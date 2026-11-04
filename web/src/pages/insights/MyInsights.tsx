/**
 * Mary's Insights (/insights): a calm, read-only summary of her own records. Reached from Home ("View insights"),
 * the desktop "Insights" nav item, and "View full insights" on Assistant cards. Data: GET /api/insights/summary,
 * built on the server from the same stores as Activity and the Assistant (no dashboard-only data).
 * Each kind of record (PayPal Sandbox / recorded by you / sample) is shown on its own; nothing is added across kinds.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Wallet, Clock, Repeat, CalendarClock, ShieldAlert, Copy, ListChecks, Search, Users, Ban } from 'lucide-react';
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
    <Card className="p-5 scroll-mt-24 mb-5 break-inside-avoid [display:inline-block] w-full align-top" id={id} aria-labelledby={`${id}-h`}>
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

const StatRow = ({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) => (
  <li className="py-2.5 flex items-start justify-between gap-4">
    <span className="min-w-0"><span className="flex flex-wrap items-center gap-2">{label}</span>{sub && <span className="block mt-0.5 text-sm text-ink-soft">{sub}</span>}</span>
    <span className="font-bold text-xl shrink-0">{value}</span>
  </li>
);

function Tile({ label, value, note, href }: { label: string; value: ReactNode; note: string; href: string }) {
  return (
    <a href={href} className="block rounded-[var(--radius-card)] border border-line bg-paper shadow-[var(--shadow-card)] p-4 hover:border-teal focus-visible:border-teal min-w-0">
      <span className="block text-base font-bold text-ink-soft">{label}</span>
      <span className="mt-1 block font-display text-3xl font-semibold break-words">{value}</span>
      <span className="mt-1 block text-sm text-ink-soft">{note}</span>
    </a>
  );
}

const STATUS_ROWS = [
  ['paid', 'Paid'], ['waiting', 'Waiting (family or PayPal)'], ['cancelled', 'Cancelled'], ['declined', 'Declined by family'],
  ['expired', 'Review expired, not paid'], ['failed', 'Failed (e.g. card declined)'], ['refunded', 'Refunded or refund pending'],
] as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SUB_HOW = { you_reported: 'You told SaySafe it is cancelled', paypal_confirmed: 'Cancelled, confirmed by PayPal Sandbox', stopped_tracking: 'You stopped tracking it' } as const;
const ORDER_HOW = { cancelled: 'Cancelled', declined: 'Declined by family', blocked: 'Stopped by a safety check' } as const;

export function InsightsBody({ d }: { d: InsightsSummaryT }) {
  const sb = d.payments.sandbox;
  const subs = d.subscriptions;
  const subRows = subs ? ([['user_entered', subs.userEntered], ['sample', subs.sample], ['sandbox', subs.sandbox]] as const).filter(([, k]) => k.count > 0) : [];
  const flagged = d.scamChecks.real.suspicious + d.scamChecks.real.needsChecking;
  const ownDups = (d.duplicates ?? []).filter((x) => !x.sample).length;
  const sampleDups = (d.duplicates ?? []).filter((x) => x.sample).length;
  const ap = d.approvals;
  const sh = d.shopping;
  const sbs = d.payments.sandboxByStatus;
  const sms = d.payments.sample.byStatus;
  return (
    <>
    <ul className="grid gap-3 grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4 mb-5" aria-label="At a glance">
      <li><Tile href="#outcomes" label="Paid (PayPal Sandbox)" value={sb.captured.count ? fmtMoneyList(sb.captured.totals) : '0'} note={sb.captured.count ? `${plural(sb.captured.count, 'purchase')} · no real money` : 'No real purchases yet · sample not counted'} /></li>
      {sh && <li><Tile href="#shopping" label="Products looked at" value={sh.productsLooked} note={`last ${sh.windowDays} days · ${plural(sh.lookedAndBought, 'bought', 'bought')}`} /></li>}
      <li><Tile href="#safety" label="Flagged as possibly risky" value={flagged} note={d.scamChecks.real.total ? `of ${plural(d.scamChecks.real.total, 'message')} you checked` : 'No suspicious checks yet'} /></li>
      {d.contacts && <li><Tile href="#contacts" label="Trusted contacts" value={d.contacts.total} note={d.contacts.sample ? `${d.contacts.own} yours · ${d.contacts.sample} sample` : 'saved by you'} /></li>}
    </ul>
    <div className="columns-1 md:columns-2 xl:columns-3 gap-5" data-layout="masonry">
      <Section id="spending" icon={Wallet} title="Payments, by kind of record">
        <ul className="divide-y divide-line">
          <Row label={<><Tag k="sandbox" />Demo Shop, paid</>} value={sb.captured.count ? fmtMoneyList(sb.captured.totals) : 'None yet'} sub={sb.captured.count ? `${sb.captured.count} payment${sb.captured.count === 1 ? '' : 's'} · ${sb.webhookVerified} with a verified PayPal notice` : 'No real money: PayPal Sandbox'} />
          {d.records && <Row label={<><Tag k="user_entered" />Payments you typed in</>} value={d.records.userEntered.count ? fmtMoneyList(d.records.userEntered.totals) : 'None'} sub={d.records.userEntered.count ? `${d.records.userEntered.count} record${d.records.userEntered.count === 1 ? '' : 's'} · not verified` : undefined} />}
          {(d.payments.sample.count > 0 || (d.records?.sample.count ?? 0) > 0) && <Row label={<><Tag k="sample" />Illustrative examples</>} value={`${d.records?.sample.count ?? 0} records · ${d.payments.sample.count} purchases`} sub="No PayPal record. Not real payments." />}
        </ul>
        <p className="mt-2 text-sm text-ink-soft">These are different kinds of record, so they are never added together. Each currency is shown on its own.</p>
      </Section>

      <Section id="outcomes" icon={ListChecks} title="Purchases, by outcome">
        {sbs && sms ? (
          <table className="w-full text-left">
            <caption className="sr-only">Purchases by outcome. Real PayPal Sandbox purchases and sample purchases are counted separately.</caption>
            <thead><tr className="border-b border-line"><th scope="col" className="py-2 pr-2 font-bold">Outcome</th><th scope="col" className="py-2 px-2 font-bold text-right">Real Sandbox</th><th scope="col" className="py-2 pl-2 font-bold text-right">Sample</th></tr></thead>
            <tbody className="divide-y divide-line">{STATUS_ROWS.map(([k, label]) => <tr key={k}><th scope="row" className="py-2 pr-2 font-normal">{label}</th><td className="py-2 px-2 text-right font-bold">{sbs[k]}</td><td className="py-2 pl-2 text-right text-ink-soft">{sms[k]}</td></tr>)}</tbody>
          </table>
        ) : sb.count === 0 ? <p>No Demo Shop purchases made in this app yet.</p> : null}
        {sb.count === 0 && <p className="mt-2 text-base">No real Demo Shop purchases yet.</p>}
        <p className="mt-2 text-sm text-ink-soft">{sb.captured.count ? `Real paid: ${fmtMoneyList(sb.captured.totals)} · ${sb.webhookVerified} with a verified PayPal notice${sb.webhookPending ? ` · ${sb.webhookPending} still waiting for it` : ''}. ` : ''}{d.payments.sample.captured.count ? `Sample paid: ${fmtMoneyList(d.payments.sample.captured.totals)}, illustrative. ` : ''}The two columns are never added together.</p>
        <h3 className="mt-4 text-lg">Recent</h3>
        {d.payments.recent.length === 0 ? <p className="text-ink-soft">Nothing yet.</p> : (
          <ul className="divide-y divide-line">{d.payments.recent.map((r) => <Row key={r.id} label={<>{r.id.startsWith('pay_') ? <Link className="font-bold text-teal underline underline-offset-4" to={`/order/${r.id}`}>{r.title}</Link> : <span className="font-bold">{r.title}</span>}<Tag k={r.kind} /></>} value={money(r.amountCents, r.currency)} sub={`${r.statusLabel} · ${day(r.at)}`} />)}</ul>
        )}
        <Link to="/activity" className="mt-2 font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">See everything in Activity</Link>
      </Section>


      {d.cancelled && (
        <Section id="cancelled" icon={Ban} title="Cancelled">
          <h3 className="text-lg">Orders</h3>
          {d.cancelled.orders.length === 0 ? <p className="text-ink-soft">No cancelled orders.</p> : (
            <ul className="divide-y divide-line">{d.cancelled.orders.map((o) => <Row key={o.id} label={<><span className="font-bold">{o.title}</span><Tag k={o.kind} /></>} value={<span className="font-normal">{ORDER_HOW[o.how]}</span>} sub={o.at ? day(o.at) : undefined} />)}</ul>
          )}
          <h3 className="mt-4 text-lg">Subscriptions</h3>
          {d.cancelled.subscriptions.length === 0 ? <p className="text-ink-soft">No cancelled subscriptions.</p> : (
            <ul className="divide-y divide-line">{d.cancelled.subscriptions.map((x, i) => <Row key={i} label={<><span className="font-bold">{x.merchant}</span>{x.kind !== 'user_entered' && <Tag k={x.kind} />}</>} value={<span className="font-normal">{SUB_HOW[x.how]}</span>} sub={x.on ? day(x.on.length === 10 ? `${x.on}T12:00:00Z` : x.on) : undefined} />)}</ul>
          )}
          <p className="mt-2 text-sm text-ink-soft">Only the Demo Membership is cancelled through PayPal. Other subscriptions show what you told SaySafe.</p>
        </Section>
      )}

      {sh && (
        <Section id="shopping" icon={Search} title="Shopping: looked at and bought">
          <ul className="divide-y divide-line">
            <StatRow label="Different products you looked at" value={sh.productsLooked} sub={`${sh.channel3Products} from real shops · ${sh.demoProducts} from the Demo Shop · last ${sh.windowDays} days`} />
            <StatRow label="Searches that showed products" value={sh.searches} sub="Asked in the Assistant" />
            <StatRow label="Of those products, bought" value={sh.lookedAndBought} sub="Demo Shop only: real-shop listings open the shop’s own website" />
            <StatRow label={<><Tag k="sandbox" />Purchases you started</>} value={sh.purchasesStarted} sub={`${sh.purchasesPaid} paid · all time`} />
          </ul>
          <details className="mt-2"><summary className="cursor-pointer font-bold text-teal min-h-11 inline-flex items-center">What is not counted</summary>
            <ul className="mt-1 text-base text-ink-soft list-disc pl-5">{[`SaySafe keeps the last ${sh.maxProducts} products shown to you for ${sh.windowDays} days, so this is a recent window.`, ...sh.notTracked, 'Sample purchases are not counted here.'].map((t) => <li key={t}>{t}</li>)}</ul>
          </details>
        </Section>
      )}

      <Section id="safety" icon={ShieldAlert} title="Safety">
        <ul className="divide-y divide-line">
          <StatRow label="Messages flagged as possibly risky" value={flagged} sub={d.scamChecks.real.total ? `${d.scamChecks.real.suspicious} suspicious · ${d.scamChecks.real.needsChecking} worth checking · ${d.scamChecks.real.noWarnings} with no obvious warning signs` : 'No suspicious checks yet'} />
          {d.duplicates && <StatRow label="Repeat-payment warnings" value={ownDups} sub={sampleDups ? `${sampleDups} more in sample records, not counted` : 'Same check as “Did I already pay…?”'} />}
          {ap && <StatRow label="Purchases paused for family approval" value={ap.real.requested} sub={ap.real.requested ? `${ap.real.approved} approved · ${ap.real.declined} declined · ${ap.real.pending} waiting · ${ap.real.expired} expired` : 'None of your real purchases needed a review yet'} />}
          {ap && ap.sample.requested > 0 && <StatRow label={<><Tag k="sample" />Sample family reviews</>} value={ap.sample.requested} sub={`${ap.sample.approved} approved · ${ap.sample.declined} declined · ${ap.sample.pending} waiting · ${ap.sample.expired} expired. Not counted above.`} />}
          {d.scamChecks.training > 0 && <StatRow label={<><Tag k="sample" />Training examples</>} value={d.scamChecks.training} sub="Practice only, not counted above" />}
        </ul>
        {d.scamChecks.recent.length > 0 && <ul className="mt-2 space-y-1 text-base">{d.scamChecks.recent.map((s, i) => <li key={i} className={`rounded-2xl p-2 border-l-[6px] ${s.verdict === 'suspicious' ? 'bg-danger-soft border-danger' : 'bg-teal-soft border-teal'}`}>{s.headline}<span className="block text-sm text-ink-soft">{day(s.at)}</span></li>)}</ul>}
        <p className="mt-2 text-sm text-ink-soft">A flag means the message showed warning signs, not that it was proven to be a scam. SaySafe can’t know what would have happened otherwise.</p>
      </Section>

      {d.contacts && (
        <Section id="contacts" icon={Users} title="Trusted contacts">
          {d.contacts.total === 0 ? <p>No contacts yet. You can add them in the Assistant.</p> : (
            <ul className="divide-y divide-line">{d.contacts.list.map((c, i) => <Row key={i} label={<><span className="font-bold">{c.name}</span>{c.sample && <Tag k="sample" />}</>} value={<span className="font-normal text-ink-soft">{c.relation ?? ''}</span>} />)}</ul>
          )}
          {d.contacts.total > d.contacts.list.length && <p className="mt-1 text-base text-ink-soft">and {d.contacts.total - d.contacts.list.length} more.</p>}
          <p className="mt-2 text-sm text-ink-soft">Private to you. Phone numbers and emails are not shown here.</p>
        </Section>
      )}

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
    </div>
    </>
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
        <p className="mt-1 text-[length:var(--text-lead)] text-ink-soft max-w-3xl">A calm summary of what you bought, cancelled and checked, and who you trust. Read-only: nothing here pays, approves or cancels.</p>
        <p className="mt-2 text-base text-ink-soft">Your records, searches, contacts, subscriptions and repeat checks are private to you. Your family helper sees only the purchases sent to them for review, anything you choose to share in Family settings, and the checks you share.</p>
      </header>
      {err ? (
        <div role="alert" className="rounded-2xl border-2 border-danger bg-danger-soft p-4"><p className="font-bold text-danger">Couldn’t load your insights: {err}</p><button type="button" onClick={load} className="mt-2 min-h-12 px-4 rounded-full border-2 border-line bg-paper font-bold hover:border-teal">Retry</button></div>
      ) : !d ? <p aria-live="polite">Loading your insights…</p> : <InsightsBody d={d} />}
    </Layout>
  );
}
