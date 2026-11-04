# Learn SaySafe docs site, screenshots and demo video

The documentation lives inside the app (same design, same Layout):

| Route | What |
|---|---|
| `/learn` | Learn SaySafe hub: 15 sections (Getting Started … Troubleshooting), client-side search over guide titles and text, How SaySafe works, use cases, privacy, FAQ |
| `/learn/:slug` | The 14 guides (numbered steps, exact prompts, screenshots with click-to-enlarge) |
| `/judges` | Judge’s Guide — Test SaySafe in 5 Minutes (13 steps) |
| `/features` | Every implemented feature (Before / During / After / Everywhere) with problem, example, access, integration, data, limits; Roadmap |
| `/help` | Unchanged support page (official PayPal help, order problems, family codes), linking to `/learn` |

Content is one typed source: `web/src/learn/content.ts` (guides, Judge’s steps, sections, FAQ, privacy) and
`web/src/learn/features.ts`. `tests/learn-docs.test.ts` checks the structure, that every referenced screenshot exists,
and the wording rules (no credentials, never “safe”, no endorsement / wallet / transfer / fraud-prevention claims,
voice and language claims only as tested).

## Screenshots: one command

The published guide images are taken from the hosted app only (`source: "hosted"` in the manifest). No local or mock
screenshots are shipped.

```bash
# hosted (real Channel3; this sandbox reaches it through the HTTPS proxy)
NODE_USE_ENV_PROXY=1 node scripts/shots-docs.mjs https://saysafe.onrender.com
npm run build   # the pages read web/public/docs-assets/manifest.json at build time; commit docs-assets + manifest
```

- Files: `web/public/docs-assets/<guide>/<nn>-<slug>-<w>.webp` (w = 390 phone at 2x, 1440 desktop), plus `manifest.json`
  (source, base URL, commit, time taken).
- The PayPal-hosted login/approval page is never captured. The buyer login is read from the environment only
  (`PAYPAL_BUYER_EMAIL`, `PAYPAL_BUYER_PASSWORD`); without it the run creates no PayPal order and the receipt shots are
  skipped.
- Receipt shots (back from PayPal, receipt card, receipt page, timeline) need a completed sandbox payment, so they are
  not in the current set; the guides describe those steps in text. A shot that can't be taken from the hosted app is
  dropped, never replaced by a mock.
- Product photos in Channel3 listings come from `cdn.trychannel3.com`, which the sandbox browser can't load, so they
  may appear blank in the listing screenshots.
- The script can still run against a local build (`node scripts/shots-docs.mjs http://127.0.0.1:8792`, mock PayPal,
  stamped "local test build") for checking layout, but those images are not published.
- `ONLY=g05,g07` re-shoots selected guides.

## QA

```bash
node scripts/docs-qa.mjs http://127.0.0.1:8792            # links + anchors + external links, axe at 320/390/1024/1440, keyboard, dialog
npx tsx scripts/docs-walkthrough.mjs http://127.0.0.1:8792 # follows /judges literally on the local build (mock PayPal)
```

## Demo video: one command

```bash
# validation on the local build (mock PayPal: ids hidden, banner on every app frame)
OUT=/tmp/saysafe-video node scripts/record-demo.mjs http://127.0.0.1:8792
# the real video, after the final deploy
OUT=<dir> PAYPAL_BUYER_EMAIL=… PAYPAL_BUYER_PASSWORD=… node scripts/record-demo.mjs https://saysafe.onrender.com
```

Writes `saysafe-demo.mp4` (1920×1080, H.264, 30 fps, silent, under 2:55), `timing.json` (every shot with its start/end and
the kept raw ranges) and `narration.md` (timestamp → on screen → exact words → caption), regenerated from the actual cut.
PayPal’s page is not recorded: approval happens in a separate, non-recording browser context; the video shows a 5 s
“PayPal Sandbox checkout” card and then the real return and receipt. Server/AI waits are cut, never sped up.
