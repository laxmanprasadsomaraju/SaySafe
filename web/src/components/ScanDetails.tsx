import { ExternalLink } from 'lucide-react';
import { Card, Notice } from './ui';
import type { ScanResultV2, ScanEvidence } from '../lib/api';

const CLASS_HELP = {
  observable: 'Plain facts about what is in the message. Not a judgement.',
  rule: 'SaySafe’s fixed safety rules. The quoted words are what each rule matched.',
  ai: 'What the AI model pointed out. Only shown when it quoted the exact words from the message.',
} as const;

function Quote({ children }: { children: string }) {
  return <q className="bg-ivory rounded px-1 break-words">{children}</q>;
}

/** Fallback for results from an older server that has no evidence classes. */
function legacyEvidence(r: ScanResultV2): ScanEvidence {
  return {
    observable: [],
    rule: r.signals.map((s) => ({ code: s.code, severity: s.severity, title: s.title, quote: s.evidence, detail: s.detail })),
    ai: r.aiReasons.map((x) => ({ category: 'ai', categoryLabel: 'AI interpretation', quote: '', explanation: x })),
    labels: { observable: 'What is in the message', rule: 'SaySafe rule checks that matched', ai: 'AI interpretation (quoted from the message)' },
  };
}

/** "Why this was flagged" (three evidence classes with quotes), what could not be verified, and safe next steps. All text is rendered as text (React escapes it). */
export function ScanDetails({ result }: { result: ScanResultV2 }) {
  const ev = result.evidence ?? legacyEvidence(result);
  const rules = [...ev.rule].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : b.severity === 'high' ? 1 : a.severity === 'medium' ? -1 : 1));
  const flagged = result.verdict !== 'no_obvious_warning_signs';
  const any = ev.observable.length + rules.length + ev.ai.length > 0;
  return (
    <>
      {result.disclosure && <Notice tone="info" title="What this result means">{result.disclosure}</Notice>}
      {any && (
        <Card className="p-6">
          <h3 className="text-2xl">{flagged ? 'Why this was flagged' : 'What SaySafe looked at'}</h3>
          {rules.length > 0 && (
            <section className="mt-4" aria-labelledby="ev-rule">
              <h4 id="ev-rule" className="text-xl font-bold">{ev.labels.rule}</h4>
              <p className="text-base text-ink-soft">{CLASS_HELP.rule}</p>
              <ul className="mt-3 space-y-4">
                {rules.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className={`mt-2 size-3 rounded-full shrink-0 ${s.severity === 'high' ? 'bg-danger' : s.severity === 'medium' ? 'bg-amber' : 'bg-line'}`} aria-hidden />
                    <div className="min-w-0">
                      <p className="font-bold">{s.title}<span className="sr-only"> ({s.severity === 'high' ? 'strong warning' : s.severity === 'medium' ? 'warning' : 'note'})</span></p>
                      {s.quote && <p className="text-base mt-1"><span className="font-bold">Matched:</span> <Quote>{s.quote}</Quote></p>}
                      {s.severity !== 'info' && <p className="text-ink-soft text-lg">{s.detail}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {ev.ai.length > 0 && (
            <section className="mt-5 border-t border-line pt-4" aria-labelledby="ev-ai">
              <h4 id="ev-ai" className="text-xl font-bold">{ev.labels.ai}</h4>
              <p className="text-base text-ink-soft">{CLASS_HELP.ai}</p>
              <ul className="mt-3 space-y-3">
                {ev.ai.map((r, i) => (
                  <li key={i}>
                    <p className="font-bold">{r.categoryLabel}</p>
                    {r.quote && <p className="text-base mt-1"><span className="font-bold">Quoted:</span> <Quote>{r.quote}</Quote></p>}
                    <p className="text-ink-soft text-lg">{r.explanation}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {ev.observable.length > 0 && (
            <section className="mt-5 border-t border-line pt-4" aria-labelledby="ev-obs">
              <h4 id="ev-obs" className="text-xl font-bold">{ev.labels.observable}</h4>
              <p className="text-base text-ink-soft">{CLASS_HELP.observable}</p>
              <ul className="mt-2 space-y-1 text-base">
                {ev.observable.map((o, i) => <li key={i} className="break-words">{o.text}{o.quote ? <> <Quote>{o.quote}</Quote></> : null}</li>)}
              </ul>
            </section>
          )}
          {result.ai?.mode === 'rules_only' && <p className="mt-4 text-base text-ink-soft">The AI model was not used for this result. Everything above comes from SaySafe’s fixed rules.</p>}
        </Card>
      )}
      <Card className="p-6">
        <h3 className="text-2xl">What SaySafe could not verify</h3>
        <ul className="mt-3 list-disc pl-6 space-y-1 text-lg">{result.couldNotVerify.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </Card>
      <Card className="p-6">
        <h3 className="text-2xl">Safe next steps</h3>
        <ol className="mt-3 space-y-3 text-lg list-decimal pl-6">
          {result.nextSteps.map((s) => (
            <li key={s.id}>
              {s.text}
              {s.url && <> <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-bold text-teal underline underline-offset-4">{s.urlLabel}<ExternalLink className="inline size-4 ml-1 align-[-2px]" aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a></>}
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
