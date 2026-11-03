/**
 * App shell: one navigation for the whole app.
 * Mobile and tablet (< 1024 px): bottom tab bar (Home, Assistant, Activity, Profile). Desktop: the same four in the header.
 * Secondary screens get a history-aware Back button with a sensible fallback.
 * The bottom stack (page dock, voice controls, tab bar) is measured so content is never hidden behind it.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { House, MessageCircle, ListChecks, UserRound, ArrowLeft, Globe } from 'lucide-react';
import { VoiceBar } from './VoiceBar';
import { useHandoff } from '../lib/handoff';
import { rememberRole } from '../lib/role';

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 64 64" className="size-9 sm:size-10" aria-hidden><rect width="64" height="64" rx="16" fill="var(--color-teal)" /><path d="M32 13l15 6v11c0 10-6.4 17.6-15 21-8.6-3.4-15-11-15-21V19l15-6z" fill="#F7F8F4" /><path d="M25 32l5 5 10-11" stroke="var(--color-teal)" strokeWidth="4.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span className="font-display text-xl sm:text-2xl font-semibold tracking-tight">SaySafe</span>
    </span>
  );
}

type Mode = 'elder' | 'family' | 'public';
interface Dest { to: string; label: string; icon: typeof House; match: (p: string) => boolean }

export function destinations(mode: 'elder' | 'family'): Dest[] {
  if (mode === 'family') return [
    { to: '/family', label: 'Home', icon: House, match: (p) => p === '/family' || p.startsWith('/family/insights') },
    { to: '/family/assistant', label: 'Assistant', icon: MessageCircle, match: (p) => p === '/family/assistant' },
    { to: '/activity?as=family', label: 'Activity', icon: ListChecks, match: (p) => p === '/activity' },
    { to: '/profile?as=family', label: 'Profile', icon: UserRound, match: (p) => p === '/profile' },
  ];
  return [
    { to: '/home', label: 'Home', icon: House, match: (p) => p === '/home' },
    { to: '/assistant', label: 'Assistant', icon: MessageCircle, match: (p) => p === '/assistant' || ['/check', '/shop', '/discover'].some((x) => p.startsWith(x)) },
    { to: '/activity', label: 'Activity', icon: ListChecks, match: (p) => p === '/activity' || p.startsWith('/order') },
    { to: '/profile', label: 'Profile', icon: UserRound, match: (p) => p === '/profile' || ['/preferences', '/help', '/guide'].includes(p) },
  ];
}
/** Primary tabs never show Back or Home. Everything else is a secondary screen with Back. */
export const PRIMARY = new Set(['/home', '/assistant', '/activity', '/profile', '/family', '/family/assistant']);

/** Where Back goes when there is no in-app history (opened from a link, or after a reload). */
export function fallbackFor(path: string, mode: Mode): string {
  if (path.startsWith('/order') || path.startsWith('/checkout')) return mode === 'family' ? '/activity?as=family' : '/activity';
  if (['/check', '/shop', '/discover'].some((p) => path.startsWith(p))) return '/assistant';
  if (['/help', '/guide', '/preferences'].includes(path)) return mode === 'family' ? '/profile?as=family' : '/profile';
  if (path.startsWith('/family/insights/')) return '/family/insights';
  if (path.startsWith('/family')) return '/family';
  return mode === 'family' ? '/family' : '/home';
}

export function BackButton({ fallback, historyAware = true }: { fallback: string; historyAware?: boolean }) {
  const nav = useNavigate();
  const go = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (historyAware && idx > 0) nav(-1); else nav(fallback);
  };
  return (
    <button type="button" onClick={go} className="inline-flex items-center gap-2 min-h-12 min-w-12 pl-2 pr-4 -ml-2 rounded-full font-bold text-teal hover:bg-teal-soft">
      <ArrowLeft className="size-6" aria-hidden />Back
    </button>
  );
}

function NavItems({ mode, variant }: { mode: 'elder' | 'family'; variant: 'top' | 'bottom' }) {
  const { pathname } = useLocation();
  return (
    <ul className={variant === 'bottom' ? 'grid grid-cols-4' : 'flex gap-1'}>
      {destinations(mode).map((d) => {
        const exact = d.to.split('?')[0] === pathname;
        const inSection = d.match(pathname);
        const Icon = d.icon;
        const cls = variant === 'bottom'
          ? `flex flex-col items-center justify-center gap-0.5 min-h-16 px-1 text-[0.8125rem] leading-tight font-bold ${inSection ? 'text-teal-deep' : 'text-ink-soft'}`
          : `inline-flex items-center gap-2 min-h-12 px-4 rounded-full font-bold ${inSection ? 'bg-teal-soft text-teal-deep' : 'text-navy hover:bg-teal-soft'}`;
        return (
          <li key={d.to}>
            <NavLink to={d.to} end aria-current={exact ? 'page' : undefined} className={cls}>
              {variant === 'bottom'
                ? <span className={`grid place-items-center rounded-full w-14 h-8 ${inSection ? 'bg-teal-soft' : ''}`}><Icon className="size-6" aria-hidden /></span>
                : <Icon className="size-5" aria-hidden />}
              <span>{d.label}</span>
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}

export function Layout({ children, mode = 'elder', wide = false, dock, footer = true, back }: {
  children: ReactNode; mode?: Mode; wide?: boolean; dock?: ReactNode; footer?: boolean; back?: string | false;
}) {
  const loc = useLocation();
  const handoff = useHandoff();
  const stack = useRef<HTMLDivElement>(null);
  // Scroll position is handled by <ScrollRestoration /> (top on a new screen, restored on Back); focus moves to the page.
  useEffect(() => { document.getElementById('main')?.focus({ preventScroll: true }); }, [loc.pathname]);
  useEffect(() => { if (mode !== 'public') rememberRole(mode); }, [mode]);
  // Keep the page's bottom padding equal to the fixed bottom stack, so nothing is ever hidden behind it.
  useLayoutEffect(() => {
    const el = stack.current;
    const set = () => document.documentElement.style.setProperty('--stack-h', `${el?.offsetHeight ?? 0}px`);
    set();
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set); ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.setProperty('--stack-h', '0px'); };
  });

  const p = loc.pathname;
  const app = mode !== 'public';
  const external = p.startsWith('/checkout/');
  const showNav = app && !external && !handoff && p !== '/family/pair';
  const showBack = app && back !== false && !PRIMARY.has(p) && p !== '/family/pair';
  const width = mode === 'public' ? 'max-w-7xl md:px-10' : wide ? 'max-w-7xl' : 'max-w-5xl';
  return (
    <div className="min-h-dvh flex flex-col" style={{ paddingBottom: 'var(--stack-h, 0px)' }}>
      <a href="#main" className="skip-link">Skip to main content</a>
      <header className="border-b border-line bg-ivory/95 backdrop-blur sticky top-0 z-20">
        <div className={`mx-auto ${width} px-4 sm:px-5 py-2.5 flex items-center gap-2 justify-between`}>
          <Link to={mode === 'family' ? '/family' : mode === 'public' ? '/' : '/home'} aria-label="SaySafe home" className="min-h-12 inline-flex items-center"><Logo /></Link>
          <div className="flex items-center gap-1">
            {/* Top tabs from 1024 px: at 768 the four tabs + website link overflowed the header. Tablets keep the bottom bar. */}
            {showNav && <nav aria-label="Main" className="hidden lg:block"><NavItems mode={mode as 'elder' | 'family'} variant="top" /></nav>}
            {/* Back to the public website (the landing page) without signing out. */}
            {app && <Link to="/" className="inline-flex items-center gap-1.5 min-h-12 px-3 rounded-full font-bold text-teal underline underline-offset-4 hover:bg-teal-soft" data-testid="website-link"><Globe className="size-5" aria-hidden /><span className="max-[359px]:sr-only">SaySafe website</span></Link>}
          </div>
        </div>
      </header>
      {showBack && (
        <div className={`mx-auto w-full ${width} px-5 pt-3`}>
          <BackButton fallback={typeof back === 'string' ? back : fallbackFor(p, mode)} historyAware={!external} />
        </div>
      )}
      <main id="main" tabIndex={-1} className={mode === 'public' ? 'flex-1 w-full outline-none' : `flex-1 mx-auto w-full ${width} px-5 ${showBack ? 'pt-3 pb-8 md:pb-12' : 'py-6 md:py-10'} outline-none`}>{children}</main>
      {footer && (
        <footer className="border-t border-line text-ink-soft text-base">
          <div className={`mx-auto ${width} px-5 py-6 flex flex-wrap gap-x-6 gap-y-2 justify-between`}>
            <p>SaySafe — Shop simply. Pay safely. Demo uses the PayPal sandbox; no real money moves.</p>
            <p><Link className="underline" to="/guide">How to use SaySafe</Link> · Not affiliated with PayPal. <a className="underline" href="https://github.com/laxmanprasadsomaraju/SaySafe" target="_blank" rel="noreferrer">Open source (MIT)</a></p>
          </div>
        </footer>
      )}
      {app && (
        // Each part draws its own top border, so an empty stack on desktop (no dock, no voice bar, tabs in the header)
        // no longer leaves a stray 1 px line across the bottom of the screen, and stacked parts never double up.
        <div ref={stack} data-testid="bottom-stack" className="fixed inset-x-0 bottom-0 z-30 bg-paper/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
          {/* The composer is a labelled region (like the voice bar) so its controls and sr-only label sit inside a landmark. */}
          {dock && !handoff && <div role="region" aria-label="Message composer" className="border-t border-line">{dock}</div>}
          {mode === 'elder' && <VoiceBar scope={p === '/assistant' ? 'assistant' : 'other'} />}
          {showNav && <nav aria-label="Main" className="lg:hidden border-t border-line"><NavItems mode={mode as 'elder' | 'family'} variant="bottom" /></nav>}
        </div>
      )}
    </div>
  );
}
