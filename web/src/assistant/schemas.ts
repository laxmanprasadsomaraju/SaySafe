/**
 * The Assistant's component registry contract. The conversation can only show these components, and only
 * with data that passes these schemas. Nothing model-generated is ever rendered as markup: blocks carry plain
 * data, React renders it as text, URLs must be https (or internal routes), images come from our own
 * /products folder or https. Anything that fails validation is dropped and the text reply stands alone.
 */
import { z } from 'zod';

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
});
export type ProductItem = z.infer<typeof ProductItem>;

const ScamResult = z.object({
  kind: z.literal('scam_result'),
  scanId: Str(60),
  verdict: Str(40),
  headline: Str(300),
  summary: Str(1200),
  signals: z.array(z.object({ severity: z.enum(['high', 'medium', 'info']), title: Str(200), detail: Str(600), evidence: Str(300).optional() })).max(8),
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
const FamilyStatus = z.object({
  kind: z.literal('family_status'),
  requestId: z.string().regex(/^pay_[A-Za-z0-9_-]{4,60}$/),
  state: Str(40),
  item: Str(300),
  amountCents: Cents,
  currency: Currency,
  approvalStatus: Str(20).nullable(),
  reasons: z.array(Str(200)).max(5).optional(),
});
const Receipt = z.object({
  kind: z.literal('receipt'),
  requestId: z.string().regex(/^pay_[A-Za-z0-9_-]{4,60}$/),
  state: Str(40),
  item: Str(300),
  merchant: Str(120),
  amountCents: Cents,
  currency: Currency,
  receipt: z.object({ captureId: Str(60), amount: Str(20), currency: Currency, payee: Str(160), orderId: Str(60), webhookConfirmed: z.boolean() }),
  evidenceLabel: Str(120).nullable(),
  verifiedSteps: z.number().int().min(0).max(10),
  at: Str(40),
});
const PaymentHistory = z.object({
  kind: z.literal('payment_history'),
  items: z.array(z.object({ id: z.string().regex(/^pay_[A-Za-z0-9_-]{4,60}$/), title: Str(300), amountCents: Cents, currency: Currency, status: Str(40), at: Str(40) })).max(10),
  total: z.number().int().min(0),
});
/** Official help links: internal routes, or https links the server lists as verified PayPal pages. */
const TrustedLinks = z.object({
  kind: z.literal('trusted_links'),
  items: z.array(z.union([z.object({ label: Str(120), to: InternalRoute }), z.object({ label: Str(120), href: HttpsUrl })])).min(1).max(6),
});

export const Block = z.discriminatedUnion('kind', [ScamResult, ProductCards, Compare, PaymentPrep, FamilyStatus, Receipt, PaymentHistory, TrustedLinks]);
export type Block = z.infer<typeof Block>;
export type BlockOf<K extends Block['kind']> = Extract<Block, { kind: K }>;
export const BLOCK_KINDS = ['scam_result', 'product_cards', 'compare', 'payment_prep', 'family_status', 'receipt', 'payment_history', 'trusted_links'] as const;

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
export function restoreThread(raw: string | null): Thread | null {
  if (!raw) return null;
  try {
    const t = Thread.safeParse(JSON.parse(raw));
    if (!t.success) return null;
    return { ...t.data, messages: t.data.messages.map((m) => ({ ...m, blocks: m.blocks.map(parseBlock).filter((b): b is Block => b !== null) })) };
  } catch { return null; }
}
