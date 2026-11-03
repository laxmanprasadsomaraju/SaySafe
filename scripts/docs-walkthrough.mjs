// Follows the Judge's Guide (/judges) literally on a LOCAL build with the mock PayPal, typing each step's exact prompt
// and asserting that every button/link label the step names exists where the step says. Run with tsx (it imports
// the guide content from TypeScript):
//   npx tsx scripts/docs-walkthrough.mjs http://127.0.0.1:8792     (mock PayPal on :9999, recorded Channel3 on :9998)
// Also checks that the /judges page itself renders the same 13 steps and prompts. Exit 1 on any failure.
import { chromium } from 'playwright';
import { JUDGE_STEPS } from '../web/src/learn/content.ts';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8792').replace(/\/$/, '');
if (!/127\.0\.0\.1|localhost/.test(BASE)) { console.error('Local only: the PayPal step uses the mock PayPal.'); process.exit(2); }
const MOCK = process.env.MOCK_PAYPAL ?? 'http://127.0.0.1:9999';
const res = []; const ok = (n, pass, info = '') => { res.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${n}${info ? ` — ${info}` : ''}`); };
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
await c.addInitScript(() => localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, mutedByUser: true, autoSpeak: false, rate: 0.95, readAll: false, lang: 'en' })));
const p = await c.newPage();
await p.route('https://www.sandbox.paypal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><title>stub</title><h1>stub</h1></html>' }));
const last = (k) => p.locator(`[data-card="${k}"]`).last();
const ask = async (text, card) => { const n = await p.locator(`[data-card="${card}"]`).count(); await p.fill('#assistant-input', text); await p.keyboard.press('Enter'); await p.waitForFunction(([k, x]) => document.querySelectorAll(`[data-card="${k}"]`).length > x, [card, n], { timeout: 40000 }); };
const has = async (scope, label) => (await scope.getByRole('button', { name: label }).count()) + (await scope.getByRole('link', { name: label }).count()) > 0;
const S = JUDGE_STEPS; const step = async (i, fn) => { try { await fn(S[i]); } catch (e) { ok(`step ${i + 1}`, false, e.message.split('\n')[0]); } };

// The page itself
await p.goto(BASE + '/judges', { waitUntil: 'networkidle' });
const steps = await p.locator('ol[aria-label="Judge’s steps"] > li').count();
const prompts = await p.locator('[data-prompt]').allInnerTexts();
ok('/judges shows 13 steps with the exact prompts', steps === 13 && S.filter((s) => s.prompt).every((s) => prompts.includes(s.prompt)), `${steps} steps`);
ok('/judges says the sandbox login is only in the Devpost testing instructions', /only in the Devpost testing instructions/.test(await p.locator('main').innerText()));

let id;
await step(0, async (s) => { await p.goto(BASE + '/'); ok('1 "Try as Mary" on the landing page', await p.locator('button:visible', { hasText: s.ui[0] }).count() > 0); await p.locator('button:visible', { hasText: s.ui[0] }).first().click(); await p.waitForURL(/\/assistant/, { timeout: 60000 }); await p.waitForSelector('#assistant-input'); });
await step(1, async (s) => { await ask(s.prompt, 'payment_matches'); const t = await last('payment_matches').innerText(); ok('2 €120 prompt → possible matches labelled Sample data, not proof', /Sample data/.test(t) && /proof/i.test(await p.locator('main').innerText())); });
await step(2, async (s) => { await p.fill('#assistant-input', s.prompt); await p.keyboard.press('Enter'); await p.getByRole('list', { name: 'Shop listings' }).last().waitFor({ timeout: 40000 }); await p.getByRole('list', { name: 'Demo Shop options' }).last().waitFor({ timeout: 20000 }); ok('3 product prompt → real listings + separate Demo Shop offer', true); });
await step(3, async (s) => { await ask(s.prompt, 'payment_prep'); const prep = last('payment_prep'); const t = await prep.innerText(); ok('4 purchase card €120.00 EUR above €75 with "Allow"', /€120\.00 EUR/.test(t) && /€75/.test(t) && await prep.getByRole('button', { name: new RegExp(`^${s.ui[0]}`) }).count() === 1); await prep.getByRole('button', { name: /^Allow/ }).click(); });
await step(4, async (s) => { const f = last('family_status'); await f.getByText('Pending').waitFor({ timeout: 20000 }); id = (await f.locator('a[href^="/order/"]').getAttribute('href')).split('/').pop(); ok('5 "Family review: Pending" + "Try as Alex too"', await has(f, s.ui[0])); await f.getByRole('button', { name: s.ui[0] }).click(); const leave = p.getByRole('button', { name: 'Leave, keep it saved' }); await leave.waitFor({ timeout: 4000 }).then(() => leave.click()).catch(() => {}); await p.waitForURL(/\/family\/assistant/, { timeout: 20000 }); });
await step(5, async (s) => { const r = last('family_review'); await r.waitFor({ timeout: 20000 }); const t = await r.innerText(); ok('6 Alex sees item, amount, expiry and "Approve"', /€120\.00 EUR/.test(t) && /Expires at/.test(t) && await has(r, s.ui[0])); await r.getByRole('button', { name: s.ui[0] }).click(); await r.getByText('Approved').first().waitFor({ timeout: 15000 }); });
await step(6, async (s) => { await p.goto(BASE + '/profile?as=family'); const back = p.getByRole('link', { name: new RegExp(s.ui[0]) }); await back.first().waitFor({ timeout: 15000 }); ok('7a Profile › "Back to Mary"', await back.count() >= 1); await back.first().click(); await p.waitForURL(/\/home/); await p.goto(BASE + '/assistant'); const f = last('family_status'); await f.getByRole('button', { name: s.ui[1] }).waitFor({ timeout: 25000 }); ok('7b same card "Approved" + "Continue to PayPal"', /Approved/.test(await f.innerText())); await f.getByRole('button', { name: s.ui[1] }).click(); await p.waitForURL(/sandbox\.paypal\.com/, { timeout: 30000 }); });
await step(7, async () => { const token = new URL(p.url()).searchParams.get('token'); const ap = await (await fetch(`${MOCK}/mock/approve/${token}`, { method: 'POST' })).json(); await p.goto(ap.returnUrl.replace(/^https?:\/\/[^/]+/, BASE)); ok('8 PayPal approval (MOCK PayPal stands in for the sandbox buyer login)', true); });
await step(8, async () => { await p.getByTestId('order-state').waitFor({ timeout: 30000 }); await p.locator('main').getByText(/Verification pending|Verified — signed/).first().waitFor({ timeout: 30000 }); const t = await p.locator('main').innerText(); ok('9 receipt: Captured, checked with PayPal; webhook pending (mock cannot sign)', /Captured/.test(t) && /checked with PayPal/.test(t) && /Verification pending/.test(t)); });
await step(9, async (s) => { await p.goto(BASE + '/assistant'); await p.waitForSelector('#assistant-input'); await ask(s.prompt, 'receipt'); await ask(s.prompt, 'receipt'); const n = await p.locator('[data-card="receipt"]').count(); ok('10 asking twice → same receipt', n >= 2 && /€120\.00/.test(await last('receipt').innerText())); });
await step(10, async (s) => { await p.goto(BASE + '/activity'); await p.waitForLoadState('networkidle'); ok('11 Activity tab + "Real PayPal Sandbox transaction" label', await p.getByRole('link', { name: s.ui[0] }).count() > 0 && /Real PayPal Sandbox transaction/.test(await p.locator('main').innerText())); });
await step(11, async (s) => { await p.goto(BASE + '/home'); await p.getByRole('link', { name: new RegExp(s.ui[0]) }).first().waitFor({ timeout: 20000 }); ok('12 Home › "View insights"', await p.getByRole('link', { name: new RegExp(s.ui[0]) }).count() === 1); await p.getByRole('link', { name: new RegExp(s.ui[0]) }).click(); await p.waitForURL(/\/insights/); });
await step(12, async (s) => {
  const scams = () => p.locator('[data-card="scam_result"]').count();
  await p.goto(BASE + '/home'); const t = p.getByRole('link', { name: s.ui[0] }); await t.first().waitFor({ timeout: 20000 }); ok('13a Home › "Things to try"', await t.count() >= 1); await t.first().click();
  const w = last('demo_welcome'); await w.waitFor({ timeout: 15000 }); ok('13b welcome card has "Check this suspicious message"', await has(w, s.ui[1])); await w.getByRole('button', { name: s.ui[1] }).click();
  const tr = last('training_examples'); await tr.waitFor({ timeout: 15000 }); let n = await scams(); await tr.getByRole('button', { name: s.ui[2] }).first().click();
  await p.waitForFunction((x) => document.querySelectorAll('[data-card="scam_result"]').length > x, n, { timeout: 40000 }); ok('13c training example → "Suspicious"', /Suspicious/i.test(await last('scam_result').innerText()));
  await p.goto(BASE + '/home'); const cm = p.getByRole('button', { name: new RegExp(s.ui[3]) }); await cm.first().waitFor({ timeout: 15000 }); await cm.first().click(); await p.waitForSelector('#assistant-input');
  n = await scams(); await p.fill('#assistant-input', s.prompt); await p.keyboard.press('Enter'); await p.waitForFunction((x) => document.querySelectorAll('[data-card="scam_result"]').length > x, n, { timeout: 40000 }); ok('13d Home › "Check a message" + pasted prompt → a scam result', true);
});

await b.close();
const failed = res.filter((r) => !r.pass);
console.log(`\n${res.length - failed.length}/${res.length} passed`);
process.exitCode = failed.length ? 1 : 0;
