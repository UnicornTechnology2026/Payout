import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle, ShieldCheck, Smartphone, QrCode, BadgeIndianRupee } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

const money = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0);

const cleanCode = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
const prettyCode = (v) => (v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v);

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok && res.status !== 202) {
    const err = new Error(data.error || data.message || "Something went wrong. Please try again.");
    err.status = res.status;
    throw err;
  }
  return data;
}

/* Crown cap drawn as SVG: 21 teeth around a flat top. */
function Cap({ children, tone = "steel", spin = false }) {
  const teeth = 21;
  const pts = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (Math.PI * 2 * i) / (teeth * 2) - Math.PI / 2;
    const r = i % 2 === 0 ? 98 : 88;
    pts.push(`${(100 + r * Math.cos(a)).toFixed(2)},${(100 + r * Math.sin(a)).toFixed(2)}`);
  }
  return (
    <div className={`cap cap-${tone} ${spin ? "cap-spin" : ""}`}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <polygon points={pts.join(" ")} className="cap-edge" />
        <circle cx="100" cy="100" r="76" className="cap-face" />
        <circle cx="100" cy="100" r="76" className="cap-rim" />
      </svg>
      <div className="cap-content">{children}</div>
    </div>
  );
}

function Steps({ current }) {
  const items = ["Enter code", "Your details", "Get cashback"];
  return (
    <ol className="steps" aria-label="Progress">
      {items.map((label, i) => (
        <li key={label} className={i < current ? "done" : i === current ? "now" : ""} aria-current={i === current ? "step" : undefined}>
          <span className="dot">{i < current ? "✓" : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const urlCode = cleanCode(params.get("code") || "");

  const [demo, setDemo] = useState(false);
  const [stage, setStage] = useState("code"); // code | form | result
  const [code, setCode] = useState(urlCode);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [upi, setUpi] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // {status, amount, transferId, utr, message, demo}
  const polls = useRef(0);

  useEffect(() => {
    api("/api/config").then((c) => setDemo(!!c.demo)).catch(() => {});
  }, []);

  // Opened from a QR scan: verify the code straight away.
  useEffect(() => {
    if (urlCode.length === 8) verify(urlCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(value = code) {
    setError("");
    if (value.length !== 8) {
      setError("The code has 8 letters and numbers. Check the one under the cap.");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/coupons/${value}`);
      setCode(value);
      setStage("form");
    } catch (e) {
      setError(e.message);
      setStage("code");
    } finally {
      setBusy(false);
    }
  }

  async function redeem(e) {
    e.preventDefault();
    setError("");

    if (!/^[\p{L}][\p{L} .'-]{1,59}$/u.test(name.trim())) return setError("Enter your full name.");
    if (!/^[6-9]\d{9}$/.test(phone)) return setError("Enter a valid 10-digit mobile number.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}@[A-Za-z0-9.-]{2,50}$/.test(upi.trim()))
      return setError("Enter a valid UPI ID, for example name@upi.");

    setBusy(true);
    try {
      const data = await api("/api/redeem", {
        method: "POST",
        body: JSON.stringify({ code, name: name.trim(), phone, upiId: upi.trim() }),
      });
      polls.current = 0;
      setResult(data);
      setStage("result");
    } catch (e) {
      setError(e.message);
      // Code was taken by someone else while the form was open.
      if (e.status === 409 || e.status === 404) setStage("code");
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus() {
    if (!result?.transferId) return;
    try {
      const data = await api(`/api/payouts/${encodeURIComponent(result.transferId)}/status`);
      setResult((r) => ({ ...r, ...data }));
    } catch (e) {
      setError(e.message);
    }
  }

  // While the bank hasn't confirmed, check automatically (about 1 minute).
  useEffect(() => {
    if (stage !== "result" || result?.status !== "PENDING") return;
    const t = setInterval(() => {
      polls.current += 1;
      if (polls.current > 15) return clearInterval(t);
      checkStatus();
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, result?.status, result?.transferId]);

  function startOver() {
    window.history.replaceState({}, "", window.location.pathname);
    setCode("");
    setName("");
    setPhone("");
    setUpi("");
    setResult(null);
    setError("");
    setStage("code");
  }

  const stepIndex = stage === "code" ? 0 : stage === "form" ? 1 : 2;

  return (
    <div className="page">
      {demo && (
        <div className="demo-bar" role="status">
          Demo mode — no real money is sent.
        </div>
      )}

      <header className="top">
        <span className="wordmark">
          <Cap tone="red">
            <span className="mini">★</span>
          </Cap>
          Cap&nbsp;Cashback
        </span>
      </header>

      <main className="layout">
        <section className="intro">
          <h1>
            Look under the cap.
            <br />
            Scan. Get paid.
          </h1>
          <p className="lede">
            Every bottle cap hides a coupon with a QR code. Scan it, tell us where to send the money, and ₹5 to ₹100
            lands in your UPI account.
          </p>
          <ul className="how">
            <li>
              <QrCode size={18} /> Scan the QR code under the cap, or type the 8-character code.
            </li>
            <li>
              <Smartphone size={18} /> Enter your name, mobile number and UPI ID.
            </li>
            <li>
              <BadgeIndianRupee size={18} /> Your cashback is sent straight to your UPI ID.
            </li>
          </ul>
        </section>

        <section className="panel" aria-live="polite">
          <Steps current={stepIndex} />

          {stage === "code" && (
            <form
              className="card"
              onSubmit={(e) => {
                e.preventDefault();
                verify();
              }}
            >
              <h2>Enter the code under your cap</h2>
              <p className="help">Scanned the QR code? It fills in automatically. If you can't scan, type the code instead.</p>

              <label htmlFor="code">Coupon code</label>
              <input
                id="code"
                className="code-input"
                value={prettyCode(code)}
                onChange={(e) => setCode(cleanCode(e.target.value))}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
              />

              <button className="btn" type="submit" disabled={busy}>
                {busy ? <LoaderCircle size={18} className="spin" /> : null}
                {busy ? "Checking code…" : "Check code"}
              </button>
              {error && <p className="error" role="alert"><CircleAlert size={16} />{error}</p>}
            </form>
          )}

          {stage === "form" && (
            <form className="card" onSubmit={redeem} noValidate>
              <div className="valid-chip">
                <CheckCircle2 size={16} /> Code {prettyCode(code)} is valid
              </div>
              <h2>Where should we send your cashback?</h2>

              <label htmlFor="name">Full name</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} placeholder="As on your bank account" />

              <label htmlFor="phone">Registered mobile number</label>
              <div className="phone-row">
                <span>+91</span>
                <input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="10-digit number"
                />
              </div>

              <label htmlFor="upi">UPI ID</label>
              <input
                id="upi"
                value={upi}
                onChange={(e) => setUpi(e.target.value.trim())}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="name@bank"
              />
              <p className="help small">Check your UPI ID carefully. UPI payments can't be reversed.</p>

              <button className="btn" type="submit" disabled={busy}>
                {busy ? <LoaderCircle size={18} className="spin" /> : null}
                {busy ? "Sending cashback…" : "Get my cashback"}
              </button>
              {error && <p className="error" role="alert"><CircleAlert size={16} />{error}</p>}
              <button type="button" className="link" onClick={startOver}>
                Use a different code
              </button>
            </form>
          )}

          {stage === "result" && result && (
            <div className="card result">
              {result.status === "SUCCESS" && (
                <>
                  <Cap tone="gold" spin>
                    <span className="cap-amount">{money(result.amount)}</span>
                  </Cap>
                  <h2>{result.demo ? "Demo cashback complete" : "Cashback sent"}</h2>
                  <p className="help">
                    {result.demo
                      ? `${money(result.amount)} would be sent to ${upi}. No real money moved because the server is in demo mode.`
                      : `${money(result.amount)} is on its way to ${upi}. It should show in your UPI app within moments.`}
                  </p>
                  {result.utr && !result.demo && <p className="utr">Bank reference (UTR): {result.utr}</p>}
                </>
              )}

              {result.status === "PENDING" && (
                <>
                  <Cap tone="steel">
                    <LoaderCircle size={34} className="spin" />
                  </Cap>
                  <h2>Sending {money(result.amount)}…</h2>
                  <p className="help">Waiting for the bank to confirm. This page updates by itself. Please don't submit the code again.</p>
                  <button className="btn ghost" onClick={checkStatus}>Check now</button>
                </>
              )}

              {(result.status === "FAILED" || result.status === "REJECTED") && (
                <>
                  <h2>Transfer didn't go through</h2>
                  <p className="help">
                    The bank couldn't complete this payment. Contact support and quote your code <strong>{prettyCode(code)}</strong> —
                    don't try to use it again.
                  </p>
                </>
              )}

              {error && <p className="error" role="alert"><CircleAlert size={16} />{error}</p>}
              <button className="link" onClick={startOver}>Redeem another cap</button>
            </div>
          )}

          <p className="foot">
            <ShieldCheck size={14} /> Each code works once. Your details are used only to send this cashback.
          </p>
        </section>
      </main>
    </div>
  );
}