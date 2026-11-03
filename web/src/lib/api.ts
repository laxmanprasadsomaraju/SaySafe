export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: opts.form ? undefined : opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Something went wrong. Please try again.');
  return data as T;
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
  headline: string; spokenSummary: string;
  signals: { code: string; severity: 'high' | 'medium' | 'info'; title: string; detail: string; evidence?: string }[];
  aiReasons: string[];
  safeActions: { label: string; url: string }[];
  phonePolicy: string | null;
  extractedText?: string; ocrUncertain?: boolean;
  ai: { used: boolean; model?: string };
  aiNotice?: string | null;
}

export const newKey = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '');
