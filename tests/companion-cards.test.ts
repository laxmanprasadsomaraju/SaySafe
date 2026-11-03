/**
 * Payment companion CARDS (phase 2): every server answer a card is built from passes the web schemas, the card
 * builders produce registry-valid blocks, the honest labels hold (user-reported vs provider-confirmed), a spoken
 * "yes" never cancels, and the cards never reach the family view. PayPal is a TEST DOUBLE; AI is off.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.hoisted(() => { process.env.PAYPAL_DEMO_PLAN_ID = 'P-TESTPLAN'; process.env.COMPANION_LIMIT_PER_MIN = '1000'; process.env.API_LIMIT_PER_MIN = '5000'; });

const subs = new Map<string, any>();
let cancelMode: 'ok' | '500' = 'ok';
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(), getOrder: vi.fn(), captureOrder: vi.fn(), getCapture: vi.fn(), refundCapture: vi.fn(), getRefund: vi.fn(),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: () => null,
  createSubscription: vi.fn(async (a: any) => {
    const id = 'I-' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const s = { id, status: 'APPROVAL_PENDING', custom_id: a.customId, links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${id}` }] };
    subs.set(id, s); return s;
  }),
  getSubscription: vi.fn(async (id: string) => ({ ...subs.get(id) })),
  cancelSubscription: vi.fn(async (id: string) => {
    if (cancelMode === '500') throw Object.assign(new Error('500'), { status: 500, data: { name: 'INTERNAL_SERVER_ERROR' } });
    subs.get(id).status = 'CANCELLED'; return null;
  }),
  subscriptionApproveLink: (s: any) => s?.links?.find((l: any) => l.rel === 'approve')?.href ?? null,
}));

import { createApp } from '../server/app';
import { parseBlock, parseServer, restoreThread } from '../web/src/assistant/schemas';
import {
  ServerPaymentsList, ServerSubsList, ServerContactsList, ServerDemoStatus, ServerDemoStart, ServerCancelIntent, ServerCancelResult, ServerCancelHelp,
  helpFromCancelHelp, cancelCardFrom, cancelPhase, searchQueryString, parseAmount, telHref, mailHref, looksCompanion, shortSpoken, isCompanionKind,
  UI_LABEL, TAP_ONLY_REPLY,
} from '../web/src/assistant/companion';
import { parseFollowup } from '../web/src/assistant/followups';
import { PaymentSearchResult, SubscriptionSummary, Subscription, DEMO_MEMBERSHIP, SUB_STATUS_LABEL } from '../shared/companion';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
async function elder() { const a = request.agent(app); await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200); return a; }
const say = (a: any, text: string) => a.post('/api/assistant').set(H).send({ text, step: 'home' }).expect(200).then((r: any) => r.body);

describe('payment cards', () => {
  it('"Did I already pay John €80?": partial name + repeated amount -> a valid card with badges, reasons, caveats, guidance', async () => {
    const a = await elder();
    await a.post('/api/companion/payments').set(H).send({ recipient: 'John Smith', amountCents: 8000, paidOn: '2026-10-01', method: 'bank_transfer' }).expect(201);
    await a.post('/api/companion/payments').set(H).send({ recipient: 'Mary-Kate Byrne', amountCents: 8000, paidOn: '2026-10-12', method: 'cash' }).expect(201);
    const r = await say(a, 'Did I already pay John €80?');
    const card = parseBlock(r.companion);
    expect(card?.kind).toBe('payment_matches');
    if (card?.kind !== 'payment_matches') throw new Error('no card');
    const top = card.result.matches[0];
    expect(top.recipient).toBe('John Smith');
    expect(top.source).toBe('manual');
    expect(top.caveats.join(' ')).toMatch(/partial|first name/i);
    expect(top.caveats.join(' ')).toMatch(/more than once|different one/i);
    expect(card.result.guidance).toMatch(/Don't pay again until you've checked with John/);
    // Re-running the same search from the card (after an edit) uses the same query.
    const qs = searchQueryString(card.result.query);
    expect(qs).toContain('q=John'); expect(qs).toContain('amount=80.00');
    const again = parseServer(PaymentSearchResult, (await a.get(`/api/companion/payments/search?${qs}`).expect(200)).body);
    expect(again.matches[0].id).toBe(top.id);
    // Edit + delete are reflected.
    await a.patch(`/api/companion/payments/${top.id}`).set(H).send({ note: 'garden' }).expect(200);
    const list = parseServer(ServerPaymentsList, (await a.get('/api/companion/payments').expect(200)).body);
    expect(list.payments.find((p) => p.id === top.id)?.note).toBe('garden');
    await a.delete(`/api/companion/payments/${top.id}`).expect(200);
    const after = parseServer(PaymentSearchResult, (await a.get(`/api/companion/payments/search?${qs}`).expect(200)).body);
    expect(after.matches.find((m) => m.id === top.id)).toBeUndefined();
  });
  it('last payment card validates', async () => {
    const a = await elder();
    await a.post('/api/companion/payments').set(H).send({ recipient: 'John Smith', amountCents: 2500, paidOn: '2026-10-20', method: 'cash' }).expect(201);
    const r = await say(a, 'When was my last payment to John?');
    expect(parseBlock(r.companion)?.kind).toBe('last_payment');
  });
  it('amounts, links and routing helpers', () => {
    expect(parseAmount('80')).toBe(8000); expect(parseAmount('€80,50')).toBe(8050); expect(parseAmount('abc')).toBeNull(); expect(parseAmount('0')).toBeNull();
    expect(telHref('+353 (87) 123-4567')).toBe('tel:+353871234567'); expect(telHref('javascript:alert(1)')).toBeNull();
    expect(mailHref('tom@example.ie')).toBe('mailto:tom@example.ie'); expect(mailHref('x" onclick=1')).toBeNull();
    expect(looksCompanion('Did I already pay John €80?')).toBe(true);
    expect(looksCompanion('What do I pay every month?')).toBe(true);
    expect(looksCompanion('show my payments')).toBe(false);
    // "last payment to John" is the companion, not the Demo Shop receipt follow-up.
    expect(parseFollowup('my last payment to John', false).kind).toBe('none');
    expect(parseFollowup('show my last payment', false).kind).toBe('last_payment');
    expect(shortSpoken('One. Two. Three. Four.')).toBe('One. Two.');
  });
});

describe('subscription cards', () => {
  it('totals, external cancel handoff labelled user-reported (never provider-confirmed)', async () => {
    const a = await elder();
    const nf = (await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Netflix', amountCents: 1299, frequency: 'monthly', nextOn: '2026-11-20' }).expect(201)).body;
    await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Spotify', amountCents: 1099, frequency: 'monthly' }).expect(201);
    await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Garden Club', amountCents: 6000, frequency: 'yearly' }).expect(201);
    const sum = parseServer(SubscriptionSummary, (await a.get('/api/companion/subscriptions/summary').expect(200)).body);
    expect(sum.totals).toEqual([{ currency: 'EUR', count: 3, monthlyCents: 2898, annualCents: 34776 }]);
    expect(parseBlock({ kind: 'monthly_costs', summary: sum })).not.toBeNull();
    const list = parseServer(ServerSubsList, (await a.get('/api/companion/subscriptions').expect(200)).body);
    expect(list.subscriptions).toHaveLength(3);

    // Voice: "cancel my Netflix" -> official link card with the tracked subscription.
    const v = await say(a, 'cancel my Netflix subscription');
    const help = parseBlock(v.companion);
    if (help?.kind !== 'subscription_help') throw new Error('no help card');
    expect(help.guide?.url).toBe('https://help.netflix.com/en/node/407');
    expect(help.subscription?.id).toBe(nf.id);
    // Tap: Help me cancel -> the same card shape.
    const h = parseServer(ServerCancelHelp, (await a.post(`/api/companion/subscriptions/${nf.id}/cancel-help`).set(H).send({}).expect(200)).body);
    const tapCard = parseBlock(helpFromCancelHelp(h));
    expect(tapCard?.kind).toBe('subscription_help');
    // "I've cancelled it" -> user_reported_cancelled with the exact label; not counted any more.
    const s = parseServer(Subscription, (await a.post(`/api/companion/subscriptions/${nf.id}/status`).set(H).send({ to: 'user_reported_cancelled', note: 'email 3 Nov' }).expect(200)).body);
    expect(s.status).toBe('user_reported_cancelled');
    expect(s.statusLabel).toBe(UI_LABEL.userReported);
    expect(SUB_STATUS_LABEL.user_reported_cancelled).toBe(UI_LABEL.userReported);
    expect(s.confirmedBy).toBe('user');
    const sum2 = parseServer(SubscriptionSummary, (await a.get('/api/companion/subscriptions/summary').expect(200)).body);
    expect(sum2.totals[0].count).toBe(2);
    expect(sum2.excluded.userReportedCancelled).toBe(1);
    // A card can never claim the provider confirmed an external cancellation.
    await a.post(`/api/companion/subscriptions/${nf.id}/status`).set(H).send({ to: 'provider_confirmed' }).expect(400);
  });

  it('Demo Membership: start -> approve link; cancel needs the token tap; a spoken "yes" never cancels; success only on provider_confirmed', async () => {
    const a = await elder();
    const st = parseServer(ServerDemoStart, (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body);
    expect(st.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    subs.get(st.subscription.paypal!.subscriptionId).status = 'ACTIVE';
    // PayPal sends the buyer back: the return route re-reads PayPal and lands on /assistant?membership=active.
    const back = await a.get('/api/companion/subscriptions/demo/return').expect(303);
    expect(back.headers.location).toBe('/assistant?membership=active');
    const status = parseServer(ServerDemoStatus, (await a.get('/api/companion/subscriptions/demo/status').expect(200)).body);
    expect(status.subscription?.paypal?.status).toBe('ACTIVE');
    expect(parseBlock({ kind: 'demo_membership', returned: 'active' })).not.toBeNull();

    // The assistant only produces the confirmation card.
    const v = await say(a, 'cancel my demo membership');
    const card = parseBlock(v.companion);
    if (card?.kind !== 'demo_cancel_intent') throw new Error('no cancel card');
    expect(card.confirmText).toBe(DEMO_MEMBERSHIP.cancelConfirmText);
    expect(card.phase).toBe('confirm');
    // "yes" afterwards: no cancel path (the Assistant answers TAP_ONLY_REPLY on the device).
    const yes = await say(a, 'yes');
    expect(yes.intent.action).toBe('confirm');
    expect(yes.companion).toBeUndefined();
    expect(subs.get(st.subscription.paypal!.subscriptionId).status).toBe('ACTIVE');
    expect(TAP_ONLY_REPLY).toMatch(/tap/);

    // PayPal 500 -> retry_needed, nothing confirmed; Retry needs a NEW intent and a new tap.
    cancelMode = '500';
    const fail = await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: card.token }).expect(202);
    expect(cancelPhase(parseServer(ServerCancelResult, fail.body))).toBe('retry_needed');
    await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: card.token }).expect(409); // single use
    cancelMode = 'ok';
    const it2 = parseServer(ServerCancelIntent, (await a.post('/api/companion/subscriptions/demo/cancel-intent').set(H).send({}).expect(200)).body);
    const fresh = parseBlock(cancelCardFrom(it2));
    expect(fresh?.kind === 'demo_cancel_intent' && fresh.phase).toBe('confirm');
    const ok = parseServer(ServerCancelResult, (await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: it2.token }).expect(200)).body);
    expect(ok.subscription.status).toBe('provider_confirmed');
    expect(cancelPhase(ok)).toBe('confirmed');
    // A forged "confirmed" answer without provider_confirmed is still not a success.
    expect(cancelPhase({ ...ok, subscription: { ...ok.subscription, status: 'cancellation_requested' } })).toBe('retry_needed');
    // After the tap the saved card carries no token.
    expect(parseBlock({ ...fresh, token: '', phase: 'confirmed' })).not.toBeNull();
    // Tampered confirmation text is rejected.
    expect(parseBlock({ ...fresh, confirmText: 'Cancel everything' })).toBeNull();
  });
});

describe('trusted contact cards', () => {
  it('lookup card validates; the scam card carries the contact_mismatch evidence', async () => {
    const a = await elder();
    await a.post('/api/companion/contacts').set(H).send({ name: 'Tom', relation: 'son', phone: '+353 87 123 4567' }).expect(201);
    const r = await say(a, "What's my son's number?");
    const card = parseBlock(r.companion);
    if (card?.kind !== 'contact_card') throw new Error('no contact card');
    expect(card.contacts[0].name).toBe('Tom');
    expect(card.contacts[0].label).toBe(UI_LABEL.contact);
    expect(parseServer(ServerContactsList, (await a.get('/api/companion/contacts').expect(200)).body).contacts).toHaveLength(1);
    const scan = (await a.post('/api/scan').set(H).send({ text: 'Hi Mum it’s Tom, this is my new number 087 999 1111. Can you send €200 today?' }).expect(200)).body;
    const block = parseBlock({ kind: 'scam_result', scanId: scan.scanId, verdict: scan.verdict, headline: scan.headline, summary: scan.spokenSummary, signals: scan.signals.slice(0, 8).map((s: any) => ({ severity: s.severity, title: s.title, detail: s.detail, ...(s.evidence ? { evidence: s.evidence.slice(0, 300) } : {}), code: s.code })), safeActions: scan.safeActions.slice(0, 4), aiNotice: scan.aiNotice ?? null });
    if (block?.kind !== 'scam_result') throw new Error('no scam card');
    const m = block.signals.find((s) => s.code === 'contact_mismatch');
    expect(m?.title).toMatch(/from Tom, but the number isn't the one you saved/);
    expect(m?.detail).toMatch(/ending 4567/);
  });
});

describe('never in the family view', () => {
  it('family restore drops every companion card; family sessions get 403', async () => {
    const saved = JSON.stringify({ v: 1, mode: 'chat', focusId: null, messages: [{ id: 'm1', role: 'assistant', text: 'x', blocks: [{ kind: 'companion_records', section: 'contacts' }, { kind: 'trusted_links', items: [{ label: 'Help', to: '/help' }] }] }] });
    const t = restoreThread(saved, { drop: (b) => isCompanionKind(b.kind) })!;
    expect(t.messages[0].blocks.map((b) => b.kind)).toEqual(['trusted_links']);
    const mary = await elder();
    const { body } = await mary.post('/api/family/invite').set(H).send({}).expect(200);
    const f = request.agent(app);
    await f.post('/api/family/pair').set(H).send({ code: body.code, name: 'Alex' }).expect(200);
    for (const p of ['/api/companion/payments', '/api/companion/subscriptions', '/api/companion/contacts', '/api/companion/subscriptions/demo/status']) await f.get(p).expect(403);
    const fam = (await f.post('/api/assistant').set(H).send({ text: 'Did I already pay John €80?' }).expect(200)).body;
    expect(fam.companion?.kind ?? 'companion_sign_in').toBe('companion_sign_in');
  });
});
