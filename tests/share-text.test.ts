import { describe, it, expect } from 'vitest';
import { buildShareText, sanitizeShareText, whatsappUrl, PUBLIC_SAYSAFE_URL } from '../web/src/lib/shareText';
import { scanMessage } from '../server/scam/guardian';

const NASTY = 'Hi Mary Kelly, invoice INV2-7KQ4-PL93, capture 3C679366HH908993F, order 5O190127TN364715T, call +1 (808) 555-0199 or 087 123 4567, email billing.team@paypa1-help.com, pay at https://paypa1-help.com/pay or bit.ly/x';

describe('WhatsApp share text', () => {
  it('never contains the message, IDs, phones, emails, URLs from it, or names', async () => {
    const r = await scanMessage(NASTY);
    const t = buildShareText(r);
    for (const bad of ['Mary', 'Kelly', 'INV2-7KQ4-PL93', '3C679366HH908993F', '5O190127TN364715T', '808', '555-0199', '087 123', 'billing.team', 'paypa1-help', 'bit.ly', '@']) expect(t, bad).not.toContain(bad);
    expect(t).toContain('SaySafe check: Suspicious');
    expect(t).toContain(PUBLIC_SAYSAFE_URL);
    expect(t.match(/https?:\/\/\S+/g)).toEqual([PUBLIC_SAYSAFE_URL]);
    expect(t).toContain('type paypal.com yourself');
  });
  it('uses at most two generic warning signs', async () => {
    const t = buildShareText(await scanMessage(NASTY));
    const line = t.split('\n').find((l) => l.startsWith('Warning signs:'))!;
    expect(line.split(';').length).toBeLessThanOrEqual(2);
  });
  it('carries the disclosure for "No obvious warning signs"', () => {
    const t = buildShareText({ verdict: 'no_obvious_warning_signs', signals: [] });
    expect(t).toContain("SaySafe can't confirm who sent this or whether a payment is real. Check in the official PayPal app.");
  });
  it('maps legacy verdicts', () => expect(buildShareText({ verdict: 'needs_verification', signals: [] })).toContain('Needs checking'));
  it('sanitizer strips IDs, emails, phone numbers and URLs but keeps the SaySafe link', () => {
    const s = sanitizeShareText(`Order 7HG23456KL890123M from a@b.ie, call 00353 1 555 0100, see www.evil.example/x and evil.top and paypal.com.evil.net/login, ${PUBLIC_SAYSAFE_URL}`);
    expect(s).not.toMatch(/7HG23456KL890123M|a@b\.ie|00353|555|evil/);
    expect(s).toContain(PUBLIC_SAYSAFE_URL);
  });
  it('builds a wa.me link with no phone number', () => {
    const u = whatsappUrl('SaySafe check: Suspicious\nhi & bye');
    expect(u.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(u.split('text=')[1])).toBe('SaySafe check: Suspicious\nhi & bye');
  });
});
