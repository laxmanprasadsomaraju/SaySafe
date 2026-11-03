/** /judges — "Judge's Guide — Test SaySafe in 5 Minutes": the steps, exact prompts and screenshots beside the main steps. */
import { Link } from 'react-router-dom';
import { KeyRound, Timer } from 'lucide-react';
import { LearnShell, Prompt } from '../../learn/LearnShell';
import { Figure } from '../../learn/Figure';
import { JUDGE_STEPS, APP_URL, REPO, VALUE_PROP, guideBySlug } from '../../learn/content';

export default function Judges() {
  return (
    <LearnShell>
      <header className="max-w-3xl">
        <p className="eyebrow">For hackathon judges</p>
        <h1 className="mt-2 display-2">Judge’s Guide — Test SaySafe in 5 Minutes</h1>
        <p className="mt-4 text-xl text-ink-soft leading-relaxed">{VALUE_PROP}</p>
        <p className="mt-3 text-lg">Follow these steps on <a className="link" href={APP_URL} target="_blank" rel="noreferrer">{APP_URL.replace('https://', '')}<span className="sr-only"> (opens in a new tab)</span></a>. All payments are PayPal Sandbox: test money only.</p>
      </header>

      <div className="mt-8 grid md:grid-cols-2 gap-4 max-w-4xl">
        <div className="rounded-2xl border-2 border-amber bg-amber-soft p-5">
          <p className="font-bold text-lg flex items-center gap-2 text-amber"><KeyRound className="size-6" aria-hidden />Sandbox buyer login</p>
          <p className="mt-1 text-base text-navy">The real checkout step needs a PayPal Sandbox buyer account. Its login is provided <b>only in the Devpost testing instructions</b>, never on this site or in the repository. Never use a real PayPal login.</p>
        </div>
        <div className="rounded-2xl border border-line bg-paper p-5">
          <p className="font-bold text-lg flex items-center gap-2"><Timer className="size-6 text-teal" aria-hidden />Cold start</p>
          <p className="mt-1 text-base text-ink-soft">The demo runs on Render’s free plan. The first load after idle can take about 60 seconds. After that it is quick.</p>
        </div>
      </div>

      <ol className="mt-10 grid gap-5 max-w-5xl" aria-label="Judge’s steps">
        {JUDGE_STEPS.map((s, i) => {
          const g = s.guide ? guideBySlug(s.guide) : undefined;
          return (
            <li key={i} id={`judge-step-${i + 1}`} className="scroll-mt-24 rounded-[var(--radius-card)] border border-line bg-paper p-5 sm:p-6">
              <div className={s.shot ? 'grid md:grid-cols-[minmax(0,1fr)_auto] gap-6 items-start' : ''}>
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-3 text-xl"><span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-navy text-white font-bold">{i + 1}</span><span>Step {i + 1}</span>{s.optional && <span className="rounded-full border border-line px-2 py-0.5 text-sm font-bold text-ink-soft">Optional</span>}</h2>
                  <p className="mt-3 text-lg leading-relaxed">{s.t}</p>
                  {s.prompt && <><p className="mt-3 text-base font-bold text-ink-soft">Type exactly:</p><Prompt text={s.prompt} /></>}
                  {g && <Link to={`/learn/${g.slug}`} className="link mt-3 inline-flex min-h-12 items-center">Guide: {g.title}</Link>}
                </div>
                {s.shot && <Figure shot={s.shot} compact />}
              </div>
            </li>
          );
        })}
      </ol>

      <section aria-labelledby="checks-h" className="mt-12 max-w-4xl">
        <h2 id="checks-h" className="display-3">What to look for</h2>
        <ul className="mt-4 grid gap-2 text-lg list-disc pl-6">
          <li>The AI never pays, approves or captures. Only buttons do, checked by the server.</li>
          <li>Family approval (Alex) and buyer approval at PayPal (Mary) are separate. Both are needed over the €75 limit.</li>
          <li>Alex sees only the requests sent to him (item, shop, amount, and later whether it was paid). Purchases under the limit stay private unless Mary turns on “Share spending summaries with Alex” (totals only) or “Share my purchase history with Alex”; both are off by default. Only Mary can change her limit. Enforced on the server.</li>
          <li>“Paid” appears only after PayPal confirms the capture; “Webhook verified” only after PayPal’s signed notice is checked.</li>
          <li>Sample data is always labelled and never counted with real sandbox payments.</li>
          <li>Real Channel3 products are bought on the retailer’s site; only the Demo Shop is paid in SaySafe.</li>
        </ul>
        <p className="mt-6 text-lg">More: <Link className="link" to="/features">Features</Link> · <Link className="link" to="/learn">Learn SaySafe</Link> · <a className="link" href={`${REPO}/blob/main/docs/ARCHITECTURE.md`} target="_blank" rel="noreferrer">Architecture<span className="sr-only"> (opens GitHub in a new tab)</span></a> · <a className="link" href={`${REPO}/blob/main/docs/TEST-EVIDENCE.md`} target="_blank" rel="noreferrer">Test evidence<span className="sr-only"> (opens GitHub in a new tab)</span></a></p>
        <p className="mt-6 rounded-2xl bg-amber-soft text-amber font-bold px-5 py-4 text-base">SaySafe is an independent hackathon project, not affiliated with or endorsed by PayPal.</p>
      </section>
    </LearnShell>
  );
}
