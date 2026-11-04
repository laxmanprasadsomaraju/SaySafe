# Assistant: how a message becomes an answer

One Assistant, one path, for typed and spoken messages (`POST /api/assistant`). The model never sees Mary's records and never authorises money. Its only job is to pick ONE intent from a fixed, zod-validated allowlist; deterministic server code runs the tool and writes the reply from a template.

## Order of routing
1. `assistantHook` (`server/memory/http.ts`): memory statements ("I prefer red", "forget that"), "ignore my preferences", references to products already shown ("that microwave", "the cheaper one"), and turn recording. A statement about a saved contact ("I like Alex") is never saved as a brand.
2. `routeAssistant` (`server/assistant/route.ts`): read-only tools, routed deterministically with no AI call:
   `preferences`, `memory_recall`, `conversation_recall`, `transactions` (list / total / latest receipt; period, min/max, status), `duplicate_check`, `spending_limit`, `transfer_check`, `payment_check`, `trust_contact`, `capabilities`.
3. Refinement of the last real-shop search ("only Nike", "under €30", "a red version", "size medium", "a women's version instead", "more like the second one"), read from `recent_products`. A request for a new product is a new search.
4. `routeCompanion` (`server/companion/router.ts`): record searches, subscriptions, contacts, send money (unchanged).
5. Product requests (`looksLikeProductSearch`, `server/assistant/shopping.ts`) go to Channel3 with no model call.
6. Otherwise the model (`interpret`, `server/ai/agent.ts`, Groq `gpt-oss-20b`) picks one intent from the same allowlist, with minimum context: the step, the titles on screen and the last search query. No records, no memory values, no ids.
7. If the request is still unclear, the Assistant asks one question about the person's own words (`clarify`). Starter examples appear only for "what can you do" and on a brand-new conversation.

## Tools read only the signed-in elder's own data (`server/assistant/tools.ts`)
- Preferences and memory come from `user_memory` (when memory is on) plus the Profile form (`user_preferences`), labelled by source. When memory is off, the Assistant says so.
- Transactions use the same rows as Activity (`listActivity`, elder role), paged internally up to 500, and counted by kind. The kinds are never added together: real PayPal Sandbox captures, purchases waiting, attempts that were cancelled or failed, records Mary typed (not verified), and sample (illustrative) data. The chat shows the newest 10 and links to Activity for the rest.
- The duplicate check looks at captured `payment_requests`: their PayPal capture ids, and the same item and amount within 24 hours. It also includes record repeats from the insights summary.
- The limit is `spending_policies.approval_threshold_cents`, per purchase. There is no period and no "remaining" amount, and the reply says so. The shopping budget in memory is reported separately.
- Transfers are a hand-off to PayPal's own Send money page. SaySafe never sends money. The answer includes evidence from Mary's records.
- Payment evidence: whether the payee is a saved contact, how many earlier records exist for them, and the amount compared with her usual amounts (the median, and the largest of her own non-sample payments). The approval limit is included only when it is relevant. When she has no history, the reply says so. It never calls a payment "safe".
- "I trust X" returns a `contact_suggest` card. Nothing is saved until Mary taps Add, which calls the existing `POST /api/companion/contacts`.
- A family session gets a privacy answer and no data.

## Channel3 (`server/catalogue/channel3.ts`, `server/assistant/shopping.ts`)
The request is turned into structured filters, using only names documented in `https://api.trychannel3.com/openapi.json`: `gender`, `age`, `brand_ids` (resolved through `GET /v1/brands/search` by exact name match and cached), `website_ids` (retailer domains), and `price.min_price`/`price.max_price`. Locale goes in `config` (country IE, currency EUR, language en). The beta `colors.palette` filter was tested live and is not used, because it returned 0 for black women's Nike T-shirts that do exist. Colour is ranked locally instead.

A remembered colour is no longer added to the query text. Remembered colour, brand and budget only change the ranking, and a "Shown first because…" line explains them. A remembered budget narrows results only when at least 3 listings (or half of them) fit. Accessories rank after the main product unless the person asked for one.

Errors (401/403, 429 with Retry-After, timeout, 5xx, malformed JSON) each get a specific message. No products are ever made up.

Live evidence: `docs/evidence/assistant-channel3-live.json`. Focused tests: `tests/assistant-repair.test.ts`, `scripts/e2e-assistant-repair.mjs`.
