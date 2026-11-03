/**
 * LOCAL QA ONLY: adds one clearly-labelled EXAMPLE purchase waiting for family review to the newest paired
 * household (PayPal is not configured locally, so POST /api/payments can't create one). Pair with
 * scripts/seed-insights-demo.ts for example captured/refunded/cancelled rows. Idempotency keys start with `seed_`.
 */
import crypto from 'node:crypto';
import { db } from '../server/db/index.js';
import { getProduct } from '../server/catalogue/products.js';
import { priceCart, fingerprint, APPROVAL_TTL_MS } from '../server/payments/service.js';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed with NODE_ENV=production.'); process.exit(1); }
const hh = process.env.SEED_HOUSEHOLD ?? (db.prepare("SELECT household_id h FROM family_links WHERE status='active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { h: string } | undefined)?.h;
if (!hh) { console.error('No paired household found.'); process.exit(1); }
const p = getProduct('microwave')!;
const q = priceCart([{ productId: p.id, quantity: 1 }]);
const id = `pay_seed${crypto.randomBytes(6).toString('base64url')}`;
db.prepare('INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, risk_json, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run(id, hh, 'FAMILY_APPROVAL_PENDING', JSON.stringify(q.lines), q.merchant, q.totalCents, q.currency, fingerprint(q), JSON.stringify({ ok: true, needsFamily: true, reasons: ['Above your protected limit (example).'] }), `seed_${id}`);
db.prepare('INSERT INTO approvals (id, request_id, fingerprint, status, nonce, expires_at) VALUES (?,?,?,?,?,?)')
  .run(`apr_seed${crypto.randomBytes(5).toString('hex')}`, id, fingerprint(q), 'pending', crypto.randomBytes(16).toString('hex'), Date.now() + APPROVAL_TTL_MS);
// One example captured payment with a buyer refund REQUEST (not a refund), so Activity shows that label.
const cap = db.prepare("SELECT id FROM payment_requests WHERE household_id=? AND state='CAPTURED' AND id NOT IN (SELECT request_id FROM refund_requests) ORDER BY created_at ASC LIMIT 1").get(hh) as { id: string } | undefined;
if (cap) db.prepare("INSERT INTO refund_requests (id, request_id, household_id, requested_by, reason, status) VALUES (?,?,?,?,?,?)").run(`rr_seed${crypto.randomBytes(5).toString('hex')}`, cap.id, hh, 'seed', 'example', 'REFUND_REQUESTED');
console.log(JSON.stringify({ household: hh, pending: id, refundRequested: cap?.id ?? null }));
