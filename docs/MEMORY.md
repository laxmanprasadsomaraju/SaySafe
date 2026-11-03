# What SaySafe remembers (memory-lite)

A small personal context for Mary: long-term memory is **on by default** (clearly disclosed, Mary can turn it off). Code: `server/memory/` (store, extract, context, personalise, http),
Profile section `web/src/components/MemorySection.tsx`. Tests: `tests/memory.test.ts`, `tests/memory-polish.test.ts`, `tests/family-privacy.test.ts` (memory ON by default), `scripts/e2e-memory.mjs`.

## Defaults

| Feature | Default | Where it's explained |
|---|---|---|
| Long-term memory (preferences Mary states) | **On** for a user with no saved choice: new households, fresh demo visitors, after demo reset (`MEMORY_DEFAULT_ON`, `server/memory/store.ts`; no `memory_settings` row = on) | One-time Assistant notice, Profile › What SaySafe remembers, Help › Privacy and data, README, /learn |
| Recent conversation context | On, kept even when memory is off | Profile (separate “Recent conversation (short-term)” part), Help |
| Family sharing switches (summaries, history) | **Off** | Profile › Family sharing, Help |
| Spoken replies (voice consent) | **Off** | Assistant bar, Profile › Voice & conversation |

The one-time Assistant notice (`web/src/components/MemoryNotice.tsx`) is shown the first time Mary opens the Assistant
on a device while memory is on: “SaySafe remembers shopping preferences you tell it, like colours or budget. You can
see, change or turn this off in Profile.” Stored as seen in `localStorage` (`ss-memory-notice-v1`).
Note: existing users who never touched the switch are also treated as ON now (there was no stored "off" for them).

## What it does — two separate parts
- **(b) Long-term personal memory (ON by default)**: explicit statements are saved: "I prefer red", "remember I like
  Panasonic", "I don't like Russell Hobbs", "keep my budget below €100", "keep answers short". "Forget that",
  "forget that I like X", "forget everything" remove them; Profile can Change / Remove / Clear all memory / turn off.
  **Turning it off stops saving immediately and stops using saved items** (they stay listed until removed). SaySafe
  then replies that it could remember it and where to turn memory on, and saves nothing.
- **(a) Temporary conversation context (kept even when memory is off)**: last 10 turns and last 20 products shown
  (title, price, retailer, time), 14 days, used only to understand "that microwave", "the cheaper one", "the one you
  showed me yesterday", "I changed my mind" after a reload or in a new tab. Several matches → "Which one do you mean?"
  with the product cards to tap. Deletable: Profile › "Clear conversation" / "Clear recent conversation"
  (`DELETE /api/memory {confirm:true, scope:'context'}`: turns + products only; preferences stay).
- **When memory is off, exactly this is retained**: the short conversation context above (and any items already
  saved, unused, until Mary removes them). Nothing new is saved.
- **Personalised real-shop results**: remembered colour/brand/style/avoid/budget shape the Channel3 ranking; the
  remembered budget is a strict local price filter when listings under it exist (otherwise the closest are shown and
  the line says so). Results say "Shown first because you prefer black and under €150. Say “ignore my preferences” to
  see them without." A remembered colour added to the query text never makes an unrelated listing relevant
  (relevance uses only the words Mary asked for).
- **"Keep answers short"** (communication preference, only while memory is on): the `/api/discover` reply drops the
  reasons and follow-up question; the existing AI explanation call gets one extra instruction ("ONE short sentence of
  at most 20 words", max tokens 80) and its answer is also trimmed to one whole sentence; plain conversational
  Assistant replies (`action: chat`, no card) keep their first two whole sentences. Cards, payments and scam checks are
  never trimmed. Tested in `tests/memory-polish.test.ts`.
- **Sample memories (demo only)**: "Try as Mary" and demo reset seed two preferences, "Prefers the colour black
  (sample)" and "Usual budget: up to €150 (sample)". They are marked in the data by the id prefix `mem_sample_`
  (no schema change), shown with a "Sample" badge, and Mary can change (it becomes hers, a normal id), remove or
  clear them; saying her own preference replaces the sample. A results line shaped by a sample says "(sample
  preferences: change or remove them in Profile)".

## Known limitation: earlier conversation is not re-displayed
Opening a new tab or coming back later starts with an empty thread on screen. The server still uses the recent
context ("that one" works), but no existing route returns the turn text (`GET /api/memory` returns only a count),
and adding one was out of scope, so earlier messages are not shown again. This is stated in Help › Privacy and data.

## Rules
- Same deterministic function for typed text and the voice transcript (`via` is recorded as the source). No AI decides
  what is saved. No raw audio is stored.
- Never saved: health, money owed, other people, contact details, numbers/links, codes; anything that isn't a clear
  shopping preference ("remember to buy milk" → not saved, says so).
- The current request overrides memory (a colour, budget or brand said now wins; "find a Breville kettle" ignores
  "I don't like Breville" for that search).
- A newer statement replaces the old one (unique user + category + key; liking a brand removes avoiding it and vice versa).
- Only product terms leave the server: at most a remembered colour is added to the Channel3 query text. No name, user
  id, household id or `x-user-id` goes to Channel3. The existing explanation prompt (Groq) gets only the preference terms.
- Nothing is invented: when nothing fits a remembered budget, the closest listings are shown and the line says so.
- **Conversation is never proof of payment.** "Did I pay for that microwave?" resolves the item from context, then
  the existing payment search answers from authoritative records only (Demo Shop sandbox captures, records Mary typed,
  sample data — each labelled). If there's no record: "We talked about the … on 3 November, but I have no payment record for it."
- Isolation: every read/write is scoped by household AND user from the session. A family session (Alex) gets 404 on
  `/api/memory*`, and the assistant never resolves Mary's context for him. Nothing is written to audit_log or insights.
- Family access (server/family/permissions.ts) never touches these tables: no family route, Family Insights view or
  family Insights AI payload reads memory or conversation, even with both Family sharing switches on (tested).
- Memory never triggers a money action (no path to the payment service, PayPal, approvals, webhooks or capture).
- Memory values are data: length-capped (key 60, value 120), control characters stripped, rendered as text.
  Long or pasted messages (scam checks) are never kept as conversation and never write memory.
- Demo reset clears memory + context, returns memory to its default (ON) and re-seeds the two samples. Profile → Clear all memory clears memory + context.

## Data (additive tables, `server/db/schema.ts`)
`user_memory` (id, household_id, user_id, category shopping|brand_like|brand_avoid|budget|communication|other,
mem_key, mem_value, source voice|text|profile, mem_status confirmed|pending, created_at, updated_at, UNIQUE(user_id,
category, mem_key)); `memory_settings` (user_id, household_id, enabled; a missing row means the default, ON — the column default 0 is never relied on because every write sets it); `conversation_turns`;
`recent_products`. Column names avoid SQL keywords (the hosted Turso replica upper-cases keyword keys).
`user_preferences` (the manual Shopping preferences form) is unchanged; the ranking profile is form ∪ remembered items.

## API (elder only; family 404; not signed in 401)
`GET /api/memory` · `PUT /api/memory/settings {enabled}` · `PATCH /api/memory/:id {value}` · `DELETE /api/memory/:id` ·
`DELETE /api/memory {confirm:true, scope?:'all'|'context'}`. `GET /api/memory` also returns `defaultOn` and
each item's `sample` flag. `/api/assistant` accepts an optional `via: 'voice'|'text'`; `/api/discover`
accepts `ignoreMemory: true` and returns `personalisation` and `channel3Query`.

## Evidence
`docs/evidence/memory-lite-channel3-live.json`: one real Channel3 run (query sent "black kettle", line "Shown first
because you prefer black and under €150", then "ignore my preferences" → query "kettle", no line).
