# UI quality: visual regression, accessibility audit and screenshots

Three scripts check the look and accessibility of the app on a **deterministic local stack**
(`scripts/local-stack.sh`): the built web app and API on :8787, the MOCK PayPal on :9999, the recorded
Channel3 response on :9998, no AI key (rules-only answers) and a fresh database on every start.

```bash
npm run build
scripts/local-stack.sh                    # start (stop with: scripts/local-stack.sh stop)

node scripts/visual-regression.mjs        # pixel-diff against tests/visual/*.png, exit 1 on any difference
node scripts/visual-regression.mjs --update   # accept the current look as the new baselines (review the PNGs first)
ONLY=profile,home node scripts/visual-regression.mjs

node scripts/a11y-audit.mjs               # axe + keyboard order + focus + zoom reflow + reduced motion → $OUT/a11y-report.json
OUT=shots node scripts/ui-shots.mjs       # every page at 320/375/390/768/1024/1280/1440 → shots/<page>-<width>.png + layout.json
```

Restart the stack between runs if you hit the "Try as Alex" rate limit (10 per 15 minutes per IP). The flagship e2e makes
more than 120 API calls a minute from one IP; start its stack with `API_LIMIT_PER_MIN=1000` (local only) so the API
rate limit doesn't stall it.

If something else already listens on :8787 (another checkout's server), the stack's API cannot bind and the scripts
silently test that other build. Check with `curl -s localhost:8787/ | grep -o 'assets/index-[^"]*'` against your
`web/dist`, or use another port: `PORT=8788 STACK_DIR=/tmp/saysafe-stack-2 scripts/local-stack.sh` and
`BASE=http://127.0.0.1:8788 node scripts/visual-regression.mjs`.

## Visual regression (`scripts/visual-regression.mjs`)

- Pages: landing, Home, Activity, Profile, Help (first 6000 px), Assistant with subscription + contact cards,
  scam result, product results, order waiting for family, family review (Alex), Family Safety Insights.
- Widths: 390 px (phone) and 1440 px (desktop). Baselines are committed in `tests/visual/`.
- Comparator: Playwright's own screenshot comparator (the one behind `expect(page).toHaveScreenshot()`,
  pixelmatch, threshold 0.2), allowing at most 0.2 % differing pixels for anti-aliasing noise.
- Determinism: fixed browser clock (3 Nov 2026 10:00 Europe/Dublin), `en-IE`, reduced motion, spoken replies off (the default for
  every visitor: SaySafe only speaks after the person presses “Turn on spoken replies”, saved as `spokenOptIn`),
  lazy images forced to load, and dates/times/ids that come from server timestamps replaced with fixed text
  before capture. Layout is under test, not the clock.
- On a difference it writes `<page>-<width>.actual.png` and `.diff.png` next to the baseline (git-ignored).
- Font rendering differs between operating systems: regenerate baselines on the machine/CI image that runs the
  check (`--update`), and review them by eye before committing.

## Accessibility audit (`scripts/a11y-audit.mjs`)

- axe-core with `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` on every main page at 390 and 1440 px.
- Keyboard: tabs through Profile and the Assistant (with cards), records the focus order and fails any stop
  without a visible focus indicator.
- Reflow: horizontal overflow at 320 px (= 400 % zoom of a 1280 px window) and 640 px (= 200 %), plus the
  same sizes at device-pixel-ratio 2 and 4, and how much of the screen fixed bars cover there.
- Reduced motion: the system setting and Profile › Reduce motion both remove animation.
- Automated checks are a floor, not proof: also test with a screen reader and real zoom.

## Design-system recipes

Shared class recipes live in `web/src/components/ds.ts` and are built only from the tokens in
`web/src/index.css` (`@theme`): card surface + padding, quiet panel, buttons (primary, secondary, danger,
outline), link rows, inputs, the On/Off switch and status pills. Use them instead of re-typing class strings.
