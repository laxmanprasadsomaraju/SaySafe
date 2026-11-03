import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Check, X, ShieldAlert, Clock, Wallet, BarChart3 } from 'lucide-react';
import { useConfig } from '../lib/insightsApi';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, Notice, SandboxBadge } from '../components/ui';
import { api, eur, type PaymentRequest } from '../lib/api';
import { stateLabel } from './Order';

export function FamilyPair() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [code, setCode] = useState(sp.get('code') ?? '');
  const [name, setName] = useState('Alex');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('/api/family/pair', { body: { code: code.trim(), name } }); nav('/family'); }
    catch (er: any) { setErr(er.message); setBusy(false); }
  };
  return (
    <Layout mode="family">
      <PageTitle eyebrow="Family" title="Join as a trusted family member" lead="Enter the 6-digit code from your relative's SaySafe app." />
      <Card className="p-6 max-w-lg">
        <form onSubmit={submit} className="space-y-5">
          <div><label htmlFor="name" className="font-bold block mb-2">Your first name</label><input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="w-full min-h-14 rounded-2xl border-2 border-line px-5 bg-paper focus:border-teal outline-none" /></div>
          <div><label htmlFor="code" className="font-bold block mb-2">Code</label><input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-full min-h-16 rounded-2xl border-2 border-line px-5 bg-paper focus:border-teal outline-none font-display text-4xl tracking-[0.3em]" /></div>
          {err && <Notice tone="danger" title={err} />}
          <Button type="submit" busy={busy} className="w-full">Join</Button>
        </form>
      </Card>
    </Layout>
  );
}

interface Overview { me: { name: string }; elder: { name: string }; policy: { thresholdCents: number; currency: string }; requests: PaymentRequest[]; alerts: { id: string; verdict: string; summary: string; created_at: string }[] }

export default function Family() {
  const nav = useNavigate();
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const cfg = useConfig();

  const inFlight = useRef(false);
  const load = () => {
    if (inFlight.current) return Promise.resolve(); // polling: never stack requests while the server is waking up
    inFlight.current = true;
    return api<Overview>('/api/family/overview').then((x) => { setO(x); setErr((p) => (p?.startsWith('We could not reach') ? null : p)); setLimit((x.policy.thresholdCents / 100).toString()); }).catch((e) => { if (e.status === 401) nav('/family/pair', { replace: true }); else setErr(e.message); }).finally(() => { inFlight.current = false; });
  };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []); // eslint-disable-line

  const decide = async (r: PaymentRequest, decision: 'approve' | 'decline') => {
    setBusyId(r.id); setErr(null);
    try { await api(`/api/family/requests/${r.id}/decision`, { body: { decision, approvalId: r.approval!.id } }); await load(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusyId(null); }
  };
  const saveLimit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setSaved(false);
    try { await api('/api/family/policy', { body: { thresholdEur: Number(limit) } }); setSaved(true); load(); } catch (er: any) { setErr(er.message); }
  };

  if (!o) return <Layout mode="family">{err ? <Notice tone="danger" title={err} /> : <p>Loading…</p>}</Layout>;
  const pending = o.requests.filter((r) => r.state === 'FAMILY_APPROVAL_PENDING' && r.approval?.status === 'pending');
  const history = o.requests.filter((r) => !pending.includes(r));
  return (
    <Layout mode="family">
      <PageTitle eyebrow={`Family view · ${o.me.name}`} title={`Helping ${o.elder.name} stay safe`} lead="You can review bigger purchases. You can't make payments from their account — they always approve at PayPal themselves." />
      {err && <div className="mb-6"><Notice tone="danger" title={err} /></div>}
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-6 items-start">
        <section aria-labelledby="pending-h" className="space-y-4">
          <h2 id="pending-h" className="text-2xl flex items-center gap-2"><Clock className="size-6 text-amber" aria-hidden />Waiting for you ({pending.length})</h2>
          {pending.length === 0 && <Card className="p-6 text-ink-soft">Nothing to review right now.</Card>}
          {pending.map((r) => (
            <Card key={r.id} as="article" className="p-6 border-2 border-amber fade-up">
              <div className="flex flex-wrap justify-between gap-2"><p className="font-bold text-amber">Above {o.elder.name}'s limit of {eur(o.policy.thresholdCents)}</p><SandboxBadge /></div>
              <div className="mt-4 flex flex-wrap gap-4 items-center">
                <img src={`/products/${r.items[0].image}`} alt="" className="size-20 rounded-2xl object-cover bg-teal-soft" />
                <div className="flex-1 min-w-[9rem]"><h3 className="text-xl">{r.items.map((i) => `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`).join(', ')}</h3><p className="text-ink-soft text-lg">{r.merchant}</p></div>
                <p className="font-display text-3xl font-semibold">{eur(r.amountCents)}</p>
              </div>
              <p className="mt-3 text-base text-ink-soft">Expires at {new Date(r.approval!.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Your answer applies only to this exact item and price.</p>
              <div className="mt-4 grid sm:grid-cols-2 gap-3">
                <Button onClick={() => decide(r, 'approve')} busy={busyId === r.id} icon={<Check className="size-6" aria-hidden />}>Approve</Button>
                <Button variant="danger" onClick={() => decide(r, 'decline')} disabled={busyId === r.id} icon={<X className="size-6" aria-hidden />}>Decline</Button>
              </div>
            </Card>
          ))}
          <h2 className="text-2xl pt-4">Recent activity</h2>
          <Card className="p-2">
            {history.length === 0 ? <p className="p-4 text-ink-soft">No purchases yet.</p> : (
              <ul className="divide-y divide-line">
                {history.slice(0, 10).map((r) => (
                  <li key={r.id} className="p-4 flex flex-wrap items-center gap-3 justify-between">
                    <div><p className="font-bold">{r.items.map((i) => i.name).join(', ')}</p><p className="text-ink-soft text-base">{eur(r.amountCents)} · {stateLabel(r.state)}{r.approval?.status && r.approval.status !== 'pending' ? ` · you ${r.approval.status}` : ''}</p></div>
                    {r.refund?.status === 'REFUND_REQUESTED' && <span className="text-base font-bold text-ink-soft">Refund request sent — not refunded yet</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
        <aside className="space-y-5">
          {cfg?.insights !== false && (
            <Card className="p-6">
              <h2 className="text-2xl flex items-center gap-2"><BarChart3 className="size-6 text-teal" aria-hidden />Safety insights</h2>
              <p className="mt-2 text-lg text-ink-soft">Purchases, your decisions, PayPal confirmations and shared scam checks over time.</p>
              <Link to="/family/insights" className="mt-3 inline-block font-bold text-teal underline text-lg">Open insights dashboard</Link>
            </Card>
          )}
          <Card className="p-6">
            <h2 className="text-2xl flex items-center gap-2"><Wallet className="size-6 text-teal" aria-hidden />Protected limit</h2>
            <p className="mt-2 text-lg text-ink-soft">Purchases above this need your review first.</p>
            <form onSubmit={saveLimit} className="mt-4 flex gap-3 items-end">
              <div className="flex-1"><label htmlFor="limit" className="font-bold block mb-2">Limit in euro</label><input id="limit" type="number" min={0} max={500} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} className="w-full min-h-14 rounded-2xl border-2 border-line px-5 bg-paper focus:border-teal outline-none" /></div>
              <Button type="submit" variant="secondary">Save</Button>
            </form>
            {saved && <p role="status" className="mt-2 text-teal font-bold">Saved.</p>}
          </Card>
          <Card className="p-6">
            <h2 className="text-2xl flex items-center gap-2"><ShieldAlert className="size-6 text-danger" aria-hidden />Alerts {o.elder.name} shared</h2>
            {o.alerts.length === 0 ? <p className="mt-2 text-ink-soft">None yet.</p> : (
              <ul className="mt-3 space-y-3">
                {o.alerts.map((a) => (
                  <li key={a.id} className={`rounded-2xl p-4 border-l-[6px] ${a.verdict === 'suspicious' ? 'bg-danger-soft border-danger' : 'bg-amber-soft border-amber'}`}>
                    <p className="font-bold">{a.summary}</p><p className="text-base text-ink-soft">{new Date(a.created_at + 'Z').toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-sm text-ink-soft">For privacy, only the result is shared — not the message itself.</p>
          </Card>
        </aside>
      </div>
    </Layout>
  );
}
