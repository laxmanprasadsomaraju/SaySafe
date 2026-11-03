/**
 * Companion intents for /api/assistant. The AI only picked the intent and extracted parameters
 * (recipient, amount, date hint, merchant, contact name/relation). The SERVER runs the query on the signed-in
 * elder's own records and writes the reply from a template. The AI never sees records, and nothing here writes:
 * there is no "mark as paid", "pay", or "cancel" path from the assistant.
 */
import type { Session } from '../auth.js';
import * as store from './store.js';
import { searchPayments, parseDateHint, fmtMoney, normName, tokenSimilarity, tokens } from './match.js';
import { findCancelGuide, GENERIC_CANCEL_STEPS } from '../../shared/cancelGuides.js';
import * as demo from './demoMembership.js';
import { CompanionError } from './store.js';
import { COMPANION_ACTIONS, CANCELLATION_SCOPE, PAYPAL_AUTOPAY_URL, DEMO_MEMBERSHIP, type CompanionAction, type CompanionCardT, type CompanionIntentParamsT, type ContactT } from '../../shared/companion.js';

export const isCompanionAction = (a: string): a is CompanionAction => (COMPANION_ACTIONS as readonly string[]).includes(a);

export interface CompanionAnswer { reply: string; card: CompanionCardT }

const SIGN_IN = 'Please start SaySafe on this device first. Your records stay private to you.';

export async function answerCompanion(action: CompanionAction, p: CompanionIntentParamsT, s: Session | null, now = new Date()): Promise<CompanionAnswer> {
  if (!s || s.role !== 'elder') return { reply: SIGN_IN, card: { kind: 'companion_sign_in', message: SIGN_IN } };
  const hh = s.householdId;

  if (action === 'payment_search') {
    const win = parseDateHint(p.date_hint, now);
    const recipient = p.recipient?.trim() || null;
    const result = searchPayments(store.paymentCandidates(hh), { q: recipient, amountCents: p.amount ? Math.round(p.amount * 100) : null, from: win?.from ?? null, to: win?.to ?? null });
    if (p.date_hint && !win) result.notes.unshift(`I couldn't read the date "${p.date_hint}", so I searched all dates.`);
    const top = result.matches[0];
    const reply = !top
      ? result.guidance
      : top.source === 'manual'
        ? `You have a record of paying ${top.recipient} ${fmtMoney(top.amountCents, top.currency)} on ${top.date}. You typed it in yourself, so it isn't proof the money arrived.${recipient ? ` Don't pay again until you've checked with ${recipient}.` : ''}`
        : `That was a ${fmtMoney(top.amountCents, top.currency)} SaySafe Demo Shop payment on ${top.date}. It was a shop purchase, not a payment to a person.`;
    return { reply, card: { kind: 'payment_matches', result } };
  }

  if (action === 'last_payment') {
    const all = store.paymentCandidates(hh).sort((a, b) => b.date.localeCompare(a.date));
    const recipient = p.recipient?.trim();
    const pool = recipient ? searchPayments(all, { q: recipient }).matches : searchPayments(all, {}).matches.sort((a, b) => b.date.localeCompare(a.date));
    const last = pool.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
    const guidance = last
      ? last.source === 'manual' ? 'This is a record you typed in, not proof the money arrived.' : 'This is a SaySafe Demo Shop payment made in this app (PayPal sandbox).'
      : 'SaySafe has no record of that. It only knows Demo Shop payments made in this app and records you typed in.';
    const reply = last ? `The last one I have is ${fmtMoney(last.amountCents, last.currency)} to ${last.recipient} on ${last.date}. ${guidance}` : `I don't have a record${recipient ? ` of paying ${recipient}` : ''}. ${guidance}`;
    return { reply, card: { kind: 'last_payment', payment: last, guidance } };
  }

  if (action === 'monthly_costs') {
    const summary = store.summarise(store.listSubscriptions(hh, now));
    const reply = !summary.totals.length
      ? "You haven't added any subscriptions yet. You can add them yourself, and I'll add up what they cost."
      : `From the subscriptions you added, that's about ${summary.totals.map((t) => `${fmtMoney(t.monthlyCents, t.currency)} a month`).join(' and ')}. You entered these yourself.`;
    return { reply, card: { kind: 'monthly_costs', summary } };
  }

  if (action === 'subscription_help') {
    const merchant = p.merchant?.trim() || null;
    const subs = store.listSubscriptions(hh, now);
    // The SaySafe Demo Membership is the only one SaySafe can cancel. The assistant may only produce the confirmation
    // card (a single-use token); the cancel itself needs a tap that sends the token. A spoken "yes" never cancels.
    const aboutDemo = merchant ? /\b(saysafe|demo)\b/i.test(merchant) : false;
    const liveDemo = subs.find((x) => x.source === 'paypal_sandbox_subscription' && x.status !== 'provider_confirmed' && (x.paypal?.status === 'ACTIVE' || x.paypal?.status === 'SUSPENDED'));
    if (aboutDemo || (!merchant && liveDemo)) {
      try {
        const intent = await demo.cancelIntent(hh);
        return {
          reply: `To stop the ${DEMO_MEMBERSHIP.name}, tap "${DEMO_MEMBERSHIP.cancelConfirmText}" on the card. Nothing is cancelled until you tap it, and I'll check with PayPal afterwards.`,
          card: { kind: 'demo_cancel_intent', ...intent, confirmText: DEMO_MEMBERSHIP.cancelConfirmText },
        };
      } catch (e) {
        if (!(e instanceof CompanionError)) throw e;
        if (aboutDemo) return { reply: e.message, card: { kind: 'subscription_help', merchant, subscription: subs.find((x) => x.source === 'paypal_sandbox_subscription') ?? null, guide: null, genericSteps: [], paypalAutopayUrl: PAYPAL_AUTOPAY_URL, cancellationScope: { ...CANCELLATION_SCOPE.demo }, disclaimer: e.message } };
      }
    }
    const sub = merchant ? subs.find((x) => x.source === 'manual' && (normName(x.merchant).includes(normName(merchant)) || normName(merchant).includes(normName(x.merchant)))) ?? null : null;
    const g = findCancelGuide(merchant ?? sub?.merchant);
    const disclaimer = "SaySafe can't cancel this subscription for you. Only the company can. If you pay them through PayPal, you can also stop the automatic payment in PayPal yourself. Keep their confirmation email.";
    const reply = g ? `Here are ${g.name}'s own cancellation steps. You cancel on their website or app. ${disclaimer}` : `I don't have a checked link for ${merchant ?? 'that company'}. Here are general steps. ${disclaimer}`;
    return { reply, card: { kind: 'subscription_help', merchant, subscription: sub, guide: g ? { id: g.id, name: g.name, url: g.url, steps: g.steps, note: g.note, verifiedOn: g.verifiedOn } : null, genericSteps: g ? [] : [...GENERIC_CANCEL_STEPS], paypalAutopayUrl: PAYPAL_AUTOPAY_URL, cancellationScope: { ...CANCELLATION_SCOPE.external }, disclaimer } };
  }

  // contact_lookup
  const contacts = store.listContacts(hh);
  const qName = p.contact_name?.trim() || null;
  const qRel = p.relation?.trim().toLowerCase().replace(/^(my|your)\s+/, '') || null;
  const hits: ContactT[] = contacts.filter((c) => {
    if (qRel && c.relation && normName(c.relation) === normName(qRel)) return true;
    if (qName) { const qt = tokens(qName); const ct = tokens(c.name); return qt.length > 0 && qt.every((t) => ct.some((x) => tokenSimilarity(t, x) >= 0.85)); }
    return false;
  }).slice(0, 5);
  const query = qName ?? qRel;
  const advice = 'Saved by you — not verified. If a message claims to be from them, call the number you saved, not one from the message.';
  const reply = hits.length
    ? hits.length === 1 ? `Here's ${hits[0].name}${hits[0].relation ? `, your ${hits[0].relation}` : ''}, as you saved them.` : `I found ${hits.length} contacts that match.`
    : query ? `I don't have a saved contact for ${query}. You can add one yourself.` : 'Who would you like to find?';
  return { reply, card: { kind: 'contact_card', contacts: hits, query, advice } };
}
