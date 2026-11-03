import { ExternalLink } from 'lucide-react';
import { Card, Notice } from './ui';
import type { ScanResult, FindingBasis } from '../lib/api';

const BASIS: Record<FindingBasis, string> = {
  deterministic_rule: 'Deterministic rule',
  ai_judgement: 'AI judgement',
  independently_verified: 'Independently verified',
};

function BasisTag({ basis }: { basis: FindingBasis }) {
  return <span className="ml-2 inline-block rounded-full border border-line px-2 py-0.5 text-sm font-bold text-ink-soft align-middle">{BASIS[basis]}</span>;
}

/** Findings with exact evidence, what could not be verified, and safe next steps. All text is rendered as text (React escapes it). */
export function ScanDetails({ result }: { result: ScanResult }) {
  const top = result.signals.filter((s) => s.severity !== 'info').sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
  const minor = result.signals.filter((s) => s.severity === 'info');
  return (
    <>
      {result.disclosure && <Notice tone="info" title="What this result means">{result.disclosure}</Notice>}
      {(top.length > 0 || minor.length > 0 || result.aiReasons.length > 0) && (
        <Card className="p-6">
          <h3 className="text-2xl">Why</h3>
          {top.length > 0 && (
            <ul className="mt-3 space-y-4">
              {top.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className={`mt-2 size-3 rounded-full shrink-0 ${s.severity === 'high' ? 'bg-danger' : 'bg-amber'}`} aria-hidden />
                  <div className="min-w-0">
                    <p className="font-bold">{s.title}<span className="sr-only"> ({s.severity === 'high' ? 'strong warning' : 'warning'})</span>{s.basis && <BasisTag basis={s.basis} />}</p>
                    {s.evidence && <p className="text-base mt-1 break-words"><span className="font-bold">Found in the message:</span> <q className="bg-ivory rounded px-1">{s.evidence}</q></p>}
                    <p className="text-ink-soft text-lg">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {minor.length > 0 && (
            <div className="mt-4">
              <p className="text-base font-bold">Also noticed:</p>
              <ul className="mt-1 space-y-1 text-base text-ink-soft">
                {minor.map((s, i) => <li key={i} className="break-words">{s.title}{s.evidence ? <>: <q>{s.evidence}</q></> : null}</li>)}
              </ul>
            </div>
          )}
          {result.aiReasons.length > 0 && (
            <div className="mt-4 border-t border-line pt-4">
              <p className="text-base font-bold">The AI model also said <BasisTag basis="ai_judgement" /></p>
              <ul className="mt-1 list-disc pl-6 text-base text-ink-soft">{result.aiReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
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
              {s.url && <> <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-teal underline underline-offset-4">{s.urlLabel}<ExternalLink className="size-4" aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a></>}
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
