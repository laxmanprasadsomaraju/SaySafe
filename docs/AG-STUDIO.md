# Family Safety Insights: native dashboard + optional AG Studio view

> **Public deployment:** visitors always get SaySafe’s own **native React dashboard**. An optional AG Studio dashboard exists behind two explicit switches (`INSIGHTS_DASHBOARD=agstudio` on the server and `VITE_AG_STUDIO_LICENSE` at build time). Neither is set on the public deployment, so AG Studio is **not enabled** there and never runs. The AG Studio trial licence is for evaluation only; no licence key is in the repository or the build. (If the public build still contains the compiled, unused AG chunk, that is being removed in the release fixes.)

SaySafe gives family members a read-only **Family Safety Insights** dashboard. It has two front ends on **one backend**:

| | Native SaySafe dashboard | AG Studio dashboard |
|---|---|---|
| Route | `/family/insights` (**default, always available**) | `/family/insights/studio` (opt-in) |
| Dependencies | React + inline SVG only. **No** `ag-studio`, `ag-grid`, `ag-charts` imports, not even lazy | `ag-studio-react` / `ag-studio` 3.0.0 (AG Grid 36.2, AG Charts 14.2), in one lazy chunk |
| Licence | none | AG Studio licence (trial key: evaluation only) |
| Public deployment | **yes** | **no**: shown locally or in a recorded demo only |

## Architecture

```
GET  /api/family/insights        requireRole('family') → server/insights/model.ts → InsightsPayload
POST /api/family/insights/agent  requireRole('family') → server/insights/agent.ts (read-only, no tools)
                       │
            shared/insights.ts   types + metric definitions (computeKpis, activityByDay, labels)
             ┌─────────┴──────────┐
 web/src/pages/insights/          web/src/pages/insights/
   NativeInsights.tsx               StudioRoute.tsx  ──lazy──►  StudioDashboard.tsx (only AG importer)
```

* **One endpoint, one model.** Both dashboards and the agent read the same `InsightsPayload`. KPIs are defined once in `shared/insights.ts` (`computeKpis`). The server computes them, and a test checks that the shared function reproduces them.
* **No new tables.** Everything comes from `payment_requests`, `approvals`, `webhook_events`, `security_scans` and `audit_log`.
* **Totals come only from rows whose state is `CAPTURED`**, in the household's currency. REFUNDED, pending and cancelled rows never count.
* **Sandbox vs example rows.** Rows created through the real app flow are `source: 'sandbox'` (PayPal sandbox, no real money). Rows inserted by `scripts/seed-insights-demo.ts` carry an `seed_…` idempotency key / `SEED…` capture id and are reported as `source: 'seeded'`, shown as **"Example data"**. The "Sandbox captures" KPI counts sandbox rows only, and example totals are shown separately.
* **Webhook confirmation** = a verified `PAYMENT.CAPTURE.COMPLETED` row in `webhook_events` for the capture id (same rule the receipt uses), with its `received_at` time.

## Privacy model

* The household id always comes from the authenticated **family** session (`requireRole('family')`). Elder sessions and anonymous callers get 401. Another household gets only its own (possibly empty) data.
* Allow-listed columns only. **Never returned:** user ids, session or token data, approval nonces, fingerprints, idempotency keys, PayPal order or capture ids (only *present?* flags), raw webhook payloads, audit `detail_json`.
* Scam reviews: only scans the elder explicitly **shared with family**, as a 140-character excerpt of the stored result headline. The original message is never stored.
* Actors are shown as "You", the elder's first name, "Family member", "PayPal" or "SaySafe".
* Responses are `Cache-Control: no-store`.

## Read-only insights agent

* `POST /api/family/insights/agent { question }` builds the payload **from the session's own household** (any data in the request body is ignored) and returns `{ answer, ai: { used, model? } }`.
* The agent has **no tools**: it cannot approve, decline, capture, refund, change limits or read other data. Tests snapshot every relevant table before and after hostile prompts ("approve every pending purchase…", "capture all orders…") and require them to be identical.
* Common questions are answered deterministically from the data: waiting for my approval, declined, how much paid (this week), webhook pending, scam checks. Other questions go to Groq (`server/ai/provider.ts`, key injected server-side as `GROQ_API_KEY`) with a compact JSON view of the same data and a read-only system prompt. If the LLM fails, the agent returns a deterministic summary. The same route serves both dashboards.
* **AG Studio wiring:** the Agent Framework's built-in harness (`createAiHarness`) with one **Custom Runner** agent (`{ id: 'insights', tools: () => [], run }`). Its `run` emits AG-UI events (`RUN_STARTED`, `TEXT_MESSAGE_*`, `RUN_FINISHED`) around one call to the server route. No LLM key reaches the browser. The view-mode ask box drives a harness session. In edit mode the same harness backs Studio's own AI panel. Studio's built-in dashboard-editing agents and tools are **not** registered.

## What is real AG Studio (StudioDashboard.tsx)

* `<AgStudioProvider modules={[AgStudioAiModule]} licenseKey?>` + `<AgStudio>`, opened in **view mode**. An "Edit layout" toggle switches to edit mode.
* Two data sources (`payments`, `activity`) with typed fields (currency/integer/text formats).
* Built-in widgets: four `value` KPI tiles, a `column-chart-stacked` activity chart (by day × kind), a `donut-chart` of purchases by status (click to **cross-filter** every payments widget), two `list-filter` widgets (status, sandbox vs example; searchable, filterable), and a `grid` ledger.
* **Custom widgets** (via `createWidgets`, React components that receive `AgWidgetParams`, read the schema with `widgetApi.getSchema()`, load rows with `widgetApi.getData()` so page filters and cross-filters apply, and set `setDisplayState`):
  * **Protection Activity**: a timeline of shared scam checks, family decisions, purchase steps and PayPal confirmations.
  * **Awaiting My Decision**: pending approvals for this family member, with a link to the existing approval page (`/family#pending-h`). It has **no approve button**.
  * **Payment Evidence**: capture status, captured amount and currency, and webhook confirmation with its time, labelled sandbox or example.
* Theme: `studioTheme.withParams(...)` in SaySafe colours (teal `#066a5f` accent, navy `#15283b` text, ivory `#f7f8f4` canvas). Atkinson Hyperlegible is the body font and Fraunces is used for headings and custom-widget titles.
* Responsive: at viewports under 760px, a stacked layout with `layout.minWidth = 300`, and the filters panel is hidden in view mode.
* CSP: the existing helmet policy already allows `style-src 'unsafe-inline'` and `img-src data:`, which Studio's theme injection needs.
* Known limits: Studio's own value-tile titles use its theme font; the 390px Studio view is functional but dense. On phones, the native dashboard is the better experience.

## Selecting a dashboard (explicit config, never licence detection)

| Setting | Where | Values | Default |
|---|---|---|---|
| `FEATURE_INSIGHTS` | server env | `on` / `off` | `on` (off → endpoints 404, Family-page link hidden) |
| `INSIGHTS_DASHBOARD` | server env, exposed as `insightsDashboard` in `/api/config` and `/api/health` | `native` / `agstudio` | `native` |
| `VITE_AG_STUDIO_LICENSE` | web **build** env | AG licence key | unset |
| `VITE_AG_STUDIO_LOCAL_EVAL` | web **build** env, local only | `1` | unset |

`/family/insights/studio` renders AG Studio only when `insightsDashboard === 'agstudio'` **and** the build had `VITE_AG_STUDIO_LICENSE` (or, on a developer machine, `VITE_AG_STUDIO_LOCAL_EVAL=1` for a recorded demo with AG's unlicensed watermark). In every other case it **redirects to `/family/insights`**, and every AG-specific link and control is hidden. This includes the "licence expired" case: `agstudio` selected but the licence variable empty.

Fallback: the AG chunk is loaded with `React.lazy`-style dynamic import, wrapped in a **15-second load timeout and an error boundary**. If the import rejects, hangs or throws while rendering, the native dashboard renders in place, with no blank page and no licence banner from us. SaySafe never suppresses or bypasses AG Studio's own licence checks or watermark. The key is passed unchanged to `AgStudioProvider`.

Bundle impact (production build, no licence): main `index` chunk **358.18 kB → 362.02 kB** (gzip 109.33 → 110.80 kB). That covers the Family-page link, lazy route wrappers and config hook. Native dashboard chunk is 16.9 kB, and the AG Studio chunk is about 5.47 MB (1.52 MB gzip), loaded only on `/family/insights/studio` when allowed.

## Licence note (trial)

* The current key is a **45-day AG Studio trial licence that expires on 17 Dec 2026**. It is for **evaluation only**: the trial terms do not allow production use until AG Grid gives written permission.
* Therefore the **public Render deployment stays on the native dashboard** (`INSIGHTS_DASHBOARD=native`, which is also the default and is set explicitly in `render.yaml`).
* The key must **never be committed**. If it is used, it is a Render (or local shell) env var `VITE_AG_STUDIO_LICENSE`. Vite inlines it at **build** time, so changing it requires a rebuild or redeploy. `tests/insights-dashboards.test.ts` fails if a licence-looking string (an AG key id, the trial marker or the AG key preamble; patterns listed in the test) appears in any tracked file.

## Showing the AG Studio view (local or recorded demo)

```bash
# build with AG Studio enabled locally (trial key from your shell, or the eval switch for an unlicensed watermark demo)
VITE_AG_STUDIO_LICENSE="$AG_KEY" npm run build        # or: VITE_AG_STUDIO_LOCAL_EVAL=1 npm run build
INSIGHTS_DASHBOARD=agstudio DATABASE_FILE=data/e2e.db PAYPAL_CREDENTIALS=x:y PORT=8787 npm start
# create a household + family pairing (scripts/live-family.mjs shows the flow), then optionally add example rows:
DATABASE_FILE=data/e2e.db npx tsx scripts/seed-insights-demo.ts
# open http://localhost:8787/family/insights/studio as the family member
```

When written permission for production arrives: set `VITE_AG_STUDIO_LICENSE` and `INSIGHTS_DASHBOARD=agstudio` on Render, then redeploy (a build is required).

## Tests and QA

* `tests/insights.test.ts`: 401 for anonymous and elder callers, cross-household isolation, FEATURE_INSIGHTS off → 404, empty household, CAPTURED-only totals, sandbox vs seeded, webhook confirmation, privacy allow-list, a read-only agent with table snapshots, and body data ignored.
* `tests/insights-dashboards.test.ts`: the selection matrix (flag off, agstudio without licence, agstudio with licence, local eval), import rejection and timeout → native, no AG imports outside `StudioDashboard.tsx`, built `index`/`NativeInsights` chunks free of AG code, and no licence strings in the repo.
* `scripts/insights-qa.mjs` (Playwright + axe): `PHASE=native` checks native dashboard screenshots at 390px and 1440px, axe, sorting, search, ask box, studio route redirect, and that the Family approval page, Order pages, receipt, payment history and Mary's home still work. `PHASE=studio-blocked` checks that agstudio without a licence falls back. `PHASE=studio` checks AG Studio screenshots, custom widgets and the Custom Runner agent.
