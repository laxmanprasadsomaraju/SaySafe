/**
 * Microphone capture helpers for the voice controller (speech.ts).
 *
 * Root cause of the "ghost speech" bug: a tap-to-stop with nobody talking still uploaded the clip,
 * Whisper transcribed silence as "Thank you." (room noise as "."), and the assistant answered it
 * ("You're welcome, Mary! …") and spoke the answer. These helpers make sure silence never leaves the browser
 * and that known silence hallucinations are dropped.
 */

export interface LevelMeter { level(): number; close(): void }
export interface MicEnv {
  getUserMedia: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null;
  MediaRecorder: (new (s: MediaStream, o?: MediaRecorderOptions) => MediaRecorder) & { isTypeSupported?: (t: string) => boolean } | null;
  /** RMS level of the live stream (0..1). null when the browser can't measure (no Web Audio). */
  meter: (stream: MediaStream) => LevelMeter | null;
  transcribe: (audio: Blob, info: { voicedMs: number; lang: string; mime: string }) => Promise<string>;
  now: () => number;
}

/** Voice-activity settings. Speech from a phone/laptop mic with AGC is typically RMS 0.03-0.3; a quiet room is < 0.01. */
export const VAD = {
  tickMs: 50,
  floor: 0.015, // RMS above this counts as voice
  minVoicedMs: 250, // need this much voice before we believe anyone spoke
  minClipMs: 600, // shorter clips are never uploaded
  silenceTimeoutMs: 6000, // nobody spoke: stop quietly
  endOfSpeechMs: 1300, // pause after speech: send it
  maxMs: 15000,
};

export const MIC_MESSAGES = {
  nothingHeard: "I didn't hear anything. Tap to try again.",
  unclear: "I couldn't make that out. Tap to try again, or type instead.",
  denied: 'Microphone access is turned off. You can type instead, or allow the microphone in your browser settings.',
  unavailable: 'The microphone is not available. You can type instead.',
  unsupported: 'Voice input isn’t available in this browser. Please type instead.',
  duplicate: 'I heard the same words again, so I ignored them. Tap to try again.',
};

export { isSilenceHallucination, dropTranscript } from '../../../shared/voice';

export function pickMime(MR: MicEnv['MediaRecorder']): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MR?.isTypeSupported?.(m)) ?? '';
}

/** Web Audio RMS meter for a mic stream. */
export function browserMeter(stream: MediaStream): LevelMeter | null {
  const Ctx = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctx) return null;
  try {
    const ctx: AudioContext = new Ctx();
    ctx.resume?.().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    return {
      level() { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); },
      close() { try { src.disconnect(); ctx.close(); } catch { /* */ } },
    };
  } catch { return null; }
}
