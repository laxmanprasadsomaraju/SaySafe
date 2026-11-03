/**
 * SaySafe Demo Membership: a real PayPal SANDBOX subscription (€2.99/month) to SaySafe Demo Shop.
 * This is the only subscription SaySafe can cancel, because SaySafe is the merchant.
 *
 *  - start:          creates the PayPal subscription (custom_id = household) and returns PayPal's approve link.
 *                    The user approves on PayPal. The PayPal-Request-Id is our row id, written before the call.
 *  - refresh:        GET from PayPal; the status shown is always PayPal's.
 *  - cancel-intent:  short-lived, single-use token + exact confirmation text. The assistant may create this card.
 *  - cancel:         only with that token, from the elder's session (a tap). Calls PayPal cancel, then GETs the
 *                    subscription and only sets provider_confirmed (confirmed_by paypal_api) when PayPal says CANCELLED.
 *                    4xx/5xx/timeout -> retry_needed (a new tap is needed). Already cancelled -> idempotent after GET.
 *  - webhook:        signed BILLING.SUBSCRIPTION.* events update PayPal status (verified like capture webhooks).
 */
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { newId, sha } from '../auth.js';
import { createSubscription, getSubscription as ppGet, cancelSubscription as ppCancel, subscriptionApproveLink, paypalConfigured } from '../paypal/client.js';
import { CompanionError, getSubscription, subView } from './store.js';
import { DEMO_MEMBERSHIP, CANCELLATION_SCOPE, type SubscriptionT } from '../../shared/companion.js';

export const demoPlanId = () => process.env.PAYPAL_DEMO_PLAN_ID?.trim() || null;
export const demoConfigured = () => Boolean(paypalConfigured() && demoPlanId());

const LIVE = ['APPROVAL_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED'];
const rowFor = (hh: string) => db.prepare("SELECT * FROM companion_subscriptions WHERE household_id=? AND source='paypal_sandbox_subscription' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(hh) as any;

function notConfigured(): never {
  throw new CompanionError('demo_not_configured', 'The SaySafe Demo Membership is not set up on this server (PAYPAL_DEMO_PLAN_ID).', 503);
}

export function currentDemo(hh: string): SubscriptionT | null {
  const r = rowFor(hh);
  return r ? subView(r) : null;
}

function applyPayPal(hh: string, id: string, pp: any, via: 'paypal_api' | 'paypal_webhook') {
  const status = String(pp?.status ?? '') || null;
  const next = pp?.billing_info?.next_billing_time ? String(pp.billing_info.next_billing_time).slice(0, 10) : null;
  db.prepare("UPDATE companion_subscriptions SET paypal_status=?, next_on=COALESCE(?, next_on), last_checked_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND household_id=?").run(status, next, id, hh);
  if (status === 'CANCELLED' || status === 'EXPIRED') {
    db.prepare("UPDATE companion_subscriptions SET sub_state='provider_confirmed', confirmed_by=COALESCE(confirmed_by, ?), confirmed_on=COALESCE(confirmed_on, ?), evidence_note=COALESCE(evidence_note, ?), cancel_state='confirmed', cancel_error=NULL WHERE id=? AND household_id=?")
      .run(via, new Date().toISOString().slice(0, 10), `PayPal reports the subscription ${status} (${pp?.status_update_time ?? 'time not given'}).`, id, hh);
  }
}

export async function startDemo(hh: string, owner: string, origin: string): Promise<{ subscription: SubscriptionT; approveUrl: string | null; reused: boolean }> {
  if (!demoConfigured()) notConfigured();
  const existing = rowFor(hh);
  if (existing && existing.sub_state !== 'provider_confirmed' && (!existing.paypal_status || LIVE.includes(existing.paypal_status))) {
    if (existing.paypal_subscription_id) {
      const v = subView(existing);
      return { subscription: v, approveUrl: existing.paypal_status === 'APPROVAL_PENDING' ? existing.paypal_approve_url : null, reused: true };
    }
  }
  const id = existing && !existing.paypal_subscription_id ? existing.id : newId('sub');
  if (!(existing && !existing.paypal_subscription_id)) {
    db.prepare("INSERT INTO companion_subscriptions (id, household_id, owner_id, merchant, amount_cents, currency, billing_cycle, source, memo) VALUES (?,?,?,?,?,?,?,'paypal_sandbox_subscription',?)")
      .run(id, hh, owner, DEMO_MEMBERSHIP.name, DEMO_MEMBERSHIP.amountCents, DEMO_MEMBERSHIP.currency, DEMO_MEMBERSHIP.frequency, 'PayPal sandbox subscription to SaySafe Demo Shop. No real money.');
  }
  const pp = await createSubscription({
    planId: demoPlanId()!, customId: hh, requestId: `saysafe-demo-sub-${id}`, brandName: 'SaySafe Demo Shop',
    returnUrl: `${origin}/api/companion/subscriptions/demo/return`, cancelUrl: `${origin}/api/companion/subscriptions/demo/return?declined=1`,
  });
  const approveUrl = subscriptionApproveLink(pp);
  db.prepare("UPDATE companion_subscriptions SET paypal_subscription_id=?, paypal_status=?, paypal_approve_url=?, last_checked_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND household_id=?")
    .run(String(pp.id), String(pp.status ?? 'APPROVAL_PENDING'), approveUrl, id, hh);
  return { subscription: getSubscription(hh, id), approveUrl, reused: false };
}

/** Read the subscription from PayPal and store what PayPal says. Throttled to one read per 5 seconds per row. */
export async function refreshDemo(hh: string, opts: { force?: boolean } = {}): Promise<SubscriptionT | null> {
  const r = rowFor(hh);
  if (!r?.paypal_subscription_id) return r ? subView(r) : null;
  if (!opts.force && r.last_checked_at && Date.now() - Date.parse(String(r.last_checked_at).replace(' ', 'T') + 'Z') < 5000) return subView(r);
  try {
    const pp = await ppGet(r.paypal_subscription_id);
    if (pp?.custom_id && pp.custom_id !== hh) throw new CompanionError('not_found', 'That subscription was not found.', 404);
    applyPayPal(hh, r.id, pp, 'paypal_api');
  } catch (e) {
    if (e instanceof CompanionError) throw e;
    return subView(r); // PayPal unreachable: keep showing the last status PayPal gave, with its "last checked" time
  }
  return getSubscription(hh, r.id);
}

/** Step 1: confirmation card. Creates a single-use token (hash stored), valid for a few minutes. Never calls PayPal cancel. */
export async function cancelIntent(hh: string): Promise<{ subscriptionId: string; confirmText: string; token: string; expiresAt: string; cancelEndpoint: '/api/companion/subscriptions/demo/cancel'; cancellationScope: typeof CANCELLATION_SCOPE.demo }> {
  if (!demoConfigured()) notConfigured();
  const r = rowFor(hh);
  if (!r?.paypal_subscription_id) throw new CompanionError('no_demo_membership', "You don't have a SaySafe Demo Membership.", 404);
  if (r.sub_state === 'provider_confirmed') throw new CompanionError('already_cancelled', 'PayPal already confirmed this membership is cancelled.', 409);
  if (!['ACTIVE', 'SUSPENDED'].includes(r.paypal_status)) throw new CompanionError('not_active', r.paypal_status === 'APPROVAL_PENDING' ? 'This membership was never approved on PayPal, so there is no billing to cancel.' : 'PayPal does not show this membership as active.', 409);
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + DEMO_MEMBERSHIP.cancelTokenTtlSeconds * 1000;
  db.prepare('DELETE FROM companion_cancel_tokens WHERE household_id=? AND (used_at IS NOT NULL OR expires_at < ?)').run(hh, Date.now());
  db.prepare('INSERT INTO companion_cancel_tokens (token_hash, household_id, subscription_id, expires_at) VALUES (?,?,?,?)').run(sha(token), hh, r.id, expires);
  return { subscriptionId: r.id, confirmText: DEMO_MEMBERSHIP.cancelConfirmText, token, expiresAt: new Date(expires).toISOString(), cancelEndpoint: '/api/companion/subscriptions/demo/cancel', cancellationScope: { ...CANCELLATION_SCOPE.demo } };
}

/** Step 2: the tap. Consumes the token (single use), calls PayPal cancel, then GET must show CANCELLED. */
export async function cancelDemo(hh: string, token: string): Promise<{ outcome: 'confirmed' | 'already_cancelled' | 'retry_needed'; subscription: SubscriptionT; message: string }> {
  if (!demoConfigured()) notConfigured();
  const now = Date.now();
  const t = db.prepare('SELECT * FROM companion_cancel_tokens WHERE token_hash=?').get(sha(token)) as any;
  if (!t || t.household_id !== hh) throw new CompanionError('bad_token', 'This confirmation is not valid. Please ask again and tap the new confirmation.', 403);
  if (t.used_at) throw new CompanionError('token_used', 'This confirmation was already used. Please ask again and tap the new confirmation.', 409);
  if (Number(t.expires_at) < now) throw new CompanionError('token_expired', 'This confirmation has expired. Please ask again and tap the new confirmation.', 410);
  // Single use, atomically: only one request can flip used_at.
  if (!db.prepare('UPDATE companion_cancel_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(now, sha(token)).changes) throw new CompanionError('token_used', 'This confirmation was already used.', 409);
  const r = db.prepare("SELECT * FROM companion_subscriptions WHERE id=? AND household_id=? AND source='paypal_sandbox_subscription'").get(t.subscription_id, hh) as any;
  if (!r?.paypal_subscription_id) throw new CompanionError('not_found', 'That membership was not found.', 404);
  if (r.sub_state === 'provider_confirmed') return { outcome: 'already_cancelled', subscription: subView(r), message: 'PayPal already confirmed this membership is cancelled.' };

  db.prepare("UPDATE companion_subscriptions SET sub_state='cancellation_requested', cancel_state='in_progress', cancel_error=NULL, updated_at=datetime('now') WHERE id=? AND household_id=?").run(r.id, hh);
  let cancelErr: string | null = null;
  try { await ppCancel(r.paypal_subscription_id, 'Cancelled by the member in SaySafe (sandbox demo)'); }
  catch (e: any) { cancelErr = e?.status ? `PayPal answered ${e.status}${e?.data?.details?.[0]?.issue ? ` ${e.data.details[0].issue}` : e?.data?.name ? ` ${e.data.name}` : ''}` : 'PayPal did not answer in time'; }

  // Whatever the cancel call said, PayPal's own GET decides.
  let pp: any = null;
  try { pp = await ppGet(r.paypal_subscription_id); } catch { pp = null; }
  if (pp && pp.custom_id && pp.custom_id !== hh) throw new CompanionError('not_found', 'That membership was not found.', 404);
  if (pp?.status === 'CANCELLED') {
    applyPayPal(hh, r.id, pp, 'paypal_api');
    db.prepare("UPDATE companion_subscriptions SET confirmed_by='paypal_api', evidence_note=? WHERE id=? AND household_id=?")
      .run(`PayPal API: subscription ${r.paypal_subscription_id} status CANCELLED (checked ${new Date().toISOString()}).`, r.id, hh);
    return { outcome: cancelErr ? 'already_cancelled' : 'confirmed', subscription: getSubscription(hh, r.id), message: 'PayPal confirmed the billing authorisation is cancelled. No more Demo Membership payments will be taken.' };
  }
  if (pp) applyPayPal(hh, r.id, pp, 'paypal_api');
  const why = cancelErr ?? (pp ? `PayPal still shows ${pp.status}` : 'SaySafe could not check with PayPal');
  db.prepare("UPDATE companion_subscriptions SET cancel_state='retry_needed', cancel_error=?, updated_at=datetime('now') WHERE id=? AND household_id=?").run(why.slice(0, 200), r.id, hh);
  return { outcome: 'retry_needed', subscription: getSubscription(hh, r.id), message: `Not cancelled yet: ${why}. Nothing is confirmed. You can try again with a new confirmation.` };
}

/** Signed BILLING.SUBSCRIPTION.* webhook (signature already verified by the caller). Matches on PayPal id AND custom_id. */
export function demoFromWebhook(event: any): { matched: boolean } {
  const res = event?.resource ?? {};
  const id = String(res.id ?? '');
  if (!id.startsWith('I-')) return { matched: false };
  const r = db.prepare("SELECT id, household_id FROM companion_subscriptions WHERE paypal_subscription_id=? AND source='paypal_sandbox_subscription'").get(id) as any;
  if (!r) return { matched: false };
  if (res.custom_id && res.custom_id !== r.household_id) return { matched: false };
  db.prepare('UPDATE companion_subscriptions SET webhook_verified=1 WHERE id=?').run(r.id);
  const status = res.status ?? (String(event.event_type).endsWith('.CANCELLED') ? 'CANCELLED' : String(event.event_type).endsWith('.ACTIVATED') ? 'ACTIVE' : null);
  if (status) applyPayPal(r.household_id, r.id, { ...res, status }, 'paypal_webhook');
  return { matched: true };
}
