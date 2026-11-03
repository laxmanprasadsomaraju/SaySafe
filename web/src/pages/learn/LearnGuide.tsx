/** /learn/:slug — one guide: numbered steps, exact prompts, screenshots (click to enlarge), notes, previous/next. */
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Clock } from 'lucide-react';
import { LearnShell, Prompt } from '../../learn/LearnShell';
import { Figure } from '../../learn/Figure';
import { GUIDES, guideBySlug } from '../../learn/content';

export default function LearnGuide() {
  const { slug = '' } = useParams();
  const g = guideBySlug(slug);
  if (!g) return <Navigate to="/learn" replace />;
  const i = GUIDES.indexOf(g);
  const prev = GUIDES[i - 1]; const next = GUIDES[i + 1];
  return (
    <LearnShell>
      <article aria-labelledby="guide-h" className="max-w-5xl">
        <p className="eyebrow">Guide {g.n} of {GUIDES.length}</p>
        <h1 id="guide-h" className="mt-2 display-2">{g.title}</h1>
        <p className="mt-4 text-xl text-ink-soft leading-relaxed max-w-[60ch]">{g.summary}</p>
        <p className="mt-3 inline-flex items-center gap-1.5 text-base font-bold text-ink-soft"><Clock className="size-5" aria-hidden />About {g.minutes} minutes · PayPal Sandbox only, no real money</p>
        {g.intro && <p className="mt-6 text-lg leading-relaxed max-w-[70ch]">{g.intro}</p>}

        <ol className="mt-8 grid gap-6" aria-label="Steps">
          {g.steps.map((s, k) => (
            <li key={k} id={`step-${k + 1}`} className="scroll-mt-24 rounded-[var(--radius-card)] border border-line bg-paper p-5 sm:p-6 min-w-0">
              <div className={s.shots?.length ? 'grid lg:grid-cols-[minmax(18rem,1fr)_auto] gap-6 items-start' : ''}>
                <div className="min-w-0">
                  <h2 className="flex items-center gap-3 text-xl"><span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-navy text-white font-bold">{k + 1}</span><span className="sr-only">Step {k + 1}{s.label ? `: ${s.label}` : ''}</span><span aria-hidden>{s.label ?? `Step ${k + 1}`}</span>{s.optional && <span className="rounded-full border border-line px-2 py-0.5 text-sm font-bold text-ink-soft">Optional</span>}</h2>
                  <p className="mt-3 text-lg leading-relaxed break-words">{s.t}</p>
                  {s.prompt && <><p className="mt-3 text-base font-bold text-ink-soft">Type or say:</p><Prompt text={s.prompt} /></>}
                </div>
                {s.shots && <div className="flex flex-wrap gap-5 justify-center">{s.shots.map((sh) => <Figure key={sh.id} shot={sh} />)}</div>}
              </div>
            </li>
          ))}
        </ol>

        {g.notes && (
          <div className="mt-8 rounded-2xl bg-amber-soft px-5 py-4 max-w-[75ch]">
            <h2 className="font-bold text-amber text-lg">Good to know</h2>
            <ul className="mt-1 grid gap-1.5 text-base text-navy list-disc pl-5">{g.notes.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}

        {g.related && (
          <nav aria-label="Related guides" className="mt-8">
            <h2 className="text-xl">Related guides</h2>
            <ul className="mt-2 flex flex-wrap gap-x-6">{g.related.map((r) => { const x = guideBySlug(r)!; return <li key={r}><Link to={`/learn/${r}`} className="link inline-flex min-h-12 items-center">{x.title}</Link></li>; })}</ul>
          </nav>
        )}

        <nav aria-label="Previous and next guide" className="mt-10 border-t border-line pt-6 flex flex-wrap justify-between gap-4">
          {prev ? <Link to={`/learn/${prev.slug}`} className="inline-flex items-center gap-2 min-h-12 font-bold text-teal underline underline-offset-4"><ArrowLeft className="size-5" aria-hidden /><span>Previous: {prev.title}</span></Link> : <Link to="/learn" className="inline-flex items-center gap-2 min-h-12 font-bold text-teal underline underline-offset-4"><ArrowLeft className="size-5" aria-hidden />All guides</Link>}
          {next ? <Link to={`/learn/${next.slug}`} className="inline-flex items-center gap-2 min-h-12 font-bold text-teal underline underline-offset-4"><span>Next: {next.title}</span><ArrowRight className="size-5" aria-hidden /></Link> : <Link to="/judges" className="inline-flex items-center gap-2 min-h-12 font-bold text-teal underline underline-offset-4"><span>Judges’ Guide</span><ArrowRight className="size-5" aria-hidden /></Link>}
        </nav>
      </article>
    </LearnShell>
  );
}
