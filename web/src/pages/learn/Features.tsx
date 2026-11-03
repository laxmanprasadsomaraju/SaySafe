/** /features — every implemented feature with the problem, an example, how to reach it, integration, data, limits. */
import { Link } from 'react-router-dom';
import { LearnShell } from '../../learn/LearnShell';
import { FEATURE_GROUPS, ROADMAP } from '../../learn/features';
import { VALUE_PROP, guideBySlug } from '../../learn/content';

const ROWS: [keyof typeof FIELD, string][] = [['problem', 'Problem'], ['example', 'Example'], ['access', 'How to reach it'], ['integration', 'PayPal / AI / Channel3'], ['data', 'Real or sample data'], ['limits', 'Limitations']];
const FIELD = { problem: 1, example: 1, access: 1, integration: 1, data: 1, limits: 1 };

export default function Features() {
  return (
    <LearnShell>
      <header className="max-w-3xl">
        <p className="eyebrow">Features</p>
        <h1 className="mt-2 display-2">What SaySafe does, and what it doesn’t</h1>
        <p className="mt-4 text-xl text-ink-soft leading-relaxed">{VALUE_PROP}</p>
      </header>
      <nav aria-label="Feature groups" className="mt-6">
        <ul className="flex flex-wrap gap-2">{FEATURE_GROUPS.map((g) => <li key={g.id}><a href={`#${g.id}`} className="inline-flex items-center min-h-12 px-4 rounded-full border-2 border-line bg-paper font-bold hover:border-teal">{g.title}</a></li>)}<li><a href="#roadmap" className="inline-flex items-center min-h-12 px-4 rounded-full border-2 border-line bg-paper font-bold hover:border-teal">Roadmap</a></li></ul>
      </nav>
      {FEATURE_GROUPS.map((grp) => (
        <section key={grp.id} id={grp.id} aria-labelledby={`${grp.id}-h`} className="mt-12 scroll-mt-24">
          <h2 id={`${grp.id}-h`} className="display-3">{grp.title}</h2>
          <p className="mt-2 text-lg text-ink-soft">{grp.lead}</p>
          <div className="mt-6 grid lg:grid-cols-2 gap-5">
            {grp.items.map((f) => {
              const g = f.guide ? guideBySlug(f.guide) : undefined;
              return (
                <article key={f.id} id={f.id} aria-labelledby={`${f.id}-h`} className="scroll-mt-24 rounded-[var(--radius-card)] border border-line bg-paper p-5 sm:p-6 min-w-0">
                  <h3 id={`${f.id}-h`} className="text-2xl">{f.name}</h3>
                  <dl className="mt-3 grid gap-3">
                    {ROWS.map(([k, label]) => <div key={k}><dt className="text-sm font-bold uppercase tracking-wide text-teal">{label}</dt><dd className="mt-0.5 text-lg text-navy break-words">{f[k]}</dd></div>)}
                  </dl>
                  {g && <Link to={`/learn/${g.slug}`} className="link mt-4 inline-flex min-h-12 items-center">Guide: {g.title}</Link>}
                </article>
              );
            })}
          </div>
        </section>
      ))}
      <section id="roadmap" aria-labelledby="roadmap-h" className="mt-14 scroll-mt-24 max-w-3xl">
        <h2 id="roadmap-h" className="display-3">Roadmap (not built or not verified yet)</h2>
        <ul className="mt-4 grid gap-2 text-lg list-disc pl-6">{ROADMAP.map((r) => <li key={r}>{r}</li>)}</ul>
        <p className="mt-6 rounded-2xl bg-amber-soft text-amber font-bold px-5 py-4 text-base">SaySafe is an independent open-source hackathon project, not affiliated with or endorsed by PayPal, Groq or Channel3. PayPal Sandbox only: no real money. SaySafe has not been evaluated with real users and doesn’t claim to have prevented any fraud.</p>
      </section>
    </LearnShell>
  );
}
