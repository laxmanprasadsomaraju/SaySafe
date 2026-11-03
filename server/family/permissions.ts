/**
 * Family permissions: the ONE place that decides what a trusted family member (Alex) may read about the
 * elder's (Mary's) Demo Shop purchases. Every family-facing route and the Family Insights AI agent go through it.
 *
 * Model (privacy first, enforced on the server, never by hiding UI):
 *  - SPENDING APPROVAL (always on): a purchase above Mary's limit gets an approval request for her family. Those
 *    requests are "assigned" to the family reviewer; Alex sees their exact item, merchant, amount, status and the
 *    payment outcome afterwards (PayPal capture / receipt status). Approval requests are household-wide: every
 *    active family member of the household is a reviewer (the demo has one, Alex).
 *  - Everything else Mary buys (at or under her limit) is PRIVATE by default and never returned to family.
 *  - Two separate opt-in switches, both OFF by default (new AND existing households; the migration adds them as 0):
 *      shareSummaries: aggregates only (totals per month and per category). Never individual rows.
 *      shareHistory:   her individual Demo Shop purchase history.
 *    Each is read from the database on EVERY call (no caching), so turning one off applies to the next API read
 *    and the next AI call.
 *  - Only Mary changes her limit and these switches (elder-only routes). Conversations, contacts, subscriptions,
 *    payment records she typed, preferences and memory are never family-visible here (companion routes are elder-only).
 */
import { db, audit } from '../db/index.js';
import { PaymentError } from '../payments/service.js';
import { getProduct } from '../catalogue/products.js';

export interface FamilySharing { shareSummaries: boolean; shareHistory: boolean; updatedAt: string | null }

/** Always a fresh read: nothing here is cached, so a revoke applies to the very next request. */
export function getSharing(householdId: string): FamilySharing {
  const r = db.prepare('SELECT share_summaries_with_family AS s, share_history_with_family AS h, sharing_updated_at AS at FROM spending_policies WHERE household_id=?').get(householdId) as { s: number | null; h: number | null; at: string | null } | undefined;
  return { shareSummaries: Number(r?.s ?? 0) === 1, shareHistory: Number(r?.h ?? 0) === 1, updatedAt: r?.at ?? null };
}

export function setSharing(householdId: string, actor: string, patch: { shareSummaries?: boolean; shareHistory?: boolean }) {
  const cur = getSharing(householdId);
  const next = { shareSummaries: patch.shareSummaries ?? cur.shareSummaries, shareHistory: patch.shareHistory ?? cur.shareHistory };
  db.prepare("UPDATE spending_policies SET share_summaries_with_family=?, share_history_with_family=?, sharing_updated_at=datetime('now') WHERE household_id=?")
    .run(next.shareSummaries ? 1 : 0, next.shareHistory ? 1 : 0, householdId);
  audit(householdId, actor, 'family.sharing_changed', undefined, next);
  return getSharing(householdId);
}

/** SQL condition (on payment_requests aliased `p`) for the rows a family member may read. */
const ASSIGNED = 'EXISTS (SELECT 1 FROM approvals a WHERE a.request_id = p.id)';

/** Was this request routed to the family for review (it crossed Mary's limit and asked for their OK)? */
export function isAssignedToFamily(requestId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM approvals WHERE request_id=? LIMIT 1').get(requestId));
}

export function familyCanSee(householdId: string, r: { id: string; household_id: string }, sharing = getSharing(householdId)): boolean {
  if (r.household_id !== householdId) return false;
  return isAssignedToFamily(r.id) || sharing.shareHistory;
}

/** payment_requests rows (all columns) the family member may read, newest first. */
export function familyVisibleRows(householdId: string, limit = 500): any[] {
  const sharing = getSharing(householdId);
  const where = sharing.shareHistory ? '' : `AND ${ASSIGNED}`;
  return db.prepare(`SELECT p.* FROM payment_requests p WHERE p.household_id = ? ${where} ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`).all(householdId, limit) as any[];
}

/** Load one request for a family member: 404 (never 403, so existence is not revealed) when it is not theirs to see. */
export function loadForFamily(id: string, householdId: string) {
  const r = db.prepare('SELECT * FROM payment_requests WHERE id=? AND household_id=?').get(id, householdId) as any;
  if (!r || !familyCanSee(householdId, r)) throw new PaymentError('not_found', 'Payment request not found.', 404);
  return r;
}

export interface SpendingSummaryRow { month: string; category: string; currency: string; count: number; totalCents: number; sample: boolean }
export interface SpendingSummary { basis: string; months: { month: string; currency: string; count: number; totalCents: number; sample: boolean }[]; categories: { category: string; currency: string; count: number; totalCents: number; sample: boolean }[] }

/**
 * Aggregates only (paid Demo Shop purchases): totals per month and per category, each currency on its own,
 * sample rows totalled apart. No ids, items, merchants or dates finer than the month. Null unless Mary turned
 * "Share spending summaries" on.
 */
export function spendingSummaryForFamily(householdId: string): SpendingSummary | null {
  if (!getSharing(householdId).shareSummaries) return null;
  const rows = db.prepare("SELECT items_json, amount_cents, currency, captured_amount, captured_currency, example, idempotency_key, paypal_capture_id, created_at FROM payment_requests WHERE household_id=? AND state='CAPTURED' LIMIT 2000").all(householdId) as any[];
  const months = new Map<string, SpendingSummary['months'][number]>();
  const cats = new Map<string, SpendingSummary['categories'][number]>();
  for (const r of rows) {
    const sample = Number(r.example ?? 0) === 1 || String(r.idempotency_key ?? '').startsWith('seed_') || String(r.paypal_capture_id ?? '').startsWith('SEED');
    const cents = r.captured_amount != null && r.captured_amount !== '' ? Math.round(Number(r.captured_amount) * 100) : Number(r.amount_cents);
    const currency = String(r.captured_currency ?? r.currency);
    const month = String(r.created_at ?? '').slice(0, 7);
    const mk = `${month}|${currency}|${sample}`;
    const m = months.get(mk) ?? { month, currency, count: 0, totalCents: 0, sample };
    m.count++; m.totalCents += cents; months.set(mk, m);
    let lines: { productId?: string; lineCents?: number }[] = [];
    try { lines = JSON.parse(r.items_json); } catch { lines = []; }
    // One purchase may span categories: split by line amount when known, else attribute to the first line's category.
    const known = lines.filter((l) => Number.isFinite(Number(l.lineCents)));
    const parts = known.length === lines.length && lines.length ? lines.map((l) => ({ cat: categoryOf(l.productId), cents: Number(l.lineCents) })) : [{ cat: categoryOf(lines[0]?.productId), cents }];
    const seen = new Set<string>();
    for (const p of parts) {
      const ck = `${p.cat}|${currency}|${sample}`;
      const c = cats.get(ck) ?? { category: p.cat, currency, count: 0, totalCents: 0, sample };
      if (!seen.has(ck)) { c.count++; seen.add(ck); }
      c.totalCents += p.cents; cats.set(ck, c);
    }
  }
  const sort = <T extends { sample: boolean }>(a: T[], k: (x: T) => string) => a.sort((x, y) => Number(x.sample) - Number(y.sample) || k(x).localeCompare(k(y)));
  return {
    basis: 'Paid Demo Shop purchases (PayPal Sandbox, no real money). Totals only, no individual purchases.',
    months: sort([...months.values()], (x) => x.month),
    categories: sort([...cats.values()], (x) => x.category),
  };
}

function categoryOf(productId?: string) {
  return (productId && getProduct(String(productId))?.category) || 'Other';
}
