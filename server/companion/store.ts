/**
 * Payment companion storage. Every query is scoped by household_id from the elder's session.
 * Nothing here writes to audit_log (which feeds family insights) and nothing is logged.
 */
import { db } from '../db/index.js';
import { newId } from '../auth.js';
import { PaymentError } from '../payments/service.js';
import {
  CANCELLATION_SCOPE, COMPANION_LABELS, DEMO_SHOP_RECIPIENT, MAX_CONTACTS, MAX_MANUAL_PAYMENTS, MAX_SUBSCRIPTIONS, SUB_TRANSITIONS, SUB_STATUS_LABEL,
  categoryOf, type ManualPaymentT, type SubscriptionT, type ContactT, type SubStatus, type SubscriptionSummaryT,
} from '../../shared/companion.js';
import { findCancelGuide } from '../../shared/cancelGuides.js';
import type { Candidate } from './match.js';

export class CompanionError extends PaymentError {}
const notFound = () => new CompanionError('not_found', 'That record was not found.', 404);
const iso = (s: string | null | undefined) => (s ? (s.includes('T') ? s : s.replace(' ', 'T') + 'Z') : '');
const dayMs = 86_400_000;
const todayUtc = (now = new Date()) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

// ---------- Manual payments ----------
const payView = (r: any): ManualPaymentT => ({
  id: r.id, recipient: r.recipient, amountCents: Number(r.amount_cents), currency: r.currency, paidOn: r.paid_on,
  method: r.pay_method, note: r.memo ?? null, label: COMPANION_LABELS.manual, sample: Number(r.example ?? 0) === 1, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

export function listManualPayments(hh: string): ManualPaymentT[] {
  return (db.prepare('SELECT * FROM companion_payments WHERE household_id=? ORDER BY paid_on DESC, created_at DESC LIMIT ?').all(hh, MAX_MANUAL_PAYMENTS) as any[]).map(payView);
}
export function getManualPayment(hh: string, id: string): ManualPaymentT {
  const r = db.prepare('SELECT * FROM companion_payments WHERE id=? AND household_id=?').get(id, hh);
  if (!r) throw notFound();
  return payView(r);
}
export function createManualPayment(hh: string, owner: string, p: { recipient: string; amountCents: number; currency: string; paidOn: string; method: string; note?: string | null }) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM companion_payments WHERE household_id=?').get(hh) as any)?.n ?? 0;
  if (Number(n) >= MAX_MANUAL_PAYMENTS) throw new CompanionError('limit_reached', `You can save up to ${MAX_MANUAL_PAYMENTS} payment records.`, 409);
  const id = newId('mpay');
  db.prepare('INSERT INTO companion_payments (id, household_id, owner_id, recipient, amount_cents, currency, paid_on, pay_method, memo) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, hh, owner, p.recipient, p.amountCents, p.currency, p.paidOn, p.method, p.note ?? null);
  return getManualPayment(hh, id);
}
export function updateManualPayment(hh: string, id: string, p: Partial<{ recipient: string; amountCents: number; currency: string; paidOn: string; method: string; note: string | null }>) {
  const cur = getManualPayment(hh, id);
  const m = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as ManualPaymentT;
  db.prepare("UPDATE companion_payments SET recipient=?, amount_cents=?, currency=?, paid_on=?, pay_method=?, memo=?, updated_at=datetime('now') WHERE id=? AND household_id=?")
    .run(m.recipient, m.amountCents, m.currency, m.paidOn, m.method, m.note ?? null, id, hh);
  return getManualPayment(hh, id);
}
export function deleteManualPayment(hh: string, id: string) {
  if (!db.prepare('DELETE FROM companion_payments WHERE id=? AND household_id=?').run(id, hh).changes) throw notFound();
}

/** Search candidates: this household's Demo Shop payments where money moved, plus manual records. */
export function paymentCandidates(hh: string): Candidate[] {
  const shop = db.prepare("SELECT id, state, items_json, amount_cents, currency, paypal_capture_id, created_at, example FROM payment_requests WHERE household_id=? AND state IN ('CAPTURED','REFUND_PENDING','REFUNDED') ORDER BY created_at DESC LIMIT 200").all(hh) as any[];
  const out: Candidate[] = shop.map((r) => {
    let items: string | null = null;
    try { items = (JSON.parse(r.items_json) as { name?: string; quantity?: number }[]).map((i) => i.name).filter(Boolean).join(', ') || null; } catch { items = null; }
    const webhookVerified = Boolean(r.paypal_capture_id && db.prepare("SELECT 1 AS ok FROM webhook_events WHERE resource_id=? AND event_type='PAYMENT.CAPTURE.COMPLETED' AND verified=1").get(r.paypal_capture_id));
    const captureStatus = r.state === 'REFUNDED' ? 'REFUNDED' : r.paypal_capture_id ? 'COMPLETED' : null;
    if (Number(r.example ?? 0) === 1) {
      // Sample shop purchase: still a shop purchase (the person-name rule applies), but never shown as a PayPal record.
      return {
        id: r.id, source: 'paypal_sandbox' as const, recipient: DEMO_SHOP_RECIPIENT, description: items, amountCents: Number(r.amount_cents), currency: r.currency,
        date: String(r.created_at).slice(0, 10), sample: true, evidence: { kind: 'sample' as const, label: COMPANION_LABELS.sampleEvidence, basis: 'shop' as const, method: null, orderState: r.state },
      };
    }
    return {
      id: r.id, source: 'paypal_sandbox' as const, recipient: DEMO_SHOP_RECIPIENT, description: items, amountCents: Number(r.amount_cents), currency: r.currency,
      date: String(r.created_at).slice(0, 10), evidence: { kind: 'paypal_sandbox' as const, captureStatus, webhookVerified, orderState: r.state },
    };
  });
  for (const m of listManualPayments(hh)) {
    out.push(m.sample
      ? { id: m.id, source: 'manual', recipient: m.recipient, description: m.note, amountCents: m.amountCents, currency: m.currency, date: m.paidOn, sample: true, evidence: { kind: 'sample', label: COMPANION_LABELS.sampleEvidence, basis: 'record', method: m.method, orderState: null } }
      : { id: m.id, source: 'manual', recipient: m.recipient, description: m.note, amountCents: m.amountCents, currency: m.currency, date: m.paidOn, evidence: { kind: 'manual', label: COMPANION_LABELS.manual, method: m.method } });
  }
  return out;
}

// ---------- Subscriptions ----------
function nextPaymentInDays(nextOn: string | null, now = new Date()): number | null {
  if (!nextOn) return null;
  return Math.round((Date.parse(`${nextOn}T00:00:00Z`) - todayUtc(now)) / dayMs);
}
export const subView = (r: any, now = new Date()): SubscriptionT => {
  const demo = r.source === 'paypal_sandbox_subscription';
  // Sample rows are fictional companies: never a real company's page, even if a name ever matched a guide.
  const g = demo || Number(r.example ?? 0) === 1 ? null : findCancelGuide(r.merchant);
  const status = r.sub_state as SubStatus;
  return {
    id: r.id, merchant: r.merchant, amountCents: Number(r.amount_cents), currency: r.currency, frequency: r.billing_cycle,
    nextOn: r.next_on ?? null, nextPaymentInDays: nextPaymentInDays(r.next_on ?? null, now), note: r.memo ?? null,
    source: demo ? 'paypal_sandbox_subscription' : 'manual',
    status, statusLabel: SUB_STATUS_LABEL[status], evidenceNote: r.evidence_note ?? null, confirmedOn: r.confirmed_on ?? null,
    confirmedBy: r.confirmed_by ?? null,
    stoppedTrackingAt: r.stopped_at ? iso(r.stopped_at) : null,
    guide: g ? { id: g.id, name: g.name, url: g.url } : null,
    managementMethod: demo ? 'paypal_api' : g ? 'official_link' : 'generic_steps',
    category: demo ? 'membership' : categoryOf(r.merchant),
    sample: Number(r.example ?? 0) === 1,
    paypal: demo && r.paypal_subscription_id ? {
      subscriptionId: r.paypal_subscription_id, status: r.paypal_status ?? null, lastCheckedAt: r.last_checked_at ? iso(r.last_checked_at) : null,
      webhookVerified: Boolean(Number(r.webhook_verified)), approveUrl: r.paypal_status === 'APPROVAL_PENDING' ? r.paypal_approve_url ?? null : null,
      cancel: { state: r.cancel_state ?? 'none', error: r.cancel_error ?? null },
    } : null,
    cancellationScope: demo ? { ...CANCELLATION_SCOPE.demo } : { ...CANCELLATION_SCOPE.external },
    label: COMPANION_LABELS.prototype, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
};
export function listSubscriptions(hh: string, now = new Date()): SubscriptionT[] {
  return (db.prepare('SELECT * FROM companion_subscriptions WHERE household_id=? ORDER BY created_at ASC LIMIT ?').all(hh, MAX_SUBSCRIPTIONS) as any[]).map((r) => subView(r, now));
}
export function getSubscription(hh: string, id: string): SubscriptionT {
  const r = db.prepare('SELECT * FROM companion_subscriptions WHERE id=? AND household_id=?').get(id, hh);
  if (!r) throw notFound();
  return subView(r);
}
export function createSubscription(hh: string, owner: string, s: { merchant: string; amountCents: number; currency: string; frequency: string; nextOn?: string | null; note?: string | null }) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM companion_subscriptions WHERE household_id=?').get(hh) as any)?.n ?? 0;
  if (Number(n) >= MAX_SUBSCRIPTIONS) throw new CompanionError('limit_reached', `You can track up to ${MAX_SUBSCRIPTIONS} subscriptions.`, 409);
  const id = newId('sub');
  db.prepare('INSERT INTO companion_subscriptions (id, household_id, owner_id, merchant, amount_cents, currency, billing_cycle, next_on, memo) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, hh, owner, s.merchant, s.amountCents, s.currency, s.frequency, s.nextOn ?? null, s.note ?? null);
  return getSubscription(hh, id);
}
const manualOnly = (cur: SubscriptionT) => {
  if (cur.source !== 'manual') throw new CompanionError('paypal_managed', 'The SaySafe Demo Membership is managed through PayPal. Use the cancel card instead.', 409);
};
export function updateSubscription(hh: string, id: string, p: Partial<{ merchant: string; amountCents: number; currency: string; frequency: string; nextOn: string | null; note: string | null }>) {
  const cur = getSubscription(hh, id);
  manualOnly(cur);
  const m = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as SubscriptionT;
  db.prepare("UPDATE companion_subscriptions SET merchant=?, amount_cents=?, currency=?, billing_cycle=?, next_on=?, memo=?, updated_at=datetime('now') WHERE id=? AND household_id=?")
    .run(m.merchant, m.amountCents, m.currency, m.frequency, m.nextOn ?? null, m.note ?? null, id, hh);
  return getSubscription(hh, id);
}
/**
 * User status moves for EXTERNAL (manual) subscriptions: tracking -> instructions_opened -> user_reported_cancelled.
 * SaySafe can't confirm an external cancellation, so these never reach provider_confirmed.
 */
export function changeSubscriptionStatus(hh: string, id: string, change: { to: SubStatus; note?: string | null; reportedOn?: string | null }) {
  const cur = getSubscription(hh, id);
  manualOnly(cur);
  if (!SUB_TRANSITIONS[cur.status].includes(change.to)) {
    throw new CompanionError('bad_transition', `This can't move from "${SUB_STATUS_LABEL[cur.status]}" to "${SUB_STATUS_LABEL[change.to]}".`, 409);
  }
  if (change.to === 'user_reported_cancelled') {
    db.prepare("UPDATE companion_subscriptions SET sub_state=?, evidence_note=?, confirmed_on=?, confirmed_by='user', updated_at=datetime('now') WHERE id=? AND household_id=?")
      .run(change.to, change.note?.trim() || null, change.reportedOn ?? new Date().toISOString().slice(0, 10), id, hh);
  } else if (change.to === 'tracking') {
    db.prepare("UPDATE companion_subscriptions SET sub_state='tracking', evidence_note=NULL, confirmed_on=NULL, confirmed_by=NULL, updated_at=datetime('now') WHERE id=? AND household_id=?").run(id, hh);
  } else {
    db.prepare("UPDATE companion_subscriptions SET sub_state=?, updated_at=datetime('now') WHERE id=? AND household_id=?").run(change.to, id, hh);
  }
  return getSubscription(hh, id);
}
/** "Stop tracking" is separate from cancelling: SaySafe stops counting it. It says nothing about the company. */
export function setTracking(hh: string, id: string, tracking: boolean) {
  getSubscription(hh, id);
  db.prepare(`UPDATE companion_subscriptions SET stopped_at=${tracking ? 'NULL' : "datetime('now')"}, updated_at=datetime('now') WHERE id=? AND household_id=?`).run(id, hh);
  return getSubscription(hh, id);
}
export function deleteSubscription(hh: string, id: string) {
  const cur = getSubscription(hh, id);
  if (cur.source === 'paypal_sandbox_subscription' && cur.status !== 'provider_confirmed' && cur.paypal?.status && !['CANCELLED', 'EXPIRED', 'APPROVAL_PENDING'].includes(cur.paypal.status)) {
    throw new CompanionError('paypal_active', 'This membership is still billing through PayPal. Cancel it first, so PayPal stops the payments.', 409);
  }
  db.prepare('DELETE FROM companion_cancel_tokens WHERE subscription_id=? AND household_id=?').run(id, hh);
  if (!db.prepare('DELETE FROM companion_subscriptions WHERE id=? AND household_id=?').run(id, hh).changes) throw notFound();
}

export const SUMMARY_METHOD = 'Weekly × 52 ÷ 12 and yearly ÷ 12 for the monthly figure; weekly × 52 and monthly × 12 for the yearly figure. Each currency is totalled on its own, never converted. Not counted: subscriptions you stopped tracking, ones you told SaySafe are cancelled, ones PayPal confirmed cancelled, and a Demo Membership you have not approved yet.';

export function summarise(subs: SubscriptionT[]): SubscriptionSummaryT {
  const by = new Map<string, { count: number; monthly: number; annual: number }>();
  let counted = 0; let stopped = 0; let confirmed = 0; let reported = 0;
  for (const s of subs) {
    if (s.stoppedTrackingAt) { stopped++; continue; }
    if (s.status === 'provider_confirmed') { confirmed++; continue; }
    if (s.status === 'user_reported_cancelled') { reported++; continue; }
    if (s.source === 'paypal_sandbox_subscription' && s.paypal?.status !== 'ACTIVE' && s.paypal?.status !== 'SUSPENDED') continue;
    counted++;
    const t = by.get(s.currency) ?? { count: 0, monthly: 0, annual: 0 };
    const annual = s.frequency === 'weekly' ? s.amountCents * 52 : s.frequency === 'monthly' ? s.amountCents * 12 : s.amountCents;
    t.count++; t.annual += annual; t.monthly += annual / 12;
    by.set(s.currency, t);
  }
  const upcoming = subs.filter((s) => !s.stoppedTrackingAt && s.status !== 'provider_confirmed' && s.status !== 'user_reported_cancelled' && s.nextOn && s.nextPaymentInDays != null && s.nextPaymentInDays >= 0)
    .sort((a, b) => a.nextPaymentInDays! - b.nextPaymentInDays!).slice(0, 5)
    .map((s) => ({ id: s.id, merchant: s.merchant, amountCents: s.amountCents, currency: s.currency, nextOn: s.nextOn!, inDays: s.nextPaymentInDays! }));
  return {
    totals: [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, t]) => ({ currency, count: t.count, monthlyCents: Math.round(t.monthly), annualCents: Math.round(t.annual) })),
    counted, excluded: { stoppedTracking: stopped, providerConfirmed: confirmed, userReportedCancelled: reported }, upcoming, label: COMPANION_LABELS.prototype, method: SUMMARY_METHOD,
  };
}

// ---------- Trusted contacts ----------
const contactView = (r: any): ContactT => ({
  id: r.id, name: r.display_name, relation: r.relation ?? null, phone: r.phone ?? null, email: r.email ?? null, note: r.memo ?? null,
  label: COMPANION_LABELS.contact, sample: Number(r.example ?? 0) === 1, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
export function listContacts(hh: string): ContactT[] {
  return (db.prepare('SELECT * FROM companion_contacts WHERE household_id=? ORDER BY display_name ASC LIMIT ?').all(hh, MAX_CONTACTS) as any[]).map(contactView);
}
export function getContact(hh: string, id: string): ContactT {
  const r = db.prepare('SELECT * FROM companion_contacts WHERE id=? AND household_id=?').get(id, hh);
  if (!r) throw notFound();
  return contactView(r);
}
export function createContact(hh: string, owner: string, c: { name: string; relation?: string | null; phone?: string | null; email?: string | null; note?: string | null }) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM companion_contacts WHERE household_id=?').get(hh) as any)?.n ?? 0;
  if (Number(n) >= MAX_CONTACTS) throw new CompanionError('limit_reached', `You can save up to ${MAX_CONTACTS} contacts.`, 409);
  const id = newId('ctc');
  db.prepare('INSERT INTO companion_contacts (id, household_id, owner_id, display_name, relation, phone, email, memo) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, hh, owner, c.name, c.relation || null, c.phone || null, c.email || null, c.note || null);
  return getContact(hh, id);
}
export function updateContact(hh: string, id: string, p: Partial<{ name: string; relation: string | null; phone: string | null; email: string | null; note: string | null }>) {
  const cur = getContact(hh, id);
  const m = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as ContactT;
  db.prepare("UPDATE companion_contacts SET display_name=?, relation=?, phone=?, email=?, memo=?, updated_at=datetime('now') WHERE id=? AND household_id=?")
    .run(m.name, m.relation || null, m.phone || null, m.email || null, m.note || null, id, hh);
  return getContact(hh, id);
}
export function deleteContact(hh: string, id: string) {
  if (!db.prepare('DELETE FROM companion_contacts WHERE id=? AND household_id=?').run(id, hh).changes) throw notFound();
}

/** "Delete all my companion data": payments records, subscriptions, contacts. Demo Shop payments are not touched. */
export function deleteAllCompanionData(hh: string) {
  const counts = { payments: 0, subscriptions: 0, contacts: 0 };
  // A Demo Membership still billing through PayPal must be cancelled first (deleting the row would lose track of it).
  const live = db.prepare("SELECT 1 AS x FROM companion_subscriptions WHERE household_id=? AND source='paypal_sandbox_subscription' AND sub_state<>'provider_confirmed' AND paypal_status IN ('ACTIVE','SUSPENDED')").get(hh);
  if (live) throw new CompanionError('paypal_active', 'Your SaySafe Demo Membership is still billing through PayPal. Cancel it first, then delete your records.', 409);
  db.transaction(() => {
    counts.payments = db.prepare('DELETE FROM companion_payments WHERE household_id=?').run(hh).changes;
    counts.subscriptions = db.prepare('DELETE FROM companion_subscriptions WHERE household_id=?').run(hh).changes;
    counts.contacts = db.prepare('DELETE FROM companion_contacts WHERE household_id=?').run(hh).changes;
    db.prepare('DELETE FROM companion_cancel_tokens WHERE household_id=?').run(hh);
  })();
  return counts;
}
