# Architecture

## Principle
**AI interprets → security rules evaluate → the user authorises → PayPal processes → the backend verifies.**

## Request flow (purchase)
1. Elder says "find me a kettle under €40". Browser records audio → `POST /api/voice/transcribe` (Groq Whisper).
2. `POST /api/assistant` → Groq returns a schema-validated intent (`shop`, query `kettle`, max €40). The server searches the catalogue (deterministic) and builds the spoken options.
3. Elder chooses → `POST /api/quote` prices the basket **on the server**.
4. Elder confirms → `POST /api/payments` with an idempotency key:
   - `DRAFT → RISK_REVIEW` (merchant, currency, €500 cap, velocity)
   - above the household limit → `FAMILY_APPROVAL_PENDING` + an approval bound to a SHA-256 fingerprint of items, prices, total, currency and merchant, expiring in 30 min
   - otherwise → PayPal Orders v2 create (server-side, `PayPal-Request-Id`) → `PAYER_APPROVAL_PENDING`, browser redirected to PayPal (only `*.paypal.com` links are allowed).
5. Family member (paired with a one-time 6-digit code, 15-minute expiry) approves/declines. Decisions are single-use (nonce rotation) and household-scoped.
6. PayPal redirects back → `POST /api/payments/:id/confirm`: the server **re-reads the order from PayPal**, checks `custom_id`, amount and currency, requires status `APPROVED`, re-checks the family approval fingerprint, then captures with an idempotent `PayPal-Request-Id`. Only a `COMPLETED` capture with matching amount moves to `CAPTURED`.
7. Webhooks (`PAYMENT.CAPTURE.*`) are signature-verified with PayPal, deduplicated by event id, and reconcile `CAPTURE_PENDING` requests.

## Scam check flow
Full detail, limits and eval results: [SCAM-DETECTION.md](SCAM-DETECTION.md).
1. Rules engine extracts links/emails/phones and scores signals (high/medium/info, grouped in risk families). Three verdicts only: `suspicious`, `needs_checking`, `no_obvious_warning_signs` (always with a disclosure). Legacy codes are mapped by `normalizeVerdict`.
2. Threat-intel adapters (local list, optional Google Web Risk, optional PhishTank) receive only the URL string. We never fetch the URL.
3. Groq may add evidence: each reason needs a fixed category and an exact quote from the message (`server/scam/aiEvidence.ts`). Only validated reasons can raise the verdict, by one step (`raiseWithEvidence`): never lower, never grant the all-clear. Invalid output after one retry -> rules only, labelled. Spoken text always matches the final verdict.
4. Screenshots: magic-byte checked, 4 MB max, processed in memory, never stored; the vision model transcribes and flags unclear characters, which rules out "No obvious warning signs".

## Data
SQLite tables: users, sessions (hashed tokens), households, family_links, spending_policies, payment_requests (versioned), approvals, webhook_events, security_scans (verdict + headline only, never the message), audit_log.

## Security controls
Helmet + strict CSP, SameSite cookies, origin check on state-changing API calls, rate limits (global, AI, pairing), zod validation, upload validation, no open redirects, no SSRF, secrets only in env.
