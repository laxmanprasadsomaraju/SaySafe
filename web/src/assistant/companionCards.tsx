/**
 * Payment companion cards (elder-only): payment matches + records, subscriptions, the SaySafe Demo Membership
 * (PayPal sandbox), and trusted contacts. Every card renders plain text from validated data, re-reads the server
 * when it is shown (so a reload shows the current state), and renders NOTHING in the family view.
 *
 * Hard rules carried by these cards:
 *  - A record Mary typed is never proof: "Recorded by you — not verified". The guidance says don't pay again.
 *  - External subscriptions are never "cancelled" by SaySafe: only "You told SaySafe this is cancelled — not
 *    confirmed by the provider".
 *  - The Demo Membership is cancelled only by a TAP on "Cancel billing via PayPal" (a spoken "yes" never sends the
 *    token), and shown as cancelled only when the server answers provider_confirmed.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { InsightsSummary as InsightsSummarySchema, fmtMoneyList, type InsightsSummaryT } from '../../../shared/insightsSummary';
import { CheckCircle2, AlertTriangle, Pencil, Trash2, Plus, ExternalLink, Phone, Mail, UserRound, Repeat, Wallet, Search, ShieldCheck, Loader2, RotateCcw, CircleSlash, Info, BarChart3 } from 'lucide-react';
import { api } from '../lib/api';
import { goToPayPal } from '../lib/handoff';
import { type Tone } from '../lib/activity';
import {
  PaymentSearchResult, Subscription, Contact, SubscriptionSummary, ManualPayment, DEMO_MEMBERSHIP, PAY_METHODS, FREQUENCIES,
  type PaymentMatchT, type SubscriptionT, type ContactT, type ManualPaymentT, type SubscriptionSummaryT,
} from '../../../shared/companion';
import {
  UI_LABEL, METHOD_LABEL, ServerPaymentsList, ServerSubsList, ServerContactsList, ServerDemoStatus, ServerDemoStart, ServerCancelIntent,
  ServerCancelResult, ServerCancelHelp, helpFromCancelHelp, cancelCardFrom, cancelPhase, searchQueryString, parseAmount, money, day, todayIso,
  telHref, mailHref, FREQ_LABEL, nextChargeText, isDemo, sourceText, managedText, EXTERNAL_DISCLAIMER, matchesCardText, MATCHES_SCOPE_NOTE,
} from './companion';
import { parseServer, type BlockOf, type Block } from './schemas';
import type { BlockActions } from './blocks';
import { card, btnPrimary, btnSecondary, btnDanger, linkBtn as linkCls, input as inputCls, pill } from '../components/ds';

// Shared design-system recipes (components/ds.ts): same targets, radius and spacing as every other page.
const cardCls = card;
const errMsg = (e: unknown) => String((e as Error)?.message ?? 'Something went wrong. Nothing was changed.').slice(0, 300);

function Pill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={pill(tone)}>{label}</span>;
}
function Head({ icon: Icon, children, right }: { icon: typeof Wallet; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-bold uppercase tracking-wider text-ink-soft flex items-center gap-2"><Icon className="size-5 shrink-0" aria-hidden />{children}</p>
      {right}
    </div>
  );
}
const PrivateNote = () => <p className="mt-3 text-sm text-ink-soft flex items-start gap-1.5"><ShieldCheck className="size-4 mt-0.5 shrink-0 text-teal" aria-hidden />Private to you. Your family can’t see this.</p>;
const Err = ({ e }: { e: string | null }) => (e ? <p role="alert" className="mt-2 text-danger font-bold break-words">{e}</p> : null);
const Done = ({ m }: { m: string | null }) => (m ? <p role="status" className="mt-2 font-bold break-words">{m}</p> : null);
const elderOnly = (act: BlockActions) => act.audience !== 'family';

/** Asks once more before deleting. Two taps, the second on a clearly named button. */
function ConfirmDelete({ what, onYes, busy }: { what: string; onYes: () => void; busy?: boolean }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button type="button" onClick={() => setAsk(true)} className={btnDanger}><Trash2 className="size-5" aria-hidden />Delete<span className="sr-only"> {what}</span></button>;
  return (
    <span className="flex flex-wrap items-center gap-2" role="group" aria-label={`Delete ${what}?`}>
      <span className="font-bold">Delete {what}?</span>
      <button type="button" onClick={onYes} disabled={busy} className={btnDanger}>{busy ? 'Deleting…' : 'Yes, delete'}</button>
      <button type="button" onClick={() => setAsk(false)} className={btnSecondary}>No</button>
    </span>
  );
}

// =====================================================================================================
// Payments
// =====================================================================================================
/** The one label every sample ("Try as Mary") row carries, everywhere it is shown. */
export function SampleBadge({ evidence = false }: { evidence?: boolean }) {
  return <span className="inline-flex items-center rounded-xl border border-amber/40 bg-amber-soft px-2.5 py-0.5 text-sm font-bold text-amber" data-testid="sample-badge">Sample data{evidence ? ' · Illustrative — no PayPal record' : ''}</span>;
}
function SourceBadge({ source, sample }: { source: PaymentMatchT['source']; sample?: boolean }) {
  if (sample) return <SampleBadge />;
  return source === 'paypal_sandbox' ? <Pill label={UI_LABEL.sandbox} tone="ok" /> : <Pill label={UI_LABEL.manual} tone="pending" />;
}

type PayDraft = { recipient: string; amount: string; paidOn: string; method: (typeof PAY_METHODS)[number]; note: string };
/** Add / edit one payment record. Everything she types is saved as "Recorded by you — not verified". */
export function PaymentForm({ initial, onSaved, onCancel }: { initial?: ManualPaymentT; onSaved: (p: ManualPaymentT) => void; onCancel: () => void }) {
  const id = useId();
  const [d, setD] = useState<PayDraft>(() => initial
    ? { recipient: initial.recipient, amount: (initial.amountCents / 100).toFixed(2), paidOn: initial.paidOn, method: initial.method, note: initial.note ?? '' }
    : { recipient: '', amount: '', paidOn: todayIso(), method: 'bank_transfer', note: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof PayDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value } as PayDraft);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountCents = parseAmount(d.amount);
    if (!d.recipient.trim()) return setErr('Please say who you paid.');
    if (!amountCents) return setErr('Please enter the amount, for example 80 or 80.50.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.paidOn)) return setErr('Please enter the date you paid.');
    setBusy(true); setErr(null);
    try {
      const body = { recipient: d.recipient.trim(), amountCents, currency: 'EUR', paidOn: d.paidOn, method: d.method, note: d.note.trim() || null };
      const raw = initial ? await api(`/api/companion/payments/${initial.id}`, { method: 'PATCH', body }) : await api('/api/companion/payments', { body });
      onSaved(parseServer(ManualPayment, raw));
    } catch (er) { setErr(errMsg(er)); setBusy(false); }
  };
  return (
    <form onSubmit={save} className="mt-3 rounded-2xl border-2 border-teal/40 bg-ivory p-3 sm:p-4 grid gap-3" aria-label={initial ? 'Edit payment record' : 'Add a payment record'}>
      <p className="font-bold">{initial ? 'Edit this record' : 'Add a record of a payment you made'}</p>
      <div><label htmlFor={`${id}-r`} className="block font-bold">Who you paid</label><input id={`${id}-r`} className={inputCls} value={d.recipient} onChange={set('recipient')} maxLength={80} autoComplete="off" placeholder="e.g. John Smith" /></div>
      <div className="grid gap-3 min-[420px]:grid-cols-2">
        <div><label htmlFor={`${id}-a`} className="block font-bold">Amount (€)</label><input id={`${id}-a`} className={inputCls} value={d.amount} onChange={set('amount')} inputMode="decimal" maxLength={12} placeholder="80.00" /></div>
        <div><label htmlFor={`${id}-d`} className="block font-bold">Date</label><input id={`${id}-d`} type="date" className={inputCls} value={d.paidOn} onChange={set('paidOn')} max="2100-12-31" /></div>
      </div>
      <div><label htmlFor={`${id}-m`} className="block font-bold">How you paid</label>
        <select id={`${id}-m`} className={inputCls} value={d.method} onChange={set('method')}>{PAY_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></div>
      <div><label htmlFor={`${id}-n`} className="block font-bold">Note <span className="font-normal text-ink-soft">(optional)</span></label><input id={`${id}-n`} className={inputCls} value={d.note} onChange={set('note')} maxLength={200} placeholder="e.g. for the garden work" /></div>
      <p className="text-sm text-ink-soft">Saved as “{UI_LABEL.manual}”. SaySafe can’t see your bank, so this is only what you typed.</p>
      <Err e={err} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Save record'}</button>
        <button type="button" onClick={onCancel} className={btnSecondary}>Cancel</button>
      </div>
    </form>
  );
}

function MatchRow({ m, onEdit, onDelete, busy }: { m: PaymentMatchT; onEdit?: () => void; onDelete?: () => void; busy?: boolean }) {
  const ev = m.evidence;
  return (
    <li className="py-3" data-source={m.source}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-bold text-lg break-words min-w-0">{m.recipient}</span>
        <span className="font-display text-xl font-semibold">{money(m.amountCents, m.currency)}</span>
      </div>
      <p className="text-base text-ink-soft">{day(m.date)}{m.description ? ` · ${m.description}` : ''}</p>
      <p className="mt-1 flex flex-wrap gap-2"><SourceBadge source={m.source} sample={m.sample} /></p>
      <p className="mt-1 text-base break-words">
        <span className="text-ink-soft">Evidence: </span>
        {ev.kind === 'paypal_sandbox'
          ? `PayPal capture ${ev.captureStatus ?? 'not recorded'}${ev.webhookVerified ? ' · signed PayPal notice verified' : ' · signed notice not verified yet'} · SaySafe Demo Shop purchase`
          : ev.kind === 'sample'
            ? `${UI_LABEL.sampleEvidence}${ev.basis === 'shop' ? ` · sample Demo Shop purchase${ev.orderState ? ` (${ev.orderState.replace(/_/g, ' ').toLowerCase()})` : ''}` : ev.method ? ` · ${METHOD_LABEL[ev.method]} (illustrated)` : ''}`
            : `${METHOD_LABEL[ev.method]} — only what you typed`}
      </p>
      {m.matchReasons.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-base" aria-label="Why this matches">
          {m.matchReasons.map((r) => <li key={r} className="flex gap-1.5"><CheckCircle2 className="size-5 shrink-0 text-teal mt-0.5" aria-hidden />{r}</li>)}
        </ul>
      )}
      {m.caveats.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-base" aria-label="Be careful">
          {m.caveats.map((c) => <li key={c} className="flex gap-1.5"><AlertTriangle className="size-5 shrink-0 text-amber mt-0.5" aria-hidden />{c}</li>)}
        </ul>
      )}
      {m.source === 'manual' && onEdit && onDelete && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={onEdit} className={btnSecondary}><Pencil className="size-5" aria-hidden />Edit<span className="sr-only"> record of {m.recipient}</span></button>
          <ConfirmDelete what={`the record of ${money(m.amountCents, m.currency)} to ${m.recipient}`} onYes={onDelete} busy={busy} />
        </div>
      )}
    </li>
  );
}

/** "Did I already pay John €80?" — candidates with source badges, evidence, reasons, caveats and the guidance. */
function PaymentMatchesCard({ b, act }: { b: BlockOf<'payment_matches'>; act: BlockActions }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ManualPaymentT | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const cur = useRef(b); cur.current = b;
  const r = b.result;
  const rerun = async () => {
    const next = parseServer(PaymentSearchResult, await api(`/api/companion/payments/search?${searchQueryString(cur.current.result.query)}`));
    act.replace(cur.current, { kind: 'payment_matches', result: next });
  };
  // Shown again after a reload: run the same search so edits and deletes since then are reflected.
  useEffect(() => { rerun().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = async (id: string) => {
    setErr(null);
    try { setEditing(parseServer(ManualPayment, await api(`/api/companion/payments/${id}`))); } catch (e) { setErr(errMsg(e)); }
  };
  const del = async (id: string) => {
    setBusy(true); setErr(null);
    try { await api(`/api/companion/payments/${id}`, { method: 'DELETE' }); setMsg('Record deleted.'); await rerun(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const who = r.query.q;
  const shown = matchesCardText(r);
  // "Did I already pay for the microwave?" names an item, not a person: word the card that way.
  const itemQuery = Boolean(who) && r.matches.length > 0 && r.matches.every((m) => !m.recipient.toLowerCase().includes(String(who).toLowerCase()));
  const ask = [who ? (itemQuery ? `“${who}”` : `paying ${who}`) : 'a payment', r.query.amountCents != null ? money(r.query.amountCents, 'EUR') : null].filter(Boolean).join(' · ');
  if (!elderOnly(act)) return null;
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="payment_matches">
      <Head icon={Search} right={<Pill label={r.matches.length ? `${r.matches.length} possible match${r.matches.length === 1 ? '' : 'es'}` : 'No match found'} tone={r.matches.length ? 'pending' : 'muted'} />}>Your records: {ask}</Head>
      <div className="mt-3 rounded-2xl border-2 border-amber bg-amber-soft p-3">
        <p className="font-bold flex items-center gap-2"><AlertTriangle className="size-5 shrink-0 text-amber" aria-hidden />{itemQuery ? 'Don’t buy or pay again until you’ve checked' : <>{UI_LABEL.dontPayAgain}{who ? ` with ${who}` : ''}</>}.</p>
        {shown.guidance && <p className="mt-1 break-words">{shown.guidance}</p>}
      </div>
      {r.matches.length > 0 && (
        <ul className="mt-2 divide-y divide-line" aria-label="Possible matches">
          {r.matches.map((m) => <MatchRow key={m.id} m={m} busy={busy} onEdit={() => void edit(m.id)} onDelete={() => void del(m.id)} />)}
        </ul>
      )}
      {shown.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-base text-ink-soft" aria-label="Notes">
          {shown.notes.map((n) => <li key={n} className="flex gap-1.5"><Info className="size-5 shrink-0 mt-0.5" aria-hidden /><span className="min-w-0 break-words">{n}</span></li>)}
        </ul>
      )}
      <Err e={err} /><Done m={msg} />
      {editing && <PaymentForm initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setMsg('Record updated.'); void rerun().catch((e) => setErr(errMsg(e))); }} />}
      {adding ? <PaymentForm onCancel={() => setAdding(false)} onSaved={(p) => { setAdding(false); setMsg(`Saved: ${money(p.amountCents, p.currency)} to ${p.recipient} on ${day(p.paidOn)}.`); void rerun().catch(() => {}); }} />
        : <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => setAdding(true)} className={btnSecondary}><Plus className="size-5" aria-hidden />Add a record</button>
            <button type="button" onClick={() => act.append?.('Here are all the payment records you saved.', [{ kind: 'companion_records', section: 'payments' }])} className={btnSecondary}>All my records</button>
          </div>}
      <p className="mt-3 text-sm text-ink-soft">{MATCHES_SCOPE_NOTE}</p>
      <PrivateNote />
    </div>
  );
}

function LastPaymentCard({ b, act }: { b: BlockOf<'last_payment'>; act: BlockActions }) {
  if (!elderOnly(act)) return null;
  const p = b.payment;
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="last_payment">
      <Head icon={Wallet}>Last payment in your records</Head>
      {p ? <ul className="divide-y divide-line"><MatchRow m={p} /></ul> : <p className="mt-2 font-bold">No record found.</p>}
      <p className="mt-1 text-base break-words">{b.guidance}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {p && p.evidence.kind === 'paypal_sandbox' && /^pay_/.test(p.id) && <button type="button" onClick={() => act.receipt(p.id)} className={btnSecondary}>Show the PayPal receipt</button>}
        <a href="/activity" className={btnSecondary}>Open Activity</a>
        <button type="button" onClick={() => act.append?.('Here are all the payment records you saved.', [{ kind: 'companion_records', section: 'payments' }])} className={btnSecondary}>All my records</button>
      </div>
      <PrivateNote />
    </div>
  );
}

/** All of Mary's typed payment records: add, edit, delete, and search. Always read live from the server. */
function PaymentsManager({ act }: { act: BlockActions }) {
  const [list, setList] = useState<ManualPaymentT[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const id = useId();
  const load = async () => { try { setList(parseServer(ServerPaymentsList, await api('/api/companion/payments')).payments); } catch (e) { setErr(errMsg(e)); } };
  useEffect(() => { void load(); }, []);
  const del = async (pid: string) => { setBusy(true); try { await api(`/api/companion/payments/${pid}`, { method: 'DELETE' }); setMsg('Record deleted.'); await load(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const search = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const t = q.trim(); if (!t) return;
    const amountCents = parseAmount(t.match(/€?\s?\d+(?:[.,]\d{1,2})?/)?.[0] ?? '');
    const name = t.replace(/€?\s?\d+(?:[.,]\d{1,2})?/g, '').trim();
    const qs = searchQueryString({ q: name || null, amountCents, from: null, to: null });
    try { act.append?.(`Your records for “${t}”.`, [{ kind: 'payment_matches', result: parseServer(PaymentSearchResult, await api(`/api/companion/payments/search?${qs}`)) }]); }
    catch (er) { setErr(errMsg(er)); }
  };
  return (
    <>
      <Head icon={Wallet} right={<Pill label={UI_LABEL.manual} tone="pending" />}>My payment records</Head>
      <form role="search" onSubmit={search} className="mt-3 flex gap-2">
        <label htmlFor={id} className="sr-only">Search your payment records by name or amount</label>
        <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={80} placeholder="Name or amount, e.g. John 80" className={`${inputCls} rounded-full flex-1`} />
        <button type="submit" className="min-h-12 px-4 rounded-full bg-teal text-white font-bold shrink-0">Search</button>
      </form>
      {list === null ? <p className="mt-3 text-ink-soft">Loading…</p> : list.length === 0 ? <p className="mt-3">No records yet. Add one each time you pay someone, and I can tell you later what you recorded.</p> : (
        <ul className="mt-2 divide-y divide-line" aria-label="Payment records">
          {list.map((p) => (
            <li key={p.id} className="py-3">
              {editing === p.id ? <PaymentForm initial={p} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setMsg('Record updated.'); void load(); }} /> : (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3"><span className="font-bold break-words min-w-0">{p.recipient}</span><span className="font-bold">{money(p.amountCents, p.currency)}</span></div>
                  <p className="text-base text-ink-soft break-words">{day(p.paidOn)} · {METHOD_LABEL[p.method]}{p.note ? ` · ${p.note}` : ''}</p>
                  {p.sample && <p className="mt-1"><SampleBadge evidence /></p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={() => setEditing(p.id)} className={btnSecondary}><Pencil className="size-5" aria-hidden />Edit<span className="sr-only"> record of {p.recipient}</span></button>
                    <ConfirmDelete what={`the record of ${money(p.amountCents, p.currency)} to ${p.recipient}`} onYes={() => void del(p.id)} busy={busy} />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Err e={err} /><Done m={msg} />
      {adding ? <PaymentForm onCancel={() => setAdding(false)} onSaved={(p) => { setAdding(false); setMsg(`Saved: ${money(p.amountCents, p.currency)} to ${p.recipient}.`); void load(); }} />
        : <button type="button" onClick={() => setAdding(true)} className={`${btnSecondary} mt-3`}><Plus className="size-5" aria-hidden />Add a record</button>}
    </>
  );
}

// =====================================================================================================
// Subscriptions
// =====================================================================================================
type SubDraft = { merchant: string; amount: string; frequency: (typeof FREQUENCIES)[number]; nextOn: string; note: string };
function SubscriptionForm({ initial, onSaved, onCancel }: { initial?: SubscriptionT; onSaved: (s: SubscriptionT) => void; onCancel: () => void }) {
  const id = useId();
  const [d, setD] = useState<SubDraft>(() => initial
    ? { merchant: initial.merchant, amount: (initial.amountCents / 100).toFixed(2), frequency: initial.frequency, nextOn: initial.nextOn ?? '', note: initial.note ?? '' }
    : { merchant: '', amount: '', frequency: 'monthly', nextOn: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof SubDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value } as SubDraft);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountCents = parseAmount(d.amount);
    if (!d.merchant.trim()) return setErr('Please enter the company, for example Netflix.');
    if (!amountCents) return setErr('Please enter the amount, for example 12.99.');
    setBusy(true); setErr(null);
    try {
      const body = { merchant: d.merchant.trim(), amountCents, currency: 'EUR', frequency: d.frequency, nextOn: d.nextOn || null, note: d.note.trim() || null };
      const raw = initial ? await api(`/api/companion/subscriptions/${initial.id}`, { method: 'PATCH', body }) : await api('/api/companion/subscriptions', { body });
      onSaved(parseServer(Subscription, raw));
    } catch (er) { setErr(errMsg(er)); setBusy(false); }
  };
  return (
    <form onSubmit={save} className="mt-3 rounded-2xl border-2 border-teal/40 bg-ivory p-3 sm:p-4 grid gap-3" aria-label={initial ? 'Edit subscription' : 'Add a subscription'}>
      <p className="font-bold">{initial ? `Edit ${initial.merchant}` : 'Add a subscription you pay'}</p>
      <div><label htmlFor={`${id}-m`} className="block font-bold">Company</label><input id={`${id}-m`} className={inputCls} value={d.merchant} onChange={set('merchant')} maxLength={80} autoComplete="off" placeholder="e.g. Netflix" /></div>
      <div className="grid gap-3 min-[420px]:grid-cols-2">
        <div><label htmlFor={`${id}-a`} className="block font-bold">Amount (€)</label><input id={`${id}-a`} className={inputCls} value={d.amount} onChange={set('amount')} inputMode="decimal" maxLength={12} placeholder="12.99" /></div>
        <div><label htmlFor={`${id}-f`} className="block font-bold">How often</label>
          <select id={`${id}-f`} className={inputCls} value={d.frequency} onChange={set('frequency')}>{FREQUENCIES.map((f) => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}</select></div>
      </div>
      <div><label htmlFor={`${id}-n`} className="block font-bold">Next charge <span className="font-normal text-ink-soft">(optional)</span></label><input id={`${id}-n`} type="date" className={inputCls} value={d.nextOn} onChange={set('nextOn')} max="2100-12-31" /></div>
      <div><label htmlFor={`${id}-o`} className="block font-bold">Note <span className="font-normal text-ink-soft">(optional)</span></label><input id={`${id}-o`} className={inputCls} value={d.note} onChange={set('note')} maxLength={200} /></div>
      <p className="text-sm text-ink-soft">Prototype: you enter these yourself. SaySafe can’t see your bank or cancel anything for you.</p>
      <Err e={err} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Save'}</button>
        <button type="button" onClick={onCancel} className={btnSecondary}>Cancel</button>
      </div>
    </form>
  );
}

function statusTone(s: SubscriptionT): Tone {
  if (s.stoppedTrackingAt) return 'muted';
  if (s.status === 'provider_confirmed') return 'ok';
  if (s.status === 'user_reported_cancelled' || s.status === 'cancellation_requested' || s.status === 'instructions_opened') return 'pending';
  return 'muted';
}
function Totals({ summary }: { summary: SubscriptionSummaryT }) {
  return (
    <div className="mt-3 rounded-2xl bg-teal-soft p-3" data-testid="sub-totals">
      {summary.totals.length === 0 ? <p className="font-bold">Nothing counted yet.</p> : summary.totals.map((t) => (
        <p key={t.currency} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-3xl font-semibold" data-testid={`monthly-${t.currency}`}>{money(t.monthlyCents, t.currency)}</span><span className="font-bold">a month</span>
          <span className="text-ink-soft"><span data-testid={`annual-${t.currency}`}>{money(t.annualCents, t.currency)}</span> a year, {t.count} counted</span>
        </p>
      ))}
      <details className="mt-1 text-sm text-ink-soft"><summary className="cursor-pointer font-bold min-h-11 inline-flex items-center">How this is worked out</summary><p className="mt-1">{summary.method}</p></details>
    </div>
  );
}

function SubscriptionRow({ s, selected, onSelect, act, reload, tags = [] }: { s: SubscriptionT; selected: boolean; onSelect: () => void; act: BlockActions; reload: () => Promise<void>; tags?: string[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const demo = isDemo(s);
  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label); setErr(null); setMsg(null);
    try { await fn(); if (done) setMsg(done); await reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };
  const helpCancel = () => run('help', async () => {
    if (demo) {
      const it = parseServer(ServerCancelIntent, await api('/api/companion/subscriptions/demo/cancel-intent', { body: {} }));
      act.append?.(`To stop the ${DEMO_MEMBERSHIP.name}, tap “Cancel billing via PayPal” on the card. Nothing is cancelled until you tap it.`, [cancelCardFrom(it)], { speak: true });
    } else {
      const h = parseServer(ServerCancelHelp, await api(`/api/companion/subscriptions/${s.id}/cancel-help`, { body: {} }));
      act.append?.(h.guide ? `Here are ${h.guide.name}’s own cancellation steps. You cancel with them. SaySafe can’t cancel it for you.` : 'Here are general steps. SaySafe can’t cancel it for you.', [helpFromCancelHelp(h)], { speak: true });
    }
  });
  const keep = () => run('keep', async () => { if (!demo && s.status === 'instructions_opened') await api(`/api/companion/subscriptions/${s.id}/status`, { body: { to: 'tracking' } }); }, `Kept. SaySafe keeps counting ${s.merchant}.`);
  const live = !s.stoppedTrackingAt && s.status !== 'provider_confirmed' && s.status !== 'user_reported_cancelled';
  return (
    <li className={`py-2 ${selected ? 'bg-teal-soft/40 rounded-2xl' : ''}`} data-sub={s.merchant}>
      {tags.length > 0 && <p className="mt-1 flex flex-wrap gap-2 px-2">{tags.map((t) => <Pill key={t} label={t} tone="ok" />)}</p>}
      <button type="button" aria-expanded={selected} onClick={onSelect} className="w-full text-left flex items-start gap-3 p-2 min-h-14 rounded-2xl hover:bg-teal-soft">
        <Repeat className="size-6 shrink-0 text-teal mt-0.5" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3"><span className="font-bold break-words min-w-0">{s.merchant}</span><span className="font-bold whitespace-nowrap">{money(s.amountCents, s.currency)} <span className="font-normal text-ink-soft">/ {s.frequency === 'weekly' ? 'week' : s.frequency === 'monthly' ? 'month' : 'year'}</span></span></span>
          <span className="block text-base text-ink-soft">{nextChargeText(s)}</span>
          {!s.sample && <span className="block text-base text-ink-soft">{sourceText(s)}</span>}{/* sample rows: the Sample data badge says it */}
          <span className="block text-base text-ink-soft">{managedText(s)}</span>
          {s.sample && <span className="mt-1 flex"><SampleBadge /></span>}
          {(s.status !== 'tracking' || s.stoppedTrackingAt) && <span className="mt-1 flex flex-wrap gap-2"><Pill label={s.stoppedTrackingAt ? 'Not tracked — not counted' : s.statusLabel} tone={statusTone(s)} /></span>}
        </span>
      </button>
      {selected && (
        <div className="px-2 pb-2">
          {demo && s.paypal && <p className="text-base break-words"><span className="text-ink-soft">PayPal says: </span><span className="font-bold">{s.paypal.status ?? 'not checked'}</span>{s.paypal.lastCheckedAt ? ` · checked ${new Date(s.paypal.lastCheckedAt).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</p>}
          {s.evidenceNote && <p className="text-base break-words"><span className="text-ink-soft">{s.confirmedBy === 'user' ? 'Your note: ' : 'PayPal: '}</span>{s.evidenceNote}</p>}
          <Err e={err} /><Done m={msg} />
          {editing ? <SubscriptionForm initial={s} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); setMsg('Saved.'); void reload(); }} /> : (
            <div className="mt-2 flex flex-wrap gap-2">
              {live && <button type="button" onClick={() => void keep()} disabled={busy !== null} className={btnSecondary}>{busy === 'keep' ? 'Saving…' : 'Keep'}</button>}
              {live && (!demo || s.paypal?.status === 'ACTIVE' || s.paypal?.status === 'SUSPENDED') && <button type="button" onClick={() => void helpCancel()} disabled={busy !== null} className={btnSecondary}>{busy === 'help' ? 'Opening…' : 'Help me cancel'}</button>}
              {!demo && s.status === 'user_reported_cancelled' && <button type="button" onClick={() => void run('undo', () => api(`/api/companion/subscriptions/${s.id}/status`, { body: { to: 'tracking' } }), 'Back to tracking.')} disabled={busy !== null} className={btnSecondary}>It’s still active</button>}
              {!demo && <button type="button" onClick={() => setEditing(true)} className={btnSecondary}><Pencil className="size-5" aria-hidden />Edit<span className="sr-only"> {s.merchant}</span></button>}
              {s.stoppedTrackingAt
                ? <button type="button" onClick={() => void run('track', () => api(`/api/companion/subscriptions/${s.id}/resume-tracking`, { body: {} }), 'Counting it again.')} disabled={busy !== null} className={btnSecondary}>Track again</button>
                : <button type="button" onClick={() => void run('stop', () => api(`/api/companion/subscriptions/${s.id}/stop-tracking`, { body: {} }), `SaySafe stopped counting ${s.merchant}. That doesn’t cancel anything with the company.`)} disabled={busy !== null} className={btnSecondary}><CircleSlash className="size-5" aria-hidden />Stop tracking</button>}
              {!demo && <ConfirmDelete what={s.merchant} onYes={() => void run('del', () => api(`/api/companion/subscriptions/${s.id}`, { method: 'DELETE' }))} busy={busy === 'del'} />}
            </div>
          )}
          {!demo && <p className="mt-2 text-sm text-ink-soft">“Stop tracking” only stops SaySafe counting it. It doesn’t cancel anything.</p>}
        </div>
      )}
    </li>
  );
}

/** Subscriptions list + monthly and annual totals. Used for "What do I pay every month?" and the records manager. */
function SubscriptionsManager({ act, initial, select }: { act: BlockActions; initial?: SubscriptionSummaryT; select?: string | null }) {
  const [subs, setSubs] = useState<SubscriptionT[] | null>(null);
  const [summary, setSummary] = useState<SubscriptionSummaryT | null>(initial ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(select ?? null);
  const [adding, setAdding] = useState(false);
  const load = async () => {
    try {
      const [l, s] = await Promise.all([api('/api/companion/subscriptions'), api('/api/companion/subscriptions/summary')]);
      setSubs(parseServer(ServerSubsList, l).subscriptions); setSummary(parseServer(SubscriptionSummary, s)); setErr(null);
    } catch (e) { setErr(errMsg(e)); }
  };
  useEffect(() => { void load(); }, []);
  const hasDemo = subs?.some(isDemo);
  return (
    <>
      <Head icon={Repeat} right={<Pill label="Prototype" tone="muted" />}>What you pay regularly</Head>
      {summary && <Totals summary={summary} />}
      {summary && (summary.excluded.stoppedTracking + summary.excluded.userReportedCancelled + summary.excluded.providerConfirmed) > 0 && (
        <p className="mt-1 text-sm text-ink-soft">Not counted: {[summary.excluded.userReportedCancelled && `${summary.excluded.userReportedCancelled} you told SaySafe are cancelled`, summary.excluded.providerConfirmed && `${summary.excluded.providerConfirmed} PayPal confirmed cancelled`, summary.excluded.stoppedTracking && `${summary.excluded.stoppedTracking} not tracked`].filter(Boolean).join(', ')}.</p>
      )}
      {subs === null ? <p className="mt-3 text-ink-soft">Loading…</p> : subs.length === 0 ? <p className="mt-3">You haven’t added any subscriptions yet. Add them yourself and I’ll add up what they cost.</p> : (
        <>
          <p className="mt-3 text-base text-ink-soft">Tap one to keep it or get help cancelling. You can also say “cancel my Netflix”.</p>
          <ul className="mt-1" aria-label="Your subscriptions">
            {subs.map((s) => <SubscriptionRow key={s.id} s={s} act={act} reload={load} selected={sel === s.id} onSelect={() => setSel(sel === s.id ? null : s.id)} />)}
          </ul>
        </>
      )}
      <Err e={err} />
      {adding ? <SubscriptionForm onCancel={() => setAdding(false)} onSaved={(s) => { setAdding(false); setSel(s.id); void load(); }} /> : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => setAdding(true)} className={btnSecondary}><Plus className="size-5" aria-hidden />Add a subscription</button>
          {!hasDemo && <button type="button" onClick={() => act.append?.('The SaySafe Demo Membership is a PayPal sandbox subscription you can start and cancel here. No real money.', [{ kind: 'demo_membership', returned: null }])} className={btnSecondary}>Try the Demo Membership</button>}
        </div>
      )}
      <p className="mt-3 text-sm text-ink-soft">Prototype: you enter these yourself. SaySafe can’t see your bank or cancel other companies’ subscriptions. Totals are per currency, never converted.</p>
    </>
  );
}

function MonthlyCostsCard({ b, act }: { b: BlockOf<'monthly_costs'>; act: BlockActions }) {
  if (!elderOnly(act)) return null;
  return <div className={`${cardCls} p-4 sm:p-5`} data-card="monthly_costs"><SubscriptionsManager act={act} initial={b.summary} /><PrivateNote /></div>;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
function ScopeBoxes({ scope, merchant }: { scope: { billingAuthorisation: string; serviceContract: string }; merchant: string | null }) {
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Two different things to cancel">
      <section className="rounded-2xl border border-line p-3"><h4 className="font-bold">1 · The service{merchant ? ` with ${merchant}` : ''}</h4><p className="mt-1 text-base break-words">{cap(scope.serviceContract.replace(/^Service contract:\s*/i, ''))}</p></section>
      <section className="rounded-2xl border border-line p-3"><h4 className="font-bold">2 · PayPal automatic payment</h4><p className="mt-1 text-base break-words">{cap(scope.billingAuthorisation.replace(/^PayPal billing authorisation[^:]*:\s*/i, ''))}</p></section>
    </div>
  );
}

/** External merchant: the official link card, the PayPal automatic-payments link, Keep, and "I've cancelled it". */
function SubscriptionHelpCard({ b, act }: { b: BlockOf<'subscription_help'>; act: BlockActions }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const cur = useRef(b); cur.current = b;
  const sub = b.subscription;
  const nid = useId();
  // Re-read the subscription so a reload shows what Mary last told SaySafe.
  useEffect(() => {
    if (!sub) return;
    api(`/api/companion/subscriptions/${sub.id}`).then((raw) => { const s = parseServer(Subscription, raw); if (s.status !== cur.current.subscription?.status || s.updatedAt !== cur.current.subscription?.updatedAt) act.replace(cur.current, { ...cur.current, subscription: s }); }).catch(() => {});
  }, [sub?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = async (label: string, steps: { to: string; note?: string | null }[]) => {
    if (!sub) return;
    setBusy(label); setErr(null);
    try {
      let s = sub;
      for (const st of steps) s = parseServer(Subscription, await api(`/api/companion/subscriptions/${sub.id}/status`, { body: st }));
      act.replace(cur.current, { ...cur.current, subscription: s });
      setAsking(false);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };
  const reported = sub?.status === 'user_reported_cancelled';
  // From a spoken request the row may still be "tracking": record that the steps were opened first.
  const toReported = () => move('done', [...(sub?.status === 'tracking' ? [{ to: 'instructions_opened' }] : []), { to: 'user_reported_cancelled', note: note.trim() || null }]);
  const name = b.guide?.name ?? sub?.merchant ?? b.merchant ?? 'this company';
  if (!elderOnly(act)) return null;
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="subscription_help">
      <Head icon={Repeat} right={sub ? <Pill label={reported ? 'Reported by you' : sub.statusLabel} tone={reported ? 'pending' : 'muted'} /> : undefined}>Cancel {name}</Head>
      {sub && <p className="mt-2 font-bold">{sub.merchant} · {money(sub.amountCents, sub.currency)} {FREQ_LABEL[sub.frequency].toLowerCase()}</p>}
      {reported && (
        <div className="mt-3 rounded-2xl border-2 border-amber bg-amber-soft p-3" role="status" data-testid="user-reported">
          <p className="font-bold">{UI_LABEL.userReported}</p>
          {sub?.evidenceNote && <p className="mt-1 break-words">Your note: {sub.evidenceNote}</p>}
          {sub?.confirmedOn && <p className="mt-1 text-base">You told SaySafe on {day(sub.confirmedOn)}. Keep the company’s confirmation email.</p>}
        </div>
      )}
      <ScopeBoxes scope={b.cancellationScope} merchant={sub?.merchant ?? b.merchant} />
      {b.guide ? (
        <div className="mt-3 rounded-2xl border-2 border-teal p-3" data-testid="official-link">
          <p className="text-sm font-bold uppercase tracking-wider text-teal">Official page · checked {day(b.guide.verifiedOn)}</p>
          <a href={b.guide.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex w-full items-center justify-between gap-3 rounded-2xl bg-teal text-white font-bold px-5 min-h-14 hover:bg-teal-deep">
            <span className="min-w-0 break-words">Open {b.guide.name}’s cancel page</span><ExternalLink className="size-5 shrink-0" aria-hidden /><span className="sr-only"> (opens {new URL(b.guide.url).hostname} in a new tab)</span>
          </a>
          <p className="mt-1 text-sm text-ink-soft break-all">{new URL(b.guide.url).hostname}</p>
          <ol className="mt-2 list-decimal pl-6 space-y-0.5 text-base">{b.guide.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          {b.guide.note && <p className="mt-2 text-base">{b.guide.note}</p>}
        </div>
      ) : (
        <div className="mt-3 rounded-2xl border border-line p-3">
          <p className="font-bold">I don’t have a checked link for {name}. General steps:</p>
          <ol className="mt-1 list-decimal pl-6 space-y-0.5 text-base">{b.genericSteps.map((s) => <li key={s}>{s}</li>)}</ol>
        </div>
      )}
      <a href={b.paypalAutopayUrl} target="_blank" rel="noopener noreferrer" className={`${linkCls} mt-2`}>PayPal automatic payments (sign in yourself)<ExternalLink className="size-5" aria-hidden /><span className="sr-only"> (opens PayPal in a new tab)</span></a>
      <p className="mt-2 text-base text-ink-soft">{b.disclaimer || EXTERNAL_DISCLAIMER}</p>
      <Err e={err} />
      {sub && sub.source === 'manual' && !reported && (asking ? (
        <div className="mt-3 rounded-2xl bg-ivory p-3 grid gap-2">
          <label htmlFor={nid} className="font-bold">Anything to note? <span className="font-normal text-ink-soft">(optional, e.g. “confirmation email 3 Nov”)</span></label>
          <input id={nid} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={inputCls} />
          <p className="text-sm text-ink-soft">SaySafe will show this as “{UI_LABEL.userReported}”.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void toReported()} disabled={busy !== null} className={btnPrimary}>{busy === 'done' ? 'Saving…' : 'Yes, I’ve cancelled it'}</button>
            <button type="button" onClick={() => setAsking(false)} className={btnSecondary}>Not yet</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => setAsking(true)} className={btnSecondary}><CheckCircle2 className="size-5" aria-hidden />I’ve cancelled it</button>
          <button type="button" onClick={() => void move('keep', sub.status === 'instructions_opened' ? [{ to: 'tracking' }] : [])} disabled={busy !== null} className={btnSecondary}>{busy === 'keep' ? 'Saving…' : 'Keep it'}</button>
        </div>
      ))}
      {sub && reported && <button type="button" onClick={() => void move('undo', [{ to: 'tracking' }])} disabled={busy !== null} className={`${btnSecondary} mt-3`}>It’s still active</button>}
      {!sub && <p className="mt-2 text-sm text-ink-soft">This isn’t in your list, so SaySafe has nothing to update.</p>}
      <PrivateNote />
    </div>
  );
}

// ---------- SaySafe Demo Membership (PayPal sandbox subscription) ----------
const Sandbox = () => <span className="inline-flex items-center rounded-full bg-amber-soft text-amber font-bold text-sm px-3 py-0.5 border border-amber/30">PayPal Sandbox · no real money</span>;
const RETURN_TEXT: Record<string, string> = {
  active: 'Back from PayPal: PayPal shows the membership as active.',
  approval_pending: 'Back from PayPal: it isn’t approved yet, so nothing is billed.',
  declined: 'You left PayPal without approving. Nothing is billed.',
  check_failed: 'Back from PayPal, but SaySafe couldn’t check with PayPal yet. Tap “Check with PayPal”.',
};

function DemoMembershipCard({ b, act }: { b: BlockOf<'demo_membership'>; act: BlockActions }) {
  const [st, setSt] = useState<{ subscription: SubscriptionT | null; configured: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => { try { setSt(parseServer(ServerDemoStatus, await api('/api/companion/subscriptions/demo/status'))); setErr(null); } catch (e) { setErr(errMsg(e)); } };
  useEffect(() => { void load(); }, []);
  const start = async () => {
    setBusy('start'); setErr(null);
    try {
      const r = parseServer(ServerDemoStart, await api('/api/companion/subscriptions/demo/start', { body: {}, idempotent: true }));
      if (r.approveUrl && /^https:\/\//.test(r.approveUrl)) return goToPayPal(r.approveUrl);
      await load(); setBusy(null);
    } catch (e) { setErr(errMsg(e)); setBusy(null); }
  };
  const cancel = async () => {
    setBusy('cancel'); setErr(null);
    try {
      const it = parseServer(ServerCancelIntent, await api('/api/companion/subscriptions/demo/cancel-intent', { body: {} }));
      act.append?.(`To stop the ${DEMO_MEMBERSHIP.name}, tap “Cancel billing via PayPal” on the card. Nothing is cancelled until you tap it.`, [cancelCardFrom(it)], { speak: true });
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };
  if (!elderOnly(act)) return null;
  const s = st?.subscription ?? null;
  const pp = s?.paypal?.status ?? null;
  const ended = !s || s.status === 'provider_confirmed' || pp === 'CANCELLED' || pp === 'EXPIRED';
  const tone: Tone = pp === 'ACTIVE' ? 'ok' : pp === 'APPROVAL_PENDING' ? 'pending' : ended && s ? 'muted' : 'muted';
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="demo_membership">
      <Head icon={Repeat} right={<Sandbox />}>{DEMO_MEMBERSHIP.name}</Head>
      <p className="mt-2 font-bold">{money(DEMO_MEMBERSHIP.amountCents, DEMO_MEMBERSHIP.currency)} a month to {DEMO_MEMBERSHIP.merchant}</p>
      {b.returned && RETURN_TEXT[b.returned] && <p className="mt-1" role="status">{RETURN_TEXT[b.returned]}</p>}
      {st === null ? <p className="mt-2 text-ink-soft">Checking with PayPal…</p> : !st.configured ? (
        <p className="mt-2">The Demo Membership isn’t set up on this server yet, so there is nothing to start.</p>
      ) : (
        <>
          <p className="mt-2 flex flex-wrap items-center gap-2" data-testid="demo-status"><span className="text-ink-soft">Status:</span><Pill label={s ? (s.status === 'provider_confirmed' ? 'Cancelled — confirmed by PayPal' : pp === 'ACTIVE' ? 'Active' : pp === 'APPROVAL_PENDING' ? 'Waiting for your approval at PayPal' : pp ?? s.statusLabel) : 'Not started'} tone={tone} /></p>
          {s?.paypal && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
              <dt className="text-ink-soft">PayPal says</dt><dd className="font-bold">{pp ?? 'not checked'}</dd>
              <dt className="text-ink-soft">Last checked</dt><dd className="font-bold">{s.paypal.lastCheckedAt ? new Date(s.paypal.lastCheckedAt).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not yet'}</dd>
              <dt className="text-ink-soft">Signed notice</dt><dd className="font-bold">{s.paypal.webhookVerified ? 'Verified' : 'Not received yet'}</dd>
              {s.nextOn && pp === 'ACTIVE' && <><dt className="text-ink-soft">Next charge</dt><dd className="font-bold">{day(s.nextOn)}</dd></>}
              {s.evidenceNote && s.status === 'provider_confirmed' && <><dt className="text-ink-soft">Evidence</dt><dd className="min-w-0 break-words">{s.evidenceNote}</dd></>}
            </dl>
          )}
          <Err e={err} />
          <div className="mt-3 flex flex-col gap-2">
            {ended && <button type="button" onClick={() => void start()} disabled={busy !== null} className={btnPrimary}>{busy === 'start' ? 'Opening PayPal…' : 'Start Demo Membership'}</button>}
            {pp === 'APPROVAL_PENDING' && s?.paypal?.approveUrl && /^https:\/\//.test(s.paypal.approveUrl) && <button type="button" onClick={() => goToPayPal(s.paypal!.approveUrl!)} className={btnPrimary}>Continue to PayPal</button>}
            {(pp === 'ACTIVE' || pp === 'SUSPENDED') && s?.status !== 'provider_confirmed' && <button type="button" onClick={() => void cancel()} disabled={busy !== null} className={btnSecondary}>{busy === 'cancel' ? 'Opening…' : 'Cancel membership'}</button>}
            <button type="button" onClick={() => void load()} className={linkCls}><RotateCcw className="size-5" aria-hidden />Check with PayPal</button>
          </div>
          <p className="mt-2 text-sm text-ink-soft">{ended ? 'Start takes you to PayPal to approve. Nothing is billed until you approve there.' : 'SaySafe Demo Shop is the merchant, so this is the one subscription SaySafe can cancel — only after you tap to confirm.'}</p>
        </>
      )}
      <PrivateNote />
    </div>
  );
}

/**
 * Confirmation card. The exact text, a big "Cancel billing via PayPal" button (tap only), then a status card:
 * pending -> confirmed (only when the server says provider_confirmed) or retry_needed / error with Retry.
 */
function DemoCancelCard({ b, act }: { b: BlockOf<'demo_cancel_intent'>; act: BlockActions }) {
  const cur = useRef(b); cur.current = b;
  const hid = useId();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (b.phase !== 'confirm') return; const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, [b.phase]);
  const expired = b.phase === 'confirm' && Date.parse(b.expiresAt) <= now;
  const tap = async () => {
    const token = cur.current.token;
    // The token leaves the saved conversation the moment it is used: it works once.
    act.replace(cur.current, { ...cur.current, token: '', phase: 'pending', message: null });
    try {
      const raw = await api(b.cancelEndpoint, { body: { token } });
      const r = parseServer(ServerCancelResult, raw);
      const phase = cancelPhase(r);
      act.replace(cur.current, { ...cur.current, token: '', phase, message: r.message.slice(0, 400), evidence: r.subscription.evidenceNote?.slice(0, 400) ?? null });
      act.speak?.(phase === 'confirmed' ? 'PayPal confirmed the Demo Membership billing is cancelled.' : 'It is not cancelled yet. Nothing is confirmed. You can try again.');
    } catch (e) {
      act.replace(cur.current, { ...cur.current, token: '', phase: 'error', message: errMsg(e).slice(0, 400) });
    }
  };
  const retry = async () => {
    act.replace(cur.current, { ...cur.current, phase: 'pending', message: 'Getting a new confirmation…' });
    try {
      const it = parseServer(ServerCancelIntent, await api('/api/companion/subscriptions/demo/cancel-intent', { body: {} }));
      act.replace(cur.current, cancelCardFrom(it));
    } catch (e) { act.replace(cur.current, { ...cur.current, phase: 'error', message: errMsg(e).slice(0, 400) }); }
  };
  if (!elderOnly(act)) return null;
  const until = new Date(b.expiresAt).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className={`${cardCls} p-4 sm:p-5 ${b.phase === 'confirm' && !expired ? 'border-2 border-danger' : ''}`} data-card="demo_cancel_intent" data-phase={b.phase}>
      <Head icon={Repeat} right={<Sandbox />}>{b.phase === 'confirm' ? 'Please confirm' : 'Cancelling the Demo Membership'}</Head>
      {b.phase === 'confirm' && (
        <>
          <h3 id={`${hid}-t`} className="mt-2 text-[1.35rem] break-words" data-testid="confirm-text">{b.confirmText}</h3>
          <ScopeBoxes scope={b.cancellationScope} merchant={DEMO_MEMBERSHIP.merchant} />
          {expired ? (
            <>
              <p className="mt-3 font-bold" role="status">This confirmation has expired. Nothing was cancelled.</p>
              <button type="button" onClick={() => void retry()} className={`${btnSecondary} mt-2`}>Ask again</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => void tap()} aria-describedby={`${hid}-t`} className="mt-4 w-full min-h-16 rounded-2xl bg-danger text-white text-[1.2rem] font-bold px-5 hover:opacity-90" data-testid="cancel-billing">Cancel billing via PayPal</button>
              <p className="mt-2 text-base text-ink-soft">Only a tap cancels: saying “yes” doesn’t. This confirmation works once, until {until}. Afterwards SaySafe checks with PayPal.</p>
              <button type="button" onClick={() => { act.replace(cur.current, { ...cur.current, token: '', phase: 'error', message: 'You kept your membership. Nothing was cancelled.' }); }} className={`${btnSecondary} mt-2`}>Keep my membership</button>
            </>
          )}
        </>
      )}
      {b.phase === 'pending' && <p className="mt-3 font-bold flex items-center gap-2" role="status"><Loader2 className="size-6 motion-safe:animate-spin" aria-hidden />{b.message ?? 'Cancelling with PayPal — not confirmed yet.'}</p>}
      {b.phase === 'confirmed' && (
        <div className="mt-3" role="status">
          <p className="font-bold text-lg flex items-center gap-2"><CheckCircle2 className="size-6 text-teal shrink-0" aria-hidden />PayPal confirmed the billing authorisation is cancelled</p>
          {b.message && <p className="mt-1 break-words">{b.message.replace(/^PayPal confirmed the billing authorisation is cancelled\.\s*/, '')}</p>}
          {b.evidence && <p className="mt-1 text-base text-ink-soft break-words">Evidence: {b.evidence}</p>}
        </div>
      )}
      {(b.phase === 'retry_needed' || b.phase === 'error') && (
        <div className="mt-3">
          <p className="font-bold flex items-center gap-2" role="alert"><AlertTriangle className="size-6 text-amber shrink-0" aria-hidden />{b.message?.startsWith('You kept') ? 'Kept' : 'Not cancelled — nothing is confirmed'}</p>
          {b.message && <p className="mt-1 break-words">{b.message}</p>}
          {!b.message?.startsWith('You kept') && <button type="button" onClick={() => void retry()} className={`${btnSecondary} mt-2`}><RotateCcw className="size-5" aria-hidden />Retry</button>}
          {!b.message?.startsWith('You kept') && <p className="mt-1 text-sm text-ink-soft">Retry gets a new confirmation. You tap again to send it.</p>}
        </div>
      )}
    </div>
  );
}

// =====================================================================================================
// Trusted contacts
// =====================================================================================================
type ContactDraft = { name: string; relation: string; phone: string; email: string; note: string };
function ContactForm({ initial, onSaved, onCancel }: { initial?: ContactT; onSaved: (c: ContactT) => void; onCancel: () => void }) {
  const id = useId();
  const [d, setD] = useState<ContactDraft>(() => ({ name: initial?.name ?? '', relation: initial?.relation ?? '', phone: initial?.phone ?? '', email: initial?.email ?? '', note: initial?.note ?? '' }));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof ContactDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!d.name.trim()) return setErr('Please enter a name.');
    if (d.phone && !/^[+()\d\s.-]*$/.test(d.phone)) return setErr('A phone number can only have digits, spaces and + ( ) - .');
    setBusy(true); setErr(null);
    try {
      const body = { name: d.name.trim(), relation: d.relation.trim() || null, phone: d.phone.trim() || null, email: d.email.trim() || null, note: d.note.trim() || null };
      const raw = initial ? await api(`/api/companion/contacts/${initial.id}`, { method: 'PATCH', body }) : await api('/api/companion/contacts', { body });
      onSaved(parseServer(Contact, raw));
    } catch (er) { setErr(errMsg(er)); setBusy(false); }
  };
  return (
    <form onSubmit={save} className="mt-3 rounded-2xl border-2 border-teal/40 bg-ivory p-3 sm:p-4 grid gap-3" aria-label={initial ? 'Edit contact' : 'Add a trusted contact'}>
      <p className="font-bold">{initial ? `Edit ${initial.name}` : 'Add a trusted contact'}</p>
      <div className="grid gap-3 min-[420px]:grid-cols-2">
        <div><label htmlFor={`${id}-n`} className="block font-bold">Name</label><input id={`${id}-n`} className={inputCls} value={d.name} onChange={set('name')} maxLength={60} autoComplete="off" placeholder="e.g. Tom" /></div>
        <div><label htmlFor={`${id}-r`} className="block font-bold">Who they are <span className="font-normal text-ink-soft">(optional)</span></label><input id={`${id}-r`} className={inputCls} value={d.relation} onChange={set('relation')} maxLength={40} placeholder="e.g. son" /></div>
      </div>
      <div><label htmlFor={`${id}-p`} className="block font-bold">Phone</label><input id={`${id}-p`} type="tel" className={inputCls} value={d.phone} onChange={set('phone')} maxLength={30} autoComplete="off" placeholder="+353 87 123 4567" /></div>
      <div><label htmlFor={`${id}-e`} className="block font-bold">Email <span className="font-normal text-ink-soft">(optional)</span></label><input id={`${id}-e`} type="email" className={inputCls} value={d.email} onChange={set('email')} maxLength={120} autoComplete="off" /></div>
      <div><label htmlFor={`${id}-o`} className="block font-bold">Note <span className="font-normal text-ink-soft">(optional)</span></label><input id={`${id}-o`} className={inputCls} value={d.note} onChange={set('note')} maxLength={200} /></div>
      <p className="text-sm text-ink-soft">Saved as “{UI_LABEL.contact}”. SaySafe uses it only to compare with what a message claims.</p>
      <Err e={err} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Save contact'}</button>
        <button type="button" onClick={onCancel} className={btnSecondary}>Cancel</button>
      </div>
    </form>
  );
}

function ContactItem({ c, onEdit, onDelete, busy }: { c: ContactT; onEdit: () => void; onDelete: () => void; busy?: boolean }) {
  // Sample contacts have fictional, non-routable details: no call or email links, so nobody is ever contacted by accident.
  const tel = c.sample ? null : telHref(c.phone); const mail = c.sample ? null : mailHref(c.email);
  return (
    <li className="py-3" data-contact={c.name}>
      {/* Name and relation flow as one line of text, so "· your pharmacy" never starts a line on its own. */}
      <p className="flex items-start gap-2"><UserRound className="size-6 text-teal shrink-0 mt-0.5" aria-hidden /><span className="min-w-0 break-words"><span className="font-bold text-lg">{c.name}</span>{c.relation && <span className="text-ink-soft"> · your {c.relation}</span>}</span></p>
      <p className="mt-1 flex flex-wrap gap-2">{c.sample ? <SampleBadge /> : <Pill label={UI_LABEL.contact} tone="pending" />}</p>
      {c.phone && <p className="mt-1 text-base break-words"><span className="text-ink-soft">Phone you saved: </span><span className="font-bold">{c.phone}</span></p>}
      {c.email && <p className="text-base break-all"><span className="text-ink-soft">Email you saved: </span><span className="font-bold">{c.email}</span></p>}
      {c.note && <p className="text-base text-ink-soft break-words">{c.note}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {tel && <a href={tel} className="min-h-12 rounded-full bg-teal text-white font-bold px-5 inline-flex items-center gap-2 hover:bg-teal-deep"><Phone className="size-5" aria-hidden />Call {c.name}</a>}
        {mail && <a href={mail} className={btnSecondary}><Mail className="size-5" aria-hidden />Email {c.name}</a>}
        <button type="button" onClick={onEdit} className={btnSecondary}><Pencil className="size-5" aria-hidden />Edit<span className="sr-only"> {c.name}</span></button>
        <ConfirmDelete what={c.name} onYes={onDelete} busy={busy} />
      </div>
    </li>
  );
}

function ContactList({ contacts, reload, setMsg, setErr }: { contacts: ContactT[]; reload: () => Promise<void>; setMsg: (m: string | null) => void; setErr: (e: string | null) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const del = async (c: ContactT) => { setBusy(true); try { await api(`/api/companion/contacts/${c.id}`, { method: 'DELETE' }); setMsg(`${c.name} deleted.`); await reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  return (
    <>
    {/* Said once for the list, not repeated under every sample contact. */}
    {contacts.some((c) => c.sample) && <p className="mt-2 text-sm text-ink-soft">Sample contacts are fictional: their numbers are in a range reserved for TV drama, so Call and Email are turned off.</p>}
    <ul className="mt-2 divide-y divide-line" aria-label="Trusted contacts">
      {contacts.map((c) => editing === c.id
        ? <li key={c.id}><ContactForm initial={c} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setMsg('Saved.'); void reload(); }} /></li>
        : <ContactItem key={c.id} c={c} busy={busy} onEdit={() => setEditing(c.id)} onDelete={() => void del(c)} />)}
    </ul>
    </>
  );
}

/** "My son's number": the lookup result, with call/email links to the details Mary saved. */
function ContactLookupCard({ b, act }: { b: BlockOf<'contact_card'>; act: BlockActions }) {
  const [list, setList] = useState<ContactT[]>(b.contacts);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ids = b.contacts.map((c) => c.id).join(',');
  // Re-read: shows edits and deletes made since (also after a reload).
  const reload = async () => { const all = parseServer(ServerContactsList, await api('/api/companion/contacts')).contacts; setList(all.filter((c) => ids.split(',').includes(c.id))); };
  useEffect(() => { reload().catch(() => {}); }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!elderOnly(act)) return null;
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="contact_card">
      <Head icon={UserRound}>{b.query ? `Trusted contact: ${b.query}` : 'Trusted contacts'}</Head>
      {list.length ? <ContactList contacts={list} reload={reload} setMsg={setMsg} setErr={setErr} /> : <p className="mt-2 font-bold">{b.query ? `No saved contact for ${b.query}.` : 'No contact found.'}</p>}
      <p className="mt-2 text-base break-words">{b.advice}</p>
      <Err e={err} /><Done m={msg} />
      <button type="button" onClick={() => act.append?.('Here are the contacts you saved.', [{ kind: 'companion_records', section: 'contacts' }])} className={`${btnSecondary} mt-3`}>{list.length ? 'All my contacts' : 'Add a contact'}</button>
      <PrivateNote />
    </div>
  );
}

function ContactsManager() {
  const [list, setList] = useState<ContactT[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const id = useId();
  const reload = async () => { try { setList(parseServer(ServerContactsList, await api('/api/companion/contacts')).contacts); } catch (e) { setErr(errMsg(e)); } };
  useEffect(() => { void reload(); }, []);
  const shown = (list ?? []).filter((c) => !q.trim() || `${c.name} ${c.relation ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <Head icon={UserRound} right={<Pill label={UI_LABEL.contact} tone="pending" />}>My trusted contacts</Head>
      {list && list.length > 3 && (
        <div className="mt-3"><label htmlFor={id} className="sr-only">Find a trusted contact</label><input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a contact" maxLength={60} className={`${inputCls} rounded-full`} /></div>
      )}
      {list === null ? <p className="mt-3 text-ink-soft">Loading…</p> : list.length === 0 ? <p className="mt-3">No contacts yet. Save the real numbers of people you trust. If a message claims to be from them from another number, I’ll tell you.</p>
        : shown.length === 0 ? <p className="mt-3">No contact matches “{q}”.</p> : <ContactList contacts={shown} reload={reload} setMsg={setMsg} setErr={setErr} />}
      <Err e={err} /><Done m={msg} />
      {adding ? <ContactForm onCancel={() => setAdding(false)} onSaved={(c) => { setAdding(false); setMsg(`${c.name} saved.`); void reload(); }} />
        : <button type="button" onClick={() => setAdding(true)} className={`${btnSecondary} mt-3`}><Plus className="size-5" aria-hidden />Add a contact</button>}
      <p className="mt-3 text-sm text-ink-soft">If a message says it’s from someone here, call the number you saved, not one from the message.</p>
    </>
  );
}

function RecordsCard({ b, act }: { b: BlockOf<'companion_records'>; act: BlockActions }) {
  if (!elderOnly(act)) return null;
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="companion_records" data-section={b.section}>
      {b.section === 'payments' ? <PaymentsManager act={act} /> : b.section === 'subscriptions' ? <SubscriptionsManager act={act} /> : <ContactsManager />}
      <PrivateNote />
    </div>
  );
}

function SignInCard({ b, act }: { b: BlockOf<'companion_sign_in'>; act: BlockActions }) {
  if (!elderOnly(act)) return null;
  return <div className={`${cardCls} p-4`} data-card="companion_sign_in"><p className="font-bold">{b.message}</p></div>;
}


// =====================================================================================================
// "Try as Mary": subscriptions list, send money, welcome, training examples, error with Retry
// =====================================================================================================
const per = (f: SubscriptionT['frequency']) => (f === 'weekly' ? 'week' : f === 'monthly' ? 'month' : 'year');

/** "Show my subscriptions" / "Which costs the most?" / "What's coming out next?" — re-read from the server on mount. */
function SubscriptionsListCard({ b, act }: { b: BlockOf<'subscriptions_list'>; act: BlockActions }) {
  const [subs, setSubs] = useState<SubscriptionT[]>(b.subscriptions);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(b.focus === 'most' ? b.highlight.mostMonthlyId : b.focus === 'next' ? b.highlight.nextId : null);
  const reload = async () => {
    try { setSubs(parseServer(ServerSubsList, await api('/api/companion/subscriptions')).subscriptions); setErr(null); } catch (e) { setErr(errMsg(e)); }
  };
  useEffect(() => { void reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!elderOnly(act)) return null;
  const tag = (id: string) => [id === b.highlight.mostMonthlyId && 'Costs the most each month', id === b.highlight.largestChargeId && id !== b.highlight.mostMonthlyId && 'Largest single charge', id === b.highlight.nextId && 'Comes out next'].filter(Boolean) as string[];
  const title = b.focus === 'most' ? 'Which costs the most' : b.focus === 'next' ? 'What’s coming out next' : 'Your subscriptions';
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="subscriptions_list" data-focus={b.focus}>
      <Head icon={Repeat} right={subs.some((x) => x.sample) ? <SampleBadge /> : <Pill label="Prototype" tone="muted" />}>{title}</Head>
      <Totals summary={b.summary} />
      {subs.length === 0 ? <p className="mt-3">No subscriptions yet. You can add one yourself.</p> : (
        <ul className="mt-2" aria-label="Your subscriptions">
          {subs.map((s) => <SubscriptionRow key={s.id} s={s} tags={tag(s.id)} act={act} reload={reload} selected={sel === s.id} onSelect={() => setSel(sel === s.id ? null : s.id)} />)}
        </ul>
      )}
      <Err e={err} />
      <p className="mt-2 text-base text-ink-soft">Tap one, then “Help me cancel”. For other companies SaySafe shows their official page: it can’t cancel for you.</p>
      <Link to={b.focus === 'next' ? '/insights#upcoming' : '/insights#subscriptions'} className={linkCls} data-testid="view-full-insights">View full insights</Link>
      {b.demoOffer && !subs.some(isDemo) && (
        <div className="mt-3 rounded-2xl border-2 border-teal/40 p-3">
          <p className="font-bold">Real PayPal Sandbox subscription you can start and cancel here</p>
          <p className="text-base text-ink-soft">{DEMO_MEMBERSHIP.name}: {money(DEMO_MEMBERSHIP.amountCents, DEMO_MEMBERSHIP.currency)} a month to {DEMO_MEMBERSHIP.merchant}. Sandbox, no real money.</p>
          <button type="button" onClick={() => act.append?.('The SaySafe Demo Membership is a real PayPal Sandbox subscription. You approve it at PayPal, and SaySafe can cancel it for you after you tap to confirm.', [{ kind: 'demo_membership', returned: null }])} className={`${btnSecondary} mt-2`}>Try the Demo Membership</button>
        </div>
      )}
      <PrivateNote />
    </div>
  );
}

/**
 * "Send Alex €50": 1) choose the saved contact, 2) review amount + recipient and confirm, 3) hand over to PayPal's own
 * Send money page. SaySafe never sends money and never says it was sent.
 */
function SendMoneyCard({ b, act }: { b: BlockOf<'send_money'>; act: BlockActions }) {
  const cur = useRef(b); cur.current = b;
  const id = useId();
  const [amount, setAmount] = useState(b.amountCents ? (b.amountCents / 100).toFixed(2) : '');
  const [err, setErr] = useState<string | null>(null);
  if (!elderOnly(act)) return null;
  const chosen = b.contacts.find((c) => c.id === b.selectedId) ?? null;
  const set = (patch: Partial<BlockOf<'send_money'>>) => act.replace(cur.current, { ...cur.current, ...patch });
  const review = () => {
    const cents = parseAmount(amount);
    if (!cents) return setErr('Please enter the amount, for example 50.');
    setErr(null); set({ amountCents: cents, phase: 'handoff' });
    act.speak?.('SaySafe can’t send money. Open PayPal and send it yourself. Nothing has been sent.');
  };
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="send_money" data-phase={b.phase}>
      <Head icon={Wallet} right={<Pill label="Nothing is sent by SaySafe" tone="pending" />}>Send money to someone you know</Head>
      {b.phase === 'choose' && (
        b.contacts.length === 0 ? <p className="mt-2 font-bold">No saved contact matches{b.query ? ` “${b.query}”` : ''}. Nothing was prepared.</p> : (
          <>
            <p className="mt-2 font-bold">Step 1 of 3 · Who is it?</p>
            <ul className="mt-1 divide-y divide-line" aria-label="Matching contacts">
              {b.contacts.map((c) => (
                <li key={c.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0"><span className="font-bold break-words">{c.name}</span>{c.relation && <span className="text-ink-soft"> · your {c.relation}</span>}{c.sample && <span className="ml-2"><SampleBadge /></span>}</span>
                  <button type="button" onClick={() => set({ selectedId: c.id, phase: 'review' })} className={btnSecondary}>Choose<span className="sr-only"> {c.name}</span></button>
                </li>
              ))}
            </ul>
          </>
        )
      )}
      {b.phase === 'review' && chosen && (
        <div className="mt-2">
          <p className="font-bold">Step 2 of 3 · Check the details</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-soft">To</dt><dd className="font-bold break-words">{chosen.name}{chosen.relation ? ` (your ${chosen.relation})` : ''}</dd>
            <dt className="text-ink-soft">Currency</dt><dd className="font-bold">{b.currency}</dd>
          </dl>
          <label htmlFor={`${id}-a`} className="mt-2 block font-bold">Amount (€)</label>
          <input id={`${id}-a`} className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" maxLength={12} placeholder="50.00" />
          <Err e={err} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={review} className={btnPrimary}>Yes, these details are right</button>
            <button type="button" onClick={() => set({ phase: 'choose', selectedId: null })} className={btnSecondary}>Choose someone else</button>
            <button type="button" onClick={() => set({ phase: 'cancelled' })} className={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}
      {b.phase === 'handoff' && chosen && (
        <div className="mt-2" role="status">
          <p className="font-bold">Step 3 of 3 · Send it yourself in PayPal</p>
          <p className="mt-1 text-lg"><span className="font-bold">{b.amountCents ? money(b.amountCents, b.currency) : ''}</span> to <span className="font-bold">{chosen.name}</span> — not sent yet.</p>
          <p className="mt-2 break-words">SaySafe’s PayPal connection is a shop (merchant) account. It can take payment for Demo Shop items you approve, but it can’t take money from your PayPal wallet and give it to a person, so it doesn’t try.</p>
          <a href={b.paypalSendUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex w-full items-center justify-between gap-3 rounded-2xl bg-teal text-white font-bold px-5 min-h-14 hover:bg-teal-deep" data-testid="paypal-send-link">
            <span>Open PayPal Send money</span><ExternalLink className="size-5 shrink-0" aria-hidden /><span className="sr-only"> (opens paypal.com in a new tab)</span>
          </a>
          <p className="mt-1 text-sm text-ink-soft break-words" data-testid="send-footnote"><span className="break-all">{new URL(b.paypalSendUrl).hostname}</span> · sign in to PayPal yourself, then choose {chosen.name} by the email or number you know is theirs. SaySafe hasn’t checked that this is the right person or amount, and nothing has been sent.</p>
          <p className="mt-2 rounded-2xl border-2 border-amber bg-amber-soft p-3 font-bold" data-testid="nothing-sent">Nothing is sent by SaySafe.</p>
          {chosen.sample && <p className="mt-2 text-sm text-ink-soft">This is a sample contact with a fictional email, so don’t use it in PayPal.</p>}
        </div>
      )}
      {b.phase === 'cancelled' && <p className="mt-2 font-bold" role="status">Okay. Nothing was prepared and nothing was sent.</p>}
      <p className="mt-3 text-sm text-ink-soft">{b.notice}</p>
      <PrivateNote />
    </div>
  );
}

function DemoWelcomeCard({ b, act }: { b: BlockOf<'demo_welcome'>; act: BlockActions }) {
  if (!elderOnly(act)) return null;
  return (
    <div className={`${cardCls} p-4 sm:p-5 border-2 border-teal/50`} data-card="demo_welcome">
      <Head icon={Info} right={<SampleBadge />}>Welcome to the Mary demo</Head>
      <p className="mt-2">You’re Mary. Her account has <span className="font-bold">sample payments, subscriptions, contacts and family reviews</span> so you can try everything. Sample items are labelled “Sample data” and can’t be paid or refunded. Payments you make in the Demo Shop are real PayPal Sandbox transactions (no real money).</p>
      <p className="mt-3 font-bold">Tap one to try it:</p>
      <div className="mt-2 grid gap-2 min-[480px]:grid-cols-2" role="group" aria-label="Example questions">
        {b.prompts.map((p) => <button key={p} type="button" onClick={() => act.send?.(p)} className="min-h-12 px-4 rounded-2xl border-2 border-teal text-teal-deep bg-paper font-bold text-left hover:bg-teal-soft">{p}</button>)}
      </div>
      <p className="mt-3 text-sm text-ink-soft">You can also try “Did I already pay John €80?”, “Which costs the most?”, “Cancel my streaming subscription” or “Send Alex €50”. Reset the sample data any time in Profile.</p>
    </div>
  );
}

function TrainingExamplesCard({ b, act }: { b: BlockOf<'training_examples'>; act: BlockActions }) {
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="training_examples">
      <Head icon={ShieldCheck} right={<Pill label="Training examples" tone="muted" />}>Try a scam check</Head>
      <p className="mt-2 text-base text-ink-soft">Fictional messages for practice. Tap one to check it, or paste your own.</p>
      <ul className="mt-2 space-y-2">
        {b.items.map((it) => (
          <li key={it.id} className="rounded-2xl border border-line p-3">
            <p className="font-bold">{it.label}</p>
            <p className="mt-1 text-base break-words italic">“{it.text}”</p>
            <p className="mt-1 text-sm text-ink-soft">{it.howToTest}</p>
            <button type="button" onClick={() => act.scan?.(it.text)} className={`${btnSecondary} mt-2`}>Check this training example</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RetryErrorCard({ b, act }: { b: BlockOf<'retry_error'>; act: BlockActions }) {
  const cur = useRef(b); cur.current = b;
  return (
    <div className={`${cardCls} p-4 border-2 border-danger`} data-card="retry_error" role="alert">
      <p className="font-bold flex items-center gap-2"><AlertTriangle className="size-6 text-danger shrink-0" aria-hidden />That didn’t work, so I can’t say what your records show.</p>
      <p className="mt-1 break-words">{b.message}</p>
      <p className="mt-1 text-sm text-ink-soft">This is an error, not “no records”. Nothing was paid or changed.</p>
      {!b.done && <button type="button" onClick={() => { act.replace(cur.current, { ...cur.current, done: true }); act.send?.(b.retryText); }} className={`${btnSecondary} mt-2`}><RotateCcw className="size-5" aria-hidden />Retry</button>}
    </div>
  );
}

// ---------- Insights summary (concise; the full page is /insights) ----------
const FOCUS_TITLE: Record<string, string> = { overview: 'Your insights', spending: 'Your spending, by kind of record', pending: 'Waiting for approval', duplicates: 'Possible repeat payments', safety: 'Your safety insights', subscriptions: 'Subscriptions', upcoming: 'Coming out next' };
const KindTag = ({ k }: { k: 'sandbox' | 'sample' | 'user_entered' }) => k === 'sample' ? <SampleBadge /> : <span className={`inline-flex items-center rounded-xl border px-2 py-0.5 text-sm font-bold ${k === 'sandbox' ? TONE_CLS.ok : TONE_CLS.muted}`}>{k === 'sandbox' ? 'Real PayPal Sandbox' : 'Recorded by you'}</span>;
export function InsightLines({ d, focus }: { d: InsightsSummaryT; focus: string }) {
  const sb = d.payments.sandbox;
  const line = (label: ReactNode, value: ReactNode, key: string) => <li key={key} className="py-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><span className="min-w-0">{label}</span><span className="font-bold text-right">{value}</span></li>;
  const rows: ReactNode[] = [];
  if (focus === 'overview' || focus === 'spending') {
    rows.push(line(<>Paid with PayPal Sandbox <KindTag k="sandbox" /></>, sb.captured.count ? `${fmtMoneyList(sb.captured.totals)} · ${sb.captured.count}` : 'None yet', 'sb'));
    if (d.records) rows.push(line(<>Payments you recorded <KindTag k="user_entered" /></>, d.records.userEntered.count ? `${fmtMoneyList(d.records.userEntered.totals)} · ${d.records.userEntered.count}` : 'None', 'rec'));
    if (d.records?.sample.count || d.payments.sample.count) rows.push(line(<>Sample records and purchases <KindTag k="sample" /></>, `${d.records?.sample.count ?? 0} records · ${d.payments.sample.count} purchases`, 'smp'));
  }
  if (focus === 'overview' || focus === 'pending') rows.push(line('Waiting for your family member', d.pendingReviews.real.length ? d.pendingReviews.real.map((x) => `${x.item} · ${money(x.amountCents, x.currency)}`).join('; ') : 'Nothing', 'pend'));
  if (focus === 'pending' && d.pendingReviews.sampleWaiting) rows.push(line(<>Sample request <KindTag k="sample" /></>, 'Illustrative, can’t be approved', 'pends'));
  if ((focus === 'overview' || focus === 'duplicates') && d.duplicates) {
    if (!d.duplicates.length) rows.push(line('Possible repeat payments', 'None found', 'dup0'));
    d.duplicates.slice(0, focus === 'duplicates' ? 5 : 1).forEach((x, i) => rows.push(line(<>{x.recipient} {x.sample && <SampleBadge />}</>, `${money(x.amountCents, x.currency)} twice, ${x.daysApart} day${x.daysApart === 1 ? '' : 's'} apart`, `dup${i}`)));
  }
  if ((focus === 'overview' || focus === 'subscriptions') && d.subscriptions) {
    const s = d.subscriptions;
    if (s.userEntered.count) rows.push(line(<>Your subscriptions <KindTag k="user_entered" /></>, `${fmtMoneyList(s.userEntered.monthly)} a month · ${fmtMoneyList(s.userEntered.annual)} a year`, 'subu'));
    if (s.sample.count) rows.push(line(<>Sample subscriptions <KindTag k="sample" /></>, `${fmtMoneyList(s.sample.monthly)} a month · ${fmtMoneyList(s.sample.annual)} a year`, 'subs'));
    if (s.sandbox.count) rows.push(line(<>Demo Membership <KindTag k="sandbox" /></>, `${fmtMoneyList(s.sandbox.monthly)} a month`, 'subp'));
  }
  if ((focus === 'overview' || focus === 'upcoming') && d.subscriptions?.upcoming.length) {
    const u = d.subscriptions.upcoming[0];
    rows.push(line(<>Next expected charge {u.kind === 'sample' && <SampleBadge />}</>, `${u.merchant} · ${money(u.amountCents, u.currency)} · ${u.inDays === 0 ? 'today' : u.inDays === 1 ? 'tomorrow' : `in ${u.inDays} days`}`, 'up'));
  }
  if (focus === 'overview' || focus === 'safety') {
    const r = d.scamChecks.real;
    rows.push(line('Messages you checked', r.total ? `${r.total} · ${r.suspicious} suspicious` : 'None yet', 'scan'));
    if (d.scamChecks.training) rows.push(line(<>Training examples <KindTag k="sample" /></>, `${d.scamChecks.training} · not counted`, 'train'));
  }
  return <ul className="mt-2 divide-y divide-line text-base">{rows}</ul>;
}
function InsightsSummaryCard({ b, act }: { b: BlockOf<'insights_summary'>; act: BlockActions }) {
  const cur = useRef(b); cur.current = b;
  // Shown again after a reload: re-read so the numbers are current, never a stale copy.
  useEffect(() => {
    api('/api/insights/summary').then((raw) => { const r = InsightsSummarySchema.safeParse(raw); if (r.success) act.replace(cur.current, { ...cur.current, summary: r.data }); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!elderOnly(act)) return null;
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="insights_summary" data-focus={b.focus}>
      <Head icon={BarChart3}>{FOCUS_TITLE[b.focus] ?? 'Your insights'}</Head>
      <InsightLines d={b.summary} focus={b.focus} />
      <p className="mt-2 text-sm text-ink-soft">Each kind of record is shown on its own and never added together. Sample data is illustrative.</p>
      <Link to={`/insights${b.focus !== 'overview' ? `#${b.focus}` : ''}`} className={`${linkCls} mt-1`} data-testid="view-full-insights">View full insights</Link>
      <p className="mt-2 text-sm text-ink-soft flex items-start gap-1.5"><ShieldCheck className="size-4 mt-0.5 shrink-0 text-teal" aria-hidden />Your records and subscriptions are private to you. Your family member sees only Demo Shop purchases, reviews and checks you share.</p>
    </div>
  );
}

/** Registry entries for the companion kinds (merged into REGISTRY in blocks.tsx). */
export const COMPANION_REGISTRY = {
  payment_matches: ({ b, act }: { b: BlockOf<'payment_matches'>; act: BlockActions }) => <PaymentMatchesCard b={b} act={act} />,
  last_payment: ({ b, act }: { b: BlockOf<'last_payment'>; act: BlockActions }) => <LastPaymentCard b={b} act={act} />,
  monthly_costs: ({ b, act }: { b: BlockOf<'monthly_costs'>; act: BlockActions }) => <MonthlyCostsCard b={b} act={act} />,
  subscription_help: ({ b, act }: { b: BlockOf<'subscription_help'>; act: BlockActions }) => <SubscriptionHelpCard b={b} act={act} />,
  demo_cancel_intent: ({ b, act }: { b: BlockOf<'demo_cancel_intent'>; act: BlockActions }) => <DemoCancelCard b={b} act={act} />,
  contact_card: ({ b, act }: { b: BlockOf<'contact_card'>; act: BlockActions }) => <ContactLookupCard b={b} act={act} />,
  companion_sign_in: ({ b, act }: { b: BlockOf<'companion_sign_in'>; act: BlockActions }) => <SignInCard b={b} act={act} />,
  companion_records: ({ b, act }: { b: BlockOf<'companion_records'>; act: BlockActions }) => <RecordsCard b={b} act={act} />,
  demo_membership: ({ b, act }: { b: BlockOf<'demo_membership'>; act: BlockActions }) => <DemoMembershipCard b={b} act={act} />,
  subscriptions_list: ({ b, act }: { b: BlockOf<'subscriptions_list'>; act: BlockActions }) => <SubscriptionsListCard b={b} act={act} />,
  send_money: ({ b, act }: { b: BlockOf<'send_money'>; act: BlockActions }) => <SendMoneyCard b={b} act={act} />,
  demo_welcome: ({ b, act }: { b: BlockOf<'demo_welcome'>; act: BlockActions }) => <DemoWelcomeCard b={b} act={act} />,
  training_examples: ({ b, act }: { b: BlockOf<'training_examples'>; act: BlockActions }) => <TrainingExamplesCard b={b} act={act} />,
  retry_error: ({ b, act }: { b: BlockOf<'retry_error'>; act: BlockActions }) => <RetryErrorCard b={b} act={act} />,
  insights_summary: ({ b, act }: { b: BlockOf<'insights_summary'>; act: BlockActions }) => <InsightsSummaryCard b={b} act={act} />,
};
export type CompanionBlock = Extract<Block, { kind: keyof typeof COMPANION_REGISTRY }>;
