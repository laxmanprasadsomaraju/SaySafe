// LOCAL QA ONLY: serves the recorded Channel3 response (tests/fixtures/channel3-microwave.json) for POST /v1/search,
// so the Assistant's real-shop cards can be exercised without a Channel3 key. It is NOT Channel3: every query gets the
// same recorded listings (microwaves). Results from it are labelled "stubbed Channel3" in scripts/e2e-demo.mjs.
//   node scripts/mock-channel3.mjs 9998   then   CHANNEL3_API_BASE=http://127.0.0.1:9998 CHANNEL3_API_KEY=mock npx tsx server/index.ts
import http from 'node:http';
import fs from 'node:fs';
const body = fs.readFileSync(new URL('../tests/fixtures/channel3-microwave.json', import.meta.url));
http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1/search') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(body); }
    res.writeHead(404); res.end();
  });
}).listen(Number(process.argv[2] ?? 9998), '127.0.0.1');
