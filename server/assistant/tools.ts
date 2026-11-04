/**
 * The Assistant's read-only tools. Each one reads ONLY the signed-in elder's own records (household + user from the
 * session cookie) and writes its reply from a template, so nothing is invented and the AI never sees the records.
 * None of these functions writes to the database, calls PayPal, creates/captures an order or sends money.
 * Kinds of record are always named separately: real PayPal Sandbox captures, sample (illustrative) data, records Mary
 * typed herself (not verified), and pending/failed attempts. Remembered conversation is never proof of payment.
 */
import type { Session } from '../auth.js';
import { db } from '../db/index.js';
import * as mem from '../memory/store.js';
import { getProfile } from '../prefs/store.js';
import { getPolicy } from '../payments/service.js';
import { listActivity, type ActivityItem } from '../activity.js';
import * as cstore from '../companion/store.js';
import { searchPayments, normName, tokens, tokenSimilarity } from '../companion/match.js';
import { buildSummary } from '../insights/summary.js';
import { WELCOME_PROMPTS } from '../../shared/demoData.js';
import { PAYPAL_SEND_MONEY_URL, SEND_MONEY_NOTICE, type ContactT } from '../../shared/companion.js';
import type { AssistantTool, ToolParamsT } from './route.js';

export interface ToolAnswer {
  reply: string;
  /** Main card (registry block). */
  card?: Record<string, unknown> | null;
  /** Further registry blocks (max 3). */
  blocks?: Record<string, unknown>[];
  /** Something the device does itself with read-only GETs (e.g. show the latest receipt). */
  clientAction?: 'latest_receipt' | null;
  /** What the tool read, for tests and the evidence log (counts only, never values). */
  read?: Record<string, number | string | boolean>;
}

const eur = (cents: number, cur = 'EUR') => new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur }).format(cents / 100);
const dayIE = (iso: string) => new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', timeZone: 'Europe/Dublin' });
const dublinDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n: number, w: string, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const shortTitle = (t: string) => t.replace(/\s*[,|(].*$/, '').split(/\s+/).slice(0, 6).join(' ');
const PRIVATE_TO_ELDER = 'That information is private to the person who saved it. Family members can’t see their memory, preferences, conversations or personal payment records.';
const SIGN_IN = 'Please start SaySafe on this device first. Your records stay private to you.';
const facts = (title: string, items: { label: string; detail?: string | null; tone?: 'ok' | 'warn' | 'info' | 'muted' }[], link?: { label: string; to: string } | { label: string; href: string } | null, note?: string | null) =>
  ({ kind: 'assistant_facts', title: title.slice(0, 80), items: items.slice(0, 12).map((i) => ({ label: (i.label.charAt(0).toUpperCase() + i.label.slice(1)).slice(0, 200), detail: i.detail ? i.detail.slice(0, 300) : null, tone: i.tone ?? 'info' })), link: link ?? null, note: note ? note.slice(0, 400) : null });

export function periodRange(period: ToolParamsT['period'], now = new Date()): { from: string; to: string; label: string } | null {
  if (!period || period === 'all') return null;
  const today = dublinDay(now);
  const d = (offset: number) => dublinDay(new Date(now.getTime() + offset * 86_400_000));
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const [y, m] = today.split('-').map(Number);
  const firstOf = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const lastOf = (yy: number, mm: number) => dublinDay(new Date(Date.UTC(yy, mm, 0, 12)));
  switch (period) {
    case 'today': return { from: today, to: today, label: 'today' };
    case 'yesterday': return { from: d(-1), to: d(-1), label: 'yesterday' };
    case 'this_week': return { from: d(-dow), to: today, label: 'this week' };
    case 'last_week': return { from: d(-dow - 7), to: d(-dow - 1), label: 'last week' };
    case 'this_month': return { from: firstOf(y, m), to: today, label: 'this month' };
    case 'last_month': { const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y; return { from: firstOf(py, pm), to: lastOf(py, pm), label: 'last month' }; }
    default: return null;
  }
}

/** Every payment-type Activity row this elder can see (paged internally, bounded at 500). */
function allPaymentRows(hh: string, q: { status?: string | null; min?: number | null; max?: number | null; from?: string; to?: string }): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = listActivity(hh, 'elder', { type: 'payment', page, limit: 50, ...(q.status ? { status: q.status as any } : {}), ...(q.min != null ? { min: q.min } : {}), ...(q.max != null ? { max: q.max } : {}), ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) });
    out.push(...r.items);
    if (!r.hasMore) break;
  }
  return out;
}
const kindOf = (i: ActivityItem) => (i.source === 'sample' ? 'sample' : i.type === 'record' ? 'typed' : i.statusGroup === 'paid' ? 'captured' : i.statusGroup === 'pending' ? 'pending' : i.statusGroup === 'failed' || i.statusGroup === 'cancelled' ? 'not_paid' : i.statusGroup === 'refunded' ? 'refunded' : 'other');
const historyItem = (i: ActivityItem) => ({ id: i.id, type: i.type, title: i.title.slice(0, 300), amountCents: i.amountCents, currency: i.currency, status: i.status, at: i.at, webhookConfirmed: i.webhookConfirmed, ...(i.source === 'sample' ? { sample: true } : {}), sourceLabel: i.sourceLabel.slice(0, 60) });

function findContacts(hh: string, name: string | null, relation: string | null): ContactT[] {
  const qRel = relation?.toLowerCase().replace(/^(my|your)\s+/, '') ?? null;
  return cstore.listContacts(hh).filter((c) => {
    if (qRel && c.relation && (normName(c.relation) === normName(qRel) || normName(c.relation).includes(normName(qRel)))) return true;
    if (name) { const qt = tokens(name); const ct = tokens(c.name); return qt.length > 0 && qt.every((t) => ct.some((x) => tokenSimilarity(t, x) >= 0.85)); }
    return false;
  }).slice(0, 5);
}

/**
 * Evidence about paying a person, from Mary's OWN records only: is the payee a saved contact, has she paid them before,
 * how does the amount compare with what she usually pays. Every line says what it rests on. Never says "safe".
 */
export function paymentEvidence(hh: string, who: { name: string | null; relation: string | null }, amountCents: number | null) {
  const contacts = findContacts(hh, who.name, who.relation);
  const contact = contacts[0] ?? null;
  const payeeName = contact?.name ?? who.name;
  const cands = cstore.paymentCandidates(hh);
  const toPayee = payeeName ? searchPayments(cands.filter((c) => c.source === 'manual'), { q: payeeName }).matches.filter((m) => m.score >= 0.6) : [];
  const realToPayee = toPayee.filter((m) => !m.sample);
  const sampleToPayee = toPayee.filter((m) => m.sample);
  const own = cands.filter((c) => !c.sample);
  const amounts = own.map((c) => c.amountCents).sort((a, b) => a - b);
  const median = amounts.length ? amounts[Math.floor(amounts.length / 2)] : null;
  const max = amounts.length ? amounts[amounts.length - 1] : null;
  const policy = getPolicy(hh);
  const signals: { label: string; detail?: string | null; tone: 'ok' | 'warn' | 'info' | 'muted' }[] = [];
  const whoLabel = payeeName ?? (who.relation ? `your ${who.relation}` : 'this person');
  if (contact) signals.push({ label: `${contact.name} is in your trusted contacts${contact.relation ? ` (your ${contact.relation})` : ''}`, detail: `Saved by you${contact.sample ? ' (sample data)' : ''}, not verified. If a message claims to be from them, call the number you saved.`, tone: 'ok' });
  else signals.push({ label: `${whoLabel} is not in your trusted contacts`, detail: 'SaySafe can’t tell who this really is.', tone: 'warn' });
  if (realToPayee.length) {
    const last = [...realToPayee].sort((a, b) => b.date.localeCompare(a.date))[0];
    signals.push({ label: `You have ${plural(realToPayee.length, 'record')} of paying ${last.recipient}`, detail: `Last: ${eur(last.amountCents, last.currency)} on ${dayIE(`${last.date}T12:00:00Z`)}. You typed these yourself, so they aren’t proof the money arrived.`, tone: 'info' });
  } else if (payeeName || who.relation) {
    signals.push({ label: `No previous payments to ${whoLabel} in your records`, detail: sampleToPayee.length ? `Only sample (illustrative) records mention ${whoLabel}, and they don’t count.` : 'This would be the first time, as far as SaySafe can see. SaySafe only sees records you typed and Demo Shop purchases made here, not your bank.', tone: 'warn' });
  }
  if (amountCents) {
    if (!amounts.length) signals.push({ label: 'No payment history to compare the amount with', detail: 'You have no payments of your own in SaySafe yet (sample data doesn’t count).', tone: 'muted' });
    else if (max !== null && median !== null && (amountCents > max * 1.5 || amountCents > median * 3)) signals.push({ label: `${eur(amountCents)} is unusually high for you`, detail: `Your own payments in SaySafe are usually around ${eur(median)} and the largest is ${eur(max)} (${plural(amounts.length, 'payment')}).`, tone: 'warn' });
    else signals.push({ label: `${eur(amountCents)} is within what you usually pay`, detail: `Your own payments in SaySafe are usually around ${eur(median!)}; the largest is ${eur(max!)}.`, tone: 'info' });
    if (amountCents > policy.thresholdCents) signals.push({ label: `Above your ${eur(policy.thresholdCents)} family approval limit`, detail: 'That limit applies to Demo Shop purchases. A Demo Shop purchase this size would wait for your family member’s OK. SaySafe doesn’t send money to people.', tone: 'info' });
  }
  return { contact, contacts, signals, payeeName, hasHistory: realToPayee.length > 0, ownCount: amounts.length };
}

export async function runTool(tool: AssistantTool, p: ToolParamsT, s: Session | null, opts: { familySession?: boolean; now?: Date; said?: string } = {}): Promise<ToolAnswer> {
  const now = opts.now ?? new Date();
  if (tool === 'capabilities') {
    const reply = 'I can find real products in Irish shops with Channel3 and compare them, show your payments and receipts, explain your approval limit, check a suspicious message or payment against your own records, help with subscriptions, and remember shopping preferences you tell me. I never send or approve money myself.';
    return { reply, card: s ? { kind: 'demo_welcome', prompts: [...WELCOME_PROMPTS] } : null };
  }
  if (tool === 'account_balance') {
    const reply = "I can't see your bank or PayPal balance: SaySafe never connects to your bank or PayPal account. To check it, open the PayPal app or your bank's own app. I can show the payments you made in SaySafe. Just ask “show my transactions”.";
    return { reply, card: null };
  }
  if (!s) return opts.familySession ? { reply: PRIVATE_TO_ELDER, card: { kind: 'companion_sign_in', message: PRIVATE_TO_ELDER }, read: { privateRefused: true } } : { reply: SIGN_IN, card: { kind: 'companion_sign_in', message: SIGN_IN } };
  const hh = s.householdId, uid = s.userId;

  if (tool === 'preferences' || tool === 'memory_recall') {
    const on = mem.isEnabled(hh, uid);
    const items = on ? mem.listMemory(hh, uid).filter((m) => m.status === 'confirmed') : [];
    const prof = getProfile(uid);
    const profLines: string[] = [];
    if (prof.colours.length) profLines.push(`colours ${list(prof.colours)}`);
    if (prof.brands.length) profLines.push(`brands you like: ${list(prof.brands)}`);
    if (prof.avoid.length) profLines.push(`things to avoid: ${list(prof.avoid)}`);
    if (prof.styles.length) profLines.push(`styles: ${list(prof.styles)}`);
    if (prof.categories.length) profLines.push(`you shop for ${list(prof.categories)}`);
    if (prof.budgetMax !== null) profLines.push(`budget up to €${prof.budgetMax}`);
    const memLabels = items.map((m) => m.label);
    const link = { label: 'Change or remove in Profile', to: '/profile' };
    const short = mem.wantsShortReplies(hh, uid);
    if (p.aspect === 'why') {
      const last = mem.recentProducts(hh, uid).find((x) => x.origin === 'channel3');
      const colour = items.find((m) => m.category === 'shopping' && m.key === 'colour');
      const budget = items.find((m) => m.category === 'budget');
      const used = [colour ? `you saved “${colour.label}”` : null, budget ? `“${budget.label}”` : null, prof.colours.length ? `your Profile colours (${list(prof.colours)})` : null].filter(Boolean) as string[];
      const reply = !last ? 'I haven’t shown you any real-shop products recently, so no preference has been applied.'
        : used.length ? `For “${last.query ?? shortTitle(last.title)}” I used ${list(used)}. A colour or budget you say in the request always wins over saved ones. Say “ignore my preferences” to see results without them.`
          : `For “${last.query ?? shortTitle(last.title)}” I didn’t use any saved preference: the order comes from how well each listing matches your words and its price.`;
      return { reply, card: facts('Why these results', [...items.map((m) => ({ label: m.label, detail: m.sample ? 'Sample preference: change or remove it in Profile.' : `Saved from ${m.source === 'profile' ? 'Profile' : 'what you said'}.`, tone: 'info' as const })), ...profLines.map((l) => ({ label: `Profile: ${l}`, tone: 'info' as const }))], link), read: { memoryItems: items.length, memoryOn: on } };
    }
    if (p.aspect === 'colour' || p.aspect === 'brand' || p.aspect === 'budget') {
      const pick = items.filter((m) => (p.aspect === 'colour' ? m.category === 'shopping' && m.key === 'colour' : p.aspect === 'brand' ? m.category === 'brand_like' || m.category === 'brand_avoid' : m.category === 'budget'));
      const fromProfile = p.aspect === 'colour' ? prof.colours : p.aspect === 'brand' ? [...prof.brands, ...prof.avoid.map((a) => `not ${a}`)] : prof.budgetMax !== null ? [`up to €${prof.budgetMax}`] : [];
      const parts = [...pick.map((m) => m.label), ...fromProfile.map((x) => `Profile: ${x}`)];
      const reply = !on && !fromProfile.length ? `Memory is off, and your Profile has no ${p.aspect} saved, so I don’t know.`
        : parts.length ? `${list(parts)}.${pick.some((m) => m.sample) ? ' (Sample preferences: you can change them in Profile.)' : ''}`
          : `You haven’t told me a ${p.aspect === 'brand' ? 'brand you like or avoid' : p.aspect} yet${on ? '' : ', and memory is off'}. You can say, for example, “I prefer ${p.aspect === 'colour' ? 'red' : p.aspect === 'brand' ? 'Philips' : 'to keep it under €100'}”.`;
      return { reply, card: null, read: { memoryItems: pick.length, profileValues: fromProfile.length, memoryOn: on } };
    }
    if (tool === 'memory_recall') {
      const turns = mem.recentTurns(hh, uid).length;
      const prods = mem.recentProducts(hh, uid).length;
      const reply = !on
        ? `Long-term memory is off, so I haven’t saved any preferences.${profLines.length ? ` Your Profile has: ${list(profLines)}.` : ''} I keep our recent conversation for up to ${mem.CONTEXT_DAYS} days so “that one” works.`
        : memLabels.length
          ? `I remember: ${list(memLabels)}.${profLines.length ? ` Your Profile also has ${list(profLines)}.` : ''} I also keep our recent conversation (${plural(turns, 'message')}, ${plural(prods, 'product')} shown) for ${mem.CONTEXT_DAYS} days. I never remember health, money you owe, other people or contact details, and a remembered chat is never proof of payment.`
          : `I haven’t saved anything about you yet.${profLines.length ? ` Your Profile has ${list(profLines)}.` : ''} Tell me things like “I prefer red” and I’ll remember them.`;
      return { reply: short ? reply.split(/(?<=\.)\s/).slice(0, 2).join(' ') : reply, card: facts('What SaySafe remembers', [...items.map((m) => ({ label: m.label, detail: m.sample ? 'Sample, not something you said' : null, tone: 'info' as const })), ...profLines.map((l) => ({ label: `Profile: ${l}`, tone: 'info' as const })), { label: `Recent conversation kept for ${mem.CONTEXT_DAYS} days`, detail: `${plural(turns, 'message')}, ${plural(prods, 'product')} shown. Clear it in Profile.`, tone: 'muted' as const }], link), read: { memoryItems: items.length, memoryOn: on, profileValues: profLines.length, turns, products: prods } };
    }
    // All preferences.
    const reply = !on && !profLines.length
      ? 'Memory is off and your Profile has no shopping preferences, so I don’t have any saved. You can turn memory on in Profile, or tell me what you like.'
      : !memLabels.length && !profLines.length
        ? 'You haven’t saved any shopping preferences yet. Tell me something like “I prefer red” or “keep it under €100”, or add them in Profile.'
        : `${memLabels.length ? `From what you told me: ${list(memLabels)}.` : on ? '' : 'Memory is off, so nothing from chat is saved.'}${profLines.length ? ` In your Profile: ${list(profLines)}.` : ''}${items.some((m) => m.sample) ? ' Items marked sample are demo examples, not things you said.' : ''} I use these to sort shop results; what you ask for in the moment always wins.`.trim();
    return { reply, card: facts('Your preferences', [...items.map((m) => ({ label: m.label, detail: m.sample ? 'Sample preference' : `From ${m.source === 'profile' ? 'Profile' : 'chat'}`, tone: 'info' as const })), ...profLines.map((l) => ({ label: `Profile: ${l}`, tone: 'info' as const }))].length ? [...items.map((m) => ({ label: m.label, detail: m.sample ? 'Sample preference' : `From ${m.source === 'profile' ? 'Profile' : 'chat'}`, tone: 'info' as const })), ...profLines.map((l) => ({ label: `Profile: ${l}`, tone: 'info' as const }))] : [{ label: 'Nothing saved yet', tone: 'muted' as const }], link, on ? null : 'Long-term memory is off.'), read: { memoryItems: items.length, memoryOn: on, profileValues: profLines.length } };
  }

  if (tool === 'conversation_recall') {
    const turns = mem.recentTurns(hh, uid);
    const prods = mem.recentProducts(hh, uid);
    const today = dublinDay(now); const yday = dublinDay(new Date(now.getTime() - 86_400_000));
    const want = p.when === 'yesterday' ? yday : p.when === 'today' ? today : null;
    const tSel = turns.filter((t) => t.speaker === 'user' && (!want || dublinDay(new Date(t.at)) === want));
    const pSel = prods.filter((x) => !want || dublinDay(new Date(x.shownAt)) === want);
    const when = p.when === 'yesterday' ? 'yesterday' : p.when === 'today' ? 'today' : 'recently';
    if (!tSel.length && !pSel.length) {
      const reply = turns.length || prods.length ? `I don’t have anything from ${when === 'recently' ? 'our recent conversation' : when}. I keep only the last ${mem.MAX_TURNS} messages and products shown in the last ${mem.CONTEXT_DAYS} days.` : `I don’t have any earlier conversation saved. I keep up to ${mem.CONTEXT_DAYS} days of recent chat, and it may have been cleared.`;
      return { reply, read: { turns: 0, products: 0 } };
    }
    const asked = tSel.slice(-4).map((t) => `“${t.text.slice(0, 80)}”`);
    const searches = [...new Set(pSel.map((x) => x.query).filter(Boolean) as string[])].slice(0, 3);
    const reply = `${when === 'recently' ? 'Recently' : when[0].toUpperCase() + when.slice(1)} ${asked.length ? `you asked ${list(asked)}` : ''}${asked.length && searches.length ? ', and ' : ''}${searches.length ? `we looked at ${list(searches.map((q) => `${q} listings`))}` : ''}. This is what we talked about, not proof of any payment.`.replace(/\s+/g, ' ');
    const items = pSel.slice(0, 5).map((x) => x.item);
    const src = pSel.slice(0, 5).every((x) => x.origin === 'demo') ? 'demo' : 'channel3';
    return { reply, card: items.length ? { kind: 'product_cards', source: src, query: (searches[0] ?? 'Earlier products').slice(0, 200), items, fetchedAt: null, note: 'Shown again from your recent conversation. Prices may have changed.' } : null, read: { turns: tSel.length, products: pSel.length } };
  }

  if (tool === 'spending_limit' || tool === 'transfer_check') {
    const policy = getPolicy(hh);
    const lim = eur(policy.thresholdCents, policy.currency);
    const budget = mem.isEnabled(hh, uid) ? mem.listMemory(hh, uid).find((m) => m.category === 'budget' && m.status === 'confirmed') : null;
    const profBudget = getProfile(uid).budgetMax;
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE household_id=? AND state='FAMILY_APPROVAL_PENDING' AND example=0").get(hh) as any)?.n ?? 0;
    const limitLine = `Your family approval limit is ${lim} per purchase: a Demo Shop purchase above ${lim} waits for your family member’s OK, and at or under it you approve it at PayPal yourself.`;
    const noRemaining = 'It’s a per-purchase limit, not a weekly or monthly allowance, so there is no amount “left” to count down.';
    const budgetLine = budget ? ` Separately, your saved shopping budget is “${budget.label}”${budget.sample ? ' (sample)' : ''}: that only sorts search results and never blocks anything.` : profBudget !== null ? ` Separately, your Profile shopping budget is up to €${profBudget}: that only sorts search results.` : '';
    const items = [
      { label: `Family approval limit: ${lim} per purchase`, detail: 'Set for your household. Applies to SaySafe Demo Shop purchases (PayPal Sandbox).', tone: 'info' as const },
      { label: 'No spending period or remaining amount', detail: 'SaySafe has no weekly or monthly allowance to count down.', tone: 'muted' as const },
      ...(pending ? [{ label: `${plural(pending, 'purchase')} waiting for your family member`, tone: 'warn' as const }] : []),
      ...(budget ? [{ label: `Shopping budget (memory): ${budget.label}`, detail: 'Only sorts search results.', tone: 'muted' as const }] : []),
    ];
    if (tool === 'spending_limit') return { reply: `${limitLine} ${noRemaining}${budgetLine}`, card: facts('Your limits', items, null), read: { thresholdCents: policy.thresholdCents, pending } };
    // "Can I transfer money to my grandson / anyone?"
    const ev = (p.person || p.relation) ? paymentEvidence(hh, { name: p.person ?? null, relation: p.relation ?? null }, p.amount ? Math.round(p.amount * 100) : null) : null;
    const who = ev?.contact ? `${ev.contact.name}${ev.contact.relation ? `, your ${ev.contact.relation}` : ''}` : p.person ?? (p.relation ? `your ${p.relation}` : null);
    const handoff = `SaySafe never sends money to a person: you’d send it yourself on PayPal’s own Send money page, signed in to PayPal. The ${lim} family approval limit covers Demo Shop purchases, not transfers, and there’s no allowance or remaining amount for transfers in SaySafe.`;
    const evLine = ev ? ` What your records show${who ? ` about ${who}` : ''}: ${list(ev.signals.slice(0, 3).map((x) => x.label.replace(/^(No|Your|Above|Only)\b/, (c) => c.toLowerCase())))}.` : '';
    const reply = `Yes, you can, but not through SaySafe. ${handoff}${evLine}${ev && !ev.contact && (p.person || p.relation) ? ' Before sending, check it really is them, using a number you already have.' : ''}`;
    const card = { kind: 'send_money', query: (p.person ?? p.relation ?? null)?.slice(0, 60) ?? null, contacts: ev?.contacts ?? [], amountCents: p.amount ? Math.round(p.amount * 100) : null, currency: 'EUR', paypalSendUrl: PAYPAL_SEND_MONEY_URL, notice: SEND_MONEY_NOTICE };
    const factsCard = facts(ev ? 'What your records show' : 'Sending money', ev ? [...ev.signals, items[0], items[1]] : [{ label: 'SaySafe never sends money', detail: 'You send it yourself on PayPal’s own page, signed in to PayPal.', tone: 'info' as const }, items[0], items[1]], { label: 'Open PayPal’s Send money page', href: PAYPAL_SEND_MONEY_URL });
    return ev?.contacts.length ? { reply, card, blocks: [factsCard], read: { thresholdCents: policy.thresholdCents, contactFound: true, history: Boolean(ev?.hasHistory) } }
      : { reply, card: factsCard, read: { thresholdCents: policy.thresholdCents, contactFound: false, history: Boolean(ev?.hasHistory) } };
  }

  if (tool === 'payment_check') {
    if (!p.person && !p.relation) {
      return { reply: 'Who would the payment be to, and roughly how much? For example: “Is it safe to pay Pat €300?”. I’ll check it against your contacts and your own payment history.', read: { asked: true } };
    }
    const ev = paymentEvidence(hh, { name: p.person ?? null, relation: p.relation ?? null }, p.amount ? Math.round(p.amount * 100) : null);
    const warn = ev.signals.filter((x) => x.tone === 'warn');
    const who = ev.contact?.name ?? p.person ?? `your ${p.relation}`;
    const reply = `Here’s what your own records show about paying ${who}${p.amount ? ` ${eur(Math.round(p.amount * 100))}` : ''}: ${list(ev.signals.map((x) => x.label.replace(/^(No|Your|Above|Only)\b/, (c) => c.toLowerCase())))}. ${warn.length ? `${plural(warn.length, 'thing')} to check before paying. ` : ''}I can’t confirm who is asking: check with them on a number you already have, not one from a message. SaySafe never sends the money.`;
    return { reply, card: facts(`Paying ${who}`.slice(0, 80), ev.signals, null, 'From your own SaySafe records only. Sample data is not counted. SaySafe can’t see your bank.'), read: { signals: ev.signals.length, warnings: warn.length, contactFound: Boolean(ev.contact), history: ev.hasHistory, ownPayments: ev.ownCount } };
  }

  if (tool === 'trust_contact') {
    const name = (p.person ?? '').trim();
    const existing = findContacts(hh, name, null);
    if (existing.length) {
      const c = existing[0];
      return { reply: `${c.name} is already in your trusted contacts${c.relation ? ` as your ${c.relation}` : ''}. I haven’t changed anything.`, card: { kind: 'contact_card', contacts: existing, query: name, advice: 'Saved by you — not verified. If a message claims to be from them, call the number you saved, not one from the message.' }, read: { exists: true } };
    }
    return { reply: `${name} isn’t in your trusted contacts. Would you like to add them? Nothing is saved until you tap “Add ${name}”. You can add a phone number later in Profile.`, card: { kind: 'contact_suggest', name: name.slice(0, 60), relation: p.relation?.slice(0, 40) ?? null, state: 'ask' }, read: { exists: false } };
  }

  if (tool === 'duplicate_check') {
    const range = periodRange(p.period ?? null, now);
    const rows = db.prepare(`SELECT id, state, items_json, amount_cents, currency, paypal_order_id, paypal_capture_id, created_at, example FROM payment_requests WHERE household_id=? AND state IN ('CAPTURED','REFUND_PENDING','REFUNDED') ORDER BY created_at ASC LIMIT 500`).all(hh) as any[];
    const inRange = rows.filter((r) => !range || (String(r.created_at).slice(0, 10) >= range.from && String(r.created_at).slice(0, 10) <= range.to));
    const real = inRange.filter((r) => Number(r.example) !== 1 && r.paypal_capture_id);
    const sample = inRange.filter((r) => Number(r.example) === 1);
    const pairs: { a: any; b: any; hours: number }[] = [];
    for (let i = 0; i < real.length; i++) for (let j = i + 1; j < real.length; j++) {
      const a = real[i], b = real[j];
      const hours = Math.abs(Date.parse(`${String(b.created_at).replace(' ', 'T')}Z`) - Date.parse(`${String(a.created_at).replace(' ', 'T')}Z`)) / 3_600_000;
      if (a.amount_cents === b.amount_cents && a.items_json === b.items_json && hours <= 24) pairs.push({ a, b, hours: Math.round(hours) });
    }
    const captureIds = new Set(real.map((r) => r.paypal_capture_id));
    const summary = buildSummary({ role: 'elder', householdId: hh }, now);
    const recDups = (summary.duplicates ?? []).filter((d: any) => !d.sample);
    const itemName = (r: any) => { try { return (JSON.parse(r.items_json) as { name: string }[]).map((x) => x.name).join(', '); } catch { return 'Purchase'; } };
    const lines: { label: string; detail?: string | null; tone: 'ok' | 'warn' | 'info' | 'muted' }[] = [];
    if (!real.length) lines.push({ label: `No captured PayPal Sandbox payments${range ? ` ${range.label}` : ''}`, detail: 'Nothing SaySafe took payment for, so nothing could have been charged twice here.', tone: 'muted' });
    else lines.push({ label: `${plural(real.length, 'captured PayPal Sandbox payment')} checked`, detail: `${captureIds.size === real.length ? 'Each has its own PayPal capture ID.' : 'Two share a capture ID: that is one payment recorded twice, not two charges.'} SaySafe captures each purchase once, and a retry reuses the same PayPal request ID.`, tone: pairs.length ? 'warn' : 'ok' });
    for (const x of pairs.slice(0, 3)) lines.push({ label: `Two ${eur(x.a.amount_cents, x.a.currency)} payments for ${itemName(x.a)} within ${x.hours} hours`, detail: `Capture IDs ${String(x.a.paypal_capture_id).slice(-6)} and ${String(x.b.paypal_capture_id).slice(-6)} (last 6 characters). Two separate purchases, or a repeat: open each receipt to check.`, tone: 'warn' });
    for (const d of recDups.slice(0, 2)) lines.push({ label: `Your records: ${eur(d.amountCents, d.currency)} to ${d.recipient} twice, ${d.daysApart} days apart`, detail: 'Typed by you, not verified. Ask them before paying again.', tone: 'warn' });
    if (sample.length) lines.push({ label: `${plural(sample.length, 'sample purchase')} not counted`, detail: 'Illustrative, no PayPal record.', tone: 'muted' });
    const reply = !real.length
      ? `No. You have no captured PayPal Sandbox payments${range ? ` ${range.label}` : ''}, so SaySafe hasn’t charged you at all, let alone twice.${recDups.length ? ` In the records you typed, ${recDups[0].recipient} appears twice with ${eur(recDups[0].amountCents, recDups[0].currency)}: worth asking them.` : ''} I can’t see your bank or PayPal wallet.`
      : pairs.length
        ? `Possibly. I found ${plural(pairs.length, 'pair')} of captured payments with the same item and amount within a day: ${eur(pairs[0].a.amount_cents, pairs[0].a.currency)} for ${itemName(pairs[0].a)}. Each has its own PayPal capture ID, so they are two separate captures. Open the receipts to check whether you meant to buy it twice.`
        : `No sign of a double charge. I checked ${plural(real.length, 'captured PayPal Sandbox payment')}: each has its own PayPal capture ID and no two are for the same item and amount within a day.${recDups.length ? ` In the records you typed, ${recDups[0].recipient} appears twice with ${eur(recDups[0].amountCents, recDups[0].currency)}.` : ''} I can’t see your bank or PayPal wallet.`;
    return { reply, card: facts('Charged twice?', lines, { label: 'See all in Activity', to: '/activity' }), read: { captured: real.length, pairs: pairs.length, sample: sample.length, recordRepeats: recDups.length } };
  }

  // ----- transactions -----
  if (p.mode === 'latest_receipt') return { reply: 'Here is your latest receipt.', clientAction: 'latest_receipt', read: {} };
  const range = periodRange(p.period ?? null, now);
  const rows = allPaymentRows(hh, { status: p.status ?? null, min: p.min ?? null, max: p.max ?? null, from: range?.from, to: range?.to });
  const by = (k: string) => rows.filter((r) => kindOf(r) === k);
  const captured = by('captured'), pending = by('pending'), notPaid = by('not_paid'), typed = by('typed'), sample = by('sample'), refunded = by('refunded');
  const sum = (xs: ActivityItem[]) => xs.reduce((a, r) => a + (r.amountCents ?? 0), 0);
  const filt = [range ? range.label : null, p.min != null ? `above ${eur(Math.round(p.min * 100))}` : null, p.max != null ? `below ${eur(Math.round(p.max * 100))}` : null, p.status ? p.status : null].filter(Boolean).join(', ');
  const kinds = [
    captured.length ? `${plural(captured.length, 'real PayPal Sandbox purchase')} paid (${eur(sum(captured))})` : null,
    refunded.length ? `${plural(refunded.length, 'refunded or refund-pending purchase')}` : null,
    pending.length ? `${plural(pending.length, 'purchase')} not finished yet` : null,
    notPaid.length ? `${plural(notPaid.length, 'attempt')} cancelled, declined or failed (nothing paid)` : null,
    typed.length ? `${plural(typed.length, 'payment')} you recorded yourself (${eur(sum(typed))}, not verified)` : null,
    sample.length ? (() => {
      const shop = sample.filter((r) => r.type === 'payment'); const recs = sample.filter((r) => r.type === 'record');
      const st = (g: string) => shop.filter((r) => r.statusGroup === g).length;
      const shopTxt = shop.length ? `${plural(shop.length, 'sample Demo Shop purchase')} (${[st('paid') ? `${st('paid')} paid` : null, st('pending') ? `${st('pending')} waiting` : null, st('failed') + st('cancelled') ? `${st('failed') + st('cancelled')} not paid` : null, st('refunded') ? `${st('refunded')} refunded` : null].filter(Boolean).join(', ')})` : null;
      const recTxt = recs.length ? `${plural(recs.length, 'sample payment record')}` : null;
      return `${[shopTxt, recTxt].filter(Boolean).join(' and ')}, all illustrative, not real`;
    })() : null,
  ].filter(Boolean) as string[];
  const read = { total: rows.length, captured: captured.length, pending: pending.length, notPaid: notPaid.length, typed: typed.length, sample: sample.length, refunded: refunded.length };
  if (p.mode === 'total') {
    const reply = !rows.length ? `I have no payments${range ? ` ${range.label}` : ''}.`
      : `${range ? `${range.label[0].toUpperCase()}${range.label.slice(1)}` : 'In total'}: ${captured.length ? `${eur(sum(captured))} paid in ${plural(captured.length, 'real PayPal Sandbox purchase')} (no real money)` : 'no PayPal Sandbox purchases finished'}${typed.length ? `; ${eur(sum(typed))} in ${plural(typed.length, 'payment')} you recorded yourself (not verified)` : ''}${sample.length ? `; sample data ${eur(sum(sample))} (illustrative)` : ''}. I keep these apart and don’t add them together. SaySafe can’t see your bank or PayPal wallet.`;
    return { reply, card: { kind: 'payment_history', items: rows.slice(0, 10).map(historyItem), total: rows.length }, read };
  }
  const reply = !rows.length
    ? `I found no payments${filt ? ` (${filt})` : ''}. SaySafe only knows Demo Shop purchases made here and payments you recorded yourself, not your bank or PayPal wallet.`
    : `I found ${plural(rows.length, 'payment record')}${filt ? ` (${filt})` : ''}: ${list(kinds)}.${rows.length > 10 ? ' Here are the newest 10; “See all in Activity” shows every one.' : ''} SaySafe can’t see your bank or wider PayPal history.`;
  return { reply, card: { kind: 'payment_history', items: rows.slice(0, 10).map(historyItem), total: rows.length }, read };
}
