/**
 * Family Safety Insights — shared contract between the server (GET /api/family/insights)
 * and BOTH dashboards (native SaySafe and the optional AG Studio view).
 *
 * Pure TypeScript: no runtime dependencies, safe to import from server, web and tests.
 * Metric definitions live here so the native dashboard, the AG Studio dashboard and the
 * read-only insights agent all count the same things the same way.
 */

export type InsightSource = 'sandbox' | 'seeded';
export type InsightsDashboard = 'native' | 'agstudio';

export interface InsightPayment {
  id: string;
  createdAt: string; // ISO 8601 UTC
  day: string; // YYYY-MM-DD (UTC)
  product: string;
  merchant: string;
  amount: number; // major units (e.g. euro)
  currency: string;
  state: string; // payment state machine value, e.g. CAPTURED
  stateLabel: string;
  /** 'sandbox' = created through the real app flow against the PayPal sandbox; 'seeded' = demo row inserted by a seed script. */
  source: InsightSource;
  hasPayPalOrder: boolean;
  hasCapture: boolean;
  capturedAmount: number | null;
  capturedCurrency: string | null;
  /** A verified PAYMENT.CAPTURE.COMPLETED webhook was received for this capture. */
  webhookConfirmed: boolean;
  webhookConfirmedAt: string | null;
  approvalStatus: string | null; // pending | approved | declined | expired | invalidated | null
  approvalDecidedAt: string | null;
  approvalExpiresAt: string | null;
  /** Pending, unexpired family approval for this household that the signed-in family member can decide. */
  awaitingMyDecision: boolean;
}

export type ScanVerdict = 'suspicious' | 'needs_verification' | 'verified_official_contact' | string;

export interface InsightScan {
  id: string;
  createdAt: string;
  day: string;
  verdict: ScanVerdict;
  /** Short safe excerpt of the stored result headline. The original message is never stored. */
  excerpt: string;
}

export type InsightEventKind = 'scam_check' | 'family_decision' | 'paypal' | 'payment';

export interface InsightEvent {
  id: string;
  at: string;
  day: string;
  kind: InsightEventKind;
  label: string;
  actor: string; // 'You' | elder name | 'Family member' | 'PayPal' | 'SaySafe'
  paymentId: string | null;
}

export interface InsightKpis {
  pendingApprovals: number;
  approved: number;
  declined: number;
  /** CAPTURED rows only. */
  captured: { count: number; total: number; currency: string };
  sandboxCaptured: { count: number; total: number; currency: string };
  seededCaptured: { count: number; total: number; currency: string };
  webhookConfirmed: number;
  webhookPending: number;
  scamReviews: number;
  suspiciousScans: number;
}

export interface InsightsPayload {
  generatedAt: string;
  me: { name: string };
  elder: { name: string };
  currency: string;
  payments: InsightPayment[];
  scans: InsightScan[];
  events: InsightEvent[];
  kpis: InsightKpis;
}

export interface InsightsAgentAnswer {
  answer: string;
  ai: { used: boolean; model?: string };
}

export const STATE_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  RISK_REVIEW: 'Safety check',
  BLOCKED: 'Blocked',
  FAMILY_APPROVAL_PENDING: 'Waiting for family',
  FAMILY_APPROVED: 'Family approved',
  PAYER_APPROVAL_PENDING: 'Waiting for PayPal',
  PAYER_APPROVED: 'Approved at PayPal',
  CAPTURE_PENDING: 'Confirming payment',
  CAPTURED: 'Paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The one place KPIs are defined. Totals come ONLY from rows whose state is CAPTURED. */
export function computeKpis(payments: InsightPayment[], scans: InsightScan[], currency = 'EUR'): InsightKpis {
  const captured = payments.filter((p) => p.state === 'CAPTURED');
  const sum = (rows: InsightPayment[]) =>
    round2(rows.filter((p) => (p.capturedCurrency ?? p.currency) === currency).reduce((s, p) => s + (p.capturedAmount ?? p.amount), 0));
  const sandbox = captured.filter((p) => p.source === 'sandbox');
  const seeded = captured.filter((p) => p.source === 'seeded');
  const withCapture = captured.filter((p) => p.hasCapture);
  return {
    pendingApprovals: payments.filter((p) => p.awaitingMyDecision).length,
    approved: payments.filter((p) => p.approvalStatus === 'approved').length,
    declined: payments.filter((p) => p.approvalStatus === 'declined').length,
    captured: { count: captured.length, total: sum(captured), currency },
    sandboxCaptured: { count: sandbox.length, total: sum(sandbox), currency },
    seededCaptured: { count: seeded.length, total: sum(seeded), currency },
    webhookConfirmed: withCapture.filter((p) => p.webhookConfirmed).length,
    webhookPending: withCapture.filter((p) => !p.webhookConfirmed).length,
    scamReviews: scans.length,
    suspiciousScans: scans.filter((s) => s.verdict === 'suspicious').length,
  };
}

export const money = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency, minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);

/** Activity per UTC day (last `days` days, oldest first), used by both dashboards' activity charts. */
export function activityByDay(events: InsightEvent[], days = 14, now = new Date()): { day: string; scam_check: number; family_decision: number; paypal: number; payment: number; total: number }[] {
  const out: ReturnType<typeof activityByDay> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10);
    out.push({ day: d, scam_check: 0, family_decision: 0, paypal: 0, payment: 0, total: 0 });
  }
  const idx = new Map(out.map((r, i) => [r.day, i]));
  for (const e of events) {
    const i = idx.get(e.day);
    if (i === undefined) continue;
    out[i][e.kind] += 1;
    out[i].total += 1;
  }
  return out;
}

export const EVENT_KIND_LABELS: Record<InsightEventKind, string> = {
  scam_check: 'Scam check',
  family_decision: 'Family decision',
  paypal: 'PayPal confirmation',
  payment: 'Purchase step',
};
