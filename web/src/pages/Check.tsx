import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ImageUp, ExternalLink, Users, Home as HomeIcon, ShieldAlert, ShieldQuestion, ShieldCheck } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, TextInput, MicButton, Notice } from '../components/ui';
import { api, type ScanResult } from '../lib/api';
import { speech, useVoiceInput } from '../lib/voice';
import { spokenScam } from '../lib/spoken';
import { ReadAloud } from '../components/VoiceBar';
import { useMe } from '../lib/session';
import { Shield } from 'lucide-react';
import { ScanDetails } from '../components/ScanDetails';
import { ShareWarning } from '../components/ShareWarning';
import { takeSharedText } from '../lib/shareTarget';
import type { ScanResultV2, ScanVerdict } from '../lib/api';

const VERDICT = {
  suspicious: { icon: ShieldAlert, cls: 'bg-danger-soft border-danger', ic: 'text-danger', label: 'Suspicious' },
  needs_checking: { icon: ShieldQuestion, cls: 'bg-amber-soft border-amber', ic: 'text-amber', label: 'Needs checking' },
  no_obvious_warning_signs: { icon: Shield, cls: 'bg-teal-soft border-teal', ic: 'text-teal', label: 'No obvious warning signs' },
} as const;

export default function Check() {
  const me = useMe('elder');
  const nav = useNavigate();
  const loc = useLocation() as { state?: { text?: string; scenario?: string } };
  const scenario = loc.state?.scenario === 'mary';
  const started = useRef(false);
  const [sharedIn] = useState(takeSharedText); // Android share target: prefill only, never auto-check
  const [text, setText] = useState(loc.state?.text ?? sharedIn ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [shared, setShared] = useState(false);
  const [samples, setSamples] = useState<{ id: string; label: string; text: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => { api('/api/samples').then(setSamples).catch(() => {}); }, []);
  // Guided demo: Mary's story opens straight on the real-looking invoice and checks it for real.
  useEffect(() => {
    if (!scenario || started.current || samples.length === 0) return;
    const s = samples.find((x) => x.id === 'invoice') ?? samples[0];
    started.current = true; setText(s.text); scan(s.text);
  }, [scenario, samples]); // eslint-disable-line react-hooks/exhaustive-deps

  const turn = useRef(0);
  const show = (r: ScanResult) => {
    setResult(r); setShared(false);
    // Spoken: risk first, then the protective action. The full explanation stays on screen.
    // In another reply language, speak the AI summary only if the server confirmed it is in that language.
    const lang = speech.getSnapshot().prefs.lang;
    if (lang !== 'en' && r.spokenLang === lang) speech.speak(r.spokenSummary, { priority: 'critical', turn: turn.current, lang });
    else speech.speak(spokenScam(r), { priority: 'critical', turn: turn.current, lang: 'en' });
    setTimeout(() => { resultRef.current?.focus({ preventScroll: true }); resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  };
  const scan = useCallback(async (t: string) => {
    if (!t.trim()) { setErr('Please paste or type the message first.'); return; }
    setBusy(true); setErr(null); setResult(null);
    const myTurn = (turn.current = speech.beginTurn());
    try { const r = await api<ScanResult>('/api/scan', { body: { text: t } }); if (speech.isCurrent(myTurn)) show(r); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); speech.endThinking(); }
  }, []);
  useEffect(() => { if (loc.state?.text) scan(loc.state.text); }, []); // eslint-disable-line

  const onImage = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) { setErr('That picture is too large (max 4 MB).'); return; }
    setBusy(true); setErr(null); setResult(null);
    turn.current = speech.beginTurn();
    try { const fd = new FormData(); fd.append('image', f); const r = await api<ScanResult>('/api/scan/image', { form: fd }); setText(r.extractedText ?? ''); show(r); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); speech.endThinking(); if (fileRef.current) fileRef.current.value = ''; }
  };

  const voice = useVoiceInput((t) => { setText(t); scan(t); });
  const share = async () => { if (!result) return; await api(`/api/scan/${result.scanId}/share`, { body: {} }); setShared(true); };

  if (!me) return <Layout><p>Loading…</p></Layout>;
  const v = result ? VERDICT[result.verdict as unknown as ScanVerdict] : null;
  const top = result?.signals.filter((s) => s.severity !== 'info') ?? [];
  const minor = result?.signals.filter((s) => s.severity === 'info') ?? [];
  return (
    <Layout>
      <PageTitle eyebrow="Scam guardian" title="Check a message" lead="Paste the text, email, link or phone number you received. Or upload a screenshot. I never open the links in it." />
      {scenario && (
        <div role="note" className="mb-6 rounded-2xl border border-line bg-white p-5 flex flex-wrap items-center justify-between gap-4">
          <p className="text-lg"><span className="font-bold">Mary’s story, step 1 of 4.</span> An invoice arrives that looks like it is from PayPal. SaySafe checks it below.</p>
          {result && <Button variant="secondary" onClick={() => nav('/shop', { state: { scenario: 'mary' } })}>Next: buy a kettle</Button>}
        </div>
      )}
      {sharedIn && !result && <div className="mb-6"><Notice tone="info" title="A message was shared to SaySafe.">It is in the box below. Read it, then choose "Check this message". Nothing has been checked or sent yet.</Notice></div>}
      <div className="grid lg:grid-cols-[1.1fr_1fr] gap-6 items-start">
        <Card className="p-6">
          <form onSubmit={(e) => { e.preventDefault(); scan(text); }} className="space-y-5">
            <TextInput id="msg" label="The message" hint="Copy and paste it here." rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Your PayPal account is suspended…" maxLength={8000} />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" busy={busy}>Check this message</Button>
              <Button type="button" variant="secondary" icon={<ImageUp className="size-6" aria-hidden />} onClick={() => fileRef.current?.click()} disabled={busy}>Upload a screenshot</Button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload a screenshot" onChange={(e) => onImage(e.target.files?.[0])} />
            </div>
          </form>
          <div className="mt-6 border-t border-line pt-6 flex flex-col items-center">
            <MicButton state={voice.state} onClick={voice.toggle} size="md" label="Or read it out to me" />
            {voice.error && <p role="alert" className="mt-2 text-danger font-bold text-center">{voice.error}</p>}
          </div>
          {samples.length > 0 && (
            <div className="mt-6 border-t border-line pt-5">
              <p className="font-bold">Try a sample (not real messages):</p>
              <div className="mt-3 flex flex-wrap gap-3">
                {samples.map((s) => (
                  <button key={s.id} type="button" onClick={() => { setText(s.text); scan(s.text); }} className="rounded-full border-2 border-line hover:border-teal px-4 min-h-12 text-base font-bold text-left">{s.label.replace('Sample: ', '')}</button>
                ))}
              </div>
            </div>
          )}
          {err && <div className="mt-5"><Notice tone="danger" title={err} /></div>}
        </Card>

        <div ref={resultRef} tabIndex={-1} aria-live="polite" className="outline-none scroll-mt-24">
          {!result && !busy && (
            <Card className="p-6 text-ink-soft"><p>Your result will appear here, in plain words, with safe next steps.</p></Card>
          )}
          {busy && <Card className="p-6"><p className="font-bold">Checking the message… <span className="text-ink-soft font-normal">I'm looking at the links, the wording and what it asks you to do.</span></p></Card>}
          {result && v && (
            <div className="space-y-5 fade-up">
              <div className={`border-l-[8px] rounded-[var(--radius-card)] p-6 ${v.cls}`}>
                <p className={`flex items-center gap-2 font-bold uppercase tracking-wider text-sm ${v.ic}`}><v.icon className="size-6" aria-hidden />{v.label}</p>
                <h2 className="text-[1.9rem] mt-2">{result.headline}</h2>
                <p className="mt-3 text-[length:var(--text-lead)]" lang={result.spokenLang && result.spokenLang !== 'en' ? result.spokenLang : undefined}>{result.spokenSummary}</p>
                <ReadAloud className="mt-3" text={result.spokenLang && result.spokenLang !== 'en' ? result.spokenSummary : [result.headline, result.spokenSummary]} lang={result.spokenLang} label="Read the full result aloud" />
              </div>
              {result.aiNotice && <Notice tone="info" title={result.aiNotice}>This result comes from SaySafe's built-in safety checks only. The safe steps are the same.</Notice>}
              {result.ocrUncertain && <Notice tone="warn" title="Some letters in the screenshot were hard to read.">Please check the address carefully, or paste the text instead.</Notice>}
              <ScanDetails result={result as unknown as ScanResultV2} />
              <Card className="p-6">
                <h3 className="text-2xl">Get help</h3>
                <div className="mt-4 flex flex-col gap-3">
                  <Button variant="secondary" icon={<Users className="size-6" aria-hidden />} onClick={share} disabled={shared}>{shared ? 'Sent to your family' : 'Ask a family member'}</Button>
                  <Button variant="ghost" icon={<HomeIcon className="size-6" aria-hidden />} onClick={() => nav('/home')}>Stop and go home</Button>
                </div>
                {result.phonePolicy && <p className="mt-4 text-base text-ink-soft">{result.phonePolicy}</p>}
              </Card>
              <ShareWarning result={result as unknown as ScanResultV2} />
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
