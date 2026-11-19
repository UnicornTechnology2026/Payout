import "dotenv/config";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { constants, publicEncrypt } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "data.sqlite"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const couponCount = (() => {
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM coupons").get().n;
  } catch {
    return 0;
  }
})();
console.log(`Database: ${path.join(__dirname, "data.sqlite")}`);
console.log(`Coupons in database: ${couponCount}`);

// coupons : one row per bottle cap (code + prize generated in advance)
// payouts : one row per redemption. Unique on coupon_code => one payout max.
db.exec(`
  CREATE TABLE IF NOT EXISTS coupons (
    code TEXT PRIMARY KEY,
    prize_paise INTEGER NOT NULL,
    batch TEXT,
    status TEXT NOT NULL DEFAULT 'unused',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    redeemed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS payouts (
    transfer_id TEXT PRIMARY KEY,
    coupon_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    vpa TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    status TEXT NOT NULL,
    cf_transfer_id TEXT,
    transfer_utr TEXT,
    provider_status TEXT,
    provider_response TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_payouts_phone ON payouts(phone, created_at);
`);

const app = express();

if (process.env.TRUST_PROXY)
  app.set("trust proxy", Number(process.env.TRUST_PROXY));

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "20kb" }));

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const validPhone = (v) => /^[6-9]\d{9}$/.test(String(v || ""));
const validVpa = (v) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}@[A-Za-z0-9.-]{2,50}$/.test(
    String(v || ""),
  );
const validName = (v) =>
  /^[\p{L}][\p{L} .'-]{1,59}$/u.test(String(v || "").trim());

// Codes: 8 chars from an alphabet without look-alikes (no 0/O/1/I/L).
const normalizeCode = (v) =>
  String(v || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
const validCode = (v) => /^[A-HJ-KM-NP-Z2-9]{8}$/.test(v);

const rupees = (paise) => Number((paise / 100).toFixed(2));
const payoutsEnabled = () => process.env.ENABLE_CASHFREE_PAYOUTS === "true";
const demoMode = () => !payoutsEnabled();
const maxPerPhonePerDay = () =>
  Number(process.env.MAX_REDEMPTIONS_PER_PHONE_PER_DAY || 5);

// Tiny in-memory rate limiter (per IP).
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({
        error: "Too many attempts. Please wait a minute and try again.",
      });
    }
    next();
  };
}

const lookupLimiter = rateLimit({ windowMs: 60_000, max: 30 });
const redeemLimiter = rateLimit({ windowMs: 60_000, max: 8 });

// ---------------------------------------------------------------------------
// CASHFREE
// ---------------------------------------------------------------------------
function cashfreeBaseUrl() {
  return process.env.CASHFREE_ENV === "production"
    ? "https://api.cashfree.com/payout"
    : "https://sandbox.cashfree.com/payout";
}

function cashfreeHeaders() {
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  const publicKeyPath = process.env.CASHFREE_PUBLIC_KEY_PATH;

  if (!clientId || !clientSecret || !publicKeyPath) {
    throw new Error("Cashfree credentials or Public Key path are missing.");
  }

  const publicKey = readFileSync(
    path.resolve(__dirname, publicKeyPath),
    "utf8",
  );
  const timestamp = Math.floor(Date.now() / 1000);

  const signature = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from(`${clientId}.${timestamp}`, "utf8"),
  ).toString("base64");

  return {
    "Content-Type": "application/json",
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
    "x-api-version": process.env.CASHFREE_API_VERSION || "2024-01-01",
    "x-cf-signature": signature,
  };
}

async function cashfreeRequest(endpoint, options = {}) {
  const response = await fetch(`${cashfreeBaseUrl()}${endpoint}`, {
    ...options,
    headers: { ...cashfreeHeaders(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      data.message ||
        data.error ||
        `Cashfree returned HTTP ${response.status}.`,
    );
    error.status = response.status;
    error.providerData = data;
    throw error;
  }
  return data;
}

// Persist a provider (or demo) status. A SUCCESS is never downgraded.
function saveProviderResponse(transferId, data) {
  const status = String(
    data.status || data.transfer_status || "PENDING",
  ).toUpperCase();
  const success = status === "SUCCESS";
  const failure = ["FAILED", "REJECTED", "CANCELLED"].includes(status);

  return db.transaction(() => {
    const payout = db
      .prepare("SELECT * FROM payouts WHERE transfer_id = ?")
      .get(transferId);
    if (!payout) return null;
    if (payout.status === "SUCCESS") return payout;

    const next = success ? "SUCCESS" : failure ? "FAILED" : "PENDING";

    db.prepare(
      `UPDATE payouts SET status = ?, provider_status = ?,
         cf_transfer_id = COALESCE(?, cf_transfer_id),
         transfer_utr = COALESCE(?, transfer_utr),
         provider_response = ?, updated_at = CURRENT_TIMESTAMP
       WHERE transfer_id = ?`,
    ).run(
      next,
      status,
      data.cf_transfer_id || null,
      data.transfer_utr || null,
      JSON.stringify(data),
      transferId,
    );

    const couponStatus = success
      ? "paid"
      : failure
        ? "payout_failed"
        : "payout_pending";
    db.prepare(
      "UPDATE coupons SET status = ? WHERE code = ? AND status != 'paid'",
    ).run(couponStatus, payout.coupon_code);

    return db
      .prepare("SELECT * FROM payouts WHERE transfer_id = ?")
      .get(transferId);
  })();
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: payoutsEnabled() ? "CASHFREE_PAYOUTS" : "DEMO_ONLY",
  });
});

app.get("/api/config", (_req, res) => {
  res.json({ demo: demoMode() });
});

// Step 1 — is the code real and unused? (does NOT reveal the prize)
app.get("/api/coupons/:code", lookupLimiter, (req, res) => {
  const code = normalizeCode(req.params.code);

  if (!validCode(code)) {
    return res.status(400).json({
      valid: false,
      error:
        "That code doesn't look right. Check the 8 characters under the cap.",
    });
  }

  const coupon = db
    .prepare("SELECT code, status FROM coupons WHERE code = ?")
    .get(code);

  if (!coupon) {
    return res.status(404).json({
      valid: false,
      error: "We couldn't find this code. Check it and try again.",
    });
  }

  if (coupon.status !== "unused") {
    return res.status(409).json({
      valid: false,
      status: coupon.status,
      error:
        coupon.status === "paid"
          ? "This code has already been redeemed."
          : "This code is already being processed.",
    });
  }

  res.json({ valid: true, code });
});

// Step 2 — claim the coupon and start the cashback transfer.
app.post("/api/redeem", redeemLimiter, async (req, res) => {
  const code = normalizeCode(req.body?.code);
  const name = String(req.body?.name || "").trim();
  const phone = String(req.body?.phone || "");
  const vpa = String(req.body?.upiId || "").trim();

  if (!validCode(code))
    return res.status(400).json({ error: "Enter a valid coupon code." });
  if (!validName(name))
    return res.status(400).json({ error: "Enter your full name." });
  if (!validPhone(phone))
    return res
      .status(400)
      .json({ error: "Enter a valid 10-digit mobile number." });
  if (!validVpa(vpa))
    return res
      .status(400)
      .json({ error: "Enter a valid UPI ID, for example name@upi." });

  const todayCount = db
    .prepare(
      "SELECT COUNT(*) AS n FROM payouts WHERE phone = ? AND created_at >= datetime('now','-1 day')",
    )
    .get(phone).n;

  if (todayCount >= maxPerPhonePerDay()) {
    return res.status(429).json({
      error: `This mobile number has reached today's limit of ${maxPerPhonePerDay()} redemptions. Try again tomorrow.`,
    });
  }

  const transferId = `CB${crypto.randomBytes(12).toString("hex").toUpperCase()}`;

  // Atomic claim: only one request can flip unused -> payout_pending.
  const claim = db.transaction(() => {
    const coupon = db.prepare("SELECT * FROM coupons WHERE code = ?").get(code);
    if (!coupon) return { error: "We couldn't find this code.", status: 404 };

    const updated = db
      .prepare(
        "UPDATE coupons SET status = 'payout_pending', redeemed_at = CURRENT_TIMESTAMP WHERE code = ? AND status = 'unused'",
      )
      .run(code);

    if (updated.changes === 0)
      return { error: "This code has already been used.", status: 409 };

    db.prepare(
      `INSERT INTO payouts (transfer_id, coupon_code, name, phone, vpa, amount_paise, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run(transferId, code, name, phone, vpa, coupon.prize_paise);

    return { coupon };
  })();

  if (claim.error) return res.status(claim.status).json({ error: claim.error });

  const amount = rupees(claim.coupon.prize_paise);

  // DEMO MODE — no money moves.
  if (demoMode()) {
    saveProviderResponse(transferId, {
      status: "SUCCESS",
      transfer_utr: `DEMO${Date.now()}`,
    });
    return res.json({
      status: "SUCCESS",
      demo: true,
      transferId,
      amount,
      message: "Demo mode: no real money was sent.",
    });
  }

  // LIVE MODE — call Cashfree.
  try {
    const providerData = await cashfreeRequest("/transfers", {
      method: "POST",
      body: JSON.stringify({
        transfer_id: transferId,
        transfer_amount: amount,
        transfer_currency: "INR",
        transfer_mode: "upi",
        beneficiary_details: {
          beneficiary_name: name,
          beneficiary_instrument_details: { vpa },
          beneficiary_contact_details: { beneficiary_phone: phone },
        },
        transfer_remarks: "Bottle cap cashback",
      }),
    });

    const saved = saveProviderResponse(transferId, providerData);

    return res.status(saved?.status === "SUCCESS" ? 200 : 202).json({
      status: saved?.status || "PENDING",
      transferId,
      amount,
      utr: saved?.transfer_utr || null,
      message:
        saved?.status === "SUCCESS"
          ? "Cashback sent to your UPI ID."
          : "Your cashback is on its way. We're waiting for the bank to confirm.",
    });
  } catch (error) {
    // A timeout doesn't prove Cashfree rejected it — keep PENDING, reconcile later.
    console.error("Cashfree payout initiation error:", error.message);

    db.prepare(
      `UPDATE payouts SET provider_status = ?, provider_response = ?, updated_at = CURRENT_TIMESTAMP
       WHERE transfer_id = ?`,
    ).run(
      `INITIATION_UNCERTAIN_${error.status || "NETWORK"}`,
      JSON.stringify(error.providerData || { message: error.message }),
      transferId,
    );

    return res.status(202).json({
      status: "PENDING",
      transferId,
      amount,
      message:
        "Your cashback is being processed. Check status in a moment — don't submit again.",
    });
  }
});

// Step 3 — poll payout status.
app.get("/api/payouts/:transferId/status", lookupLimiter, async (req, res) => {
  const transferId = String(req.params.transferId || "");
  const payout = db
    .prepare("SELECT * FROM payouts WHERE transfer_id = ?")
    .get(transferId);

  if (!payout) return res.status(404).json({ error: "Payout not found." });

  if (payout.status !== "SUCCESS" && payoutsEnabled()) {
    try {
      const query = new URLSearchParams({ transfer_id: transferId });
      const providerData = await cashfreeRequest(`/transfers?${query}`, {
        method: "GET",
      });
      saveProviderResponse(transferId, providerData);
    } catch (error) {
      console.error("Cashfree payout status error:", error.message);
    }
  }

  const latest = db
    .prepare("SELECT * FROM payouts WHERE transfer_id = ?")
    .get(transferId);

  res.json({
    transferId: latest.transfer_id,
    status: latest.status,
    amount: rupees(latest.amount_paise),
    utr: latest.transfer_utr || null,
    message:
      latest.status === "SUCCESS"
        ? "Cashback sent to your UPI ID."
        : latest.status === "FAILED"
          ? "The transfer failed. Please contact support with your coupon code."
          : "Still waiting for the bank to confirm.",
  });
});

// Cashfree auth check — does not create a payout.
app.get("/api/cashfree/auth-test", async (_req, res) => {
  try {
    const query = new URLSearchParams({
      transfer_id: `AUTH_TEST_${Date.now()}`,
    });
    await cashfreeRequest(`/transfers?${query}`, { method: "GET" });
    return res.json({
      ok: true,
      message: "Cashfree authentication successful.",
    });
  } catch (error) {
    if (error.status === 404) {
      return res.json({
        ok: true,
        message: "Cashfree authentication appears successful.",
      });
    }
    console.error("Cashfree authentication test:", error.message);
    return res.status(error.status || 500).json({
      ok: false,
      message: "Cashfree authentication test failed.",
      providerMessage: error.providerData?.message || error.message,
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(
    `Cashback API running on http://localhost:${port} (${demoMode() ? "DEMO" : "LIVE"} mode)`,
  );
});
