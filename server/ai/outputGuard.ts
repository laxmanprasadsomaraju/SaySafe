/**
 * Output guard for model text shown or spoken to the user. The model can be manipulated by text it reads
 * (scanned messages, product titles), so any sentence that vouches for safety or tells the user to pay,
 * click or call is dropped and the deterministic wording is used instead. This guards OUTPUT only;
 * scam rules and verdicts are decided elsewhere and the model can never raise a verdict.
 */
const UNSAFE = [
  /\b(is|looks|seems|appears)\s+(to be\s+)?(totally\s+|completely\s+|perfectly\s+)?(safe|genuine|legit(imate)?|real|authentic|trustworthy)\b/i,
  /\b(it'?s|this is|that'?s)\s+(totally\s+|completely\s+|perfectly\s+)?(safe|genuine|legit(imate)?|real|authentic|fine)\b/i,
  /\bsafe to (pay|click|open|call|reply|use|send)\b/i,
  /\bmark(ed)?\s+(it\s+|this\s+)?(as\s+)?safe\b/i,
  /\bgo ahead( and)?\b/i,
  /\b(pay|send|transfer|wire)\s+(now|it|them|the (money|amount|invoice|fee))\b/i,
  /\b(click|tap|open)\s+(on\s+)?(the|this|that)\s+link\b/i,
  /\b(payment|purchase)\s+(is\s+|has been\s+)?(approved|captured|completed)\b/i,
  /\bI (have |'ve )?(approved|captured|paid|refunded)\b/i,
];

const NEGATED_DISCLOSURE = /(?:\bcan['’]?t|\bcannot|\bcan not|\bcould ?n['’]?t|\bcould not|\b(?:is |are |am |was )?unable to|\b(?:is |are |am )?not able to|\bno way to|\b(?:does|do|did) ?n['’]?t|\b(?:does|do|did) not|\bwon['’]?t|\bwill not|\bnever)\s+(?:independently\s+|actually\s+|yet\s+)?(?:confirm|verify|check|tell|know|say|guarantee|prove|promise|vouch)\b[^,;.!?\n]*?(?=\s*(?:[,;.!?\n]|\bbut\b|\bhowever\b|\bso\b|$))/gi;

/** "This isn't a guarantee it's safe" denies safety; it does not assert it. */
const NOT_A_GUARANTEE = /\b(?:is ?n['’]?t|is not|not|no|never)\s+(?:a\s+|any\s+)?(?:guarantee|promise|proof)\b[^,;.!?\n]*?(?=\s*(?:[,;.!?\n]|\bbut\b|\bhowever\b|\bso\b|$))/gi;

export function vouchesOrInstructs(text: string | null | undefined): boolean {
  if (!text) return false;
  // 1) Negated disclosures: "SaySafe can't confirm who sent this or whether a payment is real".
  //    The clause governed by "can't/cannot/not/unable to confirm|verify|…" is a statement of what we
  //    do NOT know, so it is removed up to the next clause break. The clause stops at , ; . ! ? and at
  //    "but"/"however"/"so", so "I can't confirm it, but it is safe to pay" is still caught.
  let t = text.replace(NEGATED_DISCLOSURE, ' ').replace(NOT_A_GUARANTEE, ' ');
  // 2) Other negated forms are the safe direction: "is not safe", "isn't genuine", "don't click the link".
  t = t.replace(/(\bnot|n['’]t|\bnever|\bno longer)\s+\w+/gi, ' ');
  return UNSAFE.some((re) => re.test(t));
}

/** Returns the model text, or the fallback when it vouches for safety or instructs a payment/click. */
export function guardModelText(text: string | null | undefined, fallback: string): string {
  return !text || vouchesOrInstructs(text) ? fallback : text;
}
