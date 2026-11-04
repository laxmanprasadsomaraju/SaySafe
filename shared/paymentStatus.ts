/**
 * "Did my payment go through?" and its close variants ("did it go through", "was I charged", "where's my receipt").
 * One detector shared by the server rules router (server/companion/router.ts) and the Assistant's on-device
 * follow-ups (web/src/assistant/followups.ts), so the question gets the same read-only receipt answer from every
 * Assistant context: default chat, Check a message, My payments, the shopping flow, and after a reload.
 *
 * The one exception: a long pasted message that is clearly being checked (it contains a link, a phone number or an
 * IBAN and is more than ~25 words) stays a scam check, even if it says "your payment did not go through".
 */

const LINK = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|ie|net|org|co|uk|info|biz|xyz|top|app|link|ly|io)\b(?:\/|\s|$)/i;
const PHONE = /(?:\+|\b00)\d[\d\s-]{6,}|\b0\d[\d\s-]{7,}\d\b/;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/;

/** A pasted message the person wants checked: a link, phone number or IBAN, and more than 25 words. */
export function looksLikeMessageToCheck(text: string): boolean {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  return words > 25 && (LINK.test(t) || PHONE.test(t) || IBAN.test(t.toUpperCase()));
}

/** True for a question about the status of a purchase made in this app (never a scam check, never a list). */
export function isPaymentStatusQuestion(text: string): boolean {
  const s = text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  if (!s || s.length > 200 || looksLikeMessageToCheck(text)) return false;
  // "Was I charged twice?" is a duplicate check across captured payments (Assistant tool duplicate_check), not one receipt.
  if (/\b(twice|two times|double|more than once|duplicate)\b/.test(s)) return false;
  const end = s.replace(/[?.!]+$/, '');
  // "Did my payment to John go through?" / "Did I pay John back?" are about a person: the records companion answers.
  if (/\b(john|pay [a-z]+ back)\b/.test(s) || /\b(to|for)\s+(?!the shop|demo|it\b|the microwave|my order|the order)[a-z]+\b.{0,3}$/.test(end)) return false;
  if (/\b(payment|paid)\s+to\s+(?!the shop|demo)[a-z]/.test(s)) return false;
  // "Did my payment go through?", "Did it go through", "Has the payment gone through?", "Is my payment complete?"
  if (/\b(did|has|have|is|was)\b.{0,12}\b(my|the|that|this|it)\b.{0,14}\b(payment|purchase|order|it)?\b.{0,6}\b(go(ne)? through|work(ed)?|succeed(ed)?|successful|a success|complete(d)?|finish(ed)?|done|paid|been paid)\b/.test(s)
    && /\b(payment|purchase|order|it|through)\b/.test(s)) return true;
  // "Was I charged?", "Have I been charged?", "Did I get charged twice?", "Did PayPal charge me?"
  if (/\b(was|were|have|has|did|am)\s+(i|we)\s+(been\s+|get\s+|got\s+|actually\s+|really\s+)?(charged|billed)\b/.test(s)) return true;
  if (/\bdid\s+(it|they|paypal|you|the shop|saysafe)\s+(charge|bill)\s+me\b/.test(s)) return true;
  if (/\b(did|has)\s+(the\s+)?(money|payment)\s+(leave|left|come out|gone out|go out)\b/.test(s)) return true;
  // "Did PayPal take the money?", "Has the shop taken my money?"
  if (/\b(did|has|have)\s+(paypal|the shop|saysafe|it|they)\s+(take|taken|took)\s+(the|my|any)\s+money\b/.test(s)) return true;
  // "Where's my receipt?", "Where is the receipt", "Did I get a receipt?"
  if (/\bwhere('s| is| are)\s+(my|the)\s+(paypal\s+)?receipts?\b/.test(s)) return true;
  if (/\b(did|have)\s+i\s+(get|got|receive|received)\s+(a|my|the)\s+(paypal\s+)?receipt\b/.test(s)) return true;
  return false;
}

const IN_FLIGHT = new Set(['FAMILY_APPROVAL_PENDING', 'FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'CAPTURE_PENDING', 'REFUND_PENDING']);
/**
 * Which purchase answers "did my payment go through?" when the conversation isn't about one: the newest real
 * (non-sample) purchase that has a PayPal receipt or is still in progress; cancelled/failed attempts are skipped
 * unless nothing else exists. Rows are newest first (GET /api/payments). Null = no PayPal Sandbox payment yet.
 */
export function pickStatusPayment<T extends { id: string; state: string; receipt?: unknown; sample?: boolean }>(rows: T[]): T | null {
  const real = rows.filter((r) => !r.sample && !String(r.id).startsWith('pay_smp'));
  return real.find((r) => r.receipt || IN_FLIGHT.has(r.state)) ?? real[0] ?? null;
}

/** The plain answer when there is nothing to check. Never says "paid". */
export const NO_SANDBOX_PAYMENT_REPLY = 'No PayPal Sandbox payment yet. Nothing has been paid in this app. You can try the Demo Shop below: it uses PayPal Sandbox, so no real money moves.';
