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
import { startDemoHousehold, createPairingCode, redeemPairingCode, requireRole, readSession, sessionOf, logout, newId, pairDemoFamily } from './auth.js';
import { seedDemoHousehold, seedInfo, migrateSampleData } from './demo/seed.js';
import { NOT_IN_DEMO } from '../shared/realShops.js';
import { TRAINING_EXAMPLES, WELCOME_PROMPTS } from '../shared/demoData.js';
import { buildSummary } from './insights/summary.js';
const fmtEur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100);
const normText = (t: string) => t.replace(/\s+/g, ' ').trim();
const isTrainingText = (t: string) => TRAINING_EXAMPLES.some((x) => normText(x.text) === normText(t));
import { routeCompanion } from './companion/router.js';
import { scanMessage, extractFromImage, explainMore } from './scam/guardian.js';
import { TRUSTED_DOMAINS, TRUSTED_EMAILS, TRUSTED_HELP_PAGES } from './scam/directory.js';
import { normalizeVerdict, VERDICT_LABEL } from './scam/verdicts.js';
import { PRODUCTS, searchProducts, getProduct } from './catalogue/products.js';
import { interpret, describeOptions, eur } from './ai/agent.js';
import { transcribe, health as aiHealth, aiConfigured, AIUnavailableError } from './ai/provider.js';
import * as pay from './payments/service.js';
import * as fam from './family/permissions.js';
import { paypalConfigured, getOrder as getPayPalOrder } from './paypal/client.js';
import { handleWebhook, webhookStatus } from './payments/webhooks.js';
import { correlation, count, log, metrics, startedAt } from './obs.js';
import { SAMPLE_MESSAGES } from './scam/samples.js';
import { reconcileForUser, sweepWithin, finishApproved } from './payments/reconcile.js';
import { buildTimeline } from './payments/timeline.js';
import { adminRefund, checkAdminToken, requestRefund, ensureCaptureVerified, ADMIN_HEADER, REFUNDS_DISABLED_MESSAGE } from './payments/refund.js';
import { reconcile as reconcilePayment } from './payments/reconcile.js';
import { guardModelText, guardAssistantReply } from './ai/outputGuard.js';
import { buildInsights } from './insights/model.js';
import { answerInsightsQuestion } from './insights/agent.js';
import { insightsConfig } from './insights/config.js';
import { listActivity, ActivityQuery } from './activity.js';
import { registerCompanion } from './companion/routes.js';
import { registerMemory, assistantHook, discoverHook } from './memory/http.js';
import { effectiveProfile, personalisedQuery, personalisationLine } from './memory/personalise.js';
import { clearAll as clearMemory } from './memory/store.js';
import { answerCompanion, isCompanionAction } from './companion/assistant.js';
import { listContacts } from './companion/store.js';
import type { SavedContact } from './scam/contactMismatch.js';

export const AI_RULES_ONLY = 'AI unavailable — rule checks only';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

/** "Not in the Demo Shop": honest, never promises a search. With Channel3 the app runs the search right after. */
function notInDemoReply(channel3: boolean) {
  const cats = [...new Set(PRODUCTS.map((p) => p.category.toLowerCase()))].join(', ');
  return `${NOT_IN_DEMO} It sells ${cats} items, such as ${PRODUCTS.slice(0, 4).map((p) => p.name).join(', ')}: tap one below.${channel3 ? " Say 'search real shops' to find real products: you'd buy those on the retailer's own website." : ''}`;
}

export function createApp() {
  // Sample data v3: households seeded with real-brand sample names are renamed to the fictional ones (idempotent).
  try { const n = migrateSampleData(); if (n) console.log(`sample data: renamed ${n} sample rows to fictional names (v3)`); } catch (e) { console.error('sample data migration failed', e); }
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

  // Correlation id for every request (X-Request-Id header, error bodies, structured logs).
  app.use(correlation);

  // Webhook needs the raw body for signature verification: register before json parser. Flow: server/payments/webhooks.ts.
  const webhookLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.WEBHOOK_LIMIT_PER_MIN ?? 120), standardHeaders: true, legacyHeaders: false });
  app.post('/api/paypal/webhook', webhookLimiter, express.raw({ type: 'application/json', limit: '200kb' }), wrap(async (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const out = await handleWebhook(raw, req.headers as Record<string, unknown>);
    res.status(out.status).json(out.body);
  }));

  app.use(express.json({ limit: '100kb' }));

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.API_LIMIT_PER_MIN ?? 120), standardHeaders: true, legacyHeaders: false });
  const recoverLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  // Questions about Mary's own records are answered by rules without calling the AI, so they don't count against the AI limits.
  const rulesOnly = (req: Request) => req.path === '/api/assistant' && typeof req.body?.text === 'string' && req.body.text.length <= 4000 && routeCompanion(req.body.text) != null;
  const aiLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, skip: rulesOnly, message: { error: 'rate_limited', message: 'Please wait a moment before asking again.' } });
  // Per-session limit on AI routes on top of the per-IP one (several people can share an IP; one session cannot bypass by rotating IPs).
  const aiSessionKey = (req: Request) => String(req.cookies?.ss_elder ?? req.cookies?.ss_family ?? '');
  const aiSessionLimiter = rateLimit({
    windowMs: 60_000, limit: Number(process.env.AI_SESSION_LIMIT_PER_MIN ?? 15), standardHeaders: true, legacyHeaders: false, skip: rulesOnly,
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
  /** The signed-in elder's own saved contacts, for the scam check only. Never sent to the AI provider. */
  const contactsFor = (s: { householdId: string } | null): SavedContact[] => (s ? listContacts(s.householdId).map((c) => ({ name: c.name, relation: c.relation, phone: c.phone, email: c.email })) : []);

  // ---------- Status ----------
  // Cheap liveness for uptime pingers: no database, AI, PayPal or Channel3 call.
  app.get('/api/ping', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, time: new Date().toISOString() }); });
  // Readiness + lightweight metrics. External AI check is cached (AI_HEALTH_TTL_MS, default 5 min). No secrets, no PII.
  app.get('/api/health', wrap(async (_req, res) => {
    let dbOk = false;
    try { dbOk = Boolean(db.prepare('SELECT 1 AS ok').get()); } catch { dbOk = false; }
    const m = metrics();
    const pick = (prefix: string) => Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
    let webhooks: ReturnType<typeof webhookStatus> | { error: string };
    try { webhooks = webhookStatus(); } catch { webhooks = { error: 'unavailable' }; }
    res.set('Cache-Control', 'no-store');
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk, startedAt,
      db: { ok: dbOk, mode: dbConfig.mode, persistent: dbConfig.mode !== 'local' },
      paypal: { configured: paypalConfigured(), env: 'sandbox', counters: pick('paypal.'), payments: pick('payments.') },
      webhooks: { ...webhooks, counters: pick('webhook.') },
      reconcile: pick('reconcile.'),
      ai: { ...(await aiHealth()), counters: pick('ai.') },
      channel3: { configured: channel3Configured(), counters: pick('channel3.') },
      insights: insightsConfig().enabled, insightsDashboard: insightsConfig().dashboard,
      time: new Date().toISOString(),
    });
  }));
  app.get('/api/config', (_req, res) => res.json({ paypalConfigured: paypalConfigured(), aiConfigured: aiConfigured(), channel3Configured: channel3Configured(), insights: insightsConfig().enabled, insightsDashboard: insightsConfig().dashboard, demo: true }));

  // ---------- Sessions ----------
  app.post('/api/demo/start', (req, res) => {
    const name = z.string().trim().min(1).max(40).catch('Mary').parse(req.body?.name);
    const { householdId, elderId } = startDemoHousehold(res, name);
    // Each visitor's household gets its own labelled copy of the sample set (stored in the database, never shared).
    // DEMO_SEED=off only in the unit tests that need an empty household (vitest.config.ts); always on in the app.
    const seeded = process.env.DEMO_SEED === 'off' ? null : seedDemoHousehold(householdId, elderId);
    res.json({ ok: true, householdId: householdId.slice(0, 6), seeded });
  });
  // "Reset Mary's demo": replaces this household's SAMPLE rows only. Real PayPal Sandbox payments and records you typed are kept.
  app.post('/api/demo/reset', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    clearMemory(s.householdId, s.userId, { turnOff: true }); // demo reset also clears what SaySafe remembered (and turns memory off)
    res.json({ ok: true, seeded: seedDemoHousehold(s.householdId, s.userId) });
  });
  app.get('/api/demo/info', requireRole('elder'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ seed: seedInfo(sessionOf(req).householdId), prompts: WELCOME_PROMPTS, training: TRAINING_EXAMPLES });
  });
  // "Try as Alex too": a family session for this same household in this browser (pairing code flow, server-side).
  const alexLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  app.post('/api/demo/alex', alexLimiter, requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    const r = pairDemoFamily(res, s.householdId, s.userId, 'Alex');
    res.json({ ok: true, reused: r.reused });
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
    const result = await scanMessage(text, { userName: s?.name ?? 'Mary', lang: langOf(req), contacts: contactsFor(s) });
    const scanId = newId('scan');
    // Training examples are recognised by exact text on the server (never by a client flag) and stored as practice.
    const training = isTrainingText(text) ? 1 : 0;
    db.prepare('INSERT INTO security_scans (id, household_id, verdict, summary, example) VALUES (?,?,?,?,?)').run(scanId, s?.householdId ?? null, result.verdict, result.headline, training);
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
    const result = await scanMessage(extracted.text, { userName: s?.name ?? 'Mary', extractedFromImage: true, ocrUncertain: extracted.uncertain, lang: langOf(req), contacts: contactsFor(s) });
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

  // Memory (server/memory/http.ts): answers "remember…/forget…/that microwave" deterministically, records context.
  app.post('/api/assistant', assistantHook);
  app.post('/api/assistant', aiLimiter, wrap(async (req, res) => {
    const s = readSession(req, 'elder');
    const name = s?.name ?? 'Mary';
    const said = z.string().trim().min(1).max(4000).refine((t) => /\p{L}/u.test(t)).parse(req.body?.text); // never call the AI on empty/punctuation
    const lastResults = z.array(z.string().max(100)).max(5).catch([]).parse(req.body?.lastResults);
    const step = z.string().max(40).catch('home').parse(req.body?.step);
    const lang = langOf(req);
    // Questions about Mary's own records are routed by rules first, so they behave the same with or without the AI
    // (and the same typed or spoken: voice sends its transcript here too). Everything else goes to the AI.
    const demoItem = /\b(demo (item|product|shop)s?|something from the (demo )?shop)\b/i.test(said) && !/\bmembership\b/i.test(said);
    // "Let's buy the demo microwave": a named Demo Shop product, priced only from the server catalogue.
    const demoNamed = !demoItem && !/\bmembership\b/i.test(said) ? said.match(/\b(?:the |a )?demo ([a-z0-9][a-z0-9 .'-]{2,60}?)(?:\s+(?:please|now|then|instead))?[?!]*\.?$/i)?.[1]?.replace(/\.$/, '') ?? null : null;
    const demoPick = demoNamed ? searchProducts(demoNamed, null, 3) : [];
    // "Help me buy a microwave (instead)": real listings first (Channel3, bought at the retailer), Demo Shop offered apart.
    const buyReal = !demoItem && !demoNamed ? said.match(/^(?:(?:can|could) you |please |ok,? |okay,? |so,? )?(?:help me |i(?: want|'d like| would like) to |let's |lets )?(?:buy|shop for)\s+(?:me\s+)?(?:a |an |some |new |a new )?([a-z][a-z -]{2,40}?)(?:\s+(?:instead|please|for me|now))*[?.!]*$/i)?.[1] ?? null : null;
    // "What can I buy?": the Demo Shop catalogue from the server, as tappable chips (no AI).
    if (/\bwhat (can|could) i (buy|shop|get|order)\b|\bwhat('s| is) (in|for sale in) the (demo )?shop\b|\bwhat do you (sell|have)\b|\bwhat (products|items) (are there|do you have)\b/i.test(said)) {
      const catalogue = PRODUCTS.map((p) => ({ productId: p.id, name: p.name, category: p.category, priceCents: p.priceCents, currency: p.currency }));
      const r2 = `The Demo Shop sells ${[...new Set(PRODUCTS.map((p) => p.category.toLowerCase()))].join(', ')} items, paid with PayPal Sandbox (no real money). Tap one below. For anything else, ask for it and I'll search real shops with Channel3: you'd buy those on the retailer's own website.`;
      return res.json({ intent: { action: 'shop', reply: r2 }, products: [], reply: r2, replyLang: 'en', ai: false, discover: null, catalogue });
    }
    const routed = routeCompanion(said)
      ?? (demoItem ? { action: 'shop' as const, query: 'demo item', reply: 'Here are some items from the Demo Shop.' } : null)
      ?? (demoPick.length ? { action: 'shop' as const, query: demoNamed, reply: '' } : null)
      ?? (buyReal ? { action: 'shop' as const, query: buyReal.trim(), reply: '' } : null);
    const { intent, ai, replyLang: aiLang } = routed ? { intent: routed, ai: false as const, replyLang: 'en' as const } : await interpret(said, { name, lastResults, step, lang });
    let products: ReturnType<typeof searchProducts> = [];
    let reply = intent.reply;
    let replyLang = aiLang;
    let discover: { query: string; suggested: boolean } | null = null;
    if (intent.action === 'payment_status') {
      // Answered on the device from GET /api/payments/:id (receipt card). Nothing here captures or charges.
      return res.json({ intent: { action: 'payment_status', reply: intent.reply }, products, reply: intent.reply, replyLang: 'en', ai, discover: null });
    }
    if (isCompanionAction(intent.action)) {
      // The AI only chose the intent and extracted parameters. The server queries this elder's own records and
      // writes the reply from a template: the model's own reply is discarded (it can't claim "marked as paid").
      const out = await answerCompanion(intent.action, intent, s);
      return res.json({ intent: { action: intent.action, reply: out.reply }, products, reply: out.reply, replyLang: 'en', ai, discover, companion: out.card });
    }
    let demoOffer: ReturnType<typeof searchProducts> = [];
    let catalogue: { productId: string; name: string; category: string; priceCents: number; currency: string }[] | null = null;
    let buyNow = false;
    if (intent.action === 'shop' && demoPick.length) {
      // A named Demo Shop product: one match goes straight to the purchase review card (amount from /api/quote).
      products = demoPick.length === 1 || demoPick[0].name.toLowerCase().includes(String(demoNamed).toLowerCase()) ? demoPick.slice(0, 1) : demoPick;
      buyNow = products.length === 1;
      const one = products[0];
      reply = buyNow ? `Here is the Demo Shop ${one.name}: ${fmtEur(one.priceCents)}, paid with PayPal Sandbox, so no real money.` : describeOptions(products, name);
      replyLang = 'en';
      return res.json({ intent: { ...intent, reply }, products, reply, replyLang, ai, discover: null, buyNow });
    }
    if (intent.action === 'shop' && buyReal && channel3Configured()) {
      discover = { query: buyReal.trim(), suggested: false };
      demoOffer = searchProducts(buyReal, null, 1);
      reply = "Here are real listings found for Ireland. You'd buy these on the retailer's own website: SaySafe doesn't take payment for them."; replyLang = 'en';
      if (!demoOffer.length) {
        // Not in the Demo Shop: say what it does sell (server catalogue) before the real listings.
        catalogue = PRODUCTS.map((p) => ({ productId: p.id, name: p.name, category: p.category, priceCents: p.priceCents, currency: p.currency }));
        // No promise here: the app runs the Channel3 search (discover) and then says what it actually found.
        reply = notInDemoReply(true);
        return res.json({ intent: { ...intent, reply }, products, reply, replyLang, ai, discover: { ...discover, suggested: true }, catalogue, realQuery: buyReal.trim().slice(0, 120) });
      }
      return res.json({ intent: { ...intent, reply }, products, reply, replyLang, ai, discover, demoOffer });
    }
    if (intent.action === 'shop') {
      // Real-product questions go to Channel3 discovery (same rules as /discover). The Demo Shop flow is unchanged.
      const wantsReal = /\b(real (shops?|products?|listings?|prices?)|retailers?|other shops|currys|harvey norman|argos|did electrical|online shops?|compare (prices|shops)|in ireland)\b/i.test(said);
      if (wantsReal && channel3Configured()) {
        discover = { query: said, suggested: false };
        reply = "I'll look in listings found for Ireland. You'd buy on the shop's own website."; replyLang = 'en';
      } else {
        products = demoItem ? [...PRODUCTS].sort((a, b) => b.rating - a.rating).slice(0, 3) : searchProducts(intent.query || said, intent.max_price_eur ? Math.round(intent.max_price_eur * 100) : null);
        // English template, unless the AI already answered in the chosen reply language.
        if (lang === 'en' || replyLang !== lang) { reply = describeOptions(products, name); replyLang = 'en'; }
        if (!products.length) {
          // Never a blank result: say what the Demo Shop sells (from the server catalogue) and where else to look.
          catalogue = PRODUCTS.map((p) => ({ productId: p.id, name: p.name, category: p.category, priceCents: p.priceCents, currency: p.currency }));
          reply = notInDemoReply(channel3Configured());
          replyLang = 'en';
          if (channel3Configured()) discover = { query: (intent.query || said).slice(0, 200), suggested: true };
        }
      }
    }
    // Free model text (chat / confirm / cancel / help…) never claims an effect: the assistant has no write tools.
    if (ai && reply === intent.reply) reply = guardAssistantReply(reply);
    res.json({ intent: { ...intent, reply }, products, reply, replyLang, ai, discover, ...(catalogue ? { catalogue, realQuery: (intent.query || said).slice(0, 120) } : {}) });
  }));

  // ---------- Payment companion (elder-only, household-scoped; see docs/COMPANION.md) ----------
  registerCompanion(app, { originOf });
  // ---------- What SaySafe remembers (elder-only, user-scoped; family gets 404) ----------
  registerMemory(app);

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
  app.post('/api/discover', discoverHook);
  app.post('/api/discover', aiLimiter, wrap(async (req, res) => {
    const s = readSession(req, 'elder');
    const said = z.string().trim().min(1).max(400).parse(req.body?.text);
    const overrideMax = z.number().positive().max(100000).nullable().catch(null).parse(req.body?.maxPrice ?? null);
    // Signed in: the profile comes only from this user's own row. No session: the browser's local copy, sanitised.
    // Remembered preferences (only when this elder turned memory on); the current request always overrides them.
    const ignoreMemory = req.body?.ignoreMemory === true;
    const personal = s ? effectiveProfile(s.householdId, s.userId, said, { ignoreMemory }) : null;
    const profile = personal ? personal.profile : sanitizeProfile(req.body?.profile);
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
      // No user id is sent to Channel3: its optional x-user-id is only for click/commission attribution and is
      // appended to every buy URL, so it would leak an internal id to retailers (docs.trychannel3.com/api-reference/v1/search).
      // Only product terms go to Channel3: at most a remembered colour is added to the query, never anything personal.
      let result = await searchChannel3(personal ? personalisedQuery(query, personal) : query, { maxPrice });
      if (personal && !result.products.length && personalisedQuery(query, personal) !== query) result = await searchChannel3(query, { maxPrice });
      count('channel3.searches');
      const rec = recommend(result.products, { ...parsed, budget: { max: maxPrice, min: parsed.budget.min } }, profile);
      const byId = new Map(result.products.map((p) => [p.id, p]));
      const products = rec.rankedIds.map((id) => byId.get(id)!);
      const best = rec.picks.find((p) => p.role === 'best');
      const explanation = best ? await explainBest(byId.get(best.id)!, best.reasons, profile, maxPrice) : null;
      const personalisation = personal ? personalisationLine(rec, products, personal) : null;
      res.json({ ...result, query: said.slice(0, 200), searchQuery: query, products, recommendation: rec, explanation, profileApplied: !profileIsEmpty(profile), personalisation, channel3Query: result.query, reply: spokenRecommendation(products, rec, query), ai: ai ?? false });
    } catch (e) {
      if (!(e instanceof Channel3Error)) throw e;
      count(`channel3.errors.${e.code}`);
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

  // ---------- My Activity (elder or paired family; household always from the session) ----------
  app.get('/api/activity', (req, res, next) => {
    // Prefer the role the page asks for; both roles only ever see their own household.
    const want = req.query.as === 'family' ? 'family' : 'elder';
    const s = readSession(req, want) ?? readSession(req, want === 'elder' ? 'family' : 'elder');
    if (!s) return res.status(401).json({ error: 'not_signed_in' });
    (req as any).session = s;
    next();
  }, wrap(async (req, res) => {
    const s = sessionOf(req);
    const parsed = ActivityQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', message: 'Some filters were not valid.' });
    await sweepWithin(s.householdId); // same lazy, rate-limited reconcile as GET /api/payments
    res.set('Cache-Control', 'no-store');
    res.json({ role: s.role, ...listActivity(s.householdId, s.role, parsed.data) });
  }));
  // Family circle status for the elder's Profile (names only; no family data beyond that).
  app.get('/api/family/status', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    const links = db.prepare("SELECT u.name, f.status, f.pairing_expires_at FROM family_links f JOIN users u ON u.id=f.family_id WHERE f.household_id=?").all(s.householdId) as any[];
    res.json({
      active: links.filter((l) => l.status === 'active').map((l) => ({ name: l.name })),
      pendingInvites: links.filter((l) => l.status === 'pending' && l.pairing_expires_at > Date.now()).length,
      policy: pay.getPolicy(s.householdId),
      sharing: fam.getSharing(s.householdId),
    });
  });
  // Only Mary changes her own limit and what she shares with family (elder session only; household from the session).
  app.post('/api/policy', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    const eurVal = z.number().min(0).max(500).parse(req.body?.thresholdEur);
    pay.setThreshold(s.householdId, Math.round(eurVal * 100), s.userId);
    res.json(pay.getPolicy(s.householdId));
  });
  app.post('/api/family/sharing', requireRole('elder'), (req, res) => {
    const s = sessionOf(req);
    const body = z.object({ shareSummaries: z.boolean().optional(), shareHistory: z.boolean().optional() }).strict().parse(req.body ?? {});
    res.set('Cache-Control', 'no-store');
    res.json(fam.setSharing(s.householdId, s.userId, body));
  });

  // ---------- Family ----------
  app.get('/api/family/overview', requireRole('family'), wrap(async (req, res) => {
    const s = sessionOf(req);
    await sweepWithin(s.householdId);
    const elder = db.prepare('SELECT u.name FROM households h JOIN users u ON u.id=h.elder_id WHERE h.id=?').get(s.householdId) as any;
    const rows = db.prepare('SELECT id, verdict, summary, created_at FROM security_scans WHERE household_id=? AND shared_with_family=1 ORDER BY created_at DESC LIMIT 10').all(s.householdId);
    // Older rows hold legacy verdict codes; always send the three public verdicts.
    const scans = (rows as { id: string; verdict: string; summary: string; created_at: string }[]).map((r) => ({ ...r, verdict: normalizeVerdict(r.verdict), verdictLabel: VERDICT_LABEL[normalizeVerdict(r.verdict)] }));
    // Only requests routed to family for review, plus Mary's purchase history if (and while) she shares it.
    const sharing = fam.getSharing(s.householdId);
    res.set('Cache-Control', 'no-store');
    res.json({ me: { name: s.name }, elder: { name: elder?.name }, policy: pay.getPolicy(s.householdId), sharing: { shareSummaries: sharing.shareSummaries, shareHistory: sharing.shareHistory }, requests: fam.familyVisibleRows(s.householdId, 20).map(pay.publicView), alerts: scans });
  }));
  // Family members can never change Mary's limit: only she can (POST /api/policy, elder session).
  app.post('/api/family/policy', requireRole('family'), (req, res) => {
    const s = sessionOf(req);
    audit(s.householdId, s.userId, 'policy.change_denied');
    res.status(403).json({ error: 'forbidden', message: 'Only the account holder can change their own limit.' });
  });
  // Read-only: one request of the family member's own household (the Assistant's review card re-fetches it by id).
  app.get('/api/family/requests/:id', requireRole('family'), (req, res) => {
    const s = sessionOf(req);
    const id = z.string().regex(/^pay_[A-Za-z0-9_-]{4,60}$/).parse(req.params.id);
    const elder = db.prepare('SELECT u.name FROM households h JOIN users u ON u.id=h.elder_id WHERE h.id=?').get(s.householdId) as any;
    res.set('Cache-Control', 'no-store');
    res.json({ ...pay.publicView(fam.loadForFamily(id, s.householdId)), elderName: elder?.name ?? null });
  });
  app.post('/api/family/requests/:id/decision', requireRole('family'), (req, res) => {
    const s = sessionOf(req);
    const decision = z.enum(['approve', 'decline']).parse(req.body?.decision);
    const approvalId = z.string().min(5).max(40).parse(req.body?.approvalId);
    fam.loadForFamily(String(req.params.id), s.householdId); // 404 unless this request was routed to family
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
  // "My insights": Mary sees her whole household picture; a family member gets the same shape with Mary's private
  // records, subscriptions and duplicate checks left out (null), and only the scam checks she shared.
  app.get('/api/insights/summary', insightsOn, (req, res) => {
    const want = req.query.as === 'family' ? 'family' : 'elder';
    const s = readSession(req, want) ?? readSession(req, want === 'elder' ? 'family' : 'elder');
    if (!s) return res.status(401).json({ error: 'unauthenticated', message: 'Please start SaySafe on this device first.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildSummary({ role: s.role, householdId: s.householdId }));
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
  // Every error body carries a stable `error` code and the request's correlation id (`requestId`), so the UI can show
  // a truthful error card with Retry instead of an empty list, and a report can be matched to the server log.
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as any).requestId as string | undefined;
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'invalid_input', message: 'Some details were missing or not valid.', requestId });
    if (err instanceof pay.PaymentError) {
      if (err.status >= 500) log('warn', 'api.payment_error', { code: err.code, status: err.status, path: req.path });
      return res.status(err.status).json({ error: err.code, message: err.message, requestId });
    }
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large', message: 'That file is too large (max 4 MB).', requestId });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'That request is too large.', requestId });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'That request was not valid.', requestId });
    count('api.server_errors');
    log('error', 'api.server_error', { path: req.path, method: req.method, message: String(err?.message ?? err).slice(0, 300), stack: err?.stack ? String(err.stack).split('\n').slice(1, 4).join(' | ') : undefined });
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on our side. Nothing was charged.', requestId, ref: requestId });
  });
  return app;
}
