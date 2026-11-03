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

const VERDICT = {
  suspicious: { icon: ShieldAlert, cls: 'bg-danger-soft border-danger', ic: 'text-danger', label: 'Suspicious' },
  needs_verification: { icon: ShieldQuestion, cls: 'bg-amber-soft border-amber', ic: 'text-amber', label: 'Needs checking' },
  verified_official_contact: { icon: ShieldCheck, cls: 'bg-teal-soft border-teal', ic: 'text-teal', label: 'Official PayPal contact' },
} as const;

export default function Check() {
  const me = useMe('elder');
  const nav = useNavigate();
  const loc = useLocation() as { state?: { text?: string; scenario?: string } };
  const scenario = loc.state?.scenario === 'mary';
  const started = useRef(false);
  const [text, setText] = useState(loc.state?.text ?? '');
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
  const v = result ? VERDICT[result.verdict] : null;
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
              {result.ocrUncertain && <Notice tone="warn" title="Some letters in the screenshot were hard to read.">Please check the address carefully, or paste the text instead.</Notice>}
              {top.length > 0 && (
                <Card className="p-6">
                  <h3 className="text-2xl">Why</h3>
                  <ul className="mt-3 space-y-4">
                    {top.map((s, i) => (
                      <li key={i} className="flex gap-3">
                        <span className={`mt-2 size-3 rounded-full shrink-0 ${s.severity === 'high' ? 'bg-danger' : 'bg-amber'}`} aria-hidden />
                        <div><p className="font-bold">{s.title}<span className="sr-only"> ({s.severity === 'high' ? 'strong warning' : 'warning'})</span></p><p className="text-ink-soft text-lg">{s.detail}</p>{s.evidence && <p className="text-base text-ink-soft mt-1 break-all"><span className="font-bold">Seen:</span> {s.evidence}</p>}</div>
                      </li>
                    ))}
                  </ul>
                  {minor.length > 0 && <p className="mt-4 text-base text-ink-soft">Also noticed: {minor.map((s) => s.title.toLowerCase()).join('; ')}.</p>}
                </Card>
              )}
              {result.verdict === 'verified_official_contact' && <Notice tone="info" title="An official address does not make a message safe.">Scammers can copy real addresses. Check any payment inside the PayPal app.</Notice>}
              <Card className="p-6">
                <h3 className="text-2xl">Safe next steps</h3>
                <div className="mt-4 flex flex-col gap-3">
                  <a href={result.safeActions[0]?.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-between gap-3 rounded-2xl bg-teal text-white font-bold px-6 min-h-16 hover:bg-teal-deep">
                    {result.safeActions[0]?.label}<ExternalLink className="size-6" aria-hidden />
                  </a>
                  {result.safeActions.slice(1).map((a) => (
                    <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-between gap-3 rounded-2xl border-2 border-line hover:border-teal font-bold px-6 min-h-14">{a.label}<ExternalLink className="size-5" aria-hidden /></a>
                  ))}
                  <Button variant="secondary" icon={<Users className="size-6" aria-hidden />} onClick={share} disabled={shared}>{shared ? 'Sent to your family' : 'Ask a family member'}</Button>
                  <Button variant="ghost" icon={<HomeIcon className="size-6" aria-hidden />} onClick={() => nav('/home')}>Stop and go home</Button>
                </div>
                <p className="mt-4 text-base text-ink-soft">To report it, forward the message to <span className="font-bold">phishing@paypal.com</span> (from PayPal's official report page), then delete it.</p>
                {result.phonePolicy && <p className="mt-2 text-base text-ink-soft">{result.phonePolicy}</p>}
              </Card>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
