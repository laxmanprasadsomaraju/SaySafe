// The SaySafe demo video, recorded from the real app: ONE silent 1920x1080 H.264 30 fps MP4 under 2:55, plus a timing
// file and a narration script timed to the ACTUAL cut (the person records only the voice-over).
//
//   node scripts/record-demo.mjs http://127.0.0.1:8792                 # local build (mock PayPal), for validation
//   OUT=/path/to/video PAYPAL_BUYER_EMAIL=… PAYPAL_BUYER_PASSWORD=… node scripts/record-demo.mjs https://saysafe.onrender.com
//   OUT=/path/to/video EXTERNAL_APPROVAL=1 node scripts/record-demo.mjs https://saysafe.onrender.com   # approve $OUT/approve-url.txt yourself
//
// Output ($OUT, default ./video-out): saysafe-demo.mp4 · timing.json · narration.md · captions.srt · receipt-info.json · segments/*.mp4 · raw/*.webm · cards/*.png
//
// How it stays honest:
//  - Everything on screen is the real app, driven by slow, visible clicks (an injected cursor + click ring) and typing.
//  - PayPal's hosted login/approval page is NEVER recorded. The recorded browser's request to sandbox.paypal.com is
//    answered by a blank hand-off page; the approval happens in a separate, NON-recording browser context with the same
//    session: hosted = the sandbox buyer from the ENVIRONMENT (never written anywhere), local = the mock PayPal. The video
//    shows a 5 s title card for that step, then the real return and receipt.
//  - Local runs use a mock PayPal: every PayPal id is replaced by "[ID hidden · local test]" and a banner says
//    "Local test build (mock PayPal) — not a real sandbox payment" on every app frame.
//  - Waiting for the server/AI is cut out of the final video (marked in timing.json), never sped up.
//  - Known limit: the recorder's frame timestamps can lag the script clock by ~1–2 s, so check the automatic cut points
//    against the raw footage before publishing (the Nov 2026 final cut was re-cut by hand from raw/*.webm).
// Requires ffmpeg (libx264). Spoken replies stay off (the app's default), so nothing plays sound.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8792').replace(/\/$/, '');
const HOSTED = !/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE);
const MOCK = process.env.MOCK_PAYPAL ?? 'http://127.0.0.1:9999';
const OUT = path.resolve(process.env.OUT ?? 'video-out');
const W = 1920, H = 1080, FPS = 30, LIMIT = 175; // seconds (2:55)
// The page is laid out at 1280×720 CSS px (desktop layout, large enough to read). Playwright's recorder captures CSS-px
// frames (a 1920×1080 recording would put the page in the top-left corner with grey padding), so it records 1280×720
// and each segment is scaled to 1920×1080 (lanczos). CSS zoom is not used: it skews element coordinates and clicks.
const VW = 1280, VH = 720, DPR = W / VW;
const BUYER = { email: process.env.PAYPAL_BUYER_EMAIL, password: process.env.PAYPAL_BUYER_PASSWORD };
// EXTERNAL_APPROVAL=1 (hosted): no buyer login here at all. The approval URL is written to $OUT/approve-url.txt for someone
// to approve on PayPal's own page; the script polls the order's read-only status with Mary's session, then continues.
const EXTERNAL = Boolean(process.env.EXTERNAL_APPROVAL);
if (HOSTED && !process.env.NARRATE_ONLY && !EXTERNAL && !(BUYER.email && BUYER.password)) { console.error('Hosted recording needs PAYPAL_BUYER_EMAIL and PAYPAL_BUYER_PASSWORD in the environment (sandbox buyer), or EXTERNAL_APPROVAL=1.'); process.exit(2); }
for (const d of ['raw', 'segments', 'cards']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const PACE = Number(process.env.PACE ?? 0.6); // scales every on-screen pause (1 = slowest); waits for the server are cut instead
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
const log = (...a) => console.log(...a);
const proxyOf = (u) => { if (!u) return undefined; const x = new URL(u); return { server: `${x.protocol}//${x.host}`, username: decodeURIComponent(x.username), password: decodeURIComponent(x.password), bypass: '127.0.0.1,localhost' }; };

// ---------------- The shot list (narration is timed to the measured cut afterwards) ----------------
const NARRATION = {
  landing: 'This is SaySafe, a payment safety companion for older adults and the family who help them: a second look before paying, family backup, and proof afterwards. Meet Mary.',
  search: 'Mary asks the Assistant to find a kettle. These are real listings found with Channel3, with the shop and the price. She would buy these on the shop’s own website. SaySafe also offers a Demo Shop item, where the payment itself can be protected.',
  scam: 'Then a message arrives: her account is on hold, she owes a hundred and twenty euro, call this number. Mary pastes it in. The AI points to the exact warning signs: a number she can’t verify, and pressure to act. It can make a warning stronger. It never calls a message safe.',
  paid: 'Has she already paid a hundred and twenty euro? SaySafe checks her own records and finds possible matches. These are sample records, clearly labelled, and a matching amount is not proof.',
  shop: 'Now Mary buys a microwave from the SaySafe Demo Shop. The price comes from the server, not the AI. It is a hundred and twenty euro, over her seventy-five euro limit, so she taps Allow to ask her family to check first. Nothing is paid yet.',
  alex: 'Alex, her family helper, opens his own family view. He sees exactly what she wants to buy, from which shop, and for how much. He approves this one purchase. He can never pay for her.',
  approved: 'Back as Mary, the same card in the same conversation now says approved. But family approval is not payment approval. Mary still approves the payment herself, on PayPal’s own page.',
  paypal: 'This step happens on PayPal’s own Sandbox checkout, with test money.',
  receipt: 'PayPal sends her back. SaySafe captures the payment once and checks it with PayPal before it says paid. PayPal’s signed webhook notice is verified too, and every step is listed as payment evidence on the receipt.',
  insights: 'Mary’s Insights page is a calm, read-only summary. Real Sandbox payments and sample data are kept apart. It can explain, but it can’t approve, pay or cancel anything.',
  family: 'Alex has his own insights page. He sees the purchase Mary asked him to check, and its Sandbox confirmation. Her other purchases stay private.',
  end: 'SaySafe. Ask first, pay with confidence. PayPal Sandbox only, so no real money moved. The code is on GitHub.',
};
const ONSCREEN = {
  landing: 'Landing page → Try as Mary', search: 'Assistant: “Find me a kettle” → real Channel3 listings (product cards) + Demo Shop alternative',
  scam: 'Message check: scam text pasted → result with quoted warning signs', paid: '“Have I already paid €120?” → possible match, labelled Sample data',
  shop: '“Let’s buy the demo microwave” → Review purchase €120 (Family check: above €75) → Allow → Family review: Pending', alex: 'Try as Alex too → Alex’s review card → Approve',
  approved: 'Profile › Back to Mary → Assistant: Approved → Continue to PayPal', paypal: 'Title card: PayPal Sandbox checkout (PayPal’s page is not shown)',
  receipt: 'Receipt page: Captured · Webhook verified → Webhook verification: Verified — signed PayPal notice → Payment evidence timeline', insights: 'Mary’s Insights page (masonry cards, Real PayPal Sandbox vs Sample data)',
  family: 'Profile › Try as Alex too → Alex’s family Insights: “Her other purchases stay private”, 1 approved, €120 sandbox capture, webhook confirmed', end: 'End card: github.com/laxmanprasadsomaraju/SaySafe · PayPal Sandbox, no real money',
};
const CAPTIONS = {
  landing: 'For older adults and the family who help them', search: 'Real listings from Channel3', scam: 'AI explains. It never calls a message safe.', paid: 'Sample data · a match is not proof',
  shop: 'Over €75 → family check first', alex: 'Alex approves this exact purchase only', approved: 'Family approval ≠ PayPal approval', paypal: 'PayPal Sandbox · test money',
  receipt: '“Paid” only after PayPal confirms', insights: 'Read-only · real sandbox and sample kept apart', family: 'Family sees only what Mary sends', end: 'PayPal Sandbox, no real money · not affiliated with PayPal',
};


function writeNarration({ shotsOut, total, probe, raw, ranges, recordedAt, base }) {
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  const rows = shotsOut.map((s) => ({ name: s.name, start: s.start, end: s.end, from: mmss(s.start), to: mmss(s.end), seconds: +(s.end - s.start).toFixed(1), onScreen: ONSCREEN[s.name], caption: CAPTIONS[s.name], say: NARRATION[s.name], words: words(NARRATION[s.name]), wps: +(words(NARRATION[s.name]) / Math.max(1, s.end - s.start)).toFixed(2) }));
  const totalWords = rows.reduce((n, r) => n + r.words, 0);
  const timing = { base: base ?? (HOSTED ? BASE : 'local test build (mock PayPal)'), recordedAt: recordedAt ?? new Date().toISOString(), file: 'saysafe-demo.mp4', stream: probe, durationSeconds: +total.toFixed(2), limitSeconds: LIMIT, totalWords, shots: rows, rawFootage: raw ? path.relative(OUT, raw) : undefined, keptRanges: ranges };
  fs.writeFileSync(path.join(OUT, 'timing.json'), JSON.stringify(timing, null, 2));
  const local = !/^https?:/.test(timing.base);
  const md = [
    `# SaySafe demo: narration script, timed to the final video`, '',
    `Video: \`saysafe-demo.mp4\` · ${mmss(total)} (${total.toFixed(1)} s) · ${probe} · silent · recorded from ${timing.base}. ${totalWords} words, about ${(totalWords / total * 60).toFixed(0)} words a minute.`, '',
    local ? '> **Local validation build.** PayPal here is a mock: ids are hidden and a banner says so. Re-run against the hosted app after the final deploy for the real video; this file is regenerated with the new timings.\n' : '',
    'Read slowly in plain spoken English. Start each line at its timestamp. Captions are optional on-screen text (burn in with your editor).', '',
    '| Time | On screen | Say | Caption |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.from}–${r.to} | ${r.onScreen} | ${r.say} | ${r.caption} |`), '',
    '## Notes', '',
    '- The PayPal login page is not in the video (it shows the buyer’s email). The title card stands in for it; everything after it is the real return and receipt.',
    '- `captions.srt` carries the same words, cued sentence by sentence inside each shot.',
    '- Keep the in-app “PayPal Sandbox · no real money” and “Sample data” labels visible. Don’t claim PayPal endorses SaySafe, proven fraud prevention, or user-test results.',
    '- Upload to YouTube as **Public**, title “SaySafe: AI payment safety companion (PayPal AI Hackathon)”; description: demo URL, repo URL, “PayPal Sandbox only — test money. Not affiliated with or endorsed by PayPal.”',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'narration.md'), md + '\n');
  // captions.srt: each shot's narration split into sentence-sized cues, timed in proportion to their length inside the shot.
  const ts = (t) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const cues = [];
  for (const r of rows) {
    const parts = r.say.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [r.say];
    const chunks = parts.flatMap((x) => { const w = x.split(/\s+/); if (w.length <= 16) return [x]; const half = Math.ceil(w.length / 2); return [w.slice(0, half).join(' '), w.slice(half).join(' ')]; });
    const span = Math.max(0.5, r.end - r.start - 0.3), total = chunks.reduce((n, c) => n + c.length, 0); let t = r.start + 0.15;
    for (const c of chunks) { const d = span * c.length / total; cues.push({ a: t, b: t + d - 0.05, text: c }); t += d; }
  }
  fs.writeFileSync(path.join(OUT, 'captions.srt'), cues.map((c, i) => `${i + 1}\n${ts(c.a)} --> ${ts(c.b)}\n${c.text}\n`).join('\n'));
  return timing;
}

// NARRATE_ONLY=1: rewrite narration.md/timing.json from the existing timing.json (after editing the words above).
if (process.env.NARRATE_ONLY) {
  const t = JSON.parse(fs.readFileSync(path.join(OUT, 'timing.json'), 'utf8'));
  const out = writeNarration({ shotsOut: t.shots, total: t.durationSeconds, probe: t.stream, raw: t.rawFootage && path.join(OUT, t.rawFootage), ranges: t.keptRanges, recordedAt: t.recordedAt, base: t.base });
  console.log(`narration.md: ${out.totalWords} words over ${out.durationSeconds} s`); for (const r of out.shots) console.log(`${r.from}-${r.to} ${r.name.padEnd(9)} ${r.words} words (${r.wps}/s)`);
  process.exit(0);
}

const browser = await chromium.launch(HOSTED && process.env.HTTPS_PROXY ? { proxy: proxyOf(process.env.HTTPS_PROXY) } : {});

// ---------------- Title cards (rendered by the browser, not recorded) ----------------
async function card(name, html, seconds) {
  const c = await browser.newContext({ viewport: { width: W, height: H } }); const p = await c.newPage();
  await p.setContent(`<!doctype html><html><head><style>
    body{margin:0;width:${W}px;height:${H}px;display:flex;flex-direction:column;justify-content:center;align-items:center;background:#15283b;color:#fff;font-family:'Atkinson Hyperlegible Next','Atkinson Hyperlegible',system-ui,sans-serif;text-align:center}
    h1{font:600 96px/1.05 Georgia,'Fraunces',serif;margin:0 0 28px;letter-spacing:-1px} p{font-size:40px;line-height:1.35;margin:10px 120px;color:#e4f3ef} .s{font-size:30px;color:#cfd8df}
    .tag{display:inline-block;background:#fbf0e2;color:#8f4d0c;font-weight:700;font-size:30px;padding:10px 22px;border-radius:999px;margin-top:34px}
    .arch{display:grid;grid-template-columns:1fr 1.4fr 1fr;gap:28px;width:1680px;align-items:center;text-align:left}
    .box{border:3px solid #9fd8cb;border-radius:22px;padding:22px 26px;font-size:27px;line-height:1.35} .box b{display:block;font-size:31px;margin-bottom:8px;color:#fff}
    .arrow{font-size:44px;color:#9fd8cb;text-align:center} .row{display:flex;gap:26px;align-items:center;justify-content:center;margin-top:26px}
  </style></head><body>${html}</body></html>`);
  await sleep(300);
  const file = path.join(OUT, 'cards', `${name}.png`); await p.screenshot({ path: file }); await c.close();
  return { kind: 'card', name, file, seconds };
}

// ---------------- The recorded browser ----------------
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR, locale: 'en-IE', timezoneId: 'Europe/Dublin', recordVideo: { dir: path.join(OUT, 'raw'), size: { width: VW, height: VH } } });
await ctx.addInitScript(({ local }) => {
  if (!localStorage.getItem('ss-voice-prefs')) localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, mutedByUser: true, autoSpeak: false, rate: 0.95, readAll: false, lang: 'en' }));
  const boot = () => {
    const st = document.createElement('style');
    st.textContent = `#rec-cursor{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;transform:translate(-4px,-2px);transition:left .05s linear,top .05s linear}
      .rec-ring{position:fixed;width:56px;height:56px;margin:-28px 0 0 -28px;border:4px solid #c2410c;border-radius:50%;z-index:2147483646;pointer-events:none;animation:recring .7s ease-out forwards}
      @keyframes recring{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
      #rec-banner{position:fixed;right:10px;top:72px;z-index:2147483645;background:#15283b;color:#fff;font:700 15px/1.2 system-ui,sans-serif;padding:8px 16px;border-radius:10px;pointer-events:none}`;
    document.head.appendChild(st);
    const c = document.createElement('div'); c.id = 'rec-cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#15283b" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const pos = JSON.parse(sessionStorage.getItem('rec-pos') ?? '[960,540]'); c.style.left = `${pos[0]}px`; c.style.top = `${pos[1]}px`;
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; sessionStorage.setItem('rec-pos', JSON.stringify([e.clientX, e.clientY])); }, true);
    addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = 'rec-ring'; r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 800); }, true);
    if (local) {
      const b = document.createElement('div'); b.id = 'rec-banner'; b.textContent = 'Local test build (mock PayPal) — not a real sandbox payment'; document.documentElement.appendChild(b);
      const re = /\bMOCK[A-Z0-9-]*(?:…|\.\.\.)?[A-Z0-9]*|\b[A-Z0-9]{3,8}(?:…|\.\.\.)[A-Z0-9]{3,6}\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{17}\b/g;
      const mask = () => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const n = []; while (w.nextNode()) n.push(w.currentNode); for (const t of n) { re.lastIndex = 0; if (re.test(t.nodeValue)) { re.lastIndex = 0; t.nodeValue = t.nodeValue.replace(re, '[ID hidden · local test]'); } } };
      new MutationObserver(mask).observe(document.body, { subtree: true, childList: true, characterData: true }); mask();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}, { local: !HOSTED });

let payUrl = null;
await ctx.route('https://www.sandbox.paypal.com/**', async (r) => { payUrl = r.request().url(); await r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><body style="background:#f7f8f4;font:32px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#15283b">Opening PayPal…</body></html>' }); });
const p = await ctx.newPage();
const T0 = Date.now(); const now = () => (Date.now() - T0) / 1000;
const ranges = []; // { name, a, b } kept app footage
const cuts = []; let open = null;
const begin = (name) => { open = { name, a: now() }; };
const end = () => { open.b = now(); ranges.push(open); open = null; };
/** A wait that is cut out of the final video (server/AI latency). */
async function cut(fn) { const name = open.name; end(); try { await fn(); } finally { begin(name); } }

async function moveTo(loc) {
  const el = loc.first(); await el.waitFor({ timeout: 40000 });
  await el.evaluate((e) => { const r = e.getBoundingClientRect(); scrollBy({ top: r.top + r.height / 2 - innerHeight * 0.42, behavior: 'smooth' }); }); await sleep(900);
  const b = await el.boundingBox(); if (!b) return;
  // boundingBox is in CSS px of the zoomed page; the mouse uses viewport px.
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 }); await sleep(450);
}
// The visible glide is ours; the click itself is Playwright's (re-locates the element, so a re-render can't make it miss).
async function click(loc, after = 900) { await moveTo(loc); await loc.first().click({ delay: 90 }); await sleep(after); }
async function type(text, cardKind) {
  await click(p.locator('#assistant-input'), 300);
  await p.keyboard.type(text, { delay: 26 }); await sleep(600);
  const n = cardKind ? await p.locator(`[data-card="${cardKind}"]`).count() : 0;
  await p.keyboard.press('Enter');
  if (cardKind) await cut(() => p.waitForFunction(([k, x]) => document.querySelectorAll(`[data-card="${k}"]`).length > x, [cardKind, n], { timeout: 60000 }));
}
async function show(loc, ms = 2500) { const el = loc.first(); await el.waitFor({ timeout: 40000 }); await el.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'start' })); await sleep(700); await p.evaluate(() => scrollBy({ top: -120, behavior: 'smooth' })); await sleep(ms); }
async function scrollSlow(px, ms = 2200) { await p.evaluate((y) => scrollBy({ top: y, behavior: 'smooth' }), px); await sleep(ms); }
const last = (k) => p.locator(`[data-card="${k}"]`).last();
// The leave guard can open after the Alex session call returns; answered off camera (inside a cut).
const leaveIfAsked = async () => { const b = p.getByRole('button', { name: 'Leave, keep it saved' }); if (await Promise.race([b.waitFor({ timeout: 10000 }).then(() => true).catch(() => false), p.waitForURL(/\/family\//, { timeout: 10000 }).then(() => false).catch(() => false)])) await b.click(); };

// A short lead-in that is cut, so the first frame is already the page.
await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 }); await sleep(800);

// LANDING → TRY AS MARY
begin('landing');
await sleep(3000); await scrollSlow(420, 2500); await scrollSlow(-420, 1000);
await click(p.locator('button:visible', { hasText: 'Try as Mary' }), 300);
await cut(async () => { await p.waitForURL(/\/assistant/, { timeout: 90000 }); await p.waitForSelector('#assistant-input'); await last('demo_welcome').waitFor({ timeout: 30000 }); await sleep(600); });
await sleep(1500);
end();

// REAL CHANNEL3 SEARCH
begin('search');
await type('Find me a kettle');
await cut(() => p.getByRole('list', { name: 'Shop listings' }).last().waitFor({ timeout: 60000 }));
await show(p.getByRole('list', { name: 'Shop listings' }).last(), 4500);
await scrollSlow(420, 3200);
end();

// SCAM CHECK (composer mode chip "Check a message")
begin('scam');
await p.goto(BASE + '/assistant?mode=check'); await p.waitForSelector('#assistant-input'); await sleep(1200);
await type('PayPal: your account is on hold. You owe €120 for a microwave order. Call 01 555 0199 to cancel.', 'scam_result');
await show(last('scam_result'), 6500);
end();

// HAVE I ALREADY PAID? (sample data)
begin('paid');
await type('Have I already paid €120?', 'payment_matches');
await sleep(800); await show(last('payment_matches'), 5500);
end();

// DEMO SHOP → OVER LIMIT → FAMILY REVIEW
begin('shop');
await type("Let's buy the demo microwave.", 'payment_prep');
await show(last('payment_prep'), 3500);
await click(last('payment_prep').getByRole('button', { name: /^Allow/ }), 300);
await cut(() => last('family_status').getByText('Pending').waitFor({ timeout: 30000 }));
await show(last('family_status'), 3000);
end();
const rid = (await last('family_status').locator('a[href^="/order/"]').last().getAttribute('href').catch(() => null))?.split('/').pop() ?? null;

// ALEX (his own family session in this browser)
begin('alex');
await click(last('family_status').getByTestId('try-as-alex-card'), 200);
await cut(async () => { await leaveIfAsked(); await p.waitForURL(/\/family\/assistant/, { timeout: 30000 }); await last('family_review').waitFor({ timeout: 30000 }); });
await show(last('family_review'), 3500);
await click(last('family_review').getByRole('button', { name: 'Approve' }), 300);
await cut(() => last('family_review').getByText('Approved').first().waitFor({ timeout: 20000 }));
await sleep(2000);
end();

// BACK TO MARY → APPROVED → CONTINUE TO PAYPAL
begin('approved');
await p.goto(BASE + '/profile?as=family'); await sleep(900);
await click(p.getByRole('link', { name: /Back to Mary/ }), 300);
await cut(async () => { await p.waitForURL(/\/home/, { timeout: 20000 }); await p.goto(BASE + '/assistant'); await last('family_status').getByRole('button', { name: 'Continue to PayPal' }).waitFor({ timeout: 30000 }); });
await show(last('family_status'), 3000);
await click(last('family_status').getByRole('button', { name: 'Continue to PayPal' }), 200);
end();

// PAYPAL (never recorded). Hosted: the buyer approves in a separate, non-recording browser.
let receiptInfo = {};
await (async () => {
  await p.waitForURL(/sandbox\.paypal\.com/, { timeout: 30000 }).catch(() => {});
  if (!payUrl && /sandbox\.paypal\.com/.test(p.url())) payUrl = p.url();
  if (!payUrl) { await p.screenshot({ path: path.join(OUT, 'fail-paypal.png') }); await ctx.close(); throw new Error(`Continue to PayPal did not reach PayPal (page at ${p.url()}); see fail-paypal.png`); }
  const token = new URL(payUrl).searchParams.get('token');
  let returnUrl;
  if (!HOSTED) {
    returnUrl = (await (await fetch(`${MOCK}/mock/approve/${token}`, { method: 'POST' })).json()).returnUrl.replace(/^https?:\/\/[^/]+/, BASE);
  } else if (EXTERNAL) {
    // EXTERNAL_APPROVAL=1: someone else approves at PayPal (the URL is written to $OUT/approve-url.txt). We poll the
    // owner-only, read-only order status with Mary's own session until PayPal says APPROVED, then follow the return.
    fs.writeFileSync(path.join(OUT, 'approve-url.txt'), payUrl + '\n');
    log(`WAITING_FOR_BUYER ${payUrl}`);
    const limitMin = Number(process.env.APPROVAL_WAIT_MIN ?? 20); let st = null;
    for (let i = 0; i < limitMin * 6; i++) {
      const r = await ctx.request.get(`${BASE}/api/paypal/orders/${token}/status`).catch(() => null);
      st = r && r.ok() ? await r.json() : st;
      if (/APPROVED|COMPLETED/.test(st?.orderStatus ?? '')) break;
      await new Promise((r) => setTimeout(r, 10000));
    }
    if (!/APPROVED|COMPLETED/.test(st?.orderStatus ?? '')) { await ctx.close(); throw new Error(`PayPal order not approved within ${limitMin} min (last status ${st?.orderStatus ?? 'unknown'})`); }
    log(`APPROVED at PayPal (${st.orderStatus})`);
    returnUrl = `${BASE}/checkout/return?${rid ? `rid=${encodeURIComponent(rid)}&` : ''}token=${encodeURIComponent(token)}`;
  } else {
    const state = await ctx.storageState();
    const side = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } }); const s = await side.newPage();
    await s.goto(payUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await s.locator('#email').fill(BUYER.email, { timeout: 45000 }).catch(() => {});
    await s.locator('#btnNext').click({ timeout: 8000 }).catch(() => {});
    await s.locator('#password').fill(BUYER.password, { timeout: 45000 }); await s.locator('#btnLogin').click();
    await s.locator('#payment-submit-btn, [data-testid="submit-button-initial"]').first().click({ timeout: 90000 });
    await s.waitForURL((u) => u.href.startsWith(BASE), { timeout: 120000 });
    returnUrl = s.url(); await side.close();
  }
  await ctx.unroute('https://www.sandbox.paypal.com/**').catch(() => {});
  // The recorded page follows the return: with Mary's session SaySafe confirms and captures once, then shows the receipt.
  await p.goto(returnUrl);
  await p.getByTestId('order-state').waitFor({ timeout: 90000 });
  await p.locator('main').getByText(/Verification pending|Verified — signed/).first().waitFor({ timeout: 60000 });
  if (HOSTED) { // wait (cut) for the signed webhook to be verified, up to ~2.5 min
    for (let i = 0; i < 10 && !(await p.locator('main').getByText('Verified — signed').count()); i++) { await new Promise((r) => setTimeout(r, 15000)); await p.reload(); await p.getByTestId('order-state').waitFor({ timeout: 60000 }); }
  }
  const orderId = rid ?? new URL(p.url()).pathname.split('/').pop();
  const pr = await ctx.request.get(`${BASE}/api/payments/${orderId}`).then((r) => r.json()).catch(() => ({}));
  receiptInfo = { requestId: orderId, state: pr.state, captureId: pr.receipt?.captureId ?? pr.paypalCaptureId ?? null, webhookConfirmed: pr.receipt?.webhookConfirmed ?? null, onScreenVerified: (await p.locator('main').getByText('Verified — signed').count()) > 0 };
  fs.writeFileSync(path.join(OUT, 'receipt-info.json'), JSON.stringify(receiptInfo, null, 2));
  log('RECEIPT', JSON.stringify(receiptInfo));
  await sleep(600);
})();

// RECEIPT (webhook verification row)
begin('receipt');
await sleep(3500);
await moveTo(p.locator('main').getByText(/Verified — signed|Verification pending/));
await sleep(3500); await scrollSlow(380, 3000);
end();

// MARY'S INSIGHTS (masonry)
begin('insights');
await click(p.locator('header').getByRole('link', { name: 'Insights' }), 300);
await cut(async () => { await p.locator('#spending').waitFor({ timeout: 30000 }); await sleep(800); });
await sleep(3500); await scrollSlow(520, 3200); await scrollSlow(520, 3200);
end();

// ALEX'S FAMILY INSIGHTS (privacy)
begin('family');
await cut(async () => { await p.goto(BASE + '/profile'); await p.getByTestId('try-as-alex').waitFor({ timeout: 30000 }); await p.evaluate(() => scrollTo(0, 0)); });
await click(p.getByTestId('try-as-alex'), 300);
await cut(async () => { await p.waitForURL(/\/family\/assistant/, { timeout: 30000 }); await p.locator('header').getByRole('link', { name: 'Insights' }).waitFor({ timeout: 20000 }); });
await click(p.locator('header').getByRole('link', { name: 'Insights' }), 300);
await cut(async () => { await p.waitForURL(/\/family\/insights/, { timeout: 30000 }); await p.locator('main').getByText(/stay private/).first().waitFor({ timeout: 30000 }); await sleep(600); });
await moveTo(p.locator('main').getByText(/stay private/)); await sleep(4000); await scrollSlow(400, 3000);
end();
await p.close(); const raw = await p.video().path(); await ctx.close();

// ---------------- Cards ----------------
const cards = {
  paypal: await card('paypal', `<h1 style="font-size:72px">PayPal Sandbox checkout</h1><p>Mary approves the payment herself, on PayPal’s own page.</p><span class="tag">Sandbox · test money · no real payment</span>`, 5),
  end: await card('end', `<h1>SaySafe</h1><p>Ask first. Pay with confidence.</p><p class="s">saysafe.onrender.com</p><p>github.com/laxmanprasadsomaraju/SaySafe</p><span class="tag">PayPal Sandbox, no real money · independent project, not affiliated with or endorsed by PayPal</span>`, 7),
};

// ---------------- Cut + stitch ----------------
const order = ['landing', 'search', 'scam', 'paid', 'shop', 'alex', 'approved', 'paypal', 'receipt', 'insights', 'family', 'end'];
const enc = ['-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an'];
const pieces = []; let k = 0;
const shotsOut = [];
let tl = 0;
for (const name of order) {
  const start = tl;
  if (cards[name]) {
    const f = path.join(OUT, 'segments', `${String(++k).padStart(2, '0')}-${name}.mp4`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-t', String(cards[name].seconds), '-i', cards[name].file, '-vf', `scale=${W}:${H},fps=${FPS}`, ...enc, f]);
    pieces.push(f); tl += cards[name].seconds;
  } else {
    for (const r of ranges.filter((x) => x.name === name)) {
      const d = r.b - r.a; if (d < 0.25) continue;
      const f = path.join(OUT, 'segments', `${String(++k).padStart(2, '0')}-${name}.mp4`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', r.a.toFixed(3), '-i', raw, '-t', d.toFixed(3), '-vf', `scale=${W}:${H}:flags=lanczos,fps=${FPS}`, ...enc, f]);
      const real = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
      pieces.push(f); tl += real;
    }
  }
  shotsOut.push({ name, start, end: tl });
}
const list = path.join(OUT, 'segments', 'concat.txt');
fs.writeFileSync(list, pieces.map((f) => `file '${f}'`).join('\n'));
const mp4 = path.join(OUT, 'saysafe-demo.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', mp4]);
const total = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString());
const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate', '-of', 'csv=p=0', mp4]).toString().trim();

// ---------------- Timing + narration ----------------
const timing = writeNarration({ shotsOut, total, probe, raw, ranges });
await browser.close();
log(`\n${mp4}\n${probe} · ${total.toFixed(1)} s · ${timing.totalWords} words`);
for (const r of timing.shots) log(`${r.from}-${r.to} ${r.name.padEnd(9)} ${String(r.seconds).padStart(5)} s  ${r.words} words (${r.wps}/s)`);
if (total >= LIMIT) { console.error(`TOO LONG: ${total.toFixed(1)} s ≥ ${LIMIT} s`); process.exitCode = 1; }
