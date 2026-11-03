# SaySafe product overview

_Single source of truth for what SaySafe does today. Last checked 3 November 2026 against `main` d71bcac and the hosted demo at https://saysafe.onrender.com._

SaySafe is a payment safety companion for older adults and the family members who help them. It checks suspicious payment messages, helps people find products by voice or text, brings a trusted family member in for bigger purchases, and pays only through PayPal's own sandbox checkout, with a receipt it confirms with PayPal.

All payments use the **PayPal sandbox**. No real money moves. SaySafe is an independent hackathon project and is **not affiliated with or endorsed by PayPal**.

## How to read the status labels

| Label | Meaning |
|---|---|
| **Implemented and hosted** | In `main` and switched on in the hosted demo. [TEST-EVIDENCE.md](TEST-EVIDENCE.md) says which of these were exercised end-to-end on the hosted demo (browser test, live API call or live sandbox payment). |
| **Implemented, awaiting live verification** | In the code and covered by tests, but not yet confirmed on the hosted demo, a real device, or with a real person. |
| **In development** | Being built now. Not something to rely on yet. |
| **Planned** | Intended for later. Not in the code. |
| **Not supported** | SaySafe does not do this, by design or for now. |

"Tested" below always says how: mocked unit/integration tests (vitest), hosted browser tests (Playwright, headless Chromium), or real PayPal sandbox calls. See [TEST-EVIDENCE.md](TEST-EVIDENCE.md).

---

## 1. Before payment

| Feature | Status | Notes |
|---|---|---|
| Scam check of pasted text, links, email addresses and phone numbers | Implemented and hosted | Deterministic rules decide; the AI can only make a result stricter. Three verdicts only: *Suspicious*, *Needs checking*, *No obvious warning signs*. Never "safe". [SCAM-DETECTION.md](SCAM-DETECTION.md) |
| Fake-invoice / payment-request detection (e.g. a real PayPal invoice with a scam phone number in the note) | Implemented and hosted | A genuine paypal.com link never lowers the verdict. |
| Accuracy on unseen messages | Measured, with known errors | Held-out set v2, 42 cases, run live: 2 false positives, 1 false negative. A result is a judgement about the text, not proof. |
| Independent sender or link verification | Not supported | SaySafe never opens links, calls numbers or contacts senders. Optional URL reputation lists exist in code but are not configured on the hosted demo. |
| Screenshot reading | Implemented, awaiting live verification | Groq vision model transcribes the image; the text then goes through the same rules. Tested live on generated test images, not on a wide range of real screenshots. Images are not stored. |
| Share a message into SaySafe from another app (Android share target) | Implemented, awaiting live verification | Web app manifest share target to `/check/share`. Not tested on a real Android device. |
| Safe next steps and official PayPal help links | Implemented and hosted | Links come from a fixed, hand-checked directory, never from the message. |
| SaySafe Assistant (one conversation for checking, shopping and help, by text) | Implemented and hosted | The model returns an intent and text only. It has no tools and cannot pay, approve or change any record. [AI-TOOL-BOUNDARIES.md](AI-TOOL-BOUNDARIES.md) |
| Assistant interactive cards (scam result with actions, product cards, purchase review, family review status, approve/decline, receipt, history, refund status) | In development | Being finished on a separate branch. Until merged, some steps open their own screens instead of cards. |
| Voice input (tap the mic, speak, SaySafe sends after a pause) | Implemented, awaiting live verification | Groq Whisper speech-to-text. Tested in headless Chromium with a fake microphone only. Not yet tested on real phones. |
| Spoken replies with Stop | Implemented, awaiting live verification | Browser speech synthesis. Stop, Escape and navigation stop speech. Audio not checked on a real device. |
| Talk over SaySafe without tapping (hands-free barge-in) | Not supported | Tap-to-interrupt only. [VOICE.md](VOICE.md) |
| Real product discovery with Channel3 | Implemented and hosted | Real products, prices, images and merchant links from Channel3. **Discovery only**: buying opens the retailer's own website. SaySafe never pays a retailer. |
| Product comparison (best match, lower-cost option, another option) | Implemented and hosted | Deterministic ranking. Listed ratings are labelled as provided by Channel3; no reviews are read. |
| Ask family about a scam result (share a check with your trusted family member) | Implemented and hosted | The family member sees the verdict and headline in their view. |

## 2. During payment

| Feature | Status | Notes |
|---|---|---|
| SaySafe Demo Shop (the only place SaySafe can take a sandbox payment) | Implemented and hosted | 10 fictional products with original generated images. Prices always come from the server. |
| Exact purchase review (item, shop, price) before paying | Implemented and hosted | Shown and optionally read aloud. Voice "yes" never approves anything by itself. |
| Family spending threshold | Implemented and hosted | Default €75 in the demo. The family member can change it (€0–€500). Enforced on the server. |
| Family review: approve or decline the exact purchase, with expiry | Implemented and hosted | Bound to the exact basket, amount, currency and merchant; single use; expires. Decline blocks checkout. Tested over HTTP and in the hosted browser test with two sessions. Not yet tested on two physical phones. |
| Family member can never pay or approve the PayPal step | Implemented and hosted | Family approval never replaces the payer's own approval at PayPal. |
| PayPal sandbox buyer approval on PayPal's own page | Implemented and hosted | Live sandbox payments verified on 2 and 3 November 2026. |
| Secure capture (re-read the order from PayPal, check amount, currency and item, capture once) | Implemented and hosted | Idempotent PayPal-Request-Id. A duplicate confirm returns the same capture (verified live). A timeout is treated as "unknown", never "failed". |
| Cancel at PayPal returns with nothing charged | Implemented and hosted | |
| Lost redirect recovery (approved at PayPal but the page never came back) | Implemented and hosted | Reconcile reads PayPal and the user presses **Finish**. Verified live on 3 November 2026. SaySafe never captures automatically in the background. |
| Real-money (live) PayPal | Not supported | The server refuses non-sandbox PayPal unless explicitly reconfigured. |
| Buying from a Channel3 retailer inside SaySafe | Not supported | Retailer purchases happen on the retailer's site. |

## 3. After payment

| Feature | Status | Notes |
|---|---|---|
| Receipt confirmed from PayPal's capture data | Implemented and hosted | Shows amount, item, shop and PayPal's order and transaction numbers. Says "paid" only after PayPal confirms the capture. |
| Spoken receipt ("Read my receipt") | Implemented, awaiting live verification | Text checked in a live browser; audio not checked on a real device. |
| Payment timeline with evidence (created, family decision, captured, Payments v2 capture check, signed webhook) | Implemented and hosted | A webhook is shown as verified only when its PayPal signature check passed and it was stored. |
| Signed PayPal webhooks (verify signature, store, ignore duplicates) | Implemented and hosted | Verified live: signed events verified and persisted; a resent duplicate was ignored. |
| Data survives restart and redeploy | Implemented and hosted | Turso (free plan) embedded replica. Verified with a Render restart on 3 November 2026. [DATABASE.md](DATABASE.md) |
| Searchable Activity (payments, family decisions, scam checks) | Implemented and hosted | The Activity screen is being regrouped and relabelled on a separate branch (In development). |
| Refund request by the buyer | Implemented, awaiting live verification | The buyer can ask the shop for a refund; the screen says plainly that a request is not a refund. |
| Refund by the Demo Shop merchant (PayPal Payments v2 refunds) | Implemented, awaiting live verification | Code path is admin-only and is **disabled on the hosted demo** until an admin token is set. One sandbox refund was made and read back through the PayPal API on 3 November 2026 (refund ending …3901). |
| Automatic disputes or claims with PayPal | Not supported | SaySafe links to PayPal's Resolution Centre; the user opens a case themselves. No refund is promised. |
| "My order hasn't arrived" guidance | Implemented and hosted | Steps: check the receipt, contact the shop, then PayPal's Resolution Centre, then family. |
| Family Safety Insights (read-only dashboard for the family member) | Implemented and hosted | Native SaySafe dashboard: totals of captured payments, activity chart with a table alternative, searchable ledger, shared scam reviews, pending approvals, a read-only "ask about this activity" box. Example rows are labelled. |
| AG Studio view of Family Safety Insights | Not supported publicly | Built behind explicit configuration and off on the hosted demo, because the AG Studio trial licence is for evaluation only. [AG-STUDIO.md](AG-STUDIO.md) |
| PayPal Invoicing or Transaction Search | Not supported | The sandbox app returns 403 for these scopes. SaySafe cannot read the user's PayPal account. |

## 4. Accessibility

| Feature | Status | Notes |
|---|---|---|
| WCAG 2.2 AA target: large text, 48 px+ touch targets, visible focus, keyboard use, skip link, no colour-only meaning | Implemented and hosted | axe-core: 0 violations on 6 hosted screens (3 November 2026). Automated checks only. |
| Bigger text and high contrast | Implemented and hosted | Display settings are being moved into Profile on a separate branch (In development). |
| Reduced motion | Implemented and hosted | Follows the device setting. |
| Captions for everything spoken | Implemented and hosted | Every spoken reply is also on screen. |
| Usability testing with older adults | Not done yet | Only scripted walkthroughs so far. |
| Screen reader testing with real assistive technology (VoiceOver, TalkBack, NVDA) | Planned | |

## 5. Language support

| Feature | Status | Notes |
|---|---|---|
| English | Implemented and hosted | Screens, replies and voice. |
| Reply language (beta): Spanish, Polish, French, German, Portuguese | Implemented, awaiting live verification | Changes what SaySafe says and hears. Screens, currency (EUR) and product search stay English. Only English has been verified. |
| Irish, Hindi, Arabic | Not supported | Not offered: speech recognition or right-to-left captions are not ready. |
| Translated screens | Planned | |

## 6. Personalisation

| Feature | Status | Notes |
|---|---|---|
| Shopping preferences (favourite colours, brands, styles, things to avoid, usual budget) | Implemented and hosted | Saved on the server for the signed-in demo user; can be edited or cleared. Used only to rank products whose listing contains the term. |
| Voice preferences (mute, auto-speak, speed, read everything, reply language) | Implemented and hosted | Saved on this device only. |
| Family threshold set by the trusted family member | Implemented and hosted | |
| Profile sections (voice, accessibility, language, shopping, trusted family, privacy, help) | In development | Being reorganised on a separate branch. |

## 7. What SaySafe will never do

- Pay, approve or change a payment because an AI said so.
- Let a family member pay from the user's account.
- Call a message, link or seller "safe".
- Open links or call numbers found in a message.
- Say "paid" before PayPal confirms the capture.
- Show a webhook as verified unless its signature check passed.
