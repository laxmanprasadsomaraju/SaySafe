// Two independent sessions (Mary = elder, Alex = family) plus an outsider household, against a running server.
// Usage: BASE=https://saysafe.onrender.com node scripts/live-family.mjs
// Expiry and changed-basket invalidation need clock/DB control and are covered by tests/payments.test.ts and tests/security.test.ts.
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
function client(label) {
  const jar = new Map();
  return async function call(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json, label };
  };
}
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const mary = client('mary'), alex = client('alex'), eve = client('outsider');
await mary('POST', '/api/demo/start', { name: 'Mary' });
await eve('POST', '/api/demo/start', { name: 'Eve' });
const inv = await mary('POST', '/api/family/invite', {});
const code = inv.json?.code;
const pair = await alex('POST', '/api/family/pair', { code, name: 'Alex' });
check('Alex pairs from a separate session with Mary\'s one-time code', pair.status === 200);
const reuse = await eve('POST', '/api/family/pair', { code, name: 'Eve' });
check('Pairing code cannot be reused by another session', reuse.status === 400, `status ${reuse.status}`);

const policy = (await alex('GET', '/api/family/overview')).json?.policy;
check('Mary\'s threshold is €75', policy?.thresholdCents === 7500, JSON.stringify(policy));

const k = () => `live-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const a = await mary('POST', '/api/payments', { items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: k() });
const reqA = a.json?.request;
check('€120 microwave waits for family approval', reqA?.state === 'FAMILY_APPROVAL_PENDING' && reqA?.amountCents === 12000, `${reqA?.state} ${reqA?.amountCents} ${reqA?.currency}`);
const early = await mary('POST', `/api/payments/${reqA?.id}/checkout`, {});
check('Mary cannot go to PayPal while approval is pending', early.status >= 400, `status ${early.status}`);

const ov = (await alex('GET', '/api/family/overview')).json;
const seen = ov?.requests?.find((r) => r.id === reqA?.id);
check('Alex sees exact product, merchant, amount and currency', !!seen && seen.items?.[0]?.name && seen.merchant && seen.amountCents === 12000 && seen.currency === 'EUR', seen ? `${seen.items?.[0]?.name} | ${seen.merchant} | ${seen.amountCents} ${seen.currency}` : 'missing');

const self = await mary('POST', `/api/family/requests/${reqA?.id}/decision`, { decision: 'approve', approvalId: reqA?.approval?.id });
check('Mary cannot approve her own purchase', self.status === 401 || self.status === 403, `status ${self.status}`);
const cross = await eve('POST', `/api/family/requests/${reqA?.id}/decision`, { decision: 'approve', approvalId: reqA?.approval?.id });
check('Outsider session cannot approve', cross.status === 401 || cross.status === 403 || cross.status === 404, `status ${cross.status}`);
const peek = await eve('GET', `/api/payments/${reqA?.id}`);
check('Outsider cannot read Mary\'s payment', peek.status === 404 || peek.status === 401 || peek.status === 403, `status ${peek.status}`);
const anon = await client('anon')('POST', `/api/family/requests/${reqA?.id}/decision`, { decision: 'approve', approvalId: reqA?.approval?.id });
check('Unauthenticated approval is rejected', anon.status === 401 || anon.status === 403, `status ${anon.status}`);
const forged = await alex('POST', `/api/family/requests/${reqA?.id}/decision`, { decision: 'approve', approvalId: 'apr_forged123' });
check('Forged approval id is rejected', forged.status === 404, `status ${forged.status}`);

const dec = await alex('POST', `/api/family/requests/${reqA?.id}/decision`, { decision: 'decline', approvalId: reqA?.approval?.id, reason: 'Let\'s talk first' });
check('Alex declines', dec.status === 200 && dec.json?.state === 'CANCELLED', `${dec.status} ${dec.json?.state}`);
const after = await mary('POST', `/api/payments/${reqA?.id}/checkout`, {});
check('Declined purchase cannot reach PayPal', after.status >= 400, `status ${after.status}`);

const b = await mary('POST', '/api/payments', { items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: k() });
const reqB = b.json?.request;
const ok = await alex('POST', `/api/family/requests/${reqB?.id}/decision`, { decision: 'approve', approvalId: reqB?.approval?.id });
check('Alex approves the exact second request', ok.status === 200 && ok.json?.state === 'FAMILY_APPROVED', `${ok.status} ${ok.json?.state}`);
const replay = await alex('POST', `/api/family/requests/${reqB?.id}/decision`, { decision: 'decline', approvalId: reqB?.approval?.id });
check('Used approval cannot be replayed or reversed', replay.status === 409, `status ${replay.status}`);
const alexPays = await alex('POST', `/api/payments/${reqB?.id}/checkout`, {});
check('Alex cannot pay on Mary\'s behalf', alexPays.status === 401 || alexPays.status === 403, `status ${alexPays.status}`);
const co = await mary('POST', `/api/payments/${reqB?.id}/checkout`, {});
const approveHost = co.json?.approveUrl ? new URL(co.json.approveUrl).host : null;
check('Approved request still sends Mary to PayPal to authorise', co.status === 200 && /paypal\.com$/.test(approveHost ?? ''), `${co.status} ${approveHost} state=${co.json?.request?.state}`);
const orderId = co.json?.approveUrl ? new URL(co.json.approveUrl).searchParams.get('token') : 'NOORDER00000';
const confirmEarly = await mary('POST', `/api/payments/${reqB?.id}/confirm`, { orderId });
check('Capture refused before Mary approves at PayPal', confirmEarly.status >= 400 || confirmEarly.json?.state !== 'CAPTURED', `status ${confirmEarly.status} ${confirmEarly.json?.state ?? confirmEarly.json?.error}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed against ${BASE}`);
process.exit(failed ? 1 : 0);
