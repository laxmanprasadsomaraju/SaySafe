/**
 * My Activity: one read-only, paginated list of this household's payments (with family decisions)
 * and scam checks. The household always comes from the session, never from the request.
 * Unknown payment states (e.g. refund states added later) are passed through with a neutral group.
 */
import { z } from 'zod';
import { db } from './db/index.js';

export type StatusGroup = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'failed' | 'scan' | 'other';

export interface ActivityItem {
  id: string;
  type: 'payment' | 'scan';
  at: string; // ISO, UTC
  updatedAt: string;
  title: string;
  status: string; // raw state or verdict
  statusGroup: StatusGroup;
  amountCents: number | null;
  currency: string | null;
  merchant: string | null;
  captured: boolean;
  webhookConfirmed: boolean;
  sandbox: boolean;
  approval: { status: string; decidedAt: string | null; reason: string | null } | null;
  verdict: string | null;
  sharedWithFamily?: boolean;
  href: string | null;
}

const PENDING = new Set(['DRAFT', 'RISK_REVIEW', 'FAMILY_APPROVAL_PENDING', 'FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'CAPTURE_PENDING']);
export function groupOf(state: string): StatusGroup {
  if (PENDING.has(state)) return 'pending';
  if (state === 'CAPTURED') return 'paid';
  if (state === 'CANCELLED') return 'cancelled';
  if (/REFUND/.test(state)) return 'refunded';
  if (state === 'FAILED' || state === 'BLOCKED') return 'failed';
  return 'other';
}

/** SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC. */
const iso = (s: string | null | undefined) => (s ? (s.includes('T') ? s : `${s.replace(' ', 'T')}Z`) : '');

export const ActivityQuery = z.object({
  q: z.string().trim().max(100).optional(),
  item: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'pending', 'paid', 'cancelled', 'refunded', 'failed', 'scan', 'other']).optional(),
  type: z.enum(['all', 'payment', 'scan']).optional(),
  min: z.coerce.number().min(0).max(100000).optional(),
  max: z.coerce.number().min(0).max(100000).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ActivityQuery = z.infer<typeof ActivityQuery>;

export function listActivity(householdId: string, role: 'elder' | 'family', query: ActivityQuery) {
  const rows = db.prepare('SELECT * FROM payment_requests WHERE household_id=? ORDER BY created_at DESC, rowid DESC LIMIT 500').all(householdId) as any[];
  const items: ActivityItem[] = rows.map((r) => {
    const a = db.prepare('SELECT status, expires_at, decided_at, reason FROM approvals WHERE request_id=? ORDER BY created_at DESC LIMIT 1').get(r.id) as any;
    const lines = (() => { try { return JSON.parse(r.items_json) as { name: string; quantity: number }[]; } catch { return []; } })();
    const webhook = Boolean(r.paypal_capture_id && db.prepare("SELECT 1 FROM webhook_events WHERE resource_id=? AND event_type='PAYMENT.CAPTURE.COMPLETED' AND verified=1").get(r.paypal_capture_id));
    return {
      id: r.id, type: 'payment', at: iso(r.created_at), updatedAt: iso(r.updated_at),
      title: lines.map((l) => `${l.name}${l.quantity > 1 ? ` × ${l.quantity}` : ''}`).join(', ') || 'Purchase',
      status: String(r.state), statusGroup: groupOf(String(r.state)),
      amountCents: r.amount_cents, currency: r.currency, merchant: r.merchant,
      captured: Boolean(r.paypal_capture_id), webhookConfirmed: webhook, sandbox: true,
      approval: a ? { status: a.status === 'pending' && a.expires_at < Date.now() ? 'expired' : a.status, decidedAt: a.decided_at ? iso(a.decided_at) : null, reason: a.reason ?? null } : null,
      verdict: null, href: `/order/${r.id}`,
    };
  });
  // Family members only ever see the scan results the elder chose to share (same rule as the family overview).
  const scans = db.prepare(`SELECT id, verdict, summary, shared_with_family, created_at FROM security_scans WHERE household_id=? ${role === 'family' ? 'AND shared_with_family=1' : ''} ORDER BY created_at DESC LIMIT 500`).all(householdId) as any[];
  for (const s of scans) {
    items.push({
      id: s.id, type: 'scan', at: iso(s.created_at), updatedAt: iso(s.created_at), title: String(s.summary), status: String(s.verdict), statusGroup: 'scan',
      amountCents: null, currency: null, merchant: null, captured: false, webhookConfirmed: false, sandbox: false, approval: null,
      verdict: String(s.verdict), sharedWithFamily: Boolean(s.shared_with_family), href: null,
    });
  }

  const text = (query.q ?? query.item ?? '').toLowerCase();
  const fromMs = query.from ? Date.parse(`${query.from}T00:00:00Z`) : null;
  const toMs = query.to ? Date.parse(`${query.to}T23:59:59.999Z`) : null;
  const filtered = items.filter((it) => {
    if (query.type && query.type !== 'all' && it.type !== query.type) return false;
    if (query.status && query.status !== 'all' && it.statusGroup !== query.status) return false;
    if (text && !`${it.title} ${it.merchant ?? ''}`.toLowerCase().includes(text)) return false;
    if (query.min !== undefined && (it.amountCents === null || it.amountCents < Math.round(query.min * 100))) return false;
    if (query.max !== undefined && (it.amountCents === null || it.amountCents > Math.round(query.max * 100))) return false;
    const t = Date.parse(it.at);
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  }).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));

  const total = filtered.length;
  const start = (query.page - 1) * query.limit;
  const pending = items.filter((i) => i.statusGroup === 'pending').length;
  return { items: filtered.slice(start, start + query.limit), total, page: query.page, limit: query.limit, hasMore: start + query.limit < total, counts: { all: items.length, pending } };
}
