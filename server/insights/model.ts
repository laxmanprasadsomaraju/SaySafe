/**
 * Family Safety Insights — read-only data model behind GET /api/family/insights.
 *
 * Privacy model:
 *  - Every query is scoped to ONE household id taken from the authenticated family session.
 *  - Only allow-listed columns are read. Never returned: user ids, session/token data, approval nonces,
 *    fingerprints, idempotency keys, raw webhook payloads, PayPal order/capture ids (only "present?"),
 *    audit detail_json, raw scam message text (it is never stored; only the result headline is excerpted).
 *  - No writes. No new tables.
 */
import { db } from '../db/index.js';
import { normalizeVerdict } from '../scam/verdicts.js';
import { computeKpis, STATE_LABELS, type InsightEvent, type InsightPayment, type InsightScan, type InsightsPayload } from '../../shared/insights.js';

const toIso = (sqlite: string | null | undefined) => (sqlite ? new Date(sqlite.includes('T') ? sqlite : `${sqlite.replace(' ', 'T')}Z`).toISOString() : null);
const dayOf = (iso: string) => iso.slice(0, 10);
const excerpt = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Seed scripts mark their rows with an idempotency key (or capture id) prefix; everything else came through the real app flow. */
export const isSeededRow = (r: { idempotency_key?: string | null; paypal_capture_id?: string | null }) =>
  Boolean(r.idempotency_key?.startsWith('seed_') || r.paypal_capture_id?.startsWith('SEED'));

export function buildInsights(householdId: string, viewer: { userId: string; name: string }, now = Date.now()): InsightsPayload {
  const hh = db.prepare('SELECT h.elder_id, u.name AS elder_name FROM households h JOIN users u ON u.id = h.elder_id WHERE h.id = ?').get(householdId) as { elder_id: string; elder_name: string } | undefined;
  const policy = db.prepare('SELECT currency FROM spending_policies WHERE household_id = ?').get(householdId) as { currency: string } | undefined;
  const currency = policy?.currency ?? 'EUR';

  const rows = db.prepare(
    `SELECT id, created_at, state, items_json, merchant, amount_cents, currency, paypal_order_id, paypal_capture_id,
            captured_amount, captured_currency, idempotency_key
       FROM payment_requests WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500`,
  ).all(householdId) as any[];

  const approvalStmt = db.prepare('SELECT status, expires_at, decided_at FROM approvals WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1');
  const webhookStmt = db.prepare("SELECT received_at FROM webhook_events WHERE resource_id = ? AND event_type = 'PAYMENT.CAPTURE.COMPLETED' AND verified = 1 ORDER BY received_at ASC LIMIT 1");

  const payments: InsightPayment[] = rows.map((r) => {
    let items: { name?: string; quantity?: number }[] = [];
    try { items = JSON.parse(r.items_json); } catch { items = []; }
    const product = items.map((i) => `${i.name ?? 'Item'}${(i.quantity ?? 1) > 1 ? ` × ${i.quantity}` : ''}`).join(', ') || 'Purchase';
    const a = approvalStmt.get(r.id) as { status: string; expires_at: number; decided_at: string | null } | undefined;
    const approvalStatus = a ? (a.status === 'pending' && a.expires_at < now ? 'expired' : a.status) : null;
    const wh = r.paypal_capture_id ? (webhookStmt.get(r.paypal_capture_id) as { received_at: string } | undefined) : undefined;
    const createdAt = toIso(r.created_at)!;
    const capturedAmount = r.captured_amount != null && r.captured_amount !== '' ? Number(r.captured_amount) : null;
    return {
      id: r.id,
      createdAt,
      day: dayOf(createdAt),
      product,
      merchant: r.merchant,
      amount: r.amount_cents / 100,
      currency: r.currency,
      state: r.state,
      stateLabel: STATE_LABELS[r.state] ?? r.state,
      source: isSeededRow(r) ? 'seeded' : 'sandbox',
      hasPayPalOrder: Boolean(r.paypal_order_id),
      hasCapture: Boolean(r.paypal_capture_id),
      capturedAmount: Number.isFinite(capturedAmount) ? capturedAmount : null,
      capturedCurrency: r.captured_currency ?? null,
      webhookConfirmed: Boolean(wh),
      webhookConfirmedAt: wh ? toIso(wh.received_at) : null,
      approvalStatus,
      approvalDecidedAt: a ? toIso(a.decided_at) : null,
      approvalExpiresAt: a ? new Date(a.expires_at).toISOString() : null,
      awaitingMyDecision: r.state === 'FAMILY_APPROVAL_PENDING' && approvalStatus === 'pending',
    };
  });

  // Only scans the elder explicitly shared with family. The message itself is never stored.
  const scans: InsightScan[] = (db.prepare(
    'SELECT id, verdict, summary, created_at FROM security_scans WHERE household_id = ? AND shared_with_family = 1 ORDER BY created_at DESC LIMIT 200',
  ).all(householdId) as any[]).map((s) => {
    const createdAt = toIso(s.created_at)!;
    return { id: s.id, createdAt, day: dayOf(createdAt), verdict: normalizeVerdict(s.verdict), excerpt: excerpt(String(s.summary ?? '')) };
  });

  // Timeline from audit_log for this household: purchase steps, family decisions, PayPal confirmations, shared scans.
  const actorName = (actor: string) =>
    actor === viewer.userId ? 'You' : actor === hh?.elder_id ? (hh?.elder_name ?? 'Your relative') : actor.startsWith('paypal') ? 'PayPal' : actor === 'policy' || actor === 'system' ? 'SaySafe' : actor.startsWith('usr_') ? 'Family member' : 'SaySafe';
  const audits = db.prepare(
    `SELECT id, actor, action, target, at FROM audit_log
      WHERE household_id = ? AND (action LIKE 'payment.%' OR action LIKE 'approval.%' OR action = 'scan.shared')
      ORDER BY at DESC, id DESC LIMIT 500`,
  ).all(householdId) as any[];
  const paymentIds = new Set(payments.map((p) => p.id));
  const productOf = new Map(payments.map((p) => [p.id, p.product]));
  const events: InsightEvent[] = audits.map((e) => {
    const at = toIso(e.at)!;
    const pid = e.target && paymentIds.has(e.target) ? (e.target as string) : null;
    const what = pid ? productOf.get(pid) : undefined;
    let kind: InsightEvent['kind'] = 'payment';
    let label = e.action as string;
    if (e.action === 'scan.shared') { kind = 'scam_check'; label = 'Scam check shared with family'; }
    else if (e.action.startsWith('approval.')) {
      kind = 'family_decision';
      const v = e.action.slice('approval.'.length);
      label = v === 'requested' ? `Approval requested${what ? `: ${what}` : ''}` : `Purchase ${v}${what ? `: ${what}` : ''}`;
    } else if (e.action.startsWith('payment.')) {
      const t = e.action.slice('payment.'.length);
      const to = t.includes('->') ? t.split('->')[1] : t;
      if (e.actor === 'paypal-webhook' || to === 'CAPTURED') kind = 'paypal';
      label = t === 'created' ? `Purchase started${what ? `: ${what}` : ''}` : `${STATE_LABELS[to] ?? to}${what ? `: ${what}` : ''}`;
      if (e.actor === 'paypal-webhook') label = `PayPal webhook: ${STATE_LABELS[to] ?? to}${what ? ` (${what})` : ''}`;
    }
    return { id: `evt_${e.id}`, at, day: dayOf(at), kind, label, actor: actorName(String(e.actor)), paymentId: pid };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    me: { name: viewer.name },
    elder: { name: hh?.elder_name ?? 'Your relative' },
    currency,
    payments,
    scans,
    events,
    kpis: computeKpis(payments, scans, currency),
  };
}
