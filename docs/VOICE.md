# SaySafe voice: how it works, what is supported, what to test by hand

## The "ghost speech" bug (fixed on `voice-shopping`)
Symptom: tapping the mic, saying nothing and tapping again made SaySafe say "You're welcome, Mary! If there's anything else I can help with…".

Cause, as found in `origin/main` (6e66af0):
1. `web/src/lib/voice.ts` l.15-18 + l.57: tapping while listening called `stop()` -> `MediaRecorder.stop()`, and `onstop` (l.28-45) **always uploaded** the clip. The only guard was `blob.size < 1200` bytes (l.34); 2-8 s of silent Opus is about 1.4-4 KB, so silence passed.
2. Groq Whisper transcribes silence as text. Checked live through `/api/voice/transcribe` on 2026-11-03: silent 2/4/8 s clips -> `"Thank you."` (6 of 6 runs); quiet room noise -> `"."` (6 of 6).
3. `onText("Thank you.")` (l.40) went to `/api/assistant`. The prompt in `server/ai/agent.ts` l.29 asked for "warm" replies, so the model answered "You're welcome, Mary! …" (reproduced: "Thank you." -> action `chat`, reply "You're welcome.").
4. The page then spoke the reply automatically (`Home.tsx` l.35 `speak(r.reply)`).
5. Contributing: the 15 s safety timer (l.49) and unmount (l.56) also called `stop()`, which uploaded; starting the mic didn't stop TTS, so SaySafe's own voice could be recorded; replies weren't tied to a turn, so a late reply could still speak after navigation.

No Web Speech `SpeechRecognition` is used anywhere, so there are no late `onresult` events; the equivalent late callbacks were `MediaRecorder.onstop` and the transcription/assistant responses, which now all check a session token.

## One controller
`web/src/lib/speech.ts` (`speech` singleton) owns mic capture, transcription, the AI turn and speech. States: Ready (idle), Listening…, Thinking… (transcribing or waiting for the AI), Speaking…, Paused, Cancelled, Error/Muted/Unavailable.
- Mic: tap = start; tap while listening = **cancel silently** (nothing is uploaded); tap while speaking = stop speech at once (cancel + clear queue) and start listening. Only one recorder exists at a time.
- End of speech is detected locally (Web Audio RMS, `web/src/lib/mic.ts`): it sends after ~1.3 s of quiet following speech. No speech for 6 s -> "I didn't hear anything. Tap to try again." (shown, never spoken). Clips under 0.6 s or with under 250 ms of voice are never uploaded.
- Transcripts that are empty, punctuation-only, a known silence hallucination ("thank you", "you're welcome", "thanks for watching", ".", …) with little measured voice, or a repeat within 10 s are dropped. The server repeats the same check (`shared/voice.ts`) and also drops uploads under 2 KB.
- Every mic session and every AI turn carries a token. Stop, navigation, a new message or a mic tap make older ones stale, so a late transcription or AI reply never speaks or changes the page.
- Stop (voice bar, Escape) stops speech, listening and processing. Navigation does the same (`RouteSpeechGuard`).
- Assistant prompt: no greeting, no "You're welcome" unless the user thanked, no "anything else I can help with". `/api/assistant` rejects empty or punctuation-only text before any AI call.

## Interruption modes
| Mode | Status |
|---|---|
| Tap the mic while SaySafe speaks ("Interrupt and speak") | **Supported.** Tested with fake media in Chromium. |
| Stop button / Escape key | **Supported.** Tested. |
| Typed follow-up while speaking (e.g. "No, show me the cheaper ones") | **Supported.** Stops speech and asks Channel3 again below the best match's price. Tested. |
| Hands-free barge-in (talk over SaySafe without tapping) | **Not supported.** Not enabled. It needs the mic open during TTS; browser echo cancellation (`echoCancellation: true`) does not reliably remove `speechSynthesis` output on every device, and an energy VAD can't tell SaySafe's own voice from the user's. It couldn't be tested here (headless Chromium has no TTS audio). |

## Browser support
| Browser | Mic capture (getUserMedia + MediaRecorder) | Speech output | Tested here |
|---|---|---|---|
| Chrome desktop | Yes (webm/opus) | Yes | **Yes**: Chromium 141 headless, fake mic (silence + synthetic speech), stubbed speechSynthesis |
| Edge desktop | Yes (Chromium) | Yes | No (documented; same engine as Chrome) |
| Chrome Android | Yes | Yes | No |
| Safari macOS 14.1+ / iOS 14.3+ | Yes (audio/mp4) | Yes | No. iOS may need a tap before audio; AudioContext resumes on the mic tap. |
| Firefox desktop / Android | Yes (ogg/webm) | Yes (fewer voices on Linux) | No |
Without MediaRecorder the mic button is replaced by "Voice input isn't available in this browser. Please type instead." Without Web Audio, clips are cut at 8 s and silence-hallucination phrases are always dropped.

## Manual tests with a real microphone
1. Tap the mic, say nothing, wait: you should see "I didn't hear anything. Tap to try again." and hear nothing.
2. Tap the mic, say nothing, tap again within 2 s: the chip shows Cancelled, then Ready, with no sound.
3. Tap, say "Find me a microwave under 150 euro", then stop talking: it should send within ~1.5 s.
4. While SaySafe is speaking, tap the mic: the speech stops at once and the chip shows Listening….
5. While it is speaking, press Stop and then Escape: no more sound either time.
6. In a noisy room (TV on), tap and stay quiet. If it sends noise, raise `VAD.floor` in `web/src/lib/mic.ts`.
7. Speak quietly or from a distance. If it says it heard nothing, lower `VAD.floor`.
8. On iPhone Safari, check the permission prompt, recording, and that the mp4 upload is transcribed.
9. Say "thank you" clearly for over 1.5 s of voice: it is accepted. A mumbled one is dropped by design.
10. During a payment review, say "yes": you are still taken to PayPal to approve (or to family review above the limit). Voice never approves anything itself.
