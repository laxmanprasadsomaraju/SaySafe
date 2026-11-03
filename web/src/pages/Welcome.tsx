import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShoppingBag, Users, ArrowRight, MessageSquareWarning, Mic, CheckCircle2, CircleDashed, CircleX, CircleHelp, TriangleAlert, ShieldAlert, MessageCircle, Search, CreditCard, ListChecks, BarChart3, Accessibility, Code, CirclePlay, BookOpen } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, SandboxBadge } from '../components/ui';
import { api } from '../lib/api';

/**
 * Demo video link. Leave EMPTY until a real recorded demo exists; the "Watch Demo" button only renders when set.
 * TODO(release): paste the public YouTube URL here once the video is uploaded.
 */
export const DEMO_VIDEO_URL = '';
const REPO_URL = 'https://github.com/laxmanprasadsomaraju/SaySafe';

type Status = 'Live' | 'Live, sandbox' | 'Beta' | 'In development';
const statusStyle: Record<Status, string> = {
  Live: 'bg-teal-soft text-teal-deep',
  'Live, sandbox': 'bg-amber-soft text-amber',
  Beta: 'bg-ivory text-navy border border-line',
  'In development': 'bg-ivory text-ink-soft border border-dashed border-ink-soft',
};

/** Public landing page: what SaySafe is, who it is for, how it works, what is verified, and how to try it. */
export default function Welcome() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A fresh "Try as Mary" household (with its own labelled sample data), landing on the Assistant's welcome card.
  const start = async (to = '/assistant?welcome=1', state: any = { scenario: 'mary' }) => {
    setBusy(true); setErr(null);
    try { await api('/api/demo/start', { body: { name: 'Mary' } }); nav(to, { state }); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  // Already trying it in this browser: offer to carry on (same data) instead of only starting over.
  const [signedIn, setSignedIn] = useState<string | null>(null);
  useEffect(() => { api('/api/me').then((r) => setSignedIn(r?.elder?.name ?? null)).catch(() => {}); }, []);
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

  const verified = [
    ['Live PayPal sandbox payments (€19 and €29) captured exactly once', '3 Nov 2026'],
    ['Buyer approval on PayPal’s own sandbox page', '2–3 Nov 2026'],
    ['Signed PayPal webhooks checked and stored; a resent duplicate ignored', '3 Nov 2026'],
    ['Records survive a server restart and redeploy', '3 Nov 2026'],
    ['A lost PayPal redirect recovered with “Finish”, no double charge', '3 Nov 2026'],
    ['Hosted browser test 14 of 14, and 0 automated accessibility issues on 6 screens', '3 Nov 2026'],
  ] as const;
  const uncertain = [
    ['Scam checks make mistakes', 'on 42 unseen test messages: 2 false alarms, 1 missed scam'],
    ['Nothing about the sender is independently verified', 'SaySafe reads the message only'],
    ['Microphone and spoken replies', 'tested in Chromium with a simulated microphone, not on real phones'],
    ['Reply languages other than English', 'beta, not yet verified'],
    ['Usability with older adults', 'scripted walkthroughs only, no real-person testing yet'],
    ['Money', 'PayPal sandbox only, never real money'],
  ] as const;
  const problems = [
    { t: 'Fake invoices that look real', d: 'A genuine PayPal invoice can carry a scammer’s phone number. A paypal.com link proves little.' },
    { t: 'Pressure to act now', d: '“Your account is limited.” “Call within 24 hours.” Urgency stops people checking.' },
    { t: 'Shopping online is hard work', d: 'Small text, many steps and unclear prices put people off, or push them to ask strangers.' },
    { t: 'Doubt after paying', d: '“Did it go through? Was I charged twice?” SaySafe only says “paid” once PayPal confirms it.' },
  ];
  // How it works: the flagship journey in five steps (Mary → Alex → PayPal Sandbox → verified receipt).
  const steps = [
    { n: 1, t: 'Mary asks first', d: '“I got a message saying I owe €120. Did I already pay?” SaySafe checks her own records and labels sample data clearly.', tag: 'Before' },
    { n: 2, t: 'She reviews the exact purchase', d: 'Real products to compare (Channel3), or the SaySafe Demo Shop microwave at €120. The server fixes item, shop and price.', tag: 'Before' },
    { n: 3, t: 'Alex, her family helper, approves', d: 'Over Mary’s €75 limit, Alex sees that exact item and price and says yes or no. The answer expires and can’t pay for her.', tag: 'During' },
    { n: 4, t: 'Mary approves at PayPal herself', d: 'On PayPal’s own sandbox page, with test money. SaySafe re-checks amount and currency and captures once.', tag: 'During' },
    { n: 5, t: 'A receipt checked with PayPal', d: '“Paid” only after PayPal confirms the capture, then a signed webhook is verified. Activity and Insights show it as a real sandbox transaction.', tag: 'After' },
  ];
  const features: { icon: typeof ShieldAlert; t: string; d: string; status: Status; help: string }[] = [
    { icon: ShieldAlert, t: 'Scam Guardian', d: 'Paste a message, link, email, phone number or screenshot. You get Suspicious, Needs checking or No obvious warning signs, with the exact words that worried it. Never “safe”.', status: 'Live', help: 'checking-messages' },
    { icon: MessageCircle, t: 'AI Assistant', d: 'One conversation for checking, shopping and help, with purchase, family, receipt and insights cards. The AI explains and suggests; it can never pay, approve or change a record.', status: 'Live', help: 'getting-started' },
    { icon: Search, t: 'Channel3 shopping', d: 'Real products, prices and pictures from Channel3. Buying opens the shop’s own website: SaySafe never pays a retailer.', status: 'Live', help: 'real-products' },
    { icon: Users, t: 'Family Circle', d: 'Invite a trusted helper with a one-time code. Purchases over your limit wait for them to approve or decline the exact item and price.', status: 'Live', help: 'family-reviews' },
    { icon: CreditCard, t: 'PayPal Sandbox checkout', d: 'Demo Shop items are paid on PayPal’s own sandbox page. SaySafe re-checks amount and currency with PayPal and captures once.', status: 'Live, sandbox', help: 'paypal-sandbox' },
    { icon: ListChecks, t: 'Payment history', d: 'Every payment, family decision and scam check in one searchable list, with receipts and PayPal evidence.', status: 'Live', help: 'history-receipts' },
    { icon: BarChart3, t: 'Insights', d: 'Mary’s own insights, and a read-only dashboard for her family helper: spending confirmed by PayPal (sample data counted separately), shared scam checks and pending approvals.', status: 'Live', help: 'insights' },
    { icon: Accessibility, t: 'Voice and accessibility', d: 'Large text, high contrast, captions for everything spoken, and a big Stop. Voice is tap-to-talk and still being tested on real phones.', status: 'Beta', help: 'voice' },
  ];
  const tech = [
    { t: 'PayPal (sandbox)', d: 'OAuth, Orders v2 (create, get, capture), Payments v2 (capture lookup, refunds) and webhook signature verification. Sandbox only.' },
    { t: 'Groq AI', d: 'openai/gpt-oss-20b and gpt-oss-120b for explanations and the Assistant, qwen/qwen3.8-27b for reading screenshots, whisper-large-v3-turbo for speech. Rules make the decisions.' },
    { t: 'Channel3', d: 'Real product discovery: search, prices, images and links to retailers. Discovery only.' },
    { t: 'Render + Turso', d: 'Hosted on Render’s free plan with a Turso free database, so records persist across restarts.' },
    { t: 'APIMatic', d: 'The PayPal integration was audited against APIMatic’s PayPal Context Plugin guidance. Fixes: 401 token refresh, sandbox-only guard, unknown-outcome capture handling.' },
    { t: 'AG Studio', d: 'An optional AG Studio dashboard was built but is switched off publicly: the trial licence is for evaluation only. The public site uses SaySafe’s own dashboard.' },
  ];
  const tryNow = ['Choose “Try as Mary”. A private demo household is created for “Mary”, with a €75 family limit and labelled sample data. No sign-up.', 'Tap a welcome question: “Did I already pay for the microwave?”, “Show my subscriptions”, or check a training scam message.', 'Ask for a kettle, by voice or typing, and compare real Channel3 products.', 'Buy a Demo Shop item over €75: it waits for family. Open the family view as “Alex” to approve.', 'Approve the payment on PayPal’s sandbox page with a sandbox buyer account.', 'SaySafe confirms with PayPal and shows the receipt. Open Activity to see it again.'];

  return (
    <Layout mode="public">
      {/* Hero */}
      <section className="wrap pt-10 md:pt-16 pb-16 md:pb-24 grid lg:grid-cols-12 gap-12 lg:gap-8 items-center">
        <div className="lg:col-span-6 fade-up">
          <SandboxBadge />
          <h1 className="mt-6 text-[2.75rem] leading-[1.04] sm:text-[3.5rem] lg:text-[4.5rem] tracking-[-0.025em] max-w-[13ch]">Ask first. Pay with confidence.</h1>
          <p className="mt-6 text-[1.375rem] leading-relaxed text-ink-soft max-w-[36ch]">SaySafe is a payment safety companion for older adults and the family who help them. It checks the request, brings in family when it matters, and confirms with PayPal before telling you it’s paid.</p>
          <div className="mt-9 flex flex-wrap items-center gap-x-4 gap-y-3">
            {signedIn
              ? <><Button onClick={() => nav('/home')} icon={<ArrowRight className="size-6" aria-hidden />}>Continue as {signedIn}</Button><Button variant="secondary" onClick={() => start()} busy={busy}>Start a fresh demo</Button></>
              : <Button onClick={() => start()} busy={busy} icon={<ArrowRight className="size-6" aria-hidden />}>Try as Mary</Button>}
            {DEMO_VIDEO_URL && <a href={DEMO_VIDEO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 min-h-14 px-2 text-[1.125rem] font-bold text-teal underline-offset-4 hover:underline"><CirclePlay className="size-6" aria-hidden />Watch Demo<span className="sr-only"> (opens in a new tab)</span></a>}
            <a href="#how" className="inline-flex items-center min-h-14 px-2 text-[1.125rem] font-bold text-teal underline-offset-4 hover:underline">How It Works</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 min-h-14 px-2 text-[1.125rem] font-bold text-teal underline-offset-4 hover:underline"><Code className="size-5" aria-hidden />View Source Code<span className="sr-only"> (opens in a new tab)</span></a>
          </div>
          {err && <p role="alert" className="mt-4 text-danger font-bold">{err}</p>}
          <p className="mt-4 text-base text-ink-soft">No sign-up. About two minutes. PayPal sandbox only: no real money. <Link to="/help" className="link">Help centre</Link></p>
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
          <li>PayPal Orders v2 + webhooks · sandbox</li><li>Groq AI · text, screenshots, speech</li><li>Channel3 · real products</li><li>Family approval enforced on the server</li><li>WCAG 2.2 AA · automated checks</li><li>Open source · MIT</li>
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

      {/* Who + problems */}
      <section aria-labelledby="who" className="bg-paper border-y border-line">
        <div className="wrap py-20 md:py-28 grid lg:grid-cols-12 gap-12 reveal">
          <div className="lg:col-span-5">
            <p className="eyebrow">Who it’s for</p>
            <h2 id="who" className="display-2 mt-3 max-w-[16ch]">For people who want a second look before they pay.</h2>
            <p className="mt-6 text-xl leading-relaxed text-ink-soft max-w-[40ch]">Built first for older adults, and for the son, daughter or friend they would ring for advice. Useful for anyone who has ever hesitated over a payment request.</p>
          </div>
          <ul className="lg:col-span-7 grid sm:grid-cols-2 gap-x-10 gap-y-8">
            {problems.map((x) => (
              <li key={x.t} className="border-t-2 border-navy pt-5">
                <h3 className="text-2xl">{x.t}</h3>
                <p className="mt-2 text-lg text-ink-soft leading-relaxed">{x.d}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* How it works: the flagship journey, five steps */}
      <section id="how" aria-labelledby="how-h" className="wrap py-20 md:py-28 scroll-mt-24 reveal">
        <p className="eyebrow">How it works</p>
        <h2 id="how-h" className="display-2 mt-3 max-w-[22ch]">From “did I already pay?” to a receipt PayPal confirmed.</h2>
        <ol className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
          {steps.map((st) => (
            <li key={st.t} className="rounded-[var(--radius-card)] border border-line bg-paper p-6 shadow-[var(--shadow-card)]">
              <p className="flex items-center gap-3"><span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-navy text-white font-bold text-lg">{st.n}</span><span className="sr-only">Step {st.n}: </span><span className="text-sm font-bold uppercase tracking-wide text-teal">{st.tag} payment</span></p>
              <p className="mt-4 text-2xl font-display leading-tight">{st.t}</p>
              <p className="mt-3 text-lg text-ink-soft">{st.d}</p>
            </li>
          ))}
        </ol>
        <p className="mt-8 text-lg text-ink-soft max-w-[70ch]"><b className="text-navy">The rule behind it:</b> AI explains, rules decide, the payer authorises at PayPal, and the server verifies. A family “yes” never replaces your own approval. Everything uses the PayPal sandbox: no real money.</p>
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
        <p className="mt-5 text-base opacity-85">This screenshot used the typed request. The microphone has been tested in Chromium with a simulated microphone only; real phones are still to be tested.</p>
      </Showcase>

      {/* Explore features */}
      <section id="features" aria-labelledby="features-h" className="bg-paper border-y border-line">
        <div className="wrap py-20 md:py-28 reveal">
          <p className="eyebrow">Explore features</p>
          <h2 id="features-h" className="display-2 mt-3 max-w-[20ch]">Everything in the demo, with its real status.</h2>
          <ul className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {features.map((f) => (
              <li key={f.t} className="flex flex-col rounded-[var(--radius-card)] border border-line bg-ivory p-6 min-w-0">
                <f.icon className="size-8 text-teal" aria-hidden />
                <h3 className="mt-4 text-2xl">{f.t}</h3>
                <p className={`mt-2 self-start rounded-full px-3 py-1 text-sm font-bold ${statusStyle[f.status]}`}><span className="sr-only">Status: </span>{f.status}</p>
                <p className="mt-3 text-lg leading-relaxed text-ink-soft flex-1">{f.d}</p>
                <Link to={`/help#${f.help}`} className="link mt-4 min-h-12 inline-flex items-center">How to use it<span className="sr-only">: {f.t}</span></Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* What the demo does + try */}
      <section id="journey" aria-labelledby="try" className="wrap py-20 md:py-28 scroll-mt-24 reveal">
        <p className="eyebrow">Try it yourself</p>
        <h2 id="try" className="display-2 mt-3 max-w-[18ch]">What the demo actually does.</h2>
        <p className="mt-5 text-xl text-ink-soft max-w-[60ch]">You play Mary. Real Channel3 products are for browsing only; the one shop that takes a payment is the fictional SaySafe Demo Shop, paid through the PayPal sandbox with test money.</p>
        <ol className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-8">
          {tryNow.map((t, i) => (
            <li key={t} className="border-t border-line pt-5 flex gap-4 text-xl">
              <span className="font-display text-3xl text-teal leading-none" aria-hidden>{i + 1}</span><span>{t}</span>
            </li>
          ))}
        </ol>
        <div className="mt-12 flex flex-wrap gap-4">
          <Button onClick={() => start()} busy={busy} icon={<ArrowRight className="size-6" aria-hidden />}>Try it free as Mary</Button>
          <Button variant="secondary" onClick={() => start('/shop', {})} disabled={busy} icon={<ShoppingBag className="size-6" aria-hidden />}>Go straight to shopping</Button>
          <Link to="/help" className="inline-flex items-center gap-2 min-h-14 px-2 text-[1.125rem] font-bold text-teal underline-offset-4 hover:underline"><BookOpen className="size-5" aria-hidden />Step-by-step help</Link>
        </div>
        <p className="mt-5 text-base text-ink-soft">The free server sleeps when idle, so the first visit can take about a minute to wake up. Paying needs a PayPal sandbox personal (buyer) account.</p>
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
            <div>
              <h3 id="verified" className="display-3">What’s verified, and what isn’t</h3>
              <p className="mt-4 text-lg text-ink-soft">Checked on the hosted demo. Full details in the <a className="link" href={`${REPO_URL}/blob/main/docs/TEST-EVIDENCE.md`} target="_blank" rel="noreferrer">test evidence<span className="sr-only"> (opens in a new tab)</span></a>.</p>
            </div>
            <div>
              <h4 className="text-2xl">Verified</h4>
              <ul className="mt-4 grid gap-3 text-lg">
                {verified.map(([label, when]) => (
                  <li key={label} className="flex gap-3"><CheckCircle2 className="size-6 shrink-0 text-teal mt-0.5" aria-hidden /><span><span className="sr-only">Verified: </span>{label} <span className="text-ink-soft">({when})</span></span></li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-2xl">Uncertain or limited</h4>
              <ul className="mt-4 grid gap-3 text-lg">
                {uncertain.map(([label, note]) => (
                  <li key={label} className="flex gap-3"><CircleDashed className="size-6 shrink-0 text-amber mt-0.5" aria-hidden /><span><span className="sr-only">Limited: </span>{label} <span className="text-ink-soft">({note})</span></span></li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Technology */}
      <section aria-labelledby="tech" className="wrap py-20 md:py-28 reveal">
        <p className="eyebrow">Technology and integrations</p>
        <h2 id="tech" className="display-2 mt-3 max-w-[20ch]">What SaySafe is built on.</h2>
        <ul className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-8">
          {tech.map((x) => (
            <li key={x.t} className="border-t border-line pt-5 min-w-0">
              <h3 className="text-2xl">{x.t}</h3>
              <p className="mt-2 text-lg leading-relaxed text-ink-soft break-words">{x.d}</p>
            </li>
          ))}
        </ul>
        <p className="mt-10 rounded-2xl bg-amber-soft text-amber font-bold px-5 py-4 text-base max-w-[70ch]">SaySafe is an independent open-source hackathon project. It is not affiliated with, endorsed by or sponsored by PayPal, Groq, Channel3, Render, Turso, APIMatic or AG Grid.</p>
      </section>

      {/* Final CTA */}
      <section className="bg-navy text-white">
        <div className="wrap py-20 md:py-24 flex flex-col md:flex-row md:items-end md:justify-between gap-8">
          <h2 className="display-2 max-w-[16ch] text-white">Shop simply. Pay safely.</h2>
          <div className="flex flex-wrap items-center gap-4">
            <Button onClick={() => start()} busy={busy} className="!bg-white !text-navy hover:!bg-teal-soft" icon={<ArrowRight className="size-6" aria-hidden />}>Try as Mary</Button>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 min-h-14 px-2 text-[1.125rem] font-bold text-white underline underline-offset-4"><Code className="size-5" aria-hidden />View Source Code<span className="sr-only"> (opens in a new tab)</span></a>
          </div>
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
