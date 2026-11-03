// Memory journey, real browser, real UI: Assistant one-time notice (memory ON by default) → Profile → "What SaySafe
// remembers" ON with two labelled Sample preferences, long-term vs recent conversation separate → "I prefer black" →
// real-shop search shows "Shown first because you prefer black and under €150 (sample …)" → a NEW TAB (empty thread)
// → "show me that microwave again" asks which one → "Did I pay for that microwave?" answered from records only →
// Profile: Remove, Clear recent conversation, Clear all memory, turn off → nothing saved → Alex gets 404 → axe.
//
// LOCAL (mock PayPal + RECORDED Channel3 response — test doubles):
//   node scripts/mock-paypal.mjs 9989 &  node scripts/mock-channel3.mjs 9988 &
//   NODE_ENV=production SAYSAFE_ALLOW_EPHEMERAL_DB=true DATABASE_FILE=/tmp/mem/e2e.db PORT=8796 PAYPAL_API_BASE=http://127.0.0.1:9989 \
//     PAYPAL_ALLOW_LIVE=yes PAYPAL_CLIENT_ID=mock PAYPAL_CLIENT_SECRET=mock CHANNEL3_API_BASE=http://127.0.0.1:9988 CHANNEL3_API_KEY=mock npx tsx server/index.ts &
//   OUT=/tmp/mem/e2e node scripts/e2e-memory.mjs http://127.0.0.1:8796
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8796').replace(/\/$/, '');
const OUT = process.env.OUT ?? '/tmp/mem/e2e';
fs.mkdirSync(OUT, { recursive: true });
const results = []; const axeOut = [];
const ok = (n, pass, info = '') => { results.push({ n, pass: Boolean(pass), info: String(info).slice(0, 300) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${n}${info ? ` — ${String(info).slice(0, 200)}` : ''}`); };
const b = await chromium.launch();
const ctx = (w = 390) => b.newContext({ viewport: { width: w, height: w > 1000 ? 900 : 844 } });
const post = (p, url, body, method = 'POST') => p.evaluate(async ([u, x, m]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body, method]);
const get = (p, url) => p.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => ({})) }; }, url);
const axe = async (p, label, include) => {
  let a = new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  if (include) a = a.include(include);
  const r = await a.analyze();
  axeOut.push({ label, violations: r.violations.map((v) => `${v.id}:${v.nodes[0]?.target}`) });
  return r.violations.length;
};
const ask = async (p, text) => { await p.fill('#assistant-input', text); await p.keyboard.press('Enter'); };
const lastReply = (p) => p.locator('[data-role="assistant"]').last();
const waitReply = async (p, re, timeout = 20000) => { await p.waitForFunction(([s, f]) => { const els = document.querySelectorAll('[data-role="assistant"]'); const t = els[els.length - 1]?.textContent ?? ''; return new RegExp(s, f).test(t); }, [re.source, re.flags], { timeout }); return (await lastReply(p).innerText()).replace(/\s+/g, ' '); };

try {
  const mc = await ctx(1440); const m = await mc.newPage();
  await m.goto(BASE + '/'); await m.locator('button:visible', { hasText: 'Try as Mary' }).first().click();
  await m.waitForURL(/\/assistant/, { timeout: 60000 }); await m.waitForSelector('#assistant-input');

  // 1. Assistant, first use: the one-time plain notice (memory is ON by default); gone after a reload.
  const notice = m.getByTestId('memory-notice');
  await notice.waitFor({ timeout: 15000 });
  ok('1 Assistant first use: one-time memory notice', (await notice.innerText()).includes('SaySafe remembers shopping preferences you tell it, like colours or budget. You can see, change or turn this off in Profile.'));
  await m.screenshot({ path: `${OUT}/00-assistant-memory-notice.png` });
  const v0 = await axe(m, 'assistant memory notice', '[data-testid="memory-notice"]');
  ok('1b axe: notice has no violations', v0 === 0, JSON.stringify(axeOut.at(-1)));
  await m.reload(); await m.waitForSelector('#assistant-input'); await m.waitForTimeout(1500);
  ok('1c notice is shown once only (not after reload)', (await notice.count()) === 0);

  // 2. Profile: memory ON by default, two labelled samples, the two parts clearly separate.
  await m.goto(BASE + '/profile');
  const sec = m.locator('[data-testid="memory-section"]'); await sec.waitFor({ timeout: 15000 });
  const sw = m.getByRole('switch', { name: 'Remember my preferences' });
  ok('2 Profile shows "What SaySafe remembers", memory ON by default', (await sw.getAttribute('aria-checked')) === 'true');
  ok('2b two sample preferences, labelled "Sample"', (await m.getByTestId('memory-sample-badge').count()) === 2 && /Prefers the colour black \(sample\)/.test(await sec.innerText()));
  const secText = await sec.innerText();
  ok('2c long-term memory and recent conversation are separate, with retention stated', /Your preferences \(long-term memory\)/.test(secText) && /Recent conversation \(short-term\)/.test(secText) && /last 10 messages and the last 20 products/.test(secText) && /14 days/.test(secText) && /kept even when memory is off/.test(secText));
  await m.getByRole('button', { name: 'Why are results personalised?' }).click();
  ok('2d plain-language "why personalised"', /never remembers health/i.test(await sec.innerText()));
  await sec.scrollIntoViewIfNeeded(); await m.screenshot({ path: `${OUT}/01-profile-memory-default-on.png` });
  const v1 = await axe(m, 'profile memory section (default on)', '[data-testid="memory-section"]');
  ok('3 axe: memory section has no violations', v1 === 0, JSON.stringify(axeOut.at(-1)));

  // 3. Say a preference (replaces the sample colour), then a real-shop search.
  await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input');
  await ask(m, 'I prefer black');
  ok('6 saved: "Got it. I’ll remember that you prefer black"', /remember that you prefer black/i.test(await waitReply(m, /remember/i)));
  await ask(m, 'show me real shops for a microwave');
  const withWhy = await waitReply(m, /Shown first because you prefer black/, 30000);
  ok('7 search results say why: "Shown first because you prefer black … under €150 (sample …)" + how to ignore', /ignore my preferences/.test(withWhy) && /under €150/.test(withWhy), withWhy.slice(0, 260));
  await m.locator('[data-card="product_cards"]').last().scrollIntoViewIfNeeded(); await m.screenshot({ path: `${OUT}/02-personalised-results.png` });

  // 5. New tab = empty thread (sessionStorage is per tab); the server still has the context.
  const t2 = await mc.newPage(); await t2.goto(BASE + '/assistant'); await t2.waitForSelector('#assistant-input');
  await ask(t2, 'show me that microwave again');
  const clar = await waitReply(t2, /Which one do you mean/);
  const cards = await t2.locator('[data-card="product_cards"]').last().locator('article, li').count().catch(() => 0);
  ok('8 new tab: "that microwave" → clarification with the products shown before', /Which one do you mean/.test(clar), `${clar.slice(0, 160)} (items ${cards})`);
  await t2.screenshot({ path: `${OUT}/03-new-tab-clarification.png` });
  await ask(t2, 'Did I pay for that microwave?');
  const paid = await waitReply(t2, /payment record|records/i);
  // Try as Mary seeds an illustrative Currys microwave record, so the answer must come from THAT record, labelled
  // as sample data, and say it is from records, not from the conversation. (No record -> "We talked about…".)
  ok('9 "Did I pay for that microwave?" → answered from records only, labelled, conversation never proof', (/Sample data/.test(paid) && /comes from your payment records, not from our conversation/.test(paid)) || /We talked about .+ but I have no payment record for it/.test(paid), paid.slice(0, 260));
  await t2.screenshot({ path: `${OUT}/04-did-i-pay-that-microwave.png` });

  // 6. Profile lists it; Remove; Clear recent conversation; Clear all memory; turn off -> nothing saved.
  await m.goto(BASE + '/profile'); await sec.waitFor();
  await m.waitForFunction(() => /Prefers the colour black(?! \(sample)/.test(document.querySelector('[data-testid="memory-section"]')?.textContent ?? ''));
  ok('10 Profile lists "Prefers the colour black" (you typed it) and the sample budget', /you typed it/.test(await sec.innerText()) && /Usual budget: up to €150 \(sample\)/.test(await sec.innerText()));
  await sec.scrollIntoViewIfNeeded(); await m.screenshot({ path: `${OUT}/05-profile-memory-list.png` });
  const v2 = await axe(m, 'profile memory section (list)', '[data-testid="memory-section"]');
  ok('11 axe: list state has no violations', v2 === 0, JSON.stringify(axeOut.at(-1)));
  await m.getByRole('button', { name: 'Remove Prefers the colour black', exact: true }).click();
  await m.waitForFunction(() => !/Prefers the colour black/.test(document.querySelector('[data-testid="memory-section"]')?.textContent ?? ''));
  ok('12 Remove works', true);
  await m.getByRole('button', { name: 'Clear recent conversation' }).click();
  await m.waitForFunction(() => /Now: nothing yet/.test(document.querySelector('[data-testid="memory-section"]')?.textContent ?? ''));
  ok('12b Clear recent conversation clears context, keeps preferences', /Usual budget: up to €150/.test(await sec.innerText()));
  await m.getByRole('button', { name: 'Clear all memory' }).click(); await m.getByRole('button', { name: 'Yes, clear all' }).click();
  await m.waitForFunction(() => /Nothing saved yet/.test(document.querySelector('[data-testid="memory-section"]')?.textContent ?? ''));
  ok('13 Clear all memory clears every item', true);
  await sw.click();
  await m.waitForFunction(() => document.querySelector('[role="switch"][aria-labelledby="mem-on-l"]')?.getAttribute('aria-checked') === 'false');
  ok('13b turned off: the Profile says what is still kept', /recent conversation below is still kept/i.test(await sec.innerText()));
  await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input');
  await ask(m, 'I prefer red');
  ok('13c memory off: offers to turn it on, saves nothing', /memory is off/i.test(await waitReply(m, /memory is off/i)));
  const after = await get(m, '/api/memory');
  ok('13d nothing saved while off', after.body.enabled === false && after.body.items.length === 0, JSON.stringify(after.body.items));

  // 7. Alex: a family-only session gets 404 on Mary's memory.
  const r = await post(m, '/api/demo/alex', {});
  const fam = (await mc.cookies()).find((c) => c.name === 'ss_family');
  const ac = await ctx(390); await ac.addCookies([fam]); const a = await ac.newPage(); await a.goto(BASE + '/');
  const g = await get(a, '/api/memory');
  ok('14 Alex (family session) → 404 on /api/memory', r.status === 200 && g.status === 404, `alex=${r.status} memory=${g.status}`);
  await ac.close();

  // 8. 390px Profile screenshot + axe.
  const sc = await ctx(390); const s = await sc.newPage(); await sc.addCookies((await mc.cookies()).filter((c) => c.name === 'ss_elder'));
  await s.goto(BASE + '/profile'); await s.locator('[data-testid="memory-section"]').waitFor();
  await s.locator('[data-testid="memory-section"]').scrollIntoViewIfNeeded(); await s.screenshot({ path: `${OUT}/06-profile-memory-390.png` });
  const overflow = await s.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  const v3 = await axe(s, 'profile 390', '[data-testid="memory-section"]');
  ok('15 390px: no horizontal overflow, axe 0', !overflow && v3 === 0, JSON.stringify(axeOut.at(-1)));
} catch (e) {
  ok('journey threw', false, e?.stack ?? e);
} finally {
  await b.close();
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), results, axe: axeOut }, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
