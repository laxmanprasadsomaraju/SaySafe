/**
 * /learn — the "Learn SaySafe" documentation centre. Sections (anchored: /learn#family), a client-side search over
 * guide titles and text, the 14 guides, How SaySafe works, use cases, privacy, FAQ. /help stays the support page.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, X, Clock, BookOpen, Gavel, LayoutGrid, LifeBuoy } from 'lucide-react';
import { LearnShell } from '../../learn/LearnShell';
import { SandboxBadge } from '../../components/ui';
import { GUIDES, SECTIONS, HOW_IT_WORKS, USE_CASES, PRIVACY, FAQ, VALUE_PROP, guideText, type SectionId } from '../../learn/content';

const hay = GUIDES.map((g) => ({ g, text: guideText(g).toLowerCase() }));

export default function Learn() {
  const [q, setQ] = useState('');
  const loc = useLocation();
  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => (needle ? hay.filter((h) => needle.split(/\s+/).every((w) => h.text.includes(w))).map((h) => h.g) : []), [needle]);
  useEffect(() => {
    if (!loc.hash) return;
    const el = document.getElementById(decodeURIComponent(loc.hash.slice(1)));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }, [loc.hash]);
  const guidesIn = (id: SectionId) => GUIDES.filter((g) => g.sections.includes(id));

  return (
    <LearnShell>
      <header className="max-w-3xl">
        <SandboxBadge />
        <h1 className="mt-5 display-2">Learn SaySafe</h1>
        <p className="mt-4 text-xl text-ink-soft leading-relaxed">{VALUE_PROP}</p>
        <p className="mt-3 text-lg text-ink-soft">Short, step-by-step guides with real screenshots. Everything uses the PayPal Sandbox: test money only.</p>
      </header>

      <ul className="mt-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { to: '/learn/getting-started', icon: BookOpen, t: 'Start here', d: 'Getting started as Mary, in two minutes.' },
          { to: '/judges', icon: Gavel, t: 'Judges’ Guide', d: 'Test SaySafe in 5 minutes, step by step.' },
          { to: '/features', icon: LayoutGrid, t: 'All features', d: 'What each feature does, and its limits.' },
          { to: '/help', icon: LifeBuoy, t: 'Help & support', d: 'Official PayPal help, order problems, family codes.' },
        ].map((c) => (
          <li key={c.to}><Link to={c.to} className="flex h-full flex-col rounded-[var(--radius-card)] border-2 border-line bg-paper p-5 hover:border-teal shadow-[var(--shadow-card)]">
            <c.icon className="size-7 text-teal" aria-hidden /><span className="mt-3 text-xl font-display font-semibold">{c.t}</span><span className="mt-1 text-base text-ink-soft">{c.d}</span>
          </Link></li>
        ))}
      </ul>

      <section aria-labelledby="search-h" className="mt-12">
        <h2 id="search-h" className="sr-only">Search the guides</h2>
        <form role="search" className="max-w-xl" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor="learn-q" className="block font-bold text-lg">Search the guides</label>
          <div className="mt-2 flex gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="size-5 absolute left-4 top-1/2 -translate-y-1/2 text-ink-soft" aria-hidden />
              <input id="learn-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="For example: refund, voice, Alex" aria-describedby="learn-count"
                className="w-full min-h-14 rounded-full border-2 border-line bg-paper pl-11 pr-4 text-lg focus:border-teal outline-none" />
            </div>
            {q && <button type="button" onClick={() => setQ('')} className="inline-flex items-center gap-1 min-h-14 px-4 rounded-full font-bold text-teal hover:bg-teal-soft"><X className="size-5" aria-hidden />Clear</button>}
          </div>
          <p id="learn-count" aria-live="polite" className="mt-2 text-base text-ink-soft">{needle ? (hits.length ? `${hits.length} guide${hits.length === 1 ? '' : 's'} found` : 'No guides found. Try another word, or browse the sections below.') : `${GUIDES.length} guides`}</p>
        </form>
        {needle && hits.length > 0 && <GuideList guides={hits} label="Search results" />}
      </section>

      <nav aria-label="Sections" className="mt-12">
        <h2 className="display-3">Sections</h2>
        <ul className="mt-5 grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {SECTIONS.map((s) => <li key={s.id}><a href={`#${s.id}`} className="flex flex-col min-h-12 rounded-2xl px-4 py-3 hover:bg-teal-soft"><span className="font-bold text-teal underline underline-offset-4">{s.title}</span><span className="text-base text-ink-soft">{s.blurb}</span></a></li>)}
        </ul>
      </nav>

      <Section id="getting-started" title="Getting Started"><GuideList guides={guidesIn('getting-started')} /></Section>

      <Section id="how-it-works" title="How SaySafe Works" lead="AI explains, rules decide, the payer authorises at PayPal, and the server verifies. A family “yes” never replaces your own approval.">
        <ol className="mt-6 grid md:grid-cols-3 gap-5">
          {HOW_IT_WORKS.map((h, i) => (
            <li key={h.when} className="rounded-[var(--radius-card)] border border-line bg-paper p-5">
              <p className="flex items-center gap-3"><span aria-hidden className="grid size-9 place-items-center rounded-full bg-navy text-white font-bold">{i + 1}</span><span className="text-xl font-display font-semibold">{h.when}</span></p>
              <ul className="mt-3 grid gap-2 text-lg list-disc pl-5">{h.items.map((x) => <li key={x}>{x}</li>)}</ul>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="guides" title="Step-by-Step Guides"><GuideList guides={GUIDES} /></Section>

      <Section id="use-cases" title="Use Cases">
        <ul className="mt-6 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {USE_CASES.map((u) => <li key={u.t} className="border-t-2 border-navy pt-4"><h3 className="text-xl">{u.t}</h3><p className="mt-1 text-lg text-ink-soft">{u.d}</p><Link to={`/learn/${u.guide}`} className="link mt-2 inline-flex min-h-12 items-center">Read the guide<span className="sr-only">: {u.t}</span></Link></li>)}
        </ul>
      </Section>

      {(['family', 'paypal', 'voice', 'payment-memory', 'subscriptions', 'scam', 'shopping', 'insights'] as SectionId[]).map((id) => {
        const s = SECTIONS.find((x) => x.id === id)!;
        return <Section key={id} id={id} title={s.title} lead={s.blurb}><GuideList guides={guidesIn(id)} /></Section>;
      })}

      <Section id="privacy" title="Privacy & Security">
        <ul className="mt-5 grid gap-3 text-lg list-disc pl-6 max-w-[70ch]">{PRIVACY.map((p) => <li key={p}>{p}</li>)}</ul>
        <GuideList guides={guidesIn('privacy')} />
      </Section>

      <Section id="faq" title="FAQ">
        <dl className="mt-5 grid gap-5 text-lg max-w-[70ch]">{FAQ.map((f) => <div key={f.q}><dt className="font-bold text-navy">{f.q}</dt><dd className="mt-1 text-ink-soft">{f.a}</dd></div>)}</dl>
      </Section>

      <Section id="troubleshooting" title="Troubleshooting"><GuideList guides={guidesIn('troubleshooting')} /></Section>

      <p className="mt-12 rounded-2xl bg-amber-soft text-amber font-bold px-5 py-4 text-base max-w-[70ch]">SaySafe is an independent open-source hackathon project. It is not affiliated with or endorsed by PayPal. PayPal Sandbox only: no real money.</p>
    </LearnShell>
  );
}

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="mt-14 scroll-mt-24">
      <h2 id={`${id}-h`} className="display-3">{title}</h2>
      {lead && <p className="mt-2 text-lg text-ink-soft max-w-[70ch]">{lead}</p>}
      {children}
    </section>
  );
}

function GuideList({ guides, label }: { guides: typeof GUIDES; label?: string }) {
  return (
    <ul className="mt-5 grid sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-label={label}>
      {guides.map((g) => (
        <li key={g.slug}>
          <Link to={`/learn/${g.slug}`} className="flex h-full flex-col rounded-[var(--radius-card)] border border-line bg-paper p-5 hover:border-teal shadow-[var(--shadow-card)]">
            <span className="flex items-center gap-3"><span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-navy text-white font-bold">{g.n}</span><span className="text-xl font-display font-semibold leading-tight min-w-0 break-words">{g.title}</span></span>
            <span className="mt-2 text-base text-ink-soft flex-1">{g.summary}</span>
            <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-bold text-ink-soft"><Clock className="size-4" aria-hidden />About {g.minutes} min</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
