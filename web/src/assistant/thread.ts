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

/** The purchase this conversation is about: the newest family-review, receipt or sent purchase card. */
export function conversationPaymentId(t: Thread): string | null {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const bs = t.messages[i].blocks;
    for (let j = bs.length - 1; j >= 0; j--) {
      const b = bs[j] as Block & { requestId?: string | null; status?: string };
      if ((b.kind === 'family_status' || b.kind === 'receipt' || (b.kind === 'payment_prep' && b.status === 'sent')) && typeof b.requestId === 'string' && /^pay_[A-Za-z0-9_-]{4,60}$/.test(b.requestId) && !b.requestId.startsWith('pay_smp')) return b.requestId;
    }
  }
  return null;
}
