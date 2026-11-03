/**
 * Profile: Voice & conversation, Accessibility, Language, Shopping preferences, Trusted family, Privacy & data,
 * Help & documentation. Every setting says where it is kept: "This device" or "Saved to your account".
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Volume2, Accessibility, Languages, ShoppingBag, Users, Lock, LifeBuoy, BarChart3, ChevronRight, MessageCircle, Smartphone, Cloud } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Card } from '../components/ui';
import { VoiceSettings, LanguageSetting, MuteSwitch } from '../components/VoiceBar';
import { useShellRole } from '../lib/role';
import { useDisplay, setDisplay, type DisplayKey } from '../lib/display';
import { api } from '../lib/api';
import { loadProfile, clearProfile } from '../lib/prefs';
import { useConfig } from '../lib/insightsApi';
import { THREAD_KEY, FAMILY_THREAD_KEY } from '../assistant/thread';
import type { ShoppingProfile } from '../../../shared/shopping';

/** Where a setting lives. */
export function Where({ account }: { account?: boolean }) {
  return account
    ? <span className="inline-flex items-center gap-1 rounded-full border border-teal/40 bg-teal-soft text-teal-deep px-2.5 py-0.5 text-sm font-bold whitespace-nowrap"><Cloud className="size-4" aria-hidden />Saved to your account</span>
    : <span className="inline-flex items-center gap-1 rounded-full border border-line bg-ivory text-navy px-2.5 py-0.5 text-sm font-bold whitespace-nowrap"><Smartphone className="size-4" aria-hidden />This device</span>;
}

function Toggle({ k, label, hint }: { k: DisplayKey; label: string; hint: string }) {
  const d = useDisplay();
  const on = d[k];
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="min-w-0"><span className="block font-bold" id={`t-${k}`}>{label}</span><span className="block text-base text-ink-soft" id={`th-${k}`}>{hint}</span></span>
      <button type="button" role="switch" aria-checked={on} aria-labelledby={`t-${k}`} aria-describedby={`th-${k}`} onClick={() => setDisplay(k, !on)}
        className={`shrink-0 min-h-12 min-w-20 px-4 rounded-full border-2 font-bold ${on ? 'bg-navy text-white border-navy' : 'bg-paper border-line hover:border-teal'}`}>{on ? 'On' : 'Off'}</button>
    </div>
  );
}

const linkRow = 'flex items-center justify-between gap-3 py-3 min-h-14 font-bold hover:text-teal';
function Section({ id, icon: Icon, title, where, children }: { id: string; icon: typeof Lock; title: string; where?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5 md:p-6" aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-2xl flex items-center gap-2"><Icon className="size-6 text-teal shrink-0" aria-hidden />{title}</h2>
        {where}
      </div>
      <div className="mt-2">{children}</div>
    </Card>
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
      <p className="mt-2 font-bold">{empty ? 'Nothing saved yet.' : `${parts.join(', ')}${p!.profile.budgetMax !== null ? ` · usual budget €${p!.profile.budgetMax}` : ''}`}</p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        <Link to="/preferences" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">{empty ? 'Add preferences' : 'Edit'}</Link>
        {!empty && <button type="button" onClick={() => clearProfile().then(() => { setP(p && { ...p, profile: { ...p.profile, brands: [], colours: [], styles: [], avoid: [], categories: [], budgetMax: null } }); setMsg('Cleared.'); }).catch((e) => setMsg(e.message))} className="font-bold text-danger underline underline-offset-4 min-h-12">Clear</button>}
      </div>
      {msg && <p role="status" className="text-base font-bold">{msg}</p>}
    </Section>
  );
}

export default function Profile() {
  const { role, name, loading } = useShellRole();
  const nav = useNavigate();
  const cfg = useConfig();
  const family = role === 'family';
  const [circle, setCircle] = useState<{ active: { name: string }[]; pendingInvites: number; policy: { thresholdCents: number } } | null>(null);
  const [cleared, setCleared] = useState(false);
  useEffect(() => { if (!loading && !role) nav('/', { replace: true }); }, [loading, role, nav]);
  useEffect(() => { if (role === 'elder') api('/api/family/status').then(setCircle).catch(() => {}); }, [role]);

  if (loading || !role) return <Layout><p>Loading…</p></Layout>;
  const clearConversation = () => { try { sessionStorage.removeItem(family ? FAMILY_THREAD_KEY : THREAD_KEY); } catch { /* */ } setCleared(true); };
  return (
    <Layout mode={family ? 'family' : 'elder'}>
      <h1 className="text-[length:var(--text-title)] md:text-[length:var(--text-hero)]">Profile</h1>
      <p className="mt-1 text-ink-soft">{name ? `${name}, ` : ''}{family ? 'your settings as a trusted family member.' : 'your settings.'}</p>
      <div className="mt-6 grid gap-5 lg:grid-cols-2 items-start">
        {!family && (
          <Section id="voice-h" icon={Volume2} title="Voice & conversation" where={<Where />}>
            <MuteSwitch />
            <VoiceSettings parts="voice" />
            <p className="mt-2 text-base text-ink-soft">Voice controls only appear while SaySafe listens or speaks. Press Escape to stop.</p>
          </Section>
        )}
        <Section id="a11y-h" icon={Accessibility} title="Accessibility" where={<Where />}>
          <div className="divide-y divide-line">
            <Toggle k="large" label="Bigger text" hint="Larger text and buttons." />
            <Toggle k="contrast" label="High contrast" hint="Stronger colours and outlines." />
            <Toggle k="motion" label="Reduce motion" hint="No animations." />
          </div>
        </Section>
        {!family && (
          <Section id="lang-h" icon={Languages} title="Language" where={<Where />}>
            <LanguageSetting />
            <p className="mt-1 text-base text-ink-soft">Beta: replies only. Screens stay in English.</p>
          </Section>
        )}
        {!family && <ShoppingSummary />}
        <Section id="family-h" icon={Users} title="Trusted family" where={<Where account />}>
          {family ? (
            <>
              <p>You review bigger purchases. You can’t pay from their account.</p>
              <ul className="mt-2 divide-y divide-line">
                <li><Link className={linkRow} to="/family">Waiting for you and limits<ChevronRight className="size-5" aria-hidden /></Link></li>
                <li><Link className={linkRow} to="/family/assistant"><span className="inline-flex items-center gap-2"><MessageCircle className="size-5 text-teal" aria-hidden />Assistant</span><ChevronRight className="size-5" aria-hidden /></Link></li>
                {cfg?.insights !== false && <li><Link className={linkRow} to="/family/insights"><span className="inline-flex items-center gap-2"><BarChart3 className="size-5 text-teal" aria-hidden />Safety insights</span><ChevronRight className="size-5" aria-hidden /></Link></li>}
                {cfg?.insightsDashboard && <li><Link className={linkRow} to="/family/insights/studio">Insights: AG Studio view<ChevronRight className="size-5" aria-hidden /></Link></li>}
              </ul>
            </>
          ) : circle === null ? <p className="text-ink-soft">Loading…</p> : (
            <>
              <p className="font-bold">{circle.active.length ? `Connected: ${circle.active.map((a) => a.name).join(', ')}` : 'No family member connected yet.'}</p>
              <p className="mt-1 text-base text-ink-soft">Above {new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(circle.policy.thresholdCents / 100)} they review first.{circle.pendingInvites ? ` ${circle.pendingInvites} unused invite code${circle.pendingInvites > 1 ? 's' : ''}.` : ''}</p>
              <Link to="/help" className={linkRow}>{circle.active.length ? 'Family help and invite codes' : 'Invite a family member'}<ChevronRight className="size-5" aria-hidden /></Link>
            </>
          )}
        </Section>
        <Section id="privacy-h" icon={Lock} title="Privacy & data">
          <ul className="space-y-1.5 text-base list-disc pl-5">
            <li><span className="font-bold">PayPal Sandbox — no real money.</span> You approve at PayPal; SaySafe never sees your PayPal password.</li>
            <li>Messages you check aren’t stored, only the result. Family sees it only if you send it.</li>
            <li>Screenshots are read in memory and never saved.</li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <span className="min-w-0"><span className="block font-bold">Assistant conversation</span><Where /></span>
            <button type="button" onClick={clearConversation} disabled={cleared} className="min-h-12 px-4 rounded-full border-2 border-line font-bold hover:border-teal disabled:opacity-60">{cleared ? 'Cleared' : 'Clear conversation'}</button>
          </div>
        </Section>
        <Section id="help-h" icon={LifeBuoy} title="Help & documentation">
          <ul className="divide-y divide-line">
            {!family && <li><Link className={linkRow} to="/help">Get trusted help<ChevronRight className="size-5" aria-hidden /></Link></li>}
            <li><Link className={linkRow} to="/guide">How to use SaySafe<ChevronRight className="size-5" aria-hidden /></Link></li>
            <li><a className={linkRow} href="https://github.com/laxmanprasadsomaraju/SaySafe" target="_blank" rel="noreferrer">Source code and docs<span className="sr-only"> (opens GitHub in a new tab)</span><ChevronRight className="size-5" aria-hidden /></a></li>
          </ul>
        </Section>
      </div>
    </Layout>
  );
}
