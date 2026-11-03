import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { useEffect, useLayoutEffect } from 'react';
import { createBrowserRouter, createRoutesFromElements, RouterProvider, Route, Navigate, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { speech } from './lib/speech';
import { applyDisplayPrefs } from './lib/display';
import Preferences from './pages/Preferences';
import './index.css';
import Welcome from './pages/Welcome';
import Home from './pages/Home';
import Check from './pages/Check';
import Shop from './pages/Shop';
import Order from './pages/Order';
import Help from './pages/Help';
import Guide from './pages/Guide';
import Discover from './pages/Discover';
import ReturnGate from './pages/ReturnGate';
import Family, { FamilyPair } from './pages/Family';
import Assistant from './pages/Assistant';
import FamilyAssistant from './pages/FamilyAssistant';
import Activity from './pages/Activity';
import Profile from './pages/Profile';
import { ServerStatusBanner } from './components/ServerStatus';

// Insights pages are lazy so the main bundle does not grow. The native page never imports AG packages.
const NativeInsights = lazy(() => import('./pages/insights/NativeInsights'));
const StudioRoute = lazy(() => import('./pages/insights/StudioRoute'));
const MyInsights = lazy(() => import('./pages/insights/MyInsights'));
const insightsFallback = <p className="p-8">Loading…</p>;

// Apply saved display preferences (bigger text, contrast, reduced motion) before first paint.
applyDisplayPrefs();

/** Any navigation silences SaySafe and makes in-flight replies stale. Rendered BEFORE the routes so its
 *  effect runs before a new page's own mount effects (which may legitimately start speaking). */
function RouteSpeechGuard() {
  const { pathname } = useLocation();
  useEffect(() => { speech.stopAll(); }, [pathname]);
  return null;
}

/**
 * Scroll memory: a new screen starts at the top; Back (browser or in-app, both POP) returns to where you were.
 * Screens load their data after mounting, so the saved position is re-applied for up to ~2 s until the page is tall
 * enough (React Router's ScrollRestoration restores once, too early for these screens).
 */
function ScrollMemory() {
  const loc = useLocation();
  const type = useNavigationType();
  useLayoutEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    const key = `ss-scroll:${loc.key}`;
    let y = 0; try { y = Number(sessionStorage.getItem(key) ?? 0) || 0; } catch { /* */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let userMoved = false;
    if (type === 'POP' && y > 0) {
      let tries = 0;
      const tick = () => { if (userMoved) { timer = undefined; return; } window.scrollTo(0, y); if (Math.abs(window.scrollY - y) > 2 && tries++ < 40) timer = setTimeout(tick, 50); else setTimeout(() => { timer = undefined; }, 100); };
      tick();
    } else window.scrollTo(0, 0);
    const stop = () => { userMoved = true; };
    const save = () => { try { sessionStorage.setItem(key, String(Math.round(window.scrollY))); } catch { /* */ } };
    window.addEventListener('wheel', stop, { passive: true }); window.addEventListener('touchstart', stop, { passive: true }); window.addEventListener('keydown', stop);
    const onScroll = () => { if (timer === undefined || userMoved) save(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { if (timer) clearTimeout(timer); window.removeEventListener('scroll', onScroll); window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop); window.removeEventListener('keydown', stop); };
  }, [loc.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Root() {
  // ScrollRestoration: a new screen starts at the top; Back (browser or in-app) returns to where you were.
  return (<><ServerStatusBanner /><RouteSpeechGuard /><ScrollMemory /><Outlet /></>);
}

// Data router (not <BrowserRouter>) so screens can ask before leaving a pending purchase (useBlocker).
const router = createBrowserRouter(createRoutesFromElements(
  <Route element={<Root />}>
    <Route path="/" element={<Welcome />} />
    <Route path="/home" element={<Home />} />
    <Route path="/assistant" element={<Assistant />} />
    <Route path="/activity" element={<Activity />} />
    <Route path="/profile" element={<Profile />} />
    <Route path="/check" element={<Check />} />
    <Route path="/check/share" element={<Check />} />
    <Route path="/shop" element={<Shop />} />
    <Route path="/order/:id" element={<Order />} />
    <Route path="/checkout/return" element={<ReturnGate />} />
    <Route path="/checkout/cancel" element={<Order />} />
    <Route path="/help" element={<Help />} />
    <Route path="/guide" element={<Guide />} />
    <Route path="/discover" element={<Discover />} />
    <Route path="/preferences" element={<Preferences />} />
    <Route path="/family" element={<Family />} />
    <Route path="/family/pair" element={<FamilyPair />} />
    <Route path="/family/assistant" element={<FamilyAssistant />} />
    <Route path="/insights" element={<Suspense fallback={insightsFallback}><MyInsights /></Suspense>} />
    <Route path="/family/insights" element={<Suspense fallback={insightsFallback}><NativeInsights /></Suspense>} />
    <Route path="/family/insights/studio" element={<Suspense fallback={insightsFallback}><StudioRoute /></Suspense>} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route>,
));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
