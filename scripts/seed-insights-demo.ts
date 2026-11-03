/**
 * LOCAL DEMO ONLY: adds clearly-labelled EXAMPLE rows to one household so the insights dashboards
 * have realistic history to show (captured payments, a webhook-confirmed capture, shared scam checks).
 * Seeded rows are marked with an idempotency key `seed_…` and capture ids `SEED…`, which the insights
 * model reports as source: 'seeded' ("Example data"). No new tables; no PayPal calls.
 *
 *   DATABASE_FILE=data/e2e.db npx tsx scripts/seed-insights-demo.ts            # newest paired household
 *   DATABASE_FILE=data/e2e.db SEED_HOUSEHOLD=hh_xxx npx tsx scripts/seed-insights-demo.ts
 */
import crypto from 'node:crypto';
import { db, audit } from '../server/db/index.js';

if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW !== 'yes') {
  console.error('Refusing to seed example rows with NODE_ENV=production (set SEED_ALLOW=yes for a local production build).');
  process.exit(1);
}

const hh = process.env.SEED_HOUSEHOLD
  ?? (db.prepare("SELECT household_id h FROM family_links WHERE status='active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { h: string } | undefined)?.h;
if (!hh) { console.error('No paired household found.'); process.exit(1); }

const daysAgo = (d: number, h = 10) => { const t = new Date(Date.now() - d * 864e5); t.setUTCHours(h, 15, 0, 0); return t.toISOString().replace('T', ' ').slice(0, 19); };
const rid = () => `pay_seed${crypto.randomBytes(6).toString('base64url')}`;

const examples = [
  { name: 'Reading lamp', cents: 3999, days: 12, state: 'CAPTURED', webhook: true },
  { name: 'Ground coffee', cents: 1299, days: 9, state: 'CAPTURED', webhook: true },
  { name: 'Pill organiser', cents: 899, days: 5, state: 'CAPTURED', webhook: false },
  { name: 'Soft throw blanket', cents: 4500, days: 3, state: 'REFUNDED', webhook: true },
  { name: 'Radio', cents: 5900, days: 2, state: 'CANCELLED', webhook: false },
];

db.transaction(() => {
  for (const e of examples) {
    const id = rid();
    const capture = e.state === 'CAPTURED' || e.state === 'REFUNDED' ? `SEED${crypto.randomBytes(5).toString('hex').toUpperCase()}` : null;
    db.prepare(`INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, paypal_order_id, paypal_capture_id, captured_amount, captured_currency, payee_name, idempotency_key, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, hh, e.state, JSON.stringify([{ productId: 'example', name: e.name, unitCents: e.cents, quantity: 1, lineCents: e.cents, image: 'lamp.webp' }]), 'SaySafe Demo Shop', e.cents, 'EUR', `seed-${id}`,
      capture ? `SEEDORDER${crypto.randomBytes(4).toString('hex').toUpperCase()}` : null, capture, capture ? (e.cents / 100).toFixed(2) : null, capture ? 'EUR' : null, 'SaySafe Demo Shop (example)', `seed_${id}`, daysAgo(e.days), daysAgo(e.days),
    );
    db.prepare("INSERT INTO audit_log (household_id, actor, action, target, at) VALUES (?,?,?,?,?)").run(hh, 'seed', 'payment.created', id, daysAgo(e.days, 10));
    if (capture) {
      db.prepare("INSERT INTO audit_log (household_id, actor, action, target, at) VALUES (?,?,?,?,?)").run(hh, 'system', 'payment.CAPTURE_PENDING->CAPTURED', id, daysAgo(e.days, 11));
      if (e.webhook) {
        db.prepare("INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, verified, payload_json, received_at) VALUES (?,?,?,1,'{\"example\":true}',?)").run(`WH-SEED-${capture}`, 'PAYMENT.CAPTURE.COMPLETED', capture, daysAgo(e.days, 11));
        db.prepare("INSERT INTO audit_log (household_id, actor, action, target, at) VALUES (?,?,?,?,?)").run(hh, 'paypal-webhook', 'payment.CAPTURED->CAPTURED', id, daysAgo(e.days, 11));
      }
    }
    if (e.state === 'REFUNDED') db.prepare("INSERT INTO audit_log (household_id, actor, action, target, at) VALUES (?,?,?,?,?)").run(hh, 'paypal-webhook', 'payment.CAPTURED->REFUNDED', id, daysAgo(e.days - 1, 9));
    if (e.state === 'CANCELLED') db.prepare("INSERT INTO audit_log (household_id, actor, action, target, at) VALUES (?,?,?,?,?)").run(hh, 'system', 'payment.PAYER_APPROVAL_PENDING->CANCELLED', id, daysAgo(e.days, 12));
  }
  const scans = [
    { verdict: 'suspicious', summary: 'Example: "Your parcel is held" text with a payment link — looks like a scam.', days: 8 },
    { verdict: 'needs_verification', summary: 'Example: email about a bank account update — check it with the bank directly.', days: 4 },
  ];
  for (const s of scans) {
    const id = `scan_seed${crypto.randomBytes(5).toString('base64url')}`;
    db.prepare('INSERT INTO security_scans (id, household_id, verdict, summary, shared_with_family, created_at) VALUES (?,?,?,?,1,?)').run(id, hh, s.verdict, s.summary, daysAgo(s.days, 15));
    db.prepare("INSERT INTO audit_log (household_id, actor, action, target, at) VALUES (?,?,?,?,?)").run(hh, 'seed', 'scan.shared', id, daysAgo(s.days, 15));
  }
})();
audit(hh, 'seed', 'demo.seeded_examples');
console.log(`Seeded ${examples.length} example payments and 2 example scam checks into ${hh}.`);
