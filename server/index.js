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

// DATABASE TABLES
db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    prize_paise INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    claimed_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS wallets (
    phone TEXT PRIMARY KEY,
    balance_paise INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    card_id TEXT NOT NULL UNIQUE,
    amount_paise INTEGER NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payouts (
    transfer_id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL UNIQUE,
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
`);

// EXPRESS APP
const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  }),
);

app.use(express.json({ limit: "20kb" }));

// PRIZE AMOUNTS IN PAISE
const prizes = [500, 500, 1000, 2000, 5000];

const validPhone = (phone) => /^\d{10}$/.test(String(phone || ""));

const validVpa = (vpa) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}@[A-Za-z0-9.-]{2,50}$/.test(
    String(vpa || ""),
  );

const rupees = (paise) => Number((paise / 100).toFixed(2));

const payoutsEnabled = () => process.env.ENABLE_CASHFREE_PAYOUTS === "true";

// CASHFREE CONFIGURATION
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
  const message = `${clientId}.${timestamp}`;

  const signature = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from(message, "utf8"),
  ).toString("base64");

  return {
    "Content-Type": "application/json",
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
    "x-api-version": process.env.CASHFREE_API_VERSION || "2024-01-01",
    "x-cf-signature": signature,
  };
}

// CASHFREE API REQUEST
async function cashfreeRequest(endpoint, options = {}) {
  const response = await fetch(`${cashfreeBaseUrl()}${endpoint}`, {
    ...options,
    headers: {
      ...cashfreeHeaders(),
      ...(options.headers || {}),
    },
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

// SAVE CASHFREE TRANSFER STATUS
function saveProviderResponse(transferId, data) {
  const status = String(
    data.status || data.transfer_status || "PENDING",
  ).toUpperCase();

  const terminalSuccess = status === "SUCCESS";

  const terminalFailure = ["FAILED", "REJECTED", "CANCELLED"].includes(status);

  const update = db.transaction(() => {
    const payout = db
      .prepare("SELECT * FROM payouts WHERE transfer_id = ?")
      .get(transferId);

    if (!payout) return null;

    // Never downgrade a completed payout.
    if (payout.status === "SUCCESS") {
      return payout;
    }

    const nextStatus = terminalSuccess
      ? "SUCCESS"
      : terminalFailure
        ? "FAILED"
        : "PENDING";

    db.prepare(
      `
      UPDATE payouts
      SET
        status = ?,
        provider_status = ?,
        cf_transfer_id = COALESCE(?, cf_transfer_id),
        transfer_utr = COALESCE(?, transfer_utr),
        provider_response = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE transfer_id = ?
    `,
    ).run(
      nextStatus,
      status,
      data.cf_transfer_id || null,
      data.transfer_utr || null,
      JSON.stringify(data),
      transferId,
    );

    if (terminalSuccess) {
      db.prepare(
        `
        UPDATE cards
        SET
          status = 'paid',
          claimed_by = ?,
          claimed_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status IN (
            'revealed',
            'payout_pending',
            'payout_failed'
          )
      `,
      ).run(payout.phone, payout.card_id);

      // Add ledger record only once.
      const ledgerInsert = db
        .prepare(
          `
        INSERT OR IGNORE INTO ledger (
          id,
          phone,
          card_id,
          amount_paise,
          type
        )
        VALUES (?, ?, ?, ?, 'UPI_CASHBACK')
      `,
        )
        .run(
          `CF-${transferId}`,
          payout.phone,
          payout.card_id,
          payout.amount_paise,
        );

      // Credit wallet only after confirmed SUCCESS.
      if (ledgerInsert.changes > 0) {
        db.prepare(
          `
          INSERT INTO wallets (
            phone,
            balance_paise
          )
          VALUES (?, ?)

          ON CONFLICT(phone) DO UPDATE
          SET
            balance_paise =
              balance_paise + excluded.balance_paise,
            updated_at = CURRENT_TIMESTAMP
        `,
        ).run(payout.phone, payout.amount_paise);
      }
    } else if (terminalFailure) {
      db.prepare(
        `
        UPDATE cards
        SET status = 'payout_failed'
        WHERE id = ?
          AND status != 'paid'
      `,
      ).run(payout.card_id);
    } else {
      db.prepare(
        `
        UPDATE cards
        SET status = 'payout_pending'
        WHERE id = ?
          AND status != 'paid'
      `,
      ).run(payout.card_id);
    }

    return db
      .prepare("SELECT * FROM payouts WHERE transfer_id = ?")
      .get(transferId);
  });

  return update();
}

// CASHFREE AUTHENTICATION TEST — DOES NOT CREATE A PAYOUT
app.get("/api/cashfree/auth-test", async (_req, res) => {
  try {
    const testTransferId = `AUTH_TEST_${Date.now()}`;

    const query = new URLSearchParams({
      transfer_id: testTransferId,
    });

    await cashfreeRequest(`/transfers?${query.toString()}`, {
      method: "GET",
    });

    return res.json({
      ok: true,
      message: "Cashfree authentication successful.",
    });
  } catch (error) {
    const provider = error.providerData || {};

    // An unknown transfer ID can return 404 even when authentication works.
    if (error.status === 404) {
      return res.json({
        ok: true,
        message:
          "Cashfree authentication appears successful. Test transfer ID was not found, as expected.",
      });
    }

    console.error("Cashfree authentication test:", error.message);

    return res.status(error.status || 500).json({
      ok: false,
      message: "Cashfree authentication test failed.",
      providerMessage: provider.message || provider.error || error.message,
    });
  }
});

// HEALTH CHECK
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: payoutsEnabled() ? "CASHFREE_PAYOUTS" : "DEMO_ONLY",
    cashfreeEnabled: payoutsEnabled(),
  });
});

// CREATE SCRATCH CARD
app.post("/api/cards/new", (req, res) => {
  const { phone } = req.body || {};

  if (!validPhone(phone)) {
    return res.status(400).json({
      error: "Enter a valid 10-digit mobile number.",
    });
  }

  const id = `SC-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

  const prize = prizes[crypto.randomInt(prizes.length)];

  db.prepare(
    `
    INSERT INTO cards (id, prize_paise)
    VALUES (?, ?)
  `,
  ).run(id, prize);

  res.json({
    cardId: id,
    message: "Your scratch card is ready.",
  });
});

// GET WALLET
app.get("/api/wallet/:phone", (req, res) => {
  const phone = req.params.phone;

  if (!validPhone(phone)) {
    return res.status(400).json({
      error: "Invalid mobile number.",
    });
  }

  const wallet = db
    .prepare(
      `
    SELECT balance_paise
    FROM wallets
    WHERE phone = ?
  `,
    )
    .get(phone);

  const history = db
    .prepare(
      `
    SELECT
      id,
      card_id,
      amount_paise,
      type,
      created_at
    FROM ledger
    WHERE phone = ?
    ORDER BY created_at DESC
    LIMIT 20
  `,
    )
    .all(phone);

  res.json({
    phone,
    balance: rupees(wallet?.balance_paise || 0),
    currency: "INR",
    history: history.map((item) => ({
      ...item,
      amount: rupees(item.amount_paise),
    })),
  });
});

// REVEAL PRIZE
// This endpoint does NOT credit the wallet.
app.post("/api/cards/:id/reveal", (req, res) => {
  const phone = String(req.body?.phone || "");

  if (!validPhone(phone)) {
    return res.status(400).json({
      error: "Enter a valid 10-digit mobile number.",
    });
  }

  const card = db
    .prepare(
      `
    SELECT *
    FROM cards
    WHERE id = ?
  `,
    )
    .get(req.params.id);

  if (!card) {
    return res.status(404).json({
      error: "Scratch card not found.",
    });
  }

  if (card.status === "paid") {
    return res.status(409).json({
      error: "This scratch card has already been paid.",
    });
  }

  if (card.claimed_by && card.claimed_by !== phone) {
    return res.status(409).json({
      error: "This scratch card is already linked to another mobile number.",
    });
  }

  if (card.status === "ready") {
    db.prepare(
      `
      UPDATE cards
      SET
        status = 'revealed',
        claimed_by = ?
      WHERE id = ?
        AND status = 'ready'
    `,
    ).run(phone, card.id);
  }

  res.json({
    prize: rupees(card.prize_paise),
    amountPaise: card.prize_paise,
    status: card.status === "ready" ? "revealed" : card.status,
    message: "Prize revealed. Submit your UPI ID to request cashback.",
  });
});

// INITIATE UPI PAYOUT
app.post("/api/payouts/upi", async (req, res) => {
  if (!payoutsEnabled()) {
    return res.status(501).json({
      error: "Cashfree payouts are disabled. This server is in demo-only mode.",
    });
  }

  const phone = String(req.body?.phone || "");
  const cardId = String(req.body?.cardId || "");
  const vpa = String(req.body?.upiId || "").trim();

  if (!validPhone(phone)) {
    return res.status(400).json({
      error: "Enter a valid 10-digit mobile number.",
    });
  }

  if (!/^SC-[A-F0-9]{10}$/.test(cardId)) {
    return res.status(400).json({
      error: "Invalid scratch card ID.",
    });
  }

  if (!validVpa(vpa)) {
    return res.status(400).json({
      error: "Enter a valid UPI ID, for example name@upi.",
    });
  }

  const card = db
    .prepare(
      `
    SELECT *
    FROM cards
    WHERE id = ?
  `,
    )
    .get(cardId);

  if (!card) {
    return res.status(404).json({
      error: "Scratch card not found.",
    });
  }

  if (card.claimed_by !== phone) {
    return res.status(403).json({
      error: "This card does not belong to this mobile number.",
    });
  }

  if (!["revealed", "payout_pending", "payout_failed"].includes(card.status)) {
    return res.status(409).json({
      error: "This card is not available for payout.",
    });
  }

  // Prevent duplicate payout for the same card.
  const existing = db
    .prepare(
      `
    SELECT *
    FROM payouts
    WHERE card_id = ?
  `,
    )
    .get(cardId);

  if (existing) {
    if (existing.status === "SUCCESS") {
      return res.json({
        status: "SUCCESS",
        transferId: existing.transfer_id,
        message: "Cashback was already paid for this card.",
      });
    }

    if (existing.status === "PENDING") {
      return res.status(202).json({
        status: "PENDING",
        transferId: existing.transfer_id,
        message:
          "This payout is already being processed. Check its status; do not submit it again.",
      });
    }

    return res.status(409).json({
      status: existing.status,
      transferId: existing.transfer_id,
      message:
        "A payout request already exists for this card. Contact support before retrying a failed transfer.",
    });
  }

  const transferId = `SC${crypto.randomBytes(12).toString("hex").toUpperCase()}`;

  const amount = rupees(card.prize_paise);

  // Save payout record before calling Cashfree.
  db.prepare(
    `
    INSERT INTO payouts (
      transfer_id,
      card_id,
      phone,
      vpa,
      amount_paise,
      status
    )
    VALUES (?, ?, ?, ?, ?, 'PENDING')
  `,
  ).run(transferId, cardId, phone, vpa, card.prize_paise);

  db.prepare(
    `
    UPDATE cards
    SET status = 'payout_pending'
    WHERE id = ?
  `,
  ).run(cardId);

  try {
    const providerData = await cashfreeRequest("/transfers", {
      method: "POST",
      body: JSON.stringify({
        transfer_id: transferId,
        transfer_amount: amount,
        transfer_currency: "INR",
        transfer_mode: "upi",

        beneficiary_details: {
          beneficiary_name: "Scratch Reward",

          beneficiary_instrument_details: {
            vpa,
          },

          beneficiary_contact_details: {
            beneficiary_phone: phone,
          },
        },

        transfer_remarks: "Scratch cashback reward",
      }),
    });

    const saved = saveProviderResponse(transferId, providerData);

    return res.status(saved?.status === "SUCCESS" ? 200 : 202).json({
      status: saved?.status || "PENDING",
      transferId,
      prize: amount,
      message:
        saved?.status === "SUCCESS"
          ? "Cashfree confirmed the cashback transfer."
          : "Payout request accepted. The transfer is not yet confirmed; check its status.",
    });
  } catch (error) {
    // A timeout does not prove that Cashfree rejected the transfer.
    // Keep it pending and reconcile using the same transfer ID.
    console.error("Cashfree payout initiation error:", error.message);

    db.prepare(
      `
      UPDATE payouts
      SET
        provider_status = ?,
        provider_response = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE transfer_id = ?
    `,
    ).run(
      `INITIATION_UNCERTAIN_${error.status || "NETWORK"}`,
      JSON.stringify(
        error.providerData || {
          message: error.message,
        },
      ),
      transferId,
    );

    return res.status(202).json({
      status: "PENDING",
      transferId,
      message:
        "The payout request could not be confirmed yet. Please check status; do not submit another request.",
    });
  }
});

// CHECK PAYOUT STATUS
app.get("/api/payouts/:transferId/status", async (req, res) => {
  const transferId = String(req.params.transferId || "");

  const payout = db
    .prepare(
      `
    SELECT *
    FROM payouts
    WHERE transfer_id = ?
  `,
    )
    .get(transferId);

  if (!payout) {
    return res.status(404).json({
      error: "Payout not found.",
    });
  }

  if (payout.status !== "SUCCESS" && payoutsEnabled()) {
    try {
      const query = new URLSearchParams({
        transfer_id: transferId,
      });

      const providerData = await cashfreeRequest(
        `/transfers?${query.toString()}`,
        { method: "GET" },
      );

      saveProviderResponse(transferId, providerData);
    } catch (error) {
      console.error("Cashfree payout status error:", error.message);

      // Keep pending if status lookup fails.
    }
  }

  const latest = db
    .prepare(
      `
    SELECT *
    FROM payouts
    WHERE transfer_id = ?
  `,
    )
    .get(transferId);

  return res.json({
    transferId: latest.transfer_id,
    status: latest.status,
    amount: rupees(latest.amount_paise),
    utr: latest.transfer_utr || null,

    message:
      latest.status === "SUCCESS"
        ? "Cashfree confirmed the transfer."
        : latest.status === "FAILED"
          ? "Cashfree reported that the transfer failed."
          : "Transfer is still being processed or awaiting confirmation.",
  });
});

// ERROR HANDLER
app.use((err, _req, res, _next) => {
  console.error(err);

  res.status(500).json({
    error: "Unexpected server error.",
  });
});

// START SERVER
const port = Number(process.env.PORT || 4000);

app.listen(port, () => {
  console.log(`Scratch cashback API running on http://localhost:${port}`);
});
