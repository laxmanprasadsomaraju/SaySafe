/**
 * One conversation for everything: check a message, find a product, trusted help, payments. Text and voice
 * share the app-wide speech controller. Inline components come only from the registry (assistant/blocks.tsx)
 * with validated data (assistant/schemas.ts). Payments still go through the existing quote -> request ->
 * family review -> PayPal approval -> server capture flow; nothing here can approve or capture by itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Mic, Square, Loader2, SendHorizontal, MessageSquareWarning, ShoppingBag, LifeBuoy, Wallet, ImageUp, ShieldCheck } from 'lucide-react';
import { Layout } from '../components/Layout';
import { LeaveGuard } from '../components/LeaveGuard';
import { api, newKey, type ScanResult } from '../lib/api';
import { speech, useVoiceInput } from '../lib/voice';
import { useMe } from '../lib/session';
import { spokenScam, spokenFamily } from '../lib/spoken';
import { AssistantHeader } from '../assistant/AssistantHeader';
import { SpokenRepliesBar } from '../components/VoiceBar';
import { MemoryNotice } from '../components/MemoryNotice';
import { pickStatusPayment, NO_SANDBOX_PAYMENT_REPLY } from '../../../shared/paymentStatus';
import { realShopSearch, NOT_IN_DEMO, NOT_IN_DEMO_SPOKEN, NOT_IN_DEMO_FOUND_SPOKEN } from '../../../shared/realShops';
import { THREAD_KEY, markPayPalReturn, pendingPayPalReturn, clearPayPalReturn, hasBlockFor, conversationPaymentId } from '../assistant/thread';
import { fetchPayment } from '../assistant/blocks';
import { localProfileForRequest } from '../lib/prefs';
import { fetchActivity, paymentLabel } from '../lib/activity';
import { goToPayPal } from '../lib/handoff';
import { normaliseLang } from '../../../shared/lang';
import { compareRows, shortTitle, type ShopItem, type Recommendation } from '../../../shared/shopping';
import { parseBlock, productItems, restoreThread, Mode as ModeSchema, ServerPayment, ServerActivity, parseServer, familyStatusFrom, receiptFrom, refundFrom, historyFrom, type Block, type BlockOf, type Message, type Mode, type ProductItem, type Thread } from '../assistant/schemas';
import { parseFollowup, ageAnswer, sellerAnswer, sellerFacts, toShopItem } from '../assistant/followups';
import { RenderBlock, ProductSheet, type BlockActions } from '../assistant/blocks';
import { COMPANION_CHIPS, TAP_ONLY_REPLY, looksCompanion, shortSpoken, money as companionMoney } from '../assistant/companion';
import { SubscriptionSummary } from '../../../shared/companion';
import { TRAINING_EXAMPLES, WELCOME_PROMPTS } from '../../../shared/demoData';

const trainingBlock = () => ({ kind: 'training_examples', items: TRAINING_EXAMPLES.map((t) => ({ id: t.id, label: t.label, howToTest: t.howToTest, text: t.text })) });

const KEY = THREAD_KEY;
const MODES: { mode: Exclude<Mode, 'chat'>; label: string; icon: typeof Mic; placeholder: string }[] = [
  { mode: 'check', label: 'Check a message', icon: MessageSquareWarning, placeholder: 'Paste message' },
  { mode: 'find', label: 'Find a product', icon: ShoppingBag, placeholder: 'e.g. a kettle' },
  { mode: 'help', label: 'Get trusted help', icon: LifeBuoy, placeholder: 'Type here' },
  { mode: 'payments', label: 'My payments', icon: Wallet, placeholder: 'e.g. last payment' },
];
const PROMPT: Record<Mode, string> = {
  check: 'Paste the message, email, link or phone number you got, or read it out. I never open its links.',
  find: 'What are you looking for? For example: a kettle under €40. Say “real shops” to compare shops in Ireland.',
  help: 'What do you need help with? I can point you to official PayPal help, an order problem, or your family.',
  payments: 'Here are your payments. You can also ask: “show my last payment”.',
  chat: 'I can check a message, find a product, get trusted help, or show your payments.',
};
const SUGGEST: Partial<Record<Block['kind'], string[]>> = {
  product_cards: ['Show cheaper ones', 'Is it suitable for a four-year-old?', 'Is this seller trustworthy?'],
  payment_history: ['Show my last payment'],
  receipt: ['Refund options', 'Show my payments'],
};
const mid = () => Math.random().toString(36).slice(2, 10);
/** Marks the Demo Shop alternative shown after real listings, so "the cheaper one" / "compare" refer to the real listings. */
const DEMO_OFFER_NOTE = 'Demo Shop alternative: PayPal Sandbox, no real money.';
const fresh = (mode: Mode = 'chat'): Thread => ({ v: 1, mode, focusId: null, messages: [{ id: mid(), role: 'assistant', text: PROMPT[mode], blocks: [] }] });
const load = (): Thread => { try { return restoreThread(sessionStorage.getItem(KEY)) ?? fresh(); } catch { return fresh(); } };

/** Server shapes -> registry data (then validated by the schemas). */
function fromDemo(p: { id: string; name: string; priceCents: number; currency: string; merchant: string; plainWords?: string; features: string[]; image: string; description?: string }): unknown {
  return { id: `demo:${p.id}`, productId: p.id, title: p.name, brand: null, image: `/products/${p.image}`, imageAlt: '', features: p.features, price: p.priceCents / 100, compareAt: null, currency: p.currency, retailer: p.merchant, url: null, availability: 'Unknown', description: p.description ?? null, rating: null };
}
function fromChannel3(p: ShopItem, rec?: Recommendation): unknown {
  const o = p.offers[0];
  const pick = rec?.picks.find((k) => k.id === p.id);
  return { id: p.id, title: p.title, brand: p.brand, image: p.image, imageAlt: p.imageAlt || '', features: p.features.slice(0, 12), price: o?.price ?? 0, compareAt: o?.compareAt ?? null, currency: o?.currency ?? 'EUR', retailer: o?.retailer ?? 'Shop', url: o?.url || null, availability: o?.availability ?? 'Unknown', attributes: p.attributes, description: p.description ? p.description.slice(0, 2000) : null, rating: p.rating, role: pick?.role, ...(p.variants?.length ? { variants: p.variants.slice(0, 3).map((v) => ({ name: v.name.slice(0, 30), values: v.values.slice(0, 12).map((x) => x.slice(0, 30)) })) } : {}), reasons: [...(p.why ?? []), ...(pick?.reasons ?? [])].slice(0, 5) };
}

export default function Assistant() {
  const me = useMe('elder');
  const nav = useNavigate();
  const loc = useLocation();
  const [sp] = useSearchParams();
  const [thread, setThread] = useState<Thread>(load);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<{ item: ProductItem; source: 'channel3' | 'demo' } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef(thread);
  threadRef.current = thread;

  useEffect(() => { try { sessionStorage.setItem(KEY, JSON.stringify(thread)); } catch { /* full or private */ } }, [thread]);
  // Show the START of the newest reply (its first line and the top of its card), not the bottom of a long card.
  useEffect(() => {
    const behavior: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion') ? 'auto' : 'smooth';
    const last = document.querySelector('[role="log"] > div:last-of-type');
    const prev = last?.previousElementSibling as HTMLElement | null;
    // Keep the person's own message visible above a reply when there is room.
    (prev && last?.getAttribute('data-role') === 'assistant' && prev.getAttribute('data-role') === 'user' ? prev : (last as HTMLElement | null) ?? endRef.current)?.scrollIntoView({ block: 'start', behavior });
  }, [thread.messages.length]);

  const add = useCallback((role: Message['role'], text: string, blocks: unknown[] = [], lang?: string) => {
    const valid = blocks.map(parseBlock).filter((b): b is Block => b !== null);
    setThread((t) => ({ ...t, messages: [...t.messages, { id: mid(), role, text: text.slice(0, 4000), blocks: valid, lang }].slice(-80) }));
  }, []);
  const updateBlock = useCallback((match: (b: Block) => boolean, next: Block) => {
    const ok = parseBlock(next);
    if (!ok) return;
    setThread((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, blocks: m.blocks.map((b) => (match(b) ? ok : b)) })) }));
  }, []);
  const setMode = (mode: Mode) => setThread((t) => ({ ...t, mode }));
  const say = (text: string, turn?: number, lang?: string) => speech.speak(text, { turn, lang: normaliseLang(lang) });

  const lastBlock = <K extends Block['kind']>(kind: K): BlockOf<K> | null => {
    const ms = threadRef.current.messages;
    for (let i = ms.length - 1; i >= 0; i--) for (let j = ms[i].blocks.length - 1; j >= 0; j--) if (ms[i].blocks[j].kind === kind) return ms[i].blocks[j] as BlockOf<K>;
    return null;
  };

  // ---------- actions using the existing APIs ----------
  const showScan = (r: ScanResult) => {
    const block = { kind: 'scam_result', scanId: r.scanId, verdict: r.verdict, headline: r.headline, summary: r.spokenSummary, signals: r.signals.slice(0, 8).map((s) => ({ severity: s.severity, title: s.title, detail: s.detail, ...(s.evidence ? { evidence: s.evidence.slice(0, 300) } : {}), ...(s.code ? { code: s.code.slice(0, 60) } : {}) })), safeActions: r.safeActions.slice(0, 4), aiNotice: r.aiNotice ?? null };
    const spoken = spokenScam(r as any);
    add('assistant', spoken, [block]);
    speech.speak(spoken, { priority: 'critical', lang: 'en' });
  };
  const scan = async (text: string, turn: number) => {
    const r = await api<ScanResult>('/api/scan', { body: { text } });
    if (speech.isCurrent(turn)) showScan(r);
  };
  const scanImage = async (f: File) => {
    if (f.size > 4 * 1024 * 1024) { add('assistant', 'That picture is too large (max 4 MB).'); return; }
    add('user', 'Sent a screenshot to check');
    setBusy(true); const turn = speech.beginTurn();
    try { const fd = new FormData(); fd.append('image', f); const r = await api<ScanResult>('/api/scan/image', { form: fd }); if (speech.isCurrent(turn)) showScan(r); }
    catch (e: any) { add('assistant', e.message); }
    finally { setBusy(false); speech.endThinking(); if (fileRef.current) fileRef.current.value = ''; }
  };

  /** A separate, clearly labelled Demo Shop option after real listings (never mixed into the Channel3 cards). */
  const offerDemo = (demo: any[], query: string) => {
    const items = productItems(demo.map(fromDemo));
    if (!items.length) return;
    add('assistant', 'Want to see the safe purchase steps instead? The SaySafe Demo Shop has a similar item. It is paid with PayPal Sandbox, so no real money moves, and you can say “let’s buy the demo ' + query.replace(/^(a|an|the)\s+/i, '') + '”.', [{ kind: 'product_cards', source: 'demo', query, items, fetchedAt: null, note: DEMO_OFFER_NOTE }]);
  };
  /** Channel3 search. Returns what happened, so a caller never claims listings that aren't on screen. With `quiet`,
   *  a miss or an error adds nothing (the caller says it, honestly) and listings are shown without being spoken. */
  const discover = async (text: string, turn: number, maxPrice?: number, label?: string, demo?: any[], quiet = false, ignoreMemory = false, lead?: string): Promise<{ status: 'shown' | 'none' | 'error' | 'stale'; message?: string }> => {
    try {
      const r = await api<{ products: ShopItem[]; recommendation: Recommendation; reply: string; fetchedAt: string; searchQuery: string; personalisation?: { line: string } | null }>('/api/discover', { body: { text, maxPrice: maxPrice ?? null, profile: localProfileForRequest(), ...(ignoreMemory ? { ignoreMemory: true } : {}) } });
      if (!speech.isCurrent(turn)) return { status: 'stale' };
      const items = productItems(r.products.map((p) => fromChannel3(p, r.recommendation)));
      if (!items.length) { const msg = label ? `${label}, I found no other listings for ${r.searchQuery}.` : r.reply || 'I found no matching listings.'; if (!quiet) { add('assistant', msg); say(msg, turn); } return { status: 'none', message: msg }; }
      const reply = lead ? `${lead} ${r.reply}` : demo || quiet ? `${r.reply} These are real listings: you would buy them on the retailer’s own website, not through SaySafe or its PayPal Sandbox checkout.` : r.reply;
      // "Shown first because you prefer red…" (remembered preferences; only when memory is on).
      const why = typeof r.personalisation?.line === 'string' ? r.personalisation.line.slice(0, 380) : null;
      add('assistant', why ? `${reply} ${why}` : reply, [{ kind: 'product_cards', source: 'channel3', query: r.searchQuery || text, items, fetchedAt: r.fetchedAt ?? null, note: why }]);
      setThread((t) => ({ ...t, focusId: null }));
      if (!quiet) say(r.reply, turn);
      if (demo?.length) offerDemo(demo, text);
      return { status: 'shown' };
    } catch (e: any) {
      const msg = String(e?.message || 'I couldn’t search the shops right now.');
      if (speech.isCurrent(turn) && !quiet) { add('assistant', e.message || 'I couldn’t search the shops right now. The SaySafe Demo Shop still works.'); if (demo?.length) offerDemo(demo, text); }
      return { status: speech.isCurrent(turn) ? 'error' : 'stale', message: msg };
    }
  };
  /**
   * Not in the Demo Shop: run the real-shop search FIRST (Channel3), show any real listings, then the Demo Shop chips,
   * and say only what actually happened. No listings / an error → said plainly, with a "Search real shops" chip.
   */
  const notInDemoShop = async (catalogue: any[], realQuery: string | null, channel3: boolean, turn: number, lead?: string, maxPrice?: number) => {
    const chips = (realFound?: boolean) => [{ kind: 'shop_catalogue' as const, items: catalogue, channel3, ...(realQuery ? { realQuery: realQuery.slice(0, 120) } : {}), ...(realFound !== undefined ? { realFound } : {}) }];
    if (!channel3 || !realQuery) {
      const t = `${NOT_IN_DEMO} Pick a demo item below: it is paid with PayPal Sandbox, so no real money.`;
      add('assistant', t, chips()); return say(`${NOT_IN_DEMO} Pick a demo item.`, turn);
    }
    const r = await discover(realQuery, turn, maxPrice, undefined, undefined, true, false, lead);
    if (r.status === 'stale' || !speech.isCurrent(turn)) return;
    if (r.status === 'shown') {
      add('assistant', `${NOT_IN_DEMO} The real listings above are bought on the retailer’s own website. Or pick a demo item below (PayPal Sandbox, no real money).`, chips(true));
      return say(NOT_IN_DEMO_FOUND_SPOKEN, turn);
    }
    const why = r.status === 'error' ? `I couldn’t reach the real-shop search just now (${(r.message ?? '').replace(/\s*The SaySafe Demo Shop still works\.?/, '').slice(0, 160)})` : `I searched real shops for “${realQuery}” and found no matching listings`;
    add('assistant', `${NOT_IN_DEMO} ${why}. Tap “Search real shops” to try again, or pick a demo item below.`, chips(false));
    say(NOT_IN_DEMO_SPOKEN, turn);
  };
  /** The product the last "not in the Demo Shop" answer was about. */
  const lastRealQuery = (): string | null => lastBlock('shop_catalogue')?.realQuery ?? null;

  const showDemo = (products: any[], query: string, reply: string, turn: number, lang?: string) => {
    const items = productItems(products.map(fromDemo));
    if (items.length) items[0] = { ...items[0], role: 'best' };
    add('assistant', reply, items.length ? [{ kind: 'product_cards', source: 'demo', query, items, fetchedAt: null, note: null }] : [], lang);
    setThread((t) => ({ ...t, focusId: null }));
    say(reply, turn, lang);
  };

  const prepare = async (item: ProductItem, lead?: string) => {
    setSheet(null);
    if (!item.productId) return;
    const turn = speech.beginTurn();
    try {
      // The amount on the card comes from the server catalogue (/api/quote), never from the AI or the listing shown.
      const q = await api<{ lines: any[]; totalCents: number; currency: string; merchant: string; needsFamily: boolean; thresholdCents: number; spoken: string }>('/api/quote', { body: { items: [{ productId: item.productId, quantity: 1 }] } });
      const extra = q.needsFamily ? ' It’s above your protected limit, so your family member checks it first. Tap Allow to ask them.' : ' Tap Allow to continue to PayPal, or Deny.';
      add('assistant', (lead ? `${lead} ` : '') + q.spoken + extra, [{ kind: 'payment_prep', lines: q.lines.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, lineCents: l.lineCents, image: l.image })), totalCents: q.totalCents, currency: q.currency, merchant: q.merchant, needsFamily: q.needsFamily, thresholdCents: q.thresholdCents, idempotencyKey: newKey(), status: 'ready', requestId: null, error: null }]);
      say((lead ? `${lead} ` : '') + q.spoken + extra, turn);
    } catch (e: any) { add('assistant', '', [{ kind: 'retry_error', message: String(e?.message || 'I couldn’t price that item. Nothing was charged.').slice(0, 400), retryText: `buy the demo ${item.title}`.slice(0, 200), done: false }]); }
    finally { speech.endThinking(); }
  };

  const allow = async (b: BlockOf<'payment_prep'>) => {
    const same = (x: Block) => x.kind === 'payment_prep' && x.idempotencyKey === b.idempotencyKey;
    updateBlock(same, { ...b, status: 'sending', error: null });
    try {
      const r = await api<{ request: unknown; approveUrl: string | null }>('/api/payments', { body: { items: b.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), idempotencyKey: b.idempotencyKey }, idempotent: true });
      const req = parseServer(ServerPayment, r.request);
      updateBlock(same, { ...b, status: 'sent', requestId: req.id, error: null });
      if (typeof r.approveUrl === 'string' && /^https:\/\//.test(r.approveUrl)) { markPayPalReturn(req.id); goToPayPal(r.approveUrl); return; }
      const text = req.state === 'BLOCKED' ? 'I stopped this purchase for your safety. Nothing was paid.' : spokenFamily(req.state as any, req.approval?.status) || 'Saved. You can follow it in Activity.';
      add('assistant', text, [familyStatusFrom(req)]);
      say(text);
    } catch (e: any) { updateBlock(same, { ...b, status: 'error', error: String(e.message).slice(0, 300) }); }
  };
  const deny = (b: BlockOf<'payment_prep'>) => { updateBlock((x) => x.kind === 'payment_prep' && x.idempotencyKey === b.idempotencyKey, { ...b, status: 'denied' }); add('assistant', 'Okay. Nothing was paid.'); };
  const share = async (b: BlockOf<'scam_result'>) => {
    try { await api(`/api/scan/${b.scanId}/share`, { body: {} }); updateBlock((x) => x.kind === 'scam_result' && x.scanId === b.scanId, { ...b, shared: true }); add('assistant', 'I sent the result to your family member. Only the result, not the message.'); }
    catch (e: any) { add('assistant', e.message); }
  };
  const compare = (b: BlockOf<'product_cards'>) => {
    const top = b.items.slice(0, 3);
    const rows = compareRows(top.map(toShopItem)).map((r) => ({ label: r.label, values: r.values.map((v) => (v == null ? null : String(v).slice(0, 200))) }));
    add('assistant', 'Here they are side by side. I only show what each listing states.', [{ kind: 'compare', source: b.source, names: top.map((p) => shortTitle(p.title)), rows }]);
  };

  const showHistory = async (turn: number, q?: string) => {
    const a = parseServer(ServerActivity, await fetchActivity(q ? { q, limit: 5 } : { type: 'payment', limit: 5 }));
    if (!speech.isCurrent(turn)) return;
    const waiting = a.items.filter((i) => i.statusGroup === 'pending').length;
    const text = q ? (a.total ? `I found ${a.total} for “${q}”.` : `Nothing matches “${q}”. Try another word.`)
      : a.total === 0 ? 'You have no payments yet.' : `You have ${a.total} payment${a.total === 1 ? '' : 's'}${waiting ? `, ${waiting} waiting` : ''}. Tap one to see it, or search.`;
    add('assistant', text, [historyFrom(a, q)]);
    say(text, turn);
  };
  /** The newest captured purchase (or the one a card is about), re-read from the server. */
  const latestPaid = async (): Promise<ServerPayment | null> => {
    const r = lastBlock('receipt');
    if (r) return fetchPayment(r.requestId);
    const list = await api<unknown[]>('/api/payments');
    const paid = (Array.isArray(list) ? list : []).map((x) => ServerPayment.safeParse(x)).find((x) => x.success && x.data.receipt);
    return paid?.success ? fetchPayment(paid.data.id) : null;
  };
  const appendReceipt = async (id: string, text?: string, turn?: number) => {
    const p = await fetchPayment(id);
    if (turn !== undefined && !speech.isCurrent(turn)) return;
    const block = receiptFrom(p);
    if (!block) { const t = `${paymentLabel(p.state)}. There is no PayPal receipt for this purchase yet.`; add('assistant', t, [familyStatusFrom(p)]); return say(t, turn); }
    const rc = block.receipt;
    const t = text ?? `Your payment: ${new Intl.NumberFormat('en-IE', { style: 'currency', currency: rc.currency }).format(Number(rc.amount))} to ${rc.payee.replace(' (sandbox)', '')}, confirmed by PayPal. It was a sandbox payment, so no real money moved.`;
    add('assistant', t, [block]);
    say(t, turn);
  };
  /**
   * "Did my payment go through?" — the purchase this conversation is about (newest card first), else the newest real
   * purchase. Read-only: GET /api/payments/:id. It never calls confirm/capture, so asking again (or reloading) can't
   * charge twice; it shows the same receipt.
   */
  const showPaymentStatus = async (turn: number) => {
    const id = conversationPaymentId(threadRef.current);
    let p: ServerPayment | null = id ? await fetchPayment(id).catch(() => null) : null;
    if (!p) {
      const list = await api<unknown[]>('/api/payments');
      const rows = (Array.isArray(list) ? list : []).map((x) => ServerPayment.safeParse(x)).filter((x) => x.success).map((x) => x.data!);
      const pick = pickStatusPayment(rows as (ServerPayment & { sample?: boolean })[]);
      p = pick ? await fetchPayment(pick.id) : null;
    }
    if (!speech.isCurrent(turn)) return;
    if (!p) {
      // Nothing to check: a plain answer plus the Demo Shop chips (server catalogue). Never "paid".
      const ps = await api<any[]>('/api/products').catch(() => []);
      if (!speech.isCurrent(turn)) return;
      const items = (Array.isArray(ps) ? ps : []).map((x) => ({ productId: x.id, name: x.name, category: x.category, priceCents: x.priceCents, currency: x.currency }));
      add('assistant', NO_SANDBOX_PAYMENT_REPLY, items.length ? [{ kind: 'shop_catalogue', items, channel3: false }] : []);
      return say(NO_SANDBOX_PAYMENT_REPLY.split('. You can')[0] + '.', turn);
    }
    const block = receiptFrom(p);
    const amt = new Intl.NumberFormat('en-IE', { style: 'currency', currency: p.currency }).format(p.amountCents / 100);
    if (block) {
      const t = `Yes. PayPal confirmed your ${amt} payment for ${block.item}${block.receipt.webhookConfirmed ? ', and its signed notice was verified' : '. The signed PayPal notice hasn’t arrived yet, so that part is still pending'}. It was PayPal Sandbox, so no real money moved.`;
      add('assistant', t, [block]); return say(t, turn);
    }
    const t = p.state === 'FAMILY_APPROVAL_PENDING' ? `Not yet. Your ${amt} purchase is still waiting for your family member. Nothing is paid.`
      : p.state === 'FAMILY_APPROVED' || p.state === 'PAYER_APPROVAL_PENDING' ? `Not yet. Your ${amt} purchase still needs your approval at PayPal. Nothing is paid.`
      : p.state === 'PAYER_APPROVED' || p.state === 'CAPTURE_PENDING' ? `Not confirmed yet. You approved it at PayPal, and SaySafe is still waiting for PayPal to confirm the ${amt} payment. Don’t pay again.`
      : `No. ${paymentLabel(p.state)}. Nothing was paid.`;
    add('assistant', t, [familyStatusFrom(p)]); say(t, turn);
  };
  const showLastPayment = async (turn: number) => {
    const list = await api<unknown[]>('/api/payments');
    if (!speech.isCurrent(turn)) return;
    const rows = (Array.isArray(list) ? list : []).map((x) => ServerPayment.safeParse(x)).filter((x) => x.success).map((x) => x.data!);
    const paid = rows.find((p) => p.receipt);
    if (!paid) { const text = rows.length ? 'None of your payments has finished yet. Here is what is waiting.' : 'You haven’t made a payment yet.'; if (rows.length) await showHistoryText(text, turn); else { add('assistant', text); say(text, turn); } return; }
    await appendReceipt(paid.id, `Your last payment: ${new Intl.NumberFormat('en-IE', { style: 'currency', currency: paid.receipt!.currency }).format(Number(paid.receipt!.amount))} to ${paid.receipt!.payee.replace(' (sandbox)', '')}, confirmed by PayPal. It was a sandbox payment, so no real money moved.`, turn);
  };
  const showRefund = async (turn: number, id?: string) => {
    const p = id ? await fetchPayment(id) : await latestPaid();
    if (!speech.isCurrent(turn)) return;
    if (!p) { const t = 'You have no finished payment to ask a refund for.'; add('assistant', t); return say(t, turn); }
    const block = refundFrom(p);
    const t = block.status === 'can_request' ? 'You can ask the shop for a refund. It is only a request: the shop decides.' : block.status === 'REFUND_REQUESTED' ? 'Your refund request was sent. It is not refunded yet.' : block.status === 'REFUNDED' ? 'This payment was refunded.' : block.status === 'REFUND_PENDING' ? 'The refund was sent to PayPal and is not confirmed yet.' : 'This purchase has no refund option.';
    add('assistant', t, [block]);
    say(t, turn);
  };
  const showHistoryText = async (text: string, turn: number) => {
    const a = parseServer(ServerActivity, await fetchActivity({ type: 'payment', limit: 5 }));
    add('assistant', text, [historyFrom(a)]);
    say(text, turn);
  };
  const showHelp = async (reply: string, turn: number, lang?: string) => {
    const t = await api<{ helpPages: { label: string; value: string }[] }>('/api/trusted').catch(() => ({ helpPages: [] }));
    if (!speech.isCurrent(turn)) return;
    const items = [{ label: 'Order problems, or ask your family', to: '/help' }, ...t.helpPages.slice(0, 3).map((h) => ({ label: h.label, href: h.value }))];
    add('assistant', reply, [{ kind: 'trusted_links', items }], lang);
    say(reply, turn, lang);
  };

  // ---------- one entry point for typed and spoken messages ----------
  const handle = useCallback(async (raw: string, via: 'voice' | 'text' = 'text') => {
    const text = raw.trim();
    if (!text) return;
    add('user', text);
    setInput('');
    setBusy(true);
    const turn = speech.beginTurn();
    const mode = threadRef.current.mode;
    // The products the conversation is about: the newest product cards, skipping a Demo Shop alternative that was only
    // offered after real listings in the same turn.
    const ctx = (() => {
      const ms = threadRef.current.messages; let offer: BlockOf<'product_cards'> | null = null;
      for (let i = ms.length - 1; i >= 0; i--) for (let j = ms[i].blocks.length - 1; j >= 0; j--) {
        const bl = ms[i].blocks[j];
        if (bl.kind !== 'product_cards') continue;
        if (bl.note === DEMO_OFFER_NOTE) { offer = offer ?? bl; continue; }
        return bl;
      }
      return offer;
    })();
    try {
      // A Demo Membership cancel card is waiting: a spoken or typed "yes" never cancels, in any mode (only the tap does).
      if (/^(yes|yeah|yep|ok|okay|sure|go ahead|confirm|do it|cancel it|please do)\b[\s.!]*$/i.test(text) && lastBlock('demo_cancel_intent')?.phase === 'confirm') { add('assistant', TAP_ONLY_REPLY); return say(TAP_ONLY_REPLY, turn); }
      const f = parseFollowup(text, Boolean(ctx));
      if (f.kind === 'refund') return await showRefund(turn);
      if (f.kind === 'payment_status') return await showPaymentStatus(turn);
      // "Search real shops" / "real product search" (chip, typed or spoken): Channel3 for the product named, or the
      // one the last "not in the Demo Shop" answer was about.
      const rs = realShopSearch(text);
      if (rs) {
        const q = rs.query ?? lastRealQuery();
        if (!q) { const t = 'What would you like me to look for in real shops? For example “search real shops for a kettle”.'; add('assistant', t); return say(t, turn); }
        setMode('find');
        const out = await discover(q, turn, undefined, undefined, undefined, true);
        if (out.status === 'stale' || !speech.isCurrent(turn)) return;
        if (out.status === 'shown') return say('Here are real listings. You’d buy them on the retailer’s own website.', turn);
        const t = out.status === 'error' ? `I couldn’t reach the real-shop search just now. ${(out.message ?? '').slice(0, 200)}` : `I searched real shops for “${q}” and found no matching listings. Try other words.`;
        add('assistant', t); return say(t, turn);
      }
      if (f.kind === 'search') return await showHistory(turn, f.q);
      // "Show my last payment" is answered by the server from every source (Demo Shop, records, sample data).
      if (f.kind === 'last_payment' && /\breceipt\b/i.test(text)) return await showLastPayment(turn);
      // "Show my payments / all my transactions / purchases above €50": answered by the server (every record she can
      // see, counted by kind, newest 10 shown) — not the first page of Demo Shop rows.
      if (ctx) {
        const focus = ctx.items.find((i) => i.id === threadRef.current.focusId) ?? ctx.items[0];
        if (f.kind === 'age') { const a = ageAnswer(ctx.items, f.age, shortTitle); add('assistant', a); return say(a, turn); }
        if (f.kind === 'seller') { const a = sellerAnswer(sellerFacts(focus, ctx.items, ctx.source === 'demo')); add('assistant', a); return say(a, turn); }
        if (f.kind === 'compare') {
          const two = /\b(first|top) two\b|\b(1|one) and (2|two)\b/i.test(text);
          return compare(two ? { ...ctx, items: ctx.items.slice(0, 2) } : ctx);
        }
        // "Show me the cheaper one": pick it from what is ALREADY on screen (no new search, real product id).
        if (f.kind === 'cheaper' && /\bthe (cheaper|cheapest|less expensive) one\b|^(the )?(cheaper|cheapest) one[?.!]*$/i.test(text)) {
          const pick = [...ctx.items].sort((a, b) => a.price - b.price)[0];
          setThread((t) => ({ ...t, focusId: pick.id }));
          const a = `The cheapest one shown is ${shortTitle(pick.title)}: ${new Intl.NumberFormat('en-IE', { style: 'currency', currency: pick.currency }).format(pick.price)} at ${pick.retailer}.${ctx.source === 'channel3' ? ' You’d buy it on the retailer’s website.' : ''}`;
          add('assistant', a, [{ kind: 'product_cards', source: ctx.source, query: ctx.query, items: [pick], fetchedAt: ctx.fetchedAt, note: 'From the listings above. Prices can change.' }]);
          return say(a, turn);
        }
        if (f.kind === 'cheaper') {
          const cheapest = Math.min(...ctx.items.map((i) => i.price));
          const best = ctx.items[0];
          if (ctx.source === 'channel3') return await discover(ctx.query, turn, Math.round((best.price - 0.01) * 100) / 100, `Cheaper than ${new Intl.NumberFormat('en-IE', { style: 'currency', currency: best.currency }).format(best.price)}`);
          const more = await api<any[]>(`/api/products?q=${encodeURIComponent(ctx.query)}&max=${(cheapest - 0.01).toFixed(2)}`);
          if (!speech.isCurrent(turn)) return;
          const cheaper = more.filter((p) => p.priceCents / 100 < cheapest);
          if (!cheaper.length) { const a = 'That is already the lowest price for this in the Demo Shop.'; add('assistant', a); return say(a, turn); }
          return showDemo(cheaper, ctx.query, `I found ${cheaper.length} cheaper option${cheaper.length > 1 ? 's' : ''}.`, turn);
        }
      }
      // In "check a message" mode, a short request ("Compare real shops for a kettle") is a request, not a message to check.
      const shortRequest = text.length < 80 && !/https?:|www\.|@|\+?\d[\d\s-]{6,}|€|\$|£/.test(text) && /^(please\s+|ok,?\s+|okay,?\s+)?(find|buy|compare|show|help me|i need|i want|look for|search|get me|cancel|send|who|what|which|did i|have i|let's|lets|can you|did my|has my|is my|do i)\b/i.test(text);
      if (mode === 'check' && !looksCompanion(text) && !shortRequest) return await scan(text, turn);
      if (mode === 'check' && shortRequest) setMode('chat');
      // "Help me cancel this one" right after a subscriptions card: name the highlighted subscription.
      let sendText = text;
      const listCard = lastBlock('subscriptions_list');
      if (listCard && /\b(cancel|stop)\b.{0,20}\b(this|that|it)( one)?\b/i.test(text)) {
        const hid = listCard.focus === 'next' ? listCard.highlight.nextId : listCard.focus === 'most' ? listCard.highlight.mostMonthlyId : null;
        const sub = listCard.subscriptions.find((x) => x.id === hid);
        if (sub) sendText = `cancel ${sub.merchant}`;
      }
      const r = await api<any>('/api/assistant', { body: { text: sendText, via, step: mode === 'find' ? (ctx ? 'choosing' : 'shop') : mode === 'help' ? 'help' : 'home', lastResults: ctx?.items.slice(0, 5).map((i) => i.title) ?? [] } });
      if (!speech.isCurrent(turn)) return;
      const a = r.intent?.action;
      // Payment companion: the server answered from Mary's own records (template reply + one card). Spoken reply stays short.
      if (r.clientAction === 'latest_receipt') return await showLastPayment(turn);
      if (r.companion || (Array.isArray(r.blocks) && r.blocks.length)) {
        add('assistant', r.reply, [...(r.companion ? [r.companion] : []), ...(Array.isArray(r.blocks) ? r.blocks.slice(0, 3) : [])], 'en');
        return say(shortSpoken(r.reply), turn);
      }
      if (a === 'payment_status') return await showPaymentStatus(turn);
      if (a === 'check_message') {
        const msg = r.intent.message_text && r.intent.message_text !== text ? r.intent.message_text : text.length > 40 ? text : '';
        if (msg) return await scan(msg, turn);
        setMode('check'); add('assistant', PROMPT.check, [trainingBlock()]); return say(PROMPT.check, turn);
      }
      if (a === 'shop' || r.discover) {
        setMode('find');
        // Not in the Demo Shop: say so and list what it sells (server catalogue), then look in real shops if available.
        if (Array.isArray(r.catalogue) && r.catalogue.length) {
          return await notInDemoShop(r.catalogue, typeof r.realQuery === 'string' ? r.realQuery : r.discover?.query ?? null, Boolean(r.discover), turn, typeof r.discover?.lead === 'string' ? r.discover.lead.slice(0, 300) : undefined, typeof r.discover?.maxPrice === 'number' ? r.discover.maxPrice : undefined);
        }
        if (r.discover) return await discover(r.discover.query ?? text, turn, typeof r.discover.maxPrice === 'number' ? r.discover.maxPrice : undefined, undefined, Array.isArray(r.demoOffer) ? r.demoOffer : undefined, false, r.discover.ignoreMemory === true, typeof r.discover.lead === 'string' ? r.discover.lead.slice(0, 300) : undefined);
        if (r.buyNow && Array.isArray(r.products) && r.products.length === 1) {
          const item = productItems(r.products.map(fromDemo))[0];
          if (item) return await prepare(item, r.reply);
        }
        return showDemo(r.products ?? [], r.intent.query ?? text, r.reply, turn, r.replyLang);
      }
      if (a === 'select_product' && ctx && r.intent.choice_index) {
        const item = ctx.items[r.intent.choice_index - 1];
        if (item) { setThread((t) => ({ ...t, focusId: item.id })); if (ctx.source === 'demo') return await prepare(item); setSheet({ item, source: ctx.source }); return; }
      }
      if (a === 'cancel') { const ready = lastBlock('payment_prep'); if (ready?.status === 'ready') return deny(ready); }
      // A spoken or typed "yes" never cancels the Demo Membership: only the tap on the card sends the token.
      if (a === 'confirm' && lastBlock('demo_cancel_intent')?.phase === 'confirm') { add('assistant', TAP_ONLY_REPLY); return say(TAP_ONLY_REPLY, turn); }
      if (a === 'confirm') { const ready = lastBlock('payment_prep'); if (ready?.status === 'ready') { const m = 'To be safe, please tap Allow on the card yourself.'; add('assistant', m); return say(m, turn); } }
      if (a === 'trusted_help' || a === 'order_problem' || mode === 'help') return await showHelp(r.reply, turn, r.replyLang);
      add('assistant', r.reply, [], r.replyLang);
      say(r.reply, turn, r.replyLang);
    } catch (e: any) {
      // A failed request is an error with Retry, never "no records".
      if (speech.isCurrent(turn)) add('assistant', '', [{ kind: 'retry_error', message: String(e?.message || 'Something went wrong. Nothing was charged.').slice(0, 400), retryText: text, done: false }]);
    } finally { setBusy(false); speech.endThinking(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const voice = useVoiceInput((t) => { void handle(t, 'voice'); });

  // Shortcuts open the conversation with a mode preselected (?mode=check|find|help|payments).
  useEffect(() => {
    if (!me) return;
    const m = ModeSchema.safeParse(sp.get('mode'));
    if (!m.success) return;
    const mode = m.data;
    setThread((t) => {
      const last = t.messages[t.messages.length - 1];
      if (last?.role === 'assistant' && last.text === PROMPT[mode]) return { ...t, mode };
      // A brand-new conversation: the mode prompt replaces the general greeting.
      if (t.messages.length === 1 && t.messages[0].text === PROMPT.chat) return fresh(mode);
      return { ...t, mode, messages: [...t.messages, { id: mid(), role: 'assistant', text: PROMPT[mode], blocks: [] }] };
    });
    nav('/assistant', { replace: true });
    if (mode === 'payments') { const turn = speech.beginTurn(); showHistory(turn).catch(() => {}).finally(() => speech.endThinking()); }
    else setTimeout(() => inputRef.current?.focus(), 50);
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (fn: (turn: number) => Promise<unknown>) => { const turn = speech.beginTurn(); fn(turn).catch((e: any) => add('assistant', e.message || 'Something went wrong. Nothing was charged.')).finally(() => speech.endThinking()); };
  const act: BlockActions = {
    openItem: (item, source) => { setThread((t) => ({ ...t, focusId: item.id })); setSheet({ item, source }); }, compare, allow, deny, share,
    replace: (old, next) => updateBlock((b) => b === old || (b.kind === next.kind && b.kind !== 'payment_history' && 'requestId' in b && 'requestId' in next && b.requestId === next.requestId && 'requestId' in old && old.requestId === b.requestId), next),
    receipt: (id) => run((turn) => appendReceipt(id, undefined, turn)),
    refund: (id) => run((turn) => showRefund(turn, id)),
    synced: (p) => { const rc = receiptFrom(p); if (rc) updateBlock((b) => b.kind === 'receipt' && b.requestId === p.id, rc); },
    audience: 'elder',
    append: (text, blocks, o) => { add('assistant', text, blocks, 'en'); if (o?.speak) say(shortSpoken(text)); },
    send: (text) => { void handle(text); },
    scan: (text) => { add('user', 'Check this training example'); setBusy(true); const turn = speech.beginTurn(); scan(text, turn).catch((e: any) => add('assistant', '', [{ kind: 'retry_error', message: String(e?.message ?? 'The check failed.').slice(0, 400), retryText: text, done: false }])).finally(() => { setBusy(false); speech.endThinking(); }); },
    speak: (text) => say(text),
  };

  // Companion suggestion chips: answered on the device from Mary's own records (nothing guessed, nothing written).
  const companionChip = (chip: string) => run(async (turn) => {
    setMode('chat');
    add('user', chip);
    if (chip === COMPANION_CHIPS[0]) {
      const t = 'Tell me who and roughly how much, for example “Did I already pay John €80?”. Or search the records you saved.';
      add('assistant', t, [{ kind: 'companion_records', section: 'payments' }]); return say(shortSpoken(t, 1), turn);
    }
    if (chip === COMPANION_CHIPS[1]) {
      const summary = parseServer(SubscriptionSummary, await api('/api/companion/subscriptions/summary'));
      if (!speech.isCurrent(turn)) return;
      const t = !summary.totals.length ? 'You haven’t added any subscriptions yet. Add them here and I’ll add up what they cost.'
        : `From the subscriptions you added, that’s about ${summary.totals.map((x) => `${companionMoney(x.monthlyCents, x.currency)} a month`).join(' and ')}. You entered these yourself.`;
      add('assistant', t, [{ kind: 'monthly_costs', summary }]); return say(t, turn);
    }
    const t = 'Here are the contacts you saved. You can also ask, for example, “my son’s number”.';
    add('assistant', t, [{ kind: 'companion_records', section: 'contacts' }]); say(shortSpoken(t, 1), turn);
  });

  // First "Try as Mary" visit (?welcome=1): a short welcome with six prompts that work on the sample data.
  useEffect(() => {
    if (!me || sp.get('welcome') !== '1') return;
    setThread((t) => (t.messages.some((m) => m.blocks.some((b) => b.kind === 'demo_welcome')) ? t : fresh('chat')));
    setTimeout(() => add('assistant', `Hello ${me.name}. Here’s what you can try.`, [{ kind: 'demo_welcome', prompts: [...WELCOME_PROMPTS] }], 'en'), 0);
    // What she can shop for: the Demo Shop catalogue from the server (not hard-coded here).
    api<any[]>('/api/products').then((ps) => {
      const items = (Array.isArray(ps) ? ps : []).map((p) => ({ productId: p.id, name: p.name, category: p.category, priceCents: p.priceCents, currency: p.currency }));
      if (items.length) add('assistant', 'You can shop the Demo Shop below (PayPal Sandbox, no real money), or ask for anything else and I’ll search real shops.', [{ kind: 'shop_catalogue', items, channel3: true }], 'en');
    }).catch(() => {});
    nav('/assistant', { replace: true });
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from PayPal after starting the Demo Membership (?membership=<PayPal status>), or opened from Profile
  // (?records=payments|subscriptions|contacts). The card re-reads the server; the URL value is only a hint.
  useEffect(() => {
    if (!me) return;
    const ms = sp.get('membership');
    const rec = sp.get('records');
    if ((ms && /^[a-z_]{2,30}$/.test(ms)) || ['payments', 'subscriptions', 'contacts'].includes(rec ?? '')) setMode('chat');
    if (ms && /^[a-z_]{2,30}$/.test(ms)) {
      add('assistant', ms === 'active' ? 'Back from PayPal. Here is what PayPal says about your Demo Membership.' : 'Here is your Demo Membership, checked with PayPal.', [{ kind: 'demo_membership', returned: ms }], 'en');
      nav('/assistant', { replace: true });
    } else if (rec === 'payments' || rec === 'subscriptions' || rec === 'contacts') {
      add('assistant', rec === 'payments' ? 'Here are the payment records you saved.' : rec === 'subscriptions' ? 'Here are the subscriptions you added.' : 'Here are the contacts you saved.', [{ kind: 'companion_records', section: rec }], 'en');
      nav('/assistant', { replace: true });
    }
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from PayPal (or opened from a receipt): re-read the purchase from the server and add its card. Never trusts the URL.
  useEffect(() => {
    if (!me) return;
    const fromReceipt = (loc.state as { receiptId?: string } | null)?.receiptId;
    const id = pendingPayPalReturn() ?? (fromReceipt && /^pay_[A-Za-z0-9_-]{4,60}$/.test(fromReceipt) ? fromReceipt : null);
    if (!id) return;
    const viaPayPal = pendingPayPalReturn() === id;
    fetchPayment(id).then((p) => {
      const t = threadRef.current;
      if (p.receipt) { clearPayPalReturn(); if (!hasBlockFor(t, 'receipt', p.id)) { const b = receiptFrom(p)!; add('assistant', viaPayPal ? 'Back from PayPal. Here is your receipt, checked with PayPal.' : 'Here is that receipt, checked with PayPal.', [b]); } return; }
      if (['CANCELLED', 'FAILED', 'BLOCKED'].includes(p.state)) clearPayPalReturn();
      if (!hasBlockFor(t, 'family_status', p.id, 1)) add('assistant', p.state === 'PAYER_APPROVAL_PENDING' ? 'You haven’t approved this at PayPal yet. Nothing was paid.' : `${paymentLabel(p.state)}.`, [familyStatusFrom(p)]);
    }).catch(() => {});
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pending purchase in this conversation: ask before leaving (never cancels).
  const prepReady = thread.messages.flatMap((m) => m.blocks).filter((b): b is BlockOf<'payment_prep'> => b.kind === 'payment_prep' && (b.status === 'ready' || b.status === 'sending'));
  const famPending = thread.messages.flatMap((m) => m.blocks).filter((b): b is BlockOf<'family_status'> => b.kind === 'family_status').reduce((acc, b) => acc.set(b.requestId, b), new Map<string, BlockOf<'family_status'>>());
  const famWaiting = [...famPending.values()].filter((b) => b.state === 'FAMILY_APPROVAL_PENDING');
  const guardId = prepReady[0]?.idempotencyKey ?? famWaiting[0]?.requestId ?? 'none';

  const modeInfo = MODES.find((m) => m.mode === thread.mode);
  const micLabel = voice.state === 'listening' ? 'Stop listening' : voice.state === 'processing' ? 'Cancel' : voice.state === 'speaking' ? 'Interrupt and speak' : 'Speak';
  const composer = (
    <div className="mx-auto max-w-5xl px-3 sm:px-5 py-2">
      {menu && (
        <div id="mode-menu" className="mb-2 grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
          {MODES.map(({ mode, label, icon: Icon }) => (
            <button key={mode} type="button" aria-pressed={thread.mode === mode} onClick={() => { setMenu(false); setMode(mode); add('assistant', PROMPT[mode]); if (mode === 'payments') { const t = speech.beginTurn(); showHistory(t).catch(() => {}).finally(() => speech.endThinking()); } else inputRef.current?.focus(); }}
              className={`flex items-center gap-2 min-h-12 px-4 rounded-2xl border-2 font-bold text-left ${thread.mode === mode ? 'border-teal bg-teal-soft' : 'border-line bg-paper hover:border-teal'}`}><Icon className="size-5 text-teal shrink-0" aria-hidden />{label}</button>
          ))}
          <button type="button" onClick={() => { setMenu(false); fileRef.current?.click(); }} className="flex items-center gap-2 min-h-12 px-4 rounded-2xl border-2 border-line bg-paper font-bold hover:border-teal"><ImageUp className="size-5 text-teal shrink-0" aria-hidden />Check a screenshot</button>
        </div>
      )}
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void handle(input); }}>
        <button type="button" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-controls="mode-menu" aria-label="More: choose what to do" className="size-12 shrink-0 rounded-full border-2 border-line bg-paper grid place-items-center hover:border-teal"><Plus className="size-6" aria-hidden /></button>
        <label htmlFor="assistant-input" className="sr-only">{modeInfo ? `${modeInfo.label}: type here` : 'Message SaySafe'}</label>
        <textarea id="assistant-input" ref={inputRef} rows={1} value={input} maxLength={4000} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handle(input); } }}
          placeholder={modeInfo?.placeholder ?? 'Message'} className="flex-1 min-w-0 min-h-12 max-h-32 resize-none rounded-3xl border-2 border-line bg-paper px-4 py-2.5 leading-snug focus:border-teal outline-none" />
        {voice.state !== 'unsupported' && (!input.trim() || voice.state !== 'idle') && (
          <button type="button" onClick={voice.toggle} aria-pressed={voice.state === 'listening'} aria-label={micLabel}
            className={`min-h-12 min-w-12 shrink-0 rounded-full inline-flex items-center justify-center gap-1.5 px-3 min-[360px]:px-4 font-bold text-white ${voice.state === 'listening' ? 'bg-danger ring-4 ring-danger/25' : 'bg-teal hover:bg-teal-deep'}`}>
            {voice.state === 'processing' ? <Loader2 className="size-6 motion-safe:animate-spin" aria-hidden /> : voice.state === 'listening' ? <Square className="size-5" fill="currentColor" aria-hidden /> : <Mic className="size-6" aria-hidden />}
            <span aria-hidden className="max-[359px]:hidden">{voice.state === 'listening' ? 'Stop' : voice.state === 'processing' ? 'Cancel' : 'Speak'}</span>
          </button>
        )}
        {(input.trim() || voice.state === 'unsupported') && <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className="size-12 shrink-0 rounded-full bg-navy text-white grid place-items-center disabled:opacity-40"><SendHorizontal className="size-6" aria-hidden /></button>}
      </form>
      {voice.error && <p role="alert" className="mt-1 text-danger font-bold text-base">{voice.error}</p>}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="Upload a screenshot to check" onChange={(e) => { const f = e.target.files?.[0]; if (f) void scanImage(f); }} />
    </div>
  );

  if (!me) return <Layout><p>Loading…</p></Layout>;
  const lastMsg = thread.messages[thread.messages.length - 1];
  const lastKind = lastMsg?.blocks[lastMsg.blocks.length - 1]?.kind;
  const suggestions = !busy && lastMsg?.role === 'assistant' && lastKind ? SUGGEST[lastKind] ?? [] : [];
  // With nothing else to suggest (a text-only reply, e.g. the greeting), offer the companion questions.
  // Starter questions only for a brand-new conversation, never after a reply in an established one.
  const chips = !busy && thread.messages.length === 1 && lastMsg?.role === 'assistant' && !lastKind && thread.mode !== 'check' ? COMPANION_CHIPS : [];
  return (
    <Layout dock={composer} footer={false}>
      <LeaveGuard when={prepReady.length > 0 || famWaiting.length > 0} id={guardId}
        title={prepReady.length ? 'You haven’t answered the payment card yet' : 'Still waiting for your family member'}
        detail={prepReady.length ? 'Nothing has been paid.' : 'Your purchase is waiting for their answer.'} />
      <AssistantHeader onNew={() => { speech.stopAll(); setThread(fresh(thread.mode)); }} />
      <p className="mt-1 text-base text-ink-soft flex items-start gap-2"><ShieldCheck className="size-5 text-teal shrink-0 mt-0.5" aria-hidden />PayPal Sandbox only: no real money. You always approve at PayPal.</p>
      <SpokenRepliesBar />
      <MemoryNotice />
      <div role="log" aria-live="polite" aria-label="Conversation" className="mt-4 flex flex-col gap-3">
        {thread.messages.map((m) => (
          <div key={m.id} data-role={m.role} className={`scroll-mt-24 ${m.role === 'user' ? 'self-end max-w-[85%]' : 'self-start w-full max-w-2xl'}`}>
            {m.text && (
              <p lang={m.lang && m.lang !== 'en' ? m.lang : undefined} className={`rounded-3xl px-4 py-3 break-words whitespace-pre-wrap ${m.role === 'user' ? 'bg-navy text-white rounded-br-lg' : 'bg-teal-soft text-navy rounded-bl-lg'}`}>
                <span className="sr-only">{m.role === 'user' ? 'You: ' : 'SaySafe: '}</span>{m.text}
              </p>
            )}
            {m.blocks.map((b, i) => <div key={i} className="mt-2"><RenderBlock b={b} act={act} /></div>)}
          </div>
        ))}
        {busy && <p className="self-start rounded-3xl bg-teal-soft px-4 py-3 text-ink-soft inline-flex items-center gap-2"><Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />Thinking…</p>}
      </div>
      {suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggestions" role="group">
          {suggestions.map((s) => <button key={s} type="button" onClick={() => { if (s === 'Refund options') { const r = lastBlock('receipt'); if (r) return act.refund(r.requestId); } void handle(s); }} className="min-h-12 px-4 rounded-full border-2 border-teal text-teal-deep bg-paper font-bold">{s}</button>)}
        </div>
      )}
      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Ask about your records" role="group">
          {chips.map((c) => <button key={c} type="button" onClick={() => companionChip(c)} className="min-h-12 px-4 rounded-full border-2 border-teal text-teal-deep bg-paper font-bold text-left">{c}</button>)}
        </div>
      )}
      <div ref={endRef} />
      {sheet && <ProductSheet item={sheet.item} source={sheet.source} onClose={() => setSheet(null)} onPrepare={prepare} />}
    </Layout>
  );
}
