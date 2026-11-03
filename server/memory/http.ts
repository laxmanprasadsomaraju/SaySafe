/**
 * Memory HTTP surface + the hook in front of /api/assistant and /api/discover.
 *
 * - /api/memory*: the signed-in ELDER's own memory only. Any other session gets 404 (a family member can't learn
 *   that the elder has memory at all). Household and user both come from the session cookie, never the request.
 * - The /api/assistant hook answers memory statements ("remember…", "I prefer…", "forget that"), product references
 *   ("that microwave", "the cheaper one", "the one from yesterday") and "ignore my preferences" deterministically,
 *   rewrites "Did I pay for that microwave?" to the product so the EXISTING payment search answers it from
 *   authoritative records, and records the last turns + products shown. Everything else flows on unchanged.
 * - Memory never triggers a money action: nothing here calls the payment service, PayPal, or the approval flow.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'node:crypto';
import { z } from 'zod';
import { readSession, type Session } from '../auth.js';
import { routeCompanion } from '../companion/router.js';
import * as store from './store.js';
import { extractMemory, type MemoryFact } from './extract.js';
import { isProductReference, resolveProductRef, referencedNoun } from './context.js';

export const WHY_PERSONALISED = 'When memory is on, SaySafe remembers only what you clearly tell it about shopping — like a colour, a brand you like or avoid, or your usual budget — so search results suit you. It never remembers health, money you owe, other people, or contact details. Your family can’t see it. It never pays or approves anything. You can change, remove or clear it here at any time.';
const PROFILE_PATH = 'Profile → What SaySafe remembers';

const dateIE = (iso: string) => new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', timeZone: 'Europe/Dublin' });
const shortTitle = (t: string) => t.replace(/\s*[,|(].*$/, '').split(/\s+/).slice(0, 6).join(' ');
const looksPasted = (s: string) => s.length > 300 || /https?:|www\.|\n.*\n/i.test(s);

/** Server copies of the Assistant's product-card item shapes (validated again on the device). */
export function itemFromDemo(p: any) {
  return { id: `demo:${p.id}`, productId: p.id, title: String(p.name), brand: null, image: `/products/${p.image}`, imageAlt: '', features: (p.features ?? []).slice(0, 12), price: p.priceCents / 100, compareAt: null, currency: p.currency, retailer: p.merchant, url: null, availability: 'Unknown', description: p.description ?? null, rating: null };
}
export function itemFromChannel3(p: any, rec?: any) {
  const o = p.offers?.[0];
  const pick = rec?.picks?.find((k: any) => k.id === p.id);
  return { id: p.id, title: p.title, brand: p.brand ?? null, image: p.image ?? null, imageAlt: p.imageAlt || '', features: (p.features ?? []).slice(0, 12), price: o?.price ?? 0, compareAt: o?.compareAt ?? null, currency: o?.currency ?? 'EUR', retailer: o?.retailer ?? 'Shop', url: o?.url || null, availability: o?.availability ?? 'Unknown', attributes: p.attributes, description: p.description ? String(p.description).slice(0, 600) : null, rating: p.rating ?? null, ...(pick?.role ? { role: pick.role } : {}), ...(pick?.reasons ? { reasons: pick.reasons.slice(0, 5) } : {}) };
}

function elderOnly404(req: Request, res: Response, next: NextFunction) {
  const s = readSession(req, 'elder');
  if (s) { (req as any).memSession = s; return next(); }
  if (readSession(req, 'family')) return res.status(404).json({ error: 'not_found' });
  return res.status(401).json({ error: 'not_signed_in', role: 'elder' });
}
const ses = (req: Request) => (req as any).memSession as Session;

// ---------- Replies to memory statements ----------
function memoryReply(s: Session, said: string, via: 'voice' | 'text'): { reply: string; memory: Record<string, unknown> } | null {
  const ex = extractMemory(said);
  if (!ex) return null;
  const hh = s.householdId, uid = s.userId;
  const on = store.isEnabled(hh, uid);
  if (ex.kind === 'refuse') {
    return ex.reason === 'sensitive'
      ? { reply: "I won't save that. I only remember shopping preferences, like a colour, a brand or a budget — never health, money owed, other people or contact details.", memory: { saved: false, reason: 'sensitive' } }
      : { reply: 'I can only remember shopping preferences, like a colour, a brand you like or avoid, or your usual budget. I didn’t save that.', memory: { saved: false, reason: 'unsupported' } };
  }
  if (ex.kind === 'forget') {
    if (ex.scope === 'all') { store.clearAll(hh, uid); return { reply: 'Done. I’ve cleared everything SaySafe remembered for you, including our recent conversation.', memory: { cleared: true } }; }
    if (ex.scope === 'last') {
      const last = store.latestMemory(hh, uid);
      if (!last) return { reply: 'There’s nothing saved to forget.', memory: { forgotten: 0 } };
      store.deleteMemory(hh, uid, last.id);
      return { reply: `Done. I’ve forgotten that: “${last.label}”.`, memory: { forgotten: 1 } };
    }
    const term = (ex.term ?? '').toLowerCase();
    const hits = store.listMemory(hh, uid).filter((m) => m.value.toLowerCase().includes(term) || m.key.includes(term));
    for (const m of hits) store.deleteMemory(hh, uid, m.id);
    return hits.length
      ? { reply: `Done. I’ve forgotten ${hits.map((m) => `“${m.label}”`).join(' and ')}.`, memory: { forgotten: hits.length } }
      : { reply: `I don’t have anything saved about ${ex.term}.`, memory: { forgotten: 0 } };
  }
  // Save.
  const facts: MemoryFact[] = ex.facts;
  const what = facts.map((f) => f.label).join(' and ');
  if (!on) {
    return { reply: `I can remember that ${what} for next time, but memory is off. You can turn it on in ${PROFILE_PATH}. I haven’t saved anything.`, memory: { saved: false, reason: 'memory_off', offer: true } };
  }
  const saved = [];
  for (const f of facts) {
    // A contradiction replaces the old preference instead of keeping both.
    if (f.category === 'brand_like') store.deleteMemoryWhere(hh, uid, 'brand_avoid', f.key);
    if (f.category === 'brand_avoid') store.deleteMemoryWhere(hh, uid, 'brand_like', f.key);
    try { saved.push(store.upsertMemory(hh, uid, { category: f.category, key: f.key, value: f.value, source: via })); }
    catch { return { reply: 'I couldn’t save that: your memory list is full. You can remove things in Profile.', memory: { saved: false, reason: 'full' } }; }
  }
  return { reply: `Got it. I’ll remember ${what.replace(/^you /, 'that you ')}. You can see or remove it in ${PROFILE_PATH}.`, memory: { saved: true, items: saved.map((m) => ({ id: m.id, label: m.label })) } };
}

// ---------- The hook ----------
export function assistantHook(req: Request, res: Response, next: NextFunction) {
  const s = readSession(req, 'elder');
  const said = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!s || !said || said.length > 4000) return next();
  const hh = s.householdId, uid = s.userId;
  const via: 'voice' | 'text' = req.body?.via === 'voice' ? 'voice' : 'text';
  const keepTurn = !looksPasted(said);
  const json0 = res.json.bind(res);
  const done = (body: any) => {
    if (keepTurn) { store.recordTurn(hh, uid, 'user', said, via); if (body?.reply) store.recordTurn(hh, uid, 'assistant', String(body.reply), via); }
    return json0(body);
  };
  try {
    // 1. "Ignore my preferences": re-run the last real-shop search without memory.
    if (/^(please )?(ignore|skip|without) my (preferences|memory)\b|\bwithout my preferences\b/i.test(said)) {
      const last = store.recentProducts(hh, uid).find((p) => p.origin === 'channel3' && p.query);
      const reply = last ? 'Here they are without your saved preferences.' : 'There’s no recent search to show again.';
      return done({ intent: { action: last ? 'shop' : 'chat', reply }, products: [], reply, replyLang: 'en', ai: false, discover: last ? { query: last.query, suggested: false, ignoreMemory: true } : null });
    }
    // 2. Explicit memory statements (same path for typed text and the voice transcript).
    const mem = memoryReply(s, said, via);
    if (mem) return done({ intent: { action: 'chat', reply: mem.reply }, products: [], reply: mem.reply, replyLang: 'en', ai: false, discover: null, memory: mem.memory });

    const routed = routeCompanion(said);
    const recent = () => store.recentProducts(hh, uid);
    // 3. "Did I pay for that microwave?": resolve the item from context, then let the EXISTING payment search answer
    //    from authoritative records only. The conversation is never proof; it is only quoted as "we talked about it".
    if (routed?.action === 'payment_search' && /\b(that|this|it|the one)\b/i.test(said)) {
      const r = recent();
      const noun = referencedNoun(said);
      const talked = noun ? r.find((p) => `${p.title} ${p.query ?? ''}`.toLowerCase().includes(noun.replace(/s$/, ''))) : /\b(it|that one|the one)\b/i.test(said) ? r[0] : undefined;
      if (talked) {
        const term = noun ?? (talked.query ?? shortTitle(talked.title)).replace(/^(a|an|the)\s+/i, '').split(/\s+/).slice(-1)[0];
        req.body.text = `Did I pay for the ${term}?`;
        res.json = (body: any) => {
          const c = body?.companion;
          if (c?.kind === 'payment_matches') {
            const none = !c.result?.matches?.length;
            const line = none
              ? `We talked about the ${shortTitle(talked.title)} on ${dateIE(talked.shownAt)}, but I have no payment record for it.`
              : 'This answer comes from your payment records, not from our conversation.';
            body = { ...body, reply: none ? `${line} ${body.reply ?? ''}`.trim() : `${body.reply ?? ''} ${line}`.trim(), memory: { resolvedFrom: 'conversation', paymentProof: none ? 'none' : 'records' } };
            if (body.intent) body.intent = { ...body.intent, reply: body.reply };
          }
          return done(body);
        };
        return next();
      }
    }
    // 4. Product references after a reload / in a new session.
    if (!routed && isProductReference(said)) {
      const ref = resolveProductRef(said, recent(), store.now());
      if (ref) {
        if (ref.kind === 'none') return done({ intent: { action: 'chat', reply: ref.why }, products: [], reply: ref.why, replyLang: 'en', ai: false, discover: null });
        const items = ref.kind === 'one' ? [ref.item] : ref.items;
        const source = items.every((i) => i.origin === 'demo') ? 'demo' : 'channel3';
        const fmt = (p: store.RecentProduct) => `${shortTitle(p.title)} (${new Intl.NumberFormat('en-IE', { style: 'currency', currency: p.currency }).format(p.price)} at ${p.retailer}, ${dateIE(p.shownAt)})`;
        const reply = ref.kind === 'one'
          ? `${ref.why ? ref.why + ' ' : ''}Here it is again: ${fmt(ref.item)}. Prices can change since then.`
          : `${ref.why} ${items.map((p, i) => `${i + 1}: ${fmt(p)}`).join('; ')}. Tap the one you mean.`;
        const block = { kind: 'product_cards', source, query: (items[0].query ?? items[0].title).slice(0, 200), items: items.map((i) => i.item), fetchedAt: null, note: 'Shown again from your recent conversation. Prices may have changed.' };
        return done({ intent: { action: 'chat', reply }, products: [], reply, replyLang: 'en', ai: false, discover: null, companion: block, memory: { resolvedFrom: 'conversation', clarify: ref.kind === 'many' } });
      }
    }
    // 5. Everything else: record the turn and any Demo Shop products the server shows.
    res.json = (body: any) => {
      // A pasted message going to a scam check is never kept as conversation.
      if (body?.intent?.action === 'check_message') return json0(body);
      if (Array.isArray(body?.products) && body.products.length) {
        try { store.recordProducts(hh, uid, body.products.slice(0, 5).map((p: any) => ({ productId: `demo:${p.id}`, title: p.name, price: p.priceCents / 100, currency: p.currency, retailer: p.merchant, item: itemFromDemo(p) })), 'demo', body.intent?.query ?? said.slice(0, 200)); } catch { /* context is best effort */ }
      }
      return done(body);
    };
  } catch { /* memory is best effort: never block the assistant */ }
  return next();
}

/** After /api/discover answers: remember the top products shown (title, price, retailer) for "that microwave". */
export function discoverHook(req: Request, res: Response, next: NextFunction) {
  const s = readSession(req, 'elder');
  if (!s) return next();
  const json0 = res.json.bind(res);
  res.json = (body: any) => {
    try {
      if (res.statusCode < 400 && Array.isArray(body?.products) && body.products.length) {
        store.recordProducts(s.householdId, s.userId, body.products.slice(0, 5).map((p: any) => ({ productId: String(p.id), title: String(p.title), price: Number(p.offers?.[0]?.price), currency: String(p.offers?.[0]?.currency ?? 'EUR'), retailer: String(p.offers?.[0]?.retailer ?? 'Shop'), item: itemFromChannel3(p, body.recommendation) })), 'channel3', String(body.searchQuery ?? body.query ?? '').slice(0, 200) || null);
      }
    } catch { /* best effort */ }
    return json0(body);
  };
  next();
}

// ---------- /api/memory ----------
export function registerMemory(app: Express) {
  const key = (req: Request) => String(req.cookies?.ss_elder ?? req.cookies?.ss_family ?? '');
  const limiter = rateLimit({
    windowMs: 60_000, limit: Number(process.env.COMPANION_LIMIT_PER_MIN ?? 60), standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (key(req) ? `m:${crypto.createHash('sha256').update(key(req)).digest('hex').slice(0, 32)}` : `ip:${ipKeyGenerator(req.ip ?? '')}`),
    message: { error: 'rate_limited', message: 'Please wait a moment and try again.' },
  });
  const base = '/api/memory';
  app.use(base, limiter, elderOnly404, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const idOf = (req: Request) => z.string().regex(/^mem_[A-Za-z0-9_-]{6,40}$/).parse(req.params.id);
  const snapshot = (s: Session) => ({
    enabled: store.isEnabled(s.householdId, s.userId),
    items: store.listMemory(s.householdId, s.userId),
    context: {
      turns: store.recentTurns(s.householdId, s.userId).length,
      products: store.recentProducts(s.householdId, s.userId).slice(0, 10).map((p) => ({ title: shortTitle(p.title), price: p.price, currency: p.currency, retailer: p.retailer, shownAt: p.shownAt, origin: p.origin })),
      keptDays: store.CONTEXT_DAYS,
    },
    why: WHY_PERSONALISED,
  });
  app.get(base, (req, res) => { res.json(snapshot(ses(req))); });
  app.put(`${base}/settings`, (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const s = ses(req);
    store.setEnabled(s.householdId, s.userId, enabled);
    res.json(snapshot(s));
  });
  app.patch(`${base}/:id`, (req, res) => {
    const { value } = z.object({ value: z.string().trim().min(1).max(120) }).parse(req.body ?? {});
    const s = ses(req);
    const m = store.updateMemoryValue(s.householdId, s.userId, idOf(req), value);
    if (!m) return res.status(404).json({ error: 'not_found' });
    res.json(m);
  });
  app.delete(`${base}/:id`, (req, res) => {
    const s = ses(req);
    if (!store.deleteMemory(s.householdId, s.userId, idOf(req))) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });
  app.delete(base, (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body ?? {});
    const s = ses(req);
    res.json({ ok: true, deleted: store.clearAll(s.householdId, s.userId) });
  });
}
