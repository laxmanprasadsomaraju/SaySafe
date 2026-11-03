import { useEffect, useId, useState } from 'react';
import { Square, Pause, Play, RotateCcw, Volume2, VolumeX, SlidersHorizontal, ListMusic } from 'lucide-react';
import { speech, type SpeechStatus } from '../lib/speech';
import { LANGS, LANG_CODES, normaliseLang } from '../../../shared/lang';
import { useSpeech } from '../lib/voice';

const CHIP: Record<SpeechStatus, { label: string; cls: string; dot: string }> = {
  ready: { label: 'Ready', cls: 'bg-teal-soft text-teal-deep', dot: 'bg-teal' },
  listening: { label: 'Listening…', cls: 'bg-danger-soft text-danger', dot: 'bg-danger' },
  processing: { label: 'Thinking…', cls: 'bg-amber-soft text-amber', dot: 'bg-amber' },
  thinking: { label: 'Thinking…', cls: 'bg-amber-soft text-amber', dot: 'bg-amber' },
  speaking: { label: 'Speaking…', cls: 'bg-navy text-white', dot: 'bg-white' },
  cancelled: { label: 'Cancelled', cls: 'bg-line text-navy', dot: 'bg-ink-soft' },
  paused: { label: 'Paused', cls: 'bg-amber-soft text-amber', dot: 'bg-amber' },
  muted: { label: 'Muted', cls: 'bg-line text-navy', dot: 'bg-ink-soft' },
  unavailable: { label: 'Voice unavailable', cls: 'bg-line text-navy', dot: 'bg-ink-soft' },
  error: { label: 'Voice error', cls: 'bg-danger-soft text-danger', dot: 'bg-danger' },
};

const btn = 'inline-flex items-center justify-center gap-2 rounded-full min-h-11 min-w-11 px-3 font-bold text-base border-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

/** Compact, always-available voice controls. Stop is prominent whenever SaySafe is talking. */
export function VoiceBar() {
  const s = useSpeech();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const speakingNow = s.status === 'speaking' || s.status === 'paused';
  const active = speakingNow || s.status === 'listening' || s.status === 'processing' || s.status === 'thinking';

  // Escape stops speech from anywhere (it does not steal Escape from open dialogs: those stop propagation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && ['speaking', 'paused', 'listening', 'processing'].includes(speech.getSnapshot().status)) speech.stopAll(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chip = CHIP[s.status];
  return (
    <div role="region" aria-label="Voice controls" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
      {open && (
        <div id={panelId} className="mx-auto max-w-5xl px-4 sm:px-5 pt-3">
          <fieldset className="rounded-2xl border border-line bg-ivory p-4 flex flex-wrap gap-x-6 gap-y-3 items-center">
            <legend className="sr-only">Voice settings</legend>
            <label className="inline-flex items-center gap-3 min-h-11 font-bold cursor-pointer">
              <input type="checkbox" className="size-6 accent-[var(--color-teal)]" checked={s.prefs.autoSpeak} onChange={(e) => speech.setPrefs({ autoSpeak: e.target.checked })} />
              Speak short replies automatically
            </label>
            <label className="inline-flex items-center gap-3 min-h-11 font-bold cursor-pointer">
              <input type="checkbox" className="size-6 accent-[var(--color-teal)]" checked={s.prefs.readAll} onChange={(e) => speech.setPrefs({ readAll: e.target.checked })} />
              Read everything (whole results lists)
            </label>
            <label className="inline-flex items-center gap-3 min-h-11 font-bold">
              Reply language (beta)
              <select className="min-h-11 rounded-full border-2 border-line bg-paper px-3" value={s.prefs.lang} onChange={(e) => { speech.stop(); speech.setPrefs({ lang: normaliseLang(e.target.value) }); }}>
                {LANG_CODES.map((c) => <option key={c} value={c} lang={LANGS[c].bcp47}>{LANGS[c].label}</option>)}
              </select>
            </label>
            {s.prefs.lang !== 'en' && <p className="w-full text-base text-ink-soft">SaySafe will answer and listen in {LANGS[s.prefs.lang].name} where it can. Screens stay in English. Anything not in {LANGS[s.prefs.lang].name} is shown as text, not spoken{speech.hasVoice(s.prefs.lang) ? '' : `. This device has no ${LANGS[s.prefs.lang].name} voice, so replies are shown on screen`}.</p>}
            <label className="inline-flex items-center gap-3 min-h-11 font-bold">
              Speed
              <select className="min-h-11 rounded-full border-2 border-line bg-paper px-3" value={String(s.prefs.rate)} onChange={(e) => speech.setPrefs({ rate: Number(e.target.value) })}>
                <option value="0.8">Slower</option>
                <option value="0.95">Normal</option>
                <option value="1.1">Faster</option>
              </select>
            </label>
          </fieldset>
        </div>
      )}
      <div className="mx-auto max-w-5xl px-4 sm:px-5 py-2 flex flex-col-reverse sm:flex-row sm:items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <span className={`inline-flex items-center gap-2 rounded-full px-3 min-h-9 text-sm font-bold whitespace-nowrap shrink-0 ${chip.cls}`}>
            <span className={`size-2.5 rounded-full ${chip.dot}`} aria-hidden />
            <span><span className="sr-only">Voice status: </span>{chip.label}</span>
          </span>
          <p className="min-w-0 flex-1 text-base text-ink-soft line-clamp-2 break-words" title={s.caption || undefined}>
            {s.segment && <span className="inline-flex items-center gap-1 mr-2 rounded-full bg-amber-soft text-amber font-bold text-sm px-2 py-0.5 whitespace-nowrap"><ListMusic className="size-4" aria-hidden />Reading all · {s.segment.index} of {s.segment.total}</span>}
            {s.caption ? <span className="text-navy">“{s.caption}”</span> : s.status === 'unavailable' ? 'This browser can’t speak. Everything is shown as text.' : s.prefs.readAll ? <span className="font-bold text-amber">Read everything is on</span> : null}
            {s.error && <span className="text-danger font-bold"> {s.error}</span>}
            {!s.caption && s.notice && <span className="text-ink-soft"> {s.notice}</span>}
            {!s.caption && !s.notice && s.micMessage && <span className="text-navy font-bold"> {s.micMessage}</span>}
          </p>
        </div>
        <div className="flex gap-1.5 justify-end shrink-0">
          <button type="button" onClick={() => speech.stopAll()} disabled={!active} aria-label={speakingNow ? 'Stop speaking' : 'Stop'}
            className={`${btn} ${active ? 'bg-danger border-danger text-white hover:bg-[#7f1724]' : 'border-line text-navy'}`}>
            <Square className="size-5" aria-hidden fill="currentColor" /><span className={active ? '' : 'sr-only'}>Stop</span>
          </button>
          <button type="button" onClick={() => speech.togglePause()} disabled={!speakingNow} aria-label={s.status === 'paused' ? 'Resume speaking' : 'Pause speaking'} className={`${btn} border-line text-navy hover:border-teal`}>
            {s.status === 'paused' ? <Play className="size-5" aria-hidden /> : <Pause className="size-5" aria-hidden />}
          </button>
          <button type="button" onClick={() => speech.replay()} disabled={!s.canReplay} aria-label="Replay the last reply" className={`${btn} border-line text-navy hover:border-teal`}>
            <RotateCcw className="size-5" aria-hidden />
          </button>
          <button type="button" onClick={() => speech.toggleMute()} disabled={!s.supported} aria-pressed={s.prefs.muted} aria-label={s.prefs.muted ? 'Unmute voice' : 'Mute voice'}
            className={`${btn} ${s.prefs.muted ? 'bg-navy border-navy text-white' : 'border-line text-navy hover:border-teal'}`}>
            {s.prefs.muted ? <VolumeX className="size-5" aria-hidden /> : <Volume2 className="size-5" aria-hidden />}
          </button>
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={panelId} aria-label="Voice settings" className={`${btn} ${open ? 'border-teal text-teal' : 'border-line text-navy hover:border-teal'}`}>
            <SlidersHorizontal className="size-5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
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
