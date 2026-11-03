/** My Activity: every payment (with family decisions) and scam check for this household, searchable and filterable. */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, ChevronRight, ShieldAlert, Receipt, SlidersHorizontal, Users, BadgeCheck } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Card, Notice } from '../components/ui';
import { useShellRole } from '../lib/role';
import { fetchActivity, verdictLabel, money, when, shortStatus, TONE_CLS, type Tone, type ActivityItem, type ActivityFilters } from '../lib/activity';

const CHIPS: { id: string; label: string; filter: Partial<ActivityFilters> }[] = [
  { id: 'all', label: 'All', filter: {} },
  { id: 'pending', label: 'Waiting', filter: { status: 'pending' } },
  { id: 'purchases', label: 'Purchases & payments', filter: { section: 'purchases' } },
  { id: 'scans', label: 'Scam checks', filter: { section: 'scans' } },
  { id: 'family', label: 'Family reviews', filter: { section: 'family' } },
  { id: 'refunds', label: 'Refunds', filter: { section: 'refunds' } },
];
/** Sections, in this order, when everything is shown. Each item belongs to exactly one (the server decides). */
const SECTIONS: { id: NonNullable<ActivityItem['section']>; label: string }[] = [
  { id: 'purchases', label: 'Purchases & payments' }, { id: 'family', label: 'Family reviews' }, { id: 'refunds', label: 'Refunds' }, { id: 'scans', label: 'Scam checks' },
];

function Row({ it, family }: { it: ActivityItem; family: boolean }) {
  const nav = useNavigate();
  const st = it.type === 'scan' ? { label: verdictLabel(it.status), tone: (it.status === 'suspicious' ? 'danger' : 'muted') as Tone } : it.type === 'record' ? { label: 'Payment record', tone: 'muted' as Tone } : shortStatus(it.status, { webhookConfirmed: it.webhookConfirmed, approval: it.approval?.status });
  const Icon = it.type === 'scan' ? ShieldAlert : Receipt;
  const body = (
    <>
      <Icon className={`size-7 shrink-0 mt-0.5 ${it.type === 'scan' ? (it.status === 'suspicious' ? 'text-danger' : 'text-amber') : 'text-teal'}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-bold break-words">{it.type === 'scan' ? 'Scam check: ' : ''}{it.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
          {it.amountCents !== null && <span className="font-bold">{money(it.amountCents, it.currency)}</span>}
          <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-sm font-bold ${TONE_CLS[st.tone]}`}>{st.label}</span>
          {'extra' in st && st.extra && !it.example && <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-sm font-bold ${TONE_CLS[it.webhookConfirmed ? 'ok' : 'pending']}`}>{st.extra}</span>}
          <span className="text-ink-soft">{when(it.at)}</span>
        </span>
        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-ink-soft">
          {'detail' in st && st.detail && <span className="font-bold text-navy">{st.detail}</span>}
          {it.example && <span className="inline-flex rounded-full bg-amber-soft text-amber border border-amber/30 px-2 font-bold" data-testid="sample-badge">Sample data</span>}
          {!it.example && it.sourceLabel && it.type !== 'scan' && <span className="font-bold text-navy">{it.sourceLabel}</span>}
          {it.evidence && <span>Evidence: {it.evidence}</span>}
          {it.sandbox && !it.example && <span>PayPal Sandbox · no real money</span>}
          {it.captured && <span className="inline-flex items-center gap-1"><BadgeCheck className="size-4 text-teal" aria-hidden />Captured at PayPal</span>}
          {it.approval && it.approval.status !== 'pending' && <span className="inline-flex items-center gap-1"><Users className="size-4" aria-hidden />Family {it.approval.status}</span>}
          {it.approval?.status === 'pending' && <span className="inline-flex items-center gap-1"><Users className="size-4" aria-hidden />Waiting for family</span>}
          {it.type === 'scan' && !family && it.sharedWithFamily && <span>Shared with family</span>}
        </span>
      </span>
      {it.href && !family && <ChevronRight className="size-6 text-teal shrink-0 self-center" aria-hidden />}
    </>
  );
  // The receipt page is the elder's; family members see the list (their decisions happen on the Family page).
  return it.href && !family
    ? <button type="button" onClick={() => nav(it.href!)} className="w-full flex items-start gap-3 p-4 text-left min-h-16 hover:bg-teal-soft rounded-2xl">{body}<span className="sr-only">Open details</span></button>
    : <div className="flex items-start gap-3 p-4">{body}</div>;
}

export default function Activity() {
  const { role, loading } = useShellRole();
  const nav = useNavigate();
  const family = role === 'family';
  const [chip, setChip] = useState('all');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [more, setMore] = useState(false);
  const [min, setMin] = useState(''); const [max, setMax] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [allCount, setAllCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef<HTMLParagraphElement>(null);

  useEffect(() => { if (!loading && !role) nav('/', { replace: true }); }, [loading, role, nav]);

  const filters = (p: number): ActivityFilters => ({ ...CHIPS.find((c) => c.id === chip)!.filter, q: applied || undefined, min: min || undefined, max: max || undefined, from: from || undefined, to: to || undefined, page: p, limit: 20, as: family ? 'family' : undefined });
  const run = (p: number) => {
    setBusy(true); setErr(null);
    fetchActivity(filters(p)).then((r) => { setItems((prev) => (p === 1 ? r.items : [...prev, ...r.items])); setPage(p); setHasMore(r.hasMore); setTotal(r.total); setAllCount(r.counts.all); })
      .catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => { if (role) run(1); }, [role, chip, applied, min, max, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || !role) return <Layout><p>Loading…</p></Layout>;
  const filtered = chip !== 'all' || applied || min || max || from || to;
  const clear = () => { setChip('all'); setQ(''); setApplied(''); setMin(''); setMax(''); setFrom(''); setTo(''); };
  const inputCls = 'mt-1 w-full min-h-12 rounded-2xl border-2 border-line bg-paper px-4 focus:border-teal outline-none';
  return (
    <Layout mode={family ? 'family' : 'elder'}>
      <h1 className="text-[length:var(--text-title)] md:text-[length:var(--text-hero)]">Activity</h1>
      <p className="mt-1 text-ink-soft">{family ? 'Purchases in the household you help with, and the scam checks they shared with you.' : 'Your purchases, payment records and scam checks. Tap a purchase to see its receipt and PayPal timeline.'}</p>
      <p className="mt-1 text-base text-ink-soft">Labels: <span className="font-bold text-amber">Sample data</span> = illustrative, no PayPal record · <span className="font-bold text-navy">Real PayPal Sandbox transaction</span> = made in this app (no real money){family ? '' : ' · Recorded by you = only what you typed'}.</p>

      <form role="search" className="mt-5 flex gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); }}>
        <label htmlFor="act-q" className="sr-only">Search activity</label>
        <input id="act-q" type="search" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setApplied(''); }} placeholder="Search, e.g. kettle" className="flex-1 min-w-0 min-h-12 rounded-full border-2 border-line bg-paper px-5 focus:border-teal outline-none" />
        <button type="submit" className="min-h-12 min-w-12 px-4 rounded-full bg-teal text-white font-bold inline-flex items-center gap-2"><Search className="size-5" aria-hidden /><span className="max-[399px]:sr-only">Search</span></button>
      </form>

      {/* Chips wrap onto more lines: nothing is ever cut off or hidden in a scroller. */}
      <div role="group" aria-label="Show" className="mt-3 flex flex-wrap gap-2">
        {CHIPS.map((c) => (
          <button key={c.id} type="button" aria-pressed={chip === c.id} onClick={() => setChip(c.id)}
            className={`min-h-12 px-4 rounded-full border-2 font-bold text-base leading-tight text-left ${chip === c.id ? 'bg-navy text-white border-navy' : 'bg-paper border-line hover:border-teal'}`}>{c.label}</button>
        ))}
      </div>
      <button type="button" aria-expanded={more} aria-controls="more-filters" onClick={() => setMore(!more)} className="mt-2 inline-flex items-center gap-2 min-h-12 font-bold text-teal underline underline-offset-4"><SlidersHorizontal className="size-5" aria-hidden />{more ? 'Hide amount and date' : 'Amount and date'}</button>
      {more && (
        <fieldset id="more-filters" className="mt-2 grid grid-cols-2 gap-3 max-w-xl">
          <legend className="sr-only">Amount and date filters</legend>
          <label className="font-bold">From €<input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value.replace(/[^0-9.]/g, ''))} className={inputCls} /></label>
          <label className="font-bold">To €<input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value.replace(/[^0-9.]/g, ''))} className={inputCls} /></label>
          <label className="font-bold">From date<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} /></label>
          <label className="font-bold">To date<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} /></label>
        </fieldset>
      )}

      <p ref={live} role="status" className="mt-4 text-base text-ink-soft">{busy && page === 1 ? 'Loading…' : `${total} ${total === 1 ? 'item' : 'items'}${filtered ? ' match' : ''}`}{filtered && <> · <button type="button" onClick={clear} className="font-bold text-teal underline underline-offset-4 min-h-11">Clear filters</button></>}</p>
      {err && <div className="mt-3" role="alert"><Notice tone="danger" title={`Couldn’t load your activity: ${err}`} /><p className="mt-1 text-base text-ink-soft">This is an error, not an empty history.</p><button type="button" onClick={() => run(1)} className="mt-2 min-h-12 px-5 rounded-full border-2 border-line bg-paper font-bold hover:border-teal">Retry</button></div>}

      {!busy && items.length === 0 && !err && (
        <Card className="mt-3 p-6">
          {allCount === 0 && !filtered ? (
            <>
              <p className="font-bold text-lg">Nothing here yet</p>
              <p className="mt-1 text-ink-soft">{family ? 'Purchases and shared scam checks will appear here.' : 'When you check a message or buy something, it shows up here.'}</p>
              {!family && <p className="mt-3"><Link to="/assistant" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">Open the Assistant</Link></p>}
            </>
          ) : (
            <><p className="font-bold text-lg">Nothing matches</p><p className="mt-1 text-ink-soft">Try another word, or clear the filters.</p></>
          )}
        </Card>
      )}
      {items.length > 0 && chip === 'all' && SECTIONS.map((sec) => {
        const list = items.filter((it) => (it.section ?? (it.type === 'scan' ? 'scans' : 'purchases')) === sec.id);
        if (!list.length) return null;
        return (
          <section key={sec.id} aria-labelledby={`sec-${sec.id}`} className="mt-5">
            <h2 id={`sec-${sec.id}`} className="text-xl">{sec.label} <span className="text-ink-soft font-sans text-base font-normal">({list.length})</span></h2>
            <Card className="mt-2 p-1 sm:p-2"><ul className="divide-y divide-line">{list.map((it) => <li key={`${it.type}-${it.id}`}><Row it={it} family={family} /></li>)}</ul></Card>
          </section>
        );
      })}
      {items.length > 0 && chip !== 'all' && (
        <Card className="mt-3 p-1 sm:p-2">
          <ul className="divide-y divide-line">{items.map((it) => <li key={`${it.type}-${it.id}`}><Row it={it} family={family} /></li>)}</ul>
        </Card>
      )}
      {hasMore && <button type="button" onClick={() => run(page + 1)} disabled={busy} className="mt-4 w-full min-h-14 rounded-full border-2 border-line bg-paper font-bold hover:border-teal disabled:opacity-50">{busy ? 'Loading…' : 'Show more'}</button>}
    </Layout>
  );
}
