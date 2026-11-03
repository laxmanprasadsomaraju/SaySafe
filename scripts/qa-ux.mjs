// UX-unification QA against a running LOCAL server: 4 tabs + transaction detail + inline receipt in the Assistant,
// at 320/375/390/430/1440 in default / large-text / high-contrast. Axe WCAG 2.2 A/AA, horizontal overflow
// (scrollWidth), "nothing hidden behind the bottom nav" (every control is scrolled into view and hit-tested),
// keyboard tab order, Back button + browser back, the leave-a-pending-approval guard, nav hidden on
// /checkout/*, and a SCRIPTED first-time-user walkthrough (not real users).
//
//   DATABASE_FILE=/tmp/ux/e2e.db PORT=8787 npx tsx server/index.ts      # in another shell (no PayPal keys needed)
//   QA_DB=/tmp/ux/e2e.db OUT=/tmp/ux/qa node scripts/qa-ux.mjs [base] [part]   part: setup|audit|flows|walk|all
// Seeded rows come from scripts/seed-insights-demo.ts + scripts/qa-seed-ux.ts and are labelled as examples.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const PART = process.argv[3] ?? 'all';
const OUT = process.env.OUT ?? '/tmp/ux/qa';
const STATE = `${OUT}/state.json`;
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const b = await chromium.launch();
const post = (p, url, body) => p.evaluate(async ([u, x]) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body]);
const get = (p, url) => p.evaluate(async (u) => (await fetch(u)).json(), url);
const log = (...a) => { console.log(...a); fs.appendFileSync(`${OUT}/qa-log.txt`, a.join(' ') + '\n'); };

async function ctxFor(width, mode, cookies) {
  const ctx = await b.newContext({ viewport: { width, height: width >= 1000 ? 900 : 760 }, reducedMotion: 'reduce' });
  await ctx.addInitScript((m) => { if (m === 'contrast') localStorage.setItem('ss-contrast', 'on'); if (m === 'large') localStorage.setItem('ss-large', 'on'); localStorage.setItem('ss-voice', 'off'); localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, autoSpeak: true, rate: 0.95, readAll: false, lang: 'en' })); }, mode);
  if (cookies) await ctx.addCookies(cookies);
  return ctx;
}

// ---------- setup: a demo household with a family member, scans, and labelled example payments ----------
if (PART === 'setup' || PART === 'all') {
  const ctx = await ctxFor(390, 'default');
  const p = await ctx.newPage();
  await p.goto(BASE + '/'); await post(p, '/api/demo/start', { name: 'Mary' });
  await post(p, '/api/scan', { text: 'Your PayPal account is suspended. Verify now at http://paypa1-secure.example/login' });
  const s2 = await post(p, '/api/scan', { text: 'PayPal: you received €400. Call +1 800 000 0000 to release it.' });
  await post(p, `/api/scan/${s2.body.scanId}/share`, {});
  const inv = await post(p, '/api/family/invite', {});
  const fctx = await ctxFor(390, 'default'); const f = await fctx.newPage(); await f.goto(BASE + '/');
  await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
  const env = { ...process.env, DATABASE_FILE: process.env.QA_DB ?? '/tmp/ux/e2e.db' };
  execSync('npx tsx scripts/seed-insights-demo.ts', { env, stdio: 'inherit' });
  execSync('npx tsx scripts/qa-seed-ux.ts', { env, stdio: 'inherit' });
  const paid = await get(p, '/api/activity?status=paid&limit=1');
  const pending = await get(p, '/api/activity?status=pending&limit=1');
  const cookies = [...await ctx.cookies(), ...await fctx.cookies()];
  fs.writeFileSync(STATE, JSON.stringify({ cookies, receiptId: paid.items[0]?.id, pendingId: pending.items[0]?.id }, null, 2));
  log('SETUP receipt', paid.items[0]?.id, 'pending', pending.items[0]?.id);
  await ctx.close(); await fctx.close();
}
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));

// ---------- checks ----------
async function audit(p, label) {
  const ax = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const lay = await p.evaluate(async () => {
    const de = document.documentElement;
    const overflow = de.scrollWidth > de.clientWidth + 1;
    const stack = document.querySelector('[data-testid="bottom-stack"]');
    const name = (e) => (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
    const els = [...document.querySelectorAll('main button, main a[href], main input:not([type=file]), main textarea, main select, main summary')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden'; });
    const hidden = [];
    for (const e of els.slice(0, 90)) {
      e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise((r) => requestAnimationFrame(() => r()));
      const r = e.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + Math.min(r.width / 2, 20), 1), innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      if (!(hit && (hit === e || e.contains(hit) || hit.contains(e)))) hidden.push(`${name(e)} (under ${hit?.closest('[data-testid="bottom-stack"]') ? 'bottom nav' : hit?.closest('header') ? 'header' : hit?.tagName})`);
    }
    window.scrollTo(0, 0);
    const small = [...document.querySelectorAll('button, a[href], input:not([type=file]), select, textarea, summary')].filter((e) => {
      const r = e.getBoundingClientRect(); if (!r.width || !r.height || r.width <= 2) return false;
      if (e.tagName === 'A' && getComputedStyle(e).display === 'inline') return false;
      return r.height < 44 || r.width < 44;
    }).map(name);
    const nav = [...document.querySelectorAll('nav[aria-label="Main"] a')].filter((a) => a.getBoundingClientRect().height > 0);
    const navTargets = nav.map((a) => Math.round(a.getBoundingClientRect().height));
    return { overflow, sw: de.scrollWidth, cw: de.clientWidth, hidden, checked: els.length, small, stackH: stack?.offsetHeight ?? 0, navTargets, current: nav.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent) };
  });
  const issues = ax.violations.length + (lay.overflow ? 1 : 0) + lay.hidden.length;
  log(`${issues ? 'ISSUE' : 'OK   '} ${label} axe=${ax.violations.length}${ax.violations.length ? ' [' + ax.violations.map((v) => `${v.id}:${v.nodes[0]?.target}`).join('; ') + ']' : ''} overflow=${lay.overflow}(${lay.sw}/${lay.cw}) hiddenBehindNav=${lay.hidden.length}/${lay.checked}${lay.hidden.length ? ' [' + lay.hidden.slice(0, 4).join(' | ') + ']' : ''} small=${lay.small.length}${lay.small.length ? ' [' + lay.small.slice(0, 4).join(' | ') + ']' : ''} navTargets=${lay.navTargets.join(',')} current=${lay.current.join(',')}`);
  return { label, axe: ax.violations.map((v) => v.id), overflow: lay.overflow, hidden: lay.hidden, small: lay.small, navTargets: lay.navTargets };
}
const summary = [];
async function shot(p, name, full = true) {
  await p.screenshot({ path: `${OUT}/shots/${name}.png` });
  if (full) await p.screenshot({ path: `${OUT}/shots/${name}-full.png`, fullPage: true });
}

if (PART === 'audit' || PART === 'all') {
  for (const width of [320, 375, 390, 430, 1440]) for (const mode of ['default', 'large', 'contrast']) {
    const ctx = await ctxFor(width, mode, st.cookies);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const tag = `${width}-${mode}`;
    const wantShot = mode === 'default' || width === 390 || (width === 320 && mode === 'large');
    for (const [name, path] of [['home', '/home'], ['activity', '/activity'], ['profile', '/profile'], ['detail', `/order/${st.receiptId}`]]) {
      await p.goto(BASE + path); await p.waitForLoadState('networkidle'); await p.waitForTimeout(300);
      summary.push(await audit(p, `${tag} ${name}`));
      if (wantShot) await shot(p, `${tag}-${name}`);
    }
    await p.goto(BASE + '/assistant'); await p.waitForLoadState('networkidle');
    await p.fill('#assistant-input', 'show my last payment'); await p.keyboard.press('Enter');
    await p.getByRole('link', { name: /Open full receipt/ }).waitFor({ timeout: 20000 });
    await p.waitForTimeout(400);
    summary.push(await audit(p, `${tag} assistant-receipt`));
    if (wantShot) await shot(p, `${tag}-assistant-receipt`);
    if (errs.length) log('PAGE ERRORS', tag, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }
  // Family (Alex) home: pending approvals first.
  for (const width of [390, 1440]) {
    const ctx = await ctxFor(width, 'default', st.cookies); const p = await ctx.newPage();
    await p.goto(BASE + '/family'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(500);
    summary.push(await audit(p, `${width}-default family-home`)); await shot(p, `${width}-default-family-home`);
    await p.goto(BASE + '/activity?as=family'); await p.waitForLoadState('networkidle');
    summary.push(await audit(p, `${width}-default family-activity`)); await shot(p, `${width}-default-family-activity`, false);
    await ctx.close();
  }
  const total = summary.reduce((n, s) => n + s.axe.length + (s.overflow ? 1 : 0) + s.hidden.length, 0);
  fs.writeFileSync(`${OUT}/audit-summary.json`, JSON.stringify(summary, null, 2));
  log(`AUDIT pages=${summary.length} axeViolations=${summary.reduce((n, s) => n + s.axe.length, 0)} overflowPages=${summary.filter((s) => s.overflow).length} hiddenBehindNav=${summary.reduce((n, s) => n + s.hidden.length, 0)} TOTAL ISSUES ${total}`);
}

if (PART === 'flows' || PART === 'all') {
  const ctx = await ctxFor(390, 'default', st.cookies); const p = await ctx.newPage();
  const ok = (n, pass, info = '') => log(`${pass ? 'PASS' : 'FAIL'} ${n} ${info}`);
  // Keyboard order on Home.
  await p.goto(BASE + '/home'); await p.waitForLoadState('networkidle');
  await p.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await p.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  const order = [];
  for (let i = 0; i < 26; i++) {
    await p.keyboard.press('Tab');
    order.push(await p.evaluate(() => {
      const e = document.activeElement; if (!e || e === document.body || e === document.documentElement) return '(browser chrome)';
      const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(Math.min(r.left + 5, innerWidth - 1), Math.min(r.top + r.height / 2, innerHeight - 1));
      const visible = hit && (hit === e || e.contains(hit) || hit.contains(e));
      const zone = e.closest('header') ? 'header' : e.closest('[data-testid="bottom-stack"]') ? 'bottom' : e.closest('main') ? 'main' : 'other';
      return `${zone}:${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 28)}${visible ? '' : ' [OBSCURED]'}`;
    }));
  }
  log('TAB ORDER /home:', order.join(' → '));
  ok('keyboard: focused controls are never obscured', !order.some((o) => o.includes('[OBSCURED]')));
  // Back button (history) and browser back.
  await p.goto(BASE + '/home'); await p.waitForLoadState('networkidle');
  await p.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Activity' }).click(); await p.waitForURL('**/activity');
  await p.getByRole('button', { name: 'Paid', exact: true }).click(); await p.waitForTimeout(800); // a paid one: pending ones ask before leaving
  await p.getByRole('button', { name: /Open details/ }).first().click(); await p.waitForURL('**/order/**');
  await p.getByRole('button', { name: 'Back', exact: true }).click(); await p.waitForURL('**/activity'); ok('Back button returns to Activity', p.url().endsWith('/activity'));
  await p.goBack(); await p.waitForURL('**/home'); ok('browser back returns to Home', p.url().endsWith('/home'));
  await p.goto(`${BASE}/order/${st.receiptId}`); await p.waitForLoadState('networkidle');
  await p.getByRole('button', { name: 'Back', exact: true }).click(); await p.waitForURL('**/activity'); ok('Back button with no history falls back to Activity', p.url().endsWith('/activity'));
  // aria-current on tabs.
  const cur = await p.locator('nav[aria-label="Main"] a[aria-current="page"]').evaluateAll((as) => as.filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.textContent)); ok('aria-current marks the Activity tab', cur.join() === 'Activity', cur.join());
  // Leave guard on a purchase waiting for family: asks, Stay keeps you, Leave never cancels.
  await p.goto(`${BASE}/order/${st.pendingId}`); await p.waitForLoadState('networkidle');
  await p.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Home' }).click();
  const dlg = p.getByRole('dialog'); await dlg.waitFor({ timeout: 5000 });
  ok('leaving a pending approval asks first', await dlg.isVisible());
  await p.getByRole('button', { name: 'Stay here' }).click(); await p.waitForTimeout(300); ok('Stay keeps you on the purchase', p.url().includes(st.pendingId));
  // In-app history: Activity -> the pending purchase, then the browser's Back button.
  await p.goto(BASE + '/activity'); await p.waitForLoadState('networkidle');
  await p.getByRole('button', { name: 'Waiting', exact: true }).click(); await p.waitForTimeout(800);
  await p.getByRole('button', { name: /Open details/ }).first().click(); await p.waitForURL('**/order/**');
  await p.getByRole('heading', { name: 'Waiting for family' }).waitFor();
  await p.goBack({ timeout: 3000 }).catch(() => {}); const dlg2 = await p.getByRole('dialog').waitFor({ timeout: 4000 }).then(() => true).catch(() => false); ok('browser back also asks', dlg2, p.url());
  if (dlg2) await p.getByRole('button', { name: /Leave, keep it saved/ }).click();
  await p.waitForTimeout(500);
  const after = await get(p, `/api/payments/${st.pendingId}`); ok('leaving did not cancel it', after.state === 'FAMILY_APPROVAL_PENDING', after.state);
  // Nav hidden on PayPal return/cancel pages.
  await p.goto(`${BASE}/checkout/cancel?rid=${st.pendingId}&token=QA`); await p.waitForLoadState('networkidle');
  const navVisible = await p.locator('nav[aria-label="Main"]').evaluateAll((ns) => ns.some((n) => n.getBoundingClientRect().height > 0));
  ok('bottom/top nav hidden on /checkout/cancel', !navVisible);
  await shot(p, '390-default-checkout-cancel', false);
  // Assistant follow-ups (demo shop data; Channel3 if configured).
  await p.goto(BASE + '/assistant?mode=find'); await p.waitForLoadState('networkidle');
  await p.fill('#assistant-input', 'I need a kettle'); await p.keyboard.press('Enter');
  await p.getByRole('list', { name: /Demo Shop options|Shop listings/ }).last().waitFor({ timeout: 30000 });
  ok('find a product shows inline product cards', true);
  await p.getByRole('button', { name: 'Show cheaper ones' }).click(); await p.waitForTimeout(1500);
  log('  cheaper ->', (await p.locator('[role=log] p').last().textContent())?.slice(0, 140));
  await p.fill('#assistant-input', 'is it suitable for a four-year-old?'); await p.keyboard.press('Enter'); await p.waitForTimeout(800);
  log('  age ->', (await p.locator('[role=log] p').last().textContent())?.slice(0, 200));
  await p.fill('#assistant-input', 'check if this seller is trustworthy'); await p.keyboard.press('Enter'); await p.waitForTimeout(800);
  log('  seller ->', (await p.locator('[role=log] p').last().textContent())?.slice(0, 200));
  await p.getByRole('list', { name: /Demo Shop options|Shop listings/ }).last().getByRole('button').first().click();
  await p.getByRole('dialog').waitFor(); await shot(p, '390-default-assistant-sheet', false);
  const prep = p.getByRole('button', { name: /Prepare PayPal Sandbox payment/ });
  if (await prep.count()) {
    await prep.click(); await p.getByRole('button', { name: 'Deny' }).waitFor(); await shot(p, '390-default-assistant-approval', false);
    ok('Demo Shop sheet leads to the Allow/Deny approval card', true);
    await p.getByRole('button', { name: 'Deny' }).click(); await p.getByText('You said no. Nothing was paid.').waitFor({ timeout: 5000 }); ok('Deny pays nothing', true);
  }
  await p.reload(); await p.waitForLoadState('networkidle');
  ok('conversation persists across reload (sessionStorage)', (await p.locator('[role=log] > div').count()) > 3);
  await ctx.close();
}

if (PART === 'walk' || PART === 'all') {
  // SCRIPTED walkthrough, not real users: a fresh tab (no conversation history) completes three tasks by picking
  // the visible control whose label best matches the task words. Counts taps, typing, scrolling; notes friction.
  const ctx = await ctxFor(390, 'default', st.cookies); const p = await ctx.newPage();
  const steps = []; const friction = [];
  const pick = async (words) => {
    const cands = await p.evaluate((ws) => [...document.querySelectorAll('button, a[href]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; })
      .map((e, i) => ({ i, t: (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ') })).map((c) => ({ ...c, s: ws.filter((w) => c.t.toLowerCase().includes(w)).length })).filter((c) => c.s > 0).sort((a, b) => b.s - a.s), words);
    return cands[0] ?? null;
  };
  const clickBest = async (words, task) => {
    const c = await pick(words);
    if (!c) { friction.push(`${task}: nothing on screen matched ${words.join('/')} without scrolling`); await p.mouse.wheel(0, 600); await p.waitForTimeout(200); const c2 = await pick(words); if (!c2) return null; steps.push({ task, action: 'scroll' }); return clickIdx(c2, task); }
    return clickIdx(c, task);
  };
  const clickIdx = async (c, task) => { await p.evaluate((i) => [...document.querySelectorAll('button, a[href]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; })[i].click(), c.i); steps.push({ task, action: 'tap', target: c.t.slice(0, 40) }); await p.waitForTimeout(600); return c; };
  const inView = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }).catch(() => false);
  const t0 = Date.now();
  // Task 1
  await p.goto(BASE + '/home'); await p.waitForLoadState('networkidle');
  await clickBest(['check', 'message', 'scam'], 'scam check');
  await p.locator('#assistant-input').fill('Your PayPal account is limited. Confirm your details at http://paypal-help-centre.example within 24 hours.'); steps.push({ task: 'scam check', action: 'type message + Enter' });
  await p.keyboard.press('Enter');
  const verdict = p.getByText(/^(Suspicious|Needs checking)$/i).last(); await verdict.waitFor({ timeout: 30000 });
  if (!(await inView(verdict))) friction.push('scam check: verdict label not in view without scrolling');
  // Task 2
  await p.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Home' }).click(); steps.push({ task: 'find product', action: 'tap', target: 'Home tab' }); await p.waitForURL('**/home');
  await p.getByRole('navigation', { name: 'Shortcuts' }).waitFor();
  await clickBest(['find', 'product', 'shop'], 'find product');
  await p.locator('#assistant-input').fill('a kettle under €40'); steps.push({ task: 'find product', action: 'type + Enter' }); await p.keyboard.press('Enter');
  const list = p.getByRole('list', { name: /Demo Shop options|Shop listings/ }).last(); await list.waitFor({ timeout: 30000 });
  if (!(await inView(list))) friction.push('find product: results list not in view without scrolling');
  await list.getByRole('button').first().click(); steps.push({ task: 'find product', action: 'tap', target: 'first product row' });
  await p.getByRole('dialog').waitFor();
  const primary = p.getByRole('dialog').getByRole('button', { name: /Prepare PayPal Sandbox payment/ }).or(p.getByRole('dialog').getByRole('link', { name: /View on retailer site/ }));
  if (!(await inView(primary.first()))) friction.push('find product: sheet primary action below the fold');
  await p.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click(); steps.push({ task: 'find product', action: 'tap', target: 'Close sheet' });
  // Task 3
  await p.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Home' }).click(); steps.push({ task: 'locate receipt', action: 'tap', target: 'Home tab' }); await p.waitForURL('**/home');
  await p.getByRole('navigation', { name: 'Shortcuts' }).waitFor();
  await clickBest(['payments', 'receipt', 'activity'], 'locate receipt');
  await p.getByRole('link', { name: /See all in Activity|See all activity/ }).last().waitFor({ timeout: 15000 }).catch(() => {});
  const paidRow = p.getByRole('button', { name: /Paid/ }).first();
  if (await paidRow.count()) { await paidRow.click(); steps.push({ task: 'locate receipt', action: 'tap', target: 'a Paid payment' }); }
  else friction.push('locate receipt: no "Paid" row visible in the payments card');
  const found = await p.getByText(/Receipt confirmed by PayPal/).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const ms = Date.now() - t0;
  const byTask = (t) => steps.filter((s) => s.task === t);
  const report = { label: 'scripted walkthrough, not real users', viewport: '390x760', tasks: ['scam check', 'find product', 'locate receipt'].map((t) => ({ task: t, taps: byTask(t).filter((s) => s.action === 'tap').length, typing: byTask(t).filter((s) => s.action.startsWith('type')).length, scrolls: byTask(t).filter((s) => s.action === 'scroll').length, steps: byTask(t) })), receiptFound: found, friction, seconds: Math.round(ms / 1000) };
  fs.writeFileSync(`${OUT}/walkthrough.json`, JSON.stringify(report, null, 2));
  log('WALKTHROUGH (scripted, not real users)', JSON.stringify(report.tasks.map((t) => ({ task: t.task, taps: t.taps, typing: t.typing, scrolls: t.scrolls }))), 'receiptFound=' + found, 'friction=' + JSON.stringify(friction));
  await shot(p, '390-default-walkthrough-end', false);
  await ctx.close();
}
await b.close();
