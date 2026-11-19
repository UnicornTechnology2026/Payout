import { useEffect, useRef, useState } from "react";
import {
  Wallet,
  Sparkles,
  ShieldCheck,
  Gift,
  ArrowUpRight,
  RotateCcw,
  CheckCircle2,
  History,
  Smartphone,
  CircleHelp,
  LoaderCircle,
  Banknote,
} from "lucide-react";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

const money = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n || 0);

function ScratchSurface({ onReveal, disabled }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const revealed = useRef(false);
  const last = useRef(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const grad = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    grad.addColorStop(0, "#c9a96a");
    grad.addColorStop(0.5, "#ead7a7");
    grad.addColorStop(1, "#a78345");

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.fillStyle = "rgba(22,37,31,.10)";

    for (let i = 0; i < 26; i++) {
      ctx.beginPath();
      ctx.arc(
        (i * 71) % rect.width,
        (i * 43) % rect.height,
        1.2,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
    ctx.textAlign = "center";
    ctx.fillStyle = "#1b2c24";

    ctx.font = "600 13px Arial";
    ctx.fillText("YOUR REWARD IS INSIDE", rect.width / 2, rect.height / 2 - 7);

    ctx.font = "11px Arial";
    ctx.fillText("RUB HERE TO REVEAL", rect.width / 2, rect.height / 2 + 17);

    ctx.font = "22px Arial";
    ctx.fillText("✦", rect.width / 2, 42);

    revealed.current = false;
    setProgress(0);
  }, []);

  const point = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();

    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const scratch = (e) => {
    if (disabled || revealed.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const p = point(e);

    ctx.globalCompositeOperation = "destination-out";
    ctx.lineWidth = 30;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (last.current) {
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
      ctx.fill();
    }

    last.current = p;

    if (Math.random() < 0.14) {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

      let clear = 0;

      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] < 30) clear++;
      }

      const pct = Math.min(
        100,
        Math.round((clear / (pixels.length / 4)) * 100),
      );

      setProgress(pct);

      if (pct > 43 && !revealed.current) {
        revealed.current = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        onReveal();
      }
    }
  };

  return (
    <div className="scratch-wrap">
      <div className="scratch-under">
        <span className="tiny-label">LUCKY REWARD</span>
        <strong>?</strong>
        <span>Scratch to reveal</span>
      </div>

      <canvas
        ref={canvasRef}
        className={`scratch-canvas ${disabled ? "is-disabled" : ""}`}
        onPointerDown={(e) => {
          if (disabled) return;

          drawing.current = true;
          last.current = null;

          e.currentTarget.setPointerCapture(e.pointerId);
          scratch(e);
        }}
        onPointerMove={(e) => {
          if (drawing.current) scratch(e);
        }}
        onPointerUp={() => {
          drawing.current = false;
          last.current = null;
        }}
        onPointerCancel={() => {
          drawing.current = false;
          last.current = null;
        }}
      />

      <div className="scratch-hint">
        {progress > 0
          ? `${progress}% revealed`
          : "Use your finger or mouse to scratch"}
      </div>
    </div>
  );
}

export default function App() {
  const savedPhone = localStorage.getItem("scratch_phone") || "";

  const [phone, setPhone] = useState(savedPhone);
  const [activePhone, setActivePhone] = useState(savedPhone);
  const [card, setCard] = useState(null);
  const [wallet, setWallet] = useState({
    balance: 0,
    history: [],
  });
  const [prize, setPrize] = useState(null);
  const [upiId, setUpiId] = useState("");
  const [payout, setPayout] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  // API REQUEST
  async function request(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    });

    let data = {};

    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) {
      throw new Error(data.error || data.message || "Something went wrong.");
    }

    return data;
  }

  // REFRESH WALLET
  async function refreshWallet(number = activePhone) {
    if (!number) return;

    const data = await request(`/api/wallet/${number}`);
    setWallet(data);
  }

  useEffect(() => {
    if (activePhone) {
      refreshWallet(activePhone).catch((e) => setError(e.message));
    }

    // Initial wallet load when active mobile number changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhone]);

  // CREATE NEW SCRATCH CARD
  async function start() {
    setError("");
    setToast("");
    setPrize(null);
    setPayout(null);
    setUpiId("");
    setCard(null);

    if (!/^\d{10}$/.test(phone)) {
      setError("Please enter a valid 10-digit mobile number.");
      return;
    }

    setBusy(true);

    try {
      localStorage.setItem("scratch_phone", phone);
      setActivePhone(phone);

      const data = await request("/api/cards/new", {
        method: "POST",
        body: JSON.stringify({ phone }),
      });

      setCard(data.cardId);

      await refreshWallet(phone);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // REVEAL SCRATCH CARD PRIZE
  async function reveal() {
    if (!card || !activePhone || busy || prize !== null) return;

    setBusy(true);
    setError("");

    try {
      const data = await request(`/api/cards/${card}/reveal`, {
        method: "POST",
        body: JSON.stringify({
          phone: activePhone,
        }),
      });

      setPrize(data.prize);

      setToast("Prize revealed. Enter your UPI ID to request cashback.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // REQUEST UPI CASHBACK
  async function requestPayout(e) {
    e.preventDefault();

    setError("");
    setToast("");

    const cleanUpi = upiId.trim();

    if (
      !cleanUpi ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}@[A-Za-z0-9.-]{2,50}$/.test(cleanUpi)
    ) {
      setError("Please enter a valid UPI ID, for example name@upi.");
      return;
    }

    if (!card || !activePhone || prize === null) {
      setError("Please reveal your scratch-card prize first.");
      return;
    }

    setBusy(true);

    try {
      const data = await request("/api/payouts/upi", {
        method: "POST",
        body: JSON.stringify({
          phone: activePhone,
          cardId: card,
          upiId: cleanUpi,
        }),
      });

      setPayout({
        status: data.status || "PENDING",
        transferId: data.transferId,
        message: data.message || "Payout request received.",
      });

      setToast(
        data.status === "SUCCESS"
          ? "Cashfree confirmed your cashback payment."
          : "Your payout request is being processed.",
      );

      if (data.status === "SUCCESS") {
        await refreshWallet(activePhone);
      }
    } catch (e) {
      // No false success message when payouts are disabled.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // CHECK PAYOUT STATUS
  async function checkPayoutStatus() {
    if (!payout?.transferId) return;

    setBusy(true);
    setError("");

    try {
      const data = await request(
        `/api/payouts/${encodeURIComponent(payout.transferId)}/status`,
      );

      setPayout((current) => ({
        ...current,
        status: data.status,
        message: data.message,
        utr: data.utr,
      }));

      if (data.status === "SUCCESS") {
        setToast("Cashfree confirmed your cashback payment.");

        await refreshWallet(activePhone);
      } else if (data.status === "FAILED") {
        setToast("Cashfree reported that this transfer failed.");
      } else {
        setToast("Your payout is still awaiting confirmation.");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const payoutSuccess = payout?.status === "SUCCESS";
  const payoutPending = payout?.status === "PENDING";
  const payoutFailed = payout?.status === "FAILED";

  return (
    <div className="app-shell">
      {/* HEADER */}
      <header className="topbar">
        <a className="brand" href="#top">
          <span className="brand-mark">✦</span>

          <span>
            LUCKY<span className="brand-light">DROP</span>
          </span>
        </a>

        <div className="top-right">
          <span className="secure">
            <ShieldCheck size={14} />
            Secure rewards
          </span>

          <span className="demo-pill">SANDBOX SETUP</span>
        </div>
      </header>

      <main id="top" className="main-grid">
        {/* HERO SECTION */}
        <section className="hero-panel">
          <div className="eyebrow">
            <span></span>A LITTLE SURPRISE, JUST FOR YOU
          </div>

          <h1>
            Scratch.
            <br />
            <em>Reveal.</em> Enjoy.
          </h1>

          <p className="hero-copy">
            Your next little win is one scratch away. Reveal your reward and
            request cashback directly to your UPI ID.
          </p>

          <div className="hero-perks">
            <div>
              <Sparkles size={16} />
              <span>Instant reveal</span>
            </div>

            <div>
              <ShieldCheck size={16} />
              <span>One-time reward</span>
            </div>
          </div>

          <div className="hero-note">
            <Gift size={17} />
            <span>Every card is a chance to get something back.</span>
          </div>
        </section>

        {/* SCRATCH CARD SECTION */}
        <section className="play-column">
          <div className="section-head">
            <div>
              <div className="eyebrow muted">YOUR REWARD</div>

              <h2>Scratch card</h2>
            </div>

            <span className="step-count">
              01 <i>/</i> 03
            </span>
          </div>

          {!activePhone ? (
            <div className="phone-card">
              <div className="phone-icon">
                <Smartphone size={22} />
              </div>

              <h3>Where should we send your reward?</h3>

              <p>
                Enter your mobile number to create your personal reward account.
              </p>

              <label htmlFor="phone">MOBILE NUMBER</label>

              <div className="phone-input">
                <span>+91</span>

                <input
                  id="phone"
                  value={phone}
                  onChange={(e) =>
                    setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))
                  }
                  placeholder="10-digit mobile number"
                  inputMode="numeric"
                  maxLength={10}
                />
              </div>

              <button className="primary-btn" onClick={start} disabled={busy}>
                {busy ? "Please wait…" : "Continue to scratch"}

                <ArrowUpRight size={17} />
              </button>

              {error && <div className="error-msg">{error}</div>}
            </div>
          ) : (
            <>
              <div className="reward-card">
                <div className="reward-card-top">
                  <span>LUCKY DROP</span>
                  <span className="reward-star">✦</span>
                </div>

                <div className="reward-center">
                  <div className="reward-orbit">✦</div>

                  <div className="reward-title">
                    A reward
                    <br />
                    is waiting
                  </div>

                  <p>Made for you. Just scratch to reveal.</p>
                </div>

                <div className="reward-card-bottom">
                  <span>ONE CARD · ONE REWARD</span>
                  <span>✦ ✦ ✦</span>
                </div>
              </div>

              {!prize ? (
                <ScratchSurface onReveal={reveal} disabled={busy} />
              ) : (
                <div className="win-panel">
                  <div className="win-icon">
                    <CheckCircle2 size={26} />
                  </div>

                  <div className="eyebrow muted">YOU JUST WON</div>

                  <div className="win-amount">{money(prize)}</div>

                  <p>
                    Your prize is revealed. Submit your UPI ID to request
                    cashback.
                  </p>

                  {/* UPI ENTRY FORM */}
                  {!payout && (
                    <form className="upi-form" onSubmit={requestPayout}>
                      <label htmlFor="upiId">YOUR UPI ID</label>

                      <div className="phone-input">
                        <Banknote size={17} />

                        <input
                          id="upiId"
                          value={upiId}
                          onChange={(e) => setUpiId(e.target.value)}
                          placeholder="name@bank"
                          autoComplete="off"
                          maxLength={100}
                        />
                      </div>

                      <button
                        className="primary-btn"
                        type="submit"
                        disabled={busy}
                      >
                        {busy ? "Please wait…" : "Request UPI cashback"}

                        {busy ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <ArrowUpRight size={17} />
                        )}
                      </button>

                      <p className="upi-note">
                        Your UPI ID is used only to process this reward request.
                      </p>
                    </form>
                  )}

                  {/* PENDING STATUS */}
                  {payoutPending && (
                    <div className="payout-status pending">
                      <LoaderCircle size={18} className="spin" />

                      <div>
                        <strong>Payment processing</strong>

                        <p>{payout.message}</p>

                        <button
                          className="secondary-btn"
                          type="button"
                          onClick={checkPayoutStatus}
                          disabled={busy}
                        >
                          Check payment status
                        </button>
                      </div>
                    </div>
                  )}

                  {/* SUCCESS STATUS */}
                  {payoutSuccess && (
                    <div className="payout-status success">
                      <CheckCircle2 size={18} />

                      <div>
                        <strong>Cashback payment confirmed</strong>

                        <p>{payout.message}</p>

                        {payout.utr && <p>UTR: {payout.utr}</p>}
                      </div>
                    </div>
                  )}

                  {/* FAILED STATUS */}
                  {payoutFailed && (
                    <div className="payout-status failed">
                      <CircleHelp size={18} />

                      <div>
                        <strong>Payment failed</strong>

                        <p>{payout.message}</p>

                        <p>
                          Please contact support before requesting another
                          transfer.
                        </p>
                      </div>
                    </div>
                  )}

                  <button
                    className="secondary-btn"
                    onClick={start}
                    disabled={busy}
                  >
                    <RotateCcw size={16} />
                    Try another card
                  </button>
                </div>
              )}

              {error && <div className="error-msg">{error}</div>}

              <div className="card-footnote">
                <ShieldCheck size={14} />
                Each card can be claimed only once.
              </div>
            </>
          )}
        </section>

        {/* WALLET SECTION */}
        <aside className="wallet-column">
          <div className="wallet-head">
            <div className="wallet-icon">
              <Wallet size={19} />
            </div>

            <div>
              <div className="eyebrow muted">YOUR ACCOUNT</div>

              <h2>Cashback wallet</h2>
            </div>
          </div>

          <div className="balance-card">
            <div className="balance-label">
              CONFIRMED CASHBACK
              <span className="live-dot"></span>
            </div>

            <div className="balance-value">{money(wallet.balance)}</div>

            <div className="balance-foot">
              <span>INR WALLET</span>
              <span>Confirmed payments only</span>
            </div>
          </div>

          <div className="wallet-info">
            <div className="info-icon">
              <ShieldCheck size={17} />
            </div>

            <div>
              <strong>Verified payment credit</strong>

              <p>
                Wallet history updates only after the payment provider confirms
                a successful transfer.
              </p>
            </div>
          </div>

          <div className="history-head">
            <h3>
              <History size={16} />
              Recent activity
            </h3>

            <span>{wallet.history?.length || 0}</span>
          </div>

          {!wallet.history?.length ? (
            <div className="empty-history">
              <div className="empty-icon">
                <Gift size={20} />
              </div>

              <strong>No confirmed rewards yet</strong>

              <p>Your successful cashback payments will appear here.</p>
            </div>
          ) : (
            <div className="history-list">
              {wallet.history.map((item) => (
                <div className="history-item" key={item.id}>
                  <div className="history-gift">
                    <Gift size={16} />
                  </div>

                  <div className="history-desc">
                    <strong>Scratch reward</strong>

                    <span>
                      {new Date(item.created_at + "Z").toLocaleString("en-IN")}
                    </span>
                  </div>

                  <strong className="history-amount">
                    +{money(item.amount)}
                  </strong>
                </div>
              ))}
            </div>
          )}

          <div className="wallet-disclaimer">
            <CircleHelp size={14} />
            Cashfree payouts are currently disabled while sandbox authentication
            and transfer testing are completed.
          </div>
        </aside>
      </main>

      {/* FOOTER */}
      <footer>
        <span>© 2026 LUCKYDROP REWARDS</span>
        <span>Secure · Simple · Surprising</span>
      </footer>

      {toast && prize !== null && (
        <div className="toast">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
