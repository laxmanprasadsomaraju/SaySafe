/**
 * Mary's Insights (/insights): a calm, read-only summary of her own records. Reached from Home ("View insights"),
 * the desktop "Insights" nav item, and "View full insights" on Assistant cards. Data: GET /api/insights/summary,
 * built on the server from the same stores as Activity and the Assistant (no dashboard-only data).
 * Each kind of record (PayPal Sandbox / recorded by you / sample) is shown on its own; nothing is added across kinds.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Wallet, Clock, Repeat, CalendarClock, ShieldAlert, Copy, ListChecks } from 'lucide-react';
import { Layout } from '../../components/Layout';
import { Card } from '../../components/ui';
import { api } from '../../lib/api';
import { useMe } from '../../lib/session';
import { InsightsSummary, fmtMoneyList, type InsightsSummaryT } from '../../../../shared/insightsSummary';

const money = (c: number, cur: string) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur || 'EUR' }).format(c / 100);
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' });
const TAG = {
  sandbox: { t: 'Real PayPal Sandbox', c: 'bg-teal-soft text-teal-deep border-teal/30' },
  user_entered: { t: 'Recorded by you', c: 'bg-paper text-navy border-line' },
  sample: { t: 'Sample data', c: 'bg-amber-soft text-amber border-amber/30' },
} as const;
const Tag = ({ k }: { k: keyof typeof TAG }) => <span className={`inline-flex items-center rounded-xl border px-2 py-0.5 text-sm font-bold whitespace-nowrap ${TAG[k].c}`}>{TAG[k].t}</span>;

function Section({ id, icon: Icon, title, children }: { id: string; icon: typeof Wallet; title: string; children: ReactNode }) {
  return (
    <Card className="p-5 scroll-mt-24" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="text-2xl flex items-center gap-2"><Icon className="size-6 text-teal shrink-0" aria-hidden />{title}</h2>
      <div className="mt-3">{children}</div>
    </Card>
  );
}
const Row = ({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) => (
  <li className="py-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
    <span className="min-w-0 flex flex-wrap items-center gap-2">{label}</span>
    <span className="font-bold text-right">{value}{sub && <span className="block text-sm font-normal text-ink-soft">{sub}</span>}</span>
  </li>
);

export function InsightsBody({ d }: { d: InsightsSummaryT }) {
  const sb = d.payments.sandbox;
  const subs = d.subscriptions;
  const subRows = subs ? ([['user_entered', subs.userEntered], ['sample', subs.sample], ['sandbox', subs.sandbox]] as const).filter(([, k]) => k.count > 0) : [];
  return (
    <div className="grid gap-5 lg:grid-cols-2 items-start">
      <Section id="spending" icon={Wallet} title="Payments, by kind of record">
        <ul className="divide-y divide-line">
          <Row label={<><Tag k="sandbox" />Demo Shop, paid</>} value={sb.captured.count ? fmtMoneyList(sb.captured.totals) : 'None yet'} sub={sb.captured.count ? `${sb.captured.count} payment${sb.captured.count === 1 ? '' : 's'} · ${sb.webhookVerified} with a verified PayPal notice` : 'No real money: PayPal Sandbox'} />
          {d.records && <Row label={<><Tag k="user_entered" />Payments you typed in</>} value={d.records.userEntered.count ? fmtMoneyList(d.records.userEntered.totals) : 'None'} sub={d.records.userEntered.count ? `${d.records.userEntered.count} record${d.records.userEntered.count === 1 ? '' : 's'} · not verified` : undefined} />}
          {(d.payments.sample.count > 0 || (d.records?.sample.count ?? 0) > 0) && <Row label={<><Tag k="sample" />Illustrative examples</>} value={`${d.records?.sample.count ?? 0} records · ${d.payments.sample.count} purchases`} sub="No PayPal record. Not real payments." />}
        </ul>
        <p className="mt-2 text-sm text-ink-soft">These are different kinds of record, so they are never added together. Each currency is shown on its own.</p>
      </Section>

      <Section id="pending" icon={Clock} title="Waiting for approval">
        {d.pendingReviews.real.length === 0 ? <p>Nothing is waiting for your family member.</p> : (
          <ul className="divide-y divide-line">{d.pendingReviews.real.map((x) => <Row key={x.id} label={<Link className="font-bold text-teal underline underline-offset-4" to={`/order/${x.id}`}>{x.item}</Link>} value={money(x.amountCents, x.currency)} sub={`Review ends ${new Date(x.expiresAt).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`} />)}</ul>
        )}
        <ul className="mt-1 text-base text-ink-soft space-y-1">
          {sb.waitingPayPal > 0 && <li>{sb.waitingPayPal} purchase{sb.waitingPayPal === 1 ? '' : 's'} waiting for your own PayPal approval or confirmation.</li>}
          {d.pendingReviews.expired > 0 && <li>{d.pendingReviews.expired} review{d.pendingReviews.expired === 1 ? '' : 's'} expired. Nothing was paid.</li>}
          {d.pendingReviews.sampleWaiting > 0 && <li><Tag k="sample" /> {d.pendingReviews.sampleWaiting} sample request, illustrative and can’t be approved.</li>}
        </ul>
      </Section>

      {d.duplicates && (
        <Section id="duplicates" icon={Copy} title="Possible repeat payments">
          {d.duplicates.length === 0 ? <p>No two records look like the same payment.</p> : (
            <ul className="space-y-2">{d.duplicates.map((x, i) => <li key={i} className="rounded-2xl border-2 border-amber bg-amber-soft p-3"><p className="font-bold flex flex-wrap items-center gap-2">{x.recipient} · {money(x.amountCents, x.currency)} twice{x.sample && <Tag k="sample" />}</p><p className="mt-1 text-base">{x.message}</p></li>)}</ul>
          )}
          <p className="mt-2 text-sm text-ink-soft">Same check as “Did I already pay…?” in the Assistant. SaySafe can’t see your bank.</p>
        </Section>
      )}

      {subs && (
        <Section id="subscriptions" icon={Repeat} title="Subscriptions">
          {subRows.length === 0 ? <p>No subscriptions counted yet. You can add them in the Assistant.</p> : (
            <ul className="divide-y divide-line">{subRows.map(([k, s]) => <Row key={k} label={<><Tag k={k} />{s.count} subscription{s.count === 1 ? '' : 's'}</>} value={`${fmtMoneyList(s.monthly)} a month`} sub={`about ${fmtMoneyList(s.annual)} a year`} />)}</ul>
          )}
          <details className="mt-2"><summary className="cursor-pointer font-bold text-teal min-h-11 inline-flex items-center">How this is worked out</summary><p className="mt-1 text-base text-ink-soft">{subs.method}</p></details>
        </Section>
      )}

      {subs && (
        <Section id="upcoming" icon={CalendarClock} title="Coming out next">
          {subs.upcoming.length === 0 ? <p>No charges expected in the next month.</p> : (
            <ul className="divide-y divide-line">{subs.upcoming.map((u) => <Row key={u.id} label={<>{u.merchant}{u.kind !== 'user_entered' && <Tag k={u.kind} />}</>} value={money(u.amountCents, u.currency)} sub={`${u.inDays === 0 ? 'Today' : u.inDays === 1 ? 'Tomorrow' : `In ${u.inDays} days`} · ${day(`${u.nextOn}T12:00:00Z`)}`} />)}</ul>
          )}
          <p className="mt-2 text-sm text-ink-soft">Dates are the ones entered, not confirmed by the company.</p>
        </Section>
      )}

      <Section id="safety" icon={ShieldAlert} title="Safety: messages you checked">
        <ul className="divide-y divide-line">
          <Row label="Suspicious" value={d.scamChecks.real.suspicious} />
          <Row label="Worth checking" value={d.scamChecks.real.needsChecking} />
          <Row label="No obvious warning signs" value={d.scamChecks.real.noWarnings} />
          {d.scamChecks.training > 0 && <Row label={<><Tag k="sample" />Training examples</>} value={d.scamChecks.training} sub="Practice only, not counted above" />}
        </ul>
        {d.scamChecks.recent.length > 0 && <ul className="mt-2 space-y-1 text-base">{d.scamChecks.recent.map((s, i) => <li key={i} className={`rounded-2xl p-2 border-l-[6px] ${s.verdict === 'suspicious' ? 'bg-danger-soft border-danger' : 'bg-teal-soft border-teal'}`}>{s.headline}<span className="block text-sm text-ink-soft">{day(s.at)}</span></li>)}</ul>}
      </Section>

      <Section id="outcomes" icon={ListChecks} title="PayPal Sandbox outcomes">
        {sb.count === 0 ? <p>No Demo Shop purchases made in this app yet.</p> : (
          <ul className="divide-y divide-line">
            <Row label="Paid" value={sb.captured.count} sub={sb.webhookPending ? `${sb.webhookPending} still waiting for PayPal’s signed notice` : undefined} />
            <Row label="Waiting (family or PayPal)" value={sb.waitingFamily + sb.waitingPayPal} />
            <Row label="Cancelled or declined" value={sb.cancelled} />
            {sb.failed > 0 && <Row label="Failed" value={sb.failed} />}
            {(sb.refunded + sb.refundPending + sb.refundRequested) > 0 && <Row label="Refunds" value={`${sb.refunded} refunded · ${sb.refundPending} pending · ${sb.refundRequested} requested`} />}
          </ul>
        )}
        <h3 className="mt-4 text-lg">Recent</h3>
        {d.payments.recent.length === 0 ? <p className="text-ink-soft">Nothing yet.</p> : (
          <ul className="divide-y divide-line">{d.payments.recent.map((r) => <Row key={r.id} label={<>{r.id.startsWith('pay_') ? <Link className="font-bold text-teal underline underline-offset-4" to={`/order/${r.id}`}>{r.title}</Link> : <span className="font-bold">{r.title}</span>}<Tag k={r.kind} /></>} value={money(r.amountCents, r.currency)} sub={`${r.statusLabel} · ${day(r.at)}`} />)}</ul>
        )}
        <Link to="/activity" className="mt-2 font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">See everything in Activity</Link>
      </Section>
    </div>
  );
}

export default function MyInsights() {
  const me = useMe('elder');
  const nav = useNavigate();
  const { hash } = useLocation();
  const [d, setD] = useState<InsightsSummaryT | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setErr(null);
    api('/api/insights/summary').then((raw) => {
      const r = InsightsSummary.safeParse(raw);
      if (!r.success) throw new Error('SaySafe got an unexpected answer, so nothing is shown.');
      setD(r.data);
    }).catch((e: any) => { if (e?.status === 401) nav('/', { replace: true }); else setErr(String(e?.message ?? 'Couldn’t load your insights.')); });
  }, [nav]);
  useEffect(() => { if (me) load(); }, [me, load]);
  // Opened from an Assistant card ("View full insights" → /insights#pending): bring that section into view.
  useEffect(() => { if (d && hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' }); }, [d, hash]);
  return (
    <Layout wide>
      <header className="mb-6">
        <h1 className="text-[length:var(--text-title)] md:text-[length:var(--text-hero)]">Your insights</h1>
        <p className="mt-1 text-[length:var(--text-lead)] text-ink-soft max-w-3xl">A calm summary of your payments, subscriptions and safety checks. Read-only: nothing here pays, approves or cancels.</p>
        <p className="mt-2 text-base text-ink-soft">Your records, subscriptions and repeat checks are private to you. Your family member sees only Demo Shop purchases, reviews and the checks you share.</p>
      </header>
      {err ? (
        <div role="alert" className="rounded-2xl border-2 border-danger bg-danger-soft p-4"><p className="font-bold text-danger">Couldn’t load your insights: {err}</p><button type="button" onClick={load} className="mt-2 min-h-12 px-4 rounded-full border-2 border-line bg-paper font-bold hover:border-teal">Retry</button></div>
      ) : !d ? <p aria-live="polite">Loading your insights…</p> : <InsightsBody d={d} />}
    </Layout>
  );
}
