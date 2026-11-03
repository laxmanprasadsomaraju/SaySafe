# AI tool boundaries

SaySafe's models (Groq, optional OpenAI-compatible fallback) **produce intents and text only**. They have no
function-calling, no tools and no database or PayPal access. Every privileged effect is a separate HTTP route
that checks the session, household, catalogue prices, policy and family approval in server code.

Covered by `tests/ai-adversarial.test.ts` (hostile model outputs) and `tests/ai-reliability.test.ts` (failures).

## Inventory: everything a model output can reach

| # | Model call (file) | Route | What the model returns | Server-side effect of that output | Read-only vs privileged | Where it is enforced |
|---|---|---|---|---|---|---|
| 1 | `interpret()` (`server/ai/agent.ts`) | `POST /api/assistant` | One `Intent` (zod schema): `action` ∈ shop / select_product / check_message / trusted_help / order_problem / confirm / cancel / chat, `query`, `max_price_eur`, `choice_index`, `message_text`, `reply` | `shop` → `searchProducts(query, max)` over the **static catalogue**; the model's `reply` is replaced by `describeOptions()` built from catalogue prices. Every other action: **none** (returned to the browser) | Read-only | `Intent` schema strips unknown keys (price, currency, tool, approve…); invalid output → `fallbackIntent()` rules; `searchProducts` returns catalogue objects verbatim |
| 2 | `interpret()` | `POST /api/discover` | Same `Intent` | `query` / `max_price_eur` become the Channel3 search text and price **filter**. Results are discovery-only links to retailers | Read-only | `searchChannel3` (`server/catalogue/channel3.ts`): https-only offers, requested currency only, no conversion; Channel3 ids are not catalogue ids, so they can never be quoted or paid (`priceCart` → `unknown_product`) |
| 3 | `scanMessage()` AI assessment (`server/scam/guardian.ts`) | `POST /api/scan`, `POST /api/scan/image` | `verdict` ∈ suspicious / needs_verification only, `reasons`, `spoken_summary` | Can only **lower** confidence: `mergeVerdict` never lets AI grant `verified_official_contact`. Spoken text is replaced by deterministic wording if it disagrees with the final verdict **or** vouches for safety / says pay, click, go ahead (`server/ai/outputGuard.ts`). Stored: verdict + headline only | Read-only (writes a scan row with the deterministic headline) | `AiAssessment` schema, `mergeVerdict` (rules), `vouchesOrInstructs` output guard |
| 4 | `extractFromImage()` vision (`guardian.ts`) | `POST /api/scan/image` | Transcribed text, links, emails, phones | Text goes into the **rule engine** like pasted text (untrusted data). Image never stored | Read-only | `VisionExtract` schema; same rules + guard as #3. Vision failure → 503 "AI unavailable — rule checks only" |
| 5 | `explainMore()` (`guardian.ts`) | `POST /api/scan/explain` | Free text, ≤ 3 sentences | Shown/spoken only | Read-only | `guardModelText()` replaces text that vouches or instructs; any failure → fixed safe answer |
| 6 | `answerInsightsQuestion()` (`server/insights/agent.ts`) | `POST /api/family/insights/agent` | Free text | Shown only. Data comes from `buildInsights(session.householdId)`, never the request body | Read-only | `requireRole('family')`, household from session; agent has no tools; no write path |
| 7 | `transcribe()` STT (`server/ai/provider.ts`) | `POST /api/voice/transcribe` | Transcript | Returned to the browser, which sends it to #1 as user text | Read-only | Same as #1 |

## Privileged actions (never reachable from model output)

| Action | Route | Who can trigger | Enforced in |
|---|---|---|---|
| Quote a basket | `POST /api/quote` | Elder session | `priceCart()`: catalogue prices, qty 1–5, ≤ 10 lines; client/AI prices ignored |
| Create payment request | `POST /api/payments` | Elder session (a tap, or the browser acting on a `confirm` intent while a quote is on screen) | `createRequest()`: catalogue re-price, fingerprint, `riskReview()` (merchant, EUR, €500 cap, velocity), threshold from `spending_policies` |
| Start PayPal checkout | `POST /api/payments/:id/checkout` | Elder session | `startPayPalCheckout()`: state machine, `hasValidApproval()` for family-approved |
| Family approve / decline | `POST /api/family/requests/:id/decision` | Paired, active family session of the **same** household | `decide()`: household-scoped load, pending + not expired, fingerprint match, single-use nonce, optimistic lock |
| Change threshold | `POST /api/family/policy` | Family session | `setThreshold()`: integer 0–€500 |
| Capture | `POST /api/payments/:id/confirm`, `POST /api/payments/:id/finish` | Elder session, explicit | `confirmAndCapture()`: order id belongs to the request, GET order from PayPal, custom_id + amount + currency match, PayPal status APPROVED, family approval re-checked, idempotent `PayPal-Request-Id` |
| Reconcile ("Check with PayPal", lazy sweep) | `POST /api/payments/:id/reconcile`, dashboard loads | Elder / family session, own household | `server/payments/reconcile.ts`: GET only, never captures, amount/currency/custom_id checks |
| Refund (demo merchant) | `POST /api/admin/payments/:id/refund` | Merchant admin token (`ADMIN_TOKEN`, header `X-Admin-Token`); disabled when unset. Family and elder: no | `adminRefund()`: CAPTURED, Demo Shop, capture/amount/currency re-checked with PayPal, full only, durable PayPal-Request-Id |
| Ask for a refund (buyer) | `POST /api/payments/:id/refund-request` | Elder session | `requestRefund()`: records REFUND_REQUESTED only; no money moves |
| Identity / household | session cookies | Server | `readSession()`, `requireRole()`; household id always from the session |

## Known limits

- **Voice "yes" can create a payment request.** In `web/src/pages/Shop.tsx` a `confirm` intent while a quote is on
  screen calls the same `POST /api/payments` a tap would. The amount is still the catalogue price, the family
  threshold still applies, and nothing is paid until the payer logs in and approves **at PayPal**. A manipulated
  `confirm` (e.g. from a product name read aloud) can therefore at most open a PayPal approval page for an item the
  user already chose. Tightening this (require the literal utterance to match a yes-pattern) is client code on the
  voice branch's files; left for that branch.
- The output guard is a pattern list. It catches the common "safe / genuine / go ahead / pay now / click the link /
  I approved" phrasings; paraphrases can slip through. The verdict itself cannot be raised by the model regardless.
- Insights-agent free text is not passed through the output guard (it describes the family's own data and has no
  scam-verdict role).
