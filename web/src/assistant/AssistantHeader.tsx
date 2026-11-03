/**
 * Assistant header: optional Back (only when opened from another flow), the title, and one labelled menu
 * (New conversation, Voice settings, Display). The menu is a disclosure (button + panel), not an ARIA menu,
 * so every control inside is an ordinary, labelled button or switch.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Menu, X, RotateCcw, SlidersHorizontal, Type, Contrast, BookOpen } from 'lucide-react';
import { VoiceSettings, MuteSwitch } from '../components/VoiceBar';
import { useDisplay, setDisplay } from '../lib/display';
import { useSpeech, speech } from '../lib/voice';
import { switchBtn } from '../components/ds';

export function AssistantHeader({ onNew, voice = true }: { onNew: () => void; voice?: boolean }) {
  const loc = useLocation();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<null | 'voice' | 'display'>(null);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const d = useDisplay();
  const s = useSpeech();
  const back = (loc.state as { back?: string } | null)?.back;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  const item = 'w-full flex items-center gap-3 min-h-12 px-4 rounded-2xl font-bold text-left hover:bg-teal-soft';
  const sw = switchBtn;
  // Sticky right under the site header, so "Menu" (new conversation, voice, display) never scrolls away in a long
  // conversation. Static on short screens (see index.css, max-height 26rem). -mx/px keep the bar's background full width.
  return (
    <div className="assistant-bar sticky z-10 -mx-5 px-5 py-1.5 bg-ivory/95 backdrop-blur" style={{ top: 'var(--header-h, 0px)' }} data-testid="assistant-bar">
      <div className="flex items-center gap-2">
        {back && (
          <button type="button" onClick={() => { const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0; if (idx > 0) nav(-1); else nav(back); }} className="inline-flex items-center gap-1 min-h-12 min-w-12 pl-2 pr-3 -ml-2 rounded-full font-bold text-teal hover:bg-teal-soft">
            <ArrowLeft className="size-6" aria-hidden />Back
          </button>
        )}
        <h1 className="flex-1 min-w-0 text-[1.6rem] sm:text-[length:var(--text-title)] leading-tight">SaySafe Assistant</h1>
        <button ref={btn} type="button" aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open); setPanel(null); }}
          className={`shrink-0 inline-flex items-center gap-2 min-h-12 px-4 rounded-full border-2 font-bold ${open ? 'border-teal text-teal' : 'border-line hover:border-teal'}`}>
          {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}Menu<span className="sr-only">: conversation options</span>
        </button>
      </div>
      {open && (
        <div id={id} role="group" aria-label="Conversation options" className="mt-2 rounded-[var(--radius-card)] border border-line bg-paper shadow-[var(--shadow-card)] p-2 overflow-y-auto overscroll-contain" style={{ maxHeight: 'calc(100dvh - var(--header-h, 0px) - var(--stack-h, 0px) - 6rem)' }}>
          <button type="button" className={item} onClick={() => { setOpen(false); onNew(); }}><RotateCcw className="size-5 text-teal" aria-hidden />New conversation</button>
          {voice && (
            <>
              <button type="button" className={item} aria-expanded={panel === 'voice'} onClick={() => setPanel(panel === 'voice' ? null : 'voice')}><SlidersHorizontal className="size-5 text-teal" aria-hidden />Voice settings</button>
              {panel === 'voice' && (
                <div className="px-2 pb-2">
                  <MuteSwitch />
                  {s.canReplay && <button type="button" className={item} onClick={() => speech.replay()}><RotateCcw className="size-5 text-teal" aria-hidden />Replay the last reply</button>}
                  <VoiceSettings />
                </div>
              )}
            </>
          )}
          <button type="button" className={item} aria-expanded={panel === 'display'} onClick={() => setPanel(panel === 'display' ? null : 'display')}><Type className="size-5 text-teal" aria-hidden />Display</button>
          {panel === 'display' && (
            <div className="px-4 pb-2 divide-y divide-line">
              <div className="flex items-center justify-between gap-3 py-2"><span className="font-bold" id={`${id}-l`}>Bigger text</span><button type="button" role="switch" aria-checked={d.large} aria-labelledby={`${id}-l`} onClick={() => setDisplay('large', !d.large)} className={sw(d.large)}>{d.large ? 'On' : 'Off'}</button></div>
              <div className="flex items-center justify-between gap-3 py-2"><span className="font-bold inline-flex items-center gap-2" id={`${id}-c`}><Contrast className="size-5" aria-hidden />High contrast</span><button type="button" role="switch" aria-checked={d.contrast} aria-labelledby={`${id}-c`} onClick={() => setDisplay('contrast', !d.contrast)} className={sw(d.contrast)}>{d.contrast ? 'On' : 'Off'}</button></div>
              <p className="py-2 text-sm text-ink-soft">Saved on this device. More in Profile › Accessibility.</p>
            </div>
          )}
          <Link to="/learn" className={item} data-testid="assistant-menu-learn"><BookOpen className="size-5 text-teal" aria-hidden />Help: step-by-step guides</Link>
        </div>
      )}
    </div>
  );
}
