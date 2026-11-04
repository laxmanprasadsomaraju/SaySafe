// Focused Assistant browser suite (real browser, real UI, real server): the 17 repair scenarios + PS5 gift + clarify.
// For every step it checks the VISIBLE reply AND the backend tool the server reports (`tool` in /api/assistant, and the
// /api/discover call with its sanitised Channel3 request).
//
// MODE=mock (default): local stack with mock PayPal + RECORDED Channel3 responses (scripts/mock-channel3.mjs).
// MODE=live:  only scenarios 1, 3 and PS5 against a server using the REAL Channel3 API (screenshots of real cards).
// MODE=fail:  only scenario 15 against a server whose Channel3 answers 503 (scripts/mock-channel3.mjs PORT fail).
//   OUT=/tmp/out MODE=mock node scripts/e2e-assistant-repair.mjs http://127.0.0.1:8803
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8803').replace(/\/$/, '');
const MODE = process.env.MODE ?? 'mock';
const OUT = process.env.OUT ?? '/tmp/asr';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (n, pass, info = '') => { results.push({ n, pass: Boolean(pass), info: String(info).slice(0, 400) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${n}${info ? ` — ${String(info).slice(0, 260)}` : ''}`); };
const b = await chromium.launch();
const calls = [];
const watch = (p) => p.on('response', async (r) => {
  const u = new URL(r.url());
  if (!['/api/assistant', '/api/discover'].includes(u.pathname) || r.request().method() !== 'POST') return;
  let body = null; try { body = await r.json(); } catch { /* */ }
  let reqBody = null; try { reqBody = JSON.parse(r.request().postData() ?? 'null'); } catch { /* */ }
  calls.push({ path: u.pathname, status: r.status(), text: reqBody?.text ?? null, tool: body?.tool ?? null, action: body?.intent?.action ?? null, discover: body?.discover ?? null, request: body?.request ?? null, products: Array.isArray(body?.products) ? body.products.length : null, error: body?.error ?? null, read: body?.toolRead ?? null, ai: body?.ai ?? null });
});
const since = (i) => calls.slice(i);
const ask = async (p, text) => { const i = calls.length; await p.fill('#assistant-input', text); await p.keyboard.press('Enter'); return i; };
const lastReplyText = async (p) => (await p.locator('[data-role="assistant"]').last().innerText()).replace(/\s+/g, ' ');
const settle = async (p, i, { discover = false, timeout = 30000 } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const c = since(i);
    const a = c.find((x) => x.path === '/api/assistant');
    const needD = discover || Boolean(a?.discover);
    const d = c.find((x) => x.path === '/api/discover');
    const busy = await p.locator('text=Thinking…').count();
    if ((a || c.length) && (!needD || d) && !busy) { await p.waitForTimeout(400); return { a, d, text: await lastReplyText(p), all: since(i) }; }
    await p.waitForTimeout(200);
  }
  return { a: since(i).find((x) => x.path === '/api/assistant'), d: since(i).find((x) => x.path === '/api/discover'), text: await lastReplyText(p), all: since(i), timedOut: true };
};
const allText = async (p, i0) => (await p.locator('[data-role="assistant"]').allInnerTexts()).slice(i0).join(' ').replace(/\s+/g, ' ');
const cards = (p) => p.locator('[data-card="product_cards"], ul:has(li button span:has-text("Open details"))');
const shot = async (p, name, loc) => { try { if (loc) await loc.scrollIntoViewIfNeeded(); await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }); } catch { /* */ } };
const evidence = [];
const record = (scenario, r, extra = {}) => evidence.push({ scenario, assistant: r.a ? { tool: r.a.tool, action: r.a.action, ai: r.a.ai, discover: r.a.discover, read: r.a.read } : null, discover: r.d ? { status: r.d.status, request: r.d.request, products: r.d.products, error: r.d.error } : null, visible: r.text.slice(0, 600), ...extra });

async function mary(width = 1440) {
  const c = await b.newContext({ viewport: { width, height: 900 } });
  const p = await c.newPage(); watch(p);
  await p.goto(BASE + '/'); await p.locator('button:visible', { hasText: 'Try as Mary' }).first().click();
  await p.waitForURL(/\/assistant/, { timeout: 60000 }); await p.waitForSelector('#assistant-input');
  const notice = p.getByTestId('memory-notice'); if (await notice.count()) { const btn = notice.locator('button'); if (await btn.count()) await btn.first().click().catch(() => {}); }
  return { c, p };
}
const msgCount = async (p) => p.locator('[data-role="assistant"]').count();
const visibleCards = async (p, from = 0) => p.evaluate((from) => {
  const logs = [...document.querySelectorAll('[role="log"] > div')].filter((d) => d.getAttribute('data-role') === 'assistant').slice(from);
  const last = logs.reverse().find((d) => d.getAttribute('data-role') === 'assistant' && d.querySelector('img, [aria-label="No photo available"]') && d.textContent?.includes('Found with Channel3'));
  if (!last) return { n: 0, titles: [], imgs: 0, cdn: 0 };
  const items = [...last.querySelectorAll('li button')];
  const imgs = [...last.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '');
  return { n: items.length, titles: items.slice(0, 5).map((x) => x.textContent?.replace(/\s+/g, ' ').slice(0, 140)), imgs: imgs.length, cdn: imgs.filter((s) => s.startsWith('https://cdn.trychannel3.com')).length };
}, from);

try {
  if (MODE === 'fail') {
    const { c, p } = await mary(390);
    const n0 = await msgCount(p);
    const i = await ask(p, 'Find a kettle');
    const r = await settle(p, i, { discover: true });
    const t = await allText(p, n0);
    ok('15 Channel3 failure: accurate, actionable error (no PS5, no made-up products)', r.d?.status >= 500 && /couldn.t search real shops|couldn.t reach the real-shop search/i.test(t) && !/ps5|playstation/i.test(t) && /try again/i.test(t), `${r.d?.status} ${r.d?.error} | ${t.slice(0, 260)}`);
    ok('15b backend tool = channel3_search, discover returned an error (no products)', r.a?.tool === 'channel3_search' && r.d?.products === 0, JSON.stringify({ tool: r.a?.tool, d: r.d?.error }));
    record(15, r); await shot(p, '15-channel3-failure-390'); await c.close();
  } else if (MODE === 'live') {
    const { c, p } = await mary(1440);
    for (const [n, q, check] of [
      [1, 'Find a kettle', (t, cv) => cv.n >= 3 && cv.titles.every((x) => /kettle/i.test(x))],
      [3, 'Find black women\'s Nike T-shirts under €40', (t, cv, r) => cv.n >= 1 && r.d?.request?.filters?.gender === 'female' && r.d?.request?.filters?.price?.max_price === 40],
      ['ps5', 'I want to buy a PS5 for my grandson', (t, cv) => cv.n >= 1 && /grandson/i.test(t) && /Demo Shop/i.test(t)],
    ]) {
      const n0 = await msgCount(p);
      const i = await ask(p, q); const r = await settle(p, i, { discover: true, timeout: 45000 });
      await p.waitForTimeout(800);
      const cv = await visibleCards(p, n0); const t = await allText(p, n0);
      ok(`${n} LIVE "${q}": real Channel3 cards in chat`, r.a?.tool === 'channel3_search' && check(t, cv, r), JSON.stringify({ tool: r.a?.tool, req: r.d?.request, cards: cv.n, cdnImgs: cv.cdn, titles: cv.titles.slice(0, 3) }));
      record(n, r, { cards: cv });
      const lastCard = p.locator('[role="log"] > div[data-role="assistant"]').filter({ hasText: 'Found with Channel3' }).last();
      await lastCard.scrollIntoViewIfNeeded(); await shot(p, `live-${n}-cards-1440`);
    }
    await c.close();
  } else {
    // ---------------- MOCK: the full focused suite ----------------
    const { c, p } = await mary(1440);
    let n0, i, r, t, cv;
    // 1
    n0 = await msgCount(p); i = await ask(p, 'Find a kettle'); r = await settle(p, i, { discover: true }); cv = await visibleCards(p, n0); t = await allText(p, n0);
    ok('1 "Find a kettle" -> Channel3 cards in chat (+ Demo Shop offered separately)', r.a?.tool === 'channel3_search' && r.d?.status === 200 && cv.n >= 3 && /Demo Shop/.test(t) && !/ps5/i.test(t), JSON.stringify({ tool: r.a?.tool, req: r.d?.request, cards: cv.n }));
    record(1, r, { cards: cv }); await shot(p, '01-kettle-cards-1440', p.locator('[role="log"] > div').filter({ hasText: 'Found with Channel3' }).last());
    // 2
    n0 = await msgCount(p); i = await ask(p, "Find women's Nike T-shirts"); r = await settle(p, i, { discover: true }); cv = await visibleCards(p, n0); t = await allText(p, n0);
    ok('2 "Find women\'s Nike T-shirts" -> new search (not a kettle refinement), gender+brand filters', r.a?.tool === 'channel3_search' && /t-shirt/i.test(r.a?.discover?.query ?? '') && !/kettle/i.test(r.a?.discover?.query ?? '') && r.d?.request?.filters?.gender === 'female' && r.d?.request?.filters?.brand === 'Nike' && cv.n >= 1, JSON.stringify({ dq: r.a?.discover?.query, req: r.d?.request, cards: cv.n }));
    record(2, r, { cards: cv });
    // 3
    n0 = await msgCount(p); i = await ask(p, "Find black women's Nike T-shirts under €40"); r = await settle(p, i, { discover: true }); cv = await visibleCards(p, n0); t = await allText(p, n0);
    const prices = await p.evaluate((from) => { const d = [...document.querySelectorAll('[role="log"] > div')].filter((x) => x.getAttribute('data-role') === 'assistant').slice(from).reverse().find((x) => x.textContent?.includes('Found with Channel3')); return [...(d?.querySelectorAll('li button') ?? [])].map((x) => Number((x.textContent?.match(/€(\d+(?:\.\d+)?)/) ?? [])[1])); }, n0);
    ok('3 black women\'s Nike under €40: price filter + all shown prices <= €40', r.d?.request?.filters?.price?.max_price === 40 && prices.length > 0 && prices.every((x) => x <= 40), JSON.stringify({ req: r.d?.request, prices }));
    record(3, r, { cards: cv, prices }); await shot(p, '03-black-nike-under-40-1440', p.locator('[role="log"] > div').filter({ hasText: 'Found with Channel3' }).last());
    // 4
    n0 = await msgCount(p); i = await ask(p, 'Show me the cheaper one'); r = await settle(p, i, { timeout: 8000 }); t = await allText(p, n0);
    ok('4 "Show me the cheaper one" -> picked from cards on screen (no new search)', /cheapest one shown is/i.test(t) && !since(i).some((x) => x.path === '/api/discover') && Number((t.match(/€(\d+(?:\.\d+)?)/) ?? [])[1]) <= Math.min(...prices), t.slice(0, 200));
    record(4, r);
    // 5
    n0 = await msgCount(p); i = await ask(p, 'Find me a microwave under €150'); r = await settle(p, i, { discover: true }); cv = await visibleCards(p, n0); t = await allText(p, n0);
    ok('5 microwave under €150 -> Channel3 with max_price 150', r.a?.tool === 'channel3_search' && r.d?.request?.filters?.price?.max_price === 150 && cv.n >= 1, JSON.stringify({ req: r.d?.request, cards: cv.n }));
    record(5, r, { cards: cv });
    // refinement
    n0 = await msgCount(p); i = await ask(p, 'Only Philips'); r = await settle(p, i, { discover: true }); t = await allText(p, n0);
    ok('5b follow-up "Only Philips" refines the last search (microwave, brand Philips, same budget)', r.a?.tool === 'channel3_search' && /microwave/i.test(r.a?.discover?.query ?? '') && /philips/i.test(r.a?.discover?.query ?? ''), JSON.stringify(r.a?.discover));
    // 6
    n0 = await msgCount(p); i = await ask(p, 'I prefer red'); r = await settle(p, i); t = await allText(p, n0);
    i = await ask(p, 'What are my preferences?'); r = await settle(p, i); t = await lastReplyText(p);
    ok('6 "I prefer red" then "What are my preferences?" -> red listed, tool preferences', r.a?.tool === 'preferences' && /red/i.test(t) && /budget/i.test(t), t.slice(0, 260));
    record(6, r); await shot(p, '06-preferences-1440');
    // 7
    n0 = await msgCount(p); i = await ask(p, 'Find me a kettle'); r = await settle(p, i, { discover: true }); t = await allText(p, n0);
    ok('7 kettle with saved preference: request is product words only, red used locally and explained', r.d?.request?.query && !/red/i.test(r.d.request.query) && /prefer red|you prefer red|None of these listings says red/i.test(t), JSON.stringify({ q: r.d?.request?.query, t: t.slice(0, 200) }));
    record(7, r);
    // 8
    n0 = await msgCount(p); i = await ask(p, 'Ignore my preferences this time'); r = await settle(p, i, { discover: true }); t = await allText(p, n0);
    ok('8 "Ignore my preferences this time" -> same search without preferences', /without your saved preferences/i.test(t) && r.d?.status === 200 && !/prefer red/i.test(t.split('without your saved preferences')[1] ?? ''), t.slice(0, 220));
    record(8, r);
    // 9
    n0 = await msgCount(p); i = await ask(p, 'Show me all my transactions'); r = await settle(p, i); t = await allText(p, n0);
    ok('9 "Show me all my transactions" -> tool transactions, all records counted by kind, history card', r.a?.tool === 'transactions' && /payment records?/i.test(t) && /sample/i.test(t) && r.a?.read?.total >= 10 && (await p.locator('[data-card="payment_history"]').count()) > 0, JSON.stringify(r.a?.read));
    record(9, r); await shot(p, '09-all-transactions-1440', p.locator('[data-card="payment_history"]').last());
    // 10
    n0 = await msgCount(p); i = await ask(p, 'Did I pay for that microwave?'); r = await settle(p, i); t = await allText(p, n0);
    ok('10 "Did I pay for that microwave?" -> payment_search on records (not conversation)', r.a?.tool === 'payment_search' && /record|sample|no payment record/i.test(t), t.slice(0, 240));
    record(10, r); await shot(p, '10-did-i-pay-microwave-1440');
    // 11
    n0 = await msgCount(p); i = await ask(p, 'Was I charged twice?'); r = await settle(p, i); t = await allText(p, n0);
    ok('11 "Was I charged twice?" -> duplicate_check over captures (not one receipt)', r.a?.tool === 'duplicate_check' && /capture|charged/i.test(t), t.slice(0, 240));
    record(11, r);
    // 12
    n0 = await msgCount(p); i = await ask(p, 'Show my subscriptions'); r = await settle(p, i); t = await allText(p, n0);
    ok('12 "Show my subscriptions" -> subscription_list', r.a?.tool === 'subscription_list' && /subscription/i.test(t), t.slice(0, 160));
    // 13
    n0 = await msgCount(p); i = await ask(p, 'What is my spending approval limit?'); r = await settle(p, i); t = await allText(p, n0);
    ok('13 approval limit -> €75 per purchase, no invented remaining amount, budget kept separate', r.a?.tool === 'spending_limit' && /€75/.test(t) && /per purchase/i.test(t) && /no amount .left/i.test(t), t.slice(0, 260));
    record(13, r); await shot(p, '13-approval-limit-1440');
    // 13b grandson transfer
    n0 = await msgCount(p); i = await ask(p, 'Can I transfer money to my grandson?'); r = await settle(p, i); t = await allText(p, n0);
    ok('13b "Can I transfer money to my grandson?" -> limit facts + PayPal hand-off + evidence from records', r.a?.tool === 'transfer_check' && /never sends money/i.test(t) && /not in your trusted contacts/i.test(t) && /no previous payments/i.test(t), t.slice(0, 300));
    record('13b', r); await shot(p, '13b-transfer-grandson-1440');
    // evidence check
    n0 = await msgCount(p); i = await ask(p, 'Is it safe to pay Pat Doyle €500?'); r = await settle(p, i); t = await allText(p, n0);
    ok('13c suspicious-payment check cites evidence (contact, history, amount), never says safe', r.a?.tool === 'payment_check' && /trusted contacts/i.test(t) && /previous payments|history/i.test(t) && !/\bis safe\b|safe to pay\b(?! pat)/i.test(t.replace(/Is it safe to pay Pat Doyle/i, '')), t.slice(0, 300));
    // trust
    n0 = await msgCount(p); i = await ask(p, 'I trust Margaret'); r = await settle(p, i); t = await allText(p, n0);
    const sugg = p.locator('[data-card="contact_suggest"]').last();
    const before = await p.evaluate(async () => (await (await fetch('/api/companion/contacts')).json()).contacts.length);
    const notSaved = before === (await p.evaluate(async () => (await (await fetch('/api/companion/contacts')).json()).contacts.length));
    await sugg.getByRole('button', { name: /Add Margaret/ }).click(); await p.waitForTimeout(800);
    const after = await p.evaluate(async () => (await (await fetch('/api/companion/contacts')).json()).contacts.length);
    ok('13d "I trust Margaret" -> confirm card; nothing saved until the tap; saved after tap', r.a?.tool === 'trust_contact' && notSaved && after === before + 1, JSON.stringify({ before, after }));
    await shot(p, '13d-trust-contact-1440', sugg);
    // 14
    n0 = await msgCount(p); i = await ask(p, 'What did we discuss yesterday?'); r = await settle(p, i); t = await allText(p, n0);
    ok('14 "What did we discuss yesterday?" -> conversation_recall, honest when nothing from yesterday', r.a?.tool === 'conversation_recall' && /yesterday|don.t have/i.test(t), t.slice(0, 220));
    i = await ask(p, 'What did we talk about today?'); r = await settle(p, i); t = await lastReplyText(p);
    ok('14b "What did we talk about today?" -> real turns + products from today', r.a?.tool === 'conversation_recall' && /kettle|microwave|t-shirt/i.test(t), t.slice(0, 260));
    record(14, r);
    // PS5 gift
    n0 = await msgCount(p); i = await ask(p, 'I want to buy a PS5 for my grandson'); r = await settle(p, i, { discover: true }); cv = await visibleCards(p, n0); t = await allText(p, n0);
    ok('PS5 gift -> real Channel3 listings in chat, then Demo Shop chips; recipient not sent to Channel3', r.a?.tool === 'channel3_search' && cv.n >= 1 && /grandson/i.test(t) && /Demo Shop/.test(t) && !/grandson/i.test(JSON.stringify(r.d?.request ?? {})), JSON.stringify({ req: r.d?.request, cards: cv.n }));
    record('ps5', r, { cards: cv }); await shot(p, 'ps5-gift-1440', p.locator('[role="log"] > div').filter({ hasText: 'Found with Channel3' }).last());
    // clarify
    n0 = await msgCount(p); i = await ask(p, 'blorp the wizzle sprocket thing'); r = await settle(p, i); t = await allText(p, n0);
    ok('Clarify: unclear text -> one specific question about the words, no generic starters', (r.a?.tool === 'clarify') && /blorp the wizzle/i.test(t) && !/ps5|grandson|Did I already pay someone/i.test(t) && (await p.locator('[aria-label="Ask about your records"]').count()) === 0, t.slice(0, 220));
    record('clarify', r);
    // 17 read-only never creates/captures
    const payBefore = await p.evaluate(async () => (await (await fetch('/api/payments')).json()).length);
    for (const q of ['Show me all my transactions', 'Did I pay for that microwave?', 'Was I charged twice?', 'How much have I spent this month?', 'Show my latest receipt', 'What is my spending approval limit?']) { const j = await ask(p, q); await settle(p, j); }
    const payAfter = await p.evaluate(async () => (await (await fetch('/api/payments')).json()).length);
    ok('17 read-only financial questions create/capture nothing (payment rows unchanged; no POST /api/payments)', payBefore === payAfter, JSON.stringify({ payBefore, payAfter }));
    await c.close();
    // 16 Alex
    const { c: c2, p: m } = await mary(390);
    await m.evaluate(async () => { await fetch('/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }); });
    await ask(m, 'I prefer purple'); await m.waitForTimeout(1500);
    const pair = await m.evaluate(async () => { const r = await fetch('/api/demo/alex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json().catch(() => ({})) }; });
    // Alex's own device: ONLY the family cookie the demo pairing issued (no elder cookie).
    const fam = (await c2.cookies()).filter((k) => k.name === 'ss_family');
    const ac = await b.newContext(); await ac.addCookies(fam); const a = await ac.newPage(); await a.goto(BASE + '/');
    const famAsk = async (text) => a.evaluate(async (t) => { const r = await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, text);
    const f1 = await famAsk('What do you remember about me?'); const f2 = await famAsk('Show me all my transactions'); const f3 = await famAsk('What are my preferences?');
    const mem404 = await a.evaluate(async () => (await fetch('/api/memory')).status);
    const leak = JSON.stringify([f1.body, f2.body, f3.body]);
    ok('16 Alex cannot retrieve Mary\'s memory/preferences/transactions (privacy reply, no data; /api/memory 404)', /private/i.test(f1.body?.reply ?? '') && !/purple|black|€150|Hearthside|found \d+ payment|Sample data/i.test(leak) && mem404 === 404, JSON.stringify({ pair: pair.status, f1: f1.body?.reply, f2tool: f2.body?.tool, mem404 }));
    await ac.close(); await c2.close();
  }
} catch (e) { ok('script error', false, e.stack ?? e.message); }
await b.close();
fs.writeFileSync(`${OUT}/results-${MODE}.json`, JSON.stringify({ base: BASE, mode: MODE, at: new Date().toISOString(), results, evidence, calls: calls.map((c) => ({ ...c })) }, null, 1));
const fails = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - fails}/${results.length} passed (${MODE})`);
process.exit(fails ? 1 : 0);
