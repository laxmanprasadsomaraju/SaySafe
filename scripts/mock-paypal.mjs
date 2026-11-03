// LOCAL QA ONLY: a tiny fake of the PayPal sandbox REST endpoints SaySafe calls, so the in-Assistant purchase flow can be
// driven end to end without PayPal keys. It is NOT PayPal: approve links point at sandbox.paypal.com (the browser test
// stops there), approval is simulated with POST /mock/approve/:orderId, and webhook signatures always FAIL to verify
// (so receipts honestly show "Verification pending").
// Subscriptions v1 (SaySafe Demo Membership): create -> APPROVAL_PENDING + approve link, POST /mock/approve-sub/:id -> ACTIVE
// (returns PayPal's return URL), cancel -> 204 then GET shows CANCELLED. POST /mock/sub-cancel-mode/500 makes cancel fail once.
// GET /mock/sub/:id shows the mock's own status (for tests).
//   node scripts/mock-paypal.mjs 9999
//   PAYPAL_API_BASE=http://127.0.0.1:9999 PAYPAL_ALLOW_LIVE=yes PAYPAL_CLIENT_ID=mock PAYPAL_CLIENT_SECRET=mock npx tsx server/index.ts
import http from 'node:http';
const PORT = Number(process.argv[2] ?? 9999);
const orders = new Map(); const captures = new Map(); const subs = new Map(); let subCancelFail = 0;
const rid = (p) => p + Math.random().toString(36).slice(2, 12).toUpperCase();
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : {};
    const u = new URL(req.url, 'http://x'); const m = (re) => u.pathname.match(re);
    if (req.method === 'POST' && u.pathname === '/v1/oauth2/token') return send(res, 200, { access_token: 'mock-token', expires_in: 3600 });
    if (req.method === 'POST' && u.pathname === '/v2/checkout/orders') {
      const id = rid('MOCK'); const pu = body.purchase_units[0];
      const o = { id, status: 'CREATED', purchase_units: [{ reference_id: pu.reference_id, custom_id: pu.custom_id, amount: { currency_code: pu.amount.currency_code, value: pu.amount.value } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }], return_url: body.payment_source?.paypal?.experience_context?.return_url };
      orders.set(id, o); return send(res, 201, o);
    }
    let x;
    if (req.method === 'POST' && (x = m(/^\/mock\/approve\/([A-Z0-9]+)$/))) { const o = orders.get(x[1]); if (!o) return send(res, 404, {}); o.status = 'APPROVED'; return send(res, 200, { ok: true, returnUrl: `${o.return_url}&token=${o.id}` }); }
    if (req.method === 'GET' && (x = m(/^\/v2\/checkout\/orders\/([A-Z0-9]+)$/))) { const o = orders.get(x[1]); return o ? send(res, 200, o) : send(res, 404, { name: 'RESOURCE_NOT_FOUND' }); }
    if (req.method === 'POST' && (x = m(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/))) {
      const o = orders.get(x[1]); if (!o) return send(res, 404, {});
      if (o.status === 'COMPLETED') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      if (o.status !== 'APPROVED') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
      const cap = { id: rid('MOCKCAP'), status: 'COMPLETED', amount: o.purchase_units[0].amount, create_time: new Date().toISOString(), custom_id: o.purchase_units[0].custom_id };
      captures.set(cap.id, cap); o.status = 'COMPLETED'; o.purchase_units[0].payments = { captures: [cap] };
      return send(res, 201, o);
    }
    if (req.method === 'GET' && (x = m(/^\/v2\/payments\/captures\/([A-Z0-9]+)$/))) { const c = captures.get(x[1]); return c ? send(res, 200, c) : send(res, 404, {}); }
    if (req.method === 'POST' && u.pathname === '/v1/billing/subscriptions') {
      const id = 'I-' + rid('MOCK'); const ac = body.application_context ?? {};
      const s = { id, status: 'APPROVAL_PENDING', plan_id: body.plan_id, custom_id: body.custom_id, status_update_time: new Date().toISOString(), links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${id}` }], return_url: ac.return_url };
      subs.set(id, s); return send(res, 201, s);
    }
    if (req.method === 'POST' && (x = m(/^\/mock\/approve-sub\/(I-[A-Z0-9]+)$/))) { const s = subs.get(x[1]); if (!s) return send(res, 404, {}); s.status = 'ACTIVE'; s.billing_info = { next_billing_time: new Date(Date.now() + 30 * 86400000).toISOString() }; return send(res, 200, { ok: true, returnUrl: `${s.return_url}?subscription_id=${s.id}&ba_token=BA-${s.id}&token=MOCKTOKEN` }); }
    if (req.method === 'POST' && (x = m(/^\/mock\/sub-cancel-mode\/(\d+)$/))) { subCancelFail = Number(x[1]) >= 500 ? 1 : 0; return send(res, 200, { ok: true }); }
    if (req.method === 'GET' && (x = m(/^\/mock\/sub\/(I-[A-Z0-9]+)$/))) { const s = subs.get(x[1]); return s ? send(res, 200, { id: s.id, status: s.status }) : send(res, 404, {}); }
    if (req.method === 'GET' && (x = m(/^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)$/))) { const s = subs.get(x[1]); if (!s) return send(res, 404, { name: 'RESOURCE_NOT_FOUND' }); const { return_url, ...pub } = s; return send(res, 200, pub); }
    if (req.method === 'POST' && (x = m(/^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)\/cancel$/))) {
      const s = subs.get(x[1]); if (!s) return send(res, 404, { name: 'RESOURCE_NOT_FOUND' });
      if (subCancelFail) { subCancelFail = 0; return send(res, 500, { name: 'INTERNAL_SERVER_ERROR' }); }
      if (s.status !== 'ACTIVE' && s.status !== 'SUSPENDED') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'SUBSCRIPTION_STATUS_INVALID' }] });
      s.status = 'CANCELLED'; s.status_update_time = new Date().toISOString(); res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && u.pathname === '/v1/notifications/verify-webhook-signature') return send(res, 200, { verification_status: 'FAILURE' });
    send(res, 404, { name: 'NOT_MOCKED', path: u.pathname });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock PayPal on ${PORT}`));
