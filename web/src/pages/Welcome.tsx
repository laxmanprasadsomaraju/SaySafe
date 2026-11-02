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
  const start = async (to = '/check', state: any = { scenario: 'mary' }) => {
    setBusy(true); setErr(null);
    try { await api('/api/demo/start', { body: { name: 'Mary' } }); nav(to, { state }); }
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
    { icon: BadgeCheck, text: 'It never calls a payment request “safe”. It tells you what it found, what it could not check, and the safe next step.' },
    { icon: ShieldCheck, text: 'Family approval is checked on our server, so it cannot be skipped by a trick or a chatbot.' },
    { icon: Eye, text: 'Big text, high contrast, spoken help with captions on every screen.' },
  ];
  const real = [
    ['PayPal Orders v2 sandbox: create and capture', true],
    ['Buyer approval on PayPal’s own sandbox page', false, 'being verified'],
    ['Groq AI: scam explanations and voice shopping', true],
    ['Server-side family approval and spending limit', true],
    ['Products and prices', false, 'demo catalogue'],
    ['Money', false, 'PayPal sandbox only'],
  ] as const;


  const sources = [
    { where: 'United States', fig: 'about US$3 billion', what: 'total fraud losses reported to the FTC by people aged 60 and over in 2025', src: 'FTC, Protecting Older Consumers 2025–2026 (Oct 2026)', url: 'https://www.ftc.gov/news-events/news/press-releases/2026/10/ftc-issues-annual-report-congress-agencys-actions-protect-older-adults' },
    { where: 'United States', fig: '201,266 complaints, about US$7.7 billion', what: 'complaints to the FBI’s IC3 from people aged 60+ in 2025, with their reported losses. A separate dataset from the FTC’s — never add the two', src: 'FBI IC3, 2025 Internet Crime Report', url: 'https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf' },
    { where: 'Ireland', fig: '€179.04 million', what: 'value of fraudulent payments reported by Irish resident payment service providers in 2025, all ages, up 27.2% on 2024', src: 'Central Bank of Ireland (Sept 2026)', url: 'https://www.centralbank.ie/news/article/press-release-payment-fraud-increases-by-27-to-reach-179-million-in-2025-central-bank-of-ireland-report-finds' },
    { where: 'United Kingdom', fig: '£1.28 billion', what: 'payment fraud losses reported by UK Finance members in 2025, all ages', src: 'UK Finance, Annual Fraud Report 2026', url: 'https://www.ukfinance.org.uk/news-and-insight/press-release/fraud-report-2026-press-release' },
    { where: 'Australia', fig: 'A$2.18 billion', what: 'combined scam losses reported to Scamwatch, ReportCyber, IDCARE, AFCX and ASIC in 2025, all ages', src: 'National Anti-Scam Centre, Targeting Scams 2025', url: 'https://www.scamwatch.gov.au/research-and-resources/targeting-scams-report' },
    { where: 'Canada', fig: 'over 112,000 reports, over C$704 million', what: 'fraud reports and reported losses received by the Canadian Anti-Fraud Centre in 2025, all ages', src: 'Canadian Anti-Fraud Centre (Feb 2026)', url: 'https://centreantifraude-antifraudcentre.ca/features-vedette/2026/02/top-fraud-2025-fraudes-plus-courantes-eng.htm' },
  ];
  const can = ['Read a message, invoice or screenshot you give it and explain possible warning signs', 'Point you to support pages we have checked ourselves', 'Hold payments you start in SaySafe until your family check is done', 'Complete and verify supported PayPal sandbox payments'];
  const cannot = ['Promise a payment request is scam-free', 'Check every shop or seller', 'Read your PayPal inbox or invoices', 'Stop payments made outside SaySafe', 'File disputes for you or guarantee a refund'];

  return (
    <Layout mode="public">
      {/* Hero */}
      <section className="grid md:grid-cols-[1.1fr_1fr] gap-10 md:gap-14 items-center fade-up">
        <div>
          <SandboxBadge />
          <h1 className="mt-5 text-[2.6rem] leading-[1.08] md:text-[3.75rem]">From “Is this real?” to a receipt you can trust.</h1>
          <p className="mt-5 text-[length:var(--text-lead)] text-ink-soft max-w-xl">SaySafe walks older adults through the whole payment: it explains the warning signs in a suspicious request, offers a trusted family check, enforces your limits, then completes a genuine PayPal checkout and reads back a verified receipt.</p>
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
            <p className="mt-1 text-lg text-ink-soft">It asks you to call a number from the message and pay €149 today. Both are common scam signs. Check in the PayPal app instead.</p>
          </Card>
        </div>
      </section>


      {/* Why SaySafe exists */}
      <section aria-labelledby="impact" className="mt-24">
        <p className="text-teal font-bold uppercase tracking-[0.14em] text-sm">Why SaySafe exists</p>
        <h2 id="impact" className="text-[2rem] md:text-[2.75rem] mt-2 max-w-3xl">A moment of doubt shouldn’t cost someone their savings.</h2>
        <p className="mt-4 text-xl text-ink-soft max-w-3xl">Scammers impersonate trusted businesses, create false urgency and convince people to send money or reveal sensitive information. SaySafe helps people understand warning signs, find trusted support and make more informed payment decisions.</p>
        <dl className="mt-10 grid md:grid-cols-2 gap-8 border-t border-line pt-8">
          <div>
            <dt className="sr-only">United States, 2025</dt>
            <dd className="font-display text-[3.5rem] md:text-[4.5rem] leading-none text-navy">US$3B</dd>
            <dd className="mt-3 text-lg text-ink-soft max-w-md">reported fraud losses among US adults aged 60 and over in 2025. <a className="underline text-teal font-bold" href={sources[0].url} target="_blank" rel="noreferrer">FTC<span className="sr-only"> (opens in a new tab)</span></a></dd>
          </div>
          <div>
            <dt className="sr-only">Ireland, 2025</dt>
            <dd className="font-display text-[3.5rem] md:text-[4.5rem] leading-none text-navy">€179M</dd>
            <dd className="mt-3 text-lg text-ink-soft max-w-md">fraudulent payment value reported in Ireland in 2025, across all ages. <a className="underline text-teal font-bold" href={sources[2].url} target="_blank" rel="noreferrer">Central Bank of Ireland<span className="sr-only"> (opens in a new tab)</span></a></dd>
          </div>
        </dl>
        <details className="mt-8 rounded-2xl border border-line bg-white/70 p-6 group">
          <summary className="cursor-pointer text-xl font-bold min-h-12 flex items-center">Explore the research</summary>
          <p className="mt-4 text-lg text-ink-soft">Each figure comes from a different reporting system with its own definitions, so they cannot be added together or compared as rankings. Reports count complaints or cases, not unique people, and many scams are never reported. Only the US figures refer to older adults.</p>
          <ul className="mt-5 grid gap-5">
            {sources.map((x) => (
              <li key={x.url} className="border-t border-line pt-4">
                <p className="text-sm font-bold uppercase tracking-[0.12em] text-ink-soft">{x.where} · 2025</p>
                <p className="text-xl mt-1"><span className="font-bold text-navy">{x.fig}</span> — {x.what}.</p>
                <a className="mt-1 inline-block underline text-teal font-bold" href={x.url} target="_blank" rel="noreferrer">{x.src}<span className="sr-only"> (opens in a new tab)</span></a>
              </li>
            ))}
          </ul>
          <p className="mt-5 text-base text-ink-soft">Sources last checked 2 November 2026. SaySafe has not been evaluated in the field and does not claim to have prevented any amount of fraud.</p>
        </details>
      </section>

      {/* Before / during / after */}
      <section aria-labelledby="phases" className="mt-24">
        <p className="text-teal font-bold uppercase tracking-[0.14em] text-sm">What it does</p>
        <h2 id="phases" className="text-[2rem] md:text-[2.5rem] mt-2 max-w-2xl">One connected journey, not just a scam checker.</h2>
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


      {/* Differentiator */}
      <section aria-labelledby="invoice" className="mt-24 grid md:grid-cols-[1fr_1.1fr] gap-10 items-start">
        <div>
          <p className="text-teal font-bold uppercase tracking-[0.14em] text-sm">The hard case</p>
          <h2 id="invoice" className="text-[2rem] md:text-[2.5rem] mt-2">Even a genuine PayPal invoice can contain suspicious instructions.</h2>
          <p className="mt-4 text-xl text-ink-soft">Fraudsters can send real invoices or payment requests through PayPal and hide an alarming note or a fake phone number inside. A link to paypal.com proves very little. SaySafe reads what the message asks you to do.</p>
          <a className="mt-4 inline-block underline text-teal font-bold text-lg" href="https://www.paypal.com/ie/cshelp/article/what-are-invoice-scams-and-payment-request-scams-on-paypal-help1059" target="_blank" rel="noreferrer">PayPal’s guidance on invoice scams<span className="sr-only"> (opens in a new tab)</span></a>
        </div>
        <Card className="p-7">
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-ink-soft">Example SaySafe found in a test screenshot</p>
          <blockquote className="mt-3 rounded-xl bg-paper border border-line p-4 text-lg">“If you did NOT authorise this purchase, call our PayPal billing department immediately at +1 (808) 555-0199.”</blockquote>
          <ul className="mt-4 grid gap-2 text-lg">
            <li className="flex gap-3"><MessageSquareWarning className="size-6 shrink-0 text-danger mt-0.5" aria-hidden />A phone number inside the invoice note, not one SaySafe could verify</li>
            <li className="flex gap-3"><MessageSquareWarning className="size-6 shrink-0 text-danger mt-0.5" aria-hidden />Pressure to act now, for a purchase you may not recognise</li>
            <li className="flex gap-3"><CircleDashed className="size-6 shrink-0 text-amber mt-0.5" aria-hidden />Unknown: whether the seller is genuine</li>
          </ul>
          <p className="mt-4 text-lg font-bold">Safe next step: don’t call. Open the PayPal app yourself, or ask family.</p>
        </Card>
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
          <Button onClick={() => start('/check', {})} busy={busy} icon={<MessageSquareWarning className="size-6" aria-hidden />}>Check a fake message</Button>
          <Button variant="secondary" onClick={() => start('/shop', {})} disabled={busy} icon={<ShoppingBag className="size-6" aria-hidden />}>Shop by voice</Button>
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


      {/* Can / cannot */}
      <section aria-labelledby="limits" className="mt-24">
        <h2 id="limits" className="text-[2rem] md:text-[2.5rem]">What SaySafe can and cannot do.</h2>
        <div className="mt-8 grid md:grid-cols-2 gap-5">
          <Card className="p-7"><h3 className="text-2xl">It can</h3><ul className="mt-4 grid gap-3 text-lg">{can.map((t) => <li key={t} className="flex gap-3"><CheckCircle2 className="size-6 shrink-0 text-teal mt-0.5" aria-hidden />{t}</li>)}</ul></Card>
          <Card className="p-7"><h3 className="text-2xl">It cannot</h3><ul className="mt-4 grid gap-3 text-lg">{cannot.map((t) => <li key={t} className="flex gap-3"><CircleDashed className="size-6 shrink-0 text-ink-soft mt-0.5" aria-hidden />{t}</li>)}</ul></Card>
        </div>
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
