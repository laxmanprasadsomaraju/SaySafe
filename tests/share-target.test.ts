import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { combineSharedParams } from '../web/src/lib/shareTarget';

describe('Android share target', () => {
  const m = JSON.parse(fs.readFileSync('web/public/manifest.webmanifest', 'utf8'));
  it('manifest declares a GET share_target to /check/share with title, text and url', () => {
    expect(m.share_target).toEqual({ action: '/check/share', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } });
  });
  it('manifest meets the install basics (name, start_url, standalone, 192 + 512 icons)', () => {
    expect(m.short_name).toBeTruthy(); expect(m.start_url).toBeTruthy(); expect(m.display).toBe('standalone');
    const sizes = m.icons.map((i: any) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const i of m.icons) expect(fs.existsSync(`web/public${i.src}`)).toBe(true);
  });
  it('index.html links the manifest', () => expect(fs.readFileSync('web/index.html', 'utf8')).toContain('rel="manifest" href="/manifest.webmanifest"'));
  it('joins title, text and url without duplicates and strips control characters', () => {
    const p = new URLSearchParams({ title: 'PayPal', text: 'Pay now http://x.example/a\u202E', url: 'http://x.example/a' });
    expect(combineSharedParams(p)).toBe('PayPal\nPay now http://x.example/a');
  });
  it('caps shared text at 8000 characters', () => expect(combineSharedParams(new URLSearchParams({ text: 'a'.repeat(9000) })).length).toBe(8000));
});
