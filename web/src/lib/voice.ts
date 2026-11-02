import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export type VoiceState = 'idle' | 'listening' | 'processing' | 'done' | 'error' | 'unsupported';

/** Records speech with MediaRecorder and transcribes it on the server (Groq Whisper). */
export function useVoiceInput(onText: (t: string) => void) {
  const [state, setState] = useState<VoiceState>(() =>
    typeof window !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && 'MediaRecorder' in window ? 'idle' : 'unsupported');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState('processing');
        try {
          const type = r.mimeType || 'audio/webm';
          const blob = new Blob(chunks.current, { type });
          if (blob.size < 1200) throw new Error("I didn't hear anything. Please try again, or type instead.");
          const fd = new FormData();
          fd.append('audio', blob, type.includes('mp4') ? 'speech.mp4' : type.includes('ogg') ? 'speech.ogg' : 'speech.webm');
          const { text } = await api<{ text: string }>('/api/voice/transcribe', { form: fd });
          if (!text) throw new Error("I didn't catch that. Please try again, or type instead.");
          setState('done');
          onText(text);
        } catch (e: any) {
          setError(e.message);
          setState('error');
        }
      };
      rec.current = r;
      r.start();
      setState('listening');
      timer.current = window.setTimeout(stop, 15000); // safety: max 15s
    } catch (e: any) {
      setError(e?.name === 'NotAllowedError' ? 'Microphone access is turned off. You can type instead, or allow the microphone in your browser settings.' : 'The microphone is not available. You can type instead.');
      setState('error');
    }
  }, [onText, stop]);

  useEffect(() => () => stop(), [stop]);
  return { state, error, start, stop, toggle: () => (state === 'listening' ? stop() : start()) };
}

/** Speaks text aloud with the browser's own voice, and returns the caption to show on screen. */
export function speak(text: string) {
  try {
    if (localStorage.getItem('ss-voice') === 'off') return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92;
    u.lang = 'en-IE';
    const v = synth.getVoices().find((x) => /en-(IE|GB)/.test(x.lang));
    if (v) u.voice = v;
    synth.speak(u);
  } catch { /* speech is optional */ }
}
export const stopSpeaking = () => { try { window.speechSynthesis?.cancel(); } catch { /* */ } };
