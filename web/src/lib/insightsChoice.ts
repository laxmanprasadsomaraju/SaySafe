/**
 * Which insights dashboard to show. Explicit configuration only — never licence detection, and
 * AG Studio's own licence checks are never suppressed or bypassed.
 *
 * The AG Studio view at /family/insights/studio renders only when BOTH:
 *   1. the server says INSIGHTS_DASHBOARD=agstudio (exposed as /api/config → insightsDashboard), and
 *   2. the web build has VITE_AG_STUDIO_LICENSE set (the key is passed to AgStudioProvider unchanged),
 *      OR the build has VITE_AG_STUDIO_LOCAL_EVAL=1 — a local-only evaluation switch for recording a demo
 *      on a developer machine (AG Studio then shows its own unlicensed watermark). Never set it on Render.
 * Anything else → the native SaySafe dashboard at /family/insights.
 */
import type { InsightsDashboard } from '../../../shared/insights';

export interface InsightsClientConfig { insights?: boolean; insightsDashboard?: InsightsDashboard | string }
export interface InsightsBuildEnv { VITE_AG_STUDIO_LICENSE?: string; VITE_AG_STUDIO_LOCAL_EVAL?: string }

export function agStudioLicenseKey(env: InsightsBuildEnv): string | undefined {
  const k = env.VITE_AG_STUDIO_LICENSE?.trim();
  return k ? k : undefined;
}

export function studioAllowed(config: InsightsClientConfig | null | undefined, env: InsightsBuildEnv): boolean {
  if (!config || config.insights === false) return false;
  if (config.insightsDashboard !== 'agstudio') return false;
  return Boolean(agStudioLicenseKey(env)) || env.VITE_AG_STUDIO_LOCAL_EVAL === '1';
}

/**
 * Loads a lazily-imported module with a timeout. Resolves to the module, or to `null` when the import
 * rejects or takes longer than `ms` — the caller then shows the native dashboard instead.
 */
export function loadWithTimeout<T>(importer: () => Promise<T>, ms = 15000): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, ms);
    importer().then(
      (m) => { if (!settled) { settled = true; clearTimeout(t); resolve(m); } },
      () => { if (!settled) { settled = true; clearTimeout(t); resolve(null); } },
    );
  });
}
