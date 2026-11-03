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
import { SAMPLE_CANCEL_NOTICE } from '../../shared/demoData.js';
import * as demo from './demoMembership.js';
import { buildSummary } from '../insights/summary.js';
import type { InsightsSummaryT, MoneyT, InsightFocus } from '../../shared/insightsSummary.js';
import { CompanionError } from './store.js';
import { COMPANION_ACTIONS, CANCELLATION_SCOPE, PAYPAL_AUTOPAY_URL, DEMO_MEMBERSHIP, PAYPAL_SEND_MONEY_URL, SEND_MONEY_NOTICE, type SubscriptionT, type CompanionAction, type CompanionCardT, type CompanionIntentParamsT, type ContactT } from '../../shared/companion.js';

export const isCompanionAction = (a: string): a is CompanionAction => (COMPANION_ACTIONS as readonly string[]).includes(a);

export interface CompanionAnswer { reply: string; card: CompanionCardT }

const SIGN_IN = 'Please start SaySafe on this device first. Your records stay private to you.';

export async function answerCompanion(action: CompanionAction, p: CompanionIntentParamsT, s: Session | null, now = new Date()): Promise<CompanionAnswer> {
  if (!s || s.role !== 'elder') return { reply: SIGN_IN, card: { kind: 'companion_sign_in', message: SIGN_IN } };
  const hh = s.householdId;

  if (action === 'insights') {
    const focus: InsightFocus = p.insight_focus ?? 'overview';
    const summary = buildSummary({ role: 'elder', householdId: hh }, now);
    return { reply: insightsReply(summary, focus), card: { kind: 'insights_summary', focus, summary } };
  }

  if (action === 'payment_search') {
    const win = parseDateHint(p.date_hint, now);
    const recipient = p.recipient?.trim() || null;
    const result = searchPayments(store.paymentCandidates(hh), { q: recipient, amountCents: p.amount ? Math.round(p.amount * 100) : null, from: win?.from ?? null, to: win?.to ?? null });
    if (p.date_hint && !win) result.notes.unshift(`I couldn't read the date "${p.date_hint}", so I searched all dates.`);
    const top = result.matches[0];
    const n = result.matches.length;
    // Wording depends on WHY two records look alike (classifyRepeat): ask, warn gently, or just mention.
    const reps = result.repeats ?? [];
    const dupRep = reps.find((x) => x.kind === 'possible_duplicate');
    const identical = reps.find((x) => x.kind === 'identical_entries');
    const separate = reps.find((x) => x.kind === 'separate_payments');
    const repeatNote = identical ? ` Two of them are identical entries (same day, amount and note): they may be one payment typed in twice. Check before treating them as two.`
      : dupRep ? ` Two look like a possible duplicate: the same amount to ${dupRep.recipient}, ${dupRep.daysApart} day${dupRep.daysApart === 1 ? '' : 's'} apart. Ask ${dupRep.recipient} before paying again.`
      : separate ? ` You paid ${separate.recipient} the same amount more than once, but they look like separate payments (${separate.daysApart} days apart${/different things/.test(separate.message) ? ', for different work' : ''}).` : '';
    const more = n > 1 ? ` I found ${n} records in total.${repeatNote}` : '';
    // Amount only ("a message says I owe €120"): the same amount is never proof that THIS bill is paid.
    if (!recipient && p.amount) {
      const amt = fmtMoney(Math.round(p.amount * 100), 'EUR');
      const desc = (m: typeof top) => `${m!.source === 'manual' ? `${m!.sample ? 'a sample record' : 'a record you typed'} of paying ${m!.recipient}` : m!.sample ? 'a sample Demo Shop purchase' : 'a SaySafe Demo Shop purchase (real PayPal Sandbox)'} on ${new Date(`${m!.date}T00:00:00Z`).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', timeZone: 'UTC' })}${m!.description ? ` (${m!.description})` : ''}`;
      const reply = !top
        ? `I couldn't find any record of ${amt}. That doesn't prove you haven't paid, and it doesn't prove you owe it. Who is the message from? Check with them using a number you already have, not one in the message.`
        : `I found ${n === 1 ? 'one record' : `${n} records`} of ${amt}. The closest is ${desc(top)}. A matching amount alone doesn't prove this bill is paid${top.sample ? ', and this one is illustrative sample data' : top.source === 'manual' ? ', and a record you typed isn\u2019t proof the money arrived' : ''}. Who is the message from? Check with them using a number you already have, not one in the message.`;
      return { reply, card: { kind: 'payment_matches', result: { ...result, guidance: top ? `A matching amount is not proof. Nothing here shows that the ${amt} in your message is paid. Check who sent it before you pay.` : result.guidance } } };
    }
    const reply = !top
      ? result.guidance
      : top.sample
        ? `Sample data: ${top.source === 'manual' ? `a record of paying ${top.recipient}` : `a SaySafe Demo Shop purchase`} ${fmtMoney(top.amountCents, top.currency)} on ${top.date}${top.description ? ` (${top.description})` : ''}. It's illustrative, not a real payment.${more}${recipient ? ` In real life, don't pay again until you've checked.` : ''}`
        : top.source === 'manual'
          ? `You have a record of paying ${top.recipient} ${fmtMoney(top.amountCents, top.currency)} on ${top.date}. You typed it in yourself, so it isn't proof the money arrived.${more}${recipient ? ` Don't pay again until you've checked with ${recipient}.` : ''}`
          : `That was a ${fmtMoney(top.amountCents, top.currency)} SaySafe Demo Shop payment on ${top.date} (a real PayPal Sandbox transaction). It was a shop purchase, not a payment to a person.${more}`;
    return { reply, card: { kind: 'payment_matches', result } };
  }

  if (action === 'last_payment') {
    const all = store.paymentCandidates(hh).sort((a, b) => b.date.localeCompare(a.date));
    const recipient = p.recipient?.trim();
    const pool = recipient ? searchPayments(all, { q: recipient }).matches : searchPayments(all, {}).matches.sort((a, b) => b.date.localeCompare(a.date));
    const last = pool.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
    const guidance = last
      ? last.sample ? 'Sample data: illustrative, not a real payment. There is no PayPal record for it.'
        : last.source === 'manual' ? 'This is a record you typed in, not proof the money arrived.' : 'Real PayPal Sandbox transaction: a SaySafe Demo Shop payment made in this app (no real money).'
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
    if (aboutDemo || (!merchant && !p.category && liveDemo)) {
      try {
        const intent = await demo.cancelIntent(hh);
        return {
          reply: `To stop the ${DEMO_MEMBERSHIP.name}, tap "${DEMO_MEMBERSHIP.cancelConfirmText}" on the card. Nothing is cancelled until you tap it, and I'll check with PayPal afterwards.`,
          card: { kind: 'demo_cancel_intent', ...intent, confirmText: DEMO_MEMBERSHIP.cancelConfirmText },
        };
      } catch (e) {
        if (!(e instanceof CompanionError)) throw e;
        if (aboutDemo && !subs.some((x) => x.source === 'paypal_sandbox_subscription')) {
          const summary = store.summarise(subs);
          return { reply: `You don't have an active ${DEMO_MEMBERSHIP.name}, so there is nothing to cancel. You can start one (PayPal sandbox, no real money) and then cancel it here.`, card: { kind: 'subscriptions_list', focus: 'all', subscriptions: subs, summary, highlight: highlights(subs, now), demoOffer: true } };
        }
        if (aboutDemo) return { reply: e.message, card: { kind: 'subscription_help', merchant, subscription: subs.find((x) => x.source === 'paypal_sandbox_subscription') ?? null, guide: null, genericSteps: [], paypalAutopayUrl: PAYPAL_AUTOPAY_URL, cancellationScope: { ...CANCELLATION_SCOPE.demo }, disclaimer: e.message } };
      }
    }
    let sub = merchant ? subs.find((x) => x.source === 'manual' && (normName(x.merchant).includes(normName(merchant)) || normName(merchant).includes(normName(x.merchant)))) ?? null : null;
    // "Cancel my streaming subscription": the first one of that kind she tracks (e.g. Netflix).
    const ofKind = !merchant && p.category ? subs.filter((x) => x.source === 'manual' && x.category === p.category && x.status !== 'user_reported_cancelled' && !x.stoppedTrackingAt) : [];
    if (!sub && ofKind.length) sub = ofKind[0];
    if (!merchant && !sub && !p.category) {
      // Nothing named: show the list so she can pick one (each row has "Help me cancel").
      return listCard(subs, 'all', now, 'Which one would you like to cancel? Tap it in the list, then "Help me cancel".');
    }
    if (sub?.sample) {
      // A sample (fictional) subscription: no real company page exists, so no link: an in-app explanation instead.
      const reply = `Sample data: ${sub.merchant}, ${fmtMoney(sub.amountCents, sub.currency)} ${sub.frequency === 'yearly' ? 'a year' : sub.frequency === 'weekly' ? 'a week' : 'a month'}. ${SAMPLE_CANCEL_NOTICE}`;
      return { reply, card: { kind: 'subscription_help', merchant: sub.merchant, subscription: sub, guide: null, genericSteps: [], paypalAutopayUrl: PAYPAL_AUTOPAY_URL, cancellationScope: { ...CANCELLATION_SCOPE.external }, disclaimer: SAMPLE_CANCEL_NOTICE } };
    }
    const g = findCancelGuide(merchant ?? sub?.merchant);
    const disclaimer = "SaySafe can't cancel this subscription for you. Only the company can. If you pay them through PayPal, you can also stop the automatic payment in PayPal yourself. Keep their confirmation email.";
    const found = sub ? `${sub.sample ? 'Sample data: ' : ''}${sub.merchant}, ${fmtMoney(sub.amountCents, sub.currency)} ${sub.frequency === 'yearly' ? 'a year' : sub.frequency === 'weekly' ? 'a week' : 'a month'}${sub.nextOn ? `, next expected charge ${sub.nextOn}` : ''}. ` : '';
    const also = ofKind.length > 1 ? ` You also track ${ofKind.slice(1).map((x) => x.merchant).join(' and ')}.` : '';
    const noneOfKind = !merchant && p.category && !sub ? `I couldn't find a ${p.category} subscription in your list. ` : '';
    const reply = `${noneOfKind}${found}${g ? `Here are ${g.name}'s own cancellation steps. You cancel on their website or app.` : `I don't have a checked link for ${sub?.merchant ?? merchant ?? 'that company'}. Here are general steps.`} ${disclaimer}${also}`;
    return { reply, card: { kind: 'subscription_help', merchant: merchant ?? sub?.merchant ?? null, subscription: sub, guide: g ? { id: g.id, name: g.name, url: g.url, steps: g.steps, note: g.note, verifiedOn: g.verifiedOn } : null, genericSteps: g ? [] : [...GENERIC_CANCEL_STEPS], paypalAutopayUrl: PAYPAL_AUTOPAY_URL, cancellationScope: { ...CANCELLATION_SCOPE.external }, disclaimer } };
  }

  if (action === 'subscription_list') {
    const focus = p.focus ?? 'all';
    return listCard(store.listSubscriptions(hh, now), focus, now);
  }

  const contacts = store.listContacts(hh);
  const findContacts = (qName: string | null, qRel: string | null) => contacts.filter((c) => {
    if (qRel && c.relation && (normName(c.relation) === normName(qRel) || normName(c.relation).includes(normName(qRel)))) return true;
    if (qName) { const qt = tokens(qName); const ct = tokens(c.name); return qt.length > 0 && qt.every((t) => ct.some((x) => tokenSimilarity(t, x) >= 0.85)); }
    return false;
  }).slice(0, 5);

  if (action === 'send_money') {
    const qName = p.contact_name?.trim() || null;
    const qRel = p.relation?.trim().toLowerCase().replace(/^(my|your)\s+/, '') || null;
    const hits = findContacts(qName, qRel);
    const amountCents = p.amount ? Math.round(p.amount * 100) : null;
    const who = qName ?? (qRel ? `your ${qRel}` : 'them');
    const amt = amountCents ? fmtMoney(amountCents, 'EUR') : null;
    const reply = hits.length
      ? `I found ${hits.length === 1 ? `${hits[0].name}${hits[0].relation ? `, your ${hits[0].relation}` : ''}` : `${hits.length} contacts`} in your saved contacts. Tap the right person${amt ? ` to prepare ${amt}` : ''}. SaySafe can't send money to a person: you send it yourself in PayPal. Nothing is sent by SaySafe.`
      : `I couldn't find ${who} in your saved contacts, so I haven't prepared anything. Nothing is sent by SaySafe.`;
    return { reply, card: { kind: 'send_money', query: qName ?? qRel, contacts: hits, amountCents, currency: 'EUR', paypalSendUrl: PAYPAL_SEND_MONEY_URL, notice: SEND_MONEY_NOTICE } };
  }

  // contact_lookup
  const qName = p.contact_name?.trim() || null;
  const qRel = p.relation?.trim().toLowerCase().replace(/^(my|your)\s+/, '') || null;
  if (p.list_all) {
    const all = contacts.slice(0, 10);
    const reply = all.length ? `You have ${contacts.length} saved contact${contacts.length === 1 ? '' : 's'}${all.some((c) => c.sample) ? ' (sample data for the demo)' : ''}.` : "You haven't saved any contacts yet. You can add one yourself.";
    return { reply, card: { kind: 'contact_card', contacts: all, query: null, advice: 'Saved by you — not verified. If a message claims to be from them, call the number you saved, not one from the message.' } };
  }
  const hits: ContactT[] = findContacts(qName, qRel);
  const query = qName ?? qRel;
  const advice = 'Saved by you — not verified. If a message claims to be from them, call the number you saved, not one from the message.';
  const reply = hits.length
    ? hits.length === 1 ? `${qRel && !qName ? `Your ${qRel} is ${hits[0].name}` : `Here's ${hits[0].name}${hits[0].relation ? `, your ${hits[0].relation}` : ''}`}, as saved${hits[0].sample ? ' (sample data)' : ''}.` : `I found ${hits.length} contacts that match.`
    : query ? `I don't have a saved contact for ${query}. You can add one yourself.` : 'Who would you like to find?';
  return { reply, card: { kind: 'contact_card', contacts: hits, query, advice } };
}

const monthlyOf = (x: SubscriptionT) => (x.frequency === 'weekly' ? (x.amountCents * 52) / 12 : x.frequency === 'yearly' ? x.amountCents / 12 : x.amountCents);
const live = (x: SubscriptionT) => !x.stoppedTrackingAt && x.status !== 'provider_confirmed' && x.status !== 'user_reported_cancelled'
  && (x.source === 'manual' || x.paypal?.status === 'ACTIVE' || x.paypal?.status === 'SUSPENDED');
export function highlights(subs: SubscriptionT[], _now = new Date()) {
  const l = subs.filter(live);
  const most = [...l].sort((a, b) => monthlyOf(b) - monthlyOf(a))[0] ?? null;
  const largest = [...l].sort((a, b) => b.amountCents - a.amountCents)[0] ?? null;
  const next = l.filter((x) => x.nextPaymentInDays != null && x.nextPaymentInDays >= 0).sort((a, b) => a.nextPaymentInDays! - b.nextPaymentInDays!)[0] ?? null;
  return { mostMonthlyId: most?.id ?? null, largestChargeId: largest?.id ?? null, nextId: next?.id ?? null };
}
const per = (x: SubscriptionT) => (x.frequency === 'yearly' ? 'a year' : x.frequency === 'weekly' ? 'a week' : 'a month');
function listCard(subs: SubscriptionT[], focus: 'all' | 'most' | 'next', now: Date, lead?: string): CompanionAnswer {
  const summary = store.summarise(subs);
  const h = highlights(subs, now);
  const byId = (id: string | null) => subs.find((x) => x.id === id) ?? null;
  const sampleNote = subs.some((x) => x.sample) ? ' These are sample subscriptions for the demo.' : '';
  const demoOffer = !subs.some((x) => x.source === 'paypal_sandbox_subscription');
  let reply: string;
  if (!subs.length) reply = "You haven't added any subscriptions yet. You can add them yourself, and I'll add up what they cost.";
  else if (focus === 'most') {
    const m = byId(h.mostMonthlyId); const L = byId(h.largestChargeId);
    reply = m ? `${m.merchant} costs the most each month: ${fmtMoney(m.amountCents, m.currency)} ${per(m)}.${L && L.id !== m.id ? ` The largest single charge is ${L.merchant}, ${fmtMoney(L.amountCents, L.currency)} ${per(L)} (about ${fmtMoney(Math.round(monthlyOf(L)), L.currency)} a month).` : ''}${sampleNote}`
      : 'Nothing is being counted right now, so I can’t say which costs the most.';
  } else if (focus === 'next') {
    const n = byId(h.nextId);
    reply = n ? `Next to come out is ${n.merchant}: ${fmtMoney(n.amountCents, n.currency)} on ${n.nextOn}${n.nextPaymentInDays === 0 ? ' (today)' : n.nextPaymentInDays === 1 ? ' (tomorrow)' : ` (in ${n.nextPaymentInDays} days)`}. That's the date entered, not confirmed by the company.${sampleNote}`
      : 'None of your subscriptions has a next date entered.';
  } else {
    reply = `You have ${subs.length} subscription${subs.length === 1 ? '' : 's'}${summary.totals.length ? `, about ${summary.totals.map((t) => `${fmtMoney(t.monthlyCents, t.currency)} a month`).join(' and ')}` : ''}.${sampleNote}`;
  }
  return { reply: lead ? `${lead} ${reply}` : reply, card: { kind: 'subscriptions_list', focus, subscriptions: subs, summary, highlight: h, demoOffer } };
}

const eur = (ms: MoneyT[]) => (ms.length ? ms.map((m) => fmtMoney(m.cents, m.currency)).join(' and ') : fmtMoney(0, 'EUR'));
/** Template replies for the insights card. Kinds of record are always named separately and never added together. */
export function insightsReply(d: InsightsSummaryT, focus: InsightFocus): string {
  const sb = d.payments.sandbox;
  const pend = d.pendingReviews.real.length;
  const subsU = d.subscriptions?.userEntered; const subsS = d.subscriptions?.sample;
  if (focus === 'spending') {
    const parts = [
      sb.captured.count ? `Real PayPal Sandbox: ${eur(sb.captured.totals)} paid in ${sb.captured.count} Demo Shop purchase${sb.captured.count === 1 ? '' : 's'} (no real money).` : 'No PayPal Sandbox payments have finished yet.',
      d.records?.userEntered.count ? `Recorded by you: ${d.records.userEntered.count} payment${d.records.userEntered.count === 1 ? '' : 's'}, ${eur(d.records.userEntered.totals)} (not verified).` : null,
      d.records?.sample.count || d.payments.sample.count ? 'Sample data is shown separately and is illustrative.' : null,
    ].filter(Boolean);
    return `${parts.join(' ')} I keep these apart because they are different kinds of record.`;
  }
  if (focus === 'pending') {
    if (!pend) return `Nothing is waiting for your family member right now.${d.pendingReviews.sampleWaiting ? ' The waiting item in your sample data is illustrative and can’t be approved.' : ''}`;
    const x = d.pendingReviews.real[0];
    return `${pend === 1 ? `One purchase is` : `${pend} purchases are`} waiting for your family member: ${x.item}, ${fmtMoney(x.amountCents, x.currency)}${pend > 1 ? ' and more' : ''}. Nothing is paid until they answer and you approve at PayPal.`;
  }
  if (focus === 'duplicates') {
    const dups = d.duplicates ?? [];
    if (!dups.length) return 'I didn’t find two records that look like the same payment. I can only see records you typed and Demo Shop payments made here.';
    const x = dups[0];
    return `${dups.length === 1 ? 'One pair looks' : `${dups.length} pairs look`} like a possible repeat: ${fmtMoney(x.amountCents, x.currency)} to ${x.recipient}, ${x.daysApart} day${x.daysApart === 1 ? '' : 's'} apart${x.sample ? ' (sample data)' : ''}. Ask ${x.recipient} before paying again.`;
  }
  if (focus === 'safety') {
    const r = d.scamChecks.real;
    return `${r.total ? `You checked ${r.total} message${r.total === 1 ? '' : 's'}: ${r.suspicious} suspicious, ${r.needsChecking} to check, ${r.noWarnings} with no obvious warning signs.` : 'You haven’t checked any real messages yet.'}${d.scamChecks.training ? ` ${d.scamChecks.training} training example${d.scamChecks.training === 1 ? '' : 's'} not counted.` : ''}`;
  }
  const bits = [
    sb.captured.count ? `${sb.captured.count} PayPal Sandbox payment${sb.captured.count === 1 ? '' : 's'} finished` : null,
    pend ? `${pend} waiting for family` : 'nothing waiting for family',
    d.duplicates?.length ? `${d.duplicates.length} possible repeat${d.duplicates.length === 1 ? '' : 's'}` : null,
    subsU?.count ? `your subscriptions about ${eur(subsU.monthly)} a month` : subsS?.count ? `sample subscriptions about ${eur(subsS.monthly)} a month (illustrative)` : null,
  ].filter(Boolean);
  return `Here’s your summary: ${bits.join(', ')}.`;
}
