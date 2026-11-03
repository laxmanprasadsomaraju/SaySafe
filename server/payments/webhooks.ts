/**
 * PayPal webhook intake: verify -> persist -> process -> mark processed.
 *
 *  1. Signature: PayPal's verify-webhook-signature API (needs PAYPAL_WEBHOOK_ID). Unverified events are refused
 *     (400) and never stored or acted on.
 *  2. Durable persistence: the minimal event (no payer name, email or address) is stored by event id BEFORE any
 *     processing. The id is the PRIMARY KEY, so a redelivery can never create a second row.
 *  3. Processing: dispatched by event type. Every handler is idempotent and never regresses state (out-of-order
 *     events are tolerated). On success the row gets processed_at + outcome.
 *  4. Retry: if processing throws (or the process dies mid-way), processed_at stays NULL and we answer 500, so
 *     PayPal redelivers; the redelivery is processed instead of being swallowed as a duplicate.
 */
import { db } from '../db/index.js';
import { verifyWebhook } from '../paypal/client.js';
import { count, log } from '../obs.js';
import * as pay from './service.js';
import { refundFromWebhook } from './refund.js';
import { demoFromWebhook } from '../companion/demoMembership.js';

/** Test seam only: lets tests simulate a crash during processing. Never set in the app. */
export const __webhookTestHooks: { beforeDispatch: null | (() => void) } = { beforeDispatch: null };

export interface WebhookResult { status: number; body: Record<string, unknown> }

export function minimalEvent(event: any) {
  const resource = event?.resource ?? {};
  return {
    id: String(event?.id ?? ''), event_type: String(event?.event_type ?? ''), resource_type: event?.resource_type ?? null, resource_id: String(resource.id ?? ''),
    status: resource.status ?? null, amount: resource.amount?.value ?? null, currency: resource.amount?.currency_code ?? null,
    custom_id: resource.custom_id ?? resource.purchase_units?.[0]?.custom_id ?? null, order_id: resource.supplementary_data?.related_ids?.order_id ?? null,
    // Refund events: the capture this refund belongs to (from the refund's `up` link).
    capture_id: (resource.links ?? []).find((l: any) => l?.rel === 'up')?.href?.match(/\/v2\/payments\/captures\/([A-Z0-9]+)$/)?.[1] ?? null,
    create_time: event?.create_time ?? null, resource_create_time: resource.create_time ?? null,
  };
}

export function dispatch(event: any): string {
  const type = String(event?.event_type ?? '');
  // Signed BILLING.SUBSCRIPTION.* events only ever touch the SaySafe Demo Membership row they name (id + custom_id).
  if (type.startsWith('BILLING.SUBSCRIPTION.')) return demoFromWebhook(event).matched ? 'demo_membership_updated' : 'demo_membership_unmatched';
  if (type === 'PAYMENT.CAPTURE.REFUNDED') return String(refundFromWebhook(event));
  return String(pay.reconcileFromWebhook(event));
}

export async function handleWebhook(raw: string, headers: Record<string, unknown>): Promise<WebhookResult> {
  count('webhook.received');
  let event: any;
  try { event = JSON.parse(raw); } catch { count('webhook.bad_json'); return { status: 400, body: { error: 'bad_json' } }; }
  const id = String(event?.id ?? '');
  if (!id || !/^[A-Za-z0-9._:-]{1,120}$/.test(id)) { count('webhook.bad_id'); return { status: 400, body: { error: 'bad_event' } }; }
  let verified = false;
  try { verified = await verifyWebhook(headers as any, raw); } catch { verified = false; count('webhook.verify_errors'); }
  if (!verified) {
    count('webhook.rejected_signature');
    log('warn', 'webhook.unverified', { eventType: String(event?.event_type ?? '').slice(0, 60) });
    return { status: 400, body: { error: 'unverified' } }; // never act on (or store) unverified events
  }
  count('webhook.verified');
  const m = minimalEvent(event);
  const ins = db.prepare('INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, verified, payload_json, attempts) VALUES (?,?,?,1,?,0)').run(id, m.event_type, m.resource_id, JSON.stringify(m));
  if (ins.changes === 0) {
    const row = db.prepare('SELECT processed_at, outcome FROM webhook_events WHERE id=?').get(id) as { processed_at: string | null; outcome: string | null } | undefined;
    if (row?.processed_at) { count('webhook.duplicates'); return { status: 200, body: { ok: true, duplicate: true } }; }
    count('webhook.reprocessed'); // stored earlier but never finished processing: PayPal's retry gets processed now
  }
  db.prepare('UPDATE webhook_events SET attempts=attempts+1 WHERE id=?').run(id);
  try {
    __webhookTestHooks.beforeDispatch?.();
    const outcome = dispatch(event);
    db.prepare("UPDATE webhook_events SET processed_at=datetime('now'), outcome=? WHERE id=?").run(outcome.slice(0, 60), id);
    count('webhook.processed');
    log('info', 'webhook.processed', { eventType: m.event_type, outcome });
    return { status: 200, body: { ok: true, outcome } };
  } catch (e: any) {
    const code = e instanceof pay.PaymentError ? e.code : 'error';
    db.prepare('UPDATE webhook_events SET outcome=? WHERE id=?').run(`failed:${code}`.slice(0, 60), id);
    count('webhook.processing_failed');
    log('error', 'webhook.processing_failed', { eventType: m.event_type, code });
    return { status: 500, body: { error: 'processing_failed', retry: true } }; // non-2xx: PayPal redelivers
  }
}

/** Safe, PII-free summary for /api/health. */
export function webhookStatus() {
  const r = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) AS unprocessed,
    SUM(CASE WHEN outcome LIKE 'failed:%' THEN 1 ELSE 0 END) AS failed, MAX(received_at) AS last_received FROM webhook_events`).get() as any;
  return { configured: Boolean(process.env.PAYPAL_WEBHOOK_ID), stored: Number(r?.total ?? 0), unprocessed: Number(r?.unprocessed ?? 0), failed: Number(r?.failed ?? 0), lastReceivedAt: r?.last_received ?? null };
}
