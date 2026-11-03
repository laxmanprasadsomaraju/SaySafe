import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { speech, type SpeechPriority } from './speech';

export { speech };
/** React view of the central speech controller. */
export function useSpeech() { return useSyncExternalStore(speech.subscribe, speech.getSnapshot, speech.getSnapshot); }

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
    else speech.setListening(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    speech.stop(); // barge-in: tapping the mic always silences SaySafe first
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState('processing');
        speech.setListening(false);
        speech.setThinking(true);
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
          speech.setThinking(false);
          setError(e.message);
          setState('error');
        }
      };
      rec.current = r;
      r.start();
      setState('listening');
      speech.setListening(true);
      timer.current = window.setTimeout(stop, 15000); // safety: max 15s
    } catch (e: any) {
      speech.setListening(false);
      setError(e?.name === 'NotAllowedError' ? 'Microphone access is turned off. You can type instead, or allow the microphone in your browser settings.' : 'The microphone is not available. You can type instead.');
      setState('error');
    }
  }, [onText, stop]);

  useEffect(() => () => stop(), [stop]);
  return { state, error, start, stop, toggle: () => (state === 'listening' ? stop() : start()) };
}

/** Compatibility wrapper: short automatic speech through the central controller. */
export function speak(text: string, priority: SpeechPriority = 'auto', turn?: number) {
  return speech.speak(text, { priority, turn });
}
export const stopSpeaking = () => speech.stop();
