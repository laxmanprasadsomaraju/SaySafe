/**
 * Payment companion cards (phase 2): the registry contract for Mary's private records.
 *
 * These cards are ELDER-ONLY. They are never shown in the family view: FamilyAssistant drops them when it restores
 * a conversation, and every companion component renders nothing when the audience is "family". The server enforces
 * the same (every /api/companion route answers 403 to a family session).
 *
 * Wording rules (docs/COMPANION.md): a record Mary typed is "Recorded by you — not verified"; a saved contact is
 * "Saved by you — not verified"; an external cancellation is only ever "You told SaySafe this is cancelled — not
 * confirmed by the provider"; the Demo Membership is "cancelled" only after the SERVER says provider_confirmed.
 */
import { z } from 'zod';
import {
  PaymentSearchResult, PaymentMatch, SubscriptionSummary, Subscription, CancelGuideCard, Contact, ManualPayment,
  PAYPAL_AUTOPAY_URL, DEMO_MEMBERSHIP, PAY_METHODS, type SubscriptionT, type PaymentSearchResultT,
} from '../../../shared/companion';

const Str = (n: number) => z.string().max(n);
const Scope = z.object({ billingAuthorisation: Str(600), serviceContract: Str(600) });

/** UI copy (the server's own labels are kept on the data; these are what the cards say). */
export const UI_LABEL = {
  manual: 'Recorded by you — not verified',
  sandbox: 'PayPal Sandbox capture',
  contact: 'Saved by you — not verified',
  userReported: 'You told SaySafe this is cancelled — not confirmed by the provider',
  dontPayAgain: "Don't pay again until you've checked",
} as const;

export const METHOD_LABEL: Record<(typeof PAY_METHODS)[number], string> = {
  bank_transfer: 'Bank transfer', cash: 'Cash', card: 'Card', paypal: 'PayPal', cheque: 'Cheque', other: 'Other',
};

const PaymentMatchesB = z.object({ kind: z.literal('payment_matches'), result: PaymentSearchResult });
const LastPaymentB = z.object({ kind: z.literal('last_payment'), payment: PaymentMatch.nullable(), guidance: Str(600) });
const MonthlyCostsB = z.object({ kind: z.literal('monthly_costs'), summary: SubscriptionSummary });
const SubscriptionHelpB = z.object({
  kind: z.literal('subscription_help'),
  merchant: Str(80).nullable(),
  subscription: Subscription.nullable(),
  guide: CancelGuideCard.nullable(),
  genericSteps: z.array(Str(300)).max(10),
  paypalAutopayUrl: z.literal(PAYPAL_AUTOPAY_URL),
  cancellationScope: Scope,
  disclaimer: Str(600),
});
export const CANCEL_PHASES = ['confirm', 'pending', 'confirmed', 'retry_needed', 'error'] as const;
/**
 * The Demo Membership confirmation card. "confirm" holds the single-use token; every later phase has token ''.
 * "confirmed" is set only from a server answer whose subscription status is provider_confirmed (see cancelPhase).
 */
const DemoCancelB = z.object({
  kind: z.literal('demo_cancel_intent'),
  subscriptionId: Str(60),
  confirmText: z.literal(DEMO_MEMBERSHIP.cancelConfirmText),
  token: Str(100),
  expiresAt: Str(40),
  cancelEndpoint: z.literal('/api/companion/subscriptions/demo/cancel'),
  cancellationScope: Scope,
  phase: z.enum(CANCEL_PHASES).default('confirm'),
  message: Str(400).nullable().default(null),
  evidence: Str(400).nullable().default(null),
});
const ContactCardB = z.object({ kind: z.literal('contact_card'), contacts: z.array(Contact).max(10), query: Str(60).nullable(), advice: Str(600) });
const SignInB = z.object({ kind: z.literal('companion_sign_in'), message: Str(300) });
/** A live manager for one kind of record. Holds no data: it re-reads the server every time it is shown. */
const RecordsB = z.object({ kind: z.literal('companion_records'), section: z.enum(['payments', 'subscriptions', 'contacts']) });
/** Demo Membership status. Holds no PayPal status of its own: re-read from the server on every mount. */
const DemoMembershipB = z.object({ kind: z.literal('demo_membership'), returned: Str(40).nullable().default(null) });

export const COMPANION_BLOCKS = [PaymentMatchesB, LastPaymentB, MonthlyCostsB, SubscriptionHelpB, DemoCancelB, ContactCardB, SignInB, RecordsB, DemoMembershipB] as const;
export const COMPANION_KINDS = ['payment_matches', 'last_payment', 'monthly_costs', 'subscription_help', 'demo_cancel_intent', 'contact_card', 'companion_sign_in', 'companion_records', 'demo_membership'] as const;
export type CompanionKind = (typeof COMPANION_KINDS)[number];
export const isCompanionKind = (k: string): k is CompanionKind => (COMPANION_KINDS as readonly string[]).includes(k);

// ---------- Server answers the cards are built from (validated; a card is never built from unvalidated data) ----------
export const ServerPaymentsList = z.object({ payments: z.array(ManualPayment).max(500) }).passthrough();
export const ServerSubsList = z.object({ subscriptions: z.array(Subscription).max(100) }).passthrough();
export const ServerContactsList = z.object({ contacts: z.array(Contact).max(50) }).passthrough();
export const ServerDemoStatus = z.object({ subscription: Subscription.nullable(), configured: z.boolean() }).passthrough();
export const ServerDemoStart = z.object({ subscription: Subscription, approveUrl: z.string().nullable(), reused: z.boolean() }).passthrough();
export const ServerCancelIntent = z.object({
  subscriptionId: Str(60), confirmText: z.literal(DEMO_MEMBERSHIP.cancelConfirmText), token: z.string().min(20).max(100), expiresAt: Str(40),
  cancelEndpoint: z.literal('/api/companion/subscriptions/demo/cancel'), cancellationScope: Scope,
}).passthrough();
export const ServerCancelResult = z.object({ outcome: z.enum(['confirmed', 'already_cancelled', 'retry_needed']), subscription: Subscription, message: Str(400) }).passthrough();
export const ServerCancelHelp = z.object({
  subscription: Subscription,
  guide: CancelGuideCard.nullable(),
  genericSteps: z.array(Str(300)).max(10),
  paypalAutopay: z.object({ url: z.literal(PAYPAL_AUTOPAY_URL), helpUrl: Str(300), text: Str(400) }).passthrough(),
  cancellationScope: Scope,
  next: Str(400),
}).passthrough();

export const EXTERNAL_DISCLAIMER = "SaySafe can't cancel this subscription for you. Only the company can. If you pay them through PayPal, you can also stop the automatic payment in PayPal yourself. Keep their confirmation email.";

/** "Help me cancel" (tap) -> the same card the assistant shows for a spoken "cancel my Netflix". */
export function helpFromCancelHelp(r: z.infer<typeof ServerCancelHelp>) {
  return { kind: 'subscription_help' as const, merchant: r.subscription.merchant, subscription: r.subscription, guide: r.guide, genericSteps: r.genericSteps, paypalAutopayUrl: PAYPAL_AUTOPAY_URL, cancellationScope: r.cancellationScope, disclaimer: EXTERNAL_DISCLAIMER };
}
export function cancelCardFrom(r: z.infer<typeof ServerCancelIntent>) {
  return { kind: 'demo_cancel_intent' as const, subscriptionId: r.subscriptionId, confirmText: r.confirmText, token: r.token, expiresAt: r.expiresAt, cancelEndpoint: r.cancelEndpoint, cancellationScope: r.cancellationScope, phase: 'confirm' as const, message: null, evidence: null };
}
/**
 * The ONLY way the card reaches "confirmed": the server answered and its subscription says provider_confirmed
 * (PayPal's GET showed CANCELLED, or a signed webhook did). Anything else is "retry_needed".
 */
export function cancelPhase(r: z.infer<typeof ServerCancelResult>): 'confirmed' | 'retry_needed' {
  return (r.outcome === 'confirmed' || r.outcome === 'already_cancelled') && r.subscription.status === 'provider_confirmed' ? 'confirmed' : 'retry_needed';
}

/** A spoken or typed "yes" never cancels. Returns the reply to give instead when a cancel card is waiting. */
export const TAP_ONLY_REPLY = 'To be safe, please tap “Cancel billing via PayPal” on the card yourself. Saying yes doesn’t cancel anything.';

/** The search the card ran, so it can run it again after an edit (amount in major units, as the API takes it). */
export function searchQueryString(q: PaymentSearchResultT['query']): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.amountCents != null) p.set('amount', (q.amountCents / 100).toFixed(2));
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  return p.toString();
}

/** "80", "80.50", "€80,50" -> 8050 cents, else null. */
export function parseAmount(s: string): number | null {
  const t = s.replace(/[€\s]/g, '').replace(/^eur/i, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const c = Math.round(Number(t) * 100);
  return c > 0 ? c : null;
}
export const money = (cents: number, cur: string) => { try { return new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${cur}`; } };
export const day = (iso: string) => { const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }); };
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** tel: and mailto: links built only from the details Mary saved (digits and + only). */
export function telHref(phone: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/[^\d+]/g, '');
  return /^\+?\d{3,20}$/.test(d) ? `tel:${d}` : null;
}
export function mailHref(email: string | null): string | null {
  return email && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? `mailto:${email}` : null;
}

export const FREQ_LABEL = { weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' } as const;
export function nextChargeText(s: SubscriptionT): string {
  if (s.status === 'provider_confirmed') return 'No more charges: PayPal confirmed it is cancelled';
  if (s.status === 'user_reported_cancelled') return 'Not counted: you told SaySafe it is cancelled';
  if (s.stoppedTrackingAt) return 'Not tracked, not counted';
  if (!s.nextOn || s.nextPaymentInDays == null) return 'Next charge: not entered';
  const n = s.nextPaymentInDays;
  return `Next expected charge: ${day(s.nextOn)}${n === 0 ? ' (today)' : n === 1 ? ' (tomorrow)' : n > 1 ? ` (in ${n} days)` : ' (date has passed)'}`;
}
export const isDemo = (s: SubscriptionT) => s.source === 'paypal_sandbox_subscription';
export function sourceText(s: SubscriptionT): string {
  return isDemo(s) ? 'PayPal sandbox subscription (SaySafe Demo Shop)' : 'Entered by you — not verified';
}

/** Short spoken version: the first one or two sentences. The screen carries the rest. */
export function shortSpoken(text: string, sentences = 2): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  return parts ? parts.slice(0, sentences).join('').trim() : text;
}

/** Suggestion chips for the companion (handled on the device; nothing is guessed). */
export const COMPANION_CHIPS = ['Did I already pay someone?', 'What do I pay every month?', 'Find a trusted contact'] as const;

/** Text that should go to the companion instead of the Demo Shop "payments" shortcut. */
export function looksCompanion(text: string): boolean {
  const s = text.toLowerCase();
  return /\b(have i|did i)\b.{0,30}\bpa(id|y)\b/.test(s) || /\bsubscriptions?\b|\bevery month\b|\bmonthly\b|\bmembership\b|\btrusted contacts?\b|'s (phone |mobile )?(number|email)\b|\bcancel (my )?\w+/.test(s) || /\b(last|latest) payment (to|for)\s+\w/.test(s);
}
