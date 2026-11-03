/**
 * Seeds the "Try as Mary" sample set into ONE household (each visitor gets their own copy; nothing is shared).
 * Stored in the same database as everything else (Turso in production), so it survives restarts and redeploys.
 *
 * Rules:
 *  - Every row is example=1. Sample payments have no PayPal order/capture/refund ids and no webhook events.
 *    The payment service refuses every action on them (assertNotSample).
 *  - Deterministic: same content and the same ids for the same household, dates relative to the seed moment.
 *  - Reset only replaces sample rows. Real PayPal Sandbox payments and records the visitor typed are kept.
 */
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { getProduct, DEMO_MERCHANT } from '../catalogue/products.js';
import { priceCart, fingerprint, APPROVAL_TTL_MS } from '../payments/service.js';
import { DEMO_SEED_VERSION, SAMPLE_CONTACTS, SAMPLE_RECORDS, SAMPLE_SHOP, SAMPLE_SUBS } from '../../shared/demoData.js';

const DAY = 86_400_000;
/** Stable id for a sample row in one household: same household + key -> same id; different households never collide. */
export function sampleId(prefix: string, householdId: string, key: string) {
  return `${prefix}_smp${crypto.createHash('sha256').update(`${householdId}:${key}`).digest('base64url').slice(0, 18)}`;
}
// Formatted by hand from UTC parts (not toISOString), so the stored text is always SQLite's "YYYY-MM-DD HH:MM:SS".
const p2 = (n: number) => String(n).padStart(2, '0');
const isoDay = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };
const sqlTime = (ms: number) => { const d = new Date(ms); return `${isoDay(ms)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
export const isoTime = (ms: number) => `${sqlTime(ms).replace(' ', 'T')}Z`;

export function clearSamples(householdId: string) {
  const ids = (db.prepare('SELECT id FROM payment_requests WHERE household_id=? AND example=1').all(householdId) as { id: string }[]).map((r) => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM approvals WHERE request_id=?').run(id);
    db.prepare('DELETE FROM refund_requests WHERE request_id=?').run(id);
  }
  db.prepare('DELETE FROM payment_requests WHERE household_id=? AND example=1').run(householdId);
  db.prepare('DELETE FROM companion_payments WHERE household_id=? AND example=1').run(householdId);
  const subIds = (db.prepare('SELECT id FROM companion_subscriptions WHERE household_id=? AND example=1').all(householdId) as { id: string }[]).map((r) => r.id);
  for (const id of subIds) db.prepare('DELETE FROM companion_cancel_tokens WHERE subscription_id=?').run(id);
  db.prepare('DELETE FROM companion_subscriptions WHERE household_id=? AND example=1').run(householdId);
  db.prepare('DELETE FROM companion_contacts WHERE household_id=? AND example=1').run(householdId);
}

/** Insert (or re-insert, on reset) the sample set. Returns the counts written. */
export function seedDemoHousehold(householdId: string, ownerId: string, now: Date = new Date()) {
  const t0 = now.getTime();
  const counts = { transactions: 0, records: 0, subscriptions: 0, contacts: 0, familyReviews: 0 };
  db.transaction(() => {
    clearSamples(householdId);
    for (const s of SAMPLE_SHOP) {
      const p = getProduct(s.productId);
      if (!p) continue;
      const q = priceCart([{ productId: p.id, quantity: 1 }]);
      const fp = fingerprint(q);
      const id = sampleId('pay', householdId, s.key);
      const at = t0 - s.daysAgo * DAY - 2 * 3600_000; // two hours before "now" on that day, so "today" items sort before now
      const risk = { ok: true, needsFamily: s.approval !== null, reasons: s.approval ? ['Above your protected limit (sample).'] : [], sample: true };
      db.prepare(`INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, risk_json, example, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, householdId, s.state, JSON.stringify(q.lines), DEMO_MERCHANT, q.totalCents, q.currency, fp, JSON.stringify(risk), sqlTime(at), sqlTime(at + 15 * 60_000));
      counts.transactions++;
      if (s.approval) {
        const status = s.approval === 'expired' ? 'pending' : s.approval; // "expired" = a pending request whose time ran out
        const expires = s.approval === 'pending' ? t0 + 30 * DAY : at + APPROVAL_TTL_MS;
        const decided = s.approval === 'approved' || s.approval === 'declined' ? sqlTime(at + 10 * 60_000) : null;
        db.prepare('INSERT INTO approvals (id, request_id, fingerprint, status, decided_by, reason, nonce, expires_at, decided_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(sampleId('apr', householdId, s.key), id, fp, status, decided ? 'sample' : null, s.approval === 'declined' ? 'Sample: we already have a coffee maker.' : null,
            crypto.createHash('sha256').update(`nonce:${id}`).digest('hex').slice(0, 32), expires, decided, sqlTime(at));
        counts.familyReviews++;
      }
    }
    for (const r of SAMPLE_RECORDS) {
      db.prepare('INSERT INTO companion_payments (id, household_id, owner_id, recipient, amount_cents, currency, paid_on, pay_method, memo, example) VALUES (?,?,?,?,?,?,?,?,?,1)')
        .run(sampleId('mpay', householdId, r.key), householdId, ownerId, r.recipient, r.amountCents, 'EUR', isoDay(t0 - r.daysAgo * DAY), r.method, r.note);
      counts.records++;
    }
    SAMPLE_SUBS.forEach((s, i) => {
      // created_at spaced by a second so the list keeps this order.
      db.prepare("INSERT INTO companion_subscriptions (id, household_id, owner_id, merchant, amount_cents, currency, billing_cycle, next_on, memo, example, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)")
        .run(sampleId('sub', householdId, s.key), householdId, ownerId, s.merchant, s.amountCents, 'EUR', s.frequency, isoDay(t0 + s.nextInDays * DAY), s.note, sqlTime(t0 - 60 * DAY + i * 1000), sqlTime(t0 - 60 * DAY + i * 1000));
      counts.subscriptions++;
    });
    for (const c of SAMPLE_CONTACTS) {
      db.prepare('INSERT INTO companion_contacts (id, household_id, owner_id, display_name, relation, phone, email, memo, example) VALUES (?,?,?,?,?,?,?,?,1)')
        .run(sampleId('ctc', householdId, c.key), householdId, ownerId, c.name, c.relation, c.phone, c.email, c.note);
      counts.contacts++;
    }
    db.prepare('DELETE FROM demo_seeds WHERE household_id=?').run(householdId);
    db.prepare('INSERT INTO demo_seeds (household_id, seed_version, anchored_at) VALUES (?,?,?)').run(householdId, DEMO_SEED_VERSION, isoTime(t0));
  })();
  return counts;
}

export function seedInfo(householdId: string) {
  const r = db.prepare('SELECT seed_version, anchored_at FROM demo_seeds WHERE household_id=?').get(householdId) as { seed_version: number; anchored_at: string } | undefined;
  return r ? { version: Number(r.seed_version), anchoredAt: r.anchored_at } : null;
}
