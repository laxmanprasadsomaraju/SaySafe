/** Display preferences shared by the header toggles and the Profile page (one source of truth). */
import { useSyncExternalStore } from 'react';

export type DisplayKey = 'large' | 'contrast' | 'motion';
const STORE: Record<DisplayKey, { key: string; cls: string }> = {
  large: { key: 'ss-large', cls: 'large-text' },
  contrast: { key: 'ss-contrast', cls: 'high-contrast' },
  motion: { key: 'ss-reduce-motion', cls: 'reduce-motion' },
};
const listeners = new Set<() => void>();
const read = (k: DisplayKey) => { try { return localStorage.getItem(STORE[k].key) === 'on'; } catch { return false; } };
let snap = { large: read('large'), contrast: read('contrast'), motion: read('motion') };

export function applyDisplayPrefs() {
  for (const k of Object.keys(STORE) as DisplayKey[]) document.documentElement.classList.toggle(STORE[k].cls, snap[k]);
}
export function setDisplay(k: DisplayKey, on: boolean) {
  try { localStorage.setItem(STORE[k].key, on ? 'on' : 'off'); } catch { /* private mode */ }
  snap = { ...snap, [k]: on };
  applyDisplayPrefs();
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useDisplay = () => useSyncExternalStore(subscribe, () => snap, () => snap);
