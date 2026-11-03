/**
 * Short spoken summaries, built separately from what is on screen.
 * The screen always shows the full detail; speech says only what matters first.
 */
import type { PaymentRequest, ScanResult } from './api';

/** Scam result: risk level, then the single most important protective action. Never shortened past meaning. */
export function spokenScam(r: Pick<ScanResult, 'verdict' | 'phonePolicy'>): string {
  if (r.verdict === 'suspicious')
    return `This message may be a scam. Don't click its links, call its numbers, or pay anything. Open PayPal yourself, or ask your family member.`;
  if (r.verdict === 'verified_official_contact')
    return `This matches an official PayPal contact, but that alone doesn't prove the message is genuine. Check any payment inside the PayPal app yourself.`;
  return `I can't confirm this message is real. Don't use its links${r.phonePolicy ? ' or numbers' : ''}. Open the PayPal app yourself to check.`;
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
