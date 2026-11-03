import { searchChannel3, Channel3Error, channel3Configured } from './catalogue/channel3.js';
import { parseRequest, recommend, spokenRecommendation, sanitizeProfile, profileIsEmpty } from '../shared/shopping.js';
import { getProfile, saveProfile, clearProfile } from './prefs/store.js';
import { explainBest } from './ai/explain.js';
import { normaliseLang } from '../shared/lang.js';
import { dropTranscript } from '../shared/voice.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, audit, dbConfig } from './db/index.js';
import { startDemoHousehold, createPairingCode, redeemPairingCode, requireRole, readSession, sessionOf, logout, newId } from './auth.js';
import { scanMessage, extractFromImage, explainMore } from './scam/guardian.js';
import { TRUSTED_DOMAINS, TRUSTED_EMAILS, TRUSTED_HELP_PAGES } from './scam/directory.js';
import { normalizeVerdict, VERDICT_LABEL } from './scam/verdicts.js';
import { PRODUCTS, searchProducts, getProduct } from './catalogue/products.js';
import { interpret, describeOptions, eur } from './ai/agent.js';
import { transcribe, health as aiHealth, aiConfigured, AIUnavailableError } from './ai/provider.js';
import * as pay from './payments/service.js';
import { paypalConfigured, verifyWebhook, getOrder as getPayPalOrder } from './paypal/client.js';
import { SAMPLE_MESSAGES } from './scam/samples.js';
import { reconcileForUser, sweepWithin, finishApproved } from './payments/reconcile.js';
import { buildTimeline } from './payments/timeline.js';
import { adminRefund, checkAdminToken, refundFromWebhook, requestRefund, ensureCaptureVerified, ADMIN_HEADER, REFUNDS_DISABLED_MESSAGE } from './payments/refund.js';
import { reconcile as reconcilePayment } from './payments/reconcile.js';
import { guardModelText } from './ai/outputGuard.js';
import { buildInsights } from './insights/model.js';
import { answerInsightsQuestion } from './insights/agent.js';
import { insightsConfig } from './insights/config.js';

export const AI_RULES_ONLY = 'AI unavailable — rule checks only';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.trychannel3.com'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://www.sandbox.paypal.com', 'https://www.paypal.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cookieParser());

  // Webhook needs the raw body for signature verification: register before json parser.
  app.post('/api/paypal/webhook', express.raw({ type: 'application/json', limit: '200kb' }), async (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    let event: any;
    try { event = JSON.parse(raw); } catch { return res.status(400).end(); }
    let verified = false;
    try { verified = await verifyWebhook(req.headers as any, raw); } catch { verified = false; }
    const id = String(event?.id ?? '');
    if (!id) return res.status(400).end();
    if (!verified) return res.status(400).json({ error: 'unverified' }); // never act on (or store) unverified events
    // Store only what reconciliation and the receipt timeline need: no payer name, email or address.
    const resource = event?.resource ?? {};
    const minimal = {
      id, event_type: String(event.event_type ?? ''), resource_type: event.resource_type ?? null, resource_id: String(resource.id ?? ''),
      status: resource.status ?? null, amount: resource.amount?.value ?? null, currency: resource.amount?.currency_code ?? null,
      custom_id: resource.custom_id ?? resource.purchase_units?.[0]?.custom_id ?? null, order_id: resource.supplementary_data?.related_ids?.order_id ?? null,
      // Refund events: the capture this refund belongs to (from the refund's `up` link).
      capture_id: (resource.links ?? []).find((l: any) => l?.rel === 'up')?.href?.match(/\/v2\/payments\/captures\/([A-Z0-9]+)$/)?.[1] ?? null,
      create_time: event.create_time ?? null, resource_create_time: resource.create_time ?? null,
    };
    const ins = db.prepare('INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, verified, payload_json) VALUES (?,?,?,1,?)').run(id, minimal.event_type, minimal.resource_id, JSON.stringify(minimal));
    if (ins.changes === 0) return res.status(200).json({ ok: true, duplicate: true });
    const outcome = minimal.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? refundFromWebhook(event) : pay.reconcileFromWebhook(event);
    res.json({ ok: true, outcome });
  });

  app.use(express.json({ limit: '100kb' }));

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const recoverLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const aiLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message: 'Please wait a moment before asking again.' } });
  // Per-session limit on AI routes on top of the per-IP one (several people can share an IP; one session cannot bypass by rotating IPs).
  const aiSessionKey = (req: Request) => String(req.cookies?.ss_elder ?? req.cookies?.ss_family ?? '');
  const aiSessionLimiter = rateLimit({
    windowMs: 60_000, limit: Number(process.env.AI_SESSION_LIMIT_PER_MIN ?? 15), standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (aiSessionKey(req) ? `s:${crypto.createHash('sha256').update(aiSessionKey(req)).digest('hex').slice(0, 32)}` : `ip:${ipKeyGenerator(req.ip ?? '')}`),
    message: { error: 'rate_limited', message: 'Please wait a moment before asking again.' },
  });
  const AI_PATHS = new Set(['/api/scan', '/api/scan/image', '/api/scan/explain', '/api/voice/transcribe', '/api/assistant', '/api/discover', '/api/family/insights/agent']);
  app.use((req, res, next) => (req.method === 'POST' && AI_PATHS.has(req.path) ? aiSessionLimiter(req, res, next) : next()));
  app.use('/api', apiLimiter);

  // CSRF: state-changing API calls must come from our own origin (cookies are SameSite=Lax too).
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'bad_origin' });
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'bad_origin' });
      } catch { return res.status(403).json({ error: 'bad_origin' }); }
    }
    next();
  });

  /** Reply language (beta), whitelisted: en, es, pl, fr, de, pt. Anything else is English. */
  const langOf = (req: Request) => normaliseLang(req.get('x-saysafe-lang') ?? req.body?.lang);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
  const originOf = (req: Request) => process.env.PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`;
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

  // ---------- Status ----------
  app.get('/api/health', wrap(async (_req, res) => {
    res.json({ ok: true, paypal: { configured: paypalConfigured(), env: 'sandbox' }, ai: await aiHealth(), channel3: { configured: channel3Configured() }, insights: insightsConfig().enabled, insightsDashboard: insightsConfig().dashboard, db: { mode: dbConfig.mode, persistent: dbConfig.mode !== 'local' }, time: new Date().toISOString() });
  }));
  app.get('/api/config', (_req, res) => res.json({ paypalConfigured: paypalConfigured(), aiConfigured: aiConfigured(), channel3Configured: channel3Configured(), insights: insightsConfig().enabled, insightsDashboard: insightsConfig().dashboard, demo: true }));

  // ---------- Sessions ----------
  app.post('/api/demo/start', (req, res) => {
    const name = z.string().trim().min(1).max(40).catch('Mary').parse(req.body?.name);
    const { householdId } = startDemoHousehold(res, name);
    res.json({ ok: true, householdId: householdId.slice(0, 6) });
  });
  app.get('/api/me', (req, res) => {
    const elder = readSession(req, 'elder');
    const family = readSession(req, 'family');
    res.json({ elder: elder && { name: elder.name }, family: family && { name: family.name } });
  });
  app.post('/api/logout', (req, res) => { logout(req, res, req.body?.role === 'family' ? 'family' : 'elder'); res.json({ ok: true }); });

  app.post('/api/family/invite', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    res.json(createPairingCode(s.householdId, s.userId));
  });
  const pairLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10 });
  app.post('/api/family/pair', pairLimiter, (req, res) => {
    const code = String(req.body?.code ?? '');
    const name = z.string().trim().min(1).max(40).catch('Alex').parse(req.body?.name);
    const r = redeemPairingCode(res, code, name);
    if (!r) return res.status(400).json({ error: 'bad_code', message: 'That code is wrong or has expired. Ask for a new one.' });
    res.json({ ok: true });
  });

  // ---------- Scam guardian ----------
  app.get('/api/trusted', (_req, res) => res.json({ domains: TRUSTED_DOMAINS, emails: TRUSTED_EMAILS, helpPages: TRUSTED_HELP_PAGES }));
  app.get('/api/samples', (_req, res) => res.json(SAMPLE_MESSAGES));

  app.post('/api/scan', aiLimiter, wrap(async (req, res) => {
    const s = readSession(req, 'elder');
    const text = z.string().trim().min(1).max(8000).parse(req.body?.text);
    const result = await scanMessage(text, { userName: s?.name ?? 'Mary', lang: langOf(req) });
    const scanId = newId('scan');
    db.prepare('INSERT INTO security_scans (id, household_id, verdict, summary) VALUES (?,?,?,?)').run(scanId, s?.householdId ?? null, result.verdict, result.headline);
    res.json({ scanId, ...result, aiNotice: result.ai.used ? null : AI_RULES_ONLY });
  }));

  app.post('/api/scan/image', aiLimiter, upload.single('image'), wrap(async (req, res) => {
    const s = readSession(req, 'elder');
    const f = (req as any).file as Express.Multer.File | undefined;
    if (!f) return res.status(400).json({ error: 'no_image' });
    const sig = f.buffer.subarray(0, 12).toString('hex');
    const mime = sig.startsWith('89504e47') ? 'image/png' : sig.startsWith('ffd8ff') ? 'image/jpeg' : sig.startsWith('52494646') && f.buffer.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
    if (!mime) return res.status(400).json({ error: 'bad_image', message: 'Please upload a PNG, JPEG or WebP screenshot.' });
    if (!aiConfigured()) return res.status(503).json({ error: 'ai_unavailable', message: 'Screenshot reading is not available right now. You can paste the text instead.' });
    let extracted: Awaited<ReturnType<typeof extractFromImage>>;
    try { extracted = await extractFromImage(`data:${mime};base64,${f.buffer.toString('base64')}`); }
    catch { return res.status(503).json({ error: 'ai_unavailable', aiNotice: AI_RULES_ONLY, message: 'Screenshot reading is not available right now. You can paste the text instead, and I will run the rule checks.' }); }
    // The image is processed in memory and never stored.
    const result = await scanMessage(extracted.text, { userName: s?.name ?? 'Mary', extractedFromImage: true, ocrUncertain: extracted.uncertain, lang: langOf(req) });
    const scanId = newId('scan');
    db.prepare('INSERT INTO security_scans (id, household_id, verdict, summary) VALUES (?,?,?,?)').run(scanId, s?.householdId ?? null, result.verdict, result.headline);
    res.json({ scanId, ...result, aiNotice: result.ai.used ? null : AI_RULES_ONLY, extractedText: extracted.text });
  }));

  app.post('/api/scan/:id/share', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    const info = db.prepare('UPDATE security_scans SET shared_with_family=1 WHERE id=? AND household_id=?').run(String(req.params.id), s.householdId);
    if (!info.changes) return res.status(404).json({ error: 'not_found' });
    audit(s.householdId, s.userId, 'scan.shared', String(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/scan/explain', aiLimiter, wrap(async (req, res) => {
    const q = z.string().trim().min(1).max(300).parse(req.body?.question);
    const scan = req.body?.scan;
    const safe = 'Please do not use links or numbers from that message. Open the PayPal app yourself, or ask your family member.';
    const lang = langOf(req);
    if (!aiConfigured() || !scan?.verdict) return res.json({ answer: safe, aiNotice: AI_RULES_ONLY });
    try { res.json({ answer: guardModelText(await explainMore(q, scan, readSession(req, 'elder')?.name, lang), safe), lang }); }
    catch { res.json({ answer: safe, aiNotice: AI_RULES_ONLY }); }
  }));

  // ---------- Voice + assistant ----------
  app.post('/api/voice/transcribe', aiLimiter, upload.single('audio'), wrap(async (req, res) => {
    const f = (req as any).file as Express.Multer.File | undefined;
    if (!f) return res.status(400).json({ error: 'no_audio' });
    try {
      // Tiny uploads are silence: never send them to Whisper (it answers silence with "Thank you.").
      if (f.size < 2000) return res.json({ text: '', dropped: 'too_short' });
      const voicedMs = z.coerce.number().min(0).max(60000).catch(0).parse(req.body?.voicedMs);
      const text = await transcribe(f.buffer, f.mimetype || 'audio/webm', f.originalname || 'speech.webm', langOf(req));
      const dropped = dropTranscript(text, voicedMs);
      res.json(dropped ? { text: '', dropped } : { text: text.trim() });
    } catch (e) {
      if (e instanceof AIUnavailableError) return res.status(503).json({ error: 'stt_unavailable', message: 'Voice is not available right now. You can type instead.' });
      throw e;
    }
  }));

  app.post('/api/assistant', aiLimiter, wrap(async (req, res) => {
    const s = readSession(req, 'elder');
    const name = s?.name ?? 'Mary';
    const said = z.string().trim().min(1).max(4000).refine((t) => /\p{L}/u.test(t)).parse(req.body?.text); // never call the AI on empty/punctuation
    const lastResults = z.array(z.string().max(100)).max(5).catch([]).parse(req.body?.lastResults);
    const step = z.string().max(40).catch('home').parse(req.body?.step);
    const lang = langOf(req);
    const { intent, ai, replyLang: aiLang } = await interpret(said, { name, lastResults, step, lang });
    let products: ReturnType<typeof searchProducts> = [];
    let reply = intent.reply;
    let replyLang = aiLang;
    let discover: { query: string; suggested: boolean } | null = null;
    if (intent.action === 'shop') {
      // Real-product questions go to Channel3 discovery (same rules as /discover). The Demo Shop flow is unchanged.
      const wantsReal = /\b(real (shops?|products?|listings?|prices?)|retailers?|other shops|currys|harvey norman|argos|did electrical|online shops?|compare (prices|shops)|in ireland)\b/i.test(said);
      if (wantsReal && channel3Configured()) {
        discover = { query: said, suggested: false };
        reply = "I'll look in listings found for Ireland. You'd buy on the shop's own website."; replyLang = 'en';
      } else {
        products = searchProducts(intent.query ?? said, intent.max_price_eur ? Math.round(intent.max_price_eur * 100) : null);
        // English template, unless the AI already answered in the chosen reply language.
        if (lang === 'en' || replyLang !== lang) { reply = describeOptions(products, name); replyLang = 'en'; }
        if (!products.length && channel3Configured()) { discover = { query: said, suggested: true }; reply = "That isn't in the demo shop. I can look in listings found for Ireland instead."; replyLang = 'en'; }
      }
    }
    res.json({ intent, products, reply, replyLang, ai, discover });
  }));

  // ---------- Recovery after a server restart (Render Free wipes SQLite) ----------
  // Read-only: asks PayPal what actually happened to an order this app created. Never captures, never creates.
  app.get('/api/paypal/orders/:orderId/status', recoverLimiter, wrap(async (req, res) => {
    const orderId = z.string().regex(/^[A-Z0-9]{10,30}$/).parse(req.params.orderId);
    let order: any;
    try { order = await getPayPalOrder(orderId); } catch { return res.status(404).json({ error: 'not_found', message: 'PayPal does not know this order.' }); }
    const pu = order?.purchase_units?.[0];
    if (typeof pu?.custom_id !== 'string' || !/^pay_[A-Za-z0-9_-]{6,40}$/.test(pu.custom_id)) return res.status(404).json({ error: 'not_found', message: 'This is not a SaySafe order.' });
    const cap = pu?.payments?.captures?.[0];
    res.json({
      source: 'paypal',
      orderId: order.id,
      orderStatus: order.status, // CREATED | APPROVED | COMPLETED | VOIDED ...
      requestId: pu.custom_id,
      amount: pu.amount?.value, currency: pu.amount?.currency_code,
      capture: cap ? { id: cap.id, status: cap.status, amount: cap.amount?.value, currency: cap.amount?.currency_code, time: cap.create_time } : null,
      localRecord: Boolean(db.prepare('SELECT 1 FROM payment_requests WHERE id=?').get(pu.custom_id)),
    });
  }));

  // ---------- Real product discovery (Channel3). Discovery only: purchases happen on the retailer's site. ----------
  app.post('/api/discover', aiLimiter, wrap(async (req, res) => {
    const s = readSession(req, 'elder');
    const said = z.string().trim().min(1).max(400).parse(req.body?.text);
    const overrideMax = z.number().positive().max(100000).nullable().catch(null).parse(req.body?.maxPrice ?? null);
    // Signed in: the profile comes only from this user's own row. No session: the browser's local copy, sanitised.
    const profile = s ? getProfile(s.userId) : sanitizeProfile(req.body?.profile);
    const parsed = parseRequest(said);
    let query = parsed.productQuery;
    let ai: boolean | undefined;
    if (!query) {
      const r = await interpret(said, { name: s?.name ?? 'Mary', step: 'discover' });
      ai = r.ai;
      query = (r.intent.action === 'shop' && r.intent.query) ? r.intent.query : said;
    }
    const maxPrice = overrideMax ?? parsed.budget.max;
    try {
      const result = await searchChannel3(query, { maxPrice, userId: s?.householdId });
      const rec = recommend(result.products, { ...parsed, budget: { max: maxPrice, min: parsed.budget.min } }, profile);
      const byId = new Map(result.products.map((p) => [p.id, p]));
      const products = rec.rankedIds.map((id) => byId.get(id)!);
      const best = rec.picks.find((p) => p.role === 'best');
      const explanation = best ? await explainBest(byId.get(best.id)!, best.reasons, profile, maxPrice) : null;
      res.json({ ...result, query: said.slice(0, 200), searchQuery: query, products, recommendation: rec, explanation, profileApplied: !profileIsEmpty(profile), reply: spokenRecommendation(products, rec, query), ai: ai ?? false });
    } catch (e) {
      if (!(e instanceof Channel3Error)) throw e;
      const status = e.code === 'not_configured' ? 503 : e.code === 'rate_limited' ? 429 : e.code === 'bad_request' ? 400 : 502;
      if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
      res.status(status).json({ error: `channel3_${e.code}`, products: [], message: `I couldn't get recommendations right now. ${e.message} The SaySafe Demo Shop still works.` });
    }
  }));

  // ---------- Private shopping profile (elder only; never shared with family, never logged) ----------
  app.get('/api/preferences', requireRole('elder'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ profile: getProfile(sessionOf(req).userId) });
  });
  app.put('/api/preferences', requireRole('elder'), (req, res) => {
    if (JSON.stringify(req.body ?? {}).length > 4096) return res.status(413).json({ error: 'too_large', message: 'That is too much to save. Please shorten your lists.' });
    res.set('Cache-Control', 'no-store');
    res.json({ profile: saveProfile(sessionOf(req).userId, req.body?.profile) });
  });
  app.delete('/api/preferences', requireRole('elder'), (req, res) => {
    clearProfile(sessionOf(req).userId);
    res.json({ ok: true });
  });

  // ---------- Shop ----------
  app.get('/api/products', (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 100);
    const max = req.query.max ? Math.round(Number(req.query.max) * 100) : null;
    res.json(q ? searchProducts(q, max, 6) : PRODUCTS);
  });
  app.get('/api/products/:id', (req, res) => {
    const p = getProduct(String(req.params.id));
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json(p);
  });
  app.post('/api/quote', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    const q = pay.priceCart(req.body?.items);
    const policy = pay.getPolicy(s.householdId);
    res.json({ ...q, needsFamily: q.totalCents > policy.thresholdCents, thresholdCents: policy.thresholdCents, fees: [], spoken: `That's ${q.lines.map((l) => l.name).join(' and ')} for ${eur(q.totalCents)} from ${q.merchant}.` });
  });

  // ---------- Payments (elder) ----------
  app.get('/api/payments', requireRole('elder'), wrap(async (req, res) => {
    const hh = sessionOf(req).householdId;
    await sweepWithin(hh); // lazy, rate-limited reconcile of this household's stale pending payments
    res.json(pay.listRequests(hh));
  }));
  app.get('/api/payments/:id', requireRole('elder'), wrap(async (req, res) => {
    const s = sessionOf(req);
    const q = () => db.prepare('SELECT * FROM payment_requests WHERE id=? AND household_id=?').get(String(req.params.id), s.householdId) as any;
    const first = q();
    if (!first) return res.status(404).json({ error: 'not_found' });
    await ensureCaptureVerified(first); // receipt timeline: Payments v2 capture read-back (bounded, at most once a minute)
    const r = q();
    res.json({ ...pay.publicView(r), timeline: buildTimeline(r) });
  }));
  // Buyer "Request a refund": records a REQUEST only (REFUND_REQUESTED). It never refunds and never calls PayPal.
  app.post('/api/payments/:id/refund-request', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    const view = requestRefund(s.householdId, s.userId, String(req.params.id), req.body?.reason);
    const r = db.prepare('SELECT * FROM payment_requests WHERE id=? AND household_id=?').get(view.id, s.householdId);
    res.json({ ...view, timeline: buildTimeline(r) });
  });
  // "Check with PayPal": read-only reconcile of one of this household's payments. Never captures.
  app.post('/api/payments/:id/reconcile', requireRole('elder'), recoverLimiter, wrap(async (req, res) => {
    const s = sessionOf(req);
    const out = await reconcileForUser(s.householdId, String(req.params.id));
    const r = db.prepare('SELECT * FROM payment_requests WHERE id=? AND household_id=?').get(out.request.id, s.householdId);
    res.json({ outcome: out.outcome, request: { ...out.request, timeline: buildTimeline(r) } });
  }));
  // Explicit user confirm for a buyer-approved payment whose redirect was lost. Repeats every check (PayPal order, amount, currency, family approval).
  app.post('/api/payments/:id/finish', requireRole('elder'), wrap(async (req, res) => {
    const s = sessionOf(req);
    res.json(await finishApproved(s.householdId, s.userId, String(req.params.id)));
  }));
  app.post('/api/payments', requireRole('elder'), wrap(async (req, res) => {
    const s = sessionOf(req);
    if (!paypalConfigured()) return res.status(503).json({ error: 'paypal_not_configured', message: 'PayPal sandbox is not connected yet.' });
    const out = await pay.createRequest(s.householdId, s.userId, req.body?.items, String(req.body?.idempotencyKey ?? ''), originOf(req));
    res.json(out);
  }));
  app.post('/api/payments/:id/checkout', requireRole('elder'), wrap(async (req, res) => {
    const s = sessionOf(req);
    const url = await pay.startPayPalCheckout(s.householdId, s.userId, String(req.params.id), originOf(req));
    res.json({ approveUrl: url });
  }));
  app.post('/api/payments/:id/confirm', requireRole('elder'), wrap(async (req, res) => {
    const s = sessionOf(req);
    const orderId = z.string().regex(/^[A-Z0-9]{10,30}$/).parse(req.body?.orderId);
    res.json(await pay.confirmAndCapture(s.householdId, s.userId, String(req.params.id), orderId));
  }));
  app.post('/api/payments/:id/cancel', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    res.json(pay.cancelRequest(s.householdId, s.userId, String(req.params.id)));
  });

  // ---------- Family ----------
  app.get('/api/family/overview', requireRole('family'), wrap(async (req, res) => {
    const s = sessionOf(req);
    await sweepWithin(s.householdId);
    const elder = db.prepare('SELECT u.name FROM households h JOIN users u ON u.id=h.elder_id WHERE h.id=?').get(s.householdId) as any;
    const rows = db.prepare('SELECT id, verdict, summary, created_at FROM security_scans WHERE household_id=? AND shared_with_family=1 ORDER BY created_at DESC LIMIT 10').all(s.householdId);
    // Older rows hold legacy verdict codes; always send the three public verdicts.
    const scans = (rows as { id: string; verdict: string; summary: string; created_at: string }[]).map((r) => ({ ...r, verdict: normalizeVerdict(r.verdict), verdictLabel: VERDICT_LABEL[normalizeVerdict(r.verdict)] }));
    res.json({ me: { name: s.name }, elder: { name: elder?.name }, policy: pay.getPolicy(s.householdId), requests: pay.listRequests(s.householdId), alerts: scans });
  }));
  app.post('/api/family/policy', requireRole('family'), (req, res) => {
    const s = sessionOf(req);
    const eurVal = z.number().min(0).max(500).parse(req.body?.thresholdEur);
    pay.setThreshold(s.householdId, Math.round(eurVal * 100), s.userId);
    res.json(pay.getPolicy(s.householdId));
  });
  app.post('/api/family/requests/:id/decision', requireRole('family'), (req, res) => {
    const s = sessionOf(req);
    const decision = z.enum(['approve', 'decline']).parse(req.body?.decision);
    const approvalId = z.string().min(5).max(40).parse(req.body?.approvalId);
    res.json(pay.decide(s.householdId, s.userId, String(req.params.id), approvalId, decision, req.body?.reason));
  });
  // Family members have no refund authority (the old /api/family/requests/:id/refund route was removed on purpose).

  // ---------- Merchant admin (Demo Shop). Only with ADMIN_TOKEN set; header X-Admin-Token, constant-time compare. ----------
  const adminLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.ADMIN_LIMIT_PER_MIN ?? 10), standardHeaders: true, legacyHeaders: false });
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const v = checkAdminToken(req.get(ADMIN_HEADER));
    if (v === 'disabled') return res.status(503).json({ error: 'refunds_disabled', message: REFUNDS_DISABLED_MESSAGE });
    if (v === 'missing') return res.status(401).json({ error: 'admin_required', message: 'Merchant admin token required.' });
    if (v === 'wrong') { audit(null, 'admin?', 'admin.denied', String(req.params.id ?? '')); return res.status(403).json({ error: 'forbidden', message: 'Wrong merchant admin token.' }); }
    next();
  };
  const adminView = (id: string) => {
    const r = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id) as any;
    if (!r) throw new pay.PaymentError('not_found', 'Payment not found.', 404);
    const ref = db.prepare('SELECT capture_id, paypal_request_id, attempt, status, refund_id, paypal_status, last_error, updated_at FROM refunds WHERE request_id=?').get(id) ?? null;
    return { ...pay.publicView(r), refundExecution: ref, timeline: buildTimeline(r) };
  };
  const paymentId = (req: Request) => z.string().regex(/^pay_[A-Za-z0-9_-]{6,40}$/).parse(req.params.id);
  app.get('/api/admin/payments/:id', adminLimiter, requireAdmin, (req, res) => { res.json(adminView(paymentId(req))); });
  app.post('/api/admin/payments/:id/refund', adminLimiter, requireAdmin, wrap(async (req, res) => {
    const id = paymentId(req);
    const body = z.object({
      householdId: z.string().max(60).optional(), captureId: z.string().max(40).optional(),
      amount: z.union([z.string().max(20), z.number()]).optional(), currency: z.string().length(3).optional(),
    }).parse(req.body ?? {});
    const out = await adminRefund(id, 'merchant-admin', body);
    res.status(out.status === 'REFUNDED' ? 200 : 202).json({ ...out, request: adminView(id) });
  }));
  app.post('/api/admin/payments/:id/reconcile', adminLimiter, requireAdmin, wrap(async (req, res) => {
    const id = paymentId(req);
    const out = await reconcilePayment(id);
    res.json({ ...out, request: adminView(id) });
  }));

  // ---------- Family Safety Insights (read-only; one endpoint for both dashboards) ----------
  const insightsOn = (_req: Request, res: Response, next: NextFunction) => (insightsConfig().enabled ? next() : res.status(404).json({ error: 'not_found' }));
  app.get('/api/family/insights', insightsOn, requireRole('family'), (req, res) => {
    const s = sessionOf(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildInsights(s.householdId, { userId: s.userId, name: s.name }));
  });
  app.post('/api/family/insights/agent', insightsOn, aiLimiter, requireRole('family'), wrap(async (req, res) => {
    const s = sessionOf(req);
    const question = z.string().trim().min(1).max(500).parse(req.body?.question);
    // Data always comes from the session's own household, never from the request body.
    res.setHeader('Cache-Control', 'no-store');
    res.json(await answerInsightsQuestion(question, buildInsights(s.householdId, { userId: s.userId, name: s.name })));
  }));

  // ---------- Static web app ----------
  const dist = path.resolve('web/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // ---------- Errors ----------
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'invalid_input', message: 'Some details were missing or not valid.' });
    if (err instanceof pay.PaymentError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large', message: 'That file is too large (max 4 MB).' });
    const ref = crypto.randomBytes(4).toString('hex');
    console.error(`[${ref}]`, err?.message ?? err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on our side. Nothing was charged.', ref });
  });
  return app;
}
