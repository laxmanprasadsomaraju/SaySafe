/**
 * Payment requests: AI interprets -> rules evaluate -> family approves (if needed) -> payer authorises at PayPal
 * -> backend verifies with PayPal and captures. Every state change is server-side, versioned and audited.
 */
import crypto from 'node:crypto';
import { db, audit, isUniqueViolation } from '../db/index.js';
import { newId } from '../auth.js';
import { getProduct, DEMO_MERCHANT } from '../catalogue/products.js';
import { assertTransition, type PaymentState } from './stateMachine.js';
import * as paypal from '../paypal/client.js';
import { recordEvidence } from './evidence.js';

export const HARD_LIMIT_CENTS = 50000; // demo safety cap: €500
export const APPROVAL_TTL_MS = 1000 * 60 * 30;
const CURRENCY = 'EUR';

export interface CartLine { productId: string; quantity: number }
export interface PricedLine { productId: string; name: string; unitCents: number; quantity: number; lineCents: number; image: string }

export class PaymentError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/** Prices always come from the server catalogue, never from the client or the AI. */
export function priceCart(lines: CartLine[]) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 10) throw new PaymentError('bad_cart', 'Your basket is empty or too large.');
  const priced: PricedLine[] = lines.map((l) => {
    const p = getProduct(String(l.productId));
    const q = Math.trunc(Number(l.quantity));
    if (!p) throw new PaymentError('unknown_product', 'That item is not in the shop.');
    if (!(q >= 1 && q <= 5)) throw new PaymentError('bad_quantity', 'Please choose between 1 and 5 of each item.');
    return { productId: p.id, name: p.name, unitCents: p.priceCents, quantity: q, lineCents: p.priceCents * q, image: p.image };
  });
  const total = priced.reduce((s, l) => s + l.lineCents, 0);
  return { lines: priced, totalCents: total, currency: CURRENCY, merchant: DEMO_MERCHANT };
}

/** Binds approvals to the exact basket, amount, currency and merchant. Any change -> new fingerprint. */
export function fingerprint(q: { lines: PricedLine[]; totalCents: number; currency: string; merchant: string }) {
  const canon = JSON.stringify({ l: q.lines.map((l) => [l.productId, l.unitCents, l.quantity]).sort(), t: q.totalCents, c: q.currency, m: q.merchant });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

export function getPolicy(householdId: string) {
  return db.prepare('SELECT approval_threshold_cents AS thresholdCents, currency FROM spending_policies WHERE household_id=?').get(householdId) as { thresholdCents: number; currency: string };
}

export function setThreshold(householdId: string, cents: number, actor: string) {
  if (!Number.isInteger(cents) || cents < 0 || cents > HARD_LIMIT_CENTS) throw new PaymentError('bad_threshold', 'Limit must be between €0 and €500.');
  db.prepare("UPDATE spending_policies SET approval_threshold_cents=?, updated_by=?, updated_at=datetime('now') WHERE household_id=?").run(cents, actor, householdId);
  audit(householdId, actor, 'policy.threshold_changed', undefined, { cents });
}

export function load(id: string, householdId: string) {
  const r = db.prepare('SELECT * FROM payment_requests WHERE id=? AND household_id=?').get(id, householdId) as any;
  if (!r) throw new PaymentError('not_found', 'Payment request not found.', 404);
  return r;
}

/** Optimistic-locked transition. Fails if someone else changed the row first (replay / double-click safe). */
export function transition(r: any, to: PaymentState, actor: string, extra: Record<string, unknown> = {}) {
  assertTransition(r.state, to);
  const sets = ['state=?', 'version=version+1', "updated_at=datetime('now')", ...Object.keys(extra).map((k) => `${k}=?`)];
  let info;
  try {
    info = db.prepare(`UPDATE payment_requests SET ${sets.join(', ')} WHERE id=? AND version=? AND state=?`).run(to, ...Object.values(extra), r.id, r.version, r.state);
  } catch (e) {
    // paypal_order_id / paypal_capture_id are UNIQUE: the same PayPal id can never be attached to two requests.
    if (isUniqueViolation(e)) throw new PaymentError('conflict', 'This PayPal payment is already linked to another purchase.', 409);
    throw e;
  }
  if (info.changes !== 1) throw new PaymentError('conflict', 'This payment changed while we were working. Please refresh.', 409);
  audit(r.household_id, actor, `payment.${r.state}->${to}`, r.id, extra);
  return { ...r, ...extra, state: to, version: r.version + 1 };
}

export interface RiskOutcome { ok: boolean; needsFamily: boolean; reasons: string[] }

export function riskReview(householdId: string, q: ReturnType<typeof priceCart>): RiskOutcome {
  const reasons: string[] = [];
  if (q.merchant !== DEMO_MERCHANT) reasons.push('Unknown merchant.');
  if (q.currency !== CURRENCY) reasons.push('Unexpected currency.');
  if (q.totalCents <= 0) reasons.push('Invalid amount.');
  if (q.totalCents > HARD_LIMIT_CENTS) reasons.push('Above the €500 safety cap for this demo.');
  const recent = (db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE household_id=? AND created_at > datetime('now','-10 minutes')").get(householdId) as any).n;
  if (recent >= 8) reasons.push('Too many payment attempts in a short time.');
  if (reasons.length) return { ok: false, needsFamily: false, reasons };
  const policy = getPolicy(householdId);
  const needsFamily = q.totalCents > policy.thresholdCents;
  return { ok: true, needsFamily, reasons: needsFamily ? [`Above your protected limit of €${(policy.thresholdCents / 100).toFixed(2)}.`] : [] };
}

export function publicView(r: any) {
  const approval = db.prepare('SELECT id, status, expires_at, decided_at, reason FROM approvals WHERE request_id=? ORDER BY created_at DESC LIMIT 1').get(r.id) as any;
  return {
    id: r.id,
    state: r.state as PaymentState,
    items: JSON.parse(r.items_json),
    merchant: r.merchant,
    amountCents: r.amount_cents,
    currency: r.currency,
    risk: r.risk_json ? JSON.parse(r.risk_json) : null,
    approval: approval ? { id: approval.id, status: effectiveApprovalStatus(approval), expiresAt: approval.expires_at, decidedAt: approval.decided_at, reason: approval.reason } : null,
    receipt: r.state === 'CAPTURED' || r.state === 'REFUND_PENDING' || r.state === 'REFUNDED' ? { captureId: r.paypal_capture_id, amount: r.captured_amount, currency: r.captured_currency, payee: r.payee_name, orderId: r.paypal_order_id, webhookConfirmed: Boolean(r.paypal_capture_id && db.prepare("SELECT 1 FROM webhook_events WHERE resource_id=? AND event_type='PAYMENT.CAPTURE.COMPLETED' AND verified=1").get(r.paypal_capture_id)) } : null,
    refund: refundView(r),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const REFUND_REQUEST_LABEL = 'Request sent — not refunded yet';

/**
 * What the buyer sees about refunds. A buyer request (REFUND_REQUESTED) is only a request: it is labelled as such
 * and never shown as a refund. Only the payment state REFUNDED (set from PayPal's own answer) means money went back.
 */
export function refundView(r: any) {
  const req = db.prepare('SELECT status, created_at FROM refund_requests WHERE request_id=?').get(r.id) as { status: string; created_at: string } | undefined;
  const ex = db.prepare('SELECT status, refund_id FROM refunds WHERE request_id=?').get(r.id) as { status: string; refund_id: string | null } | undefined;
  const status = r.state === 'REFUNDED' ? 'REFUNDED' : r.state === 'REFUND_PENDING' ? 'REFUND_PENDING' : req ? 'REFUND_REQUESTED' : null;
  if (!status && r.state !== 'CAPTURED') return null;
  return {
    status,
    label: status === 'REFUNDED' ? 'Refunded by the Demo Shop (PayPal Sandbox — no real money)'
      : status === 'REFUND_PENDING' ? 'Refund sent to PayPal — waiting for PayPal to confirm'
      : status === 'REFUND_REQUESTED' ? REFUND_REQUEST_LABEL : null,
    requestedAt: req?.created_at ?? null,
    canRequest: r.state === 'CAPTURED' && !req,
    refundId: r.state === 'REFUNDED' ? ex?.refund_id ?? null : null,
    lastAttemptFailed: r.state === 'CAPTURED' && ex?.status === 'FAILED',
  };
}

function effectiveApprovalStatus(a: any) {
  return a.status === 'pending' && a.expires_at < Date.now() ? 'expired' : a.status;
}

/** Step 1: elder confirms the basket. Creates the request, runs risk + policy. */
export async function createRequest(householdId: string, actor: string, lines: CartLine[], idempotencyKey: string, origin: string) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) throw new PaymentError('bad_idempotency_key', 'Missing request key.');
  const existing = db.prepare('SELECT * FROM payment_requests WHERE idempotency_key=?').get(idempotencyKey) as any;
  if (existing) {
    if (existing.household_id !== householdId) throw new PaymentError('conflict', 'Request key already used.', 409);
    return { request: publicView(existing), approveUrl: null as string | null };
  }
  const q = priceCart(lines);
  const id = newId('pay');
  const fp = fingerprint(q);
  try {
    db.prepare('INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, householdId, 'DRAFT', JSON.stringify(q.lines), q.merchant, q.totalCents, q.currency, fp, idempotencyKey);
  } catch (e) {
    // Lost a race on the same idempotency key (e.g. two instances, or a retried request): return the winner.
    if (!isUniqueViolation(e)) throw e;
    const winner = db.prepare('SELECT * FROM payment_requests WHERE idempotency_key=?').get(idempotencyKey) as any;
    if (!winner || winner.household_id !== householdId) throw new PaymentError('conflict', 'Request key already used.', 409);
    return { request: publicView(winner), approveUrl: null as string | null };
  }
  audit(householdId, actor, 'payment.created', id, { total: q.totalCents });
  let r = load(id, householdId);
  r = transition(r, 'RISK_REVIEW', actor);
  const risk = riskReview(householdId, q);
  db.prepare('UPDATE payment_requests SET risk_json=? WHERE id=?').run(JSON.stringify(risk), id);
  if (!risk.ok) {
    r = transition(r, 'BLOCKED', 'policy');
    return { request: publicView(load(id, householdId)), approveUrl: null };
  }
  if (risk.needsFamily) {
    r = transition(r, 'FAMILY_APPROVAL_PENDING', 'policy');
    db.prepare('INSERT INTO approvals (id, request_id, fingerprint, status, nonce, expires_at) VALUES (?,?,?,?,?,?)')
      .run(newId('apr'), id, fp, 'pending', crypto.randomBytes(16).toString('hex'), Date.now() + APPROVAL_TTL_MS);
    audit(householdId, 'policy', 'approval.requested', id);
    return { request: publicView(load(id, householdId)), approveUrl: null };
  }
  const approveUrl = await startPayPalCheckout(householdId, actor, id, origin);
  return { request: publicView(load(id, householdId)), approveUrl };
}

/** Is there a valid family approval bound to this exact request fingerprint? */
export function hasValidApproval(r: any): boolean {
  const a = db.prepare("SELECT * FROM approvals WHERE request_id=? AND status='approved' ORDER BY decided_at DESC LIMIT 1").get(r.id) as any;
  if (!a) return false;
  if (a.fingerprint !== r.fingerprint) return false;
  // Re-price from the catalogue: if prices changed since approval, the approval no longer applies.
  const q = priceCart(JSON.parse(r.items_json).map((l: PricedLine) => ({ productId: l.productId, quantity: l.quantity })));
  return fingerprint(q) === a.fingerprint && q.totalCents === r.amount_cents;
}

/** Family decision. Only an active family member of the same household. Nonce prevents replay. */
export function decide(householdId: string, familyId: string, requestId: string, approvalId: string, decision: 'approve' | 'decline', reason?: string) {
  const r = load(requestId, householdId);
  const a = db.prepare('SELECT * FROM approvals WHERE id=? AND request_id=?').get(approvalId, requestId) as any;
  if (!a) throw new PaymentError('not_found', 'Approval not found.', 404);
  if (a.status !== 'pending') throw new PaymentError('already_decided', 'This request was already decided.', 409);
  if (a.expires_at < Date.now()) {
    db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(a.id);
    throw new PaymentError('expired', 'This request has expired.', 410);
  }
  if (a.fingerprint !== r.fingerprint) {
    db.prepare("UPDATE approvals SET status='invalidated' WHERE id=?").run(a.id);
    throw new PaymentError('changed', 'The purchase changed after the request was sent.', 409);
  }
  const status = decision === 'approve' ? 'approved' : 'declined';
  const info = db.prepare("UPDATE approvals SET status=?, decided_by=?, reason=?, decided_at=datetime('now'), nonce=? WHERE id=? AND status='pending' AND nonce=?")
    .run(status, familyId, (reason ?? '').slice(0, 200) || null, crypto.randomBytes(16).toString('hex'), a.id, a.nonce);
  if (info.changes !== 1) throw new PaymentError('conflict', 'Already decided.', 409);
  if (status === 'approved') transition(r, 'FAMILY_APPROVED', familyId);
  else transition(r, 'CANCELLED', familyId, {});
  audit(householdId, familyId, `approval.${status}`, requestId);
  return publicView(load(requestId, householdId));
}

/** Creates the PayPal order and moves to PAYER_APPROVAL_PENDING. Family approval does NOT pay: the payer still approves at PayPal. */
export async function startPayPalCheckout(householdId: string, actor: string, requestId: string, origin: string) {
  let r = load(requestId, householdId);
  if (r.state === 'FAMILY_APPROVED' && !hasValidApproval(r)) throw new PaymentError('approval_invalid', 'The family approval no longer matches this purchase.', 409);
  if (r.state !== 'RISK_REVIEW' && r.state !== 'FAMILY_APPROVED') {
    if (r.state === 'PAYER_APPROVAL_PENDING' && r.paypal_order_id) {
      const order = await paypal.getOrder(r.paypal_order_id);
      return paypal.approveLink(order);
    }
    throw new PaymentError('bad_state', `Cannot start checkout from ${r.state}.`, 409);
  }
  const items = JSON.parse(r.items_json) as PricedLine[];
  const order = await paypal.createOrder({
    requestId: r.id,
    currency: r.currency,
    brandName: 'SaySafe Demo Shop',
    items: items.map((i) => ({ name: i.name, unitAmountCents: i.unitCents, quantity: i.quantity, sku: i.productId })),
    returnUrl: `${origin}/checkout/return?rid=${encodeURIComponent(r.id)}`,
    cancelUrl: `${origin}/checkout/cancel?rid=${encodeURIComponent(r.id)}`,
  });
  r = transition(r, 'PAYER_APPROVAL_PENDING', actor, { paypal_order_id: order.id });
  const link = paypal.approveLink(order);
  if (!link) throw new PaymentError('paypal_no_link', 'PayPal did not return an approval link.', 502);
  return link;
}

/** Called after PayPal redirects back. Never trusts the redirect: re-reads the order from PayPal, re-checks policy, then captures. */
export async function confirmAndCapture(householdId: string, actor: string, requestId: string, orderIdFromRedirect: string) {
  let r = load(requestId, householdId);
  if (!r.paypal_order_id || r.paypal_order_id !== orderIdFromRedirect) throw new PaymentError('order_mismatch', 'This PayPal order does not belong to this purchase.', 409);
  if (r.state === 'CAPTURED') return publicView(r);
  const order = await paypal.getOrder(r.paypal_order_id);
  const pu = order?.purchase_units?.[0];
  const value = Math.round(Number(pu?.amount?.value) * 100);
  if (pu?.custom_id !== r.id || pu?.amount?.currency_code !== r.currency || value !== r.amount_cents) {
    if (r.state === 'PAYER_APPROVAL_PENDING') transition(r, 'FAILED', 'policy');
    throw new PaymentError('tampered', 'The PayPal order does not match the approved purchase.', 409);
  }
  if (r.state === 'PAYER_APPROVAL_PENDING') {
    if (order.status !== 'APPROVED') throw new PaymentError('not_approved', 'PayPal has not confirmed your approval yet.', 409);
    r = transition(r, 'PAYER_APPROVED', actor);
  }
  // Re-check policy right before money moves.
  const risk = JSON.parse(r.risk_json ?? '{}');
  if (risk.needsFamily && !hasValidApproval(r)) throw new PaymentError('approval_invalid', 'Family approval is missing or no longer valid.', 403);
  if (r.state === 'PAYER_APPROVED') r = transition(r, 'CAPTURE_PENDING', 'system');
  if (r.state !== 'CAPTURE_PENDING') throw new PaymentError('bad_state', `Cannot capture from ${r.state}.`, 409);
  try {
    const cap = await paypal.captureOrder(r.paypal_order_id, r.id);
    return applyCaptureResult(r, cap);
  } catch (e: any) {
    // ORDER_ALREADY_CAPTURED etc: reconcile from PayPal rather than guessing.
    const latest = await paypal.getOrder(r.paypal_order_id).catch(() => null);
    if (latest?.status === 'COMPLETED') return applyCaptureResult(load(requestId, householdId), latest);
    if (e?.data?.details?.[0]?.issue === 'INSTRUMENT_DECLINED') throw new PaymentError('declined', 'PayPal declined this payment method. You can try again with another one.', 402);
    // Timeout, dropped connection or PayPal 5xx: the outcome is unknown, not failed. Stay CAPTURE_PENDING;
    // a later confirm re-sends the same PayPal-Request-Id, so PayPal can never capture twice.
    if (paypal.isUnknownOutcome(e)) throw new PaymentError('outcome_unknown', 'PayPal has not answered yet. You will not be charged twice. Check again in a moment.', 503);
    transition(load(requestId, householdId), 'FAILED', 'system', {});
    throw new PaymentError('capture_failed', 'The payment did not go through. No money was taken.', 502);
  }
}

function applyCaptureResult(r: any, orderOrCapture: any) {
  const capture = orderOrCapture?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture || capture.status !== 'COMPLETED') {
    // PENDING captures stay CAPTURE_PENDING until the webhook confirms.
    return publicView(r);
  }
  const amt = Math.round(Number(capture.amount?.value) * 100);
  if (amt !== r.amount_cents || capture.amount?.currency_code !== r.currency) throw new PaymentError('amount_mismatch', 'Captured amount differs from approved amount.', 500);
  // Name the merchant as PayPal reports it; the sandbox business account has no display name, so fall back to our shop name.
  const payee = orderOrCapture?.purchase_units?.[0]?.payee?.display_name ?? r.merchant;
  recordEvidence(r, 'capture', { source: 'capture_response', captureId: capture.id, amount: capture.amount.value, currency: capture.amount.currency_code, paypalTime: capture.create_time ?? capture.update_time ?? null });
  if (r.state === 'CAPTURE_PENDING') {
    try {
      transition(r, 'CAPTURED', 'paypal', { paypal_capture_id: capture.id, captured_amount: capture.amount.value, captured_currency: capture.amount.currency_code, payee_name: payee });
    } catch (e) {
      // Out of order: the signed webhook (or a reconcile) recorded this same capture first. Never regress; accept it.
      const now = load(r.id, r.household_id);
      if (!(e instanceof PaymentError && e.code === 'conflict' && now.state === 'CAPTURED' && now.paypal_capture_id === capture.id)) throw e;
    }
  }
  return publicView(load(r.id, r.household_id));
}

/** Webhook reconciliation (deduped by event id). */
export function reconcileFromWebhook(event: any) {
  const type = event?.event_type;
  const res = event?.resource;
  const requestId = res?.custom_id ?? res?.purchase_units?.[0]?.custom_id;
  if (!requestId) return 'ignored';
  const r = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(requestId) as any;
  if (!r) return 'unknown_request';
  // Correlate: a capture event must belong to the PayPal order we created for this request.
  const orderId = res?.supplementary_data?.related_ids?.order_id;
  if (type?.startsWith('PAYMENT.CAPTURE.') && orderId && r.paypal_order_id && orderId !== r.paypal_order_id) return 'order_mismatch';
  if (type === 'PAYMENT.CAPTURE.COMPLETED' && r.state === 'CAPTURED') {
    return r.paypal_capture_id === res?.id ? 'already_captured' : 'capture_id_mismatch';
  }
  if (type === 'PAYMENT.CAPTURE.COMPLETED' && r.state === 'CAPTURE_PENDING') {
    const amt = Math.round(Number(res.amount?.value) * 100);
    if (amt !== r.amount_cents || res.amount?.currency_code !== r.currency) return 'amount_mismatch';
    transition(r, 'CAPTURED', 'paypal-webhook', { paypal_capture_id: res.id, captured_amount: res.amount.value, captured_currency: res.amount.currency_code, payee_name: r.payee_name ?? 'SaySafe Demo Shop (sandbox)' });
    return 'captured';
  }
  if ((type === 'PAYMENT.CAPTURE.DENIED' || type === 'PAYMENT.CAPTURE.DECLINED') && r.state === 'CAPTURE_PENDING') {
    transition(r, 'FAILED', 'paypal-webhook');
    return 'failed';
  }
  // PAYMENT.CAPTURE.REFUNDED is handled by refund.ts (refundFromWebhook), which correlates by refund id / capture id.
  return 'no_change';
}

export function cancelRequest(householdId: string, actor: string, requestId: string) {
  const r = load(requestId, householdId);
  transition(r, 'CANCELLED', actor);
  db.prepare("UPDATE approvals SET status='invalidated' WHERE request_id=? AND status='pending'").run(requestId);
  return publicView(load(requestId, householdId));
}

export function listRequests(householdId: string, limit = 20) {
  return (db.prepare('SELECT * FROM payment_requests WHERE household_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(householdId, limit) as any[]).map(publicView);
}
