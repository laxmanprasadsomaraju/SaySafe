import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import type { InsightsAgentAnswer, InsightsPayload } from '../../../shared/insights';
import type { InsightsClientConfig } from './insightsChoice';

/** Loads the signed-in family member's own insights. Unauthenticated → pairing page (Mary → her own /insights). */
export function useInsights(pollMs = 15000) {
  const nav = useNavigate();
  const [data, setData] = useState<InsightsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<InsightsPayload>('/api/family/insights')
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => {
        if (!alive) return;
        if (e.status !== 401) return setError(e.message);
        // Mary (no family session) opened the family dashboard link: send her to her own Insights page instead.
        api<{ elder?: unknown; family?: unknown }>('/api/me').then((me) => nav(me?.elder && !me?.family ? '/insights' : '/family/pair', { replace: true })).catch(() => nav('/family/pair', { replace: true }));
      });
    load();
    const t = setInterval(load, pollMs);
    return () => { alive = false; clearInterval(t); };
  }, [nav, pollMs]);
  return { data, error };
}

let configPromise: Promise<InsightsClientConfig> | null = null;
export function fetchConfig(): Promise<InsightsClientConfig> {
  configPromise ??= api<InsightsClientConfig>('/api/config').catch(() => ({ insights: true, insightsDashboard: 'native' }));
  return configPromise;
}
export function useConfig() {
  const [cfg, setCfg] = useState<InsightsClientConfig | null>(null);
  useEffect(() => { fetchConfig().then(setCfg); }, []);
  return cfg;
}

export const askInsights = (question: string) => api<InsightsAgentAnswer>('/api/family/insights/agent', { body: { question } });
