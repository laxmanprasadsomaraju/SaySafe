import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ExternalLink, Mail, PackageX, Users, Receipt, ShieldCheck, Phone } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, Notice } from '../components/ui';
import { api, eur, type PaymentRequest } from '../lib/api';
import { speak } from '../lib/voice';
import { useMe } from '../lib/session';

interface Trusted { helpPages: { id: string; label: string; value: string; verifiedOn: string; note?: string }[]; emails: { value: string; label: string; verifiedOn: string }[] }

export default function Help() {
  const me = useMe('elder');
  const nav = useNavigate();
  const loc = useLocation() as { state?: { problem?: boolean; requestId?: string } };
  const [trusted, setTrusted] = useState<Trusted | null>(null);
  const [orders, setOrders] = useState<PaymentRequest[]>([]);
  const [selected, setSelected] = useState<PaymentRequest | null>(null);
  const [invite, setInvite] = useState<{ code: string; expiresInMinutes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Trusted>('/api/trusted').then(setTrusted);
    if (!me) return;
    api<PaymentRequest[]>('/api/payments').then((o) => {
      const paid = o.filter((x) => x.state === 'CAPTURED' || x.state === 'REFUNDED');
      setOrders(paid);
      if (loc.state?.problem) {
        const pick = paid.find((x) => x.id === loc.state?.requestId) ?? paid[0] ?? null;
        setSelected(pick);
        if (pick) speak(`Sorry your ${pick.items[0].name} hasn't arrived. Start by contacting the shop; the steps are on screen.`);
      }
    });
  }, [me]); // eslint-disable-line

  const makeInvite = async () => { setErr(null); try { setInvite(await api('/api/family/invite', { body: {} })); } catch (e: any) { setErr(e.message); } };
  const page = (id: string) => trusted?.helpPages.find((p) => p.id === id);

  if (!me) return <Layout><p>Loading…</p></Layout>;
  return (
    <Layout>
      <PageTitle eyebrow="Trusted help" title="Help you can trust" lead="These links go straight to PayPal's own website. Type paypal.com yourself if you are ever unsure. I never give you phone numbers copied from messages." />

      {selected && (
        <Card className="p-6 md:p-8 mb-6 fade-up border-2 border-amber">
          <h2 className="text-2xl flex items-center gap-2"><PackageX className="size-7 text-amber" aria-hidden />Problem with your order</h2>
          <p className="mt-2 text-lg">{selected.items.map((i) => i.name).join(', ')} · {eur(selected.amountCents)} · paid to {selected.receipt?.payee}</p>
          <ol className="mt-5 space-y-4">
            <li className="flex gap-4"><span className="size-9 rounded-full bg-teal text-white grid place-items-center font-bold shrink-0">1</span><div><p className="font-bold">Look at your receipt</p><Button variant="ghost" className="!px-0" icon={<Receipt className="size-5" aria-hidden />} onClick={() => nav(`/order/${selected.id}`)}>Open receipt</Button></div></li>
            <li className="flex gap-4"><span className="size-9 rounded-full bg-teal text-white grid place-items-center font-bold shrink-0">2</span><div><p className="font-bold">Contact the shop first</p><p className="text-ink-soft text-lg">Most delivery problems are fixed by the seller. This is a demo shop, so no real parcel was sent.</p></div></li>
            <li className="flex gap-4"><span className="size-9 rounded-full bg-teal text-white grid place-items-center font-bold shrink-0">3</span><div><p className="font-bold">If it's not sorted, open a case with PayPal</p><p className="text-ink-soft text-lg">You do this yourself inside PayPal's Resolution Centre. SaySafe does not open cases for you and cannot promise a refund.</p>
              {page('help-resolution') && <a href={page('help-resolution')!.value} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-2 font-bold text-teal underline underline-offset-4 min-h-12">{page('help-resolution')!.label}<ExternalLink className="size-5" aria-hidden /></a>}
            </div></li>
            <li className="flex gap-4"><span className="size-9 rounded-full bg-teal text-white grid place-items-center font-bold shrink-0">4</span><div><p className="font-bold">Ask your family to help</p><p className="text-ink-soft text-lg">They can see this purchase in their SaySafe view.</p></div></li>
          </ol>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-5">
        <Card className="p-6">
          <h2 className="text-2xl flex items-center gap-2"><ShieldCheck className="size-7 text-teal" aria-hidden />Official PayPal help</h2>
          <ul className="mt-4 space-y-3">
            {trusted?.helpPages.map((p) => (
              <li key={p.id}>
                <a href={p.value} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3 rounded-2xl border-2 border-line hover:border-teal px-5 min-h-16 font-bold">{p.label}<ExternalLink className="size-5 shrink-0" aria-hidden /></a>
                <p className="text-sm text-ink-soft mt-1 px-1">Checked on {p.verifiedOn} · {new URL(p.value).hostname}</p>
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-5">
          <Card className="p-6">
            <h2 className="text-2xl flex items-center gap-2"><Mail className="size-7 text-teal" aria-hidden />Report a fake message</h2>
            <p className="mt-2 text-lg">Forward the whole message to <span className="font-bold">{trusted?.emails[0]?.value ?? 'phishing@paypal.com'}</span>, then delete it.</p>
            <p className="mt-1 text-base text-ink-soft">This address is for reporting only. PayPal will never ask you to pay or share a code by email.</p>
          </Card>
          <Card className="p-6">
            <h2 className="text-2xl flex items-center gap-2"><Phone className="size-7 text-teal" aria-hidden />Phone numbers</h2>
            <p className="mt-2 text-lg">Don't call numbers from texts or emails. Use the official contact page to reach PayPal.</p>
          </Card>
          <Card className="p-6">
            <h2 className="text-2xl flex items-center gap-2"><Users className="size-7 text-teal" aria-hidden />Your trusted family member</h2>
            <p className="mt-2 text-lg">Give them this one-time code so they can join your SaySafe. They can review bigger purchases and see alerts you share. They can never pay from your account.</p>
            {invite ? (
              <div className="mt-4 rounded-2xl bg-teal-soft p-5 text-center">
                <p className="text-ink-soft">Your code</p>
                <p className="font-display text-5xl tracking-[0.2em] font-semibold mt-1" aria-label={invite.code.split('').join(' ')}>{invite.code}</p>
                <p className="text-base text-ink-soft mt-2">Works once, for {invite.expiresInMinutes} minutes. They enter it at <span className="font-bold">{location.host}/family</span></p>
                <a href={`/family/pair?code=${invite.code}`} target="_blank" rel="noopener" className="mt-3 inline-block font-bold text-teal underline underline-offset-4">Demo: open Alex's family view in a new tab</a>
              </div>
            ) : <Button className="mt-4" variant="secondary" onClick={makeInvite}>Create a family code</Button>}
            {err && <div className="mt-3"><Notice tone="danger" title={err} /></div>}
          </Card>
          {!selected && orders.length > 0 && <Button variant="secondary" className="w-full" icon={<PackageX className="size-6" aria-hidden />} onClick={() => setSelected(orders[0])}>My order hasn't arrived</Button>}
        </div>
      </div>
    </Layout>
  );
}
