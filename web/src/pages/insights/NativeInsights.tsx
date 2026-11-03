/**
 * Native SaySafe "Family Safety Insights" dashboard — the default at /family/insights.
 * Deliberately has NO dependency on ag-studio / ag-grid / ag-charts (not even a lazy import).
 * Chart is inline SVG with a data-table alternative.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, ShieldAlert, Clock, CheckCircle2, XCircle, Wallet, BadgeCheck, Sparkles, LayoutDashboard } from 'lucide-react';
import { Layout } from '../../components/Layout';
import { Button, Card, Notice, PageTitle } from '../../components/ui';
import { askInsights, useConfig, useInsights } from '../../lib/insightsApi';
import { studioAllowed } from '../../lib/insightsChoice';
import { activityByDay, EVENT_KIND_LABELS, money, type InsightPayment, type InsightsPayload } from '../../../../shared/insights';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function SourceBadge({ source }: { source: InsightPayment['source'] }) {
  return source === 'sandbox'
    ? <span className="inline-block rounded-full bg-teal-soft text-teal-deep border border-teal/30 px-2 py-0.5 text-sm font-bold whitespace-nowrap">PayPal sandbox</span>
    : <span className="inline-block rounded-full bg-amber-soft text-amber border border-amber/30 px-2 py-0.5 text-sm font-bold whitespace-nowrap">Example data</span>;
}

function Kpi({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note?: string }) {
  return (
    <Card as="div" className="p-4 sm:p-5">
      <p className="flex items-center gap-2 text-base font-bold text-ink-soft">{icon}{label}</p>
      <p className="mt-1 font-display text-3xl sm:text-4xl font-semibold">{value}</p>
      {note && <p className="mt-1 text-sm text-ink-soft">{note}</p>}
    </Card>
  );
}

const SERIES = [
  { key: 'scam_check', color: '#9e1d2c' },
  { key: 'family_decision', color: '#8f4d0c' },
  { key: 'payment', color: '#3d4f61' },
  { key: 'paypal', color: '#066a5f' },
] as const;

function ActivityChart({ d }: { d: InsightsPayload }) {
  const rows = useMemo(() => activityByDay(d.events, 14), [d.events]);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const W = 700, H = 220, pad = 28, bw = (W - pad * 2) / rows.length;
  const total = rows.reduce((s, r) => s + r.total, 0);
  return (
    <Card className="p-5">
      <h2 className="text-2xl">Activity over the last 14 days</h2>
      {total === 0 ? <p className="mt-3 text-ink-soft">No activity in the last 14 days. Purchases, family decisions, PayPal confirmations and shared scam checks will appear here.</p> : (
        <>
          <svg viewBox={`0 0 ${W} ${H + 24}`} className="mt-4 w-full h-auto" role="img" aria-label={`Activity chart: ${total} events in the last 14 days. The table below has the same numbers.`}>
            <line x1={pad} x2={W - pad} y1={H} y2={H} stroke="#dfe5df" />
            {rows.map((r, i) => {
              let y = H;
              return (
                <g key={r.day}>
                  {SERIES.map((s) => {
                    const h = (r[s.key] / max) * (H - 20);
                    y -= h;
                    return h > 0 ? <rect key={s.key} x={pad + i * bw + 4} y={y} width={bw - 8} height={h} fill={s.color} rx={2} /> : null;
                  })}
                  {i % 2 === 0 && <text x={pad + i * bw + bw / 2} y={H + 18} textAnchor="middle" fontSize="12" fill="#3d4f61">{r.day.slice(5)}</text>}
                </g>
              );
            })}
          </svg>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-base" aria-label="Legend">
            {SERIES.map((s) => <li key={s.key} className="flex items-center gap-2"><span className="inline-block size-3 rounded-sm" style={{ background: s.color }} aria-hidden />{EVENT_KIND_LABELS[s.key]}</li>)}
          </ul>
          <details className="mt-3">
            <summary className="cursor-pointer font-bold text-teal min-h-12 inline-flex items-center">Show chart as a table</summary>
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-base">
                <caption className="sr-only">Activity per day</caption>
                <thead><tr className="text-left"><th scope="col" className="p-2">Day</th>{SERIES.map((s) => <th key={s.key} scope="col" className="p-2">{EVENT_KIND_LABELS[s.key]}</th>)}<th scope="col" className="p-2">Total</th></tr></thead>
                <tbody>{rows.filter((r) => r.total).map((r) => <tr key={r.day} className="border-t border-line"><th scope="row" className="p-2 text-left font-normal">{r.day}</th>{SERIES.map((s) => <td key={s.key} className="p-2">{r[s.key]}</td>)}<td className="p-2 font-bold">{r.total}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Card>
  );
}

type SortKey = 'createdAt' | 'product' | 'amount' | 'stateLabel' | 'source';
const COLS: { key: SortKey; label: string }[] = [
  { key: 'createdAt', label: 'Date' }, { key: 'product', label: 'Purchase' }, { key: 'amount', label: 'Amount' }, { key: 'stateLabel', label: 'Status' }, { key: 'source', label: 'Source' },
];

function Ledger({ d }: { d: InsightsPayload }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  const states = useMemo(() => [...new Set(d.payments.map((p) => p.stateLabel))].sort(), [d.payments]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = d.payments.filter((p) => (state === 'all' || p.stateLabel === state) && (!s || `${p.product} ${p.merchant} ${p.stateLabel} ${p.source}`.toLowerCase().includes(s)));
    const m = sort.dir === 'asc' ? 1 : -1;
    return out.sort((a, b) => (a[sort.key] < b[sort.key] ? -m : a[sort.key] > b[sort.key] ? m : 0));
  }, [d.payments, q, state, sort]);
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'createdAt' || key === 'amount' ? 'desc' : 'asc' }));
  return (
    <Card className="p-5" aria-labelledby="ledger-h">
      <h2 id="ledger-h" className="text-2xl">Payment ledger</h2>
      <div className="mt-3 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[12rem]"><label htmlFor="ledger-q" className="block font-bold mb-1 text-base">Search</label><input id="ledger-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Product, shop or status" className="w-full min-h-12 rounded-2xl border-2 border-line px-4 bg-paper focus:border-teal outline-none text-base" /></div>
        <div><label htmlFor="ledger-state" className="block font-bold mb-1 text-base">Status</label><select id="ledger-state" value={state} onChange={(e) => setState(e.target.value)} className="min-h-12 rounded-2xl border-2 border-line px-3 bg-paper text-base"><option value="all">All</option>{states.map((s) => <option key={s}>{s}</option>)}</select></div>
      </div>
      <p className="sr-only" aria-live="polite">{rows.length} of {d.payments.length} payments shown</p>
      {d.payments.length === 0 ? <p className="mt-4 text-ink-soft">No purchases yet. When {d.elder.name} starts a purchase it appears here with its PayPal status.</p> : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-base min-w-[640px]">
            <caption className="sr-only">Purchases for {d.elder.name}, sortable</caption>
            <thead>
              <tr className="text-left border-b-2 border-line">
                {COLS.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="p-2">
                    <button type="button" onClick={() => toggle(c.key)} className="inline-flex items-center gap-1 font-bold min-h-11">
                      {c.label}{sort.key === c.key ? (sort.dir === 'asc' ? <ArrowUp className="size-4" aria-hidden /> : <ArrowDown className="size-4" aria-hidden />) : <ArrowUpDown className="size-4 opacity-50" aria-hidden />}
                    </button>
                  </th>
                ))}
                <th scope="col" className="p-2">PayPal evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-line align-top">
                  <td className="p-2 whitespace-nowrap">{fmtDate(p.createdAt)}</td>
                  <td className="p-2"><span className="font-bold">{p.product}</span><br /><span className="text-ink-soft text-sm">{p.merchant}</span></td>
                  <td className="p-2 whitespace-nowrap">{money(p.amount, p.currency)}</td>
                  <td className="p-2">{p.stateLabel}{p.approvalStatus && p.approvalStatus !== 'pending' && <span className="block text-sm text-ink-soft">Family: {p.approvalStatus}</span>}{p.awaitingMyDecision && <Link to="/family#pending-h" className="inline-flex items-center min-h-11 text-sm font-bold text-teal underline underline-offset-4">Review on Family page</Link>}</td>
                  <td className="p-2"><SourceBadge source={p.source} /></td>
                  <td className="p-2 text-sm">{p.hasCapture ? <>Captured {p.capturedAmount != null ? money(p.capturedAmount, p.capturedCurrency ?? p.currency) : ''}<br />{p.webhookConfirmed ? `Webhook confirmed ${fmtDate(p.webhookConfirmedAt)}` : 'Webhook pending'}</> : p.hasPayPalOrder ? 'PayPal order created' : '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="p-4 text-ink-soft">No payments match your search.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AskBox() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState<{ q: string; text: string; ai: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const examples = ['Which purchases are waiting for my approval?', 'Show transactions that were declined', 'How much was paid through our demo checkout this week?', 'Show payments whose webhook confirmation is still pending'];
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true); setErr(null);
    try { const r = await askInsights(question.trim()); setA({ q: question.trim(), text: r.answer, ai: r.ai.used }); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(q); };
  return (
    <Card className="p-5" aria-labelledby="ask-h">
      <h2 id="ask-h" className="text-2xl flex items-center gap-2"><Sparkles className="size-6 text-teal" aria-hidden />Ask about this activity</h2>
      <p className="mt-1 text-base text-ink-soft">Read-only: it can explain what happened, but it can't approve, pay or change anything.</p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[12rem]"><label htmlFor="ask-q" className="block font-bold mb-1 text-base">Your question</label><input id="ask-q" value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} className="w-full min-h-12 rounded-2xl border-2 border-line px-4 bg-paper focus:border-teal outline-none text-base" /></div>
        <Button type="submit" busy={busy} className="!min-h-12">Ask</Button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">{examples.map((x) => <button key={x} type="button" onClick={() => { setQ(x); ask(x); }} className="rounded-full border-2 border-line px-4 py-1 text-base font-bold text-left hover:border-teal min-h-12">{x}</button>)}</div>
      <div aria-live="polite">
        {err && <div className="mt-3"><Notice tone="danger" title={err} /></div>}
        {a && <div className="mt-4 rounded-2xl bg-teal-soft p-4"><p className="font-bold">{a.q}</p><p className="mt-1 whitespace-pre-line">{a.text}</p><p className="mt-2 text-sm text-ink-soft">{a.ai ? 'Answered with AI from your household data only.' : 'Answered directly from your household data.'}</p></div>}
      </div>
    </Card>
  );
}

export function NativeInsightsBody({ d }: { d: InsightsPayload }) {
  const k = d.kpis;
  const pending = d.payments.filter((p) => p.awaitingMyDecision);
  return (
    <div className="space-y-6">
      <section aria-label="Key numbers" className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi icon={<Clock className="size-5 text-amber" aria-hidden />} label="Waiting for you" value={String(k.pendingApprovals)} />
        <Kpi icon={<CheckCircle2 className="size-5 text-teal" aria-hidden />} label="Approved" value={String(k.approved)} />
        <Kpi icon={<XCircle className="size-5 text-danger" aria-hidden />} label="Declined" value={String(k.declined)} />
        <Kpi icon={<Wallet className="size-5 text-teal" aria-hidden />} label="Sandbox captures" value={money(k.sandboxCaptured.total, k.sandboxCaptured.currency)} note={`${k.sandboxCaptured.count} paid in sandbox${k.seededCaptured.count ? ` · ${money(k.seededCaptured.total, k.seededCaptured.currency)} more in example data` : ''}`} />
        <Kpi icon={<BadgeCheck className="size-5 text-teal" aria-hidden />} label="Webhook confirmed" value={`${k.webhookConfirmed}`} note={`${k.webhookPending} pending`} />
        <Kpi icon={<ShieldAlert className="size-5 text-danger" aria-hidden />} label="Scam reviews" value={String(k.scamReviews)} note={`${k.suspiciousScans} suspicious`} />
      </section>
      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-6 items-start">
        <ActivityChart d={d} />
        <Card className="p-5" aria-labelledby="await-h">
          <h2 id="await-h" className="text-2xl flex items-center gap-2"><Clock className="size-6 text-amber" aria-hidden />Awaiting your decision</h2>
          {pending.length === 0 ? <p className="mt-2 text-ink-soft">Nothing to review right now.</p> : (
            <ul className="mt-3 space-y-3">{pending.map((p) => <li key={p.id} className="rounded-2xl border-2 border-amber p-3"><p className="font-bold">{p.product} · {money(p.amount, p.currency)}</p><p className="text-sm text-ink-soft">Expires {fmtDate(p.approvalExpiresAt)}</p></li>)}</ul>
          )}
          {pending.length > 0 && <Link to="/family#pending-h" className="mt-3 inline-flex items-center min-h-12 font-bold text-teal underline underline-offset-4">Approve or decline on the Family page</Link>}
          <h2 className="text-2xl mt-6 flex items-center gap-2"><ShieldAlert className="size-6 text-danger" aria-hidden />Scam reviews shared with you</h2>
          {d.scans.length === 0 ? <p className="mt-2 text-ink-soft">{d.elder.name} hasn't shared any scam checks yet.</p> : (
            <ul className="mt-3 space-y-2">{d.scans.slice(0, 8).map((s) => <li key={s.id} className={`rounded-2xl p-3 border-l-[6px] ${s.verdict === 'suspicious' ? 'bg-danger-soft border-danger' : 'bg-amber-soft border-amber'}`}><p className="font-bold text-base">{s.excerpt}</p><p className="text-sm text-ink-soft">{fmtDate(s.createdAt)}</p></li>)}</ul>
          )}
          <p className="mt-2 text-sm text-ink-soft">Only the result is shared, never the message itself.</p>
        </Card>
      </div>
      <Ledger d={d} />
      <AskBox />
    </div>
  );
}

export default function NativeInsights() {
  const { data, error } = useInsights();
  const cfg = useConfig();
  const showStudio = studioAllowed(cfg, import.meta.env);
  return (
    <Layout mode="family" wide>
      <PageTitle eyebrow="Family · Insights" title={data ? `${data.elder.name}'s safety at a glance` : 'Family Safety Insights'} lead="Purchases, your decisions, PayPal sandbox confirmations and shared scam checks — for your household only." />
      <p className="-mt-4 mb-6 flex flex-wrap gap-x-5 gap-y-2"><Link to="/family" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">Back to Family page</Link>{showStudio && <Link to="/family/insights/studio" className="font-bold text-teal underline underline-offset-4 inline-flex items-center gap-1 min-h-12"><LayoutDashboard className="size-5" aria-hidden />Open AG Studio view</Link>}</p>
      {error && <div className="mb-6"><Notice tone="danger" title={error} /></div>}
      {!data ? (!error && <p>Loading…</p>) : <NativeInsightsBody d={data} />}
    </Layout>
  );
}
