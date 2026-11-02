import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, ShoppingBag, Users, ArrowRight } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, SandboxBadge } from '../components/ui';
import { api } from '../lib/api';

export default function Welcome() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/demo/start', { body: { name: 'Mary' } }); nav('/home'); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const points = [
    { icon: ShieldCheck, title: 'Checks messages for scams', text: 'Paste a text, email, link or screenshot. SaySafe explains the warning signs in plain words.' },
    { icon: ShoppingBag, title: 'Shop by voice, pay with PayPal', text: 'Say what you need. Hear the options and the exact price, then approve the payment yourself at PayPal.' },
    { icon: Users, title: 'Family can help with bigger buys', text: 'Over your limit? A trusted family member reviews it first. They can never pay from your account.' },
  ];
  return (
    <Layout mode="public">
      <section className="grid md:grid-cols-[1.15fr_1fr] gap-10 items-center fade-up">
        <div>
          <SandboxBadge />
          <h1 className="mt-5 text-[length:var(--text-hero)] md:text-[3.5rem]">Shop simply.<br /><span className="text-teal">Pay safely.</span></h1>
          <p className="mt-5 text-[length:var(--text-lead)] text-ink-soft max-w-xl">SaySafe is a voice-first helper that lets older adults shop, spot scams, and pay with PayPal — with a trusted family member one tap away.</p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Button onClick={start} busy={busy} icon={<ArrowRight className="size-6" aria-hidden />}>Try the demo as Mary</Button>
          </div>
          {err && <p role="alert" className="mt-4 text-danger font-bold">{err}</p>}
          <p className="mt-4 text-base text-ink-soft">No sign-up. You get your own private demo space with sample data.</p>
        </div>
        <Card className="p-7 md:p-8">
          <p className="text-ink-soft font-bold">Mary asks:</p>
          <p className="font-display text-2xl mt-1">“Is this message really from PayPal?”</p>
          <div className="mt-5 rounded-2xl bg-danger-soft border-l-[6px] border-danger px-5 py-4">
            <p className="font-bold text-danger">This message may be a scam.</p>
            <p className="text-ink-soft mt-1 text-lg">It pressures you to pay €149 now, and the link pretends to be PayPal but goes to another website.</p>
          </div>
          <p className="mt-4 text-lg text-ink-soft">Safe next step: open PayPal's official help page.</p>
        </Card>
      </section>
      <section aria-label="What SaySafe does" className="mt-14 grid md:grid-cols-3 gap-5">
        {points.map(({ icon: Icon, title, text }) => (
          <Card key={title} className="p-6">
            <Icon className="size-9 text-teal" aria-hidden />
            <h2 className="text-2xl mt-3">{title}</h2>
            <p className="mt-2 text-ink-soft text-lg">{text}</p>
          </Card>
        ))}
      </section>
    </Layout>
  );
}
