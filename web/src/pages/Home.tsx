import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MessageSquareWarning, ShoppingBag, LifeBuoy, Wallet, ChevronRight, Clock, Mic, ShieldAlert } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Card } from '../components/ui';
import { useMe } from '../lib/session';
import { fetchActivity, paymentLabel, verdictLabel, money, when, type ActivityItem } from '../lib/activity';

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
  const label = it.type === 'scan' ? `Scam check · ${verdictLabel(it.status)}` : `${money(it.amountCents, it.currency)} · ${paymentLabel(it.status)}`;
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block font-bold break-words">{it.title}</span>
        <span className="block text-base text-ink-soft">{label} · {when(it.at)}</span>
      </span>
      {it.href && <ChevronRight className="size-6 text-teal shrink-0" aria-hidden />}
    </>
  );
  return it.href
    ? <button type="button" onClick={() => nav(it.href!)} className="w-full flex items-center gap-3 py-3 text-left min-h-14 hover:text-teal">{inner}</button>
    : <div className="flex items-center gap-3 py-3 min-h-14">{inner}</div>;
}

export default function Home() {
  const me = useMe('elder');
  const nav = useNavigate();
  const [pending, setPending] = useState<ActivityItem[]>([]);
  const [recent, setRecent] = useState<ActivityItem[]>([]);
  useEffect(() => {
    if (!me) return;
    fetchActivity({ status: 'pending', limit: 3 }).then((r) => setPending(r.items)).catch(() => {});
    fetchActivity({ limit: 4 }).then((r) => setRecent(r.items)).catch(() => {});
  }, [me]);

  if (!me) return <Layout><p>Loading…</p></Layout>;
  const recentOnly = recent.filter((r) => !pending.some((p) => p.id === r.id)).slice(0, 3);
  return (
    <Layout>
      <header className="fade-up">
        <h1 className="text-[length:var(--text-title)] md:text-[length:var(--text-hero)]">{greeting()}, {me.name}.</h1>
        <p className="mt-1 text-[length:var(--text-lead)] text-ink-soft">What would you like to do?</p>
      </header>

      {pending.length > 0 && (
        <Card className="mt-6 p-5 border-2 border-amber" aria-labelledby="pending-h">
          <h2 id="pending-h" className="text-xl flex items-center gap-2"><Clock className="size-6 text-amber" aria-hidden />Waiting ({pending.length})</h2>
          <ul className="mt-1 divide-y divide-line">{pending.map((it) => <li key={it.id}><ActivityRow it={it} /></li>)}</ul>
        </Card>
      )}

      <nav aria-label="Shortcuts" className="mt-6 grid grid-cols-1 min-[400px]:grid-cols-2 gap-3 md:gap-5">
        {SHORTCUTS.map(({ mode, icon: Icon, title, text }) => (
          <button key={mode} type="button" onClick={() => nav(`/assistant?mode=${mode}`)}
            className="group text-left bg-paper rounded-[var(--radius-card)] border-2 border-line hover:border-teal shadow-[var(--shadow-card)] p-4 md:p-6 min-h-24 flex min-[400px]:flex-col gap-3 items-start">
            <span className="size-12 md:size-14 rounded-2xl bg-teal-soft grid place-items-center shrink-0"><Icon className="size-7 md:size-8 text-teal" aria-hidden /></span>
            <span className="min-w-0">
              <span className="font-display text-[1.3rem] md:text-[1.6rem] font-semibold leading-tight block">{title}</span>
              <span className="text-ink-soft text-base md:text-lg mt-1 block">{text}</span>
            </span>
          </button>
        ))}
      </nav>

      <Link to="/assistant" className="mt-4 flex items-center justify-center gap-3 min-h-14 rounded-full bg-teal text-white font-bold px-6 hover:bg-teal-deep shadow-[var(--shadow-lift)]">
        <Mic className="size-6" aria-hidden />Talk or type to SaySafe
      </Link>

      {recentOnly.length > 0 && (
        <Card className="mt-8 p-5" aria-labelledby="recent-h">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="recent-h" className="text-xl">Recent</h2>
            <Link to="/activity" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">See all activity</Link>
          </div>
          <ul className="divide-y divide-line">{recentOnly.map((it) => <li key={it.id}><ActivityRow it={it} /></li>)}</ul>
        </Card>
      )}
      {recent.length === 0 && (
        <p className="mt-8 text-ink-soft flex items-start gap-2"><ShieldAlert className="size-6 text-teal shrink-0" aria-hidden />Your checks and purchases will show here. PayPal Sandbox only: no real money moves.</p>
      )}
    </Layout>
  );
}
