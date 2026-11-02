import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { House, Type, Contrast, Volume2, VolumeX } from 'lucide-react';
import { stopSpeaking } from '../lib/voice';

function usePref(key: string, cls: string | null) {
  const [on, setOn] = useState(() => localStorage.getItem(key) === 'on');
  useEffect(() => {
    if (cls) document.documentElement.classList.toggle(cls, on);
    localStorage.setItem(key, on ? 'on' : 'off');
  }, [on, key, cls]);
  return [on, setOn] as const;
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 64 64" className="size-10" aria-hidden><rect width="64" height="64" rx="16" fill="var(--color-teal)" /><path d="M32 13l15 6v11c0 10-6.4 17.6-15 21-8.6-3.4-15-11-15-21V19l15-6z" fill="#F7F8F4" /><path d="M25 32l5 5 10-11" stroke="var(--color-teal)" strokeWidth="4.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span className="font-display text-2xl font-semibold tracking-tight">SaySafe</span>
    </span>
  );
}

export function Layout({ children, mode = 'elder' }: { children: ReactNode; mode?: 'elder' | 'family' | 'public' }) {
  const [large, setLarge] = usePref('ss-large', 'large-text');
  const [contrast, setContrast] = usePref('ss-contrast', 'high-contrast');
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem('ss-voice') !== 'off');
  const loc = useLocation();
  useEffect(() => { localStorage.setItem('ss-voice', voiceOn ? 'on' : 'off'); if (!voiceOn) stopSpeaking(); }, [voiceOn]);
  useEffect(() => { stopSpeaking(); window.scrollTo(0, 0); document.getElementById('main')?.focus({ preventScroll: true }); }, [loc.pathname]);

  const toggle = 'inline-flex items-center gap-2 rounded-full border-2 px-4 min-h-12 font-bold text-base';
  return (
    <div className="min-h-dvh flex flex-col">
      <a href="#main" className="skip-link">Skip to main content</a>
      <header className="border-b border-line bg-ivory/90 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-5xl px-5 py-3 flex flex-wrap items-center gap-3 justify-between">
          <Link to={mode === 'family' ? '/family' : mode === 'public' ? '/' : '/home'} aria-label="SaySafe home"><Logo /></Link>
          <nav aria-label="Display settings" className="flex flex-wrap gap-2">
            {mode === 'elder' && loc.pathname !== '/home' && (
              <NavLink to="/home" className={`${toggle} border-teal text-teal`}><House className="size-5" aria-hidden />Home</NavLink>
            )}
            <button type="button" className={`${toggle} ${large ? 'bg-navy text-white border-navy' : 'border-line'}`} aria-pressed={large} onClick={() => setLarge(!large)}><Type className="size-5" aria-hidden />Bigger text</button>
            <button type="button" className={`${toggle} ${contrast ? 'bg-navy text-white border-navy' : 'border-line'}`} aria-pressed={contrast} onClick={() => setContrast(!contrast)}><Contrast className="size-5" aria-hidden />High contrast</button>
            {mode !== 'family' && (
              <button type="button" className={`${toggle} ${voiceOn ? 'border-line' : 'bg-navy text-white border-navy'}`} aria-pressed={!voiceOn} onClick={() => setVoiceOn(!voiceOn)}>
                {voiceOn ? <Volume2 className="size-5" aria-hidden /> : <VolumeX className="size-5" aria-hidden />}{voiceOn ? 'Voice on' : 'Voice off'}
              </button>
            )}
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 mx-auto w-full max-w-5xl px-5 py-8 md:py-12 outline-none">{children}</main>
      <footer className="border-t border-line text-ink-soft text-base">
        <div className="mx-auto max-w-5xl px-5 py-6 flex flex-wrap gap-x-6 gap-y-2 justify-between">
          <p>SaySafe — Shop simply. Pay safely. Demo uses the PayPal sandbox; no real money moves.</p>
          <p>Not affiliated with PayPal. <a className="underline" href="https://github.com/laxmanprasadsomaraju/SaySafe" target="_blank" rel="noreferrer">Open source (MIT)</a></p>
        </div>
      </footer>
    </div>
  );
}
