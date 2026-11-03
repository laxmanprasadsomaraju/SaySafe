/**
 * "Did my payment go through?" (and close variants) is a payment-status question from every Assistant context.
 * The same shared detector feeds the server rules router and the on-device follow-ups, which run before the
 * Check-a-message / My-payments / shopping branches in the Assistant, so the mode never turns it into a scam check.
 */
import { describe, it, expect } from 'vitest';
import { isPaymentStatusQuestion, looksLikeMessageToCheck, pickStatusPayment, NO_SANDBOX_PAYMENT_REPLY } from '../shared/paymentStatus';
import { routeCompanion } from '../server/companion/router';
import { parseFollowup } from '../web/src/assistant/followups';

const STATUS = [
  'Did my payment go through?', 'did it go through', 'Did it go through?', 'Has the payment gone through?', 'Is my payment complete?',
  'Did my purchase work?', 'Was I charged?', 'was i charged', 'Have I been charged?', 'Was I charged twice?', 'Did I get charged?',
  'Did PayPal charge me?', "Where's my receipt?", 'Where is my receipt', 'where’s my receipt?', 'Where is the receipt?', 'Did I get a receipt?',
  'Did the payment go through for the microwave?', 'did my order go through',
  // audit fix 7
  'Was my payment successful?', 'was my payment successful', 'Did PayPal take the money?', 'did paypal take my money',
];
const NOT_STATUS = [
  'Did I already pay John €80?', 'Did I pay the plumber?', 'I received a message saying I owe €120. Can you check whether I already paid?',
  'Show my last payment', 'What do I pay every month?', 'Help me buy a microwave', 'Did my payment to Sarah go through?',
  'Have I paid anyone twice?', 'Cancel my subscription',
];
const SCAM = 'Dear customer, your payment did not go through and your account will be suspended today. To avoid being charged a penalty fee, verify your card details now at http://secure-paypa1-verify.xyz/login or call +353 85 123 4567 before midnight.';
const SCAM_IBAN = 'Hi Mam, it is me, new number. Was I charged for the rent? My payment did not go through, can you transfer €480 to my friend now to IE29 AIBK 9311 5212 3456 78 please, I will explain everything later tonight, thanks, love you.';

describe('payment-status detector (shared)', () => {
  it.each(STATUS)('status question: %s', (t) => expect(isPaymentStatusQuestion(t)).toBe(true));
  it.each(NOT_STATUS)('not a status question: %s', (t) => expect(isPaymentStatusQuestion(t)).toBe(false));
  it('a long pasted message with a link/phone/IBAN stays a scam check', () => {
    expect(looksLikeMessageToCheck(SCAM)).toBe(true);
    expect(looksLikeMessageToCheck(SCAM_IBAN)).toBe(true);
    expect(isPaymentStatusQuestion(SCAM)).toBe(false);
    expect(isPaymentStatusQuestion(SCAM_IBAN)).toBe(false);
    expect(routeCompanion(SCAM)?.action).not.toBe('payment_status');
    expect(parseFollowup(SCAM, false).kind).not.toBe('payment_status');
  });
  it('short questions (even with a link) are not "messages being checked"', () => {
    expect(looksLikeMessageToCheck('Did my payment go through?')).toBe(false);
    expect(looksLikeMessageToCheck('is www.example.com safe?')).toBe(false);
  });
});

describe('every Assistant context routes the question to the read-only receipt answer', () => {
  // The server router (default chat, voice transcripts, any `step`) and the device follow-up parser (which runs first
  // in handle() for chat, check, payments and find modes, with or without product cards on screen, and after reload
  // because the thread and mode are restored from sessionStorage before the next message).
  it.each(STATUS)('server rules router: %s', (t) => expect(routeCompanion(t)?.action).toBe('payment_status'));
  it.each(STATUS)('follow-up parser without product cards (chat / check / payments): %s', (t) => expect(parseFollowup(t, false).kind).toBe('payment_status'));
  it.each(STATUS)('follow-up parser with product cards on screen (shopping flow): %s', (t) => expect(parseFollowup(t, true).kind).toBe('payment_status'));
});

describe('which purchase answers it', () => {
  const r = (id: string, state: string, receipt: unknown = null, sample = false) => ({ id, state, receipt, sample });
  it('no real purchase → null (plain "No PayPal Sandbox payment yet")', () => {
    expect(pickStatusPayment([])).toBeNull();
    expect(pickStatusPayment([r('pay_smpX1234', 'CAPTURED', { captureId: 'x' }, true)])).toBeNull();
    expect(NO_SANDBOX_PAYMENT_REPLY).toMatch(/^No PayPal Sandbox payment yet\./);
    expect(NO_SANDBOX_PAYMENT_REPLY).not.toMatch(/\bpaid\b(?! in this app)/);
  });
  it('newest receipt or in-progress purchase; skips newer cancelled attempts; never a sample', () => {
    expect(pickStatusPayment([r('pay_c1234', 'CANCELLED'), r('pay_p1234', 'CAPTURED', { captureId: 'x' })])?.id).toBe('pay_p1234');
    expect(pickStatusPayment([r('pay_w1234', 'FAMILY_APPROVAL_PENDING'), r('pay_p1234', 'CAPTURED', { captureId: 'x' })])?.id).toBe('pay_w1234');
    expect(pickStatusPayment([r('pay_smpS1234', 'CAPTURED', { captureId: 'x' }, true), r('pay_c1234', 'FAILED')])?.id).toBe('pay_c1234');
  });
});
