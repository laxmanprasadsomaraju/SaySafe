import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShoppingBag, Users, ArrowRight, MessageSquareWarning, Mic, CheckCircle2, CircleDashed, CircleX, CircleHelp, TriangleAlert } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, SandboxBadge } from '../components/ui';
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
  // Gentle reveal on scroll. Content is visible without JS and with reduced motion.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const els = document.querySelectorAll('.reveal'); els.forEach((e) => e.classList.add('reveal-ready'));
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('reveal-in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -10% 0px' });
    els.forEach((e) => io.observe(e)); return () => io.disconnect();
  }, []);

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

  const real = [
    ['PayPal Orders v2 sandbox: create and capture', true],
    ['Buyer approval on PayPal’s own sandbox page', true, 'tested 2 Nov 2026'],
    ['Groq AI: scam explanations, screenshot reading, shopping assistant', true],
    ['Server-side family approval and spending limit', true],
    ['Microphone on real phones and laptops', false, 'not yet tested'],
    ['Products and prices', false, 'demo catalogue'],
    ['Money', false, 'PayPal sandbox only'],
  ] as const;
  const journey = ['A suspicious “PayPal” invoice arrives', 'SaySafe shows the warning signs', 'Mary asks for a kettle by voice', 'A bigger buy waits for family', 'Mary approves on PayPal’s sandbox page', 'PayPal confirms it, and SaySafe reads the receipt'];

  return (
    <Layout mode="public">
      {/* Hero */}
      <section className="wrap pt-10 md:pt-16 pb-16 md:pb-24 grid lg:grid-cols-12 gap-12 lg:gap-8 items-center">
        <div className="lg:col-span-6 fade-up">
          <SandboxBadge />
          <h1 className="mt-6 text-[2.75rem] leading-[1.04] sm:text-[3.5rem] lg:text-[4.5rem] tracking-[-0.025em] max-w-[13ch]">Pay with confidence, not doubt.</h1>
          <p className="mt-6 text-[1.375rem] leading-relaxed text-ink-soft max-w-[34ch]">SaySafe checks the request, brings in family when it matters, and confirms with PayPal before telling you it’s paid.</p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Button onClick={() => start()} busy={busy} icon={<ArrowRight className="size-6" aria-hidden />}>Try it free as Mary</Button>
            <a href="#journey" className="inline-flex items-center min-h-14 px-2 text-[1.125rem] font-bold text-teal underline-offset-4 hover:underline">See how it works</a>
            <Link to="/guide" className="inline-flex items-center min-h-14 px-2 text-[1.125rem] font-bold text-teal underline-offset-4 hover:underline">How to use it</Link>
          </div>
          {err && <p role="alert" className="mt-4 text-danger font-bold">{err}</p>}
          <p className="mt-4 text-base text-ink-soft">No sign-up. About two minutes. No real money.</p>
          <ul className="mt-10 flex flex-wrap gap-x-7 gap-y-3 text-lg font-bold" aria-label="The three things SaySafe does">
            <li className="flex items-center gap-2"><MessageSquareWarning className="size-6 text-teal" aria-hidden />Check a message</li>
            <li className="flex items-center gap-2"><Mic className="size-6 text-teal" aria-hidden />Shop by voice</li>
            <li className="flex items-center gap-2"><Users className="size-6 text-teal" aria-hidden />Get trusted help</li>
          </ul>
        </div>
        <div className="lg:col-span-6 relative fade-up">
          <img src="/hero-mary.webp" alt="An older woman smiling at her phone at a sunny kitchen table" width={928} height={1152} className="w-full max-w-[34rem] ml-auto rounded-[2rem] object-cover aspect-[4/5]" />
          <figure className="absolute -bottom-8 left-0 sm:left-4 lg:-left-10 w-[58%] max-w-[17.5rem]">
            <Phone src="/screens/check-result.webp" alt="SaySafe result screen: Suspicious. This message may be a scam, with a spoken explanation." />
            <figcaption className="mt-2 text-sm font-bold text-ink-soft">Real SaySafe screen</figcaption>
          </figure>
        </div>
      </section>

      {/* Proof strip */}
      <section aria-label="What powers the demo" className="border-y border-line bg-paper">
        <ul className="wrap py-6 flex flex-wrap justify-between gap-x-8 gap-y-3 text-base font-bold text-ink-soft">
          <li>PayPal Orders v2 · sandbox</li><li>Groq AI · text and screenshots</li><li>Family approval enforced on the server</li><li>WCAG 2.2 AA · automated checks</li><li>Open source · MIT</li>
        </ul>
      </section>

      {/* Why */}
      <section aria-labelledby="impact" className="wrap py-20 md:py-28 reveal">
        <p className="eyebrow">Why SaySafe exists</p>
        <h2 id="impact" className="display-2 mt-3 max-w-[20ch]">A moment of doubt shouldn’t cost someone their savings.</h2>
        <dl className="mt-14 grid md:grid-cols-2 gap-12 md:gap-16">
          <div className="border-t-2 border-navy pt-6">
            <dt className="sr-only">United States, 2025</dt>
            <dd className="font-display text-[4.5rem] md:text-[6.5rem] leading-[0.9] tracking-[-0.03em] text-navy">US$3B</dd>
            <dd className="mt-5 text-xl text-ink-soft max-w-[32ch]">in fraud losses reported by US adults aged 60 and over in 2025. <a className="link" href={sources[0].url} target="_blank" rel="noreferrer">FTC<span className="sr-only"> (opens in a new tab)</span></a></dd>
          </div>
          <div className="border-t-2 border-navy pt-6">
            <dt className="sr-only">Ireland, 2025</dt>
            <dd className="font-display text-[4.5rem] md:text-[6.5rem] leading-[0.9] tracking-[-0.03em] text-navy">€179M</dd>
            <dd className="mt-5 text-xl text-ink-soft max-w-[32ch]">in fraudulent payments reported in Ireland in 2025, all ages. <a className="link" href={sources[2].url} target="_blank" rel="noreferrer">Central Bank of Ireland<span className="sr-only"> (opens in a new tab)</span></a></dd>
          </div>
        </dl>
        <details className="mt-12 border-t border-line pt-2">
          <summary className="cursor-pointer text-xl font-bold min-h-14 flex items-center gap-2 text-teal">Explore the research</summary>
          <p className="mt-4 text-lg text-ink-soft max-w-[65ch]">Each figure comes from a different reporting system with its own definitions, so they can’t be added together or ranked. Reports count complaints or cases, not people, and many scams are never reported. Only the US figures refer to older adults.</p>
          <ul className="mt-6 grid md:grid-cols-2 gap-x-12">
            {sources.map((x) => (
              <li key={x.url} className="border-t border-line py-5">
                <p className="text-sm font-bold uppercase tracking-[0.12em] text-ink-soft">{x.where} · 2025</p>
                <p className="text-xl mt-1"><span className="font-bold text-navy">{x.fig}</span>: {x.what}.</p>
                <a className="link mt-1 inline-block" href={x.url} target="_blank" rel="noreferrer">{x.src}<span className="sr-only"> (opens in a new tab)</span></a>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-base text-ink-soft">Sources last checked 2 November 2026. SaySafe hasn’t been evaluated in the field and doesn’t claim to have prevented any fraud.</p>
        </details>
      </section>

      {/* Showcase 1: ScamLens */}
      <Showcase id="scan" eyebrow="Before you pay · Check a message" title="Even a genuine PayPal invoice can carry a fake phone number."
        screens={[{ src: '/screens/check-result.webp', alt: 'SaySafe result: Suspicious, this message may be a scam, with the reasons and a Read it to me again button.' }]}>
        <p>Scammers send real invoices with an alarming note inside. A link to paypal.com proves little, so SaySafe reads what the message asks you to do.</p>
        <blockquote className="mt-6 border-l-4 border-danger pl-5 text-lg italic">“If you did NOT authorise this purchase, call our PayPal billing department immediately at +1 (808) 555-0199.”<span className="block not-italic text-sm font-bold text-ink-soft mt-2">From SaySafe’s sample invoice</span></blockquote>
        <ul className="mt-6 grid gap-3 text-lg">
          <li className="flex gap-3"><TriangleAlert className="size-6 shrink-0 text-danger mt-0.5" aria-hidden /><span><b>Warning sign:</b> a phone number inside the note</span></li>
          <li className="flex gap-3"><TriangleAlert className="size-6 shrink-0 text-danger mt-0.5" aria-hidden /><span><b>Warning sign:</b> pressure to act now</span></li>
          <li className="flex gap-3"><CircleHelp className="size-6 shrink-0 text-amber mt-0.5" aria-hidden /><span><b>Unknown:</b> whether the seller is genuine</span></li>
        </ul>
        <a className="link mt-6 inline-block text-lg" href="https://www.paypal.com/ie/cshelp/article/what-are-invoice-scams-and-payment-request-scams-on-paypal-help1059" target="_blank" rel="noreferrer">PayPal’s guidance on invoice scams<span className="sr-only"> (opens in a new tab)</span></a>
      </Showcase>

      {/* Showcase 2: Family */}
      <Showcase id="family" dark flip eyebrow="While you pay · Get trusted help" title="Bigger purchases wait for someone you trust."
        screens={[{ src: '/screens/family-waiting.webp', alt: 'Mary’s screen: Waiting for family, Simple Dial Microwave 20L, €120, with a Cancel this purchase button.', cap: 'Mary’s phone: waiting' }, { src: '/screens/family-request.webp', alt: 'Family member Alex’s screen: Above Mary’s limit of €75, the microwave for €120, with Approve and Decline buttons.', cap: 'Alex’s phone: approves' }]}>
        <p>Over Mary’s limit, SaySafe sends her family the exact item, shop and price. The answer applies only to that purchase and expires. Mary still approves at PayPal herself, so nobody can pay for her.</p>
      </Showcase>

      {/* Showcase 3: Checkout + receipt */}
      <Showcase id="receipt" eyebrow="After you pay · A receipt you can hear" title="It says “paid” only after PayPal confirms it."
        screens={[{ src: '/screens/receipt.webp', alt: 'SaySafe receipt: Paid, Easy-Pour Electric Kettle, €32.00 EUR, Receipt confirmed by PayPal, with order and transaction numbers.', cap: 'Sandbox payment, 2 Nov 2026' }]}>
        <p>Mary approves on PayPal’s own page. SaySafe then captures the payment and shows the amount, the shop and PayPal’s transaction number, and reads them aloud.</p>
        <p className="mt-5 rounded-2xl bg-amber-soft text-amber font-bold px-5 py-4 text-base">This screenshot is a real PayPal sandbox payment of €32.00 with test money. No real money moved.</p>
      </Showcase>

      {/* Showcase 4: Voice */}
      <Showcase id="voice" dark flip eyebrow="Accessibility · Shop by voice" title="Just say what you need."
        screens={[{ src: '/screens/shop-voice.webp', alt: 'SaySafe shopping screen: a large Tap to speak microphone button, a text box with I need a kettle, and the spoken reply shown as a caption.' }]}>
        <p>Tap the big button and ask for “a reliable kettle under €40”, or type it instead. Every spoken reply is also shown as text, and you can make text bigger or switch to high contrast at any time.</p>
        <p className="mt-5 text-base opacity-85">This screenshot used the typed request. Microphone use on real phones is still being tested.</p>
      </Showcase>

      {/* Journey */}
      <section id="journey" aria-labelledby="try" className="wrap py-20 md:py-28 scroll-mt-24 reveal">
        <p className="eyebrow">Try it yourself</p>
        <h2 id="try" className="display-2 mt-3 max-w-[18ch]">Walk through Mary’s afternoon.</h2>
        <ol className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-8">
          {journey.map((t, i) => (
            <li key={t} className="border-t border-line pt-5 flex gap-4 text-xl">
              <span className="font-display text-3xl text-teal leading-none" aria-hidden>{i + 1}</span><span>{t}</span>
            </li>
          ))}
        </ol>
        <div className="mt-12 flex flex-wrap gap-4">
          <Button onClick={() => start()} busy={busy} icon={<ArrowRight className="size-6" aria-hidden />}>Try it free as Mary</Button>
          <Button variant="secondary" onClick={() => start('/shop', {})} disabled={busy} icon={<ShoppingBag className="size-6" aria-hidden />}>Go straight to shopping</Button>
        </div>
      </section>

      {/* Honesty */}
      <section aria-labelledby="limits" className="bg-paper border-t border-line">
        <div className="wrap py-20 md:py-28 grid lg:grid-cols-3 gap-12 reveal">
          <div>
            <h2 id="limits" className="display-3">What SaySafe can and cannot do</h2>
            <p className="mt-4 text-lg text-ink-soft">SaySafe helps you spot warning signs and make more informed payment decisions. It never calls a payment request “safe”.</p>
          </div>
          <div>
            <h3 className="text-2xl">It can</h3>
            <ul className="mt-4 grid gap-3 text-lg">{can.map((t) => <li key={t} className="flex gap-3"><CheckCircle2 className="size-6 shrink-0 text-teal mt-0.5" aria-hidden />{t}</li>)}</ul>
          </div>
          <div>
            <h3 className="text-2xl">It cannot</h3>
            <ul className="mt-4 grid gap-3 text-lg">{cannot.map((t) => <li key={t} className="flex gap-3"><CircleX className="size-6 shrink-0 text-ink-soft mt-0.5" aria-hidden />{t}</li>)}</ul>
          </div>
          <div className="lg:col-span-3 border-t border-line pt-10 grid lg:grid-cols-3 gap-12">
            <h3 className="display-3">What’s real in this demo</h3>
            <ul className="lg:col-span-2 grid sm:grid-cols-2 gap-x-10 gap-y-3 text-lg">
              {real.map(([label, isReal, note]) => (
                <li key={label} className="flex gap-3">
                  {isReal ? <CheckCircle2 className="size-6 shrink-0 text-teal mt-0.5" aria-hidden /> : <CircleDashed className="size-6 shrink-0 text-amber mt-0.5" aria-hidden />}
                  <span><span className="sr-only">{isReal ? 'Real: ' : 'Not real yet: '}</span>{label}{note && <span className="text-ink-soft"> ({note})</span>}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-navy text-white">
        <div className="wrap py-20 md:py-24 flex flex-col md:flex-row md:items-end md:justify-between gap-8">
          <h2 className="display-2 max-w-[16ch] text-white">Shop simply. Pay safely.</h2>
          <Button onClick={() => start()} busy={busy} className="!bg-white !text-navy hover:!bg-teal-soft" icon={<ArrowRight className="size-6" aria-hidden />}>Try it free as Mary</Button>
        </div>
      </section>
    </Layout>
  );
}

function Phone({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="rounded-[2rem] bg-navy p-2 shadow-[0_24px_60px_-28px_rgb(21_40_59/0.55)]">
      <img src={src} alt={alt} width={390} height={844} decoding="async" className="block w-full rounded-[1.5rem] bg-paper" />
    </div>
  );
}

function Showcase({ id, eyebrow, title, children, screens, dark, flip }: { id: string; eyebrow: string; title: string; children: ReactNode; screens: { src: string; alt: string; cap?: string }[]; dark?: boolean; flip?: boolean }) {
  return (
    <section aria-labelledby={id} className={dark ? 'bg-navy text-white' : ''}>
      <div className="wrap py-14 sm:py-20 md:py-28 grid lg:grid-cols-12 gap-8 sm:gap-12 lg:gap-16 items-center reveal">
        <div className={`${screens.length > 1 ? 'lg:col-span-5' : 'lg:col-span-6'} ${flip ? 'lg:order-2' : ''} ${dark ? '[&_.link]:!text-white' : ''}`}>
          <p className={`eyebrow ${dark ? '!text-teal-soft' : ''}`}>{eyebrow}</p>
          <h2 id={id} className={`display-2 mt-3 ${dark ? 'text-white' : ''}`}>{title}</h2>
          <div className={`mt-4 sm:mt-6 text-lg sm:text-xl leading-relaxed max-w-[52ch] ${dark ? 'text-white/90' : 'text-ink-soft'}`}>{children}</div>
        </div>
        <div className={`${screens.length > 1 ? 'lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 justify-items-center items-start' : 'lg:col-span-6 flex justify-center'} gap-8 sm:gap-6 ${flip ? 'lg:order-1' : ''}`}>
          {screens.map((s, i) => (
            <figure key={s.src} className={screens.length > 1 ? 'w-[90%] sm:w-full max-w-[20rem] sm:max-w-[21rem]' : 'w-[84%] max-w-[22rem]'}>
              {screens.length > 1 && s.cap && <figcaption className={`mb-3 flex items-center justify-center gap-2 text-base font-bold ${dark ? 'text-white' : 'text-ink'}`}><span aria-hidden className={`grid size-7 place-items-center rounded-full text-sm ${dark ? 'bg-white text-navy' : 'bg-navy text-white'}`}>{i + 1}</span>{s.cap}</figcaption>}
              <Phone src={s.src} alt={s.alt} />
              {screens.length === 1 && s.cap && <figcaption className={`mt-3 text-center text-base font-bold ${dark ? 'text-white/85' : 'text-ink-soft'}`}>{s.cap}</figcaption>}
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
