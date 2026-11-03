/**
 * Payments v2 capture check: GET /v2/payments/captures/{id} is the authority on what happened to the money
 * after an order is COMPLETED (captured, still pending, refunded, partially refunded, reversed).
 * Read-only. Never captures or refunds.
 */
import * as paypal from '../paypal/client.js';
import { recordEvidence } from './evidence.js';

export type CaptureCheck =
  | { result: 'completed' | 'pending' | 'refunded' | 'partially_refunded' | 'other'; capture: any; status: string }
  | { result: 'mismatch'; capture: any; status: string; why: string }
  | { result: 'unknown' | 'not_found'; capture: null; status: null; error?: string };

const cents = (v: unknown) => Math.round(Number(v) * 100);

/** Does a capture returned by PayPal belong to this exact local record (id, custom_id, order, amount, currency)? */
export function captureMismatch(r: any, cap: any, captureId: string): string | null {
  if (!cap || typeof cap !== 'object') return 'PayPal returned no capture';
  if (cap.id !== captureId) return `capture id ${cap.id} differs from ${captureId}`;
  if (cap.custom_id && cap.custom_id !== r.id) return 'capture custom_id belongs to a different purchase';
  const orderId = cap.supplementary_data?.related_ids?.order_id;
  if (orderId && r.paypal_order_id && orderId !== r.paypal_order_id) return 'capture belongs to a different PayPal order';
  if (cap.amount?.currency_code !== r.currency) return `currency ${cap.amount?.currency_code} differs from ${r.currency}`;
  if (cents(cap.amount?.value) !== r.amount_cents) return `amount ${cap.amount?.value} differs from the approved amount`;
  return null;
}

/** Reads the capture from Payments v2, checks it against the record, and records `capture_verified` evidence (source payments-v2). */
export async function checkCapture(r: any, captureId: string, opts: { timeoutMs?: number; record?: boolean } = {}): Promise<CaptureCheck> {
  let cap: any;
  try {
    cap = await paypal.getCapture(captureId, { timeoutMs: opts.timeoutMs });
  } catch (e: any) {
    if (e?.status === 404) return { result: 'not_found', capture: null, status: null };
    return { result: 'unknown', capture: null, status: null, error: String(e?.message ?? e).slice(0, 200) };
  }
  const why = captureMismatch(r, cap, captureId);
  const status = String(cap?.status ?? '');
  if (why) {
    if (opts.record !== false) recordEvidence(r, 'reconcile_mismatch', { source: 'payments-v2', captureId, status, note: why, paypalTime: cap?.update_time ?? null });
    return { result: 'mismatch', capture: cap, status, why };
  }
  if (opts.record !== false) {
    recordEvidence(r, 'capture_verified', { source: 'payments-v2', captureId, status, amount: cap.amount.value, currency: cap.amount.currency_code, paypalTime: cap.update_time ?? cap.create_time ?? null });
  }
  const result = status === 'COMPLETED' ? 'completed' : status === 'PENDING' ? 'pending' : status === 'REFUNDED' ? 'refunded' : status === 'PARTIALLY_REFUNDED' ? 'partially_refunded' : 'other';
  return { result, capture: cap, status };
}
