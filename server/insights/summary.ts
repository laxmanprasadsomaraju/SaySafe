/**
 * "My insights" summary (GET /api/insights/summary, the Home card and the Assistant insights card).
 *
 * Read-only. Household always comes from the session. It reuses the stores the Assistant and Activity use:
 *  - payment_requests (Demo Shop purchases; sample rows via example=1, same rule as Activity / Family insights)
 *  - companion store: manual records, subscriptions + summarise() (same monthly/annual maths as the Assistant)
 *  - match.classifyRepeat (the same John €80 logic as "Did I already pay…?")
 *  - security_scans (training examples flagged example=1 at scan time)
 * Nothing here is hard-coded, nothing is summed across kinds, and each currency is totalled on its own.
 */
import { db } from '../db/index.js';
import * as store from '../companion/store.js';
import { classifyRepeat } from '../companion/match.js';
import { normalizeVerdict } from '../scam/verdicts.js';
import { STATE_LABELS } from '../../shared/insights.js';
import type { InsightsSummaryT, MoneyT } from '../../shared/insightsSummary.js';
import type { SubscriptionT } from '../../shared/companion.js';
import { isSeededRow } from './model.js';
import { familyVisibleRows } from '../family/permissions.js';
import { recentProducts, CONTEXT_DAYS, MAX_PRODUCTS } from '../memory/store.js';

type StatusCountsT = NonNullable<InsightsSummaryT['payments']['sandboxByStatus']>;
type ApprovalCountsT = NonNullable<InsightsSummaryT['approvals']>['real'];
const zeroStatus = (): StatusCountsT => ({ paid: 0, waiting: 0, cancelled: 0, declined: 0, failed: 0, refunded: 0, expired: 0 });
const zeroApprovals = (): ApprovalCountsT => ({ requested: 0, pending: 0, approved: 0, declined: 0, expired: 0 });
const WAITING_STATES = ['DRAFT', 'RISK_REVIEW', 'FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'CAPTURE_PENDING'];

/** One purchase's outcome bucket. Declined = the family helper said no; expired = the review ran out (nothing paid). */
export function statusBucket(state: string, approvalStatus: string | null): keyof StatusCountsT | null {
  if (state === 'CAPTURED') return 'paid';
  if (state === 'REFUNDED' || state === 'REFUND_PENDING') return 'refunded';
  if (state === 'FAILED') return 'failed';
  if (approvalStatus === 'declined' && (state === 'CANCELLED' || state === 'BLOCKED')) return 'declined';
  if (state === 'CANCELLED' || state === 'BLOCKED') return 'cancelled';
  if (state === 'FAMILY_APPROVAL_PENDING') return approvalStatus === 'expired' ? 'expired' : 'waiting';
  if (WAITING_STATES.includes(state)) return 'waiting';
  return null;
}

const toIso = (s: string | null | undefined) => (s ? new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toISOString() : '');

/** Sum per currency, never converting. */
export function totalsByCurrency(rows: { amountCents: number; currency: string }[]): MoneyT[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.currency, (by.get(r.currency) ?? 0) + r.amountCents);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cents]) => ({ currency, cents }));
}

function subKind(subs: SubscriptionT[]) {
  const s = store.summarise(subs);
  return { count: s.counted, monthly: s.totals.map((t) => ({ currency: t.currency, cents: t.monthlyCents })), annual: s.totals.map((t) => ({ currency: t.currency, cents: t.annualCents })) };
}

export interface Viewer { role: 'elder' | 'family'; householdId: string }

export function buildSummary(v: Viewer, now = new Date()): InsightsSummaryT {
  const hh = v.householdId;
  const elder = db.prepare('SELECT u.name AS name, h.elder_id AS elder_id FROM households h JOIN users u ON u.id = h.elder_id WHERE h.id = ?').get(hh) as { name: string; elder_id: string } | undefined;
  const nowMs = now.getTime();

  // ---------- Demo Shop purchases (family: permission-filtered, see server/family/permissions.ts) ----------
  // Family: only requests routed to them for review (+ Mary's history while she shares it). Same filter as every family route.
  const rows = v.role === 'family' ? familyVisibleRows(hh, 500) : db.prepare(
    `SELECT id, state, items_json, amount_cents, currency, paypal_capture_id, captured_amount, captured_currency, idempotency_key, example, created_at, updated_at
       FROM payment_requests WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500`,
  ).all(hh) as any[];
  const approval = db.prepare('SELECT status, expires_at FROM approvals WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1');
  const webhook = db.prepare("SELECT 1 AS ok FROM webhook_events WHERE resource_id = ? AND event_type = 'PAYMENT.CAPTURE.COMPLETED' AND verified = 1 LIMIT 1");
  const refundReq = db.prepare('SELECT status FROM refund_requests WHERE request_id = ?');
  const itemsOf = (j: string) => { try { return (JSON.parse(j) as { name?: string; quantity?: number }[]).map((i) => `${i.name ?? 'Item'}${(i.quantity ?? 1) > 1 ? ` × ${i.quantity}` : ''}`).join(', ') || 'Purchase'; } catch { return 'Purchase'; } };

  const sandbox = { count: 0, captured: { count: 0, totals: [] as MoneyT[] }, webhookVerified: 0, webhookPending: 0, waitingFamily: 0, waitingPayPal: 0, cancelled: 0, failed: 0, refunded: 0, refundPending: 0, refundRequested: 0 };
  const sample = { count: 0, captured: { count: 0, totals: [] as MoneyT[] } };
  const sandboxCaptured: { amountCents: number; currency: string }[] = [];
  const sampleCaptured: { amountCents: number; currency: string }[] = [];
  const pendingReal: InsightsSummaryT['pendingReviews']['real'] = [];
  let sampleWaiting = 0; let expired = 0;
  const recent: InsightsSummaryT['payments']['recent'] = [];
  const sandboxByStatus = zeroStatus(); const sampleByStatus = zeroStatus();
  const apReal = zeroApprovals(); const apSample = zeroApprovals();
  const paidProductIds = new Set<string>();
  const cancelledOrders: NonNullable<InsightsSummaryT['cancelled']>['orders'] = [];

  for (const r of rows) {
    const isSample = isSeededRow(r);
    const a = approval.get(r.id) as { status: string; expires_at: number } | undefined;
    const apStatus = a ? (a.status === 'pending' && Number(a.expires_at) < nowMs ? 'expired' : a.status) : null;
    const wh = Boolean(r.paypal_capture_id && webhook.get(r.paypal_capture_id));
    // Captured amount is PayPal's own figure when present (same as the family KPIs).
    const capAmt = r.captured_amount != null && r.captured_amount !== '' ? Math.round(Number(r.captured_amount) * 100) : Number(r.amount_cents);
    const capCur = r.captured_currency ?? r.currency;
    const bucket = statusBucket(r.state, apStatus);
    if (bucket) (isSample ? sampleByStatus : sandboxByStatus)[bucket]++;
    if (a) {
      const ap = isSample ? apSample : apReal;
      ap.requested++;
      if (apStatus === 'pending' || apStatus === 'approved' || apStatus === 'declined' || apStatus === 'expired') ap[apStatus]++;
    }
    if (!isSample && r.state === 'CAPTURED') {
      try { for (const l of JSON.parse(r.items_json) as { productId?: string }[]) if (l.productId) paidProductIds.add(String(l.productId)); } catch { /* ignore */ }
    }
    if ((r.state === 'CANCELLED' || r.state === 'BLOCKED') && cancelledOrders.length < 10) {
      cancelledOrders.push({ id: r.id, title: itemsOf(r.items_json), at: toIso(r.updated_at ?? r.created_at), kind: isSample ? 'sample' : 'sandbox', how: apStatus === 'declined' ? 'declined' : r.state === 'BLOCKED' ? 'blocked' : 'cancelled' });
    }
    if (isSample) {
      sample.count++;
      if (r.state === 'CAPTURED') { sample.captured.count++; sampleCaptured.push({ amountCents: Number(r.amount_cents), currency: r.currency }); }
      if (r.state === 'FAMILY_APPROVAL_PENDING' && apStatus === 'pending') sampleWaiting++;
    } else {
      sandbox.count++;
      if (r.state === 'CAPTURED') {
        sandbox.captured.count++; sandboxCaptured.push({ amountCents: capAmt, currency: capCur });
        if (wh) sandbox.webhookVerified++; else sandbox.webhookPending++;
      }
      if (r.state === 'FAMILY_APPROVAL_PENDING' && apStatus === 'pending') {
        sandbox.waitingFamily++;
        pendingReal.push({ id: r.id, item: itemsOf(r.items_json), amountCents: Number(r.amount_cents), currency: r.currency, expiresAt: new Date(Number(a!.expires_at)).toISOString() });
      }
      if (r.state === 'FAMILY_APPROVAL_PENDING' && apStatus === 'expired') expired++;
      if (['FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'CAPTURE_PENDING'].includes(r.state)) sandbox.waitingPayPal++;
      if (r.state === 'CANCELLED' || r.state === 'BLOCKED') sandbox.cancelled++;
      if (r.state === 'FAILED') sandbox.failed++;
      if (r.state === 'REFUNDED') sandbox.refunded++;
      if (r.state === 'REFUND_PENDING') sandbox.refundPending++;
      const rr = refundReq.get(r.id) as { status: string } | undefined;
      if (rr?.status === 'REFUND_REQUESTED' && r.state === 'CAPTURED') sandbox.refundRequested++;
    }
    if (recent.length < 5) recent.push({ id: r.id, title: itemsOf(r.items_json), amountCents: Number(r.amount_cents), currency: r.currency, at: toIso(r.created_at), statusLabel: STATE_LABELS[r.state] ?? r.state, kind: isSample ? 'sample' : 'sandbox', webhookVerified: wh });
  }
  sandbox.captured.totals = totalsByCurrency(sandboxCaptured);
  sample.captured.totals = totalsByCurrency(sampleCaptured);

  // ---------- Scam checks ----------
  const scans = db.prepare(`SELECT verdict, summary, example, created_at FROM security_scans WHERE household_id = ? ${v.role === 'family' ? 'AND shared_with_family = 1' : ''} ORDER BY created_at DESC LIMIT 500`).all(hh) as any[];
  const real = { total: 0, suspicious: 0, needsChecking: 0, noWarnings: 0 };
  let training = 0;
  const recentScans: InsightsSummaryT['scamChecks']['recent'] = [];
  for (const s of scans) {
    if (Number(s.example ?? 0) === 1) { training++; continue; } // a training example is practice, never an incident
    const vd = normalizeVerdict(s.verdict);
    real.total++;
    if (vd === 'suspicious') real.suspicious++; else if (vd === 'needs_checking') real.needsChecking++; else real.noWarnings++;
    if (recentScans.length < 3) recentScans.push({ verdict: vd, headline: String(s.summary ?? '').slice(0, 200), at: toIso(s.created_at) });
  }

  const base: InsightsSummaryT = {
    role: v.role,
    generatedAt: now.toISOString(),
    elderName: elder?.name ?? 'Your relative',
    privateRecordsVisible: v.role === 'elder',
    payments: { sandbox, sample: { ...sample, byStatus: sampleByStatus }, sandboxByStatus, recent },
    records: null,
    subscriptions: null,
    duplicates: null,
    pendingReviews: { real: pendingReal.slice(0, 10), sampleWaiting, expired },
    scamChecks: { scope: v.role === 'family' ? 'shared' : 'all', real, training, recent: recentScans },
    approvals: { real: apReal, sample: apSample },
    shopping: null,
    contacts: null,
    cancelled: null,
  };
  if (v.role !== 'elder') return base; // Mary's own records are private to her (companion routes are elder-only too).

  // ---------- Mary's own records (elder only) ----------
  const manual = store.listManualPayments(hh);
  const recU = manual.filter((m) => !m.sample);
  const recS = manual.filter((m) => m.sample);
  base.records = { userEntered: { count: recU.length, totals: totalsByCurrency(recU) }, sample: { count: recS.length, totals: totalsByCurrency(recS) } };

  const subs = store.listSubscriptions(hh, now);
  const subU = subs.filter((s) => s.source === 'manual' && !s.sample);
  const subS = subs.filter((s) => s.source === 'manual' && s.sample);
  const subP = subs.filter((s) => s.source === 'paypal_sandbox_subscription');
  const kindOf = (s: SubscriptionT) => (s.source === 'paypal_sandbox_subscription' ? 'sandbox' as const : s.sample ? 'sample' as const : 'user_entered' as const);
  const upcoming = store.summarise(subs).upcoming.filter((u) => u.inDays <= 31).slice(0, 5).map((u) => ({ ...u, kind: kindOf(subs.find((s) => s.id === u.id)!) }));
  base.subscriptions = { userEntered: subKind(subU), sample: subKind(subS), sandbox: subKind(subP), upcoming, method: store.SUMMARY_METHOD };

  // Same classifier as "Did I already pay…?": only identical entries and possible duplicates are flagged here.
  const cands = store.paymentCandidates(hh).filter((c) => c.source === 'manual');
  const dups: NonNullable<InsightsSummaryT['duplicates']> = [];
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    const rep = classifyRepeat(cands[i], cands[j]);
    if (rep && (rep.kind === 'possible_duplicate' || rep.kind === 'identical_entries')) dups.push({ kind: rep.kind, recipient: rep.recipient, amountCents: rep.amountCents, currency: rep.currency, daysApart: rep.daysApart, sample: Boolean(cands[i].sample && cands[j].sample), message: rep.message.slice(0, 500) });
  }
  base.duplicates = dups.slice(0, 10);
  // Recent list for Mary also shows what she recorded, labelled, newest first.
  const recentAll = [...recent, ...manual.slice(0, 5).map((m) => ({ id: m.id, title: `${m.recipient}${m.note ? ` · ${m.note}` : ''}`.slice(0, 300), amountCents: m.amountCents, currency: m.currency, at: `${m.paidOn}T12:00:00.000Z`, statusLabel: 'Recorded', kind: m.sample ? 'sample' as const : 'user_entered' as const, webhookVerified: false }))];
  base.payments.recent = recentAll.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);

  // ---------- Shopping funnel (elder only; derived from recent_products + payment_requests, no extra tracking) ----------
  const looked = elder?.elder_id ? recentProducts(hh, elder.elder_id) : [];
  const ids = new Set(looked.map((p) => p.productId));
  const demoLooked = looked.filter((p) => p.origin === 'demo');
  base.shopping = {
    windowDays: CONTEXT_DAYS, maxProducts: MAX_PRODUCTS,
    productsLooked: ids.size,
    channel3Products: new Set(looked.filter((p) => p.origin === 'channel3').map((p) => p.productId)).size,
    demoProducts: new Set(demoLooked.map((p) => p.productId)).size,
    searches: new Set(looked.map((p) => p.batch)).size,
    purchasesStarted: sandbox.count,
    purchasesPaid: sandbox.captured.count,
    lookedAndBought: new Set(demoLooked.map((p) => p.productId).filter((id) => paidProductIds.has(id.replace(/^demo:/, '')))).size,
    notTracked: ['Browsing the Demo Shop pages without asking the Assistant is not recorded.', 'Older searches drop out after the window, and a product shown twice counts once.'],
  };

  // ---------- Trusted contacts (elder only; names and relations, never phone or email) ----------
  const contacts = store.listContacts(hh);
  base.contacts = {
    total: contacts.length, own: contacts.filter((c) => !c.sample).length, sample: contacts.filter((c) => c.sample).length,
    list: contacts.slice(0, 12).map((c) => ({ name: c.name.slice(0, 60), relation: c.relation ? c.relation.slice(0, 60) : null, sample: Boolean(c.sample) })),
  };

  // ---------- Cancelled (elder only): orders above + subscriptions she cancelled or stopped tracking ----------
  const cancelledSubs: NonNullable<InsightsSummaryT['cancelled']>['subscriptions'] = [];
  for (const s of subs) {
    const how = s.status === 'provider_confirmed' ? 'paypal_confirmed' as const : s.status === 'user_reported_cancelled' ? 'you_reported' as const : s.stoppedTrackingAt ? 'stopped_tracking' as const : null;
    if (how && cancelledSubs.length < 10) cancelledSubs.push({ merchant: s.merchant.slice(0, 120), kind: kindOf(s), how, on: s.confirmedOn ?? s.stoppedTrackingAt ?? null });
  }
  base.cancelled = { orders: cancelledOrders, subscriptions: cancelledSubs };
  return base;
}
