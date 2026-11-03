import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MessageSquareWarning, ShoppingBag, LifeBuoy, Wallet, ChevronRight, Clock, Mic, ShieldAlert, BarChart3 } from 'lucide-react';
import { api } from '../lib/api';
import { useConfig } from '../lib/insightsApi';
import { InsightsSummary, type InsightsSummaryT } from '../../../shared/insightsSummary';
import { Layout } from '../components/Layout';
import { Card } from '../components/ui';
import { useMe } from '../lib/session';
import { fetchActivity, verdictLabel, money, when, shortStatus, type ActivityItem } from '../lib/activity';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export const SHORTCUTS = [
  { mode: 'check', icon: MessageSquareWarning, title: 'Check a message', text: 'Is this text, email or link really from PayPal?' },
  { mode: 'find', icon: ShoppingBag, title: 'Find a product', text: 'Demo Shop with PayPal Sandbox, or compare real shops.' },
  { mode: 'help', icon: LifeBuoy, title: 'Get trusted help', text: 'Official PayPal help, order problems, or your family.' },
  { mode: 'payments', icon: Wallet, title: 'My payments', text: 'Receipts, what is waiting, and what happened.' },
] as const;

export function ActivityRow({ it }: { it: ActivityItem }) {
  const nav = useNavigate();
  const st = shortStatus(it.status, { webhookConfirmed: it.webhookConfirmed, approval: it.approval?.status });
  const label = it.type === 'scan' ? `Scam check · ${verdictLabel(it.status)}` : it.type === 'record' ? `${money(it.amountCents, it.currency)} · ${it.example ? 'Sample record' : 'Recorded by you'}` : `${money(it.amountCents, it.currency)} · ${st.detail && st.label === 'Pending' ? st.detail : st.label}`;
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block font-bold break-words">{it.title}</span>
        <span className="block text-base text-ink-soft">{label} · {when(it.at)}</span>
        {it.example && <span className="mt-1 inline-flex rounded-xl border border-amber/40 bg-amber-soft px-2 text-sm font-bold text-amber">Sample data</span>}
      </span>
      {it.href && <ChevronRight className="size-6 text-teal shrink-0" aria-hidden />}
    </>
  );
  return it.href
    ? <button type="button" onClick={() => nav(it.href!)} className="w-full flex items-center gap-3 py-3 text-left min-h-14 hover:text-teal">{inner}</button>
    : <div className="flex items-center gap-3 py-3 min-h-14">{inner}</div>;
}

/** The one thing that most needs Mary: her own next step first (PayPal), then what waits for family, then the rest. */
const PRIORITY = ['FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'FAMILY_APPROVAL_PENDING'];
export function mostRelevant(items: ActivityItem[]): ActivityItem | null {
  const rank = (i: ActivityItem) => { const k = PRIORITY.indexOf(i.state ?? i.status); return k < 0 ? PRIORITY.length : k; };
  // Sample rows are never "Needs you": they can't be paid or approved.
  return [...items].filter((i) => i.type === 'payment' && !i.example && !(i.approval?.status === 'expired')).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** "View insights": a short glance from the same summary the Insights page and the Assistant use. */
function InsightsCard() {
  const [d, setD] = useState<InsightsSummaryT | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { api('/api/insights/summary').then((raw) => { const r = InsightsSummary.safeParse(raw); if (r.success) setD(r.data); else setFailed(true); }).catch(() => setFailed(true)); }, []);
  const bits = d ? [
    d.pendingReviews.real.length ? `${d.pendingReviews.real.length} waiting for family` : 'Nothing waiting for family',
    d.duplicates?.length ? `${d.duplicates.length} possible repeat payment${d.duplicates.length === 1 ? '' : 's'}` : null,
    d.subscriptions?.upcoming[0] ? `Next charge: ${d.subscriptions.upcoming[0].merchant}${d.subscriptions.upcoming[0].kind === 'sample' ? ' (sample)' : ''}` : null,
  ].filter(Boolean) as string[] : [];
  return (
    <Card className="mt-6 p-5" aria-labelledby="ins-h" data-testid="home-insights">
      <h2 id="ins-h" className="text-xl flex items-center gap-2"><BarChart3 className="size-6 text-teal" aria-hidden />Your insights</h2>
      <p className="mt-1 text-ink-soft">{failed ? 'Your spending, subscriptions and safety checks in one place.' : d ? bits.join(' · ') : 'Loading…'}</p>
      <Link to="/insights" className="mt-3 inline-flex items-center justify-center gap-2 min-h-12 px-5 rounded-full border-2 border-teal text-teal-deep bg-paper font-bold hover:bg-teal-soft">View insights<ChevronRight className="size-5" aria-hidden /></Link>
    </Card>
  );
}

export default function Home() {
  const me = useMe('elder');
  const nav = useNavigate();
  const cfg = useConfig();
  const [pending, setPending] = useState<ActivityItem[]>([]);
  const [count, setCount] = useState(0);
  const [recent, setRecent] = useState<ActivityItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadAll = () => {
    setErr(null);
    fetchActivity({ status: 'pending', limit: 10 }).then((r) => { setPending(r.items.filter((i) => !i.example)); setCount(r.items.filter((i) => !i.example).length); }).catch((e) => setErr(e.message)); // an error, never "nothing pending"
    fetchActivity({ limit: 4 }).then((r) => setRecent(r.items)).catch((e) => setErr(e.message));
  };
  useEffect(() => { if (me) loadAll(); }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return <Layout><p>Loading…</p></Layout>;
  const top = mostRelevant(pending);
  const yours = top && ['FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED'].includes(top.state ?? '');
  return (
    <Layout>
      <header className="fade-up">
        <h1 className="text-[length:var(--text-title)] md:text-[length:var(--text-hero)]">{greeting()}, {me.name}.</h1>
        <p className="mt-1 text-[length:var(--text-lead)] text-ink-soft">What would you like to do?</p>
      </header>

      <nav aria-label="Shortcuts" className="mt-6 grid grid-cols-1 min-[360px]:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-5">
        {SHORTCUTS.map(({ mode, icon: Icon, title, text }) => (
          <button key={mode} type="button" onClick={() => nav(`/assistant?mode=${mode}`)}
            className="group text-left bg-paper rounded-[var(--radius-card)] border-2 border-line hover:border-teal shadow-[var(--shadow-card)] p-4 md:p-5 min-h-24 flex min-[360px]:flex-col gap-3 items-start">
            <span className="size-12 md:size-14 rounded-2xl bg-teal-soft grid place-items-center shrink-0"><Icon className="size-7 md:size-8 text-teal" aria-hidden /></span>
            <span className="min-w-0">
              <span className="font-display text-[1.3rem] md:text-[1.5rem] font-semibold leading-tight block">{title}</span>
              <span className="text-ink-soft text-base md:text-lg mt-1 hidden md:block">{text}</span>
            </span>
          </button>
        ))}
      </nav>

      {top && (
        <Card className={`mt-6 p-5 border-2 ${yours ? 'border-teal' : 'border-amber'}`} aria-labelledby="next-h">
          <h2 id="next-h" className="text-xl flex items-center gap-2"><Clock className={`size-6 ${yours ? 'text-teal' : 'text-amber'}`} aria-hidden />{yours ? 'Needs you' : 'Waiting'}</h2>
          <ActivityRow it={top} />
          {count > 1 && <Link to="/activity" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">{count - 1} more in Activity</Link>}
        </Card>
      )}

      {cfg?.insights !== false && <InsightsCard />}

      <Card className="mt-6 p-5" aria-labelledby="recent-h">
        <h2 id="recent-h" className="text-xl">Recent activity</h2>
        {err ? (
          <div role="alert" className="mt-2"><p className="font-bold text-danger">Couldn’t load your activity: {err}</p><button type="button" onClick={loadAll} className="mt-2 min-h-12 px-4 rounded-full border-2 border-line font-bold hover:border-teal">Retry</button></div>
        ) : recent === null ? <p className="mt-2 text-ink-soft">Loading…</p> : recent.length === 0 ? <p className="mt-2 text-ink-soft">Nothing yet. When you check a message or buy something, it shows up here.</p> : (
          <ul className="divide-y divide-line">{recent.map((it) => <li key={`${it.type}-${it.id}`}><ActivityRow it={it} /></li>)}</ul>
        )}
        {recent && recent.some((i) => i.example) && <p className="mt-2 text-sm text-ink-soft">Items marked “Sample data” are illustrative examples for the demo: no PayPal record, nothing can be paid.</p>}
        <div className="mt-2 flex flex-wrap gap-x-5"><Link to="/activity" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">See all activity</Link><Link to="/assistant?welcome=1" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">Things to try</Link></div>
      </Card>

      <Link to="/assistant" className="mt-6 flex md:inline-flex items-center justify-center gap-3 min-h-14 rounded-full bg-teal text-white font-bold px-8 hover:bg-teal-deep shadow-[var(--shadow-lift)]">
        <Mic className="size-6" aria-hidden />Talk or type to SaySafe
      </Link>
      {/* The "See all activity" link lives once, in Recent activity (it was repeated here). */}
      <p className="mt-5 text-base text-ink-soft flex items-start gap-2"><ShieldAlert className="size-5 text-teal shrink-0 mt-0.5" aria-hidden /><span>PayPal Sandbox only: no real money moves.</span></p>
    </Layout>
  );
}
