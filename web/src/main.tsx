import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
import { ServerStatusBanner } from './components/ServerStatus';

// Insights pages are lazy so the main bundle does not grow. The native page never imports AG packages.
const NativeInsights = lazy(() => import('./pages/insights/NativeInsights'));
const StudioRoute = lazy(() => import('./pages/insights/StudioRoute'));
const insightsFallback = <p className="p-8">Loading…</p>;

// Apply saved display preferences before first paint.
if (localStorage.getItem('ss-large') === 'on') document.documentElement.classList.add('large-text');
if (localStorage.getItem('ss-contrast') === 'on') document.documentElement.classList.add('high-contrast');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ServerStatusBanner />
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/home" element={<Home />} />
        <Route path="/check" element={<Check />} />
        <Route path="/shop" element={<Shop />} />
        <Route path="/order/:id" element={<Order />} />
        <Route path="/checkout/return" element={<ReturnGate />} />
        <Route path="/checkout/cancel" element={<Order />} />
        <Route path="/help" element={<Help />} />
        <Route path="/guide" element={<Guide />} />
        <Route path="/discover" element={<Discover />} />
        <Route path="/family" element={<Family />} />
        <Route path="/family/pair" element={<FamilyPair />} />
        <Route path="/family/insights" element={<Suspense fallback={insightsFallback}><NativeInsights /></Suspense>} />
        <Route path="/family/insights/studio" element={<Suspense fallback={insightsFallback}><StudioRoute /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
