/** Client view of GET /api/activity, plus labels that never break on a state this build doesn't know yet. */
import { api } from './api';
import { stateLabel } from '../pages/Order';
import type { PaymentState } from './api';

export type StatusGroup = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'failed' | 'scan' | 'other';
export interface ActivityItem {
  id: string; type: 'payment' | 'scan'; at: string; updatedAt: string; title: string; status: string; state?: string; refundLabel?: string | null; statusGroup: StatusGroup; section?: 'purchases' | 'scans' | 'family' | 'refunds'; example?: boolean;
  amountCents: number | null; currency: string | null; merchant: string | null; captured: boolean; webhookConfirmed: boolean; sandbox: boolean;
  approval: { status: string; decidedAt: string | null; reason: string | null } | null; verdict: string | null; sharedWithFamily?: boolean; href: string | null;
}
export interface ActivityPage { role: 'elder' | 'family'; items: ActivityItem[]; total: number; page: number; limit: number; hasMore: boolean; counts: { all: number; pending: number } }

export interface ActivityFilters { q?: string; status?: string; type?: string; section?: string; min?: string; max?: string; from?: string; to?: string; page?: number; limit?: number; as?: 'family' | 'elder' }
export function fetchActivity(f: ActivityFilters) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== 'all') qs.set(k, String(v));
  return api<ActivityPage>(`/api/activity?${qs}`);
}

const humanise = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const paymentLabelSpecial = (s: string) => (s === 'REFUND_REQUESTED' ? 'Refund requested — not refunded yet' : 'Refund pending — not confirmed yet');
/** Known states use the receipt page's wording; refund or future states get a readable fallback. */
export function paymentLabel(state: string): string {
  if (state === 'REFUND_REQUESTED' || state === 'REFUND_PENDING') return paymentLabelSpecial(state);
  const known = stateLabel(state as PaymentState) as string | undefined;
  if (known) return known;
  if (state === 'REFUND_REQUESTED') return 'Refund requested — not refunded yet';
  if (state === 'REFUND_PENDING') return 'Refund pending — not confirmed yet';
  return humanise(state);
}
export function verdictLabel(v: string): string {
  return ({ suspicious: 'Suspicious', needs_verification: 'Needs checking', needs_checking: 'Needs checking', verified_official_contact: 'Official contact (still check in PayPal)', no_obvious_warning_signs: 'No obvious warning signs' } as Record<string, string>)[v] ?? humanise(v);
}
export const money = (cents: number | null, currency: string | null) =>
  cents === null ? '' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format(cents / 100);
export const when = (iso: string) => new Date(iso).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The short status every list uses: Pending, Waiting for family, Captured, Verification pending, Refunded, Cancelled
 * (plus the honest refund-request wording). `extra` is a second, smaller label: e.g. a capture whose signed PayPal
 * notice has not been verified yet reads "Captured" + "Verification pending".
 */
export type Tone = 'pending' | 'ok' | 'muted' | 'danger';
export function shortStatus(status: string, opts: { webhookConfirmed?: boolean; approval?: string | null } = {}): { label: string; tone: Tone; extra?: string; detail?: string } {
  if (status === 'FAMILY_APPROVAL_PENDING') return opts.approval === 'expired' ? { label: 'Cancelled', tone: 'muted', detail: 'Family review expired. Nothing was paid.' } : { label: 'Waiting for family', tone: 'pending' };
  if (['DRAFT', 'RISK_REVIEW', 'FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'CAPTURE_PENDING'].includes(status)) return { label: 'Pending', tone: 'pending', detail: paymentLabel(status) };
  if (status === 'CAPTURED') return { label: 'Captured', tone: 'ok', extra: opts.webhookConfirmed ? 'Webhook verified' : 'Verification pending' };
  if (status === 'REFUND_REQUESTED') return { label: 'Refund requested', tone: 'pending', detail: 'Request sent — not refunded yet' };
  if (status === 'REFUND_PENDING') return { label: 'Pending', tone: 'pending', detail: 'Refund sent to PayPal — not confirmed yet' };
  if (status === 'REFUNDED') return { label: 'Refunded', tone: 'ok' };
  if (status === 'CANCELLED') return { label: 'Cancelled', tone: 'muted', detail: opts.approval === 'declined' ? 'Family declined. Nothing was paid.' : 'Nothing was paid.' };
  if (status === 'BLOCKED') return { label: 'Cancelled', tone: 'danger', detail: 'Stopped for safety. Nothing was paid.' };
  if (status === 'FAILED') return { label: 'Cancelled', tone: 'danger', detail: 'Did not go through. Nothing was paid.' };
  return { label: paymentLabel(status), tone: 'muted' };
}
export const TONE_CLS: Record<Tone, string> = { pending: 'bg-amber-soft text-amber border-amber/40', ok: 'bg-teal-soft text-teal-deep border-teal/40', muted: 'bg-line text-navy border-line', danger: 'bg-danger-soft text-danger border-danger/40' };
/** "ABCD…WXYZ" for long PayPal references (the full value stays available to screen readers and on the page title). */
export const truncateRef = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
