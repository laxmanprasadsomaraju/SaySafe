/**
 * Refund lifecycle (Demo Shop, PayPal Sandbox). Full refunds only.
 *
 *  - Buyer (elder) "Request a refund" -> refund_requests row, status REFUND_REQUESTED. A request only: no money moves,
 *    the payment stays CAPTURED, and the UI says "Request sent — not refunded yet".
 *  - Family members have NO refund authority.
 *  - Only the merchant admin (ADMIN_TOKEN, header X-Admin-Token, compared in constant time) can execute a refund:
 *    POST /api/admin/payments/:id/refund. Without ADMIN_TOKEN set, refunds are disabled (503).
 *  - Before PayPal is called: payment must be CAPTURED, Demo Shop, capture id + amount + currency match the record AND
 *    PayPal's own GET /v2/payments/captures/{id}, and not already refunded. The PayPal-Request-Id is written to the
 *    `refunds` table and the state moved to REFUND_PENDING in one DB transaction, so a retry reuses the key.
 *  - Response verified (id, amount, currency, custom_id, capture link), then GET /v2/payments/refunds/{id} confirms.
 *  - 4xx: refund row FAILED, state back to CAPTURED, clear error. Timeout / 5xx: stays REFUND_PENDING; reconcile
 *    resolves it from GET refund (when we have the id) or GET capture (REFUNDED / PARTIALLY_REFUNDED).
 *  - Signed PAYMENT.CAPTURE.REFUNDED webhook: correlated by refund id, capture id (refund `up` link) or custom_id.
 */
import crypto from 'node:crypto';
import { db, audit, isUniqueViolation } from '../db/index.js';
import * as paypal from '../paypal/client.js';
import { DEMO_MERCHANT } from '../catalogue/products.js';
import { PaymentError, transition, publicView, load, loadActionable, assertNotSample } from './service.js';
import { checkCapture } from './captureCheck.js';
import { recordEvidence, evidenceRows } from './evidence.js';
import { newId } from '../auth.js';

const cents = (v: unknown) => Math.round(Number(v) * 100);
const fresh = (id: string) => db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id) as any;
const refundRow = (id: string) => db.prepare('SELECT * FROM refunds WHERE request_id=?').get(id) as any;

// ---------- Merchant admin authority ----------
export const ADMIN_HEADER = 'x-admin-token';
export const MIN_ADMIN_TOKEN_LENGTH = 24;
export const REFUNDS_DISABLED_MESSAGE = 'Refunds not enabled';

export function refundsEnabled() {
  return (process.env.ADMIN_TOKEN ?? '').length >= MIN_ADMIN_TOKEN_LENGTH;
}

/** Constant-time comparison (SHA-256 of both sides, so lengths never leak either). */
export function checkAdminToken(presented: unknown): 'ok' | 'missing' | 'wrong' | 'disabled' {
  const expected = process.env.ADMIN_TOKEN ?? '';
  if (expected.length < MIN_ADMIN_TOKEN_LENGTH) return 'disabled';
  if (typeof presented !== 'string' || presented.length === 0) return 'missing';
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

/** The capture id a refund belongs to, from its `up` link (…/v2/payments/captures/{id}). */
export function refundCaptureId(refund: any): string | null {
  const up = (refund?.links ?? []).find((l: any) => l?.rel === 'up' && typeof l.href === 'string');
  const m = up?.href.match(/\/v2\/payments\/captures\/([A-Z0-9]+)$/);
  return m ? m[1] : null;
}

/** Moves the payment to REFUNDED (from CAPTURED or REFUND_PENDING) and closes any buyer request. Never regresses. */
function markRefunded(r: any, actor: string) {
  if (r.state === 'REFUNDED') return r;
  let now = r;
  try { now = transition(r, 'REFUNDED', actor); }
  catch (e) {
    if (!(e instanceof PaymentError && e.code === 'conflict')) throw e;
    now = fresh(r.id);
    if (now.state !== 'REFUNDED' && (now.state === 'CAPTURED' || now.state === 'REFUND_PENDING')) now = transition(now, 'REFUNDED', actor);
  }
  db.prepare("UPDATE refund_requests SET status='REFUNDED', updated_at=datetime('now') WHERE request_id=?").run(r.id);
  return now;
}

/** REFUND_PENDING -> CAPTURED after a definitive PayPal refusal. Ignores the case where something else already moved it. */
function backToCaptured(id: string, actor: string) {
  const now = fresh(id);
  if (now?.state !== 'REFUND_PENDING') return now;
  try { return transition(now, 'CAPTURED', actor); } catch (e) { if (e instanceof PaymentError && e.code === 'conflict') return fresh(id); throw e; }
}

// ---------- Buyer request (not a refund) ----------
export function requestRefund(householdId: string, actor: string, requestId: string, reason?: unknown) {
  const r = loadActionable(requestId, householdId); // household scoping: 404 for anyone else's purchase; 409 for a sample row
  if (r.state === 'REFUNDED') throw new PaymentError('already_refunded', 'This payment has already been refunded.', 409);
  if (!['CAPTURED', 'REFUND_PENDING'].includes(r.state)) throw new PaymentError('not_paid', 'Only a completed payment can have a refund request.', 409);
  const existing = db.prepare('SELECT id FROM refund_requests WHERE request_id=?').get(r.id);
  if (!existing) {
    const why = typeof reason === 'string' ? reason.trim().slice(0, 200) || null : null;
    try {
      db.prepare("INSERT INTO refund_requests (id, request_id, household_id, requested_by, reason, status) VALUES (?,?,?,?,?,'REFUND_REQUESTED')")
        .run(newId('rfq'), r.id, householdId, actor, why);
      audit(householdId, actor, 'refund.requested_by_buyer', r.id); // reason stays in refund_requests only
    } catch (e) { if (!isUniqueViolation(e)) throw e; } // double tap: one request
  }
  return publicView(load(r.id, householdId));
}

// ---------- Merchant refund ----------
export interface AdminRefundResult {
  status: 'REFUNDED' | 'REFUND_PENDING';
  outcome: 'refunded' | 'already_refunded' | 'pending' | 'unknown' | 'mismatch';
  refundId: string | null;
  duplicate: boolean;
  message: string;
  request: ReturnType<typeof publicView>;
}

const inflight = new Map<string, Promise<AdminRefundResult>>();

/** Concurrent duplicates share one in-flight attempt (one PayPal call); later duplicates read the stored result. */
export function adminRefund(requestId: string, actor: string, opts: { householdId?: string; amount?: unknown; currency?: unknown; captureId?: unknown } = {}): Promise<AdminRefundResult> {
  const running = inflight.get(requestId);
  if (running) return running.then((x) => ({ ...x, duplicate: true }));
  const p = doRefund(requestId, actor, opts).finally(() => inflight.delete(requestId));
  inflight.set(requestId, p);
  return p;
}

function result(r: any, outcome: AdminRefundResult['outcome'], message: string, duplicate = false): AdminRefundResult {
  const now = fresh(r.id);
  return { status: now.state === 'REFUNDED' ? 'REFUNDED' : 'REFUND_PENDING', outcome, refundId: refundRow(r.id)?.refund_id ?? null, duplicate, message, request: publicView(now) };
}

async function doRefund(requestId: string, actor: string, opts: { householdId?: string; amount?: unknown; currency?: unknown; captureId?: unknown }): Promise<AdminRefundResult> {
  const r = fresh(requestId);
  if (!r || (opts.householdId && opts.householdId !== r.household_id)) throw new PaymentError('not_found', 'Payment not found.', 404);
  assertNotSample(r);
  if (opts.amount != null && opts.amount !== '') {
    if (cents(opts.amount) !== r.amount_cents || (opts.currency != null && opts.currency !== r.currency)) {
      throw new PaymentError('partial_refund_unsupported', 'Partial refunds are not supported. Only a full refund of the captured amount can be made.', 400);
    }
  }
  if (r.state === 'REFUNDED') return result(r, 'already_refunded', 'Already refunded. No second refund was made.', true);
  if (r.merchant !== DEMO_MERCHANT) throw new PaymentError('not_demo_shop', 'Only SaySafe Demo Shop payments can be refunded here.', 409);
  if (opts.captureId != null && opts.captureId !== r.paypal_capture_id) throw new PaymentError('capture_mismatch', 'That capture id does not belong to this payment.', 409);

  if (r.state === 'REFUND_PENDING') {
    // A previous attempt's outcome is unknown. Resume with the SAME stored PayPal-Request-Id: PayPal replays, never refunds twice.
    const row = refundRow(r.id);
    if (!row) throw new PaymentError('refund_state_unknown', 'A refund is pending but no refund key is stored. Run reconcile.', 409);
    return sendRefund(r, row);
  }
  if (r.state !== 'CAPTURED' || !r.paypal_capture_id) throw new PaymentError('not_captured', `Only captured payments can be refunded (this one is ${r.state}).`, 409);
  if (cents(r.captured_amount) !== r.amount_cents || r.captured_currency !== r.currency) {
    throw new PaymentError('amount_mismatch', 'The captured amount on record does not match the approved amount. Not refunded.', 409);
  }

  // PayPal's own view of the capture (Payments v2) must agree before any money moves.
  const v2 = await checkCapture(r, r.paypal_capture_id);
  if (v2.result === 'unknown') throw new PaymentError('paypal_unavailable', 'Could not confirm the capture with PayPal. Nothing was refunded.', 503);
  if (v2.result === 'not_found') throw new PaymentError('capture_mismatch', 'PayPal does not know this capture. Nothing was refunded.', 409);
  if (v2.result === 'mismatch') {
    const amountish = /amount|currency/.test(v2.why);
    throw new PaymentError(amountish ? 'amount_mismatch' : 'capture_mismatch', `PayPal's capture does not match this payment (${v2.why}). Nothing was refunded.`, 409);
  }
  if (v2.result === 'refunded') {
    markRefunded(fresh(r.id), 'reconcile');
    recordEvidence(r, 'refund_verified', { source: 'payments-v2', captureId: r.paypal_capture_id, status: 'REFUNDED', amount: v2.capture.amount?.value, currency: v2.capture.amount?.currency_code, paypalTime: v2.capture.update_time ?? null });
    throw new PaymentError('already_refunded', 'PayPal already shows this capture as fully refunded. No second refund was made; the record now shows Refunded.', 409);
  }
  if (v2.result === 'partially_refunded') throw new PaymentError('partial_refund_unsupported', 'PayPal shows this capture as partially refunded. Partial refunds are not supported here; nothing was refunded.', 409);
  if (v2.result !== 'completed') throw new PaymentError('capture_not_completed', `PayPal shows this capture as ${v2.status}. Nothing was refunded.`, 409);

  // Durable idempotency: key stored + state REFUND_PENDING atomically, BEFORE calling PayPal.
  const prev = refundRow(r.id);
  const attempt = prev ? prev.attempt + 1 : 1; // a new key only after a definitive failure (state was put back to CAPTURED)
  const key = `refund-${r.id}-${attempt}`;
  let pending: any;
  db.transaction(() => {
    if (prev) {
      db.prepare("UPDATE refunds SET paypal_request_id=?, attempt=?, status='IN_FLIGHT', refund_id=NULL, paypal_status=NULL, last_error=NULL, actor=?, updated_at=datetime('now') WHERE request_id=?").run(key, attempt, actor, r.id);
    } else {
      db.prepare("INSERT INTO refunds (request_id, household_id, capture_id, paypal_request_id, attempt, status, amount, currency, actor) VALUES (?,?,?,?,?, 'IN_FLIGHT', ?,?,?)")
        .run(r.id, r.household_id, r.paypal_capture_id, key, attempt, r.captured_amount, r.captured_currency, actor);
    }
    pending = transition(fresh(r.id), 'REFUND_PENDING', actor, {});
  })();
  audit(r.household_id, actor, 'refund.requested', r.id, { paypalRequestId: key, amount: r.captured_amount, currency: r.captured_currency });
  return sendRefund(pending, refundRow(r.id));
}

async function sendRefund(r: any, row: any): Promise<AdminRefundResult> {
  let ref: any;
  try {
    ref = await paypal.refundCapture(row.capture_id, row.paypal_request_id, r.id);
  } catch (e: any) {
    const issue: string | undefined = e?.data?.details?.[0]?.issue;
    const detail = `${e?.status ?? 'network'} ${e?.data?.name ?? ''} ${issue ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (paypal.isUnknownOutcome(e)) {
      db.prepare("UPDATE refunds SET status='UNKNOWN', last_error=?, updated_at=datetime('now') WHERE request_id=?").run(detail, r.id);
      audit(r.household_id, 'paypal', 'refund.outcome_unknown', r.id, { detail });
      return result(r, 'unknown', 'PayPal did not answer. The refund is pending; it will not be made twice. Reconcile (or retry) resolves it.');
    }
    if (issue === 'CAPTURE_FULLY_REFUNDED') {
      // Already refunded at PayPal (e.g. an earlier attempt we never heard back from): read PayPal, do not guess.
      db.prepare("UPDATE refunds SET last_error=?, updated_at=datetime('now') WHERE request_id=?").run(detail, r.id);
      const out = await reconcileRefund(fresh(r.id));
      return result(r, out.outcome === 'refunded' ? 'refunded' : 'pending', out.outcome === 'refunded' ? 'PayPal shows the capture as fully refunded.' : 'PayPal says the capture is already refunded; waiting to confirm.');
    }
    db.prepare("UPDATE refunds SET status='FAILED', last_error=?, updated_at=datetime('now') WHERE request_id=?").run(detail, r.id);
    backToCaptured(r.id, 'paypal');
    audit(r.household_id, 'paypal', 'refund.failed', r.id, { detail });
    throw new PaymentError('refund_failed', `PayPal refused the refund (${detail}). Nothing was refunded; the payment is still captured.`, 422);
  }
  return applyRefundResponse(fresh(r.id), ref, 'refund_response');
}

/** Checks a refund object from PayPal against our record. Returns why it does not match, or null. */
function refundMismatch(r: any, row: any, ref: any): string | null {
  if (!ref || typeof ref.id !== 'string' || !ref.id) return 'PayPal returned no refund id';
  if (row?.refund_id && row.refund_id !== ref.id) return `refund id ${ref.id} differs from ${row.refund_id}`;
  if (ref.custom_id && ref.custom_id !== r.id) return 'refund custom_id belongs to a different purchase';
  const capId = refundCaptureId(ref);
  if (capId && capId !== r.paypal_capture_id) return 'refund belongs to a different capture';
  if (ref.amount?.currency_code !== r.currency) return `refund currency ${ref.amount?.currency_code} differs from ${r.currency}`;
  if (cents(ref.amount?.value) !== r.amount_cents) return `refund amount ${ref.amount?.value} is not the full amount (partial refunds are not supported)`;
  return null;
}

async function applyRefundResponse(r: any, ref: any, source: 'refund_response'): Promise<AdminRefundResult> {
  const row = refundRow(r.id);
  const why = refundMismatch(r, row, ref);
  if (why) {
    recordEvidence(r, 'refund_mismatch', { source, refundId: ref?.id ?? null, captureId: r.paypal_capture_id, status: ref?.status ?? null, note: why });
    db.prepare("UPDATE refunds SET status='UNKNOWN', last_error=?, updated_at=datetime('now') WHERE request_id=?").run(why.slice(0, 200), r.id);
    return result(r, 'mismatch', `PayPal's refund answer did not match this payment (${why}). Left as REFUND_PENDING for review.`);
  }
  db.prepare("UPDATE refunds SET refund_id=COALESCE(refund_id, ?), paypal_status=?, updated_at=datetime('now') WHERE request_id=?").run(ref.id, ref.status ?? null, r.id);
  if (ref.status === 'FAILED' || ref.status === 'CANCELLED') {
    db.prepare("UPDATE refunds SET status='FAILED', last_error=?, updated_at=datetime('now') WHERE request_id=?").run(`refund ${ref.status}`, r.id);
    backToCaptured(r.id, 'paypal');
    throw new PaymentError('refund_failed', `PayPal reports the refund as ${ref.status}. Nothing was refunded; the payment is still captured.`, 422);
  }
  if (ref.status === 'COMPLETED') {
    recordEvidence(r, 'refund_completed', { source, refundId: ref.id, captureId: r.paypal_capture_id, status: 'COMPLETED', amount: ref.amount.value, currency: ref.amount.currency_code, paypalTime: ref.create_time ?? ref.update_time ?? null });
    db.prepare("UPDATE refunds SET status='COMPLETED', updated_at=datetime('now') WHERE request_id=?").run(r.id);
    markRefunded(fresh(r.id), 'paypal'); // a webhook may already have done this (out of order): accepted, never regressed
  } else {
    db.prepare("UPDATE refunds SET status='PENDING', updated_at=datetime('now') WHERE request_id=?").run(r.id);
  }
  // Read it back from Payments v2.
  const verified = await verifyRefundById(fresh(r.id), ref.id, 'paypal-v2');
  const now = fresh(r.id);
  if (now.state === 'REFUNDED') return result(r, 'refunded', verified === 'verified' ? 'Refunded and confirmed with PayPal.' : 'Refunded (PayPal response). Read-back not confirmed yet.');
  return result(r, 'pending', 'PayPal accepted the refund but has not completed it yet.');
}

/** GET /v2/payments/refunds/{id}: confirm a refund and resolve REFUND_PENDING. Read-only at PayPal. */
async function verifyRefundById(r: any, refundId: string, actor: string): Promise<'verified' | 'pending' | 'failed' | 'mismatch' | 'unknown'> {
  let ref: any;
  try { ref = await paypal.getRefund(refundId); } catch { return 'unknown'; }
  const why = refundMismatch(r, { ...refundRow(r.id), refund_id: refundId }, ref);
  if (why) { recordEvidence(r, 'refund_mismatch', { source: 'payments-v2', refundId, captureId: r.paypal_capture_id, status: ref?.status ?? null, note: why }); return 'mismatch'; }
  db.prepare("UPDATE refunds SET refund_id=COALESCE(refund_id, ?), paypal_status=?, updated_at=datetime('now') WHERE request_id=?").run(refundId, ref.status ?? null, r.id);
  if (ref.status === 'COMPLETED') {
    recordEvidence(r, 'refund_verified', { source: 'payments-v2', refundId, captureId: r.paypal_capture_id, status: 'COMPLETED', amount: ref.amount.value, currency: ref.amount.currency_code, paypalTime: ref.update_time ?? ref.create_time ?? null });
    db.prepare("UPDATE refunds SET status='COMPLETED', updated_at=datetime('now') WHERE request_id=?").run(r.id);
    markRefunded(fresh(r.id), actor);
    return 'verified';
  }
  if (ref.status === 'FAILED' || ref.status === 'CANCELLED') {
    db.prepare("UPDATE refunds SET status='FAILED', last_error=?, updated_at=datetime('now') WHERE request_id=?").run(`refund ${ref.status}`, r.id);
    backToCaptured(r.id, actor);
    return 'failed';
  }
  return 'pending';
}

/** Reconcile a REFUND_PENDING record. Read-only at PayPal (GET refund, else GET capture); never sends a refund. */
export async function reconcileRefund(r: any): Promise<{ outcome: 'refunded' | 'refund_failed' | 'pending' | 'mismatch' | 'unknown' | 'not_applicable'; state: string }> {
  if (r.state !== 'REFUND_PENDING') return { outcome: 'not_applicable', state: r.state };
  const row = refundRow(r.id);
  if (row?.refund_id) {
    const v = await verifyRefundById(r, row.refund_id, 'reconcile');
    const now = fresh(r.id);
    const outcome = v === 'verified' ? 'refunded' : v === 'failed' ? 'refund_failed' : v;
    return { outcome, state: now.state };
  }
  const v2 = await checkCapture(r, r.paypal_capture_id);
  if (v2.result === 'unknown') return { outcome: 'unknown', state: r.state };
  if (v2.result === 'refunded') {
    recordEvidence(r, 'refund_verified', { source: 'payments-v2', captureId: r.paypal_capture_id, status: 'REFUNDED', amount: v2.capture.amount?.value, currency: v2.capture.amount?.currency_code, paypalTime: v2.capture.update_time ?? null });
    if (row) db.prepare("UPDATE refunds SET status='COMPLETED', paypal_status='REFUNDED', updated_at=datetime('now') WHERE request_id=?").run(r.id);
    const now = markRefunded(r, 'reconcile');
    return { outcome: 'refunded', state: now.state };
  }
  if (v2.result === 'partially_refunded') {
    recordEvidence(r, 'refund_mismatch', { source: 'payments-v2', captureId: r.paypal_capture_id, status: 'PARTIALLY_REFUNDED', note: 'PayPal shows a partial refund; only full refunds are supported. Needs manual review.' });
    return { outcome: 'mismatch', state: r.state };
  }
  if (v2.result === 'mismatch' || v2.result === 'not_found') return { outcome: 'mismatch', state: r.state };
  // Capture still COMPLETED: PayPal has not refunded (yet). Stay pending; the admin may retry, which reuses the same key.
  return { outcome: 'pending', state: r.state };
}

// ---------- Signed webhook ----------
/** PAYMENT.CAPTURE.REFUNDED (resource = the refund). Called only for signature-verified, first-seen events. */
export function refundFromWebhook(event: any): string {
  const ref = event?.resource ?? {};
  const capId = refundCaptureId(ref);
  let r: any = null;
  const byRefund = ref.id ? (db.prepare('SELECT request_id FROM refunds WHERE refund_id=?').get(ref.id) as any) : null;
  if (byRefund) r = fresh(byRefund.request_id);
  if (!r && capId) r = db.prepare('SELECT * FROM payment_requests WHERE paypal_capture_id=?').get(capId) as any;
  if (!r && typeof ref.custom_id === 'string') r = fresh(ref.custom_id);
  if (!r) return 'unknown_request';
  if (ref.custom_id && ref.custom_id !== r.id) return 'custom_id_mismatch';
  if (capId && capId !== r.paypal_capture_id) return 'capture_id_mismatch';
  const row = refundRow(r.id);
  if (row?.refund_id && ref.id && row.refund_id !== ref.id) return 'refund_id_mismatch';
  if (ref.amount?.currency_code !== r.currency || cents(ref.amount?.value) !== r.amount_cents) {
    recordEvidence(r, 'refund_mismatch', { source: 'paypal_webhook', refundId: ref.id ?? null, captureId: capId, status: ref.status ?? null, note: 'webhook refund is not the full amount (partial refunds are not supported)' });
    return 'amount_mismatch';
  }
  if (ref.status && ref.status !== 'COMPLETED') return 'no_change';
  if (r.state === 'REFUNDED') {
    if (row && !row.refund_id && ref.id) db.prepare('UPDATE refunds SET refund_id=? WHERE request_id=? AND refund_id IS NULL').run(ref.id, r.id);
    return 'already_refunded';
  }
  if (r.state !== 'CAPTURED' && r.state !== 'REFUND_PENDING') return 'no_change';
  if (row && ref.id) db.prepare("UPDATE refunds SET refund_id=COALESCE(refund_id, ?), status='COMPLETED', paypal_status='COMPLETED', updated_at=datetime('now') WHERE request_id=?").run(ref.id, r.id);
  markRefunded(r, 'paypal-webhook');
  return 'refunded';
}

// ---------- Receipt: lazy Payments v2 capture check ----------
const lastCaptureCheck = new Map<string, number>();
export const CAPTURE_CHECK_MIN_INTERVAL_MS = 60_000;
export function __resetRefundState() { lastCaptureCheck.clear(); inflight.clear(); }

/**
 * Opening a receipt for a captured payment with no Payments v2 evidence yet reads GET /v2/payments/captures/{id}
 * (bounded wait, at most once a minute per payment) so the timeline shows PayPal's own capture status.
 * If PayPal shows the capture REFUNDED (e.g. refunded in PayPal and the webhook was lost) the record follows PayPal.
 */
export async function ensureCaptureVerified(r: any, timeoutMs = 3000) {
  if (!r?.paypal_capture_id || !['CAPTURED', 'REFUND_PENDING', 'REFUNDED'].includes(r.state)) return;
  if (evidenceRows(r.id, 'capture_verified').some((e) => e.captureId === r.paypal_capture_id)) return;
  const last = lastCaptureCheck.get(r.id) ?? 0;
  if (Date.now() - last < CAPTURE_CHECK_MIN_INTERVAL_MS) return;
  lastCaptureCheck.set(r.id, Date.now());
  try {
    const v2 = await checkCapture(r, r.paypal_capture_id, { timeoutMs });
    if (v2.result === 'refunded' && r.state === 'CAPTURED') {
      recordEvidence(r, 'refund_verified', { source: 'payments-v2', captureId: r.paypal_capture_id, status: 'REFUNDED', amount: v2.capture.amount?.value, currency: v2.capture.amount?.currency_code, paypalTime: v2.capture.update_time ?? null });
      markRefunded(fresh(r.id), 'reconcile');
    }
  } catch { /* the receipt must still load */ }
}
