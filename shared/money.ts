/**
 * Spoken money. The screen shows "€49.99"; the voice says "49 euro 99 cent".
 * Irish English: "euro" and "cent" do not take a plural s. Whole amounts drop the cents ("€49.00" -> "49 euro").
 */
export function spokenAmount(amount: number, currency = 'EUR'): string {
  if (!Number.isFinite(amount)) return '';
  const neg = amount < 0;
  const totalCents = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(totalCents / 100);
  const cents = totalCents % 100;
  const cur = currency.toUpperCase();
  const [major, minor] = cur === 'EUR' ? ['euro', 'cent'] : cur === 'GBP' ? ['pound', 'pence'] : cur === 'USD' ? ['dollar', 'cent'] : [cur, ''];
  const majorWord = cur === 'GBP' || cur === 'USD' ? (whole === 1 ? major : `${major}s`) : major;
  let out: string;
  if (!minor) out = `${(totalCents / 100).toFixed(cents ? 2 : 0)} ${cur}`;
  else if (whole === 0 && cents > 0) out = `${cents} ${minor}`;
  else out = cents ? `${whole} ${majorWord} ${cents} ${minor}` : `${whole} ${majorWord}`;
  return neg ? `minus ${out}` : out;
}

/** Same, from integer cents (the payment records store cents). */
export const spokenCents = (cents: number, currency = 'EUR') => spokenAmount(cents / 100, currency);

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;
const toNumber = (int: string, dec?: string) => Number(`${int.replace(/,/g, '')}.${(dec ?? '0').padEnd(2, '0')}`);

/**
 * Rewrites every money amount in a sentence for text-to-speech only (captions keep the symbol):
 * "€49.99", "€ 49", "€1,299.00", "49.99 EUR", "49 euro" stay exact, never rounded.
 */
export function speakableMoney(text: string): string {
  return text
    .replace(new RegExp(String.raw`€\s?${NUM}(?!\d)`, 'g'), (_m, i: string, d?: string) => spokenAmount(toNumber(i, d), 'EUR'))
    .replace(new RegExp(String.raw`(?<![\w.])${NUM}\s?(EUR|GBP|USD)\b`, 'g'), (_m, i: string, d: string | undefined, c: string) => spokenAmount(toNumber(i, d), c))
    .replace(new RegExp(String.raw`£\s?${NUM}(?!\d)`, 'g'), (_m, i: string, d?: string) => spokenAmount(toNumber(i, d), 'GBP'));
}
