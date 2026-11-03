# PayPal integration audit with the APIMatic PayPal Context Plugin

**Date:** 3 November 2026 · **Plugin:** `paypal` v0.4.1 (MIT) from the APIMatic Context Plugins Marketplace

## How it was installed (honest account)
- `npx context-plugins install paypal` was run in the build environment. The first run reported
  "No supported editor found" (it looks for Claude Code, Cursor, VS Code or Codex).
- A Cursor config folder (`~/.cursor`) was created and the same command re-run. It printed
  `OK Installed -> ~/.cursor/plugins/local/paypal`.
- The coding agent then read the plugin's TypeScript skills directly from that folder
  (`typescript-integrate-paypal`, `-error-handling`, `-configuration-resilience`, `-authentication`)
  and used them as the reference for this audit. Cursor itself was not used.
- SaySafe does **not** switch to the generated SDK: the existing hand-written Orders v2 client is
  tested live, and replacing it days before submission is a bigger risk than the gaps found.

## What was checked and the result

| Area | Status before | Plugin guidance | Change |
|---|---|---|---|
| Server-side OAuth, token cache | Cached token, 15 s timeout, never sent to browser | Cached token must be dropped and re-acquired after a 401 | **Fixed:** a 401 clears the cache and retries once (same PayPal-Request-Id, so safe) |
| Sandbox-only | Base URL overridable by env | "The default environment is whichever the spec listed first. Nothing announces it" | **Fixed:** server refuses any non-sandbox base unless `PAYPAL_ALLOW_LIVE=yes` |
| Orders v2 create | `PayPal-Request-Id: create-<request>` | Idempotency key must be stored with the claim and re-sent | OK, already done |
| Capture, amount check | Re-reads order, checks custom_id, amount, currency before capture; checks captured amount after | — | OK |
| Capture on timeout/connection error | Marked **FAILED** and told the user "No money was taken" | "A ConnectionError or TimeoutError on a write is *unknown*, not *failed*: re-read by the reference you sent" | **Fixed:** stays `CAPTURE_PENDING`, re-reads PayPal, tells the user they won't be charged twice; a retry re-sends the same PayPal-Request-Id |
| Webhook signature | PayPal verify-webhook-signature API with `PAYPAL_WEBHOOK_ID` | — | OK; unsigned POST returns 400 on live |
| Webhook replay | Event id primary key, `INSERT OR IGNORE`, correlation by order id + capture id + amount + currency | — | OK (unit tests) |
| Error responses | `INSTRUMENT_DECLINED` → 402, others → FAILED | Map 4xx (your bug / user) apart from 5xx (retryable) | **Fixed** with the unknown-outcome rule above |
| Refunds | `refundCapture` with PayPal-Request-Id | — | Present, not exposed in the UI |
| Restart / recovery | SQLite on Render Free is wiped on restart | Settle from what the provider holds | **Added:** `/checkout/return` without a session asks PayPal for the real order state (read-only, never captures) |
| Secrets | Env vars on Render; vault in the agent | Logging the token request leaks `client_secret` | OK: no request logging of auth headers |

## Tests added
- `timeout during capture is UNKNOWN, not failed; a retry never captures twice`
- `timeout with nothing captured stays CAPTURE_PENDING and says no double charge`

Full suite: 66/66 passing (vitest), TypeScript clean.
