/**
 * "My insights" summary — one shape for Mary's Insights page, the Home "View insights" card and the Assistant
 * insights card. Built on the server (server/insights/summary.ts) from the SAME stores the Assistant and Activity read.
 *
 * Honesty rules (enforced by construction and tests):
 *  - Every money figure belongs to exactly ONE kind: verified PayPal Sandbox, sample (illustrative), or user-entered.
 *    Kinds are never added together, and each currency is totalled on its own (never converted).
 *  - Sample scam checks (training examples) are counted apart from real checks and never called incidents.
 *  - A family member (role "family") never receives the elder's private records, subscriptions or duplicates:
 *    those fields are null for them. They see only the household's Demo Shop purchases, family reviews and the scam
 *    checks the elder chose to share — the same policy as the family dashboard and Activity.
 */
import { z } from 'zod';

export const Money = z.object({ currency: z.string().max(3), cents: z.number().int() });
export type MoneyT = z.infer<typeof Money>;

const Totals = z.object({ count: z.number().int().min(0), totals: z.array(Money) });

export const INSIGHT_FOCI = ['overview', 'spending', 'pending', 'duplicates', 'safety', 'subscriptions', 'upcoming'] as const;
export type InsightFocus = (typeof INSIGHT_FOCI)[number];

export const RecentPayment = z.object({
  id: z.string().max(80),
  title: z.string().max(300),
  amountCents: z.number().int(),
  currency: z.string().max(3),
  at: z.string().max(40),
  statusLabel: z.string().max(60),
  kind: z.enum(['sandbox', 'sample', 'user_entered']),
  webhookVerified: z.boolean(),
});

export const UpcomingCharge = z.object({
  id: z.string().max(80), merchant: z.string().max(120), amountCents: z.number().int(), currency: z.string().max(3),
  nextOn: z.string().max(10), inDays: z.number().int(), kind: z.enum(['sample', 'user_entered', 'sandbox']),
});

export const SubKind = z.object({ count: z.number().int().min(0), monthly: z.array(Money), annual: z.array(Money) });

export const Duplicate = z.object({
  kind: z.enum(['identical_entries', 'possible_duplicate']),
  recipient: z.string().max(120), amountCents: z.number().int(), currency: z.string().max(3), daysApart: z.number().int().min(0),
  sample: z.boolean(), message: z.string().max(500),
});

export const PendingReview = z.object({ id: z.string().max(80), item: z.string().max(300), amountCents: z.number().int(), currency: z.string().max(3), expiresAt: z.string().max(40) });

export const InsightsSummary = z.object({
  role: z.enum(['elder', 'family']),
  generatedAt: z.string().max(40),
  elderName: z.string().max(80),
  /** False for a family member: Mary's own records, subscriptions and duplicate checks are private to her. */
  privateRecordsVisible: z.boolean(),
  payments: z.object({
    /** Demo Shop purchases made in this app against PayPal Sandbox (no real money). */
    sandbox: z.object({
      count: z.number().int().min(0),
      captured: Totals,
      webhookVerified: z.number().int().min(0),
      webhookPending: z.number().int().min(0),
      waitingFamily: z.number().int().min(0),
      waitingPayPal: z.number().int().min(0),
      cancelled: z.number().int().min(0),
      failed: z.number().int().min(0),
      refunded: z.number().int().min(0),
      refundPending: z.number().int().min(0),
      refundRequested: z.number().int().min(0),
    }),
    /** Illustrative "Try as Mary" shop purchases: no PayPal record. */
    sample: z.object({ count: z.number().int().min(0), captured: Totals }),
    recent: z.array(RecentPayment).max(6),
  }),
  /** Payments Mary typed in herself (and sample ones). Null for family. */
  records: z.object({ userEntered: Totals, sample: Totals }).nullable(),
  subscriptions: z.object({
    userEntered: SubKind, sample: SubKind, sandbox: SubKind,
    upcoming: z.array(UpcomingCharge).max(6),
    method: z.string().max(400),
  }).nullable(),
  duplicates: z.array(Duplicate).max(10).nullable(),
  pendingReviews: z.object({ real: z.array(PendingReview).max(10), sampleWaiting: z.number().int().min(0), expired: z.number().int().min(0) }),
  scamChecks: z.object({
    /** elder: every check she ran; family: only the ones she shared. */
    scope: z.enum(['all', 'shared']),
    real: z.object({ total: z.number().int().min(0), suspicious: z.number().int().min(0), needsChecking: z.number().int().min(0), noWarnings: z.number().int().min(0) }),
    training: z.number().int().min(0),
    recent: z.array(z.object({ verdict: z.string().max(40), headline: z.string().max(200), at: z.string().max(40) })).max(5),
  }),
});
export type InsightsSummaryT = z.infer<typeof InsightsSummary>;

export const fmtMoneyList = (ms: MoneyT[]) => ms.map((m) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: m.currency || 'EUR' }).format(m.cents / 100)).join(' and ');
