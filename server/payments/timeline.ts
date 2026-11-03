/**
 * Payment evidence timeline for the receipt. Read-only; built from rows we already keep:
 *  - audit_log state transitions (`payment.X->Y`, with who moved it: user/redirect, paypal, paypal-webhook, reconcile)
 *  - audit_log `evidence.*` rows (PayPal's own timestamps for captures/approvals)
 *  - webhook_events (only signature-verified events are ever stored)
 *  - refund_requests (buyer asked) and refunds (merchant refund execution)
 *  - Payments v2 read-backs (`evidence.capture_verified`, `evidence.refund_verified`, source 'payments-v2')
 * Out-of-order arrivals (e.g. the webhook before the capture response) never regress state (the service
 * refuses that); here events are ordered by PayPal's time when we have it, else our server time, and
 * duplicates collapse to the first occurrence.
 */
import { db } from '../db/index.js';

export type TimelineKind =
  | 'order_created' | 'buyer_approved' | 'capture_completed' | 'capture_verified' | 'webhook_received'
  | 'refund_asked' | 'refund_requested' | 'refund_completed' | 'refund_verified' | 'refund_webhook';
export interface TimelineEvent {
  kind: TimelineKind;
  label: string;
  at: string; // ISO, when SaySafe recorded it
  paypalTime: string | null; // ISO, PayPal's own timestamp when PayPal gave one
  source: string;
  verification: string;
  verified: boolean;
}
export interface PaymentTimeline { label: string; events: TimelineEvent[]; pending: string[] }

export const SANDBOX_LABEL = 'PayPal Sandbox — no real money';
const RANK: Record<TimelineKind, number> = {
  order_created: 0, buyer_approved: 1, capture_completed: 2, capture_verified: 3, webhook_received: 4,
  refund_asked: 5, refund_requested: 6, refund_completed: 7, refund_verified: 8, refund_webhook: 9,
};

const iso = (t: string | null | undefined) => {
  if (!t) return null;
  const ms = Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
export const truncateId = (id: string | null | undefined) => (!id ? '' : id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);
const json = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const cents = (v: unknown) => Math.round(Number(v) * 100);

export function buildTimeline(r: any): PaymentTimeline {
  const rows = db.prepare('SELECT actor, action, detail_json, at FROM audit_log WHERE target=? ORDER BY id ASC').all(r.id) as { actor: string; action: string; detail_json: string | null; at: string }[];
  const events: TimelineEvent[] = [];
  const has = (k: TimelineKind) => events.some((e) => e.kind === k);
  const evidence = (kind: string) => rows.filter((x) => x.action === `evidence.${kind}`).map((x) => json(x.detail_json));

  for (const row of rows) {
    if (row.action.endsWith('->PAYER_APPROVAL_PENDING') && !has('order_created')) {
      const d = json(row.detail_json);
      events.push({ kind: 'order_created', label: 'Order created', at: iso(row.at)!, paypalTime: null, source: `SaySafe server · PayPal order ${truncateId(d.paypal_order_id ?? r.paypal_order_id)}`, verification: 'Amount and items set by SaySafe from the shop catalogue', verified: true });
    } else if (row.action.endsWith('->PAYER_APPROVED') && !has('buyer_approved')) {
      const viaReconcile = row.actor === 'reconcile';
      const ev = evidence('buyer_approved')[0];
      events.push({ kind: 'buyer_approved', label: 'Buyer approved at PayPal', at: iso(row.at)!, paypalTime: iso(ev?.paypalTime), source: viaReconcile ? 'Checked with PayPal (reconcile)' : 'PayPal redirect', verification: 'PayPal order status APPROVED read from PayPal’s API; amount and currency matched', verified: true });
    } else if (row.action.endsWith('->CAPTURED') && !has('capture_completed')) {
      const src = row.actor === 'paypal-webhook' ? 'Signed PayPal webhook' : row.actor === 'reconcile' ? 'Checked with PayPal (reconcile)' : 'PayPal capture response';
      const ev = [...evidence('capture')].find((e) => !r.paypal_capture_id || e.captureId === r.paypal_capture_id);
      const amountOk = r.captured_amount != null && cents(r.captured_amount) === r.amount_cents && r.captured_currency === r.currency;
      events.push({ kind: 'capture_completed', label: 'Payment captured', at: iso(row.at)!, paypalTime: iso(ev?.paypalTime), source: src, verification: amountOk ? `Amount and currency matched (${r.captured_amount} ${r.captured_currency})` : 'Amount/currency check did not match', verified: amountOk });
    }
  }

  const wh = r.paypal_capture_id
    ? (db.prepare("SELECT payload_json, received_at FROM webhook_events WHERE resource_id=? AND event_type='PAYMENT.CAPTURE.COMPLETED' AND verified=1 ORDER BY received_at ASC LIMIT 1").get(r.paypal_capture_id) as { payload_json: string; received_at: string } | undefined)
    : undefined;
  if (wh) {
    const p = json(wh.payload_json);
    events.push({ kind: 'webhook_received', label: 'Signed PayPal notice received', at: iso(wh.received_at)!, paypalTime: iso(p.create_time), source: 'PayPal webhook', verification: 'Signature verified with PayPal’s verify-webhook-signature API', verified: true });
    // If the webhook arrived first and moved the state, the capture row has no PayPal time; borrow the event's.
    const cap = events.find((e) => e.kind === 'capture_completed');
    if (cap && !cap.paypalTime) cap.paypalTime = iso(p.resource_create_time) ?? null;
  }

  // Payments v2 read-back of the capture (GET /v2/payments/captures/{id}).
  const v2 = evidence('capture_verified').find((e) => e.source === 'payments-v2' && (!r.paypal_capture_id || e.captureId === r.paypal_capture_id));
  if (v2) {
    const at = rows.find((x) => x.action === 'evidence.capture_verified')?.at;
    const ok = v2.amount != null && cents(v2.amount) === r.amount_cents && v2.currency === r.currency;
    events.push({ kind: 'capture_verified', label: 'Capture checked with PayPal', at: iso(at)!, paypalTime: iso(v2.paypalTime), source: `PayPal Payments v2 · capture ${truncateId(v2.captureId)}`, verification: ok ? `Status ${v2.status}; amount and currency matched (${v2.amount} ${v2.currency})` : 'Amount/currency check did not match', verified: ok });
  }

  // ---- Refunds ----
  const ask = db.prepare('SELECT created_at FROM refund_requests WHERE request_id=?').get(r.id) as { created_at: string } | undefined;
  if (ask) events.push({ kind: 'refund_asked', label: 'You asked for a refund', at: iso(ask.created_at)!, paypalTime: null, source: 'SaySafe (request to the shop)', verification: 'A request only — not a refund. The shop decides.', verified: true });
  const refundStart = rows.find((x) => x.action.endsWith('->REFUND_PENDING'));
  if (refundStart) events.push({ kind: 'refund_requested', label: 'Refund requested from PayPal', at: iso(refundStart.at)!, paypalTime: null, source: 'Demo Shop merchant (admin)', verification: 'Capture, amount and currency re-checked with PayPal Payments v2 first; full refund only', verified: true });
  const refundedRow = rows.find((x) => x.action.endsWith('->REFUNDED'));
  const done = evidence('refund_completed')[0];
  if (refundedRow || done) {
    const src = done ? 'PayPal refund response' : refundedRow!.actor === 'paypal-webhook' ? 'Signed PayPal webhook' : refundedRow!.actor === 'reconcile' ? 'Checked with PayPal (reconcile)' : 'PayPal';
    const amt = done?.amount ?? r.captured_amount;
    const cur = done?.currency ?? r.captured_currency;
    const ok = amt != null && cents(amt) === r.amount_cents && cur === r.currency;
    const at = done ? rows.find((x) => x.action === 'evidence.refund_completed')!.at : refundedRow!.at;
    events.push({ kind: 'refund_completed', label: 'Refund completed', at: iso(at)!, paypalTime: iso(done?.paypalTime), source: done?.refundId ? `${src} · refund ${truncateId(done.refundId)}` : src, verification: ok ? `Full refund of ${amt} ${cur}` : 'Refund amount did not match the payment', verified: ok });
  }
  const rv = evidence('refund_verified').find((e) => e.source === 'payments-v2');
  if (rv) {
    const at = rows.find((x) => x.action === 'evidence.refund_verified')!.at;
    events.push({ kind: 'refund_verified', label: 'Refund checked with PayPal', at: iso(at)!, paypalTime: iso(rv.paypalTime), source: rv.refundId ? `PayPal Payments v2 · refund ${truncateId(rv.refundId)}` : `PayPal Payments v2 · capture ${truncateId(rv.captureId)} shows REFUNDED`, verification: `Status ${rv.status}; ${rv.amount} ${rv.currency}`, verified: true });
  }
  const refundRec = db.prepare('SELECT refund_id FROM refunds WHERE request_id=?').get(r.id) as { refund_id: string | null } | undefined;
  const rwh = r.paypal_capture_id
    ? (db.prepare(
      "SELECT payload_json, received_at FROM webhook_events WHERE event_type='PAYMENT.CAPTURE.REFUNDED' AND verified=1 AND (resource_id=? OR json_extract(payload_json,'$.capture_id')=?) ORDER BY received_at ASC LIMIT 1",
    ).get(refundRec?.refund_id ?? null, r.paypal_capture_id) as { payload_json: string; received_at: string } | undefined)
    : undefined;
  if (rwh) {
    const p = json(rwh.payload_json);
    events.push({ kind: 'refund_webhook', label: 'Signed PayPal refund notice received', at: iso(rwh.received_at)!, paypalTime: iso(p.create_time), source: 'PayPal webhook (PAYMENT.CAPTURE.REFUNDED)', verification: 'Signature verified with PayPal’s verify-webhook-signature API', verified: true });
    const rc = events.find((e) => e.kind === 'refund_completed');
    if (rc && !rc.paypalTime) rc.paypalTime = iso(p.resource_create_time) ?? null;
  }

  // One event per kind, in PayPal's own order (created -> approved -> captured -> notice -> refund). Arrival order at our
  // server (e.g. webhook before capture response) and clock skew never reorder them.
  events.sort((a, b) => RANK[a.kind] - RANK[b.kind]);

  const pending: string[] = [];
  if (['CAPTURED', 'REFUND_PENDING', 'REFUNDED'].includes(r.state) && !wh) pending.push('Signed PayPal notice not received yet');
  if (r.state === 'PAYER_APPROVAL_PENDING') pending.push('Waiting for the buyer to approve at PayPal');
  if (r.state === 'PAYER_APPROVED') pending.push('Approved at PayPal, not yet paid. Nothing is taken until you confirm.');
  if (r.state === 'CAPTURE_PENDING') pending.push('PayPal is still processing the capture');
  if (r.state === 'CAPTURED' && ask) pending.push('Refund request sent — not refunded yet');
  if (r.state === 'REFUND_PENDING') pending.push('Refund sent to PayPal — waiting for PayPal to confirm');
  if (r.state === 'REFUNDED' && !rwh) pending.push('Signed PayPal refund notice not received yet');
  return { label: SANDBOX_LABEL, events, pending };
}
