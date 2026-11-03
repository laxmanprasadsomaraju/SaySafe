import { useEffect } from 'react';
import { Square, Pause, Play, Volume2, ListMusic } from 'lucide-react';
import { speech, type SpeechStatus } from '../lib/speech';
import { LANGS, LANG_CODES, normaliseLang } from '../../../shared/lang';
import { useSpeech } from '../lib/voice';

const LABEL: Partial<Record<SpeechStatus, string>> = { listening: 'Listening…', processing: 'Thinking…', thinking: 'Thinking…', speaking: 'Speaking…', paused: 'Paused' };
const btn = 'inline-flex items-center justify-center gap-2 rounded-full min-h-11 min-w-11 px-4 font-bold text-base border-2 transition-colors';

/**
 * Voice controls appear only while SaySafe is listening or speaking: nothing stays on screen while idle.
 * In the Assistant: a compact labelled bar while listening, thinking or speaking. On other screens: only while
 * SaySafe is speaking. Stop (with the word "Stop") is always visible then; Pause/Resume only while speaking.
 * Escape stops from anywhere. Mute, replay and settings live in the Assistant menu and in Profile.
 */
export function VoiceBar({ scope = 'other' }: { scope?: 'assistant' | 'other' }) {
  const s = useSpeech();
  const speakingNow = s.status === 'speaking' || s.status === 'paused';
  const busy = s.status === 'listening' || s.status === 'processing' || s.status === 'thinking';
  const show = speakingNow || (scope === 'assistant' && busy);

  // Escape stops speech from anywhere (it does not steal Escape from open dialogs: those stop propagation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && ['speaking', 'paused', 'listening', 'processing'].includes(speech.getSnapshot().status)) speech.stopAll(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!show) return null;
  const label = LABEL[s.status] ?? '';
  const dot = s.status === 'listening' ? 'bg-danger' : speakingNow ? 'bg-teal' : 'bg-amber';
  return (
    <div role="region" aria-label="Voice controls" data-testid="voice-bar">
      <div className="mx-auto max-w-5xl px-4 sm:px-5 py-1.5 flex items-center gap-2">
        <p className="min-w-0 flex-1 flex items-center gap-2 text-base" aria-live="polite">
          <span className={`size-2.5 rounded-full shrink-0 ${dot}`} aria-hidden />
          <span className="font-bold whitespace-nowrap">{label}</span>
          {s.segment && <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-amber-soft text-amber font-bold text-sm px-2 py-0.5 whitespace-nowrap"><ListMusic className="size-4" aria-hidden />{s.segment.index} of {s.segment.total}</span>}
          {s.caption && <span className="min-w-0 truncate text-ink-soft hidden min-[400px]:inline" title={s.caption}>“{s.caption}”</span>}
        </p>
        {speakingNow && (
          <button type="button" onClick={() => speech.togglePause()} className={`${btn} border-line text-navy hover:border-teal`}>
            {s.status === 'paused' ? <Play className="size-5" aria-hidden /> : <Pause className="size-5" aria-hidden />}{s.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
        )}
        <button type="button" onClick={() => speech.stopAll()} className={`${btn} bg-danger border-danger text-white hover:bg-[#7f1724]`}>
          <Square className="size-4" aria-hidden fill="currentColor" />Stop<span className="sr-only">{speakingNow ? ' speaking' : s.status === 'listening' ? ' listening' : ''}</span>
        </button>
      </div>
    </div>
  );
}


/** Voice settings, shared by the voice bar's settings panel and the Profile page. */
export function VoiceSettings({ className = '', parts = 'all' }: { className?: string; parts?: 'all' | 'voice' | 'language' }) {
  const s = useSpeech();
  if (parts === 'language') return <LanguageSetting className={className} />;
  return (
          <fieldset className={`rounded-2xl border border-line bg-ivory p-4 flex flex-wrap gap-x-6 gap-y-3 items-center ${className}`}>
            <legend className="sr-only">Voice settings</legend>
            <label className="inline-flex items-center gap-3 min-h-11 font-bold cursor-pointer">
              <input type="checkbox" className="size-6 accent-[var(--color-teal)]" checked={s.prefs.autoSpeak} onChange={(e) => speech.setPrefs({ autoSpeak: e.target.checked })} />
              Speak short replies automatically
            </label>
            <label className="inline-flex items-center gap-3 min-h-11 font-bold cursor-pointer">
              <input type="checkbox" className="size-6 accent-[var(--color-teal)]" checked={s.prefs.readAll} onChange={(e) => speech.setPrefs({ readAll: e.target.checked })} />
              Read everything (whole results lists)
            </label>
            {parts === 'all' && <LanguageSetting bare />}
            <label className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 min-h-11 font-bold max-w-full">
              Speed
              <select className="min-h-11 rounded-full border-2 border-line bg-paper px-3" value={String(s.prefs.rate)} onChange={(e) => speech.setPrefs({ rate: Number(e.target.value) })}>
                <option value="0.8">Slower</option>
                <option value="0.95">Normal</option>
                <option value="1.1">Faster</option>
              </select>
            </label>
          </fieldset>
  );
}

/** Per-card / per-section "Read aloud" (user-chosen, so it plays even when auto-speak is off). */
export function ReadAloud({ text, label = 'Read aloud', className = '', lang }: { text: string | string[]; label?: string; className?: string; lang?: string }) {
  return (
    <button type="button" onClick={() => speech.speak(text, { priority: 'user', lang: normaliseLang(lang) })} className={`inline-flex items-center gap-2 font-bold text-teal underline underline-offset-4 min-h-11 ${className}`}>
      <Volume2 className="size-5" aria-hidden />{label}
    </button>
  );
}

/** Reply language (beta). Stored with the voice settings on this device. */
export function LanguageSetting({ className = '', bare = false }: { className?: string; bare?: boolean }) {
  const s = useSpeech();
  const body = (
    <>
      <label className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 min-h-11 font-bold max-w-full">
        Reply language (beta)
        <select className="min-h-11 rounded-full border-2 border-line bg-paper px-3" value={s.prefs.lang} onChange={(e) => { speech.stop(); speech.setPrefs({ lang: normaliseLang(e.target.value) }); }}>
          {LANG_CODES.map((c) => <option key={c} value={c} lang={LANGS[c].bcp47}>{LANGS[c].label}</option>)}
        </select>
      </label>
      {s.prefs.lang !== 'en' && <p className="w-full text-base text-ink-soft">SaySafe answers and listens in {LANGS[s.prefs.lang].name} where it can. Screens stay in English{speech.hasVoice(s.prefs.lang) ? '' : `. No ${LANGS[s.prefs.lang].name} voice on this device, so replies are shown as text`}.</p>}
    </>
  );
  return bare ? body : <div className={`flex flex-wrap gap-x-6 gap-y-2 items-center ${className}`}>{body}</div>;
}
/** Spoken replies on/off (the old mute button). */
export function MuteSwitch() {
  const s = useSpeech();
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="font-bold" id="mute-l">Spoken replies</span>
      <button type="button" role="switch" aria-checked={!s.prefs.muted} aria-labelledby="mute-l" disabled={!s.supported} onClick={() => speech.toggleMute()}
        className={`shrink-0 min-h-12 min-w-20 px-4 rounded-full border-2 font-bold inline-flex items-center gap-2 ${!s.prefs.muted ? 'bg-navy text-white border-navy' : 'bg-paper border-line hover:border-teal'}`}><Volume2 className="size-5" aria-hidden />{s.prefs.muted ? 'Off' : 'On'}</button>
    </div>
  );
}
