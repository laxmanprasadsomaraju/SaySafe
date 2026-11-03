/**
 * /family/insights/studio — optional AG Studio view.
 * Renders only when the server config says INSIGHTS_DASHBOARD=agstudio AND the build carries a licence key
 * (or the local-only eval switch). Otherwise redirects to the native dashboard.
 * The AG Studio chunk is lazy-loaded; if it fails to load, throws while rendering, or takes too long,
 * the native dashboard is shown instead (no blank page).
 */
import { Component, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import NativeInsights from './NativeInsights';
import { useConfig } from '../../lib/insightsApi';
import { loadWithTimeout, studioAllowed } from '../../lib/insightsChoice';

class FallbackBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.warn('[insights] AG Studio view failed; showing native dashboard.', err); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export const importStudio = () => import('./StudioDashboard');

export default function StudioRoute({ importer = importStudio, timeoutMs = 15000 }: { importer?: () => Promise<{ default: ComponentType }>; timeoutMs?: number }) {
  const cfg = useConfig();
  const [Comp, setComp] = useState<ComponentType | null | 'failed'>(null);
  const allowed = cfg ? studioAllowed(cfg, import.meta.env) : null;
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    loadWithTimeout(importer, timeoutMs).then((m) => { if (alive) setComp(() => (m ? m.default : 'failed')); });
    return () => { alive = false; };
  }, [allowed, importer, timeoutMs]);
  if (cfg === null) return <p className="p-8">Loading…</p>;
  if (!allowed) return <Navigate to="/family/insights" replace />;
  if (Comp === 'failed') return <NativeInsights />;
  if (!Comp) return <p className="p-8">Loading dashboard…</p>;
  return <FallbackBoundary fallback={<NativeInsights />}><Comp /></FallbackBoundary>;
}
