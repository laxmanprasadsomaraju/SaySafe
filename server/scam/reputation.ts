/**
 * Threat-intelligence adapters. We only send the URL string to the reputation service;
 * we never open the suspicious URL ourselves.
 * A URL that no source lists is reported as UNKNOWN, never "safe".
 */
import { parse as parseDomain } from 'tldts';

export interface ReputationResult {
  url: string;
  source: string;
  listed: boolean;
  checked: boolean;
  error?: string;
}

/** Small local list of demo/known-bad domains (seeded for the demo; extend via PR). */
const LOCAL_BLOCKLIST = new Set<string>([
  'paypal-secure-login.com',
  'paypa1-support.net',
  'paypal-resolution-centre.info',
]);

async function webRisk(url: string): Promise<ReputationResult | null> {
  const key = process.env.GOOGLE_WEB_RISK_API_KEY;
  if (!key) return null;
  try {
    const q = new URLSearchParams({ uri: url, key });
    ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'].forEach((t) => q.append('threatTypes', t));
    const res = await fetch(`https://webrisk.googleapis.com/v1/uris:search?${q}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { url, source: 'Google Web Risk', listed: false, checked: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as any;
    return { url, source: 'Google Web Risk', listed: Boolean(data?.threat), checked: true };
  } catch (e: any) {
    return { url, source: 'Google Web Risk', listed: false, checked: false, error: e.message };
  }
}

async function phishTank(url: string): Promise<ReputationResult | null> {
  const key = process.env.PHISHTANK_APP_KEY;
  if (!key) return null;
  try {
    const body = new URLSearchParams({ url, format: 'json', app_key: key });
    const res = await fetch('https://checkurl.phishtank.com/checkurl/', {
      method: 'POST',
      body,
      headers: { 'User-Agent': 'phishtank/saysafe-ai' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { url, source: 'PhishTank', listed: false, checked: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as any;
    const r = data?.results;
    return { url, source: 'PhishTank', listed: Boolean(r?.in_database && r?.valid), checked: true };
  } catch (e: any) {
    return { url, source: 'PhishTank', listed: false, checked: false, error: e.message };
  }
}

export async function checkReputation(urls: string[]): Promise<ReputationResult[]> {
  const out: ReputationResult[] = [];
  for (const raw of urls.slice(0, 5)) {
    const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    const reg = parseDomain(host).domain ?? host;
    out.push({ url: raw, source: 'SaySafe local list', listed: LOCAL_BLOCKLIST.has(reg), checked: true });
    const extra = await Promise.all([webRisk(url), phishTank(url)]);
    for (const e of extra) if (e) out.push({ ...e, url: raw });
  }
  return out;
}
