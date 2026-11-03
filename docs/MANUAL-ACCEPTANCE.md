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
