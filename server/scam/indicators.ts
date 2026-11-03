/**
 * Wording indicators (deterministic). Each one matches whole words/phrases with regular
 * expressions on the NFKC-normalised ORIGINAL text, so every finding can quote the exact span.
 *
 * Replaces the old substring keyword lists in rules.ts, which matched "pay" inside "PayPal",
 * "pin" inside "shipping" and "locked" inside "blocked".
 */
import type { Signal } from './rules.js';
import type { Family } from './verdicts.js';
import { quoteSpan } from './evidence.js';

interface Hit { index: number; text: string }

function find(src: string, res: RegExp[], opts: { negatable?: boolean } = {}): Hit[] {
  const hits: Hit[] = [];
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of src.matchAll(g)) {
      if (opts.negatable && isNegated(src, m.index!)) continue;
      hits.push({ index: m.index!, text: m[0] });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** "Never share this code" / "do not give your password" are warnings, not requests. */
function isNegated(src: string, index: number): boolean {
  const clauseStart = Math.max(src.lastIndexOf('.', index - 1), src.lastIndexOf('\n', index - 1), src.lastIndexOf('!', index - 1), index - 40);
  const before = src.slice(Math.max(0, clauseStart), index).toLowerCase();
  return /\b(never|don['’]?t|do not|not|no one|nobody|won['’]?t|will not|shouldn['’]?t|should not)\b/.test(before);
}

function sig(src: string, hits: Hit[], s: Omit<Signal, 'evidence' | 'basis'>): Signal {
  const first = hits[0];
  const extra = hits.length > 1 ? ` (+${hits.length - 1} more)` : '';
  return { ...s, basis: 'deterministic_rule', evidence: quoteSpan(src, first.index, first.index + first.text.length) + extra };
}

const MONEY = String.raw`(?:[€$£]\s?\d[\d,.]*|\d[\d,.]*\s?(?:eur|euro|euros|usd|gbp|pounds?|dollars?)\b)`;

const RE = {
  urgency: [
    /\b(?:immediately|urgent(?:ly)?|right away|act now|asap|final (?:notice|warning|reminder)|last (?:warning|chance))\b/i,
    /\bwithin (?:the next )?(?:\d{1,2}|twenty[- ]four|one|two|an?) ?(?:hours?|hrs?|h|minutes?|mins?)\b/i,
    /\b(?:expires?|expiring|ends?) (?:today|tonight|soon|in \d+ (?:hours?|minutes?))\b/i,
    /\b(?:today only|before midnight|avoid (?:suspension|closure|cancellation|charges?|penalt(?:y|ies)))\b/i,
    /\bor (?:your|the) (?:account|card|service|access) will be\b/i,
  ],
  threat: [/\b(?:legal action|police|arrest(?:ed)?|court (?:case|action|summons)|bailiffs?|warrant|prosecut(?:e|ion))\b/i],
  accountProblem: [
    /\b(?:account|access|card|wallet|profile)\b[^.\n]{0,40}?\b(?:limited|restricted|suspended|locked|on hold|frozen|disabled|deactivated|compromised|will be closed)\b/i,
    /\b(?:unusual|suspicious|unrecognised|unrecognized|unauthori[sz]ed) (?:activity|sign[- ]?in|log[- ]?in|login|access)\b/i,
  ],
  secretRequest: [
    /\b(?:send|share|give|tell|read|reply with|text|forward|provide|enter|confirm|type|need|what(?:'s| is))\b[^.\n]{0,40}?\b(?:password|passcode|pin|one[- ]time (?:pass)?code|otp|verification code|security code|\d-digit code|the code|that code|card (?:number|details)|cvv|cvc|bank (?:details|login)|login details|sign[- ]in details|security (?:questions?|answers?)|pps number)\b/i,
    /\b(?:confirm|verify|update|re-?enter)\b[^.\n]{0,20}?\b(?:your )?(?:identity|account details|personal details|billing (?:details|information)|card details|login)\b/i,
    // the secret first, the request after: "I sent my code to you by mistake, can you forward it to me?"
    /\b(?:code|otp|pin|password|passcode)\b[^.\n]{0,70}?\b(?:send|forward|give|tell|read|share|text)\b[^.\n]{0,12}?\b(?:it|that|this|them)?\s*(?:back )?(?:to )?(?:me|us)\b/i,
  ],
  otpPresent: [/\b(?:code|otp|passcode)\b[^.\n]{0,25}?\b\d{4,8}\b/i, /\b\d{4,8}\b[^.\n]{0,25}?\b(?:is your|verification|security) (?:code|otp)\b/i],
  remote: [
    /\b(?:anydesk|teamviewer|team viewer|quick ?support|quickassist|quick assist|rustdesk|ultraviewer|logmein|supremo|splashtop)\b/i,
    /\bremote (?:access|desktop|control|support (?:app|tool))\b/i,
    /\b(?:share|sharing) (?:your|the) screen\b|\bscreen ?shar(?:e|ing)\b/i,
    /\binstall\b[^.\n]{0,30}?\b(?:app|software|program)\b[^.\n]{0,40}?\b(?:help|support|refund|fix|secure)\b/i,
  ],
  giftCard: [/\b(?:gift ?cards?|itunes (?:cards?|vouchers?)|apple gift|google play (?:cards?|vouchers?|codes?)|steam (?:cards?|wallet)|amazon (?:vouchers?|gift)|paysafecard|voucher codes?)\b/i],
  crypto: [/\b(?:bitcoin|btc|crypto(?:currency|currencies)?|usdt|tether|ethereum|crypto (?:atm|wallet)|wallet address|binance|coinbase)\b/i],
  callUs: [
    /\b(?:call|ring|phone|dial)\s+(?:us|our|now|immediately|today|the (?:number|helpline|hotline)|this number|(?:the )?(?:billing|support|security|fraud|refund|customer|paypal)\b)/i,
    /\bcontact (?:our|the) (?:security|fraud|billing|support|refund|customer|paypal)\b[^.\n]{0,20}?\b(?:team|department|desk|centre|center|line)\b/i,
    /\b(?:toll[- ]?free|helpline|hotline)\b/i,
    /\b(?:call|ring|phone|dial|whatsapp)\b[^.\n]{0,12}?(?:\+|00)\d/i,
  ],
  callToCancel: [
    /\b(?:call|ring|phone|dial|contact)\b[^.\n]{0,70}?\b(?:cancel|refund|dispute|reverse|stop (?:the|this) (?:payment|charge|order))/i,
    /\b(?:to|if you want to|for|wish to) (?:cancel|refund|dispute|reverse)\b[^.\n]{0,70}?\b(?:call|ring|phone|dial|contact)\b/i,
  ],
  charge: [
    /\byou (?:have been|were|will be|'ve been) (?:charged|billed|debited)\b/i,
    /\bhas been (?:charged|debited|deducted|billed)\b/i,
    /\b(?:auto[- ]?renew(?:al|ed)?|annual renewal|subscription (?:renewal|renewed|has been|will be))\b/i,
    /\b(?:did ?n[o']?t|did not|didn['’]t|don['’]?t|do not) (?:authori[sz]e|make|place|recogni[sz]e|order)\b/i,
    /\b(?:not authori[sz]ed|unauthori[sz]ed (?:transaction|payment|charge|purchase))\b/i,
    /\bif (?:this|it) (?:was|wasn['’]t|is|isn['’]t) (?:not )?(?:you|yours)\b/i,
    /\bif you did not\b/i,
    /\bnot you\s*\?/i,
    /\b(?:geek ?squad|norton|mcafee|avast|kaspersky|windows defender|microsoft support)\b/i,
    new RegExp(String.raw`\b(?:bitcoin|btc|crypto) (?:purchase|order|transaction)\b`, 'i'),
  ],
  // Weak "something was bought/renewed" claims: on their own they are normal receipt wording,
  // so they only count next to a phone number (the fake-invoice trick).
  chargeClaim: [
    /\brenew(?:al|ed|s)?\b/i,
    /\b(?:order|purchase|payment|subscription|charge|transaction)\b[^.\n]{0,40}?\b(?:confirmed|completed|processed|successful|placed|approved|authori[sz]ed|pending|scheduled)\b/i,
    /\b(?:billing|refunds?|cancell?ation|dispute) (?:support|department|team|line|desk|centre|center)\b/i,
    /\b(?:antivirus|anti-virus|firewall|virus protection|tech(?:nical)? support|device protection)\b/i,
  ],
  paymentAsk: [
    new RegExp(String.raw`\b(?:please|kindly|can you|could you|you (?:must|need to|have to))\s+(?:refund|return|send back|pay back)\b[^.\n]{0,40}?${MONEY}`, 'i'),
    new RegExp(String.raw`\b(?:pay|send|transfer|wire|lodge|settle)\b(?!\s+(?:you|it) back)[^.\n]{0,40}?(?:${MONEY}|\bmoney\b|\bthe (?:amount|balance|fee|deposit|rest)\b|\ba (?:fee|deposit)\b|\b(?:it|that|this) (?:today|now|asap)\b)`, 'i'),
    /\b(?:amount|balance|payment) (?:due|required|outstanding|owed|overdue)\b/i,
    /\bdue (?:on receipt|now|today|immediately|by)\b/i,
    /\b(?:invoice|bill|balance|amount|payment|fee)\b[^.\n]{0,40}?\b(?:is|are) (?:now )?(?:due|overdue|outstanding|payable)\b/i,
    /\b(?:has |have )?(?:requested|is requesting|sent you a (?:payment|money) request|money request|request(?:ed)? (?:a )?payment)\b/i,
    /\b(?:release|unlock|customs|delivery|redelivery|admin|processing|clearance|handling|activation) (?:fee|charge|payment)\b/i,
    /\b(?:can|could) you (?:send|lend|transfer|pay)\b/i,
  ],
  overpayment: [
    /\b(?:sent|paid|refunded|transferred|credited)\b[^.\n]{0,25}?\b(?:too much|by mistake|in error|twice|extra)\b/i,
    /\boverpa(?:id|yment)\b|\baccidental(?:ly)? (?:sent|refund)/i,
    /\b(?:refund (?:is )?(?:pending|waiting|on hold|available)|claim your refund|you are (?:due|owed|entitled to) a refund|tax refund)\b/i,
  ],
  newNumber: [
    /\b(?:new (?:phone )?number|my new (?:phone|mobile|number)|(?:lost|broke|dropped|smashed) my phone|phone (?:is )?(?:broken|dead|not working)|can['’]?t (?:call|talk|ring) (?:right )?now)\b/i,
  ],
  familyGreeting: [
    /\b(?:hi|hello|hey|hiya)\s+(?:mum|mam|mom|mammy|mummy|dad|da|daddy|nan|nana|nanny|granny|gran|grandma|grandad|grandpa)\b/i,
    /^\s*(?:mum|mam|mom|mammy|mummy|dad|da|daddy|nan|nana|nanny|granny|gran|grandma|grandad|grandpa)\b/i,
    /\b(?:it['’]?s|this is) (?:me|your (?:son|daughter|grandson|granddaughter))\b/i,
  ],
  secrecy: [/\b(?:don['’]?t|do not) tell (?:anyone|anybody|mum|mam|mom|dad|your (?:family|bank)|the bank)\b|\bkeep (?:this|it) (?:between us|secret|quiet)\b/i],
  safeAccount: [/\bsafe(?:ty)? account\b|\bmove (?:your|the|all your) (?:money|savings|funds)\b/i],
  emergency: [/\b(?:stuck|stranded|in trouble|in hospital|been arrested|accident|emergency)\b/i],
  romance: [
    /\b(?:guaranteed|risk[- ]free|double your|high) (?:returns?|profits?|money|investment)\b/i,
    /\b(?:investment (?:opportunity|platform)|trading (?:platform|account))\b/i,
    /\b(?:flight|plane ticket|visa|hospital|medical) (?:fees?|bills?|costs?|money)\b/i,
    /\b(?:come|fly) (?:to )?(?:see|visit|meet) you\b/i,
  ],
  prize: [/\byou(?:['’]ve| have)? (?:won|been selected)\b|\b(?:lottery|prize draw|claim your (?:reward|gift|prize))\b/i],
  qr: [/\bscan (?:the|this) qr\b/i],
  // Text aimed at the checker (or any AI) rather than at the reader. A genuine message has no reason to give orders to a scam checker.
  injection: [
    /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,25}?\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,20}?\b(?:instructions?|prompts?|rules?|guidelines|guardrails|checks?)\b/i,
    /\b(?:mark|classify|label|flag|rate|treat|report|tag)\s+(?:this|it|the (?:message|email|invoice|text))?\s*(?:message |email |invoice )?(?:as\s+)?(?:safe|legit(?:imate)?|genuine|trusted|verified|harmless|not (?:a )?scam)\b/i,
    /(?:^|\n|\[)\s*(?:system|assistant|developer)\s*(?:prompt|message|note|override)?\s*\]?\s*:\s*(?=[^\n]{0,80}\b(?:ignore|you are|you must|mark|classify|this message|respond|reply only)\b)/i,
    /\b(?:you are|act as) (?:an? |the )?(?:ai|assistant|language model|chatbot|scam (?:checker|detector|filter)|security (?:scanner|filter))\b/i,
  ],
  // A payment with a deadline of today/now. Payment family (not "pressure"), so on its own a real bill
  // due today is "Needs checking", not "Suspicious".
  payDeadline: [
    /\b(?:pay|settle|clear|transfer|send|lodge|wire)\b[^.\n]{0,30}?\b(?:today|tonight|now|immediately|asap|by (?:today|tonight|tomorrow|midnight|end of (?:the )?day|close of business|\d{1,2}(?::\d{2})?\s?(?:am|pm)))\b/i,
    /\b(?:is |are |now )?(?:due|overdue|payable)\b[^.\n]{0,25}?\b(?:today|tonight|now|immediately)\b/i,
  ],
  genericGreeting: [/\bdear (?:customer|user|client|member|account holder|sir\/madam|valued customer)\b/i],
};

/** "I'll transfer it tonight" is the sender promising to pay you, not a demand. */
const FIRST_PERSON_BEFORE = /\b(?:i|we)(?:['’]ll| will| can| shall| could|['’]m going to| am going to| are going to)\s+(?:\w+\s+)?$/i;

export interface IndicatorContext {
  phones: number;
  unofficialLinks: number;
  userContentLinks: number;
}

export function detectIndicators(src: string, ctx: IndicatorContext): Signal[] {
  const out: Signal[] = [];
  const push = (hits: Hit[], s: Omit<Signal, 'evidence' | 'basis'>) => { if (hits.length) out.push(sig(src, hits, s)); };

  const urgent = find(src, RE.urgency);
  const threat = find(src, RE.threat);
  push([...urgent, ...threat].sort((a, b) => a.index - b.index), {
    code: 'urgency', family: 'pressure',
    severity: threat.length || new Set(urgent.map((h) => h.text.toLowerCase())).size > 1 ? 'high' : 'medium',
    title: 'It pressures you to act fast',
    detail: 'Scammers rush or threaten you so you do not stop and check.',
  });
  push(find(src, RE.secrecy), {
    code: 'secrecy', family: 'pressure', severity: 'medium',
    title: 'It asks you to keep it secret',
    detail: 'Scammers ask you not to tell family or the bank, because they would stop you.',
  });
  push(find(src, RE.safeAccount), {
    code: 'safe_account', family: 'story', severity: 'high',
    title: 'It asks you to move money to a "safe account"',
    detail: 'Banks and the Gardaí never ask you to move money to keep it safe. This is a well-known bank-impersonation scam.',
  });
  push(find(src, RE.accountProblem), {
    code: 'account_problem', family: 'pressure', severity: 'medium',
    title: 'It says there is a problem with your account',
    detail: 'Real account problems show up when you open the PayPal app yourself. Do not fix them through a message.',
  });
  const secret = find(src, RE.secretRequest, { negatable: true });
  push(secret, {
    code: 'sensitive_request', family: 'secret', severity: 'high',
    title: 'It asks for codes, passwords or card details',
    detail: 'PayPal never asks for your password, codes or card details in a message or on a call.',
  });
  if (!secret.length) push(find(src, RE.otpPresent), {
    code: 'otp_present', family: 'secret', severity: 'info', blocksAllClear: true,
    title: 'It contains a one-time code',
    detail: 'If you did not just try to sign in, someone may be trying to use your account. Never give this code to anyone.',
  });
  push(find(src, RE.remote), {
    code: 'remote_access', family: 'secret', severity: 'high',
    title: 'It asks you to install an app or share your screen',
    detail: 'Remote-access apps let a stranger control your phone or computer and your bank.',
  });
  push(find(src, RE.giftCard), {
    code: 'gift_card', family: 'charge', severity: 'high',
    title: 'It mentions paying with gift cards',
    detail: 'No real company or official asks to be paid in gift cards.',
  });
  const payAsk = find(src, RE.paymentAsk);
  const crypto = find(src, RE.crypto);
  const romance = find(src, RE.romance);
  push(crypto, {
    code: 'crypto', family: 'charge', severity: payAsk.length || romance.length ? 'high' : 'medium',
    title: 'It mentions crypto',
    detail: 'Crypto payments are almost impossible to get back. Scammers love them.',
  });
  const callUs = find(src, RE.callUs);
  push(callUs, {
    code: 'call_us', family: 'contact', severity: 'medium',
    title: 'It tells you to call or contact "support"',
    detail: 'Fake support lines are a common trick. Use the contact page inside the PayPal app instead.',
  });
  const cancel = find(src, RE.callToCancel);
  push(cancel, {
    code: 'call_to_cancel', family: 'charge', severity: ctx.phones ? 'high' : 'medium',
    title: 'It tells you to call to cancel or get a refund',
    detail: 'The "call us to cancel" trick gets you on the phone with a scammer who then asks for access or money.',
  });
  const charge = find(src, RE.charge);
  const chargeClaim = ctx.phones ? find(src, RE.chargeClaim) : [];
  push(charge, {
    code: 'invoice_scam', family: 'charge', severity: 'medium',
    title: 'It claims a charge, renewal or purchase you may not have made',
    detail: 'Scammers send scary "you were charged" messages so you call them. Check your real activity in the PayPal app.',
  });
  if (ctx.phones && (charge.length || chargeClaim.length)) {
    const h = charge[0] ?? chargeClaim[0];
    out.push({
      code: 'phone_with_charge', family: 'charge', severity: 'high', basis: 'deterministic_rule',
      title: 'A phone number next to an unexpected charge',
      detail: 'This is the known fake-invoice trick: a real-looking PayPal invoice or request with a "call us" number. Real PayPal invoices can be sent by anyone.',
      evidence: quoteSpan(src, h.index, h.index + h.text.length),
    });
  }
  push(payAsk, {
    code: 'payment_demand', family: 'payment', severity: 'medium',
    title: 'It asks you to pay or send money',
    detail: 'Check any payment request inside the PayPal app, never from a link or a number in a message.',
  });
  if (payAsk.length && ctx.unofficialLinks > 0) {
    out.push({
      code: 'payment_via_link', family: 'link', severity: 'high', basis: 'deterministic_rule',
      title: 'It asks you to pay through a link',
      detail: 'Paying through a link in a message is how fake "fee" and "delivery" scams take card details.',
      evidence: quoteSpan(src, payAsk[0].index, payAsk[0].index + payAsk[0].text.length),
    });
  }
  push(find(src, RE.overpayment), {
    code: 'overpayment_story', family: 'story', severity: 'medium',
    title: 'It talks about a refund or money sent by mistake',
    detail: 'The "we refunded you too much, send it back" story is a common scam.',
  });
  const newNum = find(src, RE.newNumber);
  const fam = find(src, RE.familyGreeting);
  const emerg = find(src, RE.emergency);
  if (newNum.length || (fam.length && (payAsk.length || emerg.length))) {
    const hits = [...newNum, ...fam, ...emerg].sort((a, b) => a.index - b.index);
    out.push(sig(src, hits, {
      code: 'family_impersonation', family: 'story', severity: payAsk.length ? 'high' : 'medium',
      title: 'It could be someone pretending to be family',
      detail: '"Hi Mum, this is my new number" messages that then ask for money are a common scam. Call your family member on the number you already have.',
    }));
  }
  push(romance, {
    code: 'romance_investment', family: 'story', severity: 'medium',
    title: 'It sounds like a romance or investment story',
    detail: 'Strangers who build trust and then need money, or promise big returns, are a classic scam.',
  });
  push(find(src, RE.prize), {
    code: 'prize', family: 'story', severity: 'medium',
    title: 'It says you have won something',
    detail: 'If you did not enter, you did not win. Prize messages usually ask for a fee or your details.',
  });
  push(find(src, RE.qr), {
    code: 'qr_code', family: 'link', severity: 'medium',
    title: 'It asks you to scan a QR code',
    detail: 'A QR code is a hidden link. You cannot see where it goes before you open it.',
  });
  push(find(src, RE.injection), {
    code: 'prompt_injection', family: 'manipulation', severity: 'high',
    title: 'It contains orders aimed at a scam checker',
    detail: 'Words like "ignore previous instructions" or "mark this as safe" are written to fool automatic checkers. A genuine message has no reason to include them.',
  });
  const deadline = find(src, RE.payDeadline).filter((h) => !FIRST_PERSON_BEFORE.test(src.slice(Math.max(0, h.index - 24), h.index)));
  if (payAsk.length || deadline.length) push(deadline, {
    code: 'payment_deadline', family: 'payment', severity: 'medium',
    title: 'It wants payment today or right now',
    detail: 'A deadline of "today" is a reason to slow down. Check the bill in the official app or with the company, using a number you already have.',
  });
  push(find(src, RE.genericGreeting), {
    code: 'generic_greeting', family: 'identity', severity: 'info',
    title: 'It does not use your name',
    detail: 'Real PayPal emails greet you by your full name.',
  });
  return out;
}
