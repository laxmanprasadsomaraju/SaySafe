# SaySafe — AI Payment Guardian for Everyone

**Pay with confidence, not doubt.**

SaySafe helps older adults check suspicious payment messages, shop by voice and pay through a genuine PayPal checkout, with a trusted family member brought in for bigger purchases.

**Live demo:** https://saysafe.onrender.com · **How to use it:** https://saysafe.onrender.com/guide

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). Open source under the MIT licence. Not affiliated with or endorsed by PayPal.

> All payments use the **PayPal sandbox**. No real money moves.

---

## Try it in two minutes

1. Open https://saysafe.onrender.com and choose **Try it free as Mary**. No sign-up. The free host sleeps when idle, so the first visit can take about a minute.
2. **Check a message:** use the sample invoice, or paste a text, link, email or phone number. You get a verdict, the evidence and safe next steps.
3. **Shop by voice:** say or type "I need a kettle". SaySafe reads back the exact item, shop and price.
4. **Pay with PayPal:** pick something under €75 and approve with a PayPal **sandbox personal** account. SaySafe re-reads the order from PayPal before saying "paid".
5. **Family approval:** in *Get trusted help*, create an invite and open it on a second device. Back as Mary, choose the €120 microwave. The family member approves or declines the exact item and price, and Mary still approves at PayPal herself.

The step-by-step guide is also in the app at `/guide`.

## The journey

Explain the evidence → offer verification or family review → enforce safeguards on the server → genuine PayPal Orders v2 checkout → receipt confirmed from PayPal's capture data.

- **AI interprets.** Natural speech in, a clear proposed action out.
- **Rules decide.** Deterministic link, domain and wording checks. The AI can only make a verdict *stricter*, never "safe".
- **The payer authorises.** Every payment is approved by the payer at PayPal. Family approval never replaces it.
- **The server verifies.** Capture happens only after re-reading the order from PayPal and re-checking amount, currency, item and policy. Requests are idempotent.

## What is tested, and how

Status as of 2 November 2026. Labels describe only what has actually been run.

| Capability | Status | Evidence |
|---|---|---|
| Scam check (text, links, email, phone) | ✅ Tested | Unit tests and live Groq AI. AI doubt lowers a "verified" result to "needs checking" (test added). |
| Screenshot scanning | 🟡 Partly tested | Live Groq vision on generated test images, not real-world screenshots. |
| PayPal sandbox checkout on the live site | ✅ Tested | Buyer approved on PayPal's sandbox page. Return URL captured €32.00 and showed the receipt. Reload showed the same receipt with no second charge. |
| PayPal cancel on the live site | ✅ Tested | "Cancel and return" came back to SaySafe in the waiting state, with nothing charged. |
| Server-side order checks | ✅ Tested | Wrong, tampered or mismatched PayPal order IDs are rejected, including on already-paid purchases. |
| Family approval rules | ✅ Tested | Bound to the exact basket, amount, currency and merchant, with expiry and replay protection. Tested over HTTP and in the browser with two separate sessions. Two physical devices: pending. |
| Verified webhooks | 🟡 Code tested | Signature verified with PayPal before acting, unverified → 400, duplicates ignored. Webhook registered for the live URL. A live event is still to be confirmed. |
| Spoken receipt | 🟡 Partly tested | The receipt text and "Read my receipt" button were checked in a live browser. Audio still needs a check on a real device. |
| Microphone input | ⏳ Pending | Needs a test on a real laptop and phone. Typed input uses the same assistant path and is tested. |
| Refunds (demo shop only) | ⏳ Built, not tested live | |
| Accessibility | ✅ Tested | axe WCAG 2.2 A/AA: 0 violations on all app screens at 320px and 390px in default, high-contrast and large-text modes. No horizontal overflow. |
| Automated tests | ✅ Passing | 56 unit and security tests, 12-step browser end-to-end test, TypeScript, production build. |

## Deploy your own (Render, free)

1. Fork this repo, or use it directly, since it's public.
2. In Render, choose **New → Web Service → Public Git Repository** and paste the repo URL. You can also connect GitHub, which turns on auto-deploys.
3. Settings: runtime **Node**, build `npm ci && npm run build`, start `npm start`, health check `/api/health`, instance type **Free**.
4. Environment variables:
   - `NODE_VERSION=22`
   - `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`
   - `PAYPAL_CREDENTIALS=CLIENT_ID:SECRET` (or `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`)
   - `GROQ_API_KEY`
   - `PAYPAL_WEBHOOK_ID`, set after you register a webhook for `https://<your-app>/api/paypal/webhook`
5. Open `https://<your-app>/api/health`. It should report PayPal sandbox and Groq as configured.

A `render.yaml` Blueprint is included as well.

**Free-plan caveat:** Render's free instances sleep after 15 minutes idle and use a temporary disk, so the SQLite demo data (demo sessions, pending family approvals, local payment records) resets on sleep, restart or redeploy. PayPal's own records are never affected. A purchase in progress during a reset can't be completed and simply expires at PayPal unpaid, so no money is captured. For a persistent deployment, use a paid instance with a persistent disk and set `DATABASE_FILE=/var/data/saysafe.db`. No code changes are needed.

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

## Family Safety Insights (native dashboard, optional AG Studio view)

Family members get a read-only insights dashboard at **`/family/insights`**: KPI tiles, an activity chart (inline SVG with a table alternative), an accessible sortable, searchable ledger, shared scam reviews, pending approvals linked to the Family page, and a read-only "ask about this activity" box. It is built in plain SaySafe React and has no third-party dashboard dependency. One endpoint, `GET /api/family/insights` (family session only, own household only), feeds it. Totals count only `CAPTURED` payments, and seeded rows are labelled "Example data".

An optional **AG Studio** view of the same data (`/family/insights/studio`) is selected only by explicit config: `INSIGHTS_DASHBOARD=agstudio` on the server **and** `VITE_AG_STUDIO_LICENSE` at build time. Otherwise the route redirects to the native dashboard, and a failed or slow AG chunk falls back to native. The public deployment stays native (`INSIGHTS_DASHBOARD=native`, the default), because the AG Studio trial licence is evaluation-only. See [docs/AG-STUDIO.md](docs/AG-STUDIO.md).

## Run it locally

```bash
cp .env.example .env      # add PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, GROQ_API_KEY
npm install
npm run dev               # web on :5173, API on :8787
npm test                  # unit, policy and security tests
node scripts/e2e-browser.mjs        # browser end-to-end (needs a running server and Playwright)
node scripts/qa-screens.mjs         # axe + layout checks on every app screen
```

**Getting keys (free):**
- PayPal sandbox: [developer.paypal.com](https://developer.paypal.com/dashboard/) → Apps & Credentials → Sandbox → Create App. Use a sandbox *personal* account to approve test payments.
- Groq: [console.groq.com/keys](https://console.groq.com/keys).

## Accessibility

WCAG 2.2 AA target: large body text, 48 px+ touch targets, Atkinson Hyperlegible font, visible focus, full keyboard use, a skip link, captions for everything spoken, *Bigger text* and *High contrast* toggles, reduced-motion support, voice optional on every screen, and no colour-only meaning.

## AI tools used

- **Groq** — `openai/gpt-oss-20b` (intent + scam explanations), `qwen/qwen3.8-27b` (screenshot reading), `whisper-large-v3-turbo` (speech-to-text). Models are configurable by env var.
- Browser speech synthesis for spoken replies.
- Product images were generated with an AI image model for this project.
- AI coding assistance was used during development.

## Safety rules we never break

AI never authorises payments · family approval never replaces payer approval · no "95% safe" scores · unknown links are "unknown", never "safe" · we never open links found in messages · prices always come from the server · no secrets in the browser.

## Safety rules we never break

AI never authorises payments · family approval never replaces payer approval · no "95% safe" scores · unknown links are "unknown", never "safe" · we never open links found in messages · prices always come from the server · no secrets in the browser.

## Known limitations

See [docs/STATUS.md](docs/STATUS.md). SaySafe is a hackathon project and is not affiliated with or endorsed by PayPal.
