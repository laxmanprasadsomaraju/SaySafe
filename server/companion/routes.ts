/**
 * Payment companion HTTP API. Elder-only and household-scoped: the household always comes from the elder's
 * session cookie, never from the request. A family session gets 403. Nothing is logged or audited.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'node:crypto';
import { z } from 'zod';
import { readSession, sessionOf } from '../auth.js';
import * as store from './store.js';
import { searchPayments } from './match.js';
import {
  ManualPaymentInput, ManualPaymentPatch, PaymentSearchQuery, SubscriptionInput, SubscriptionPatch, SubscriptionStatusChange,
  ContactInput, ContactPatch, COMPANION_LABELS,
} from '../../shared/companion.js';
import { CANCEL_GUIDES, GENERIC_CANCEL_STEPS, CANCEL_GUIDES_VERIFIED_ON, getCancelGuide } from '../../shared/cancelGuides.js';
import { DemoCancelBody, PAYPAL_AUTOPAY_URL, PAYPAL_AUTOPAY_HELP_URL } from '../../shared/companion.js';
import * as demo from './demoMembership.js';

/** Elder session required. A signed-in family member gets 403 (these records are private to the elder). */
export function requireElderOnly(req: Request, res: Response, next: NextFunction) {
  const s = readSession(req, 'elder');
  if (s) { (req as any).session = s; return next(); }
  if (readSession(req, 'family')) return res.status(403).json({ error: 'elder_only', message: 'These records are private to the person who saved them.' });
  return res.status(401).json({ error: 'not_signed_in', role: 'elder' });
}

const idParam = (req: Request) => z.string().regex(/^[a-z]{3,4}_[A-Za-z0-9_-]{6,40}$/).parse(req.params.id);

export function registerCompanion(app: Express, opts: { originOf: (req: Request) => string }) {
  const sessionKey = (req: Request) => String(req.cookies?.ss_elder ?? req.cookies?.ss_family ?? '');
  const limiter = rateLimit({
    windowMs: 60_000, limit: Number(process.env.COMPANION_LIMIT_PER_MIN ?? 60), standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (sessionKey(req) ? `c:${crypto.createHash('sha256').update(sessionKey(req)).digest('hex').slice(0, 32)}` : `ip:${ipKeyGenerator(req.ip ?? '')}`),
    message: { error: 'rate_limited', message: 'Please wait a moment and try again.' },
  });
  const base = '/api/companion';
  app.use(base, limiter, requireElderOnly, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const hh = (req: Request) => sessionOf(req).householdId;
  const me = (req: Request) => sessionOf(req).userId;

  // ----- Manual payment records -----
  app.get(`${base}/payments`, (req, res) => { res.json({ payments: store.listManualPayments(hh(req)), label: COMPANION_LABELS.manual }); });
  app.post(`${base}/payments`, (req, res) => { res.status(201).json(store.createManualPayment(hh(req), me(req), ManualPaymentInput.parse(req.body ?? {}))); });
  // search must be registered before /payments/:id
  app.get(`${base}/payments/search`, (req, res) => {
    const q = PaymentSearchQuery.parse(req.query ?? {});
    if (q.from && q.to && q.from > q.to) return res.status(400).json({ error: 'invalid_input', message: 'The start date is after the end date.' });
    res.json(searchPayments(store.paymentCandidates(hh(req)), { q: q.q, amountCents: q.amount != null ? Math.round(q.amount * 100) : null, from: q.from, to: q.to }));
  });
  app.get(`${base}/payments/:id`, (req, res) => { res.json(store.getManualPayment(hh(req), idParam(req))); });
  app.patch(`${base}/payments/:id`, (req, res) => { res.json(store.updateManualPayment(hh(req), idParam(req), ManualPaymentPatch.parse(req.body ?? {}))); });
  app.delete(`${base}/payments/:id`, (req, res) => { store.deleteManualPayment(hh(req), idParam(req)); res.json({ ok: true }); });

  // ----- Subscriptions (prototype) -----
  app.get(`${base}/subscriptions`, (req, res) => { res.json({ subscriptions: store.listSubscriptions(hh(req)), label: COMPANION_LABELS.prototype }); });
  app.get(`${base}/subscriptions/summary`, (req, res) => { res.json(store.summarise(store.listSubscriptions(hh(req)))); });
  app.get(`${base}/cancel-guides`, (_req, res) => { res.json({ guides: CANCEL_GUIDES, genericSteps: GENERIC_CANCEL_STEPS, verifiedOn: CANCEL_GUIDES_VERIFIED_ON }); });
  // ----- SaySafe Demo Membership (PayPal sandbox subscription). Registered before /subscriptions/:id. -----
  const demoLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `d:${crypto.createHash('sha256').update(sessionKey(req)).digest('hex').slice(0, 32)}`, message: { error: 'rate_limited', message: 'Please wait a moment and try again.' } });
  app.post(`${base}/subscriptions/demo/start`, demoLimiter, async (req, res) => { res.status(201).json(await demo.startDemo(hh(req), me(req), opts.originOf(req))); });
  app.get(`${base}/subscriptions/demo/status`, async (req, res) => { res.json({ subscription: await demo.refreshDemo(hh(req)), configured: demo.demoConfigured() }); });
  // PayPal sends the buyer back here (top-level GET, so the SameSite=Lax elder cookie is present). Read PayPal, then go to the app.
  app.get(`${base}/subscriptions/demo/return`, async (req, res) => {
    let state = req.query.declined ? 'declined' : 'returned';
    try { const v = await demo.refreshDemo(hh(req), { force: true }); if (v?.paypal?.status) state = v.paypal.status.toLowerCase(); } catch { state = 'check_failed'; }
    res.redirect(303, `/assistant?membership=${encodeURIComponent(state)}`);
  });
  app.post(`${base}/subscriptions/demo/cancel-intent`, demoLimiter, async (req, res) => { res.json(await demo.cancelIntent(hh(req))); });
  app.post(`${base}/subscriptions/demo/cancel`, demoLimiter, async (req, res) => {
    const { token } = DemoCancelBody.parse(req.body ?? {});
    const out = await demo.cancelDemo(hh(req), token);
    res.status(out.outcome === 'retry_needed' ? 202 : 200).json(out);
  });

  app.post(`${base}/subscriptions`, (req, res) => { res.status(201).json(store.createSubscription(hh(req), me(req), SubscriptionInput.parse(req.body ?? {}))); });
  app.get(`${base}/subscriptions/:id`, (req, res) => { res.json(store.getSubscription(hh(req), idParam(req))); });
  app.patch(`${base}/subscriptions/:id`, (req, res) => { res.json(store.updateSubscription(hh(req), idParam(req), SubscriptionPatch.parse(req.body ?? {}))); });
  app.post(`${base}/subscriptions/:id/status`, (req, res) => { res.json(store.changeSubscriptionStatus(hh(req), idParam(req), SubscriptionStatusChange.parse(req.body ?? {}))); });
  // Help me cancel (EXTERNAL subscriptions): the official link + PayPal automatic payments page. Marks "instructions_opened".
  app.post(`${base}/subscriptions/:id/cancel-help`, (req, res) => {
    const id = idParam(req);
    let sub = store.getSubscription(hh(req), id);
    if (sub.source !== 'manual') return res.status(409).json({ error: 'paypal_managed', message: 'The SaySafe Demo Membership is cancelled with the confirmation card, not here.' });
    if (sub.status === 'tracking') sub = store.changeSubscriptionStatus(hh(req), id, { to: 'instructions_opened' });
    const g = getCancelGuide(sub.guide?.id);
    res.json({
      subscription: sub,
      guide: g ? { id: g.id, name: g.name, url: g.url, steps: g.steps, note: g.note, verifiedOn: g.verifiedOn } : null,
      genericSteps: g ? [] : GENERIC_CANCEL_STEPS,
      paypalAutopay: { url: PAYPAL_AUTOPAY_URL, helpUrl: PAYPAL_AUTOPAY_HELP_URL, text: 'If you pay this company through PayPal, you can stop PayPal paying them here (sign in to PayPal yourself). That stops the PayPal payments; it does not end your contract with the company.' },
      cancellationScope: sub.cancellationScope,
      next: 'When the company confirms, you can tell SaySafe it is cancelled. SaySafe will show it as "You told SaySafe this is cancelled — not confirmed by the provider".',
    });
  });
  app.post(`${base}/subscriptions/:id/stop-tracking`, (req, res) => { res.json(store.setTracking(hh(req), idParam(req), false)); });
  app.post(`${base}/subscriptions/:id/resume-tracking`, (req, res) => { res.json(store.setTracking(hh(req), idParam(req), true)); });
  app.delete(`${base}/subscriptions/:id`, (req, res) => { store.deleteSubscription(hh(req), idParam(req)); res.json({ ok: true }); });

  // ----- Trusted contacts -----
  app.get(`${base}/contacts`, (req, res) => { res.json({ contacts: store.listContacts(hh(req)), label: COMPANION_LABELS.contact }); });
  app.post(`${base}/contacts`, (req, res) => { res.status(201).json(store.createContact(hh(req), me(req), ContactInput.parse(req.body ?? {}))); });
  app.get(`${base}/contacts/:id`, (req, res) => { res.json(store.getContact(hh(req), idParam(req))); });
  app.patch(`${base}/contacts/:id`, (req, res) => { res.json(store.updateContact(hh(req), idParam(req), ContactPatch.parse(req.body ?? {}))); });
  app.delete(`${base}/contacts/:id`, (req, res) => { store.deleteContact(hh(req), idParam(req)); res.json({ ok: true }); });

  // ----- Delete everything (payment records, subscriptions, contacts). Demo Shop payments are not touched. -----
  app.delete(`${base}/all`, (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body ?? {});
    res.json({ ok: true, deleted: store.deleteAllCompanionData(hh(req)) });
  });
}
