import { useEffect, useId } from 'react';
import { Square, Pause, Play, Volume2, VolumeX, ListMusic } from 'lucide-react';
import { speech, voiceEffect, type SpeechStatus } from '../lib/speech';
import { switchBtn } from './ds';
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
    <div role="region" aria-label="Voice controls" data-testid="voice-bar" className="border-t border-line">
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


/** Shown under an automatic option that is ticked but held back by muted playback. */
const Held = () => <span className="mt-1 inline-flex items-center gap-1 rounded-xl border border-amber/40 bg-amber-soft px-2.5 py-0.5 text-sm font-bold text-amber">Saved · won’t play while muted</span>;

/**
 * Voice settings, shared by the Assistant menu and Profile. Voice playback (MuteSwitch) is the master switch;
 * these are the automatic-speaking preferences. While playback is muted they stay saved and editable, and the
 * group says plainly that they won't play until playback is turned on (voiceEffect() in speech.ts is the one
 * source for that wording and for what speakNow() actually does).
 */
export function VoiceSettings({ className = '', parts = 'all' }: { className?: string; parts?: 'all' | 'voice' | 'language' }) {
  const s = useSpeech();
  const id = useId();
  if (parts === 'language') return <LanguageSetting className={className} />;
  const fx = voiceEffect(s.prefs, s.supported);
  const held = fx.playback !== 'on';
  const row = 'flex items-start gap-3 min-h-12 py-2 cursor-pointer';
  return (
    <fieldset className={`${className}`} aria-describedby={held ? `${id}-held` : undefined} data-testid="voice-settings">
      <legend className="sr-only">Automatic speaking</legend>
      {held && <p id={`${id}-held`} role="status" className="mb-2 rounded-2xl bg-amber-soft text-navy px-4 py-3 text-base" data-testid="voice-held">{fx.note}</p>}
      <div className="divide-y divide-line">
        <label className={row}>
          <input type="checkbox" className="mt-1 size-6 shrink-0 accent-[var(--color-teal)]" checked={s.prefs.autoSpeak} onChange={(e) => speech.setPrefs({ autoSpeak: e.target.checked })} aria-describedby={`${id}-auto`} />
          <span className="min-w-0 flex-1"><span className="block font-bold">Automatically speak short replies</span><span id={`${id}-auto`} className="block text-base text-ink-soft">Short answers and safety warnings are read out as they arrive.</span>{fx.autoShort === 'saved-muted' && <Held />}</span>
        </label>
        <label className={row}>
          <input type="checkbox" className="mt-1 size-6 shrink-0 accent-[var(--color-teal)]" checked={s.prefs.readAll} onChange={(e) => speech.setPrefs({ readAll: e.target.checked })} aria-describedby={`${id}-all`} />
          <span className="min-w-0 flex-1"><span className="block font-bold">Read entire results</span><span id={`${id}-all`} className="block text-base text-ink-soft">Reads every product in a results list, one after another.</span>{fx.readAll === 'saved-muted' && <Held />}</span>
        </label>
        {parts === 'all' && <div className="py-2"><LanguageSetting bare /></div>}
        <label className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 min-h-12 py-2 font-bold">
          Speaking speed
          <select className="min-h-12 rounded-full border-2 border-line bg-paper px-3" value={String(s.prefs.rate)} onChange={(e) => speech.setPrefs({ rate: Number(e.target.value) })}>
            <option value="0.8">Slower</option>
            <option value="0.95">Normal</option>
            <option value="1.1">Faster</option>
          </select>
        </label>
      </div>
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
      <label className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 min-h-12 font-bold max-w-full">
        Reply language (beta)
        <select className="min-h-12 rounded-full border-2 border-line bg-paper px-3" value={s.prefs.lang} onChange={(e) => { speech.stop(); speech.setPrefs({ lang: normaliseLang(e.target.value) }); }}>
          {LANG_CODES.map((c) => <option key={c} value={c} lang={LANGS[c].bcp47}>{LANGS[c].label}</option>)}
        </select>
      </label>
      {s.prefs.lang !== 'en' && <p className="w-full text-base text-ink-soft">SaySafe answers and listens in {LANGS[s.prefs.lang].name} where it can. Screens stay in English{speech.hasVoice(s.prefs.lang) ? '' : `. No ${LANGS[s.prefs.lang].name} voice on this device, so replies are shown as text`}.</p>}
    </>
  );
  return bare ? body : <div className={`flex flex-wrap gap-x-6 gap-y-2 items-center ${className}`}>{body}</div>;
}
/** Voice playback: the master On / Muted switch (was "Spoken replies"). */
export function MuteSwitch() {
  const s = useSpeech();
  const id = useId();
  const on = !s.prefs.muted && s.supported;
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="min-w-0"><span className="block font-bold" id={`${id}-l`}>Voice playback</span><span className="block text-base text-ink-soft" id={`${id}-h`}>{!s.supported ? 'Not available in this browser.' : on && s.needsTap ? 'On. Tap to enable sound: your browser waits for a first tap before SaySafe can speak.' : on ? 'SaySafe can speak to you.' : 'Muted: SaySafe won’t speak on its own.'}</span></span>
      <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-l`} aria-describedby={`${id}-h`} disabled={!s.supported} onClick={() => speech.toggleMute()}
        className={switchBtn(on)} data-testid="voice-playback">{on ? <Volume2 className="size-5" aria-hidden /> : <VolumeX className="size-5" aria-hidden />}{!s.supported ? 'Off' : on ? 'On' : 'Muted'}</button>
    </div>
  );
}
