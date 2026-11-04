/**
 * Deterministic router for the Assistant's read-only tools that the older rules got wrong or did not know
 * (preferences, memory, conversation recall, transactions, duplicate charges, the approval limit, "can I send money",
 * payment evidence, trusted contacts, capabilities). It runs BEFORE server/companion/router.ts.
 * It only names a tool and extracts parameters. The server answers from the signed-in elder's own records
 * (server/assistant/tools.ts). Nothing here writes, pays, approves or sends.
 */
import { z } from 'zod';

export const ASSISTANT_TOOLS = ['preferences', 'memory_recall', 'conversation_recall', 'transactions', 'duplicate_check', 'spending_limit', 'transfer_check', 'payment_check', 'trust_contact', 'capabilities'] as const;
export type AssistantTool = (typeof ASSISTANT_TOOLS)[number];

export const ToolParams = z.object({
  /** transactions: list (default), total ("how much have I spent"), latest_receipt */
  mode: z.enum(['list', 'total', 'latest_receipt']).nullable().optional().catch(null),
  status: z.enum(['pending', 'paid', 'failed', 'cancelled', 'refunded']).nullable().optional().catch(null),
  min: z.number().min(0).max(1_000_000).nullable().optional().catch(null),
  max: z.number().min(0).max(1_000_000).nullable().optional().catch(null),
  period: z.enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'all']).nullable().optional().catch(null),
  item: z.string().trim().max(60).nullable().optional().catch(null),
  /** transfer_check / payment_check / trust_contact */
  person: z.string().trim().max(60).nullable().optional().catch(null),
  relation: z.string().trim().max(40).nullable().optional().catch(null),
  amount: z.number().positive().max(1_000_000).nullable().optional().catch(null),
  /** preferences: a specific aspect ("colour", "brand", "budget") or "why" (why are you showing me black kettles) */
  aspect: z.enum(['all', 'colour', 'brand', 'budget', 'why']).nullable().optional().catch(null),
  /** conversation_recall: yesterday | today | recent */
  when: z.enum(['yesterday', 'today', 'recent']).nullable().optional().catch(null),
});
export type ToolParamsT = z.infer<typeof ToolParams>;
export interface ToolIntent { tool: AssistantTool; params: ToolParamsT }

const RELATIONS = 'grandson|granddaughter|grandchild|son|daughter|husband|wife|partner|friend|neighbou?r|nephew|niece|brother|sister|carer|gardener|plumber|electrician|cleaner|helper';
const AMOUNT = /(?:€|eur\s?|euro\s?)\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:euros?|eur)\b/i;
const amountOf = (s: string) => { const m = s.match(AMOUNT); return m ? Number((m[1] ?? m[2]).replace(',', '.')) : null; };
const relOf = (s: string) => s.match(new RegExp(`\\bmy (${RELATIONS})\\b`, 'i'))?.[1]?.toLowerCase() ?? null;
const periodOf = (s: string): ToolParamsT['period'] =>
  /\btoday\b/.test(s) ? 'today' : /\byesterday\b/.test(s) ? 'yesterday' : /\blast week\b/.test(s) ? 'last_week' : /\bthis week\b/.test(s) ? 'this_week'
    : /\blast month\b/.test(s) ? 'last_month' : /\bthis month\b/.test(s) ? 'this_month' : null;
/** A person's name as typed (capitalised word(s)), never a relation word. */
const nameAfter = (raw: string, lead: RegExp) => {
  const m = raw.match(lead);
  const n = m?.[1]?.trim().replace(/[?.!,]+$/, '') ?? null;
  return n && /^[A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?$/.test(n) && !/^(PayPal|SaySafe|The|This|That|It|Them|Him|Her)$/.test(n) ? n : null;
};

export function routeAssistant(said: string): ToolIntent | null {
  const raw = said.trim().replace(/[’]/g, "'");
  const s = raw.toLowerCase().replace(/\s+/g, ' ');
  if (!s || s.length > 300) return null;
  const P = (tool: AssistantTool, params: ToolParamsT = {}): ToolIntent => ({ tool, params });

  // ----- Capabilities (the ONLY place starter examples are offered) -----
  if (/^(what can (you|i) (do|ask|say|try)|what do you do|how can you help( me)?|help|what are you able to do|what can you help (me )?with)[?.!]*$/.test(s)) return P('capabilities');

  // ----- Memory and preferences (answered from saved memory + Profile; never guessed) -----
  if (/\bwhat (do|did) you (remember|know|save[d]?|keep) about me\b|\bwhat have you (remembered|saved)\b|\bwhat do you remember\b|\bwhat('s| is) in (my )?memory\b/.test(s)) return P('memory_recall');
  if (/\bwhy (are|did|do) you (show|showing|shown|pick|picking|suggest|suggesting|recommend)\b.{0,40}\b(me|these|those|this|that)\b/.test(s) || /\bwhy (these|this one|black|red|blue|white)\b/.test(s)) return P('preferences', { aspect: 'why' });
  if (/\bwhat (colou?r|colou?rs) do i (like|prefer|want)\b|\bmy favou?rite colou?r\b|\bwhich colou?r do i\b/.test(s)) return P('preferences', { aspect: 'colour' });
  if (/\bwhat brands? do i (like|prefer|avoid|not like)\b|\bmy favou?rite brand\b|\bwhich brands?\b.{0,20}\b(i like|avoid)\b/.test(s)) return P('preferences', { aspect: 'brand' });
  if (/\b(what('s| is) my|my usual) (shopping )?budget\b/.test(s)) return P('preferences', { aspect: 'budget' });
  if (/\b(what are|show|tell me|list|see) (me )?my (shopping )?(preferences|prefs|settings|likes)\b|\bmy (shopping )?preferences\b|\bwhat do i (like|prefer)\b|\bwhat are my (likes|preferences)\b|\bwhat preferences\b/.test(s)) return P('preferences', { aspect: 'all' });

  // ----- Conversation recall -----
  if (/\bwhat (did|have) we (discuss|talk(ed)? about|look(ed)? at|say|chat(ted)? about)\b|\bwhat were we (talking|chatting) about\b|\bwhat did (i|you) (ask|say|show me)\b.{0,20}\b(yesterday|earlier|before|last time|today)\b|\b(our|the) (last|previous) conversation\b/.test(s)) {
    return P('conversation_recall', { when: /\byesterday\b/.test(s) ? 'yesterday' : /\btoday\b/.test(s) ? 'today' : 'recent' });
  }

  // ----- Approval / spending limit (never confused with a shopping budget) -----
  if (/\b(spending|approval|protected|family|safety|payment)( approval)? limit\b|\bmy limit\b|\bhow much (can|am) i (allowed to )?spend\b|\bhow much (is )?(left|remaining)\b|\bhow much (money )?do i have left\b|\b(remaining|left) (to spend|on my limit)\b|\bwhat('s| is) the limit\b/.test(s)) {
    if (!/\b(send|transfer|give)\b/.test(s)) return P('spending_limit');
  }

  // ----- Can I send / transfer money to someone? (hand-off only; SaySafe never sends) -----
  if (/\b(can|could|may) i (send|transfer|give)\b.{0,40}\b(money|€|\d|to (my|anyone|someone|anybody|[A-Z]))/i.test(raw) || /\bhow much can i (send|transfer|give)\b/.test(s) || /\b(i want|i'd like|i need) to (send|transfer) money\b/.test(s)) {
    const anyone = /\b(anyone|anybody|someone|somebody|people)\b/.test(s);
    return P('transfer_check', { relation: relOf(s), person: anyone ? null : nameAfter(raw, /\bto ([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)/), amount: amountOf(s) });
  }

  // ----- Is this payment suspicious? Evidence from her own records -----
  if (/\b(is it|is this|would it be|does this|does it|is that)\b.{0,30}\b(safe|suspicious|normal|unusual|a scam|look (odd|strange|right|suspicious))\b.{0,40}\b(pay|paying|send|sending|transfer)\b/.test(s)
    || /\b(should i|is it safe to|is it ok(ay)? to) (pay|send|transfer)\b/.test(s)
    || /\b(suspicious|unusual) (payment|activity|transaction)s?\b/.test(s)) {
    return P('payment_check', { relation: relOf(s), person: nameAfter(raw, /\b(?:pay|send|transfer(?: money)? to|paying|sending)\s+(?:money to\s+)?([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)/), amount: amountOf(s) });
  }

  // ----- "I trust Alex" / "add Pat to my trusted contacts" -> a confirm card (never a silent edit) -----
  const trust = raw.match(/^(?:i (?:really )?trust|i know and trust)\s+([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)(?:,?\s+(?:he|she|they)(?:'s| is| are) my (\w+))?/i)
    ?? raw.match(/^(?:please )?add\s+([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)\s+(?:to|as)\s+(?:a |my )?trusted contacts?/i)
    ?? raw.match(/^([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?) is (?:someone i trust|trustworthy|trusted)/);
  if (trust && /^[A-Z]/.test(trust[1])) return P('trust_contact', { person: trust[1], relation: trust[2]?.toLowerCase() ?? null });

  // ----- Duplicate charges (before the "was I charged" receipt rule) -----
  if (/\b(charged|billed|paid|pay|taken)\b.{0,20}\b(twice|two times|double|more than once)\b|\bdouble[- ]charged\b|\bduplicate (charges?|payments?)\b|\bcharged me twice\b/.test(s)) {
    // "Did I pay John twice?" stays with the named-person record search (companion router).
    // "Have I paid the same person / anyone twice?" stays with the records insight (companion router).
    const personRepeat = /\b(same (person|people|company|one|amount|thing)|anyone|anybody|someone|somebody)\b/.test(s);
    if (!personRepeat && (!/\b(pay|paid)\s+(?!for\b|the shop\b)[a-z]+\s+twice\b/.test(s) || /\b(charged|billed)\b/.test(s))) return P('duplicate_check', { period: periodOf(s) });
  }

  // ----- Transactions (all records she can see; counts by kind) -----
  const txWord = /\b(transac\w*|payments?|purchases?|orders?|spending|spent|charges?|receipts?|bought)\b/;
  if (/\b(how much|what) (have|did) i (spend|spent|pay|paid)\b|\bhow much (have i|did i) spen[dt]\b|\btotal (spent|spending)\b/.test(s) && !/\b(to|for) [a-z]+\b.*\?$/.test(s.replace(/\b(this|last) (month|week)\b|\btoday\b|\byesterday\b/g, ''))) {
    return P('transactions', { mode: 'total', period: periodOf(s) ?? 'all' });
  }
  if (/\b(latest|last|newest|most recent) receipt\b|\bshow (me )?my receipt\b/.test(s)) return P('transactions', { mode: 'latest_receipt' });
  if (txWord.test(s) && /\b(show|list|see|all|my|what|which|any|pending|failed|above|over|below|under|last week|this month|last month|this week|today|yesterday|did i (pay|buy)|have i (paid|bought))\b/.test(s)
    && !/\b(cancel|subscriptions?|last payment to|did my payment|go through|scam|message|refund)\b/.test(s)
    && !/\b(last|latest|most recent|previous) (payment|purchase|transaction)\b/.test(s)
    && !/\b(did|have) i (already )?pa(id|y) (for )?(the |a |my )?[a-z]/.test(s)) {
    const over = s.match(/\b(?:above|over|more than|at least)\s*(?:€|eur\s?)?\s*(\d+(?:[.,]\d{1,2})?)/);
    const under = s.match(/\b(?:below|under|less than)\s*(?:€|eur\s?)?\s*(\d+(?:[.,]\d{1,2})?)/);
    const status = /\bpending|waiting|not finished\b/.test(s) ? 'pending' : /\bfailed|declined|blocked\b/.test(s) ? 'failed' : /\bcancell?ed\b/.test(s) ? 'cancelled' : /\brefunded\b/.test(s) ? 'refunded' : /\b(paid|completed|successful|captured)\b/.test(s) && /\bshow|list\b/.test(s) ? 'paid' : null;
    return P('transactions', { mode: 'list', status, min: over ? Number(over[1].replace(',', '.')) : null, max: under ? Number(under[1].replace(',', '.')) : null, period: periodOf(s) ?? 'all' });
  }
  if (/\bwhat did i (pay|buy|spend)\b/.test(s)) return P('transactions', { mode: 'list', period: periodOf(s) ?? 'all' });
  return null;
}
