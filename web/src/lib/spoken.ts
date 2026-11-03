/**
 * Short spoken summaries, built separately from what is on screen.
 * The screen always shows the full detail; speech says only what matters first.
 */
import type { PaymentRequest } from './api';
import { shareVerdict } from './shareText';

/**
 * Scam result: verdict label, then the single most important protective action. Never shortened past meaning.
 * Accepts the three public verdicts and the legacy codes (mapped the same way as the server's normalizeVerdict).
 * Never says "safe": the best it can say is "No obvious warning signs", always with the disclosure.
 */
export function spokenScam(r: { verdict: string; phonePolicy?: string | null }): string {
  const v = shareVerdict(r.verdict);
  if (v === 'suspicious')
    return `Suspicious. This message may be a scam. Don't click its links, call its numbers, or pay anything. Open PayPal yourself, or ask your family member.`;
  if (v === 'no_obvious_warning_signs')
    return `No obvious warning signs. No concerning signs were found in what you shared. This isn't a guarantee it's safe. Check anything about money in the official PayPal app.`;
  return `Needs checking. I can't confirm this message is real. Don't use its links${r.phonePolicy ? ' or numbers' : ''}. Open the PayPal app yourself to check.`;
}

const euro = (v: string | number) => { const n = Number(v); return `€${n.toFixed(n % 1 ? 2 : 0)}`; };

/** Receipt: amount, what PayPal's evidence shows (only that), and what happens next. */
export function spokenReceipt(r: PaymentRequest): string {
  if (!r.receipt) return '';
  const payee = r.receipt.payee.replace(' (sandbox)', '');
  const confirmed = r.receipt.webhookConfirmed ? 'PayPal confirmed the payment and sent a signed notice.' : 'PayPal confirmed the payment.';
  return `${euro(r.receipt.amount)} to ${payee}. ${confirmed} This was a sandbox payment, so no real money moved. Your receipt stays on this page.`;
}

/** Family approval: who reviews, and the current state. */
export function spokenFamily(state: PaymentRequest['state'], approvalStatus?: string | null): string {
  if (state === 'FAMILY_APPROVAL_PENDING') return 'Your trusted family member is reviewing this purchase. Nothing is paid yet. This page updates when they answer.';
  if (state === 'FAMILY_APPROVED') return 'Your family member said yes. You still approve the payment yourself at PayPal.';
  if (state === 'CANCELLED' && approvalStatus === 'declined') return 'Your family member said no this time. Nothing was paid.';
  return '';
}
