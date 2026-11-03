/** Profile: voice, accessibility, shopping preferences, family circle, help, privacy and the sandbox notice. */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Volume2, Accessibility, Users, LifeBuoy, Lock, BarChart3, ChevronRight, Info } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Card } from '../components/ui';
import { VoiceSettings } from '../components/VoiceBar';
import { ShoppingPrefsForm } from './Preferences';
import { useShellRole } from '../lib/role';
import { useDisplay, setDisplay, type DisplayKey } from '../lib/display';
import { api } from '../lib/api';
import { useConfig } from '../lib/insightsApi';

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
function Section({ id, icon: Icon, title, children }: { id: string; icon: typeof Info; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 md:p-6" aria-labelledby={id}>
      <h2 id={id} className="text-2xl flex items-center gap-2"><Icon className="size-6 text-teal shrink-0" aria-hidden />{title}</h2>
      <div className="mt-2">{children}</div>
    </Card>
  );
}

export default function Profile() {
  const { role, name, loading } = useShellRole();
  const nav = useNavigate();
  const cfg = useConfig();
  const family = role === 'family';
  const [circle, setCircle] = useState<{ active: { name: string }[]; pendingInvites: number; policy: { thresholdCents: number } } | null>(null);
  useEffect(() => { if (!loading && !role) nav('/', { replace: true }); }, [loading, role, nav]);
  useEffect(() => { if (role === 'elder') api('/api/family/status').then(setCircle).catch(() => {}); }, [role]);

  if (loading || !role) return <Layout><p>Loading…</p></Layout>;
  return (
    <Layout mode={family ? 'family' : 'elder'}>
      <h1 className="text-[length:var(--text-title)] md:text-[length:var(--text-hero)]">Profile</h1>
      <p className="mt-1 text-ink-soft">{name ? `${name}, ` : ''}{family ? 'your settings as a trusted family member.' : 'your settings. They stay on this device unless it says otherwise.'}</p>
      <div className="mt-6 grid gap-5 lg:grid-cols-2 items-start">
        {!family && (
          <Section id="voice-h" icon={Volume2} title="Voice">
            <p className="text-base text-ink-soft mb-3">SaySafe speaks short replies and never reads every card unless you turn on Read everything. Reply language is a beta feature: screens stay in English.</p>
            <VoiceSettings />
          </Section>
        )}
        <Section id="a11y-h" icon={Accessibility} title="Accessibility">
          <div className="divide-y divide-line">
            <Toggle k="large" label="Bigger text" hint="Makes all text and buttons larger." />
            <Toggle k="contrast" label="High contrast" hint="Stronger colours and outlines." />
            <Toggle k="motion" label="Reduce motion" hint="No animations. Your device setting is always respected too." />
          </div>
        </Section>
        {!family && <div id="shopping"><ShoppingPrefsForm headingLevel="h2" /></div>}
        <Section id="family-h" icon={Users} title="Family circle">
          {family ? (
            <>
              <p>You review bigger purchases. You can’t make payments from their account: they always approve at PayPal themselves.</p>
              <ul className="mt-2 divide-y divide-line">
                <li><Link className={linkRow} to="/family">Waiting for you and limits<ChevronRight className="size-5" aria-hidden /></Link></li>
                {cfg?.insights !== false && <li><Link className={linkRow} to="/family/insights"><span className="inline-flex items-center gap-2"><BarChart3 className="size-5 text-teal" aria-hidden />Safety insights</span><ChevronRight className="size-5" aria-hidden /></Link></li>}
                {cfg?.insightsDashboard && <li><Link className={linkRow} to="/family/insights/studio">Insights: AG Studio view<ChevronRight className="size-5" aria-hidden /></Link></li>}
              </ul>
            </>
          ) : circle === null ? <p className="text-ink-soft">Loading…</p> : (
            <>
              <p className="font-bold">{circle.active.length ? `Connected: ${circle.active.map((a) => a.name).join(', ')}` : 'No family member connected yet.'}</p>
              <p className="mt-1 text-base text-ink-soft">Purchases above {new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(circle.policy.thresholdCents / 100)} need their review first.{circle.pendingInvites ? ` ${circle.pendingInvites} invite code${circle.pendingInvites > 1 ? 's' : ''} not used yet.` : ''}</p>
              <Link to="/help" className={linkRow}>{circle.active.length ? 'Family help and invite codes' : 'Invite a family member'}<ChevronRight className="size-5" aria-hidden /></Link>
            </>
          )}
        </Section>
        <Section id="help-h" icon={LifeBuoy} title="Help">
          <ul className="divide-y divide-line">
            {!family && <li><Link className={linkRow} to="/help">Get trusted help<ChevronRight className="size-5" aria-hidden /></Link></li>}
            <li><Link className={linkRow} to="/guide">How to use SaySafe (guide)<ChevronRight className="size-5" aria-hidden /></Link></li>
          </ul>
        </Section>
        <Section id="privacy-h" icon={Lock} title="Privacy and payments">
          <p className="font-bold">PayPal Sandbox — no real money.</p>
          <p className="mt-1 text-base text-ink-soft">This demo uses PayPal’s test system. You always approve payments at PayPal, and SaySafe never sees your PayPal password.</p>
          <ul className="mt-3 space-y-2 text-base text-ink-soft list-disc pl-5">
            <li>Your shopping preferences are private to you. Family members can’t see them, and shops don’t get them.</li>
            <li>Messages you check are not stored, only the result. Your family sees a result only if you send it.</li>
            <li>Screenshots are read in memory and never saved.</li>
            <li>Other shops found with Channel3 are for comparing. You buy on their own website.</li>
          </ul>
        </Section>
      </div>
    </Layout>
  );
}
