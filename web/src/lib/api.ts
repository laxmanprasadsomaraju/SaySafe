export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/**
 * Server reachability, for the "Waking up the server…" banner. The free Render instance sleeps when idle and
 * takes ~50 s to start: during that time requests fail at the network level or get a 502/503/504 page from
 * Render's proxy (not our JSON). Those are retried with backoff; our own JSON errors never are.
 */
export type ServerStatus = 'ok' | 'waking' | 'unreachable';
let status: ServerStatus = 'ok';
const listeners = new Set<(s: ServerStatus) => void>();
function setStatus(s: ServerStatus) { if (s !== status) { status = s; listeners.forEach((l) => l(s)); } }
export function onServerStatus(l: (s: ServerStatus) => void) { listeners.add(l); l(status); return () => { listeners.delete(l); }; }

// ~90 s in total: enough for a cold start, short enough to then say so plainly.
const BACKOFF_MS = [1000, 2000, 4000, 8000, 12000, 15000, 15000, 15000, 15000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reply language (beta) from the voice preferences; the server whitelists it. */
function replyLang(): string {
  try { return JSON.parse(localStorage.getItem('ss-voice-prefs') ?? '{}').lang ?? 'en'; } catch { return 'en'; }
}

/**
 * GETs are retried automatically. POSTs only when `idempotent` is set (the server dedupes them, e.g. by
 * idempotency key or PayPal-Request-Id), because a POST that timed out may still have reached the server.
 */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; idempotent?: boolean } = {}): Promise<T> {
  const method = opts.method ?? (opts.body || opts.form ? 'POST' : 'GET');
  const retryable = method === 'GET' || opts.idempotent === true;
  const headers: Record<string, string> = { 'X-SaySafe-Lang': replyLang() };
  if (!opts.form && opts.body) headers['Content-Type'] = 'application/json';
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
        credentials: 'same-origin',
      });
    } catch {
      res = null; // network error: server asleep, restarting, or offline
    }
    const data = res ? await res.json().catch(() => null) : null;
    const coldStart = !res || ([502, 503, 504].includes(res.status) && !(data && typeof data === 'object' && 'error' in data));
    if (coldStart && retryable && attempt < BACKOFF_MS.length) {
      setStatus('waking');
      await sleep(BACKOFF_MS[attempt]);
      continue;
    }
    if (coldStart) {
      setStatus('unreachable');
      throw new ApiError(0, 'unreachable', 'We could not reach SaySafe. Please check your connection and try again. Nothing was charged.');
    }
    setStatus('ok');
    if (!res!.ok) throw new ApiError(res!.status, data?.error ?? 'error', data?.message ?? 'Something went wrong. Please try again.');
    return (data ?? {}) as T;
  }
}

export const eur = (cents: number) => `€${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export interface Product {
  id: string; name: string; category: string; priceCents: number; currency: string; merchant: string;
  rating: number; description: string; plainWords: string; features: string[]; image: string;
}

export type PaymentState =
  | 'DRAFT' | 'RISK_REVIEW' | 'BLOCKED' | 'FAMILY_APPROVAL_PENDING' | 'FAMILY_APPROVED' | 'PAYER_APPROVAL_PENDING'
  | 'PAYER_APPROVED' | 'CAPTURE_PENDING' | 'CAPTURED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';

export interface PaymentRequest {
  id: string; state: PaymentState;
  items: { productId: string; name: string; unitCents: number; quantity: number; lineCents: number; image: string }[];
  merchant: string; amountCents: number; currency: string;
  risk: { ok: boolean; needsFamily: boolean; reasons: string[] } | null;
  approval: { id: string; status: string; expiresAt: number; decidedAt: string | null; reason: string | null } | null;
  receipt: { captureId: string; amount: string; currency: string; payee: string; orderId: string; webhookConfirmed?: boolean } | null;
  createdAt: string; updatedAt: string;
  timeline?: PaymentTimeline;
}

export interface PaymentTimeline {
  label: string;
  events: { kind: 'order_created' | 'buyer_approved' | 'capture_completed' | 'webhook_received'; label: string; at: string; paypalTime: string | null; source: string; verification: string; verified: boolean }[];
  pending: string[];
}
export type ReconcileOutcome = 'captured' | 'buyer_approved' | 'cancelled' | 'pending' | 'no_change' | 'mismatch' | 'unknown' | 'not_applicable' | 'throttled';

export interface ScanResult {
  scanId: string;
  verdict: 'suspicious' | 'needs_verification' | 'verified_official_contact';
  headline: string; spokenSummary: string; spokenLang?: string;
  signals: { code: string; severity: 'high' | 'medium' | 'info'; title: string; detail: string; evidence?: string }[];
  aiReasons: string[];
  safeActions: { label: string; url: string }[];
  phonePolicy: string | null;
  extractedText?: string; ocrUncertain?: boolean;
  ai: { used: boolean; model?: string };
  aiNotice?: string | null;
}

export const newKey = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '');

/** Scan result as the server sends it since the scam-audit branch (three public verdicts, evidence, limits). */
export type ScanVerdict = 'suspicious' | 'needs_checking' | 'no_obvious_warning_signs';
export type FindingBasis = 'deterministic_rule' | 'ai_judgement' | 'independently_verified';
export interface ScanResultV2 extends Omit<ScanResult, 'verdict' | 'signals'> {
  verdict: ScanVerdict;
  verdictLabel: string;
  /** suspicious | needs_verification | verified_official_contact, for older clients. */
  legacyVerdict?: 'suspicious' | 'needs_verification' | 'verified_official_contact';
  /** Always set when verdict is no_obvious_warning_signs. */
  disclosure: string | null;
  signals: { code: string; severity: 'high' | 'medium' | 'info'; title: string; detail: string; evidence?: string; basis?: FindingBasis }[];
  nextSteps: { id: string; text: string; url?: string; urlLabel?: string }[];
  couldNotVerify: string[];
  /** Three evidence classes (since scam-calibrate). Older servers do not send it. */
  evidence?: ScanEvidence;
  ai: { used: boolean; model?: string; mode?: 'ai_checked' | 'rules_only'; raised?: boolean };
}
export interface ScanEvidence {
  observable: { kind: 'link' | 'phone' | 'email' | 'amount' | 'screenshot' | 'scam_list'; text: string; quote?: string }[];
  rule: { code: string; severity: 'high' | 'medium' | 'info'; title: string; quote?: string; detail: string }[];
  ai: { category: string; categoryLabel: string; quote: string; explanation: string }[];
  labels: { observable: string; rule: string; ai: string };
}
