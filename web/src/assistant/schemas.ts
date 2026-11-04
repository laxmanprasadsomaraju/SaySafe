/**
 * The Assistant's component registry contract. The conversation can only show these components, and only
 * with data that passes these schemas. Nothing model-generated is ever rendered as markup: blocks carry plain
 * data, React renders it as text, URLs must be https (or internal routes), images come from our own
 * /products folder or https. Anything that fails validation is dropped and the text reply stands alone.
 */
import { z } from 'zod';
import { COMPANION_BLOCKS, COMPANION_KINDS } from './companion';

const isHttps = (u: string) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
export const HttpsUrl = z.string().max(2000).refine(isHttps, 'https only');
export const ImageSrc = z.string().max(2000).refine((u) => /^\/products\/[A-Za-z0-9._-]+$/.test(u) || isHttps(u), 'bad image');
export const InternalRoute = z.string().max(200).regex(/^\/[A-Za-z0-9/_?=&.-]*$/).refine((u) => !u.startsWith('//'), 'not internal');
const Str = (n: number) => z.string().max(n);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Cents = z.number().int().min(0).max(10_000_000);

export const ProductItem = z.object({
  id: Str(200),
  title: Str(300),
  brand: Str(120).nullable(),
  image: ImageSrc.nullable(),
  imageAlt: Str(300),
  features: z.array(Str(200)).max(12),
  price: z.number().min(0).max(1_000_000),
  compareAt: z.number().min(0).max(1_000_000).nullable(),
  currency: Currency,
  retailer: Str(120),
  url: HttpsUrl.nullable(),
  availability: z.enum(['InStock', 'OutOfStock', 'Unknown']),
  attributes: z.record(Str(80), z.array(Str(200)).max(20)).optional(),
  description: Str(2000).nullable().optional(),
  /** Demo Shop catalogue id; only demo items can be prepared for a PayPal Sandbox payment. */
  productId: Str(60).regex(/^[a-z0-9-]+$/).optional(),
  role: z.enum(['best', 'cheaper', 'another']).optional(),
  reasons: z.array(Str(200)).max(5).optional(),
  rating: z.object({ value: z.number().min(0).max(5), count: z.number().int().min(0) }).nullable().optional(),
  /** Listed variant options (e.g. Size: S, M, L). */
  variants: z.array(z.object({ name: Str(30), values: z.array(Str(30)).max(12) })).max(3).optional(),
});
export type ProductItem = z.infer<typeof ProductItem>;

const ScamResult = z.object({
  kind: z.literal('scam_result'),
  scanId: Str(60),
  verdict: Str(40),
  headline: Str(300),
  summary: Str(1200),
  signals: z.array(z.object({ severity: z.enum(['high', 'medium', 'info']), title: Str(200), detail: Str(600), evidence: Str(300).optional(), code: Str(60).optional() })).max(8),
  safeActions: z.array(z.object({ label: Str(120), url: HttpsUrl })).max(4),
  aiNotice: Str(200).nullable(),
  shared: z.boolean().optional(),
});
const ProductCards = z.object({
  kind: z.literal('product_cards'),
  source: z.enum(['channel3', 'demo']),
  query: Str(200),
  items: z.array(ProductItem).min(1).max(30),
  fetchedAt: Str(40).nullable(),
  note: Str(400).nullable(),
});
const Compare = z.object({
  kind: z.literal('compare'),
  source: z.enum(['channel3', 'demo']),
  names: z.array(Str(120)).min(2).max(3),
  rows: z.array(z.object({ label: Str(60), values: z.array(Str(200).nullable()).max(3) })).max(12),
});
const PrepLine = z.object({ productId: Str(60).regex(/^[a-z0-9-]+$/), name: Str(200), quantity: z.number().int().min(1).max(5), lineCents: Cents, image: Str(100) });
const PaymentPrep = z.object({
  kind: z.literal('payment_prep'),
  lines: z.array(PrepLine).min(1).max(10),
  totalCents: Cents,
  currency: Currency,
  merchant: Str(120),
  needsFamily: z.boolean(),
  thresholdCents: Cents,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  status: z.enum(['ready', 'denied', 'sending', 'sent', 'error']),
  requestId: Str(60).nullable(),
  error: Str(300).nullable(),
});
const PayId = z.string().regex(/^pay_[A-Za-z0-9_-]{4,60}$/);
/** Mary's view of a purchase waiting for (or past) family review. Status always re-read from the server. */
const FamilyStatus = z.object({
  kind: z.literal('family_status'),
  requestId: PayId,
  state: Str(40),
  item: Str(300),
  amountCents: Cents,
  currency: Currency,
  approvalStatus: Str(20).nullable(),
  reasons: z.array(Str(200)).max(5).optional(),
  checkedAt: Str(40).optional(),
});
/** Alex's review card: exact items and amount from the server. Approve/Decline go to the existing decide endpoint. */
const FamilyReview = z.object({
  kind: z.literal('family_review'),
  requestId: PayId,
  approvalId: Str(40),
  elderName: Str(40).nullable(),
  lines: z.array(z.object({ name: Str(200), quantity: z.number().int().min(1).max(5), lineCents: Cents, image: Str(100) })).min(1).max(10),
  merchant: Str(120),
  amountCents: Cents,
  currency: Currency,
  state: Str(40),
  approvalStatus: Str(20),
  expiresAt: z.number().int().min(0),
  error: Str(300).nullable().optional(),
});
const Receipt = z.object({
  kind: z.literal('receipt'),
  requestId: PayId,
  state: Str(40),
  item: Str(300),
  merchant: Str(120),
  amountCents: Cents,
  currency: Currency,
  receipt: z.object({ captureId: Str(60), amount: Str(20), currency: Currency, payee: Str(160), orderId: Str(60), webhookConfirmed: z.boolean() }),
  evidenceLabel: Str(120).nullable(),
  verifiedSteps: z.number().int().min(0).max(10),
  at: Str(40),
  /** From the server timeline: PayPal shows the buyer approved / Payments v2 read-back of the capture. */
  buyerApproved: z.boolean().optional(),
  captureVerified: z.boolean().optional(),
  refundStatus: z.enum(['REFUND_REQUESTED', 'REFUND_PENDING', 'REFUNDED']).nullable().optional(),
  familyApproval: Str(20).nullable().optional(),
});
const HistoryItem = z.object({ id: z.string().regex(/^(pay|scan|mpay)_[A-Za-z0-9_-]{4,60}$/), type: z.enum(['payment', 'scan', 'record']).default('payment'), title: Str(300), amountCents: Cents.nullable(), currency: Currency.nullable(), status: Str(40), at: Str(40), webhookConfirmed: z.boolean().optional(), sample: z.boolean().optional(), sourceLabel: Str(60).optional() });
const PaymentHistory = z.object({
  kind: z.literal('payment_history'),
  items: z.array(HistoryItem).max(10),
  total: z.number().int().min(0),
  query: Str(100).optional(),
  /** Family members see the household list but cannot open the elder's receipt page. */
  as: z.enum(['elder', 'family']).optional(),
});
/** Refund REQUEST card. A request is never a refund: only REFUNDED (from PayPal) means money went back. */
const Refund = z.object({
  kind: z.literal('refund'),
  requestId: PayId,
  item: Str(300),
  amountCents: Cents,
  currency: Currency,
  status: z.enum(['can_request', 'REFUND_REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'not_eligible']),
  requestedAt: Str(40).nullable(),
  error: Str(300).nullable().optional(),
});
/** Official help links: internal routes, or https links the server lists as verified PayPal pages. */
const TrustedLinks = z.object({
  kind: z.literal('trusted_links'),
  items: z.array(z.union([z.object({ label: Str(120), to: InternalRoute }), z.object({ label: Str(120), href: HttpsUrl })])).min(1).max(6),
});

/** Payment companion cards (elder-only, see ./companion.ts) are part of the same registry. */
export const Block = z.discriminatedUnion('kind', [ScamResult, ProductCards, Compare, PaymentPrep, FamilyStatus, FamilyReview, Receipt, PaymentHistory, Refund, TrustedLinks, ...COMPANION_BLOCKS]);
export type Block = z.infer<typeof Block>;
export type BlockOf<K extends Block['kind']> = Extract<Block, { kind: K }>;
export const BLOCK_KINDS = ['scam_result', 'product_cards', 'compare', 'payment_prep', 'family_status', 'family_review', 'receipt', 'payment_history', 'refund', 'trusted_links', ...COMPANION_KINDS] as const;

/** Validate one block. Returns null (and the block is not shown) if anything is off. */
export function parseBlock(raw: unknown): Block | null {
  const r = Block.safeParse(raw);
  return r.success ? r.data : null;
}
/** Product lists keep the valid listings and drop the rest (one odd listing must not hide the others). */
export function productItems(raw: unknown[]): ProductItem[] {
  return raw.map((x) => ProductItem.safeParse(x)).filter((r) => r.success).map((r) => r.data!).slice(0, 30);
}

export const Mode = z.enum(['check', 'find', 'help', 'payments', 'chat']);
export type Mode = z.infer<typeof Mode>;
export const Message = z.object({
  id: Str(40),
  role: z.enum(['user', 'assistant']),
  text: Str(4000),
  lang: Str(8).optional(),
  blocks: z.array(z.unknown()).max(4).default([]),
});
export type Message = { id: string; role: 'user' | 'assistant'; text: string; lang?: string; blocks: Block[] };
export const Thread = z.object({ v: z.literal(1), mode: Mode, focusId: Str(200).nullable().default(null), messages: z.array(Message).max(80) });
export type Thread = { v: 1; mode: Mode; focusId: string | null; messages: Message[] };

/** Restores a saved conversation, re-validating every block (sessionStorage is not trusted either). */
export function restoreThread(raw: string | null, opts: { drop?: (b: Block) => boolean } = {}): Thread | null {
  if (!raw) return null;
  try {
    const t = Thread.safeParse(JSON.parse(raw));
    if (!t.success) return null;
    return { ...t.data, messages: t.data.messages.map((m) => ({ ...m, blocks: m.blocks.map(parseBlock).filter((b): b is Block => b !== null && !opts.drop?.(b)) })) };
  } catch { return null; }
}

// ---------- Server responses (validated before any card is built from them) ----------
const ServerTimelineEvent = z.object({ kind: Str(40), label: Str(200), verified: z.boolean() }).passthrough();
/** GET /api/payments/:id, GET /api/family/requests/:id and the decide/refund-request responses. */
export const ServerPayment = z.object({
  id: PayId,
  state: Str(40),
  items: z.array(z.object({ productId: Str(60), name: Str(200), quantity: z.number().int().min(1).max(5), lineCents: Cents, image: Str(100) }).passthrough()).min(1).max(10),
  merchant: Str(120),
  amountCents: Cents,
  currency: Currency,
  risk: z.object({ reasons: z.array(Str(300)).max(10) }).passthrough().nullable(),
  approval: z.object({ id: Str(40), status: Str(20), expiresAt: z.number(), decidedAt: Str(40).nullable(), reason: Str(300).nullable() }).nullable(),
  receipt: z.object({ captureId: Str(60), amount: Str(20), currency: Currency, payee: Str(160), orderId: Str(60), webhookConfirmed: z.boolean().optional() }).nullable(),
  refund: z.object({ status: z.enum(['REFUND_REQUESTED', 'REFUND_PENDING', 'REFUNDED']).nullable(), requestedAt: Str(40).nullable(), canRequest: z.boolean() }).passthrough().nullable().optional(),
  updatedAt: Str(40),
  timeline: z.object({ label: Str(200), events: z.array(ServerTimelineEvent).max(20) }).passthrough().optional(),
  elderName: Str(40).nullable().optional(),
}).passthrough();
export type ServerPayment = z.infer<typeof ServerPayment>;
export const ServerActivity = z.object({
  total: z.number().int().min(0),
  items: z.array(z.object({ id: Str(80), type: z.enum(['payment', 'scan', 'record']), title: Str(300), amountCents: Cents.nullable(), currency: Currency.nullable(), status: Str(40), at: Str(40), statusGroup: Str(20), webhookConfirmed: z.boolean() }).passthrough()).max(50),
}).passthrough();
/** Throws if the server sent something unexpected: a card is never built from unvalidated data. */
export function parseServer<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error('SaySafe got an unexpected answer from the server, so nothing is shown. Nothing was paid.');
  return r.data;
}
const isoAt = (s: string) => (s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
const itemText = (p: ServerPayment) => p.items.map((i) => `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`).join(', ').slice(0, 300);

/** Card builders: server data -> block data (validated again by parseBlock when added). */
export function familyStatusFrom(p: ServerPayment): BlockOf<'family_status'> {
  return { kind: 'family_status', requestId: p.id, state: p.state, item: itemText(p), amountCents: p.amountCents, currency: p.currency, approvalStatus: p.approval?.status ?? null, reasons: (p.risk?.reasons ?? []).slice(0, 5).map((r) => r.slice(0, 200)), checkedAt: new Date().toISOString() };
}
export function familyReviewFrom(p: ServerPayment): BlockOf<'family_review'> | null {
  if (!p.approval) return null;
  return { kind: 'family_review', requestId: p.id, approvalId: p.approval.id, elderName: p.elderName ?? null, lines: p.items.map((i) => ({ name: i.name, quantity: i.quantity, lineCents: i.lineCents, image: i.image })), merchant: p.merchant, amountCents: p.amountCents, currency: p.currency, state: p.state, approvalStatus: p.approval.status, expiresAt: p.approval.expiresAt, error: null };
}
export function receiptFrom(p: ServerPayment): BlockOf<'receipt'> | null {
  const rc = p.receipt;
  if (!rc) return null;
  const ev = p.timeline?.events ?? [];
  const has = (k: string) => ev.some((e) => e.kind === k && e.verified);
  return { kind: 'receipt', requestId: p.id, state: p.state, item: itemText(p), merchant: p.merchant, amountCents: p.amountCents, currency: p.currency,
    receipt: { captureId: rc.captureId, amount: rc.amount, currency: rc.currency, payee: rc.payee, orderId: rc.orderId, webhookConfirmed: Boolean(rc.webhookConfirmed) },
    evidenceLabel: p.timeline?.label?.slice(0, 120) ?? null, verifiedSteps: Math.min(10, ev.filter((e) => e.verified).length), at: isoAt(p.updatedAt),
    buyerApproved: has('buyer_approved'), captureVerified: has('capture_verified') || has('capture_completed'), refundStatus: p.refund?.status ?? null, familyApproval: p.approval?.status ?? null };
}
export function refundFrom(p: ServerPayment): BlockOf<'refund'> {
  const st = p.state === 'REFUNDED' ? 'REFUNDED' : p.refund?.status ?? (p.refund?.canRequest ? 'can_request' : 'not_eligible');
  return { kind: 'refund', requestId: p.id, item: itemText(p), amountCents: p.amountCents, currency: p.currency, status: st, requestedAt: p.refund?.requestedAt ?? null, error: null };
}
export function historyFrom(a: z.infer<typeof ServerActivity>, query?: string, as?: 'elder' | 'family'): BlockOf<'payment_history'> {
  return { kind: 'payment_history', total: a.total, query: query?.slice(0, 100) || undefined, ...(as === 'family' ? { as } : {}),
    items: a.items.filter((i) => /^(pay|scan|mpay)_/.test(i.id)).slice(0, 10).map((i) => ({ id: i.id, type: i.type, title: i.title, amountCents: i.amountCents, currency: i.currency, status: i.status, at: i.at, webhookConfirmed: i.webhookConfirmed,
      ...((i as Record<string, unknown>).example === true ? { sample: true } : {}), ...(typeof (i as Record<string, unknown>).sourceLabel === 'string' ? { sourceLabel: String((i as Record<string, unknown>).sourceLabel).slice(0, 60) } : {}) })) };
}
