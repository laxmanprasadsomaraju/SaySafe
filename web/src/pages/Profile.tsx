/**
 * Profile, in three groups (DOM and reading order = visual order):
 *   1. Personal experience: Voice & conversation, Accessibility, Language
 *   2. Account & preferences: Shopping preferences, Trusted family, Family sharing (Mary only), Privacy & data
 *   3. Demo & help: Mary's demo (things to try, walkthrough, Try as Alex, Reset demo) and the Help Centre
 * Layout: each group is a two-column grid of INDEPENDENT column stacks (flex columns), not one grid of cards.
 * The old single `grid lg:grid-cols-2` put mismatched cards into shared rows, so a short card next to a tall one
 * left a large blank area under it. Stacks keep natural card heights, and the DOM order still reads card by card.
 * Every setting says where it is kept: "This device" or "Saved to your account".
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Volume2, Accessibility, Languages, ShoppingBag, Users, Lock, LifeBuoy, BarChart3, ChevronRight, MessageCircle, Smartphone, Cloud, RotateCcw, Brain } from 'lucide-react';
import { MemoryBody } from '../components/MemorySection';
import { Layout } from '../components/Layout';
import { card, cardPad, panel, linkRow, linkBtn, btnSecondary, btnDanger, btnDangerSolid, btnPrimarySm, btnOutlineTeal, switchBtn, eyebrow } from '../components/ds';
import { VoiceSettings, LanguageSetting, MuteSwitch } from '../components/VoiceBar';
import { useShellRole } from '../lib/role';
import { useDisplay, setDisplay, type DisplayKey } from '../lib/display';
import { api } from '../lib/api';
import { loadProfile, clearProfile } from '../lib/prefs';
import { useConfig } from '../lib/insightsApi';
import { agStudioLicenseKey } from '../lib/insightsChoice';
import { THREAD_KEY, FAMILY_THREAD_KEY } from '../assistant/thread';
import type { ShoppingProfile } from '../../../shared/shopping';

/** Where a setting lives. */
export function Where({ account }: { account?: boolean }) {
  return account
    ? <span className="inline-flex items-center gap-1 rounded-full border border-teal/40 bg-teal-soft text-teal-deep px-2.5 py-0.5 text-sm font-bold whitespace-nowrap"><Cloud className="size-4" aria-hidden />Saved to account</span>
    : <span className="inline-flex items-center gap-1 rounded-full border border-line bg-ivory text-navy px-2.5 py-0.5 text-sm font-bold whitespace-nowrap"><Smartphone className="size-4" aria-hidden />This device</span>;
}

function Toggle({ k, label, hint }: { k: DisplayKey; label: string; hint: string }) {
  const d = useDisplay();
  const on = d[k];
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="min-w-0"><span className="block font-bold" id={`t-${k}`}>{label}</span><span className="block text-base text-ink-soft" id={`th-${k}`}>{hint}</span></span>
      <button type="button" role="switch" aria-checked={on} aria-labelledby={`t-${k}`} aria-describedby={`th-${k}`} onClick={() => setDisplay(k, !on)}
        className={switchBtn(on)}>{on ? 'On' : 'Off'}</button>
    </div>
  );
}

/** One settings card. Title and "where it is kept" badge share a row and wrap together on narrow screens. */
function Section({ id, icon: Icon, title, where, children }: { id: string; icon: typeof Lock; title: string; where?: ReactNode; children: ReactNode }) {
  return (
    <section className={`${card} ${cardPad}`} aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 id={id} className="text-[1.3rem] leading-tight flex items-center gap-2 min-w-0"><Icon className="size-6 text-teal shrink-0" aria-hidden />{title}</h3>
        {where}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A group of settings with its own heading. Cards go into two independent column stacks from 1024px. */
function Group({ id, title, lead, left, right }: { id: string; title: string; lead: string; left: ReactNode[]; right: ReactNode[] }) {
  const l = left.filter(Boolean), r = right.filter(Boolean);
  const single = !l.length || !r.length;
  return (
    <section aria-labelledby={id} className="mt-10 first-of-type:mt-8 scroll-mt-24" id={`${id}-group`}>
      <h2 id={id} className={eyebrow}>{title}</h2>
      <p className="mt-1 text-base text-ink-soft max-w-2xl">{lead}</p>
      <div className={`mt-4 grid gap-5 ${single ? 'max-w-3xl' : 'lg:grid-cols-2'} items-start`}>
        <div className="flex flex-col gap-5 min-w-0">{single ? [...l, ...r] : l}</div>
        {!single && <div className="flex flex-col gap-5 min-w-0">{r}</div>}
      </div>
    </section>
  );
}

function ShoppingSummary() {
  const [p, setP] = useState<{ profile: ShoppingProfile; where: 'account' | 'browser' } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { loadProfile().then(setP).catch(() => setP(null)); }, []);
  const parts = p ? [...p.profile.brands, ...p.profile.colours, ...p.profile.styles].slice(0, 4) : [];
  const empty = !p || (parts.length === 0 && !p.profile.avoid.length && !p.profile.categories.length && p.profile.budgetMax === null);
  return (
    <Section id="shop-h" icon={ShoppingBag} title="Shopping preferences" where={<Where account={p?.where !== 'browser'} />}>
      <p className="text-base text-ink-soft">Private to you. Family members and shops can’t see them.</p>
      <p className="mt-3 font-bold">{empty ? 'Nothing saved yet.' : `${parts.join(', ')}${p!.profile.budgetMax !== null ? ` · usual budget €${p!.profile.budgetMax}` : ''}`}</p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        <Link to="/preferences" className={linkBtn}>{empty ? 'Add preferences' : 'Edit preferences'}</Link>
        {!empty && <button type="button" onClick={() => clearProfile().then(() => { setP(p && { ...p, profile: { ...p.profile, brands: [], colours: [], styles: [], avoid: [], categories: [], budgetMax: null } }); setMsg('Cleared.'); }).catch((e) => setMsg(e.message))} className="font-bold text-danger underline underline-offset-4 min-h-12">Clear all</button>}
      </div>
      {msg && <p role="status" className="text-base font-bold">{msg}</p>}
    </Section>
  );
}

/** Mary's private companion records: links into the Assistant, and "Delete all" (asks first). Never shown to family. */
function CompanionData() {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const del = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ deleted: { payments: number; subscriptions: number; contacts: number } }>('/api/companion/all', { method: 'DELETE', body: { confirm: true } });
      const d = r.deleted ?? { payments: 0, subscriptions: 0, contacts: 0 };
      setMsg(`Deleted ${d.payments} payment record${d.payments === 1 ? '' : 's'}, ${d.subscriptions} subscription${d.subscriptions === 1 ? '' : 's'} and ${d.contacts} contact${d.contacts === 1 ? '' : 's'}. Demo Shop payments are kept.`);
      setAsk(false);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-4 border-t border-line pt-4" data-testid="companion-data">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-bold">My records</p><Where account /></div>
      <p className="text-base text-ink-soft">Private to you. Your family can’t see them.</p>
      <ul className="divide-y divide-line">
        <li><Link className={linkRow} to="/assistant?records=payments">Payments I recorded<ChevronRight className="size-5" aria-hidden /></Link></li>
        <li><Link className={linkRow} to="/assistant?records=subscriptions">My subscriptions<ChevronRight className="size-5" aria-hidden /></Link></li>
        <li><Link className={linkRow} to="/assistant?records=contacts">Trusted contacts<ChevronRight className="size-5" aria-hidden /></Link></li>
      </ul>
      {!ask ? (
        <button type="button" onClick={() => { setAsk(true); setMsg(null); }} className={`mt-3 ${btnDanger}`}>Delete all my companion data</button>
      ) : (
        <div className="mt-3 rounded-2xl border-2 border-danger p-4" role="group" aria-label="Delete all my companion data?">
          <p className="font-bold">Delete all your payment records, subscriptions and trusted contacts?</p>
          <p className="mt-1 text-base text-ink-soft">This can’t be undone. Your Demo Shop payments are kept. A Demo Membership still billing through PayPal must be cancelled first.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void del()} disabled={busy} className={btnDangerSolid}>{busy ? 'Deleting…' : 'Yes, delete everything'}</button>
            <button type="button" onClick={() => setAsk(false)} className={btnSecondary}>Keep my records</button>
          </div>
        </div>
      )}
      {err && <p role="alert" className="mt-2 text-danger font-bold">{err}</p>}
      {msg && <p role="status" className="mt-2 font-bold">{msg}</p>}
    </div>
  );
}

/** "Reset Mary's demo": puts the sample data back. Real PayPal Sandbox payments and records you typed are kept. */
function ResetDemo() {
  const nav = useNavigate();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reset = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ seeded: { transactions: number; records: number; subscriptions: number; contacts: number } }>('/api/demo/reset', { body: {} });
      try { sessionStorage.removeItem(THREAD_KEY); } catch { /* */ }
      setMsg(`Sample data restored: ${r.seeded.transactions} purchases, ${r.seeded.records} payment records, ${r.seeded.subscriptions} subscriptions, ${r.seeded.contacts} contacts.`); setAsk(false);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div>
      {!ask ? <button type="button" onClick={() => { setAsk(true); setMsg(null); }} className={btnSecondary} data-testid="reset-demo"><RotateCcw className="size-5" aria-hidden />Reset Mary’s demo</button> : (
        <div className="rounded-2xl border-2 border-teal/50 bg-paper p-4" role="group" aria-label="Reset Mary’s demo?">
          <p className="font-bold">Put the sample data back as it was?</p>
          <p className="mt-1 text-base text-ink-soft">Sample purchases, records, subscriptions, contacts and family reviews are replaced. Your real PayPal Sandbox payments and anything you typed yourself are kept. The conversation is cleared.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void reset()} disabled={busy} className={btnPrimarySm}>{busy ? 'Resetting…' : 'Yes, reset the sample data'}</button>
            <button type="button" onClick={() => setAsk(false)} className={btnSecondary}>Keep it</button>
          </div>
        </div>
      )}
      {msg && <p role="status" className="mt-2 font-bold">{msg} <button type="button" onClick={() => nav('/assistant?welcome=1')} className="font-bold text-teal underline underline-offset-4 min-h-12">Open the Assistant</button></p>}
      {err && <p role="alert" className="mt-2 text-danger font-bold">{err}</p>}
    </div>
  );
}

/** "Try as Alex too": a family session for this household in this browser, so a judge can approve a REAL request. */
export function TryAsAlex({ compact = false }: { compact?: boolean }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/demo/alex', { body: {} }); nav('/family/assistant'); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className={compact ? '' : 'max-w-prose'}>
      <button type="button" onClick={() => void go()} disabled={busy} className={btnOutlineTeal} data-testid="try-as-alex"><Users className="size-5" aria-hidden />{busy ? 'Opening Alex’s view…' : 'Try as Alex too'}</button>
      <p className="mt-2 text-base text-ink-soft">Opens Alex’s family view for this account in this browser, so you can approve or decline a real request (Mary can’t approve her own). Come back with Profile › Back to Mary.</p>
      {err && <p role="alert" className="mt-1 text-danger font-bold">{err}</p>}
    </div>
  );
}

/** Demo & help: a quieter panel (no shadow) so it doesn't compete with the settings, but its actions are one tap away. */
function DemoAndHelp({ family }: { family: boolean }) {
  const help = (
    <div className="min-w-0">
      <h3 id="help-h" className="text-xl flex items-center gap-2"><LifeBuoy className="size-6 text-teal shrink-0" aria-hidden />Help Centre</h3>
      <ul className="mt-1 divide-y divide-line">
        {!family && <li><Link className={linkRow} to="/help">Get trusted help<ChevronRight className="size-5" aria-hidden /></Link></li>}
        <li><Link className={linkRow} to="/learn" data-testid="profile-learn-link">Learn SaySafe: step-by-step guides<ChevronRight className="size-5" aria-hidden /></Link></li>
        <li><Link className={linkRow} to="/judges">Judges’ Guide (test in 5 minutes)<ChevronRight className="size-5" aria-hidden /></Link></li>
        <li><Link className={linkRow} to="/" data-testid="profile-website-link">SaySafe website (you stay signed in)<ChevronRight className="size-5" aria-hidden /></Link></li>
        <li><a className={linkRow} href="https://github.com/laxmanprasadsomaraju/SaySafe" target="_blank" rel="noreferrer">Source code and docs<span className="sr-only"> (opens GitHub in a new tab)</span><ChevronRight className="size-5" aria-hidden /></a></li>
      </ul>
    </div>
  );
  return (
    <section aria-labelledby="demohelp-h" className="mt-10" id="demohelp-h-group">
      <h2 id="demohelp-h" className={eyebrow}>Demo &amp; help</h2>
      <p className="mt-1 text-base text-ink-soft max-w-2xl">{family ? 'Guides and documentation.' : 'This account has sample data, marked “Sample data” everywhere. It is yours alone: other visitors can’t see it.'}</p>
      <div className={`mt-4 ${panel} ${cardPad} grid gap-x-10 gap-y-6 ${family ? '' : 'lg:grid-cols-2'}`}>
        {!family && (
          <div className="min-w-0" aria-labelledby="demo-h" role="group">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="demo-h" className="text-xl flex items-center gap-2"><RotateCcw className="size-6 text-teal shrink-0" aria-hidden />Mary’s demo</h3>
              <Where account />
            </div>
            <ul className="mt-1 divide-y divide-line">
              <li><Link className={linkRow} to="/assistant?welcome=1">Things to try (welcome)<ChevronRight className="size-5" aria-hidden /></Link></li>
              <li><Link className={linkRow} to="/learn/getting-started">Try as Mary: walkthrough<ChevronRight className="size-5" aria-hidden /></Link></li>
            </ul>
            <div className="mt-3 flex flex-col gap-4">
              <TryAsAlex />
              <ResetDemo />
            </div>
          </div>
        )}
        {help}
      </div>
    </section>
  );
}

type Sharing = { shareSummaries: boolean; shareHistory: boolean };
type Circle = { active: { name: string }[]; pendingInvites: number; policy: { thresholdCents: number }; sharing?: Sharing };
const eurFmt = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);

/**
 * Mary's "Family sharing": her limit (only she can change it) and two opt-in switches, both off by default.
 * The server enforces all of it; this only sends Mary's choice.
 */
export function FamilySharingBody({ circle, onChange }: { circle: Circle; onChange: (c: Circle) => void }) {
  const name = circle.active[0]?.name;
  const who = name ?? 'your family helper';
  const Who = name ?? 'Your family helper';
  const sh = circle.sharing ?? { shareSummaries: false, shareHistory: false };
  const [limit, setLimit] = useState(String(circle.policy.thresholdCents / 100));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const flip = async (k: keyof Sharing) => {
    setBusy(k); setErr(null); setMsg(null);
    try { const next = await api<Sharing>('/api/family/sharing', { body: { [k]: !sh[k] } }); onChange({ ...circle, sharing: { shareSummaries: next.shareSummaries, shareHistory: next.shareHistory } }); }
    catch (e: any) { setErr(e?.message || 'Something went wrong.'); } finally { setBusy(null); }
  };
  const saveLimit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy('limit'); setErr(null); setMsg(null);
    try { const p = await api<{ thresholdCents: number }>('/api/policy', { body: { thresholdEur: Number(limit) } }); onChange({ ...circle, policy: { ...circle.policy, thresholdCents: p.thresholdCents } }); setMsg('Limit saved.'); }
    catch (er: any) { setErr(er?.message || 'Something went wrong.'); } finally { setBusy(null); }
  };
  const row = (k: keyof Sharing, label: string, hint: string) => (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="min-w-0"><span className="block font-bold" id={`fs-${k}`}>{label}</span><span className="block text-base text-ink-soft" id={`fsh-${k}`}>{hint}</span></span>
      <button type="button" role="switch" aria-checked={sh[k]} aria-labelledby={`fs-${k}`} aria-describedby={`fsh-${k}`} onClick={() => void flip(k)} disabled={busy !== null}
        className={switchBtn(sh[k])} data-testid={`share-${k}`}>{sh[k] ? 'On' : 'Off'}</button>
    </div>
  );
  return (
    <>
      <p>{Who} only sees purchases that need their OK. Turn these on if you want them to see more.</p>
      <div className="mt-1 divide-y divide-line">
        {row('shareSummaries', `Share spending summaries with ${who}`, 'Totals by month and type of item. No single purchases.')}
        {row('shareHistory', `Share my purchase history with ${who}`, 'Each Demo Shop purchase. Never your messages, contacts or subscriptions.')}
      </div>
      <form onSubmit={saveLimit} className="mt-2 border-t border-line pt-3 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[9rem]"><label htmlFor="my-limit" className="font-bold block mb-1">My limit in euro</label>
          <input id="my-limit" type="number" min={0} max={500} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} aria-describedby="my-limit-h" className="w-full min-h-12 rounded-2xl border-2 border-line px-4 bg-paper focus:border-teal outline-none" /></div>
        <button type="submit" disabled={busy !== null} className={btnSecondary}>Save</button>
        <p id="my-limit-h" className="w-full text-base text-ink-soft">Above {eurFmt(circle.policy.thresholdCents)}, {who} checks first. Only you can change this.</p>
      </form>
      {msg && <p role="status" className="mt-2 text-teal font-bold">{msg}</p>}
      {err && <p role="alert" className="mt-2 text-danger font-bold">{err}</p>}
    </>
  );
}
/** Mary's family circle in Profile: loading, an explicit error with Retry (never a silent blank), or the circle. */
export function FamilyCircleBody({ circle, error, onRetry }: { circle: Circle | null; error: string | null; onRetry: () => void }) {
  if (error) return (
    <div role="alert" data-testid="family-circle-error">
      <p className="font-bold text-danger">Couldn’t load your family circle: {error}</p>
      <p className="mt-1 text-base text-ink-soft">This is a loading error, not an empty circle. Your family settings are unchanged.</p>
      <button type="button" onClick={onRetry} className={`mt-3 ${btnSecondary}`}>Retry</button>
    </div>
  );
  if (circle === null) return <p className="text-ink-soft" role="status">Loading…</p>;
  return (
    <>
      <p className="font-bold">{circle.active.length ? `Connected: ${circle.active.map((a) => a.name).join(', ')}` : 'No family member connected yet.'}</p>
      <p className="mt-1 text-base text-ink-soft">Above {eurFmt(circle.policy.thresholdCents)} they review first. They see only those purchases.{circle.pendingInvites ? ` ${circle.pendingInvites} unused invite code${circle.pendingInvites > 1 ? 's' : ''}.` : ''}</p>
      <ul className="mt-1 divide-y divide-line"><li><Link to="/help" className={linkRow}>{circle.active.length ? 'Family help and invite codes' : 'Invite a family member'}<ChevronRight className="size-5" aria-hidden /></Link></li></ul>
    </>
  );
}

export default function Profile() {
  const { role, name, loading } = useShellRole();
  const nav = useNavigate();
  const cfg = useConfig();
  const family = role === 'family';
  const [circle, setCircle] = useState<Circle | null>(null);
  const [circleErr, setCircleErr] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  // Family circle: an error is shown as an error with Retry, never as an endless "Loading…".
  const loadCircle = () => { setCircleErr(null); setCircle(null); api<Circle>('/api/family/status').then(setCircle).catch((e) => setCircleErr(e?.message || 'Something went wrong.')); };
  useEffect(() => { if (!loading && !role) nav('/', { replace: true }); }, [loading, role, nav]);
  useEffect(() => { if (role === 'elder') loadCircle(); }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || !role) return <Layout><p>Loading…</p></Layout>;
  // Clears this device's conversation and, for Mary, the short conversation context SaySafe keeps (remembered preferences stay).
  const clearConversation = () => { try { sessionStorage.removeItem(family ? FAMILY_THREAD_KEY : THREAD_KEY); } catch { /* */ } if (!family) api('/api/memory', { method: 'DELETE', body: { confirm: true, scope: 'context' } }).catch(() => {}); setCleared(true); };

  const voice = !family && (
    <Section key="voice" id="voice-h" icon={Volume2} title="Voice & conversation" where={<Where />}>
      <MuteSwitch />
      <div className="mt-2 border-t border-line pt-2"><VoiceSettings parts="voice" /></div>
      <p className="mt-3 text-base text-ink-soft">Voice controls appear only while SaySafe listens or speaks. Press Escape to stop.</p>
    </Section>
  );
  const a11y = (
    <Section key="a11y" id="a11y-h" icon={Accessibility} title="Accessibility" where={<Where />}>
      <div className="-mt-1 divide-y divide-line">
        <Toggle k="large" label="Bigger text" hint="Larger text and buttons." />
        <Toggle k="contrast" label="High contrast" hint="Stronger colours and outlines." />
        <Toggle k="motion" label="Reduce motion" hint="No animations." />
      </div>
    </Section>
  );
  const lang = !family && (
    <Section key="lang" id="lang-h" icon={Languages} title="Language" where={<Where />}>
      <LanguageSetting />
      <p className="mt-2 text-base text-ink-soft">Beta: replies only. Screens stay in English.</p>
    </Section>
  );
  const shopping = !family && <ShoppingSummary key="shop" />;
  const sharingCard = !family && circle && (
    <Section key="sharing" id="sharing-h" icon={Users} title="Family sharing" where={<Where account />}>
      <FamilySharingBody circle={circle} onChange={setCircle} />
    </Section>
  );
  const familyCard = (
    <Section key="family" id="family-h" icon={Users} title="Trusted family" where={<Where account />}>
      {family ? (
        <>
          <p>You review bigger purchases. You can’t pay from their account.</p>
          <p className="mt-1 text-base text-ink-soft">You see only the purchases sent to you, plus anything they choose to share. Only they can change their limit.</p>
          <ul className="mt-2 divide-y divide-line">
            <li><Link className={linkRow} to="/family">Waiting for you<ChevronRight className="size-5" aria-hidden /></Link></li>
            <li><Link className={linkRow} to="/family/assistant"><span className="inline-flex items-center gap-2"><MessageCircle className="size-5 text-teal" aria-hidden />Assistant</span><ChevronRight className="size-5" aria-hidden /></Link></li>
            {cfg?.insights !== false && <li><Link className={linkRow} to="/family/insights"><span className="inline-flex items-center gap-2"><BarChart3 className="size-5 text-teal" aria-hidden />Safety insights</span><ChevronRight className="size-5" aria-hidden /></Link></li>}
            {cfg?.insightsDashboard === 'agstudio' && agStudioLicenseKey(import.meta.env) && <li><Link className={linkRow} to="/family/insights/studio">Insights: AG Studio view<ChevronRight className="size-5" aria-hidden /></Link></li>}
            <li><Link className={linkRow} to="/home">Back to Mary (if you’re trying the demo)<ChevronRight className="size-5" aria-hidden /></Link></li>
          </ul>
        </>
      ) : <FamilyCircleBody circle={circle} error={circleErr} onRetry={loadCircle} />}
    </Section>
  );
  const privacy = (
    <Section key="privacy" id="privacy-h" icon={Lock} title="Privacy & data">
      <ul className="space-y-1.5 text-base list-disc pl-5">
        <li><span className="font-bold">PayPal Sandbox — no real money.</span> You approve at PayPal; SaySafe never sees your PayPal password.</li>
        <li>Messages you check aren’t stored, only the result. Family sees it only if you send it.</li>
        <li>Screenshots are read in memory and never saved.</li>
      </ul>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="min-w-0 flex flex-wrap items-center gap-2"><span className="font-bold">Assistant conversation</span><Where /></span>
        <button type="button" onClick={clearConversation} disabled={cleared} className={btnSecondary}>{cleared ? 'Cleared' : 'Clear conversation'}</button>
      </div>
      {!family && <CompanionData />}
    </Section>
  );

  // "What SaySafe remembers": elder only, ON by default (clearly disclosed), saved to the account (never visible to family).
  const memory = !family && (
    <Section key="memory" id="memory-h" icon={Brain} title="What SaySafe remembers" where={<Where account />}>
      <MemoryBody />
    </Section>
  );

  return (
    <Layout mode={family ? 'family' : 'elder'}>
      <header>
        <h1 className="text-[length:var(--text-title)] md:text-[length:var(--text-hero)]">Profile</h1>
        <p className="mt-1 text-ink-soft">{name ? `${name}, ` : ''}{family ? 'your settings as a trusted family member.' : 'your settings.'}</p>
        {/* Quick way to the three groups (and to the demo actions without scrolling past every setting). */}
        <nav aria-label="Profile sections" className="mt-4 flex flex-wrap gap-2">
          {[['personal-h', 'Personal experience'], ['account-h', 'Account & preferences'], ['demohelp-h', family ? 'Help' : 'Demo & help']].map(([id, label]) => (
            <a key={id} href={`#${id}-group`} className="inline-flex items-center min-h-12 px-4 rounded-full border-2 border-line bg-paper font-bold text-base hover:border-teal">{label}</a>
          ))}
        </nav>
      </header>
      <Group id="personal-h" title="Personal experience" lead="How SaySafe speaks, looks and answers. Saved on this device."
        left={voice ? [voice] : [a11y]} right={voice ? [a11y, lang] : []} />
      <Group id="account-h" title="Account & preferences" lead={family ? 'Your role in the household, and your privacy.' : 'What SaySafe remembers for you, who helps you, and your data.'}
        left={family ? [familyCard] : [shopping, familyCard, sharingCard]} right={memory ? [privacy, memory] : [privacy]} />
      <DemoAndHelp family={family} />
    </Layout>
  );
}
