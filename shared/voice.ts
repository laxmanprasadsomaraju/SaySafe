/** Transcript filters shared by the browser and the server (silence must never reach the assistant). */

/** Phrases Whisper is known to produce on silence or noise (checked live: silence -> "Thank you.", noise -> "."). */
const HALLUCINATIONS = new Set([
  'thank you', 'thank you very much', 'thanks', 'thanks a lot', 'thank you so much', 'thank you for watching', 'thanks for watching',
  'you\'re welcome', 'youre welcome', 'you', 'bye', 'bye bye', 'goodbye', 'okay', 'ok', 'so', 'oh', 'uh', 'um', 'hmm', 'mm', 'yeah',
  'please subscribe', 'subscribe', 'like and subscribe', 'subtitles by the amara org community', 'thank you for listening', 'music', 'applause', 'silence',
]);
const norm = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

export function isSilenceHallucination(text: string): boolean {
  const n = norm(text);
  return !n || !/\p{L}/u.test(n) || HALLUCINATIONS.has(n) || HALLUCINATIONS.has(n.replace(/'/g, ''));
}

/**
 * Should this transcript be thrown away instead of being sent to the assistant?
 * Empty/punctuation-only text is always dropped. A known hallucination phrase is dropped unless the
 * clip clearly had sustained speech (a real "thank you" said out loud is still let through).
 */
export function dropTranscript(text: string, voicedMs: number): string | null {
  const t = text.trim();
  if (!t || !/\p{L}/u.test(t)) return 'empty';
  if (isSilenceHallucination(t) && voicedMs < 1500) return 'silence_hallucination';
  return null;
}

