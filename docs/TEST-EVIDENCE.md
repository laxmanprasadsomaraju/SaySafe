# Test evidence

_What was run, on which build, where, and what kind of test it is. Times are GMT (= Irish time in November). Identifiers from the PayPal sandbox are truncated._

**Kinds of test**
- **Mocked**: runs in Node with a PayPal test double and stubbed AI. Proves our logic, not PayPal's behaviour.
- **Real browser**: Playwright driving headless Chromium (desktop and an iPhone 13 viewport). Not a real phone.
- **Real PayPal sandbox**: real calls to `api-m.sandbox.paypal.com` and PayPal's hosted sandbox approval page, with test money.
- **Live AI**: real calls to Groq models.

Nothing below is a test on a physical phone or with a real person. Those are listed under [Not yet done](#not-yet-done).

## Summary

| # | Suite | Date (GMT) | Commit | Result | Kind | Environment |
|---|---|---|---|---|---|---|
| H1 | vitest unit / integration / security (QA-fix commit) | 2026-11-03 12:34 | working tree committed as the QA-fix commit on `main` (parent `8a6a794`) | **473 passed, 0 failed** (34 files) | Mocked | Node 22.23.3, vitest 5.1 |
| H2 | TypeScript + production build (QA-fix commit) | 2026-11-03 12:35 | same | **0 errors; built** | Static / Build | `tsc --noEmit`, Vite 8 |
| H3 | Hosted `/api/health` | 2026-11-03 12:14 and 12:25 | `8a6a794` deployed | **ok**: PayPal sandbox configured, Groq ok, Channel3 configured, Turso replica persistent | Hosted API | https://saysafe.onrender.com |
| H4 | Hosted `scripts/e2e-browser.mjs` + axe | 2026-11-03 12:16–12:17 | `8a6a794` deployed | **17/17 passed; axe 0 violations on 7 screens** | Hosted browser + real PayPal sandbox (order create + redirect only) | Playwright Chromium headless via the sandbox egress proxy |
| H5 | Hosted Assistant family flow (`scripts/e2e-hosted.mjs`, port of `e2e-assistant-family.mjs`) | 2026-11-03 12:25–12:31 | `8a6a794` deployed | **16 passed, 2 failed** (see §H5) | Hosted browser + real PayPal sandbox + live Groq + live Channel3 | as H4 |
| H6 | Hosted companion flow (port of `e2e-companion.mjs`) | 2026-11-03 | — | **Not completed** (stopped by a script error, then paused by instruction while demo data is seeded) | — | — |
| H7 | PayPal Subscriptions API cancel proof | 2026-11-03 10:37 | script `scripts/paypal-setup-plan.ts --cancel` | **Sandbox buyer approved I-BY…W7; cancel → 204; GET → CANCELLED** | Real PayPal sandbox (API, **not through the app UI**) | raw responses in project `work/subs-probe/` |
| 1 | vitest unit / integration / security | 2026-11-03 10:02 | `d062acb` (branch `docs-site`; app code identical to `main` `d71bcac` except the landing and Help pages) | **376 passed, 0 failed** (28 files) | Mocked | Node 22.23.3, vitest 5.1, Linux sandbox |
| 2 | TypeScript | 2026-11-03 10:03 | `d062acb` | **0 errors** | Static | `tsc --noEmit`, TypeScript 7 |
| 3 | Production build | 2026-11-03 10:03 | `d062acb` | **Built** | Build | Vite 8 |
| 4 | Landing + Help accessibility and overflow | 2026-11-03 09:58 | working tree of `d062acb` | **axe 0 violations, no horizontal overflow** on 9 page states | Real browser, local server | Playwright 1.56.1 Chromium headless, `reducedMotion: reduce`, local production server |
| 5 | Hosted end-to-end + axe | 2026-11-03 02:31 | `6a25f68` deployed | **14/14 passed; axe 0 violations on 6 screens** | Real browser + real PayPal sandbox (order create and redirect only) | https://saysafe.onrender.com, Render Free + Turso Free |
| 6 | Hosted live payment verification (P0) | 2026-11-03 01:25–01:57 | `7344e59`, timeline fix `c85741e` | **All money checks passed**; timeline 500 found and fixed | Real PayPal sandbox | Hosted demo |
| 7 | Buyer approval on PayPal's hosted page | 2026-11-02 22:04 | pre-release `main` | **Passed** | Real PayPal sandbox | Local server + PayPal sandbox page |
| 8 | Sandbox refund through PayPal API | 2026-11-03 (early morning) | branch `refund` `61e62a5` | **Refund COMPLETED, capture REFUNDED** | Real PayPal sandbox | API call; in-app admin refund disabled on hosted |
| 9 | Scam detection held-out set v2 | 2026-11-03 | branch `scam-calibrate` `9ecb41e` | **42 cases: 2 false positives, 1 false negative** | Live AI | Groq `openai/gpt-oss-20b` + rules |
| 10 | Voice controller QA | 2026-11-03 | branch `voice-shopping` `fea9581` | Passed (see [VOICE.md](VOICE.md)); per-check counts not recorded | Real browser, simulated microphone | Chromium headless, fake media stream, stubbed `speechSynthesis` |

## H. Hosted runs and QA fixes, 3 November 2026 (12:14–12:40 GMT)

Hosted target: https://saysafe.onrender.com running `8a6a794` (live since 12:12). The QA fixes below are committed on `main` but **not deployed** at the time of these runs, so hosted results are for `8a6a794`.

**H4 `e2e-browser.mjs` (hosted browser, 17/17):** landing explains product · Try it as Mary opens the guided scam check · home has 4 shortcuts · one bottom nav · no display buttons in the header, no idle voice bar · at most one outstanding action · Check a message opens the Assistant · fake PayPal support flagged · official PayPal contact recognised · malicious look-alike rejected · genuine PayPal invoice not called safe · family pairs with one-time code · large purchase awaits family approval · family review card in Alex's Assistant shows the server amount · family decline prevents payment (409) · small purchase creates a real sandbox order · redirects to the PayPal sandbox approval page. axe 0 on landing desktop/mobile, home, check result, order awaiting, family dashboard, family assistant.

**H5 `e2e-hosted.mjs` family part (hosted browser, real sandbox, live AI):** passed — health; demo start; companion chips on a fresh conversation; fictional PayPal phishing text → Suspicious; Channel3 listings with real images (3/3 loaded); Alex pairs; Mary's card Pending €120.00; server FAMILY_APPROVAL_PENDING; Alex's tabs; Insights link; Alex's review card shows exact item/shop/amount; Mary's card turns Approved with Continue to PayPal; survives reload; Continue to PayPal reaches the **real** sandbox checkout URL; confirm before buyer approval refused (409 `not_approved`); native Family Safety Insights renders for Alex.
Failed — (1) completing buyer approval with a fictional guest card on PayPal's hosted page: PayPal sent the guest flow to `checkoutweb/signup` and it did not return (automation limit on PayPal's page, not a SaySafe result); (2) the companion part stopped because the suggestion chips only show on a fresh conversation (script bug, fixed in the script). So **the receipt card after buyer approval, Activity detail and all companion cards are not yet verified on the hosted app**; they remain verified locally against the mock PayPal only.
axe (tags wcag2a/aa, wcag21a/aa, wcag22aa) on hosted screens: 0 violations on landing, Home, Assistant, Alex's review/approved cards, Profile, Insights; **1 rule on Channel3/Demo Shop product buttons: `label-content-name-mismatch`** (accessible name `"<title>, €… at <shop>, best match. Open details"` does not contain the visible "BEST MATCH" badge text). Earlier runs did not include the `wcag21a` tag, which is why it was not reported before. Open.
Real sandbox orders created: a few unapproved sandbox orders (no capture), e.g. …534J, …580M, …3056.

**QA fixes in this commit (mocked tests in `tests/qa-fixes.test.ts`, 13 tests):**
- Payment matches card no longer repeats "Don't pay again until you've checked with John" (heading only) or the scope footnote (footer only).
- Phone extractor: a spaced Irish mobile after "new number" / "number" with a full stop ("new number 087 999 1111.") was dropped as an ID; it is now extracted, so the contact-mismatch warning shows the number. IDs, dates and amounts are still ignored.
- Contact-mismatch summary: the sentence after the warning is capitalised ("… Call Tom on the number you saved. This message looks suspicious.").
- Scam eval unchanged: offline verdicts **and** signal codes compared before/after the extractor change on all 106 cases in `tests/fixtures/scam-eval/*.json`: **0 differences**. The live v2 counts (42 cases: 2 false positives, 1 false negative) therefore stand; the live AI set was not re-run (Groq rate limits).

## 1. vitest (mocked)

- **Command:** `npx vitest run --reporter=dot` (same as `npm test`)
- **Result:** Test Files 28 passed (28) · Tests 376 passed (376), started 10:02:26, 58.6 s. An earlier run on the base commit `d71bcac` at 09:41 also gave 376/376 in 38 s.
- **Covers:** scam rules and verdicts, AI output contracts and adversarial outputs, payment state machine, family approval binding, expiry, replay and idempotency, tamper and currency checks, capture timeout handling, webhook verification and dedup (PayPal test double), refunds (admin-only), HTTP security (anonymous, cross-site, cross-household, self-approval), Turso driver row normalisation, insights metrics, voice transcript filters, Assistant block registry.
- **Not covered:** real PayPal behaviour, real models, real browsers.

## 2–3. TypeScript and build

- `npm run typecheck` → `tsc --noEmit -p tsconfig.json`: exit 0.
- `npm run build` → `vite build --config web/vite.config.ts`: built in 6.2 s, exit 0.

## 4. Landing and Help centre QA (this branch)

- **Script:** `work/docs-qa.mjs` (project scratch, not in the repo). Local server: `PORT=8899 NODE_ENV=production SAYSAFE_ALLOW_EPHEMERAL_DB=true npx tsx server/index.ts`, serving the built `web/dist`. No PayPal credentials; AI not reachable (pages tested do not need either).
- **axe tags:** wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa. Reduced motion is emulated so scroll-reveal sections are fully visible to axe.

| Page | 320 px | 390 px | 1440 px |
|---|---|---|---|
| `/` landing | 0 violations, no overflow | 0, no overflow | 0, no overflow |
| `/help` signed out | 0, no overflow | 0, no overflow | 0, no overflow |
| `/help` signed in as Mary (shows family-code tools) | 0, no overflow | 0, no overflow | 0, no overflow |

Also checked: `/guide` redirects to `/help#getting-started`; searching Help for "refund" finds 3 topics.

## 5. Hosted end-to-end (real browser, hosted demo)

- **Command:** `BASE=https://saysafe.onrender.com node scripts/e2e-browser.mjs` (the script uses the sandbox egress proxy for hosted runs since `d71bcac`).
- **Checks (14):** landing explains product · Try it as Mary opens the guided scam check · home has 4 shortcuts · one bottom nav (Home, Assistant, Activity, Profile) · Check a message opens the Assistant in check mode · fake PayPal support flagged · official PayPal contact recognised · malicious PayPal-looking link rejected · genuine PayPal invoice not called safe · family pairs with one-time code · large purchase awaits family approval · family decline prevents payment · small purchase creates a real sandbox order · redirects to PayPal sandbox approval page.
- **axe (0 violations):** landing desktop, landing mobile, home mobile, check result mobile, order awaiting mobile, family dashboard.
- **Limits:** the script stops at PayPal's approval page; it does not log in as a buyer. Mobile is an iPhone 13 viewport in Chromium, not Safari on a phone.

## 6. Hosted live payment verification (real PayPal sandbox)

Run against https://saysafe.onrender.com on 3 November 2026, 01:25–01:43, re-checked after the timeline fix at 01:57.

| Check | Result | Evidence (truncated) |
|---|---|---|
| Create, approve as sandbox buyer, capture €19.00 | Pass | order …6505H → capture …0294K, 19.00 EUR |
| Confirm before approval | Refused (409 `not_approved`) | |
| Duplicate confirm | Same capture returned, no second charge | PayPal order shows exactly 1 capture |
| Signed webhook | Verified and persisted | `PAYMENT.CAPTURE.COMPLETED` WH-…091R and WH-…62549 |
| Duplicate webhook (PayPal resend) | Ignored; state unchanged | resend of WH-…091R |
| Lost redirect → reconcile → Finish, €29.00 | Pass, one capture | order …9722X → capture …1058 |
| Live order status lookup | Both COMPLETED, 1 capture each | |
| Render restart | Data persisted (Turso replica); session still valid | restart 01:39 |
| Payment timeline | Failed (HTTP 500) on `7344e59`; **fixed in `c85741e`** and re-checked: created, approved, captured, Payments v2 capture check and signed webhook shown | |

## 7. Buyer approval on PayPal's hosted page (real PayPal sandbox)

2 November 2026, 22:04 UTC: sandbox personal buyer logged in on www.sandbox.paypal.com and completed the purchase; SaySafe captured EUR 32.00 (order 8C46…914U, capture 7GW7…353B); a second confirm returned the same capture. This receipt is the one shown on the landing page.

## 8. Sandbox refund (real PayPal sandbox, API)

Refund …3901 on capture 7GW7…353B: PayPal status COMPLETED, capture read back as REFUNDED. Made through PayPal's Payments v2 refund API. The in-app admin refund is **disabled on the hosted demo** until `ADMIN_TOKEN` is set, so a hosted in-app refund has not been run.

## 9. Scam detection evaluation (live AI)

Held-out set v2: 42 messages not used during calibration, run live through rules + Groq. Result: 2 false positives (AI over-warning on code/password quotes), 1 false negative (an unknown-number "hello" message). The original 52-message set went from 6 false positives to 0 after calibration, but that set informed the calibration, so it is not an independent measure. Details: [SCAM-DETECTION.md](SCAM-DETECTION.md). Nothing about senders is independently verified.

## 10. Voice (real browser, simulated microphone)

`node scripts/qa-voice.mjs` and `scripts/qa-mic.mjs`: Chromium headless with a fake media stream (silence and synthetic speech) and stubbed speech synthesis. Checks Stop, Pause/Resume, Escape, navigation silencing, mute, read-everything, no overlapping speech, follow-ups, and that silence is never sent. Real microphones and real speakers were not used.

## Not yet done

- Any test on a physical phone (iOS Safari, Android Chrome), including microphone permission, real speech and spoken output.
- The full Assistant → Demo Shop → family approval → PayPal buyer approval → receipt flow on a real phone.
- Family approval across two physical devices.
- Android share target on a device.
- Usability testing with older adults (only scripted walkthroughs so far) and screen-reader testing.
- Non-English reply languages (beta, English only verified).
- Hosted in-app refund (disabled until `ADMIN_TOKEN` is set).
