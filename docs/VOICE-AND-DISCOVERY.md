# Voice, real-product discovery and preferences (branch `voice-shopping`)

## Speech
- `web/src/lib/speech.ts` is the only place SaySafe makes sound. `speak(text, {priority, turn, lang})`, `stop`, `pause`, `resume`, `mute`, `replay`.
- `stop()` cancels `speechSynthesis`, clears the queue and bumps a generation counter; stale callbacks and replies still being fetched (`turn` tokens) never speak later.
- Text is spoken sentence by sentence. Pause = cancel and remember the sentence; Resume = speak again from it (avoids Chrome's pause/resume bugs and 15 s cut-off).
- Speech stops on route change (`RouteSpeechGuard` in `main.tsx`), when a new message is sent (`beginTurn`), when the mic starts (barge-in), on Escape and on `pagehide`.
- Automatic speech only for short replies (≤ 320 chars). Long text only on "Read aloud", "Replay" or the opt-in "Read everything".
- Prefs in `localStorage['ss-voice-prefs']`: `muted`, `autoSpeak`, `rate`, `readAll`, `lang`. The legacy `ss-voice=off` still means muted.
- Spoken summaries are built separately from the screen: `web/src/lib/spoken.ts` (scam, receipt, family) and `shared/shopping.ts` (shopping).

## Channel3 discovery
- `shared/shopping.ts`: budget parsing, deterministic ranking (request match, main category, budget, listed stock, completeness, profile boosts only when the listing contains the term), picks (best / lower-cost / another), compare rows, follow-up intents, read-all segments, AI explanation guard.
- Channel3 returns `ratings {value, count, source_count}` but no review text. Ratings are shown labelled "Listed rating … (as provided by Channel3; no reviews checked)" and never used in reasons.
- The optional Groq explanation (`server/ai/explain.ts`) is dropped unless `explanationIsGrounded()` accepts it.

## Preferences
- `user_preferences` table (one row per elder user, JSON ≤ 4 KB, sanitised). `GET/PUT/DELETE /api/preferences` (elder session only; no family path, never audited or logged). localStorage fallback without a session.

## Reply language (beta)
- `shared/lang.ts`: en, es, pl, fr, de, pt only. Sets the AI reply language (120b model + one retry for non-English), Whisper `language`, and `utterance.lang`. English fallback text is shown, not spoken, in another reply language; no device voice → text only with a notice. UI, EUR and product search stay English.

## QA
- `node scripts/qa-voice.mjs` (BASE, OUT env) stubs `speechSynthesis` and checks Stop, Pause/Resume, Escape, navigation, mute, read-everything, overlap, follow-ups, axe.
