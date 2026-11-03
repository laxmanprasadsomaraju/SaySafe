# Manual acceptance: the flagship journey

The one part of the flagship journey that automation cannot honestly claim is the **buyer's approval on PayPal's own
sandbox page**: it needs a PayPal Sandbox personal (buyer) login. `scripts/e2e-flagship.mjs` against the hosted app
stops at the PayPal redirect and reports that step as **MANUAL**. This checklist is how a person completes and records
it. Times in GMT (= Irish time in November). PayPal Sandbox only: no real money moves.

**Never write the sandbox buyer password, client secrets or webhook ids into the repository, a screenshot or a video.**
Judges receive the buyer login privately in the Devpost testing instructions.

## Before you start

- [ ] Note the deployed commit (Render dashboard or the deploy log) and the start time.
- [ ] Open https://saysafe.onrender.com and wait until the landing page loads (the free host sleeps).
- [ ] Use a fresh browser profile, so you start as a new visitor.

## Steps

| # | Do | Expect | Pass? |
|---|---|---|---|
| 1 | Choose **Try as Mary** | Assistant opens with a welcome card, "Sample data" labels and the "PayPal Sandbox only: no real money" note | ☐ |
| 2 | Type *I received a message saying I owe €120. Can you check whether I already paid?* | Possible matches from Mary's records, each labelled **Sample data**; it says a matching amount is not proof; nothing claims "paid" | ☐ |
| 3 | Type *Can you help me buy a microwave instead?* | Real Channel3 listings (open the retailer's site, no PayPal button) and, separately, the **SaySafe Demo Shop** microwave (PayPal Sandbox) | ☐ |
| 4 | Type *Let's buy the demo microwave.* | Review card: Simple Dial Microwave 20L, **€120.00 EUR**, "above your €75.00 limit" | ☐ |
| 5 | Ask your family to check (Allow) | **Family review: Pending**, "Nothing is paid yet" | ☐ |
| 6 | Tap **Try as Alex too** (on the card, or Profile › Trusted family) | Alex's family view: exact item, shop, €120, requester and expiry, Approve / Decline | ☐ |
| 7 | As Alex, tap **Approve**; go back to Mary's Assistant | Mary's same card shows **Approved** and **Continue to PayPal**, without a reload | ☐ |
| 8 | Tap **Continue to PayPal** | Browser is on `https://www.sandbox.paypal.com/checkoutnow?token=…`; amount EUR 120.00 | ☐ |
| 9 | Sign in with the sandbox **buyer** login and choose **Complete Purchase** once | Back on SaySafe; "Confirming with PayPal…" then the receipt | ☐ |
| 10 | Read the receipt | **Payment successful · Captured**, €120.00 EUR, Family approval Approved, Your approval at PayPal Approved, capture "checked with PayPal". Webhook may say **Verification pending** at first | ☐ |
| 11 | Reload after ~20 s and again after ~60 s | Same capture id and order id, **Webhook verified — signed PayPal notice**, Refund: None, no second capture | ☐ |
| 12 | Ask *Did my payment go through?* twice, then reload the Assistant | The same receipt each time; the conversation is still there after reload | ☐ |
| 13 | Open **Activity**, search *microwave* | The purchase is labelled **Real PayPal Sandbox transaction**, apart from the "Sample data" rows; it opens the same receipt | ☐ |
| 14 | Home › **View insights** (Mary), then Alex's Family page › **View insights** | Mary: payments by kind of record, sandbox €120.00 not added to sample amounts. Alex: sandbox captures counted separately from example data; ledger Source column | ☐ |

## Release-readiness checks (A–D, G, H)

Run on the deployed build after the flagship steps above (steps 12–14 leave a captured purchase in the conversation).

| # | Do | Expect | Pass? |
|---|---|---|---|
| A1 | Fresh visitor (new profile): **Try as Mary**, ask *Did my payment go through?* before buying anything | "No PayPal Sandbox payment yet. Nothing has been paid in this app…" plus the Demo Shop chips; never "paid" | ☐ |
| A2 | After step 11: **+ › Check a message**, ask *Did my payment go through?*, then (still in that mode) *Was I charged?* | The receipt card each time; no scam-check result | ☐ |
| A3 | **+ › My payments**, ask *Where's my receipt?* | The receipt card | ☐ |
| A4 | Ask *Help me buy a microwave* (listings on screen), then *did it go through* | The receipt card (not a product answer) | ☐ |
| A5 | Reload the Assistant, ask *Have I been charged?* | The receipt card; no second capture (receipt page shows the same capture id) | ☐ |
| A6 | **+ › Check a message**, paste a long message (>25 words) that contains a link or phone number and the words "your payment did not go through" | A scam-check result, not a receipt | ☐ |
| B1 | Fresh visitor: open the Assistant and Profile › Voice & conversation | "Spoken replies off" and a **Turn on spoken replies** button (not pressed); no sound plays on any reply; nothing says "Muted" | ☐ |
| B2 | Press **Turn on spoken replies**, reload, ask *What can I buy?* | Button pressed, "Spoken replies on" after reload; the short reply is read aloud (if the browser asks for a tap first: "Tap to enable sound") | ☐ |
| B3 | Tap **Speak** (mic) with spoken replies off | Voice input works the same; the reply is shown, not spoken | ☐ |
| C1 | Ask *Show my subscriptions*, then *Cancel my streaming subscription* | Fictional names only (StreamBox Plus, TuneWave Premium, The Daily Ledger digital, ParcelPass yearly), each labelled Sample; the cancel card says **This is sample data** with an in-app link, no company link | ☐ |
| C2 | Ask *Did I already pay for the microwave?* | The sample record is "Hearthside Appliances" (fictional), not a real shop | ☐ |
| D1 | Mary: Home › **View insights** | Sandbox, sample and recorded-by-you amounts shown apart, each currency on its own, subscriptions per month = yearly ÷ 12, John Smith pair flagged as a possible duplicate (sample), training scam checks not counted as incidents | ☐ |
| D2 | Alex: Family › **View insights** | No Mary records, subscriptions, contacts or unshared scam checks; sample rows labelled; only scam checks Mary shared | ☐ |
| G1 | Ask *I want to buy a Nike t-shirt* (desktop, spoken replies on) | Real Channel3 listing cards first (bought on the retailer's site), then the Demo Shop chips; the reply never says "I'll also look"; spoken: "That's not in the Demo Shop…" | ☐ |
| G2 | Ask for something Channel3 has nothing for (or with Channel3 down) | "That's not in the Demo Shop. I searched real shops… and found no matching listings" (or "couldn't reach") with a **Search real shops** chip; saying *real product search* searches again | ☐ |
| H1 | At 1280×720, 1440×900 and ~2000 px wide: scroll to the bottom of a long Assistant conversation, then Activity and Profile | The top nav (Home/Assistant/Activity/Profile/Insights/Website) stays at the top; on the Assistant the title row with **Menu** stays under it; the composer stays at the bottom. Phone: the bottom tab bar stays | ☐ |
| A7 | Ask *Was I charged twice?*, *Was my payment successful?*, *Did PayPal take the money?* | Each shows the latest receipt card (or "No PayPal Sandbox payment yet"), read-only, never a scam check | ☐ |
| P1 | Sandbox buyer pays with a payment method PayPal declines | The purchase ends as "did not go through": **Nothing was charged**, start again from the Demo Shop; it never stays on "Confirming payment" | ☐ |
| S1 | Default build (no `VITE_AG_STUDIO_LICENSE`): Alex › Profile, and the built `web/dist/assets` | No "Insights: AG Studio view" link; no `StudioDashboard` chunk in the build | ☐ |

Automated equivalents: `tests/payment-status.test.ts`, `tests/speech.test.ts`, `tests/sample-brands.test.ts`,
`tests/insights-verification.test.ts`, `tests/not-in-demo-shop.test.ts`, `tests/payment-engine.test.ts` (declined),
`tests/ag-studio-build.test.ts`, and sections 8b, 10b, 10c of
`scripts/e2e-flagship.mjs` (local, mock PayPal + recorded Channel3 responses).

## Record the result

Add a row to [TEST-EVIDENCE.md](TEST-EVIDENCE.md) (§F) with: date and times, deployed commit, PayPal order id,
capture id, webhook status after reload, whether any second capture appeared, and anything that failed. Order and
capture ids are sandbox test identifiers and may be recorded; logins and secrets may not.

## Recorded runs

| Date (GMT) | Build | PayPal order | Capture | Outcome |
|---|---|---|---|---|
| 3 Nov 2026, 14:37–14:39 | hosted (commit not recorded) | 14N79698ML703613G | 4K097800X0771815W | Started from "Help me buy a demo item": steps 1, 4–11 and 13 passed; steps 2, 3, 12 and 14 not run. Webhook verified on reload; one capture |
| 3 Nov 2026, 15:44–15:52 | `d630e97` | 9BP28498Y7570471J | 96T3543906935310P | Steps 2 and 4–13 passed (step 3, the Channel3 listings, not recorded); step 12 needed the "My payments" mode on that build; webhook verified ~4 s after capture; no double charge; step 14 only for Alex (Mary's `/insights` did not exist on that build) |

The `flagship` branch (Mary's `/insights`, "Try as Alex too" on the card, payment-status routing) has passed the local
browser suite against the mock PayPal only. Repeat this checklist on the hosted app after it is deployed.
