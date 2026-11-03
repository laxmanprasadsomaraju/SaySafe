/**
 * My Activity: one read-only, paginated list of this household's payments (with family decisions)
 * and scam checks. The household always comes from the session, never from the request.
 * Unknown payment states (e.g. refund states added later) are passed through with a neutral group.
 */
import { z } from 'zod';
import { db } from './db/index.js';
import { refundView } from './payments/service.js';

export type StatusGroup = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'failed' | 'scan' | 'other';
/** Activity sections: Purchases & payments, Scam checks, Family reviews, Refunds. Each item is in exactly one. */
export type ActivitySection = 'purchases' | 'scans' | 'family' | 'refunds';

export interface ActivityItem {
  id: string;
  type: 'payment' | 'scan' | 'record';
  at: string; // ISO, UTC
  updatedAt: string;
  title: string;
  status: string; // what to show: payment state, REFUND_REQUESTED for a buyer request, or the scan verdict
  state?: string; // raw payment state
  refundLabel?: string | null;
  statusGroup: StatusGroup;
  section: ActivitySection;
  amountCents: number | null;
  currency: string | null;
  merchant: string | null;
  captured: boolean;
  webhookConfirmed: boolean;
  sandbox: boolean;
  /** Local QA/example row (idempotency key seed_… or capture SEED…). Seed scripts refuse hosted databases. */
  example: boolean;
  /** Where the row comes from, shown as a label: sample data, a real PayPal Sandbox transaction, or a record the user typed. */
  source: 'sample' | 'paypal_sandbox' | 'user_entered' | 'scan';
  sourceLabel: string;
  /** What backs it: PayPal evidence, or "Illustrative — no PayPal record" for samples. */
  evidence: string | null;
  /**
   * Machine-readable verification level (one per record, see docs/ARCHITECTURE.md "Evidence model"). A record the
   * user typed is ALWAYS user_entered_unverified: it is never described as independently verified.
   */
  verification: 'illustrative' | 'paypal_webhook_verified' | 'paypal_capture_recorded' | 'paypal_order_only' | 'no_paypal_record' | 'user_entered_unverified' | 'not_applicable';
  /** Authoritative external ids (PayPal Sandbox) where they exist; never for samples or typed records. */
  externalIds: { paypalOrderId: string | null; paypalCaptureId: string | null } | null;
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
  section: z.enum(['all', 'purchases', 'scans', 'family', 'refunds']).optional(),
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
    // A buyer refund request is only a request: shown as REFUND_REQUESTED, never as refunded (same rule as the receipt).
    const rv = refundView(r);
    const shown = String(rv?.status ?? r.state);
    const webhook = Boolean(r.paypal_capture_id && db.prepare("SELECT 1 FROM webhook_events WHERE resource_id=? AND event_type='PAYMENT.CAPTURE.COMPLETED' AND verified=1").get(r.paypal_capture_id));
    return {
      id: r.id, type: 'payment', at: iso(r.created_at), updatedAt: iso(r.updated_at),
      title: lines.map((l) => `${l.name}${l.quantity > 1 ? ` × ${l.quantity}` : ''}`).join(', ') || 'Purchase',
      status: shown, state: String(r.state), refundLabel: rv?.label ?? null, statusGroup: groupOf(shown),
      section: groupOf(shown) === 'refunded' ? 'refunds' : a ? 'family' : 'purchases',
      amountCents: r.amount_cents, currency: r.currency, merchant: r.merchant,
      captured: Boolean(r.paypal_capture_id), webhookConfirmed: webhook, sandbox: true,
      example: Number(r.example ?? 0) === 1 || Boolean(String(r.idempotency_key ?? '').startsWith('seed_') || String(r.paypal_capture_id ?? '').startsWith('SEED')),
      source: Number(r.example ?? 0) === 1 ? 'sample' : 'paypal_sandbox',
      sourceLabel: Number(r.example ?? 0) === 1 ? 'Sample data' : 'Real PayPal Sandbox transaction',
      evidence: Number(r.example ?? 0) === 1 ? 'Illustrative — no PayPal record' : r.paypal_capture_id ? (webhook ? 'PayPal capture + signed webhook verified' : 'PayPal capture recorded') : r.paypal_order_id ? 'PayPal order created, not captured' : 'No PayPal order yet',
      verification: Number(r.example ?? 0) === 1 ? 'illustrative' : r.paypal_capture_id ? (webhook ? 'paypal_webhook_verified' : 'paypal_capture_recorded') : r.paypal_order_id ? 'paypal_order_only' : 'no_paypal_record',
      externalIds: Number(r.example ?? 0) === 1 ? null : { paypalOrderId: r.paypal_order_id ?? null, paypalCaptureId: r.paypal_capture_id ?? null },
      approval: a ? { status: a.status === 'pending' && a.expires_at < Date.now() ? 'expired' : a.status, decidedAt: a.decided_at ? iso(a.decided_at) : null, reason: a.reason ?? null } : null,
      verdict: null, href: `/order/${r.id}`,
    };
  });
  // Family members only ever see the scan results the elder chose to share (same rule as the family overview).
  const scans = db.prepare(`SELECT id, verdict, summary, shared_with_family, example, created_at FROM security_scans WHERE household_id=? ${role === 'family' ? 'AND shared_with_family=1' : ''} ORDER BY created_at DESC LIMIT 500`).all(householdId) as any[];
  for (const s of scans) {
    items.push({
      id: s.id, type: 'scan', at: iso(s.created_at), updatedAt: iso(s.created_at), title: String(s.summary), status: String(s.verdict), statusGroup: 'scan', section: 'scans',
      amountCents: null, currency: null, merchant: null, captured: false, webhookConfirmed: false, sandbox: false, example: Number(s.example ?? 0) === 1, source: 'scan', sourceLabel: Number(s.example ?? 0) === 1 ? 'Training example (practice)' : 'Scam check', evidence: null, verification: 'not_applicable', externalIds: null, approval: null,
      verdict: String(s.verdict), sharedWithFamily: Boolean(s.shared_with_family), href: null,
    });
  }

  // Payment records Mary typed (or sample ones) are PRIVATE to her: listed for the elder only, never for family.
  if (role === 'elder') {
    const recs = db.prepare('SELECT id, recipient, amount_cents, currency, paid_on, pay_method, memo, example, created_at, updated_at FROM companion_payments WHERE household_id=? ORDER BY paid_on DESC LIMIT 500').all(householdId) as any[];
    for (const m of recs) {
      const sample = Number(m.example ?? 0) === 1;
      items.push({
        id: m.id, type: 'record', at: `${m.paid_on}T12:00:00Z`, updatedAt: iso(m.updated_at), title: `${m.recipient}${m.memo ? ` · ${m.memo}` : ''}`,
        status: 'RECORDED', statusGroup: 'other', section: 'purchases', amountCents: Number(m.amount_cents), currency: m.currency, merchant: m.recipient,
        captured: false, webhookConfirmed: false, sandbox: false, example: sample, source: sample ? 'sample' : 'user_entered',
        sourceLabel: sample ? 'Sample data' : 'Recorded by you — not verified', evidence: sample ? 'Illustrative — no PayPal record' : 'Only what you typed — SaySafe can’t see your bank',
        verification: sample ? 'illustrative' : 'user_entered_unverified', externalIds: null, approval: null, verdict: null, href: null,
      });
    }
  }

  const text = (query.q ?? query.item ?? '').toLowerCase();
  const fromMs = query.from ? Date.parse(`${query.from}T00:00:00Z`) : null;
  const toMs = query.to ? Date.parse(`${query.to}T23:59:59.999Z`) : null;
  const filtered = items.filter((it) => {
    if (query.type && query.type !== 'all' && it.type !== query.type && !(query.type === 'payment' && it.type === 'record')) return false;
    if (query.status && query.status !== 'all' && it.statusGroup !== query.status) return false;
    if (query.section && query.section !== 'all' && it.section !== query.section) return false;
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
