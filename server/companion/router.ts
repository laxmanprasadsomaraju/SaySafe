/**
 * Deterministic router for questions about Mary's OWN records (payments, subscriptions, contacts, sending money).
 * Runs before the AI, so these questions get the same answer with or without Groq, typed or spoken.
 * Returns null for anything else (shopping, scam checks, chat), which then goes to the AI as before.
 * It only extracts parameters: the server answers from the database (server/companion/assistant.ts).
 */
import type { IntentT } from '../ai/agent.js';
import { categoryIn } from '../../shared/companion.js';
import { isPaymentStatusQuestion } from '../../shared/paymentStatus.js';

const AMOUNT = /(?:€|eur\s?|euro\s?)\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:euros?|eur)\b/i;
const RELATIONS = 'son|daughter|grandson|granddaughter|brother|sister|nephew|niece|husband|wife|friend|neighbou?r|carer|doctor|gardener|pharmacy|pharmacist|plumber|electrician|cleaner|boiler (?:man|service|engineer)|family helper|helper';
const DATE_HINT = /\b(yesterday|today|last week|this week|last month|this month|\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b/i;

const amountOf = (s: string) => { const m = s.match(AMOUNT); return m ? Number((m[1] ?? m[2]).replace(',', '.')) : null; };
const clean = (s: string | undefined | null) => (s ?? '').replace(AMOUNT, ' ').replace(/[?.!,]+/g, ' ').replace(/\b(please|now|today|for me|in my contacts?|from my contacts?|my contacts?|contact|saved)\b/gi, ' ').replace(/\s+/g, ' ').trim() || null;
const rel = (s: string) => s.match(new RegExp(`\\bmy (${RELATIONS})\\b`, 'i'))?.[1]?.toLowerCase() ?? null;

export function routeCompanion(said: string): IntentT | null {
  const raw = said.trim();
  const s = raw.toLowerCase().replace(/[’']/g, "'");
  if (!s || s.length > 300) return null;

  // ----- "Did my payment go through?" — status of a purchase made in this app. Never a scam check, never a list.
  // The app answers with the receipt card read from the server (GET only: it can't capture or charge again).
  if (isPaymentStatusQuestion(raw)) {
    return { action: 'payment_status', reply: "I'll check that payment." };
  }
  // ----- Insights (Mary's own summary; answered from the database, never by the AI) -----
  const twice = /\b(twice|two times|more than once|double|duplicates?)\b/.test(s);
  if ((twice && (/\bsame (person|people|company|one|amount|thing)\b|\b(anyone|anybody|someone|somebody)\b/.test(s) || /^(have|did) i (paid|pay)( for)?( anything| something)? twice\b/.test(s))) || /\bduplicate (payments?|charges?)\b/.test(s)) {
    return { action: 'insights', insight_focus: 'duplicates', reply: "I'll check your records for repeats." };
  }
  if (/\b(anything|something|what|any)\b.{0,30}\b(waiting|pending)\b.{0,30}\b(approv\w*|review\w*|family|alex|check\w*)\b/.test(s) || /\bwaiting (for|on) (an? )?(approval|review|alex|my family|family)\b/.test(s) || /\bpending (approvals?|reviews?)\b/.test(s)) {
    return { action: 'insights', insight_focus: 'pending', reply: "I'll check what's waiting." };
  }
  if (/\b(my )?(spending|spend|spent)\b/.test(s) && /\b(show|what|how much|my|see|summary|tell)\b/.test(s) && !/\b(want|going) to spend\b/.test(s)) {
    return { action: 'insights', insight_focus: 'spending', reply: "Here's what your records show." };
  }
  if (/\b(safety|scam)\s+(insights?|summary|history|checks?|overview|report)\b/.test(s) || /\b(show|open|see|view)\b.{0,12}\b(my |the )?(safety )?insights?\b/.test(s) || /^(my )?insights?[?.!]*$/.test(s)) {
    return { action: 'insights', insight_focus: /\b(safety|scam)\b/.test(s) ? 'safety' : 'overview', reply: "Here's your summary." };
  }

  // ----- "Did I already pay …?" -----
  if (/\b(have i|did i|i think i|have we|did we)\b.{0,15}\bpa(id|y)\b/.test(s) || /\balready paid\b/.test(s)) {
    const who = raw.replace(/[’]/g, "'").match(/\bpa(?:id|y)\s+(?:for\s+)?(?:the\s+|my\s+|a\s+)?(.{1,60}?)(?=\s+(?:€|eur\b|euro|\d|on\b|in\b|last\b|yesterday\b|by\b|already\b|twice\b|again\b)|[?.!,]|$)/i);
    const recipient = clean(who?.[1]?.replace(/^(already|for)\s+/i, ''));
    const relation = rel(s);
    return { action: 'payment_search', recipient: relation ? relation : recipient, amount: amountOf(s), date_hint: s.match(DATE_HINT)?.[1] ?? null, reply: "I'll look at your records." };
  }
  // ----- Last payment -----
  if (/\b(last|latest|most recent|previous)\s+(payment|purchase|transaction)\b/.test(s)) {
    const to = raw.match(/\b(?:payment|purchase|transaction)\s+(?:to|for)\s+(?!the shop\b)([a-z][a-z' -]{1,40})/i)?.[1];
    return { action: 'last_payment', recipient: clean(to), reply: "I'll look." };
  }
  // ----- Send money to a person (SaySafe never sends it) -----
  const send = raw.replace(/[’]/g, "'").match(/\b(?:i (?:want|need|would like|'d like) to |can you |please |help me )?(?:send|transfer|give|pay)\s+(?:some\s+)?(?:money\s+)?(?:to\s+)?(.{1,60})$/i);
  if (send && !/\b(bill|invoice|subscription|for (?:the|a|an) |demo shop|for it|at paypal|with paypal)\b/.test(s) && !/^(yes|no)\b/.test(s)) {
    const relation = rel(s);
    let who = clean(send[1].replace(/\b(money|some|to|back)\b/gi, ' '));
    if (who && /^(it|that|this|them|now)$/i.test(who)) who = null;
    if (relation || who) return { action: 'send_money', relation, contact_name: relation ? null : who, amount: amountOf(s), reply: "I'll find them in your contacts." };
  }
  // ----- Subscriptions -----
  const subWord = /\b(subscriptions?|memberships?|direct debits?|regular payments?|standing orders?)\b/.test(s);
  if (/\b(cancel|stop|end|get rid of|unsubscribe)\b/.test(s) && !/^(no|stop|cancel|not now)[.!]*$/.test(s.trim())) {
    const cat = categoryIn(s);
    const named = s.match(/\b(streambox(?: plus)?|tunewave(?: premium)?|daily ledger|parcelpass|netflix|spotify|disney\+?|amazon prime|prime|irish times|apple|google one|now tv|sky|demo membership|saysafe demo membership|membership)\b/)?.[1] ?? null;
    if (named || cat || subWord) {
      const merchant = named === 'membership' ? 'demo membership' : named;
      return { action: 'subscription_help', merchant, category: merchant ? null : cat, reply: "Here's how to cancel." };
    }
  }
  if (/\b(which|what)\b.{0,30}\b(costs? the most|most expensive|biggest|dearest|highest)\b/.test(s) || /\bmost expensive (subscription|one)\b/.test(s)) return { action: 'subscription_list', focus: 'most', reply: "Here's what costs the most." };
  if (/\bwhat'?s?\b.{0,20}\b(coming out|due|going out|next)\b/.test(s) || /\bnext (charge|payment|bill|subscription)\b/.test(s) || /\bwhat('s| is) coming\b/.test(s)) {
    if (subWord || /\b(coming out|going out|next (charge|bill|payment|subscription)|due next)\b/.test(s)) return { action: 'subscription_list', focus: 'next', reply: "Here's what's coming out next." };
  }
  if (/\b(how much|what do .{0,20}cost|total)\b/.test(s) && (subWord || /\b(every|each|a|per) month\b/.test(s))) return { action: 'monthly_costs', reply: "I'll add them up." };
  if (subWord || /\bwhat (do|am) i pay(ing)?\b.{0,20}\b(every|each|a|per) (month|week|year)\b/.test(s) || /\bmonthly costs?\b/.test(s)) return { action: 'subscription_list', focus: 'all', reply: "Here's what you pay regularly." };

  // ----- Contacts -----
  if (/\b(show|list|see|open)\b.{0,10}\b(my |all )?(trusted )?contacts\b/.test(s) || /^(my )?(trusted )?contacts[?.!]*$/.test(s) || /\bwho (are|is in) my contacts\b/.test(s)) return { action: 'contact_lookup', list_all: true, reply: "Here are the contacts you saved." };
  const whoIs = s.match(new RegExp(`\\bwho(?:'s| is| are)? my (${RELATIONS})\\b`));
  if (whoIs) return { action: 'contact_lookup', relation: whoIs[1], reply: "Here's what you saved." };
  const relQ = s.match(new RegExp(`\\bmy (${RELATIONS})'?s? (?:phone |mobile )?(?:number|phone|email|contact|details)\\b`));
  if (relQ) return { action: 'contact_lookup', relation: relQ[1], reply: "Here's what you saved." };
  const findQ = raw.match(/\b(?:find|look up|search for|show me|where is|call|ring|phone)\s+([A-Za-z][A-Za-z' -]{1,40}?)(?:\s+(?:in|from)\s+my\s+contacts?|'s (?:number|details|phone))?[?.!]*$/i);
  if (findQ && /\bcontacts?\b|^(find|look up|call|ring|phone)\b/i.test(raw)) {
    const name = clean(findQ[1]);
    const r2 = rel(s);
    if (r2) return { action: 'contact_lookup', relation: r2, reply: "Here's what you saved." };
    // "find a kettle" is shopping, not a contact: only a capitalised name or an explicit "in my contacts".
    if (name && (/\bcontacts?\b/i.test(raw) || /^[A-Z]/.test(findQ[1])) && !/^(a|an|the|some|me)\b/i.test(name)) return { action: 'contact_lookup', contact_name: name, reply: "Here's what you saved." };
  }
  const nameQ = raw.match(/\b([A-Z][a-z]+)'s (?:phone |mobile )?(?:number|email|details)\b/);
  if (nameQ) return { action: 'contact_lookup', contact_name: nameQ[1], reply: "Here's what you saved." };
  return null;
}
