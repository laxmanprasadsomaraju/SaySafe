// LOCAL QA ONLY: serves the recorded Channel3 response (tests/fixtures/channel3-microwave.json) for POST /v1/search,
// so the Assistant's real-shop cards can be exercised without a Channel3 key. It is NOT Channel3: every query gets the
// same recorded listings (microwaves), except t-shirt queries (a second recording). Results from it are labelled "stubbed Channel3" in scripts/e2e-demo.mjs.
//   node scripts/mock-channel3.mjs 9998   then   CHANNEL3_API_BASE=http://127.0.0.1:9998 CHANNEL3_API_KEY=mock npx tsx server/index.ts
import http from 'node:http';
import fs from 'node:fs';
const body = fs.readFileSync(new URL('../tests/fixtures/channel3-microwave.json', import.meta.url));
// Second recorded response (real Channel3 /v1/search for "nike t-shirt", IE/EUR, recorded 3 Nov 2026 ~17:45 GMT): served
// for queries that mention a t-shirt, so the "not in the Demo Shop → real listings" path can be tested end to end.
const tshirt = fs.readFileSync(new URL('../tests/fixtures/channel3-nike-tshirt.json', import.meta.url));
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let q = ''; try { q = String(JSON.parse(raw || '{}').query ?? ''); } catch { /* */ }
    if (req.method === 'POST' && req.url === '/v1/search') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(/t-?shirt/i.test(q) ? tshirt : body); }
    res.writeHead(404); res.end();
  });
}).listen(Number(process.argv[2] ?? 9998), '127.0.0.1');
