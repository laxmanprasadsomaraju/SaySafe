# Implementation status

_Last updated: 2026-11-02 (Irish time). "Verified" means we ran it; anything else is labelled._

## Verified
- Scam rules engine (links, domains, punycode, @-trick, shorteners, IPs, wording, emails, phones, invoice/money-request scams, paypal.me treated as user content) — 23 unit tests.
- Trusted directory: paypal.com home, IE contact page, fake-messages page, report-suspicious-messages page — each fetched from paypal.com on 2026-11-02. The disputes link opens PayPal's login (Resolution Centre), as expected.
- Only bare PayPal help/home pages and PayPal's own addresses can be "official contact"; a real PayPal invoice or paypal.me link is never "verified". AI can escalate but never grant "verified".
- AI scam explanation and shopping intent via Groq (`openai/gpt-oss-20b`) — live API.
- PayPal sandbox: OAuth, Orders v2 create — live. Browser test: "Pay with PayPal" lands on `www.sandbox.paypal.com/checkoutnow`.
- Real sandbox capture through SaySafe code (scripts/paypal-smoke.ts, EUR 32.00 COMPLETED). Payer approval in that script used PayPal's sandbox test card via API, not the buyer login page.
- Payment state machine, family approval binding, expiry, replay, idempotency, tamper/currency checks, webhook reconciliation — 16 tests (PayPal test double inside tests only).
- HTTP security tests (14): anonymous and cross-site calls refused; client cannot set price; checkout/confirm refused while approval pending; elder cannot self-approve; family cannot pay or see another household; decline blocks payment; forged/replayed approvals refused; payer approval still required after family approval; duplicate confirm captures once; prompt injection cannot mark a scam safe or create a payment.
- Browser end-to-end (scripts/e2e-browser.mjs, 11 checks) on desktop + iPhone 13 viewport: landing, three-action home, fake support message flagged, official contact recognised, look-alike link rejected, family pairing, large purchase awaiting approval, family decline blocks checkout, sandbox order + PayPal redirect.
- Accessibility: axe-core (WCAG 2.2 A/AA rules) — 0 violations on landing (desktop + mobile), home, check result, order, family dashboard. Colour tokens: body text 7.9:1+, primary buttons 6.5:1+.

## Built, not yet verified live
- Buyer approval on PayPal's page with a sandbox personal buyer account, then return + capture (needs a buyer login and ideally the deployed URL).
- Screenshot analysis with `qwen/qwen3.8-27b` (model is listed as Groq preview; not yet called live).
- Groq Whisper transcription from a real browser microphone.
- Webhook signature verification (needs deployed URL + `PAYPAL_WEBHOOK_ID`).
- Demo-merchant refund (Payments API).
- Spoken receipt in a real browser (text-to-speech uses the browser's voice).

## Simulated / demo-only
- Product catalogue: fictional sandbox demo shop (10 items, original generated images). Channel3 not integrated.
- Threat intel: local demo blocklist unless `GOOGLE_WEB_RISK_API_KEY` / `PHISHTANK_APP_KEY` are set.
- Money: PayPal sandbox only.

## Blocked
- Hosting: Render needs the owner's sign-in (automated sign-in was blocked). One-click Blueprint: `render.yaml` in the repo.
- Real-user usability tests: not done yet.

## Not in MVP (by choice)
- Vault, subscriptions, payouts, automatic disputes, Agent Toolkit / MCP.

## Risks
- Render free instances sleep and use an ephemeral disk; demo data resets on restart.
- Groq free-tier limits apply; the app falls back to rules-only when AI is unavailable.

## Buyer approval on PayPal's hosted sandbox page — VERIFIED (2026-11-02 22:04 UTC)
- SaySafe request `pay_kPyY4csvcw_9`, PayPal order `8C464471GW754914U`, EUR 32.00.
- Sandbox personal buyer logged in on www.sandbox.paypal.com, PayPal Balance, "Complete Purchase".
- Before approval, confirm returned 409 `not_approved`. After approval, confirm captured: capture `7GW748197L509353B`, state CAPTURED, EUR 32.00.
- Second confirm: same capture returned, no second charge.
- Open: return redirect to SaySafe's own page and spoken receipt not yet tested in browser (redirect target was localhost); a confirm with a mismatched orderId on an already-captured request returns the stored receipt instead of rejecting — tighten.
