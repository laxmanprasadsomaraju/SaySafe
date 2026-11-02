# SaySafe — AI Payment Guardian for Everyone

**Shop simply. Pay safely.**

SaySafe is a voice-first assistant that helps older adults shop, spot scams, verify official PayPal contacts and make protected PayPal payments — with a trusted family member one tap away.

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). Open source under the MIT licence.

> Demo payments use the **PayPal sandbox**. No real money moves.

---

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/laxmanprasadsomaraju/SaySafe)

## Why

Most shopping assistants try to make paying *faster*. For many older people the problem is the opposite: fake "PayPal" texts, look-alike links, pressure to pay now, and checkouts that are hard to read. SaySafe makes paying **safer**:

- **AI interprets.** Natural speech in, a clear proposed action out.
- **Security rules evaluate.** Deterministic link, domain and wording checks — the AI can only make a verdict *stricter*, never "safe".
- **The user authorises.** Every payment is approved by the payer at PayPal.
- **PayPal processes.** Real Orders v2 sandbox checkout.
- **The backend verifies.** Capture only after re-reading the order from PayPal and re-checking policy.

## Features

| | Feature | Status |
|---|---|---|
| 🛡️ | **Scam Message Guardian** — paste text, a link, email or phone number, upload a screenshot (vision: not yet tested live), or read it aloud. Look-alike domains, brand-in-subdomain, punycode, `@` tricks, shorteners, IP links, urgency, gift-card and password requests, free-mail "support". Plain-English, spoken result with safe next steps. | ✅ Text/links tested; screenshot pending |
| ✅ | **Trusted official directory** — PayPal help pages fetched from paypal.com on 2026-11-02, plus the phishing report address. No scraped phone numbers. | ✅ Checked |
| 🎙️ | **Voice shopping** — "Find me a reliable kettle under €40." Groq Whisper speech-to-text, AI intent, spoken options, exact price and merchant read back. Text input everywhere too. | ✅ Text tested; mic needs a real-device test |
| 💳 | **Real PayPal sandbox checkout** — server-side Orders v2, payer approval at PayPal, server-side verified capture, idempotent requests, spoken receipt from PayPal's capture data. | ✅ Sandbox order + capture verified; buyer-login approval pending |
| 👪 | **Family spending protection** — purchases above a limit (default €75) need a trusted relative's approval, bound to the exact basket, amount, currency and merchant, with expiry and replay protection. Family can never pay from the user's account. | ✅ Tested (HTTP + browser) |
| 📦 | **Order problems** — "My kettle never arrived": receipt, seller first, then PayPal's official Resolution Centre. Never promises a refund. Demo-merchant refund via Payments API for our own sandbox shop. | 🟡 Built, refund not tested live |
| 🔔 | **Verified webhooks** — PayPal signature verification, deduplication, amount checks, reconciliation. | ✅ Code + tests (needs `PAYPAL_WEBHOOK_ID` on deploy) |

## Accessibility

WCAG 2.2 AA target: 20 px+ body text, 56–64 px buttons, Atkinson Hyperlegible font, visible focus, full keyboard use, skip link, captions for everything spoken, *Bigger text* and *High contrast* toggles, reduced-motion support, voice optional on every screen, no colour-only meaning.

## Architecture

```
web (React + Vite + Tailwind)  ──►  server (Express, TypeScript)
                                     ├─ ai/        Groq provider (text, vision, Whisper) + OpenAI-compatible fallback
                                     ├─ scam/      deterministic rules, trusted directory, threat-intel adapters, AI explainer
                                     ├─ catalogue/ demo shop (sandbox-only products, original images)
                                     ├─ payments/  state machine, risk + policy, family approvals, capture, refunds
                                     ├─ paypal/    Orders v2, Payments, webhook verification
                                     └─ db/        SQLite (sessions, households, requests, approvals, webhooks, audit log)
```

Payment states: `DRAFT → RISK_REVIEW → (BLOCKED | FAMILY_APPROVAL_PENDING → FAMILY_APPROVED | ) → PAYER_APPROVAL_PENDING → PAYER_APPROVED → CAPTURE_PENDING → CAPTURED (→ REFUNDED)`, plus `FAILED` and `CANCELLED`. Illegal transitions throw; every change is optimistic-locked and written to an audit log. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

```bash
cp .env.example .env      # add PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, GROQ_API_KEY
npm install
npm run dev               # web on :5173, API on :8787
npm test                  # unit + policy tests
```

Production: `npm run build && npm start` (serves the web app and API on `PORT`). A `render.yaml` is included.

**Getting keys (free):**
- PayPal sandbox: [developer.paypal.com](https://developer.paypal.com/dashboard/) → Apps & Credentials → Sandbox → Create App. Use a sandbox *personal* account to approve test payments.
- Groq: [console.groq.com/keys](https://console.groq.com/keys).

## AI tools used

- **Groq** — `openai/gpt-oss-20b` (intent + scam explanations), `qwen/qwen3.8-27b` (screenshot reading), `whisper-large-v3-turbo` (speech-to-text). Models are configurable by env var.
- Browser speech synthesis for spoken replies.
- Product images were generated with an AI image model for this project.
- AI coding assistance was used during development.

## Safety rules we never break

AI never authorises payments · family approval never replaces payer approval · no "95% safe" scores · unknown links are "unknown", never "safe" · we never open links found in messages · prices always come from the server · no secrets in the browser.

## Known limitations

See [docs/STATUS.md](docs/STATUS.md). SaySafe is a hackathon project and not affiliated with or endorsed by PayPal.
