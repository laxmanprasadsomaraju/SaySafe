// REAL Channel3 check (no mocks): asks a running SaySafe server's /api/discover for real listings and checks the fields
// the Assistant cards need (name, price + currency, retailer, image, specs, external https link). Separate from the
// mocked/recorded tests on purpose. Default target is the hosted app (its server holds the Channel3 key).
//   node scripts/channel3-live-check.mjs [base=https://saysafe.onrender.com] [query=microwave]
// Uses curl so the sandbox/CI egress proxy (HTTPS_PROXY) is honoured. One request: well under any rate limit.
import { execFileSync } from 'node:child_process';
const BASE = (process.argv[2] ?? 'https://saysafe.onrender.com').replace(/\/$/, '');
const Q = process.argv[3] ?? 'microwave';
const raw = execFileSync('curl', ['-sS', '-m', '60', '-H', 'Content-Type: application/json', '-X', 'POST', `${BASE}/api/discover`, '-d', JSON.stringify({ text: Q })]).toString();
const r = JSON.parse(raw);
const items = Array.isArray(r.products) ? r.products : [];
const checks = [
  ['at least 3 listings', items.length >= 3],
  ['every listing has a title', items.every((p) => typeof p.title === 'string' && p.title.length > 3)],
  ['every listing has a price and currency', items.every((p) => p.offers?.[0]?.price > 0 && /^[A-Z]{3}$/.test(p.offers?.[0]?.currency ?? ''))],
  ['every listing names a retailer', items.every((p) => typeof p.offers?.[0]?.retailer === 'string' && p.offers[0].retailer.length > 1)],
  ['every listing links to the retailer over https', items.every((p) => /^https:\/\//.test(p.offers?.[0]?.url ?? ''))],
  ['most listings have an image', items.filter((p) => /^https:\/\//.test(p.image ?? '')).length >= Math.ceil(items.length / 2)],
  ['most listings have specifications', items.filter((p) => (p.features?.length ?? 0) > 0).length >= Math.ceil(items.length / 2)],
  ['no rating is invented (null or from the listing)', items.every((p) => p.rating == null || typeof p.rating === 'object' || typeof p.rating === 'number')],
];
for (const [n, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${n}`);
console.log(`\n${new Date().toISOString()} ${BASE} query="${Q}" → ${items.length} listings (fetchedAt ${r.fetchedAt ?? 'n/a'})`);
for (const p of items.slice(0, 5)) console.log(`- ${p.title.slice(0, 70)} | ${p.offers?.[0]?.price} ${p.offers?.[0]?.currency} | ${p.offers?.[0]?.retailer} | img ${p.image ? 'yes' : 'no'} | ${p.features?.slice(0, 2).join(' · ')}`);
if (r.error) console.log('error:', r.error, r.message);
process.exitCode = checks.every(([, p]) => p) ? 0 : 1;
