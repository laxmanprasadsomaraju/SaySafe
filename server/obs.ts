/**
 * Lightweight, free observability: no vendor, no extra service.
 *  - A correlation id per HTTP request (incoming X-Request-Id if it is safe, else a new one), carried through
 *    async calls with AsyncLocalStorage, echoed in the X-Request-Id response header and in every error body.
 *  - In-process counters (reset on restart) for PayPal calls/timeouts/retries, webhooks, reconcile, AI and Channel3.
 *  - log(): one JSON line, redacted (emails, phone numbers, long digit runs, bearer tokens, cookies, secrets).
 * Nothing here ever records request bodies, message text, contacts or payment records.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const als = new AsyncLocalStorage<{ requestId: string }>();
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function newRequestId() { return `req_${crypto.randomBytes(8).toString('hex')}`; }
export function currentRequestId(): string | null { return als.getStore()?.requestId ?? null; }

export function correlation(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  const requestId = incoming && SAFE_ID.test(incoming) ? incoming : newRequestId();
  (req as any).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  // Every JSON error body (any route, any status >= 400) carries the correlation id, so a failure is never
  // mistaken for an empty result and a user report can be matched to the server log.
  const json = res.json.bind(res);
  res.json = (body?: any) => json(res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && 'error' in body && !('requestId' in body) ? { ...body, requestId } : body);
  als.run({ requestId }, () => next());
}

/** Run a function with a correlation id outside an HTTP request (scripts, tests). */
export function withRequestId<T>(requestId: string, fn: () => T): T { return als.run({ requestId }, fn); }

// ---------- Redaction ----------
const PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/Basic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [redacted]'],
  [/\b(ss_elder|ss_family|cookie|x-api-key|x-admin-token|authorization|client_secret|password|api[_-]?key|secret|token)\b"?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[redacted]'],
  [/\bgsk_[A-Za-z0-9]{10,}\b/g, '[redacted-key]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\+?\d[\d\s().-]{7,}\d/g, '[number]'],
];
export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : (() => { try { return JSON.stringify(input); } catch { return String(input); } })();
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s.slice(0, 2000);
}

export type LogLevel = 'info' | 'warn' | 'error';
/** Structured, redacted one-line log. `fields` must never hold message text, contacts or records. */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'test' && !process.env.SAYSAFE_TEST_LOGS) return;
  const line = redact({ t: new Date().toISOString(), level, event, requestId: currentRequestId(), ...fields });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

// ---------- Counters ----------
const counters = new Map<string, number>();
const lastAt = new Map<string, string>();
export function count(name: string, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
  lastAt.set(name, new Date().toISOString());
}
export function metrics() {
  const out: Record<string, number> = {};
  for (const [k, v] of [...counters.entries()].sort()) out[k] = v;
  return out;
}
export function lastSeen(name: string) { return lastAt.get(name) ?? null; }
export function __resetMetrics() { counters.clear(); lastAt.clear(); }
export const startedAt = new Date().toISOString();
