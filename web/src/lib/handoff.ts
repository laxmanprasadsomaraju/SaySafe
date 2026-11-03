/**
 * PayPal hand-off: the moment SaySafe sends the person to PayPal's own approval page.
 * The app shell hides its navigation during the hand-off so nothing competes with the PayPal step.
 */
import { useSyncExternalStore } from 'react';
import { speech } from './speech';

let active = false;
const listeners = new Set<() => void>();
const set = (v: boolean) => { if (v !== active) { active = v; listeners.forEach((l) => l()); } };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Leave for PayPal's approval page. Only call with a URL the server returned. */
export function goToPayPal(approveUrl: string) {
  set(true);
  speech.stop();
  window.location.assign(approveUrl);
}
export const handoffActive = () => active;
export const useHandoff = () => useSyncExternalStore(subscribe, () => active, () => false);
// Coming back with the browser's Back button (bfcache) restores the page: show the navigation again.
if (typeof window !== 'undefined') window.addEventListener('pageshow', () => set(false));
