/** Client view of GET /api/activity, plus labels that never break on a state this build doesn't know yet. */
import { api } from './api';
import { stateLabel } from '../pages/Order';
import type { PaymentState } from './api';

export type StatusGroup = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'failed' | 'scan' | 'other';
export interface ActivityItem {
  id: string; type: 'payment' | 'scan'; at: string; updatedAt: string; title: string; status: string; statusGroup: StatusGroup;
  amountCents: number | null; currency: string | null; merchant: string | null; captured: boolean; webhookConfirmed: boolean; sandbox: boolean;
  approval: { status: string; decidedAt: string | null; reason: string | null } | null; verdict: string | null; sharedWithFamily?: boolean; href: string | null;
}
export interface ActivityPage { role: 'elder' | 'family'; items: ActivityItem[]; total: number; page: number; limit: number; hasMore: boolean; counts: { all: number; pending: number } }

export interface ActivityFilters { q?: string; status?: string; type?: string; min?: string; max?: string; from?: string; to?: string; page?: number; limit?: number; as?: 'family' | 'elder' }
export function fetchActivity(f: ActivityFilters) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== 'all') qs.set(k, String(v));
  return api<ActivityPage>(`/api/activity?${qs}`);
}

const humanise = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
/** Known states use the receipt page's wording; refund or future states get a readable fallback. */
export function paymentLabel(state: string): string {
  const known = stateLabel(state as PaymentState) as string | undefined;
  if (known) return known;
  if (state === 'REFUND_REQUESTED') return 'Refund requested';
  return humanise(state);
}
export function verdictLabel(v: string): string {
  return ({ suspicious: 'Suspicious', needs_verification: 'Needs checking', needs_checking: 'Needs checking', verified_official_contact: 'Official contact (still check in PayPal)', no_obvious_warning_signs: 'No obvious warning signs' } as Record<string, string>)[v] ?? humanise(v);
}
export const money = (cents: number | null, currency: string | null) =>
  cents === null ? '' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format(cents / 100);
export const when = (iso: string) => new Date(iso).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
