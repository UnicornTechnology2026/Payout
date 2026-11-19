# LuckyDrop — Scratch & Cashback Wallet

A React + Vite + Tailwind customer experience with a Node/Express API and SQLite wallet ledger.

## What works in this starter
- Mobile-friendly scratch-card UI (mouse and touch).
- Server-generated unique card IDs and server-assigned rewards (₹5/₹10/₹20/₹50).
- One-time card claims enforced by the server and a database transaction.
- Wallet balance is credited immediately after a valid reveal.
- Wallet history is persisted in SQLite.
- Demo mode works without Cashfree credentials.

## Important distinction
The current app credits an **in-site wallet balance**. It does not transfer money to a bank/UPI account. The UPI cash-out route is deliberately disabled until Cashfree confirms your merchant's Payouts API access, approved authentication method (IP whitelist or public-key signature), UPI transfer mode and sandbox test procedure. Do not describe a demo wallet credit as a real bank transfer.

## Requirements
- Node.js 20 or later recommended
- npm

## Run locally
From this folder:

```bash
npm run install:all
cp server/.env.example server/.env
npm run dev
```

Open http://localhost:5173. The API runs at http://localhost:4000.

Use any 10-digit test mobile number. Click Continue, scratch the card, and the reward is added to that mobile number's wallet. Refreshing the page keeps the wallet balance because it is stored in SQLite. Each card can only be credited once.

## API endpoints
- `GET /api/health`
- `POST /api/cards/new` body: `{ "phone": "9999999999" }`
- `POST /api/cards/:cardId/reveal` body: `{ "phone": "9999999999" }`
- `GET /api/wallet/:phone`
- `POST /api/payouts/upi` (intentionally returns 501 until live/sandbox Cashfree adapter is configured)

## Cashfree integration notes
Cashfree credentials must only be stored in `server/.env` or a production secret manager. Never place them in `client/.env`, React source, browser local storage, or public repository.

Before enabling UPI cash-out, complete these steps with Cashfree:
1. Confirm Payouts API is enabled for the merchant account and sandbox UPI transfers are supported for the account.
2. Confirm the current Payouts API version, authorization flow and 2FA method for the hosting environment.
3. Confirm exact UPI beneficiary/transfer payload and webhook signature verification from current Cashfree docs.
4. Implement payout state transitions (`PENDING`, `SUCCESS`, `FAILED`) and reconcile by unique transfer ID. Never mark a payout successful merely because the create-transfer API accepted it.
5. Use an atomic wallet debit/hold and idempotency key so retries cannot pay twice. Release a hold only after a confirmed failure.
6. Test with Cashfree sandbox test data before production approval.

Useful docs: https://www.cashfree.com/docs/api-reference/payouts/

## Production hardening required
This is a starter, not a production-ready financial system. Before public launch add OTP authentication, campaign eligibility rules, card issuance/QR signing, rate limiting, abuse/fraud controls, admin reporting, database backups, HTTPS, audit logs, privacy/consent copy, webhook signature verification, monitoring and a legal/compliance review. Do not use real customer data in the demo.
