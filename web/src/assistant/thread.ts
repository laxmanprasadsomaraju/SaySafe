/**
 * The saved conversation (sessionStorage, per tab) and the "came back from PayPal" marker.
 * Any screen can append a card to the saved conversation (e.g. the receipt page after PayPal returns); every block is
 * validated on the way in and again when the Assistant restores it.
 */
import { parseBlock, restoreThread, type Block, type Thread } from './schemas';

export const THREAD_KEY = 'ss-assistant-thread';
export const FAMILY_THREAD_KEY = 'ss-assistant-thread-family';
/** Set just before an Assistant card sends Mary to PayPal; holds only the purchase id. */
export const RETURN_KEY = 'ss-assistant-return';

const mid = () => Math.random().toString(36).slice(2, 10);
export function markPayPalReturn(requestId: string) { try { sessionStorage.setItem(RETURN_KEY, requestId); } catch { /* private mode */ } }
export function pendingPayPalReturn(): string | null { try { const v = sessionStorage.getItem(RETURN_KEY); return v && /^pay_[A-Za-z0-9_-]{4,60}$/.test(v) ? v : null; } catch { return null; } }
export function clearPayPalReturn() { try { sessionStorage.removeItem(RETURN_KEY); } catch { /* */ } }

/** True if the conversation already shows a card of this kind for this purchase. */
export function hasBlockFor(t: Thread, kind: Block['kind'], requestId: string, recent = 3) {
  return t.messages.slice(-recent).some((m) => m.blocks.some((b) => b.kind === kind && 'requestId' in b && b.requestId === requestId));
}
/** Appends one assistant message to the saved conversation (used when the Assistant is not on screen). */
export function appendToSavedThread(text: string, blocks: unknown[], key = THREAD_KEY): boolean {
  try {
    const t = restoreThread(sessionStorage.getItem(key)) ?? { v: 1 as const, mode: 'chat' as const, focusId: null, messages: [] };
    const valid = blocks.map(parseBlock).filter((b): b is Block => b !== null);
    const first = valid[0]; if (first && 'requestId' in first && typeof first.requestId === 'string' && hasBlockFor(t, first.kind, first.requestId)) return false;
    t.messages = [...t.messages, { id: mid(), role: 'assistant' as const, text: text.slice(0, 4000), blocks: valid }].slice(-80);
    sessionStorage.setItem(key, JSON.stringify(t));
    return true;
  } catch { return false; }
}
