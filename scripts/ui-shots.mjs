// UI audit screenshots: every main page and key Assistant cards as "Try as Mary" (and Alex), at
// 320/375/390/768/1024/1280/1440 px. One session drives the data; each page is then captured at every width
// by resizing the viewport (so AI-backed results are produced once, not seven times).
//   node scripts/ui-shots.mjs [base]        OUT=dir WIDTHS=390,1440 ONLY=profile,home
// Hosted: goes through HTTPS_PROXY and paces AI calls (≤10/min). Writes $OUT/<page>-<width>.png and $OUT/layout.json
// (horizontal overflow + small targets per page/width).
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const OUT = process.env.OUT ?? '/tmp/ui-shots';
const WIDTHS = (process.env.WIDTHS ?? '320,375,390,768,1024,1280,1440').split(',').map(Number);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const HOSTED = !/127\.0\.0\.1|localhost/.test(BASE);
fs.mkdirSync(OUT, { recursive: true });
const px = process.env.HTTPS_PROXY || process.env.https_proxy;
let proxy;
if (px && HOSTED) { const u = new URL(px); proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined }; }
const b = await chromium.launch(proxy ? { proxy } : {});
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await ctx.addInitScript(() => localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, mutedByUser: true, autoSpeak: true, rate: 0.95, readAll: false, lang: 'en' })));
const p = await ctx.newPage();
await p.route('https://www.sandbox.paypal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><title>PayPal stub</title><h1>PayPal (stub)</h1></html>' }));
const layout = [];
const want = (name) => !ONLY || ONLY.has(name);
const post = (url, body) => p.evaluate(async ([u, x]) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body]);
let lastAi = 0;
const pace = async () => { if (!HOSTED) return; const wait = lastAi + 6500 - Date.now(); if (wait > 0) await p.waitForTimeout(wait); lastAi = Date.now(); };

async function capture(name) {
  if (!want(name)) return;
  for (const w of WIDTHS) {
    await p.setViewportSize({ width: w, height: w < 768 ? 844 : 900 });
    await p.waitForTimeout(350);
    const lay = await p.evaluate(() => {
      const W = document.documentElement.clientWidth;
      const small = [...document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="switch"]')].filter((e) => {
        const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false;
        if (e.tagName === 'A' && getComputedStyle(e).display === 'inline') return false;
        if (e.closest('.sr-only') || e.matches('.sr-only, .skip-link') || r.right < 0 || e.tabIndex < 0) return false; // visually hidden / off-screen skip link
        if (e.matches('input[type="checkbox"], input[type="radio"]') && e.closest('label')) return false; // the label is the target
        return r.height < 44 || r.width < 44;
      }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 30));
      const clipped = [...document.querySelectorAll('main *')].filter((e) => e.scrollWidth > e.clientWidth + 2 && ['hidden', 'clip'].includes(getComputedStyle(e).overflowX) && e.clientWidth > 0 && !e.classList.contains('truncate') && !e.closest('.sr-only')).length;
      return { overflow: document.documentElement.scrollWidth > W + 1, scrollWidth: document.documentElement.scrollWidth, small, clipped, height: document.documentElement.scrollHeight };
    });
    layout.push({ page: name, width: w, ...lay });
    // Full-page capture: sticky header and fixed bottom bar are laid out in flow so they don't repeat mid-image.
    const st = await p.addStyleTag({ content: 'header.sticky{position:static!important}[data-testid="bottom-stack"]{position:static!important}div[style*="--stack-h"]{padding-bottom:0!important}' });
    await p.waitForTimeout(100);
    await p.screenshot({ path: `${OUT}/${name}-${w}.png`, fullPage: true });
    await st.evaluate((e) => e.remove());
  }
  await p.setViewportSize({ width: 1440, height: 900 });
  console.log('captured', name);
}
const go = async (path) => { await p.goto(BASE + path); await p.waitForLoadState('networkidle'); await p.waitForTimeout(500); };
const last = (kind) => p.locator(`[data-card="${kind}"]`).last();
async function say(text, kind, ai = false) {
  if (ai) await pace(); else await p.waitForTimeout(HOSTED ? 1500 : 300);
  await p.fill('#assistant-input', text); await p.keyboard.press('Enter');
  if (kind) await last(kind).waitFor({ timeout: 45000 }); else await p.waitForTimeout(2500);
  await p.waitForTimeout(500);
}
const safe = async (label, fn) => { try { await fn(); } catch (e) { console.log('SKIP', label, String(e?.message ?? e).split('\n')[0].slice(0, 160)); } };

// Landing (signed out)
await go('/'); await capture('landing');
// Try as Mary -> Assistant welcome
await p.getByRole('button', { name: /^Try as Mary/ }).first().click();
await p.waitForURL('**/assistant'); await last('demo_welcome').waitFor({ timeout: 30000 });
await go('/home'); await capture('home');
await go('/activity'); await capture('activity');
await go('/profile'); await capture('profile');
await go('/help'); await capture('help');
// Scam result (Check page, one AI call)
await safe('scam', async () => {
  if (!want('scam-result')) return;
  await go('/check'); await pace();
  await p.getByRole('button', { name: /Account suspended|invoice/i }).first().click();
  await p.getByText(/Suspicious|Needs checking|Be careful/).first().waitFor({ timeout: 45000 }); await p.waitForTimeout(800);
  await capture('scam-result');
});
// Product results (Discover / Shop)
await safe('products', async () => {
  if (!want('product-results')) return;
  await go('/discover'); await pace();
  const box = p.locator('#dq');
  await box.fill('kettle under €60'); await p.keyboard.press('Enter');
  await p.waitForTimeout(12000);
  await capture('product-results');
});
// Assistant thread with cards (rules-answered questions cost no AI call)
await safe('assistant', async () => {
  await go('/assistant');
  await p.getByRole('button', { name: /^Menu/ }).click(); await p.getByRole('button', { name: 'New conversation' }).click(); await p.waitForTimeout(800);
  await say('Show my last payment', 'last_payment');
  await say('Show my subscriptions', 'subscriptions_list');
  await say('Show my contacts', 'contact_card');
  await capture('assistant-cards');
  await say('Cancel my streaming subscription', 'subscription_help');
  await say('Did I already pay John €80?', 'payment_matches');
  await capture('assistant-records');
});
await safe('payment card', async () => {
  if (!want('assistant-payment')) return;
  await go('/assistant');
  await p.getByRole('button', { name: /^Menu/ }).click(); await p.getByRole('button', { name: 'New conversation' }).click(); await p.waitForTimeout(800);
  await say('I need a microwave', 'product_cards', true);
  await p.getByRole('list', { name: 'Demo Shop options' }).last().getByRole('button').first().click();
  await p.getByRole('button', { name: /Prepare PayPal Sandbox payment/ }).click();
  await last('payment_prep').waitFor({ timeout: 20000 }); await p.waitForTimeout(600);
  await capture('assistant-payment');
});
// Order waiting for family (server request over the €75 limit)
let pending = null;
await safe('order', async () => {
  const big = await post('/api/payments', { items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: 'ui-shots-' + Date.now() });
  pending = big.body.request?.id;
  if (pending) { await go(`/order/${pending}`); await capture('order-waiting'); }
});
// Receipt. LOCAL only: a real capture through the MOCK PayPal (scripts/local-stack.sh), clearly not PayPal itself.
await safe('receipt-local', async () => {
  if (HOSTED || !want('receipt')) return;
  const r = await post('/api/payments', { items: [{ productId: 'kettle-classic', quantity: 1 }], idempotencyKey: 'ui-rcpt-' + Date.now() });
  const co = await post(`/api/payments/${r.body.request.id}/checkout`, {});
  const url = co.body.approveUrl ?? co.body.url ?? co.body.redirectUrl;
  const token = new URL(url).searchParams.get('token');
  const ap = await (await fetch(`http://127.0.0.1:9999/mock/approve/${token}`, { method: 'POST' })).json();
  await p.goto(ap.returnUrl.replace(/^https?:\/\/[^/]+/, BASE));
  await p.getByTestId('order-state').waitFor({ timeout: 25000 }); await p.waitForTimeout(800);
  await capture('receipt');
});
// Receipt (hosted): a captured order linked from Activity, if any
await safe('receipt', async () => {
  if (!HOSTED || !want('receipt')) return;
  await go('/activity');
  const hrefs = await p.locator('a[href^="/order/"]').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.closest('li')?.textContent ?? a.textContent]));
  const paid = hrefs.find(([, t]) => /paid|captured|receipt/i.test(t ?? '')) ?? hrefs.find(([h]) => !h.endsWith(pending ?? '__'));
  if (paid) { await go(paid[0]); await capture('receipt'); } else console.log('SKIP receipt: no order links');
});
// Alex (family)
await safe('alex', async () => {
  await go('/profile'); await p.getByTestId('try-as-alex').click(); await p.waitForURL('**/family/assistant');
  await last('family_review').waitFor({ timeout: 20000 }).catch(() => {}); await p.waitForTimeout(800);
  await capture('family-review');
  await go('/family'); await capture('family-home');
  await go('/family/insights'); await p.waitForTimeout(1500); await capture('family-insights');
  await go('/profile?as=family'); await capture('family-profile');
});
fs.writeFileSync(`${OUT}/layout.json`, JSON.stringify(layout, null, 1));
const bad = layout.filter((l) => l.overflow || l.small.length || l.clipped);
console.log('pages x widths', layout.length, 'with overflow', layout.filter((l) => l.overflow).length, 'with small targets', layout.filter((l) => l.small.length).length);
for (const l of bad) console.log(`${l.page}@${l.width}: overflow=${l.overflow}${l.overflow ? `(${l.scrollWidth})` : ''} small=${l.small.length}${l.small.length ? ' [' + [...new Set(l.small)].slice(0, 4).join(' | ') + ']' : ''} clipped=${l.clipped}`);
await b.close();
