# Implementation status

_Last updated: 2026-11-02 (Irish time)._

## Implemented and verified
- Scam rules engine (links, domains, punycode, @-trick, shorteners, IPs, wording, emails, phones) — 19 unit tests.
- Trusted directory: paypal.com, phishing@paypal.com, 4 official help pages — each checked by hand on 2026-11-02.
- AI scam explanation via Groq (`openai/gpt-oss-20b`) — verified against the live API; AI can only escalate.
- AI shopping intent via Groq — verified live ("kettle under €40" → 2 options).
- PayPal sandbox: OAuth + Orders v2 create — verified live (real sandbox order IDs returned).
- Payment state machine, risk/policy, family approval binding, expiry, replay, idempotency, tamper/currency checks, webhook reconciliation — 16 tests (PayPal replaced by a test double only inside tests).
- Elder Mode UI (home, check, shop, review, order/receipt, help) and Family Mode (pairing, approvals, limit, alerts, history).

## Implemented but unverified
- Real sandbox capture through SaySafe code verified 2026-11-02 (scripts/paypal-smoke.ts: order created, approved with PayPal test card, re-read and captured, EUR 32.00 COMPLETED).

## Implemented but unverified (continued)
- Buyer approval on PayPal's own page with a sandbox personal account (needs deployed URL for the return redirect).
- Screenshot analysis with `qwen/qwen3.8-27b` (code done; live test pending).
- Groq Whisper transcription from the browser microphone (needs a real mic test).
- Webhook signature verification (needs deployed URL + `PAYPAL_WEBHOOK_ID`).
- Demo-merchant refund (Payments API).

## Mock / demo-only
- Product catalogue is a fictional sandbox demo shop (10 items, original AI-generated images). Channel3 not integrated.
- Threat intel: local demo blocklist only unless `GOOGLE_WEB_RISK_API_KEY` / `PHISHTANK_APP_KEY` are set.

## Blocked by external dependency
- Hosting: needs the owner to create the Render (or other) service and paste env vars.

## Not implemented (optional, M7)
- Channel3 product search, PayPal Invoicing, Pay Later explainer, email notifications, PayPal Agent Toolkit / MCP.
- Playwright e2e + axe accessibility tests.

## Remaining risks
- Render free instances sleep and use an ephemeral disk: the SQLite demo data resets on restart (acceptable for a demo; each visitor gets a fresh household).
- Groq free-tier limits apply; the app falls back to rules-only when AI is unavailable.
