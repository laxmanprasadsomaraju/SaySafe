# Payment companion (phase 1: server)

Helps Mary answer three everyday questions by voice or chat, using **only her own records**:

1. **"Have I already paid John?"** — searches her SaySafe Demo Shop payments and payments she recorded herself.
2. **"What do my subscriptions cost, and how do I cancel one?"** — a manual subscription tracker (prototype) plus one real PayPal sandbox subscription, the *SaySafe Demo Membership*.
3. **"Is this message really from my son?"** — trusted contacts she saved, used by the scam check (`contact_mismatch`).

SaySafe never pays, blocks, marks anything as paid, or cancels anything on its own. The UI cards come in phase 2 (`shared/companion.ts` holds the zod schemas they use).

## Data sources

| Source | Label shown | What it proves |
|---|---|---|
| `paypal_sandbox` — Demo Shop payments made in this app (`payment_requests` in CAPTURED / REFUND_PENDING / REFUNDED) | "SaySafe Demo Shop (PayPal sandbox)" | Recipient is always **SaySafe Demo Shop**. Evidence: capture status, and whether a signed `PAYMENT.CAPTURE.COMPLETED` webhook was verified. |
| `manual` — payment records Mary types ("I paid John €80 by bank transfer on 1 Oct") | "Recorded by you, not verified" | Nothing beyond what she typed. SaySafe can't see whether money arrived. |
| Subscriptions, `manual` (external merchants) | "Prototype: you enter these yourself…" | Nothing. Totals are her own figures. |
| Subscription, `paypal_sandbox_subscription` (SaySafe Demo Membership, €2.99/month) | PayPal's status, last checked time, webhook-verified flag | PayPal's own answer (GET `/v1/billing/subscriptions/{id}`, or a signed `BILLING.SUBSCRIPTION.*` webhook). |
| Trusted contacts | "Saved by you — not verified" | Nothing. Used only to compare against what a message claims. |

No imports (bank, PayPal wallet, contacts) in this phase.

## "Have I already paid X?" — matching

`GET /api/companion/payments/search?q=&amount=&from=&to=` (also reached by the assistant's `payment_search` intent).

Each match has `score` (0–1), `matchReasons` and `caveats`:

- **Names**: exact, prefix ("John" ↔ "Johnny"), one typo ("Jon" ↔ "John", with a "spelled differently" caveat). A first name matching a fuller name gets a "partial name" caveat. A contradicting surname ("John Murphy" vs "John Smith") is **not** a match. Several different people behind one name → a note.
- **Amounts**: exact, close (±€1 or 2%, caveat), different (shown only when the name matches, with both amounts stated). An amount that appears more than once in her records gets a "could be a different one" caveat.
- **Dates**: within the window; up to 3 days off (caveat with the number of days); further → "off by more than 3 days".
- **Possible duplicate**: two manual records, same person, same amount, within 3 days.
- **Guidance** text is always about uncertainty, e.g. "A record you typed is not proof the money arrived. Don't pay again until you've checked with John." With no match: "I couldn't find a record of paying John. That doesn't mean you haven't paid…"

### Hard rule: a person's name never matches a Demo Shop payment

A query naming a person (e.g. "John") **excludes** SaySafe Demo Shop payments entirely, even when the amount and date are identical. Only a query about the shop or an item it sold ("kettle", "demo shop"), or a search with no name (amount/date only), can return them.

*Why exclude rather than list it as "not a payment to John":* in a voice answer, any payment read out next to John's name sounds like evidence about John. An amount coincidence is not a link, and the safe answer for an older user is "I found no record of paying John". The response carries one plain note instead: "SaySafe Demo Shop payments are not shown: they are shop purchases, not payments to John." Tested in `tests/companion-match.test.ts` and over HTTP/assistant.

## Subscriptions

### External merchants (manual, prototype)
- Fields: merchant, amount, currency, frequency (weekly/monthly/yearly), next date ("next payment in N days" — no reminders, there is no free cron).
- **Summary**: monthly = weekly×52÷12, monthly, yearly÷12; annual = weekly×52, monthly×12, yearly. **Per currency, never converted.** Not counted: stopped tracking, user-reported cancelled, PayPal-confirmed cancelled, a Demo Membership not yet approved.
- **Help me cancel** (`POST /subscriptions/:id/cancel-help`): the merchant's **official** cancellation page from `shared/cancelGuides.ts` (else generic steps — never a guessed link) **plus** PayPal's automatic payments page `https://www.paypal.com/myaccount/autopay/` (the user signs in to PayPal themselves). Moves the status to `instructions_opened`.
- Statuses: `tracking → instructions_opened → user_reported_cancelled` (and back to `tracking`). `user_reported_cancelled` is labelled **"You told SaySafe this is cancelled — not confirmed by the provider"**. External subscriptions can **never** reach `provider_confirmed` (route rejects it, and a DB `CHECK` forbids it for `source='manual'`).
- **Stop tracking** is separate from cancelling: SaySafe stops counting it and says nothing about the company.

### SaySafe Demo Membership (real PayPal sandbox subscription)
SaySafe Demo Shop is the merchant, so this is the one subscription SaySafe can cancel.

- Plan: created by `scripts/paypal-setup-plan.ts` (idempotent: finds the product/plan by name, creates only when missing, fixed PayPal-Request-Ids). Its id goes in **`PAYPAL_DEMO_PLAN_ID`** (never hardcoded). Without it the demo routes answer 503.
- `POST /api/companion/subscriptions/demo/start` → PayPal subscription with `custom_id` = household; returns PayPal's approve link. The row id is the durable PayPal-Request-Id (written before the call). Calling start again reuses the pending/active one.
- `GET /api/companion/subscriptions/demo/return` — PayPal's return URL. Reads PayPal, then redirects to `/assistant?membership=<status>`.
- `GET /api/companion/subscriptions/demo/status` — refreshes from PayPal (throttled 5 s). Evidence: PayPal status, last checked, webhook verified.
- Webhook (`/api/paypal/webhook`, same signature verification as captures): `BILLING.SUBSCRIPTION.*` updates the row matching **both** the PayPal id and `custom_id`. A signed `CANCELLED` sets `provider_confirmed` (confirmed by `paypal_webhook`).
- **Cancel is two steps:**
  1. `POST …/demo/cancel-intent` → a single-use token (hash stored, 5 minutes) and the exact text **"Cancel SaySafe Demo Membership billing via PayPal"**. Only for ACTIVE/SUSPENDED.
  2. `POST …/demo/cancel {token}` — elder session only, token bound to the household, used once. Calls PayPal cancel, **then GETs the subscription**; only `CANCELLED` sets `provider_confirmed` (confirmed by `paypal_api`). PayPal 4xx/5xx/timeout → `retry_needed` (HTTP 202, error shown, nothing confirmed); retry needs a new tap. If PayPal already shows CANCELLED (cancel answered 4xx), it's treated as done after the GET (`already_cancelled`).
- The assistant can only create the **cancel-intent card** (`demo_cancel_intent`). It has no path to the cancel call; a spoken "yes" (`confirm`) never cancels. Cancelling needs the tap that sends the token.
- It can't be edited, moved by the manual status route, deleted, or wiped by "delete all" while PayPal still bills it.

### Two different things get cancelled
- **PayPal billing authorisation** (automatic payment): stops PayPal paying a merchant.
- **Service contract**: between the user and the merchant.

For the Demo Membership both are SaySafe Demo Shop, so cancelling the billing ends the membership. For external merchants SaySafe cancels neither: the user stops the PayPal automatic payment in PayPal (optional) **and** cancels with the merchant. Every subscription carries `cancellationScope` with this wording.

| Cancellation | Where it happens | Who confirms |
|---|---|---|
| SaySafe Demo Membership | Inside chat: confirmation card → tap → PayPal API | PayPal (GET shows CANCELLED, or signed webhook) → `provider_confirmed` |
| External merchant (Netflix, Sky…) | On the merchant's own site/app (official link) | The merchant. SaySafe only records "You told SaySafe this is cancelled — not confirmed by the provider" |
| PayPal automatic payment to an external merchant | In the user's PayPal account (`/myaccount/autopay/`), signed in by the user | PayPal / the user. SaySafe can't see or change it |

### Cancellation directory (`shared/cancelGuides.ts`), verified 2026-11-03

| Service | Official URL | Check |
|---|---|---|
| Netflix | https://help.netflix.com/en/node/407 | HTTP 200, title "How to cancel Netflix" |
| Spotify Premium | https://support.spotify.com/ie/article/cancel-premium/ | HTTP 200, title "How to cancel Premium plans" |
| Disney+ | https://help.disneyplus.com/article/disneyplus-cancel-subscription | HTTP 200; body is rendered by JavaScript, text not machine-checked |
| Amazon Prime | https://www.amazon.co.uk/gp/help/customer/display.html?nodeId=GTJQ7QZY7QL2HK4Y | HTTP 200, heading "Cancel Your Amazon Prime Membership" |
| Apple | https://support.apple.com/en-ie/118428 | HTTP 200, title "Cancel a subscription from Apple - Apple Support (IE)" |
| Google One | https://support.google.com/googleone/answer/9056360?hl=en-GB | HTTP 200, title "Cancel your Google One membership" |
| NOW | https://www.nowtv.com/ie/help/article/how-do-i-cancel-now | HTTP 200, title "How to cancel your NOW Membership" |
| Sky TV (Ireland) | https://www.sky.com/help/articles/cancel-sky-tv-roi | HTTP 200, title "Cancelling Sky TV", mentions 31 days notice |
| PayPal automatic payments | https://www.paypal.com/myaccount/autopay/ | Redirects to PayPal sign-in with `returnUri=/myaccount/autopay` (sign-in page; plain fetches get 403 bot protection). Linked from PayPal's own help article "What is an automatic payment and how do I update or cancel one?" |

## Trusted contacts and the scam rule `contact_mismatch`

Name, relation, phone, email, note; max 50; private to Mary.

When a scanned message **claims** to be a saved contact — by relation ("your son", "Hi Mum it's me" for a son/daughter, "Hi Granny" for a grandchild) or by name in a claim ("it's Tom", "Tom here", a sign-off) — and it contains a phone number or email that differs from the saved one, or says "new number":

- evidence: **"This says it's from Tom, but the number isn't the one you saved"** (medium, identity family), and the advice "Call Tom on the number you saved (ending 4567) before you do anything…", also spoken first.
- same number as saved → info note: "The number matches Tom's saved number, but numbers can be spoofed".

Contacts are read server-side from the signed-in elder's household and **never sent to the AI provider**: contact signals are removed from the model's brief, the model sees the verdict from before the contact check, and `/api/scan/explain` strips them too. Scam evaluation: the eval runs without contacts, so `cases.json`, `holdout.json` and the frozen `heldout-v2.json` results are unchanged (v2 offline: 35/42, 3 false negatives, 0 false positives — same as before).

## Assistant intents

`/api/assistant` gained `payment_search {recipient, amount, date_hint}`, `last_payment {recipient}`, `monthly_costs`, `subscription_help {merchant}`, `contact_lookup {contact_name | relation}`. The AI only picks the intent and extracts parameters (each falls back to null when malformed). The server runs the query on the elder's records and writes the reply from a template; the model's reply is discarded, so it can't claim "I marked John as paid". The model never sees records or contacts. There is no write path from the assistant. A rules-only fallback handles the same questions when the AI is unavailable. Response: `{ …, companion: <CompanionCard> }`.

## Privacy

- Elder-only: `requireElderOnly` — no session 401, a family session 403. Household always from the session cookie.
- Never in family endpoints, insights, or the family activity feed. Nothing is written to `audit_log` (which feeds insights). Contents are never logged. `Cache-Control: no-store`.
- Per-item delete, and `DELETE /api/companion/all {confirm:true}` (payment records, subscriptions, contacts, cancel tokens; Demo Shop payments untouched; refused while the Demo Membership is still billing).
- Rate limits: global API limit, plus 60/min per session on companion routes and 10/min on demo membership start/cancel.
- Tables: `companion_payments`, `companion_subscriptions`, `companion_contacts`, `companion_cancel_tokens` (idempotent `CREATE TABLE IF NOT EXISTS`; lower-case, non-keyword column names for the Turso key folding).

## PayPal boundaries

- **Merchant APIs can't read a buyer's wallet history.** SaySafe's PayPal app is the Demo Shop merchant; it only sees its own orders and its own subscriptions.
- **Log in with PayPal** gives identity attributes, not transaction history.
- **Payouts** is merchant-to-recipient disbursement, not a person's personal "send money"; SaySafe doesn't use it to pay people.
- **SaySafe can't cancel other merchants' subscriptions** or PayPal automatic payments to them. The Subscriptions API cancels only subscriptions created by this merchant app — that's exactly the Demo Membership.
- Subscriptions API is used **only** for the SaySafe Demo Membership (sandbox).
- Live probe (2026-11-03, sandbox app APP-88D74049KB273115F): products 201, plans 201, subscriptions 201 `APPROVAL_PENDING` with an `approve` link, GET 200; cancel on an `APPROVAL_PENDING` subscription returns **404 RESOURCE_NOT_FOUND** (cancel applies to ACTIVE/SUSPENDED); `BILLING.SUBSCRIPTION.ACTIVATED/CANCELLED` exist as webhook event types. The 204 on an ACTIVE subscription needs a buyer approval first (see below).

## Setup and buyer approval (sandbox)

```bash
# 1. Plan (idempotent; prints PAYPAL_DEMO_PLAN_ID=P-…)
PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… npx tsx scripts/paypal-setup-plan.ts
# 2. Set PAYPAL_DEMO_PLAN_ID on the server, and add BILLING.SUBSCRIPTION.ACTIVATED / .CANCELLED (and optionally
#    .SUSPENDED / .EXPIRED) to the existing webhook's event types in the PayPal developer dashboard.
# 3. In the app (browser, signed in as Mary) or with a cookie jar:
curl -c jar -b jar -X POST https://<host>/api/demo/start -H 'Content-Type: application/json' -d '{"name":"Mary"}'
curl -c jar -b jar -X POST https://<host>/api/companion/subscriptions/demo/start -H 'Content-Type: application/json' -d '{}'
#    -> open "approveUrl" in the same browser session, approve with the sandbox buyer account, PayPal returns to
#       /api/companion/subscriptions/demo/return -> /assistant?membership=active
# Without the app (probe only): creates a subscription and prints the approve link; then GET / cancel it
npx tsx scripts/paypal-setup-plan.ts --probe-subscription <householdId> https://<host>
npx tsx scripts/paypal-setup-plan.ts --get I-XXXX
npx tsx scripts/paypal-setup-plan.ts --cancel I-XXXX     # expect "cancel -> 204", then "get -> 200 … CANCELLED"
```
(Inside the Hark sandbox, Node needs `NODE_USE_ENV_PROXY=1` so credentials are injected on the wire.)

## Known gaps
- No UI yet (phase 2: cards + voice in `web/src`).
- `scripts/reset-demo.ts` doesn't delete companion rows explicitly; locally they cascade with the household, on Turso (FKs may be off) they'd be orphaned.
- The PayPal 204 cancel on an ACTIVE subscription and live `BILLING.SUBSCRIPTION.*` delivery are verified only after a buyer approves and the webhook event types are added.
- Name matching is English-centric (no phonetic matching beyond one typo).
