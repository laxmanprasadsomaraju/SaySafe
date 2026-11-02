import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, ShoppingBag, Users, ArrowRight, MessageSquareWarning, Mic, BadgeCheck, Lock, Eye, Volume2, CheckCircle2, CircleDashed } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, SandboxBadge } from '../components/ui';
import { api } from '../lib/api';

/** Public landing page: what SaySafe is, why it is safe, and how to try it in three steps. */
export default function Welcome() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async (to = '/home') => {
    setBusy(true); setErr(null);
    try { await api('/api/demo/start', { body: { name: 'Mary' } }); nav(to); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const phases = [
    { icon: MessageSquareWarning, when: 'Before you pay', title: 'Spot the scam', text: 'Paste or photograph a text, email or link. SaySafe reads it out, shows the warning signs, and points you to PayPal’s real help page — never a phone number from the message.' },
    { icon: Users, when: 'While you pay', title: 'Family in the loop', text: 'Anything over your limit waits for a trusted family member to approve. Then you still approve it yourself at PayPal. Nobody can pay for you.' },
    { icon: Volume2, when: 'After you pay', title: 'A receipt you can hear', text: 'SaySafe checks with PayPal that the money really went through, then tells you what you bought, what it cost, and where it is going.' },
  ];
  const steps = [
    { n: '1', title: 'Start the demo', text: 'One tap. No sign-up. You get a private practice space as “Mary”.' },
    { n: '2', title: 'Check a fake message', text: 'Pick a sample “PayPal support” text and hear why it is a scam.' },
    { n: '3', title: 'Buy a kettle by voice', text: 'Say “I need a kettle”, then pay with a PayPal sandbox test account. No real money.' },
  ];
  const promises = [
    { icon: Lock, text: 'SaySafe never sees your PayPal password or card.' },
    { icon: BadgeCheck, text: 'It never calls a message “safe”. It tells you what it found and the safe next step.' },
    { icon: ShieldCheck, text: 'Family approval is checked on our server, so it cannot be skipped by a trick or a chatbot.' },
    { icon: Eye, text: 'Big text, high contrast, spoken help with captions on every screen.' },
  ];
  const real = [
    ['PayPal Orders v2 sandbox: create, approve, capture', true],
    ['Groq AI: scam explanations and voice shopping', true],
    ['Server-side family approval and spending limit', true],
    ['Products and prices', false, 'demo catalogue'],
    ['Money', false, 'PayPal sandbox only'],
  ] as const;

  return (
    <Layout mode="public">
      {/* Hero */}
      <section className="grid md:grid-cols-[1.1fr_1fr] gap-10 md:gap-14 items-center fade-up">
        <div>
          <SandboxBadge />
          <h1 className="mt-5 text-[2.6rem] leading-[1.08] md:text-[3.75rem]">The payment guardian that has your back.</h1>
          <p className="mt-5 text-[length:var(--text-lead)] text-ink-soft max-w-xl">SaySafe helps older adults spot scams, shop by voice and pay with PayPal — with a trusted family member one tap away. It protects you before, during and after you pay.</p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Button onClick={() => start()} busy={busy} icon={<ArrowRight className="size-6" aria-hidden />}>Try it free as Mary</Button>
            <a href="#how" className="inline-flex items-center justify-center rounded-full min-h-14 px-7 text-[1.125rem] font-bold border-2 border-line bg-paper hover:border-teal">How it works</a>
          </div>
          {err && <p role="alert" className="mt-4 text-danger font-bold">{err}</p>}
          <p className="mt-4 text-base text-ink-soft">No account needed. Takes about two minutes.</p>
        </div>
        <div className="relative">
          <img src="/hero-mary.webp" alt="A smiling older woman checking her phone at a sunny kitchen table" width={928} height={1152} className="w-full rounded-[2rem] object-cover aspect-[4/5] shadow-[var(--shadow-card)]" />
          <Card className="absolute -bottom-6 left-4 right-4 md:-left-10 md:right-10 p-5" aria-label="Example warning">
            <p className="flex items-center gap-2 font-bold text-danger"><MessageSquareWarning className="size-6" aria-hidden />This message may be a scam</p>
            <p className="mt-1 text-lg text-ink-soft">“PayPal support” asked you to call a number and pay €149 today. Real PayPal never does that.</p>
          </Card>
        </div>
      </section>

      {/* Before / during / after */}
      <section aria-labelledby="phases" className="mt-24">
        <p className="text-teal font-bold uppercase tracking-[0.14em] text-sm">What it does</p>
        <h2 id="phases" className="text-[2rem] md:text-[2.5rem] mt-2 max-w-2xl">Protection at every step, not just at checkout.</h2>
        <div className="mt-8 grid md:grid-cols-3 gap-5">
          {phases.map(({ icon: Icon, when, title, text }) => (
            <Card key={title} className="p-7">
              <span className="inline-grid place-items-center size-14 rounded-2xl bg-teal-soft text-teal"><Icon className="size-7" aria-hidden /></span>
              <p className="mt-5 text-sm font-bold uppercase tracking-[0.12em] text-ink-soft">{when}</p>
              <h3 className="text-2xl mt-1">{title}</h3>
              <p className="mt-2 text-ink-soft text-lg">{text}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Home screen preview */}
      <section aria-labelledby="simple" className="mt-24 rounded-[2rem] bg-navy text-white p-8 md:p-12 grid md:grid-cols-2 gap-10 items-center">
        <div>
          <h2 id="simple" className="text-[2rem] md:text-[2.5rem]">Three big buttons. That’s the whole app.</h2>
          <p className="mt-4 text-xl text-white/85">No menus to learn and no chatbot to argue with. Everything is spoken aloud with captions, and you can make the text bigger at any time.</p>
        </div>
        <ul className="grid gap-3" aria-label="The three actions on the home screen">
          {[[MessageSquareWarning, 'Check a message'], [Mic, 'Shop by voice'], [Users, 'Get trusted help']].map(([Icon, label]: any) => (
            <li key={label} className="flex items-center gap-4 rounded-2xl bg-white text-navy px-6 py-5 text-2xl font-bold"><Icon className="size-8 text-teal" aria-hidden />{label}</li>
          ))}
        </ul>
      </section>

      {/* How to try */}
      <section id="how" aria-labelledby="try" className="mt-24 scroll-mt-24">
        <p className="text-teal font-bold uppercase tracking-[0.14em] text-sm">Try it</p>
        <h2 id="try" className="text-[2rem] md:text-[2.5rem] mt-2">See it work in three steps.</h2>
        <ol className="mt-8 grid md:grid-cols-3 gap-5">
          {steps.map((s) => (
            <li key={s.n}><Card as="div" className="p-7 h-full">
              <span className="font-display text-5xl text-teal" aria-hidden>{s.n}</span>
              <h3 className="text-2xl mt-2">{s.title}</h3>
              <p className="mt-2 text-ink-soft text-lg">{s.text}</p>
            </Card></li>
          ))}
        </ol>
        <div className="mt-8 flex flex-wrap gap-4">
          <Button onClick={() => start('/check')} busy={busy} icon={<MessageSquareWarning className="size-6" aria-hidden />}>Check a fake message</Button>
          <Button variant="secondary" onClick={() => start('/shop')} disabled={busy} icon={<ShoppingBag className="size-6" aria-hidden />}>Shop by voice</Button>
        </div>
      </section>

      {/* Promises */}
      <section aria-labelledby="promises" className="mt-24 grid md:grid-cols-2 gap-10">
        <div>
          <h2 id="promises" className="text-[2rem] md:text-[2.5rem]">Our safety promises.</h2>
          <ul className="mt-6 grid gap-4">
            {promises.map(({ icon: Icon, text }) => (
              <li key={text} className="flex gap-4 text-xl"><Icon className="size-7 shrink-0 text-teal mt-0.5" aria-hidden />{text}</li>
            ))}
          </ul>
        </div>
        <Card className="p-7">
          <h3 className="text-2xl">What’s real in this demo</h3>
          <ul className="mt-4 grid gap-3 text-lg">
            {real.map(([label, isReal, note]) => (
              <li key={label} className="flex gap-3">
                {isReal ? <CheckCircle2 className="size-6 shrink-0 text-teal mt-0.5" aria-label="Real" /> : <CircleDashed className="size-6 shrink-0 text-amber mt-0.5" aria-label="Simulated" />}
                <span>{label}{note && <span className="text-ink-soft"> — {note}</span>}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-base text-ink-soft">Full list in the project’s STATUS file on GitHub.</p>
        </Card>
      </section>

      {/* Final CTA */}
      <section className="mt-24 mb-6 rounded-[2rem] bg-teal-soft p-8 md:p-12 text-center">
        <h2 className="text-[2rem] md:text-[2.5rem]">Shop simply. Pay safely.</h2>
        <p className="mt-3 text-xl text-ink-soft">Try the full demo in about two minutes.</p>
        <div className="mt-6 flex justify-center"><Button onClick={() => start()} busy={busy} icon={<ArrowRight className="size-6" aria-hidden />}>Try it free as Mary</Button></div>
      </section>
    </Layout>
  );
}
