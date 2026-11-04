// LOCAL QA ONLY: serves RECORDED Channel3 responses for POST /v1/search so the Assistant's real-shop cards can be
// exercised without a Channel3 key. It is NOT Channel3. Recordings (real /v1/search responses, IE/EUR):
//   tests/fixtures/channel3-microwave.json (default), channel3-nike-tshirt.json (men's "nike t-shirt", 3 Nov 2026),
//   channel3-nike-women-tshirt.json (gender=female + Nike brand id + max €40, 4 Nov 2026), channel3-kettle.json and
//   channel3-ps5.json (4 Nov 2026, recorded by the Assistant repair live run).
//   node scripts/mock-channel3.mjs 9998 [ok|fail|malformed|slow]
// GET /v1/brands/search answers Nike only (id MpZS, as the real API does); anything else -> no brands.
// Mode "fail" answers 503 to every search, "malformed" answers 200 with non-JSON, "slow" waits 15 s (client timeout is 12 s).
import http from 'node:http';
import fs from 'node:fs';
const read = (f) => { try { return fs.readFileSync(new URL(`../tests/fixtures/${f}`, import.meta.url)); } catch { return null; } };
const body = read('channel3-microwave.json');
const tshirt = read('channel3-nike-tshirt.json');
const womenTshirt = read('channel3-nike-women-tshirt.json') ?? tshirt;
const kettle = read('channel3-kettle.json') ?? body;
const ps5 = read('channel3-ps5.json') ?? body;
const mode = process.argv[3] ?? 'ok';
let searches = 0;
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/brands/search')) {
      const q = new URL(req.url, 'http://x').searchParams.get('query') ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ brands: /^nike$/i.test(q) ? [{ id: 'MpZS', name: 'Nike' }] : [] }));
    }
    if (req.method === 'GET' && req.url === '/__count') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ searches })); }
    let q = ''; let filters = {};
    try { const j = JSON.parse(raw || '{}'); q = String(j.query ?? ''); filters = j.filters ?? {}; } catch { /* */ }
    if (req.method === 'POST' && req.url === '/v1/search') {
      searches++;
      if (mode === 'fail') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"detail":"unavailable"}'); }
      if (mode === 'malformed') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('<html>oops</html>'); }
      const send = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(/t-?shirt/i.test(q) ? (filters.gender === 'female' ? womenTshirt : tshirt) : /kettle/i.test(q) ? kettle : /ps5|playstation/i.test(q) ? ps5 : body); };
      return mode === 'slow' ? setTimeout(send, 15000) : send();
    }
    res.writeHead(404); res.end();
  });
}).listen(Number(process.argv[2] ?? 9998), '127.0.0.1');
