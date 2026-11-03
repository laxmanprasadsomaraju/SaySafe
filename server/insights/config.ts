/**
 * Explicit insights configuration (never licence detection).
 *  FEATURE_INSIGHTS     on|off      default on  — the whole Insights feature (endpoints + link).
 *  INSIGHTS_DASHBOARD   native|agstudio  default native — which dashboard /family/insights/studio may show.
 * The AG Studio view additionally requires VITE_AG_STUDIO_LICENSE at web build time (checked in the browser);
 * the public deployment stays native.
 */
import type { InsightsDashboard } from '../../shared/insights.js';

export function insightsConfig(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; dashboard: InsightsDashboard } {
  const enabled = !/^(0|off|false|no)$/i.test(env.FEATURE_INSIGHTS ?? 'on');
  const dashboard: InsightsDashboard = (env.INSIGHTS_DASHBOARD ?? '').toLowerCase() === 'agstudio' ? 'agstudio' : 'native';
  return { enabled, dashboard };
}
