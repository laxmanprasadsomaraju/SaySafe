/**
 * On-demand reconciliation with PayPal. Covers a lost redirect, a lost webhook, a capture whose
 * response never arrived, and a server restart (the PayPal order is the source of truth).
 *
 * Rules (never relaxed here):
 *  - It only READS PayPal (GET /v2/checkout/orders/:id, GET /v2/payments/captures/:id, GET /v2/payments/refunds/:id).
 *    It never creates, captures or refunds.
 *  - It only acts on an existing local record that already has a paypal_order_id. A missing local record
 *    never leads to a capture (ReturnGate stays read-only).
 *  - COMPLETED is recorded as CAPTURED only when custom_id, amount and currency all match the local record AND
 *    Payments v2 (GET /v2/payments/captures/:id) confirms the capture id, status, amount and currency
 *    (evidence source 'payments-v2'). If Payments v2 cannot be reached the outcome is 'unknown' (no change).
 *  - REFUND_PENDING (a refund whose outcome was unknown) is resolved from GET refund / GET capture (refund.ts).
 *  - APPROVED moves PAYER_APPROVAL_PENDING -> PAYER_APPROVED (buyer approved) but does NOT capture:
 *    capture happens only on the user's explicit confirm, which repeats every check and family approval.
 *  - VOIDED (or an expired order PayPal no longer knows, long after creation, before any capture) -> CANCELLED.
 *  - Network error / timeout / PayPal 5xx: change nothing, return 'unknown'.
 */
import { db, audit } from '../db/index.js';
import * as paypal from '../paypal/client.js';
import { load, loadActionable, assertNotSample, transition, publicView, PaymentError, confirmAndCapture } from './service.js';
import { recordEvidence } from './evidence.js';
import { checkCapture } from './captureCheck.js';
import { reconcileRefund } from './refund.js';
import type { PaymentState } from './stateMachine.js';

export type ReconcileOutcome =
  | 'captured' | 'buyer_approved' | 'cancelled' | 'pending' | 'no_change' | 'mismatch' | 'unknown' | 'not_applicable' | 'throttled'
  | 'refunded' | 'refund_failed';

export const RECONCILABLE: PaymentState[] = ['PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'CAPTURE_PENDING', 'REFUND_PENDING'];
/** PayPal deletes unapproved orders after ~3 hours (approved ones later). Only then is a 404 treated as "expired". */
const EXPIRED_AFTER_MS = 3 * 60 * 60 * 1000;
export const STALE_AFTER_MS = 2 * 60 * 1000;

const sqliteMs = (t: string) => Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
const cents = (v: unknown) => Math.round(Number(v) * 100);

function fresh(r: any) { return db.prepare('SELECT * FROM payment_requests WHERE id=?').get(r.id) as any; }

/** Step through the legal path; an optimistic-lock conflict means someone else moved it first: stop, never regress. */
function stepTo(r: any, path: PaymentState[], extraForLast: Record<string, unknown> = {}) {
  let cur = r;
  // Start after the current state when it is already on the path (e.g. CAPTURE_PENDING -> CAPTURED skips the earlier steps).
  for (let i = path.indexOf(cur.state) + 1; i < path.length; i++) {
    try {
      cur = transition(cur, path[i], 'reconcile', i === path.length - 1 ? extraForLast : {});
    } catch (e) {
      if (e instanceof PaymentError && e.code === 'conflict') return fresh(r);
      throw e;
    }
  }
  return cur;
}

export async function reconcile(requestId: string, opts: { householdId?: string } = {}): Promise<{ outcome: ReconcileOutcome; state: PaymentState }> {
  const r = opts.householdId ? load(requestId, opts.householdId) : (db.prepare('SELECT * FROM payment_requests WHERE id=?').get(requestId) as any);
  if (!r) throw new PaymentError('not_found', 'Payment request not found.', 404);
  assertNotSample(r);
  if (!RECONCILABLE.includes(r.state) || !r.paypal_order_id) return { outcome: 'not_applicable', state: r.state };
  if (r.state === 'REFUND_PENDING') {
    const out = await reconcileRefund(r);
    return { outcome: out.outcome === 'not_applicable' ? 'no_change' : out.outcome, state: out.state as PaymentState };
  }

  let order: any;
  try {
    order = await paypal.getOrder(r.paypal_order_id);
  } catch (e: any) {
    const gone = e?.status === 404 && r.state !== 'CAPTURE_PENDING' && Date.now() - sqliteMs(r.created_at) > EXPIRED_AFTER_MS;
    if (gone) {
      const now = stepTo(r, ['CANCELLED']);
      audit(r.household_id, 'reconcile', 'reconcile.expired', r.id, { orderId: r.paypal_order_id });
      return { outcome: now.state === 'CANCELLED' ? 'cancelled' : 'no_change', state: now.state };
    }
    return { outcome: 'unknown', state: r.state }; // network / 5xx / unexpected: change nothing
  }
  if (!order || typeof order !== 'object') return { outcome: 'unknown', state: r.state };

  const pu = order.purchase_units?.[0];
  const orderMatches = pu?.custom_id === r.id && pu?.amount?.currency_code === r.currency && cents(pu?.amount?.value) === r.amount_cents && (!order.id || order.id === r.paypal_order_id);
  const mismatch = (why: string) => {
    recordEvidence(r, 'reconcile_mismatch', { source: 'reconcile', note: why, paypalTime: order.update_time ?? null });
    return { outcome: 'mismatch' as const, state: r.state as PaymentState };
  };

  switch (order.status) {
    case 'COMPLETED': {
      if (!orderMatches) return mismatch('order custom_id/amount/currency differ from the local record');
      const caps: any[] = pu?.payments?.captures ?? [];
      const cap = caps.find((c) => c?.status === 'COMPLETED') ?? caps[0];
      if (!cap) return { outcome: 'pending', state: r.state };
      if (cents(cap.amount?.value) !== r.amount_cents || cap.amount?.currency_code !== r.currency || (cap.custom_id && cap.custom_id !== r.id)) {
        return mismatch('capture amount/currency/custom_id differ from the local record');
      }
      if (r.state === 'CAPTURED') return { outcome: 'no_change', state: r.state };
      // Payments v2 is the authority on the capture itself: confirm id, status, amount and currency before recording money.
      const v2 = await checkCapture(r, cap.id);
      if (v2.result === 'unknown') return { outcome: 'unknown', state: r.state };
      if (v2.result === 'not_found' || v2.result === 'mismatch') return { outcome: 'mismatch', state: r.state };
      if (v2.result === 'pending' || v2.result === 'other') {
        // Capture exists but PayPal is still processing it (e.g. PENDING): money is in flight, nothing more to do yet.
        const now = stepTo(r, ['PAYER_APPROVED', 'CAPTURE_PENDING']);
        return { outcome: 'pending', state: now.state };
      }
      const c = v2.capture;
      recordEvidence(r, 'capture', { source: 'reconcile', captureId: c.id, amount: c.amount.value, currency: c.amount.currency_code, paypalTime: c.create_time ?? cap.create_time ?? c.update_time ?? null });
      let now = stepTo(r, ['PAYER_APPROVED', 'CAPTURE_PENDING', 'CAPTURED'], {
        paypal_capture_id: c.id, captured_amount: c.amount.value, captured_currency: c.amount.currency_code,
        payee_name: r.payee_name ?? pu?.payee?.display_name ?? r.merchant,
      });
      if (now.state !== 'CAPTURED') return { outcome: 'no_change', state: now.state };
      if (v2.result === 'refunded') {
        // Captured and since fully refunded at PayPal (e.g. our capture response and both webhooks were lost).
        recordEvidence(r, 'refund_verified', { source: 'payments-v2', captureId: c.id, status: 'REFUNDED', amount: c.amount.value, currency: c.amount.currency_code, paypalTime: c.update_time ?? null });
        now = stepTo(now, ['REFUNDED']);
        return { outcome: now.state === 'REFUNDED' ? 'refunded' : 'captured', state: now.state };
      }
      if (v2.result === 'partially_refunded') {
        recordEvidence(r, 'refund_mismatch', { source: 'payments-v2', captureId: c.id, status: 'PARTIALLY_REFUNDED', note: 'PayPal shows a partial refund; only full refunds are supported. Needs manual review.' });
      }
      return { outcome: 'captured', state: now.state };
    }
    case 'APPROVED': {
      if (!orderMatches) return mismatch('order custom_id/amount/currency differ from the local record');
      if (r.state !== 'PAYER_APPROVAL_PENDING') return { outcome: 'no_change', state: r.state };
      recordEvidence(r, 'buyer_approved', { source: 'reconcile', paypalTime: order.update_time ?? null });
      const now = stepTo(r, ['PAYER_APPROVED']); // buyer approved; NO capture here
      return { outcome: now.state === 'PAYER_APPROVED' ? 'buyer_approved' : 'no_change', state: now.state };
    }
    case 'VOIDED': {
      const now = stepTo(r, ['CANCELLED']);
      if (now.state === 'CANCELLED') db.prepare("UPDATE approvals SET status='invalidated' WHERE request_id=? AND status='pending'").run(r.id);
      return { outcome: now.state === 'CANCELLED' ? 'cancelled' : 'no_change', state: now.state };
    }
    default: // CREATED, SAVED, PAYER_ACTION_REQUIRED: buyer has not finished at PayPal yet
      return { outcome: 'pending', state: r.state };
  }
}

// ---------- Rate limiting (in-memory, per process; fine for one free instance) ----------
const lastByRequest = new Map<string, number>();
const lastByHousehold = new Map<string, number>();
export const RECONCILE_MIN_INTERVAL_MS = 5_000;
export const SWEEP_MIN_INTERVAL_MS = 60_000;
export function __resetReconcileThrottle() { lastByRequest.clear(); lastByHousehold.clear(); }

/** Used by the Order page (on load and by the "Check with PayPal" button). At most one PayPal read per request per 5 s. */
export async function reconcileForUser(householdId: string, requestId: string) {
  const r = loadActionable(requestId, householdId); // household scoping: 404 for anyone else's request; 409 for a sample row
  const last = lastByRequest.get(r.id) ?? 0;
  let outcome: ReconcileOutcome = 'throttled';
  if (Date.now() - last >= RECONCILE_MIN_INTERVAL_MS || !RECONCILABLE.includes(r.state)) {
    lastByRequest.set(r.id, Date.now());
    outcome = (await reconcile(r.id, { householdId })).outcome;
  }
  return { outcome, request: publicView(load(r.id, householdId)) };
}

/**
 * Lazy sweep: when an elder or family member opens their dashboard, reconcile this household's
 * pending records that have not changed for 2 minutes. At most once a minute per household and
 * at most 5 records per sweep. Errors are swallowed (the dashboard must still load).
 */
export async function sweepHousehold(householdId: string, now = Date.now()) {
  const last = lastByHousehold.get(householdId) ?? 0;
  if (now - last < SWEEP_MIN_INTERVAL_MS) return { swept: 0, skipped: true as const };
  lastByHousehold.set(householdId, now);
  const cutoff = new Date(now - STALE_AFTER_MS).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(
    `SELECT id FROM payment_requests WHERE household_id=? AND example=0 AND paypal_order_id IS NOT NULL AND state IN ('PAYER_APPROVAL_PENDING','PAYER_APPROVED','CAPTURE_PENDING','REFUND_PENDING') AND updated_at < ? ORDER BY updated_at ASC LIMIT 5`,
  ).all(householdId, cutoff) as { id: string }[];
  const outcomes: Record<string, ReconcileOutcome> = {};
  for (const row of rows) {
    try { outcomes[row.id] = (await reconcile(row.id, { householdId })).outcome; } catch { outcomes[row.id] = 'unknown'; }
  }
  return { swept: rows.length, skipped: false as const, outcomes };
}

/** Bounded wait so a slow PayPal never blocks a dashboard for long. */
export async function sweepWithin(householdId: string, ms = 4000) {
  const p = sweepHousehold(householdId).catch(() => null);
  await Promise.race([p, new Promise((res) => setTimeout(res, ms).unref?.())]);
}

/** Explicit "finish payment" for a buyer-approved record (e.g. after a lost redirect). Re-runs every check via confirmAndCapture. */
export async function finishApproved(householdId: string, actor: string, requestId: string) {
  const r = loadActionable(requestId, householdId);
  if (!['PAYER_APPROVED', 'CAPTURE_PENDING', 'PAYER_APPROVAL_PENDING'].includes(r.state) || !r.paypal_order_id) {
    throw new PaymentError('bad_state', 'There is nothing to finish for this purchase.', 409);
  }
  return confirmAndCapture(householdId, actor, requestId, r.paypal_order_id);
}
