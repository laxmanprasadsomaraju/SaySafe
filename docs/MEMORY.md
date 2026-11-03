# What SaySafe remembers (memory-lite)

A small, opt-in personal context for Mary. Code: `server/memory/` (store, extract, context, personalise, http),
Profile section `web/src/components/MemorySection.tsx`. Tests: `tests/memory.test.ts`, `scripts/e2e-memory.mjs`.

## What it does
- **Long-term memory (OFF by default)**: Mary turns on "Remember my preferences" in Profile → What SaySafe remembers.
  Then explicit statements are saved: "I prefer red", "remember I like Panasonic", "I don't like Russell Hobbs",
  "keep my budget below €100", "keep answers short". "Forget that", "forget that I like X", "forget everything" remove them.
  When memory is off, SaySafe replies that it could remember it and where to turn memory on, and saves nothing.
- **Conversation context (always, short)**: last 10 turns and last 20 products shown (title, price, retailer, time),
  14 days, so "that microwave", "the cheaper one", "the one you showed me yesterday", "I changed my mind" work after a
  reload or in a new tab. Several matches → "Which one do you mean?" with the product cards to tap.
- **Personalised real-shop results**: remembered colour/brand/style/avoid/budget shape the Channel3 ranking; results
  say "Shown first because you prefer black and under €150. Say “ignore my preferences” to see them without."

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
- Demo reset clears memory + context and turns memory off. Profile → Clear all clears memory + context.

## Data (additive tables, `server/db/schema.ts`)
`user_memory` (id, household_id, user_id, category shopping|brand_like|brand_avoid|budget|communication|other,
mem_key, mem_value, source voice|text|profile, mem_status confirmed|pending, created_at, updated_at, UNIQUE(user_id,
category, mem_key)); `memory_settings` (user_id, household_id, enabled default 0); `conversation_turns`;
`recent_products`. Column names avoid SQL keywords (the hosted Turso replica upper-cases keyword keys).
`user_preferences` (the manual Shopping preferences form) is unchanged; the ranking profile is form ∪ remembered items.

## API (elder only; family 404; not signed in 401)
`GET /api/memory` · `PUT /api/memory/settings {enabled}` · `PATCH /api/memory/:id {value}` · `DELETE /api/memory/:id` ·
`DELETE /api/memory {confirm:true}`. `/api/assistant` accepts an optional `via: 'voice'|'text'`; `/api/discover`
accepts `ignoreMemory: true` and returns `personalisation` and `channel3Query`.

## Evidence
`docs/evidence/memory-lite-channel3-live.json`: one real Channel3 run (query sent "black kettle", line "Shown first
because you prefer black and under €150", then "ignore my preferences" → query "kettle", no line).
