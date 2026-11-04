/**
 * PayPal REST (sandbox) client: OAuth, Orders v2, Payments (refund), webhook signature verification.
 * Credentials come from env only and never reach the browser.
 */
import { count, log } from '../obs.js';

const BASE = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
// Sandbox-only by design: refuse to start against PayPal live unless someone deliberately opts in.
if (!/^https:\/\/api-m\.sandbox\.paypal\.com\/?$/.test(BASE) && process.env.PAYPAL_ALLOW_LIVE !== 'yes') {
  throw new Error(`Refusing non-sandbox PayPal base URL ${BASE}. SaySafe is a sandbox demo.`);
}

/** PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET, or a single PAYPAL_CREDENTIALS="id:secret". */
function creds() {
  const combined = process.env.PAYPAL_CREDENTIALS;
  if (combined && combined.includes(':')) { const i = combined.indexOf(':'); return { id: combined.slice(0, i).trim(), secret: combined.slice(i + 1).trim() }; }
  return { id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET };
}

export function paypalConfigured() {
  const c = creds(); return Boolean(c.id && c.secret);
}

let cached: { token: string; exp: number } | null = null;

async function token(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const { id, secret } = creds();
  if (!id || !secret) throw new Error('PayPal credentials missing (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status}`);
  const data = (await res.json()) as any;
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

/** Network failure or timeout: PayPal may or may not have acted. Callers must re-read, never assume failure. */
export function isUnknownOutcome(e: any) { return !e?.status || e.status >= 500; }

/** A request body that is already JSON text and must be sent byte-for-byte (used for webhook verification). */
export class RawJsonBody { constructor(readonly text: string) {} }

async function call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, retried = false, timeoutMs = 20000): Promise<any> {
  const op = `${method} ${path.replace(/\/[A-Z0-9]{10,30}(?=\/|$)/g, '/:id')}`; // no ids in metric names
  count('paypal.calls');
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body instanceof RawJsonBody ? body.text : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    // Timeout or dropped connection: outcome UNKNOWN (no status). Callers re-read; they never assume failure.
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    count(timeout ? 'paypal.timeouts' : 'paypal.network_errors');
    log('warn', 'paypal.call_failed', { op, kind: timeout ? 'timeout' : 'network' });
    throw e;
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  // A revoked or expired token: drop the cache and try once more with a fresh one (same PayPal-Request-Id, so safe).
  if (res.status === 401 && !retried) { count('paypal.token_retries'); cached = null; return call(method, path, body, extraHeaders, true, timeoutMs); }
  if (!res.ok) {
    count(res.status >= 500 ? 'paypal.http_5xx' : 'paypal.http_4xx');
    log(res.status >= 500 ? 'warn' : 'info', 'paypal.http_error', { op, status: res.status, issue: data?.details?.[0]?.issue ?? data?.name ?? null, debugId: data?.debug_id ?? null });
    const err = new Error(`PayPal ${method} ${path} -> ${res.status} ${data?.name ?? ''} ${data?.details?.[0]?.issue ?? data?.message ?? ''}`.trim()) as Error & { status: number; data: any };
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export interface OrderItem { name: string; unitAmountCents: number; quantity: number; sku: string }

const money = (cents: number) => (cents / 100).toFixed(2);

export async function createOrder(args: { requestId: string; items: OrderItem[]; currency: string; returnUrl: string; cancelUrl: string; brandName: string }) {
  const total = args.items.reduce((s, i) => s + i.unitAmountCents * i.quantity, 0);
  return call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: args.requestId,
      custom_id: args.requestId,
      description: 'SaySafe demo purchase (sandbox)',
      amount: { currency_code: args.currency, value: money(total), breakdown: { item_total: { currency_code: args.currency, value: money(total) } } },
      items: args.items.map((i) => ({ name: i.name.slice(0, 127), sku: i.sku, quantity: String(i.quantity), unit_amount: { currency_code: args.currency, value: money(i.unitAmountCents) }, category: 'PHYSICAL_GOODS' })),
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: args.brandName,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: args.returnUrl,
          cancel_url: args.cancelUrl,
          landing_page: 'LOGIN',
        },
      },
    },
  }, { 'PayPal-Request-Id': `create-${args.requestId}` });
}

export const getOrder = (orderId: string) => call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);

/** Idempotent capture: PayPal-Request-Id makes retries safe. */
export const captureOrder = (orderId: string, requestId: string) =>
  call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { 'PayPal-Request-Id': `capture-${requestId}`, Prefer: 'return=representation' });

/** Payments v2: read one capture (status COMPLETED | PENDING | REFUNDED | PARTIALLY_REFUNDED | DECLINED | FAILED). Read-only. */
export const getCapture = (captureId: string, opts: { timeoutMs?: number } = {}) =>
  call('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`, undefined, {}, false, opts.timeoutMs ?? 20000);

/**
 * FULL refund of a capture (no amount in the body = the whole remaining amount). `paypalRequestId` must be the
 * durable key stored in the DB before this call: PayPal replays the same refund for the same key, so a retry after a
 * timeout can never refund twice. A new key on an already-refunded capture gets 422 CAPTURE_FULLY_REFUNDED.
 */
export const refundCapture = (captureId: string, paypalRequestId: string, customId?: string) =>
  call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { ...(customId ? { custom_id: customId } : {}), note_to_payer: 'SaySafe Demo Shop refund (PayPal Sandbox, no real money)' },
    { 'PayPal-Request-Id': paypalRequestId, Prefer: 'return=representation' });

/** Payments v2: read one refund (status COMPLETED | PENDING | FAILED | CANCELLED). Read-only. */
export const getRefund = (refundId: string, opts: { timeoutMs?: number } = {}) =>
  call('GET', `/v2/payments/refunds/${encodeURIComponent(refundId)}`, undefined, {}, false, opts.timeoutMs ?? 20000);

/**
 * The verify-webhook-signature request body, with `webhook_event` spliced in as the EXACT raw bytes PayPal sent.
 * PayPal signs the raw body (CRC32 of it is in the signed string); re-serialising a parsed copy can change number
 * formatting, escapes or whitespace and make a genuine event fail (or verify a different text than the one we act on).
 * Throws if the raw body is not a single JSON object.
 */
export function verifyRequestBody(headers: Record<string, string | string[] | undefined>, rawBody: string, webhookId: string): string {
  const raw = rawBody.trim();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('webhook body is not a JSON object');
  const h = (k: string) => String(headers[k] ?? '');
  const envelope = JSON.stringify({
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: webhookId,
  });
  return `${envelope.slice(0, -1)},"webhook_event":${raw}}`;
}

/** Verify a webhook via PayPal's verify-webhook-signature API, sending the event as the raw body it arrived with. */
export async function verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const data = await call('POST', '/v1/notifications/verify-webhook-signature', new RawJsonBody(verifyRequestBody(headers, rawBody, webhookId)));
  return data?.verification_status === 'SUCCESS';
}

export function approveLink(order: any): string | null {
  const l = (order?.links ?? []).find((x: any) => x.rel === 'payer-action' || x.rel === 'approve');
  if (!l) return null;
  // Only ever redirect to PayPal's own domains (no open redirect).
  try {
    const host = new URL(l.href).hostname;
    if (host === 'www.sandbox.paypal.com' || host === 'www.paypal.com' || host.endsWith('.paypal.com')) return l.href;
  } catch { /* ignore */ }
  return null;
}

// ---------- Subscriptions v1 (SaySafe Demo Membership only; plan id from PAYPAL_DEMO_PLAN_ID) ----------
// Verified live in the sandbox on 2026-11-03 (work/subs-probe): create -> 201 APPROVAL_PENDING with an `approve` link,
// GET -> 200, cancel on an APPROVAL_PENDING subscription -> 404 RESOURCE_NOT_FOUND (cancel applies to ACTIVE/SUSPENDED).

/** `requestId` must be stored before the call (durable PayPal-Request-Id): a retry after a timeout returns the same subscription. */
export const createSubscription = (args: { planId: string; customId: string; requestId: string; returnUrl: string; cancelUrl: string; brandName: string }) =>
  call('POST', '/v1/billing/subscriptions', {
    plan_id: args.planId,
    custom_id: args.customId,
    application_context: { brand_name: args.brandName, user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: args.returnUrl, cancel_url: args.cancelUrl },
  }, { 'PayPal-Request-Id': args.requestId, Prefer: 'return=representation' });

export const getSubscription = (id: string, opts: { timeoutMs?: number } = {}) =>
  call('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`, undefined, {}, false, opts.timeoutMs ?? 15000);

/** 204 No Content on success. Callers must GET afterwards before treating it as cancelled. */
export const cancelSubscription = (id: string, reason: string, opts: { timeoutMs?: number } = {}) =>
  call('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason.slice(0, 128) }, {}, false, opts.timeoutMs ?? 15000);

export function subscriptionApproveLink(sub: any): string | null {
  const l = (sub?.links ?? []).find((x: any) => x.rel === 'approve');
  if (!l) return null;
  try { const host = new URL(l.href).hostname; if (host === 'www.sandbox.paypal.com' || host === 'www.paypal.com') return l.href; } catch { /* ignore */ }
  return null;
}
