import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { speech, type SpeechPriority } from './speech';

export { speech };
/** React view of the central speech controller. */
export function useSpeech() { return useSyncExternalStore(speech.subscribe, speech.getSnapshot, speech.getSnapshot); }

export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking' | 'unsupported';

/**
 * Tap-to-talk, driven entirely by the central voice controller (speech.ts): one recorder at a time,
 * session tokens for every callback, silence never uploaded, and the hook cancels on unmount.
 */
export function useVoiceInput(onText: (t: string) => void) {
  const snap = useSpeech();
  const handler = useRef(onText);
  handler.current = onText;
  useEffect(() => () => speech.cancelListening(), []);
  const state: VoiceState = !snap.micSupported ? 'unsupported'
    : snap.status === 'listening' ? 'listening'
    : snap.status === 'processing' ? 'processing'
    : snap.status === 'speaking' || snap.status === 'paused' ? 'speaking'
    : 'idle';
  const toggle = useCallback(() => speech.micToggle((t) => handler.current(t)), []);
  return { state, error: snap.micMessage, toggle, stop: () => speech.cancelListening() };
}

/** Compatibility wrapper: short automatic speech through the central controller. */
export function speak(text: string, priority: SpeechPriority = 'auto', turn?: number) {
  return speech.speak(text, { priority, turn });
}
export const stopSpeaking = () => speech.stop();
