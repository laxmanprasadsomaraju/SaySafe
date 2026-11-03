/**
 * Assistant interactive cards: server read endpoint for the family review card, activity sections, the zod
 * contract for every server answer a card is built from, and the honest labels (a refund REQUEST is never a refund;
 * a webhook is "verified" only when the server says the signed notice was verified). PayPal is a TEST DOUBLE here.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

const orders = new Map<string, any>();
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => orders.get(id)),
  captureOrder: vi.fn(async (id: string) => orders.get(id)),
  getCapture: vi.fn(async () => { throw new Error('no'); }),
  refundCapture: vi.fn(async () => ({ status: 'COMPLETED' })),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: () => false,
  approveLink: (o: any) => o.links[0].href,
}));

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { ServerPayment, ServerActivity, parseServer, parseBlock, familyReviewFrom, familyStatusFrom, receiptFrom, refundFrom, historyFrom } from '../web/src/assistant/schemas';
import { parseFollowup } from '../web/src/assistant/followups';
import { shortStatus, truncateRef } from '../web/src/lib/activity';
import { refuseHostedSeed } from '../scripts/seed-guard';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
const key = () => 'k' + Math.random().toString(36).slice(2, 14);
async function elder() { const a = request.agent(app); await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200); return a; }
async function familyFor(e: ReturnType<typeof request.agent>) {
  const { body } = await e.post('/api/family/invite').set(H).send({}).expect(200);
  const f = request.agent(app);
  await f.post('/api/family/pair').set(H).send({ code: body.code, name: 'Alex' }).expect(200);
  return f;
}
const buy = (a: any, productId: string) => a.post('/api/payments').set(H).send({ items: [{ productId, quantity: 1 }], idempotencyKey: key() }).expect(200);

describe('GET /api/family/requests/:id (family review card)', () => {
  it('returns the exact items and amount from the server, for the family member of that household only', async () => {
    const mary = await elder(); const alex = await familyFor(mary);
    const req = (await buy(mary, 'microwave')).body.request;
    expect(req.state).toBe('FAMILY_APPROVAL_PENDING');
    const r = await alex.get(`/api/family/requests/${req.id}`).expect(200);
    const p = parseServer(ServerPayment, r.body);
    expect(p.amountCents).toBe(req.amountCents);
    expect(p.items[0].productId).toBe('microwave');
    expect(p.elderName).toBe('Mary');
    const card = familyReviewFrom(p)!;
    expect(parseBlock(card)).not.toBeNull();
    expect(card.approvalStatus).toBe('pending');
    // Another household's family member, the elder herself and a stranger cannot read it.
    const other = await elder(); const otherAlex = await familyFor(other);
    await otherAlex.get(`/api/family/requests/${req.id}`).expect(404);
    await mary.get(`/api/family/requests/${req.id}`).expect(401);
    await request(app).get(`/api/family/requests/${req.id}`).expect(401);
    await alex.get('/api/family/requests/not-an-id').expect(400);
  });

  it('approve from the card uses the existing decide endpoint; then Mary’s card offers PayPal', async () => {
    const mary = await elder(); const alex = await familyFor(mary);
    const req = (await buy(mary, 'microwave')).body.request;
    const card = familyReviewFrom(parseServer(ServerPayment, (await alex.get(`/api/family/requests/${req.id}`)).body))!;
    const d = await alex.post(`/api/family/requests/${req.id}/decision`).set(H).send({ decision: 'approve', approvalId: card.approvalId }).expect(200);
    const after = familyReviewFrom(parseServer(ServerPayment, d.body))!;
    expect(after.approvalStatus).toBe('approved');
    // Replay is refused by the server, not by the card.
    await alex.post(`/api/family/requests/${req.id}/decision`).set(H).send({ decision: 'approve', approvalId: card.approvalId }).expect(409);
    const status = familyStatusFrom(parseServer(ServerPayment, (await mary.get(`/api/payments/${req.id}`)).body));
    expect(status.state).toBe('FAMILY_APPROVED');
    const co = await mary.post(`/api/payments/${req.id}/checkout`).set(H).send({}).expect(200);
    expect(co.body.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
  });

  it('expired and declined requests show as such and cannot be approved', async () => {
    const mary = await elder(); const alex = await familyFor(mary);
    const a = (await buy(mary, 'microwave')).body.request;
    db.prepare('UPDATE approvals SET expires_at=? WHERE request_id=?').run(Date.now() - 1000, a.id);
    const expired = parseServer(ServerPayment, (await mary.get(`/api/payments/${a.id}`)).body);
    expect(familyStatusFrom(expired).approvalStatus).toBe('expired');
    expect(familyReviewFrom(parseServer(ServerPayment, (await alex.get(`/api/family/requests/${a.id}`)).body))!.approvalStatus).toBe('expired');
    await alex.post(`/api/family/requests/${a.id}/decision`).set(H).send({ decision: 'approve', approvalId: expired.approval!.id }).expect(410);
    const b = (await buy(mary, 'microwave')).body.request;
    await alex.post(`/api/family/requests/${b.id}/decision`).set(H).send({ decision: 'decline', approvalId: b.approval.id }).expect(200);
    const declined = familyStatusFrom(parseServer(ServerPayment, (await mary.get(`/api/payments/${b.id}`)).body));
    expect([declined.state, declined.approvalStatus]).toEqual(['CANCELLED', 'declined']);
  });
});

describe('activity sections', () => {
  it('puts every item in exactly one section and filters by section', async () => {
    const mary = await elder(); await familyFor(mary);
    await buy(mary, 'kettle-classic');
    await buy(mary, 'microwave');
    await mary.post('/api/scan').set(H).send({ text: 'Your PayPal account is suspended, verify at http://paypa1-secure.example now' }).expect(200);
    const all = (await mary.get('/api/activity').expect(200)).body;
    expect(all.items.map((i: any) => i.section).sort()).toEqual(['family', 'purchases', 'scans']);
    expect(all.items.every((i: any) => i.example === false)).toBe(true);
    const fam = (await mary.get('/api/activity?section=family').expect(200)).body;
    expect(fam.items).toHaveLength(1);
    expect(fam.items[0].approval.status).toBe('pending');
    await mary.get('/api/activity?section=bogus').expect(400);
    const parsed = parseServer(ServerActivity, all);
    const h = historyFrom(parsed, 'kettle');
    expect(parseBlock(h)).not.toBeNull();
  });
});

describe('card contract (zod) and honest labels', () => {
  const base = { id: 'pay_abcdef12', state: 'CAPTURED', items: [{ productId: 'kettle-classic', name: 'Kettle', quantity: 1, lineCents: 3200, image: 'kettle.webp' }], merchant: 'SaySafe Demo Shop (sandbox)', amountCents: 3200, currency: 'EUR', risk: null, approval: null, receipt: { captureId: 'CAP123456789XYZ', amount: '32.00', currency: 'EUR', payee: 'SaySafe Demo Shop (sandbox)', orderId: 'ORDER123456789', webhookConfirmed: false }, refund: { status: null, requestedAt: null, canRequest: true }, updatedAt: '2026-11-03 09:00:00', timeline: { label: 'x', events: [{ kind: 'buyer_approved', label: 'b', verified: true }] } };
  it('refuses unexpected server answers instead of showing them', () => {
    expect(() => parseServer(ServerPayment, { ...base, amountCents: -5 })).toThrow();
    expect(() => parseServer(ServerPayment, { ...base, id: '<img>' })).toThrow();
    expect(() => parseServer(ServerPayment, null)).toThrow();
  });
  it('webhook is verified only when the server flag says so', () => {
    const r = receiptFrom(parseServer(ServerPayment, base))!;
    expect(r.receipt.webhookConfirmed).toBe(false);
    expect(r.buyerApproved).toBe(true);
    expect(shortStatus('CAPTURED', { webhookConfirmed: false })).toMatchObject({ label: 'Captured', extra: 'Verification pending' });
    expect(shortStatus('CAPTURED', { webhookConfirmed: true }).extra).toBe('Webhook verified');
    expect(receiptFrom(parseServer(ServerPayment, { ...base, receipt: null, state: 'FAMILY_APPROVED' }))).toBeNull();
  });
  it('a refund request is never shown as a refund', () => {
    expect(refundFrom(parseServer(ServerPayment, base)).status).toBe('can_request');
    const asked = refundFrom(parseServer(ServerPayment, { ...base, refund: { status: 'REFUND_REQUESTED', requestedAt: '2026-11-03 09:01:00', canRequest: false } }));
    expect(asked.status).toBe('REFUND_REQUESTED');
    expect(shortStatus('REFUND_REQUESTED')).toMatchObject({ label: 'Refund requested', detail: 'Request sent — not refunded yet' });
    expect(refundFrom(parseServer(ServerPayment, { ...base, state: 'REFUNDED', refund: { status: 'REFUNDED', requestedAt: null, canRequest: false } })).status).toBe('REFUNDED');
    expect(parseBlock({ ...asked, status: 'refunded_maybe' })).toBeNull();
  });
  it('status labels', () => {
    expect(shortStatus('FAMILY_APPROVAL_PENDING').label).toBe('Waiting for family');
    expect(shortStatus('PAYER_APPROVAL_PENDING').label).toBe('Pending');
    expect(shortStatus('REFUNDED').label).toBe('Refunded');
    expect(shortStatus('CANCELLED', { approval: 'declined' })).toMatchObject({ label: 'Cancelled' });
    expect(truncateRef('ABCDEFGHIJKLMNOP')).toBe('ABCDEF…MNOP');
  });
  it('refund and search follow-ups', () => {
    expect(parseFollowup('I want a refund for my last payment', false)).toEqual({ kind: 'refund' });
    expect(parseFollowup('search my payments for kettle', false)).toEqual({ kind: 'search', q: 'kettle' });
    expect(parseFollowup('find my microwave purchase', false)).toEqual({ kind: 'search', q: 'microwave' });
    expect(parseFollowup('show my last payment', false)).toEqual({ kind: 'last_payment' });
  });
});

describe('example data can never be seeded into a hosted database', () => {
  it('refuses production, Render and remote Turso', () => {
    expect(refuseHostedSeed({ NODE_ENV: 'production' } as any)).toMatch(/production/);
    expect(refuseHostedSeed({ RENDER: 'true' } as any)).toMatch(/Render/);
    expect(refuseHostedSeed({ TURSO_DATABASE_URL: 'libsql://saysafe.turso.io' } as any)).toMatch(/remote/);
    expect(refuseHostedSeed({ TURSO_DATABASE_URL: 'http://127.0.0.1:8080' } as any)).toBeNull();
    expect(refuseHostedSeed({} as any)).toBeNull();
  });
});
