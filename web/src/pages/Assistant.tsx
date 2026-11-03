/**
 * One conversation for everything: check a message, find a product, trusted help, payments. Text and voice
 * share the app-wide speech controller. Inline components come only from the registry (assistant/blocks.tsx)
 * with validated data (assistant/schemas.ts). Payments still go through the existing quote -> request ->
 * family review -> PayPal approval -> server capture flow; nothing here can approve or capture by itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Mic, Square, Loader2, SendHorizontal, MessageSquareWarning, ShoppingBag, LifeBuoy, Wallet, ImageUp, ShieldCheck, RotateCcw } from 'lucide-react';
import { Layout } from '../components/Layout';
import { LeaveGuard } from '../components/LeaveGuard';
import { api, newKey, type PaymentRequest, type ScanResult } from '../lib/api';
import { speech, useVoiceInput } from '../lib/voice';
import { useMe } from '../lib/session';
import { spokenScam, spokenFamily } from '../lib/spoken';
import { localProfileForRequest } from '../lib/prefs';
import { fetchActivity } from '../lib/activity';
import { goToPayPal } from '../lib/handoff';
import { normaliseLang } from '../../../shared/lang';
import { compareRows, shortTitle, type ShopItem, type Recommendation } from '../../../shared/shopping';
import { parseBlock, productItems, restoreThread, Mode as ModeSchema, type Block, type BlockOf, type Message, type Mode, type ProductItem, type Thread } from '../assistant/schemas';
import { parseFollowup, ageAnswer, sellerAnswer, sellerFacts, toShopItem } from '../assistant/followups';
import { RenderBlock, ProductSheet, type BlockActions } from '../assistant/blocks';

const KEY = 'ss-assistant-thread';
const MODES: { mode: Exclude<Mode, 'chat'>; label: string; icon: typeof Mic; placeholder: string }[] = [
  { mode: 'check', label: 'Check a message', icon: MessageSquareWarning, placeholder: 'Paste the message' },
  { mode: 'find', label: 'Find a product', icon: ShoppingBag, placeholder: 'e.g. kettle under €40' },
  { mode: 'help', label: 'Get trusted help', icon: LifeBuoy, placeholder: 'What’s wrong?' },
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
};
const mid = () => Math.random().toString(36).slice(2, 10);
const fresh = (mode: Mode = 'chat'): Thread => ({ v: 1, mode, focusId: null, messages: [{ id: mid(), role: 'assistant', text: PROMPT[mode], blocks: [] }] });
const load = (): Thread => { try { return restoreThread(sessionStorage.getItem(KEY)) ?? fresh(); } catch { return fresh(); } };

/** Server shapes -> registry data (then validated by the schemas). */
function fromDemo(p: { id: string; name: string; priceCents: number; currency: string; merchant: string; plainWords?: string; features: string[]; image: string; description?: string }): unknown {
  return { id: `demo:${p.id}`, productId: p.id, title: p.name, brand: null, image: `/products/${p.image}`, imageAlt: '', features: p.features, price: p.priceCents / 100, compareAt: null, currency: p.currency, retailer: p.merchant, url: null, availability: 'Unknown', description: p.description ?? null, rating: null };
}
function fromChannel3(p: ShopItem, rec?: Recommendation): unknown {
  const o = p.offers[0];
  const pick = rec?.picks.find((k) => k.id === p.id);
  return { id: p.id, title: p.title, brand: p.brand, image: p.image, imageAlt: p.imageAlt || '', features: p.features.slice(0, 12), price: o?.price ?? 0, compareAt: o?.compareAt ?? null, currency: o?.currency ?? 'EUR', retailer: o?.retailer ?? 'Shop', url: o?.url || null, availability: o?.availability ?? 'Unknown', attributes: p.attributes, description: p.description ? p.description.slice(0, 2000) : null, rating: p.rating, role: pick?.role, reasons: pick?.reasons.slice(0, 5) };
}

export default function Assistant() {
  const me = useMe('elder');
  const nav = useNavigate();
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
    const block = { kind: 'scam_result', scanId: r.scanId, verdict: r.verdict, headline: r.headline, summary: r.spokenSummary, signals: r.signals.slice(0, 8).map((s) => ({ severity: s.severity, title: s.title, detail: s.detail, ...(s.evidence ? { evidence: s.evidence.slice(0, 300) } : {}) })), safeActions: r.safeActions.slice(0, 4), aiNotice: r.aiNotice ?? null };
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

  const discover = async (text: string, turn: number, maxPrice?: number, label?: string) => {
    try {
      const r = await api<{ products: ShopItem[]; recommendation: Recommendation; reply: string; fetchedAt: string; searchQuery: string }>('/api/discover', { body: { text, maxPrice: maxPrice ?? null, profile: localProfileForRequest() } });
      if (!speech.isCurrent(turn)) return;
      const items = productItems(r.products.map((p) => fromChannel3(p, r.recommendation)));
      if (!items.length) { const msg = label ? `${label}, I found no other listings for ${r.searchQuery}.` : r.reply || 'I found no matching listings.'; add('assistant', msg); say(msg, turn); return; }
      add('assistant', r.reply, [{ kind: 'product_cards', source: 'channel3', query: r.searchQuery || text, items, fetchedAt: r.fetchedAt ?? null, note: null }]);
      setThread((t) => ({ ...t, focusId: null }));
      say(r.reply, turn);
    } catch (e: any) {
      if (speech.isCurrent(turn)) add('assistant', e.message || 'I couldn’t search the shops right now. The SaySafe Demo Shop still works.');
    }
  };

  const showDemo = (products: any[], query: string, reply: string, turn: number, lang?: string) => {
    const items = productItems(products.map(fromDemo));
    if (items.length) items[0] = { ...items[0], role: 'best' };
    add('assistant', reply, items.length ? [{ kind: 'product_cards', source: 'demo', query, items, fetchedAt: null, note: null }] : [], lang);
    setThread((t) => ({ ...t, focusId: null }));
    say(reply, turn, lang);
  };

  const prepare = async (item: ProductItem) => {
    setSheet(null);
    if (!item.productId) return;
    const turn = speech.beginTurn();
    try {
      const q = await api<{ lines: any[]; totalCents: number; currency: string; merchant: string; needsFamily: boolean; thresholdCents: number; spoken: string }>('/api/quote', { body: { items: [{ productId: item.productId, quantity: 1 }] } });
      const extra = q.needsFamily ? ' It’s above your protected limit, so your family member checks it first.' : ' Tap Allow to continue to PayPal, or Deny.';
      add('assistant', q.spoken + extra, [{ kind: 'payment_prep', lines: q.lines.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, lineCents: l.lineCents, image: l.image })), totalCents: q.totalCents, currency: q.currency, merchant: q.merchant, needsFamily: q.needsFamily, thresholdCents: q.thresholdCents, idempotencyKey: newKey(), status: 'ready', requestId: null, error: null }]);
      say(q.spoken + extra, turn);
    } catch (e: any) { add('assistant', e.message); }
    finally { speech.endThinking(); }
  };

  const allow = async (b: BlockOf<'payment_prep'>) => {
    const same = (x: Block) => x.kind === 'payment_prep' && x.idempotencyKey === b.idempotencyKey;
    updateBlock(same, { ...b, status: 'sending', error: null });
    try {
      const r = await api<{ request: PaymentRequest; approveUrl: string | null }>('/api/payments', { body: { items: b.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), idempotencyKey: b.idempotencyKey }, idempotent: true });
      updateBlock(same, { ...b, status: 'sent', requestId: r.request.id, error: null });
      if (r.approveUrl) { goToPayPal(r.approveUrl); return; }
      const req = r.request;
      const text = req.state === 'BLOCKED' ? 'I stopped this purchase for your safety. Nothing was paid.' : spokenFamily(req.state, req.approval?.status) || 'Saved. You can follow it in Activity.';
      add('assistant', text, [{ kind: 'family_status', requestId: req.id, state: req.state, item: req.items.map((i) => i.name).join(', '), amountCents: req.amountCents, currency: req.currency, approvalStatus: req.approval?.status ?? null, reasons: req.risk?.reasons?.slice(0, 5) ?? [] }]);
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

  const showHistory = async (turn: number) => {
    const r = await fetchActivity({ type: 'payment', limit: 5 });
    if (!speech.isCurrent(turn)) return;
    const waiting = r.items.filter((i) => i.statusGroup === 'pending').length;
    const text = r.total === 0 ? 'You have no payments yet.' : `You have ${r.total} payment${r.total === 1 ? '' : 's'}${waiting ? `, ${waiting} waiting` : ''}. Tap one to see it.`;
    add('assistant', text, [{ kind: 'payment_history', total: r.total, items: r.items.map((i) => ({ id: i.id, title: i.title, amountCents: i.amountCents ?? 0, currency: i.currency ?? 'EUR', status: i.status, at: i.at })) }]);
    say(text, turn);
  };
  const showLastPayment = async (turn: number) => {
    const list = await api<PaymentRequest[]>('/api/payments');
    if (!speech.isCurrent(turn)) return;
    const paid = list.find((p) => p.receipt);
    if (!paid) { const text = list.length ? 'None of your payments has finished yet. Here is what is waiting.' : 'You haven’t made a payment yet.'; if (list.length) await showHistoryText(text, turn); else { add('assistant', text); say(text, turn); } return; }
    const r = await api<PaymentRequest>(`/api/payments/${paid.id}`);
    if (!speech.isCurrent(turn)) return;
    const rc = r.receipt!;
    const text = `Your last payment: ${new Intl.NumberFormat('en-IE', { style: 'currency', currency: rc.currency }).format(Number(rc.amount))} to ${rc.payee.replace(' (sandbox)', '')}, confirmed by PayPal. It was a sandbox payment, so no real money moved.`;
    add('assistant', text, [{ kind: 'receipt', requestId: r.id, state: r.state, item: r.items.map((i) => `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`).join(', '), merchant: r.merchant, amountCents: r.amountCents, currency: r.currency, receipt: { captureId: rc.captureId, amount: rc.amount, currency: rc.currency, payee: rc.payee, orderId: rc.orderId, webhookConfirmed: Boolean(rc.webhookConfirmed) }, evidenceLabel: r.timeline?.label ?? null, verifiedSteps: r.timeline?.events.filter((e) => e.verified).length ?? 0, at: r.updatedAt.includes('T') ? r.updatedAt : `${r.updatedAt.replace(' ', 'T')}Z` }]);
    say(text, turn);
  };
  const showHistoryText = async (text: string, turn: number) => {
    const r = await fetchActivity({ type: 'payment', limit: 5 });
    add('assistant', text, [{ kind: 'payment_history', total: r.total, items: r.items.map((i) => ({ id: i.id, title: i.title, amountCents: i.amountCents ?? 0, currency: i.currency ?? 'EUR', status: i.status, at: i.at })) }]);
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
  const handle = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    add('user', text);
    setInput('');
    setBusy(true);
    const turn = speech.beginTurn();
    const mode = threadRef.current.mode;
    const ctx = lastBlock('product_cards');
    try {
      const f = parseFollowup(text, Boolean(ctx));
      if (f.kind === 'last_payment') return await showLastPayment(turn);
      if (f.kind === 'payments') return await showHistory(turn);
      if (ctx) {
        const focus = ctx.items.find((i) => i.id === threadRef.current.focusId) ?? ctx.items[0];
        if (f.kind === 'age') { const a = ageAnswer(ctx.items, f.age, shortTitle); add('assistant', a); return say(a, turn); }
        if (f.kind === 'seller') { const a = sellerAnswer(sellerFacts(focus, ctx.items, ctx.source === 'demo')); add('assistant', a); return say(a, turn); }
        if (f.kind === 'compare') return compare(ctx);
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
      if (mode === 'check') return await scan(text, turn);
      if (mode === 'payments') return await showHistory(turn);
      const r = await api<any>('/api/assistant', { body: { text, step: mode === 'find' ? (ctx ? 'choosing' : 'shop') : mode === 'help' ? 'help' : 'home', lastResults: ctx?.items.slice(0, 5).map((i) => i.title) ?? [] } });
      if (!speech.isCurrent(turn)) return;
      const a = r.intent?.action;
      if (a === 'check_message') {
        const msg = r.intent.message_text && r.intent.message_text !== text ? r.intent.message_text : text.length > 40 ? text : '';
        if (msg) return await scan(msg, turn);
        setMode('check'); add('assistant', PROMPT.check); return say(PROMPT.check, turn);
      }
      if (a === 'shop' || r.discover) {
        setMode('find');
        if (r.discover) return await discover(r.discover.query ?? text, turn);
        return showDemo(r.products ?? [], r.intent.query ?? text, r.reply, turn, r.replyLang);
      }
      if (a === 'select_product' && ctx && r.intent.choice_index) {
        const item = ctx.items[r.intent.choice_index - 1];
        if (item) { setThread((t) => ({ ...t, focusId: item.id })); if (ctx.source === 'demo') return await prepare(item); setSheet({ item, source: ctx.source }); return; }
      }
      if (a === 'cancel') { const ready = lastBlock('payment_prep'); if (ready?.status === 'ready') return deny(ready); }
      if (a === 'confirm') { const ready = lastBlock('payment_prep'); if (ready?.status === 'ready') { const m = 'To be safe, please tap Allow on the card yourself.'; add('assistant', m); return say(m, turn); } }
      if (a === 'trusted_help' || a === 'order_problem' || mode === 'help') return await showHelp(r.reply, turn, r.replyLang);
      add('assistant', r.reply, [], r.replyLang);
      say(r.reply, turn, r.replyLang);
    } catch (e: any) {
      if (speech.isCurrent(turn)) add('assistant', e.message || 'Something went wrong. Nothing was charged.');
    } finally { setBusy(false); speech.endThinking(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const voice = useVoiceInput((t) => { void handle(t); });

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

  const act: BlockActions = { openItem: (item, source) => { setThread((t) => ({ ...t, focusId: item.id })); setSheet({ item, source }); }, compare, allow, deny, share, update: (next) => updateBlock((b) => b.kind === next.kind && 'requestId' in b && 'requestId' in next && b.requestId === next.requestId, next) };

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
          placeholder={modeInfo?.placeholder ?? 'Message SaySafe'} className="flex-1 min-w-0 min-h-12 max-h-32 resize-none rounded-3xl border-2 border-line bg-paper px-4 py-2.5 leading-snug focus:border-teal outline-none" />
        {voice.state !== 'unsupported' && (
          <button type="button" onClick={voice.toggle} aria-pressed={voice.state === 'listening'} aria-label={micLabel}
            className={`size-12 shrink-0 rounded-full grid place-items-center text-white ${voice.state === 'listening' ? 'bg-danger ring-4 ring-danger/25' : 'bg-teal hover:bg-teal-deep'}`}>
            {voice.state === 'processing' ? <Loader2 className="size-6 motion-safe:animate-spin" aria-hidden /> : voice.state === 'listening' ? <Square className="size-5" fill="currentColor" aria-hidden /> : <Mic className="size-6" aria-hidden />}
          </button>
        )}
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className="size-12 shrink-0 rounded-full bg-navy text-white grid place-items-center disabled:opacity-40"><SendHorizontal className="size-6" aria-hidden /></button>
      </form>
      {voice.error && <p role="alert" className="mt-1 text-danger font-bold text-base">{voice.error}</p>}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="Upload a screenshot to check" onChange={(e) => { const f = e.target.files?.[0]; if (f) void scanImage(f); }} />
    </div>
  );

  if (!me) return <Layout><p>Loading…</p></Layout>;
  const lastMsg = thread.messages[thread.messages.length - 1];
  const lastKind = lastMsg?.blocks[lastMsg.blocks.length - 1]?.kind;
  const suggestions = !busy && lastMsg?.role === 'assistant' && lastKind ? SUGGEST[lastKind] ?? [] : [];
  return (
    <Layout dock={composer} footer={false}>
      <LeaveGuard when={prepReady.length > 0 || famWaiting.length > 0} id={guardId}
        title={prepReady.length ? 'You haven’t answered the payment card yet' : 'Still waiting for your family member'}
        detail={prepReady.length ? 'Nothing has been paid.' : 'Your purchase is waiting for their answer.'} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--text-title)]">Assistant</h1>
        <button type="button" onClick={() => { speech.stopAll(); setThread(fresh(thread.mode)); }} className="inline-flex items-center gap-2 min-h-12 px-4 rounded-full border-2 border-line font-bold hover:border-teal"><RotateCcw className="size-5" aria-hidden />New conversation</button>
      </div>
      <p className="mt-1 text-base text-ink-soft flex items-start gap-2"><ShieldCheck className="size-5 text-teal shrink-0 mt-0.5" aria-hidden />Payments use the PayPal Sandbox (no real money) and always need your own approval at PayPal.</p>
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
          {suggestions.map((s) => <button key={s} type="button" onClick={() => void handle(s)} className="min-h-12 px-4 rounded-full border-2 border-teal text-teal-deep bg-paper font-bold">{s}</button>)}
        </div>
      )}
      <div ref={endRef} />
      {sheet && <ProductSheet item={sheet.item} source={sheet.source} onClose={() => setSheet(null)} onPrepare={prepare} />}
    </Layout>
  );
}
