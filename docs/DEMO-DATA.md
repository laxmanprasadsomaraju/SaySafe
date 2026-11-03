# "Try as Mary" demo data

## Why Mary used to be empty (root cause)

`POST /api/demo/start` calls `startDemoHousehold()` (server/auth.ts), which creates a **brand-new, isolated household per visitor** (new `users`, `households` and `spending_policies` rows, new session cookie). That isolation is deliberate (judges must not see each other's data), but **nothing ever seeded the new household**: the only seed scripts (`scripts/qa-seed-ux.ts`, `scripts/seed-insights-demo.ts`) are local-QA tools that refuse hosted databases. So Activity, the companion (payments, subscriptions, contacts) and the family view were empty **by design**, and the Assistant correctly answered "no record".

What was checked and is not the cause:

| Question | Finding |
|---|---|
| Stable demo user id? | No: each Try as Mary is a new household (intended). The session cookie keeps it for 7 days in that browser. |
| Seed migrations in production? | There were none for demo data. |
| Data lost when Render sleeps? | No: production uses Turso (embedded replica, writes go to the primary). Verified locally with a file DB across a restart (14 items before and after). |
| Wrong user/session id in queries? | No: every query uses `household_id` from the session cookie. |
| Auth filters hiding data? | No: companion routes are elder-only (family gets 403), activity is household-scoped. |
| Assistant not connected? | It was connected to `/api/companion/*` for 5 intents, but "Show my last payment" was answered on the device from Demo Shop receipts only, and AI misrouting could send data questions to "chat". |
| Failed calls shown as empty? | In the Assistant, an error became a plain text bubble (no Retry); Activity showed an error notice without Retry; Home swallowed errors. |

## The fix

- `server/demo/seed.ts` seeds a deterministic, labelled sample set into **that visitor's own household** on `POST /api/demo/start`, and again on `POST /api/demo/reset` ("Reset Mary's demo"). It is stored in the same database as everything else (Turso in production), so it survives restarts and redeploys. Reset replaces sample rows only; real PayPal Sandbox payments and records the visitor typed are kept.
- Every sample row has `example = 1` (new column on `payment_requests`, `companion_payments`, `companion_subscriptions`, `companion_contacts`, added by an idempotent `ALTER TABLE` migration in `server/db/schema.ts`). `demo_seeds` records the seed version and anchor time per household.
- Ids are derived from `sha256(household:key)`, so a reset gives the same ids and two households never collide.
- `DEMO_SEED=off` is set only in `vitest.config.ts`, for the older unit tests that need an empty household.

## Seed data (dates relative to the moment of seeding)

### Demo Shop-style purchases (`payment_requests`, example=1, **no PayPal ids**)

| Item | Amount | State | Days ago | Family review |
|---|---|---|---|---|
| Easy-Pour Electric Kettle 1.5L | €32.00 | CAPTURED (completed demo purchase) | 52 | — |
| Easy Tune Radio | €39.00 | PAYER_APPROVAL_PENDING (pending) | 1 | — |
| Wide-Slot Toaster | €29.00 | CANCELLED | 33 | — |
| Simple Dial Microwave 20L | €120.00 | CAPTURED | 40 | approved |
| Bright Reading Lamp | €35.00 | CAPTURE_PENDING (awaiting verification) | 3 | — |
| Weekly Pill Organiser with Alarm | €19.00 | REFUNDED (illustrative refund) | 45 | — |
| Soft Heated Throw | €59.00 | FAMILY_APPROVAL_PENDING | 0 | pending (sample, not actionable) |
| One-Button Coffee Maker | €65.00 | CANCELLED | 18 | declined |
| Big Button Home Phone | €45.00 | FAMILY_APPROVAL_PENDING | 27 | expired |

### Payment records (`companion_payments`, example=1) — illustrate "recorded by you"

| Recipient | Amount | Method | Days ago | Note |
|---|---|---|---|---|
| John Smith | €80.00 | bank transfer | 12 | Fence repair |
| John Smith | €80.00 | bank transfer | 10 | Fence repair (paid again?) — **possible duplicate pair** |
| Currys | €89.00 | card | 24 | Microwave |
| Pat Doyle | €40.00 | cash | 5 | Hedge trimming |
| Riverside Pharmacy | €18.50 | card | 2 | Prescription |

### Subscriptions (`companion_subscriptions`, example=1, source manual; amounts illustrative)

| Merchant | Amount | Frequency | Next charge | How it is managed |
|---|---|---|---|---|
| Netflix | €12.99 | monthly | in 6 days | official link (help.netflix.com/en/node/407) |
| Spotify Premium | €11.99 | monthly | in 13 days | official link |
| The Irish Times digital | €9.99 | monthly | in 20 days | general steps (no checked link — none is invented) |
| Amazon Prime | €95.00 | yearly | in 41 days | official link |

Plus the **real** SaySafe Demo Membership (PayPal Sandbox subscription, €2.99/month) offered as "Try the Demo Membership": start → approve at PayPal → cancel in chat by tap (PayPal API, then GET-confirmed).

### Trusted contacts (`companion_contacts`, example=1) — non-routable

| Name | Relation | Phone | Email |
|---|---|---|---|
| Alex Byrne | family helper | +44 7700 900101 | alex.byrne@example.com |
| Sarah | daughter | +44 7700 900102 | sarah@example.com |
| Pat Doyle | gardener | +44 7700 900103 | — |
| Riverside Pharmacy | pharmacy | +44 20 7946 0104 | hello@riverside-pharmacy.example.com |
| Shannon Boiler Services | boiler service | +44 20 7946 0105 | bookings@shannon-boiler.example.com |

Numbers are in Ofcom's ranges reserved for TV/radio drama; emails use example.com (RFC 2606). Call and Email buttons are not shown for sample contacts.

### Training examples (tap to try, labelled "Training example")

1. PayPal invoice from "Geek Support Services" asking you to call +44 20 7946 0999 → **Suspicious**.
2. "Hi Mum, it's Sarah… new number +44 7700 900999… send €250" → **contact mismatch** with Sarah's saved number.
3. Ordinary SaySafe Demo Shop dispatch notice, no link/number/request → **No obvious warning signs**.

## Labels

| Label | Where | Meaning |
|---|---|---|
| Sample data · Illustrative — no PayPal record | Activity, Home, Assistant cards, order page, family view | Seeded example. Server refuses every action on it: checkout, confirm, cancel, finish, reconcile, refund request, family decision (409 `sample_not_actionable`), and `transition()` itself throws. |
| Real PayPal Sandbox transaction | Activity, history card, last-payment card | Made in this app; PayPal's own evidence (capture, Payments v2 read-back, signed webhook). |
| Recorded by you — not verified | Records, subscriptions, contacts the user typed | Only what they typed. |
| User-imported | — | Not implemented. |

## The Assistant

- `server/companion/router.ts` routes questions about Mary's own records **by rules, before the AI** (same answer with or without Groq; typed and spoken both POST the transcript to `/api/assistant`). Intents: `payment_search`, `last_payment`, `monthly_costs`, `subscription_list` (all / most / next), `subscription_help` (merchant or kind, e.g. streaming → Netflix), `contact_lookup` (name, relation, or all), `send_money`.
- The server queries the database and writes the reply from a template; the model's reply is discarded for these intents.
- **Send money**: contact card → choose → check amount and recipient → "Open PayPal Send money" (https://www.paypal.com/ie/digital-wallet/send-receive-money/send-money, HTTP 200 on 2026-11-03) with "Nothing is sent by SaySafe". PayPal Payouts is not used. The app never says money was sent.
- A failed request renders an error card with **Retry** (re-sends the same text), never "no records". Activity and Home also show Retry on errors.
