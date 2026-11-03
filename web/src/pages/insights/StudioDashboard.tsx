/**
 * AG Studio "Family Safety Insights" dashboard (lazy chunk, only reachable via StudioRoute).
 * The ONLY file in the app that imports ag-studio / ag-studio-react.
 *
 * - Data: GET /api/family/insights (same endpoint as the native dashboard) → two Studio data sources.
 * - Widgets: built-in value tiles, stacked column chart, donut, list filters and grid (cross-filtering),
 *   plus three custom widgets (Protection Activity, Awaiting My Decision, Payment Evidence).
 * - AI: Studio Agent Framework with a Custom Runner whose loop is our server route
 *   POST /api/family/insights/agent. The agent has NO tools, so it can only answer in text.
 * - Licence: VITE_AG_STUDIO_LICENSE is passed to AgStudioProvider only when set. Never hard-coded.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, createAiHarness, studioTheme, type AgAiAgentRunner, type AgAiChatSession, type AgAiEvent, type AgAiHarness, type AgStudioMode, type AgWidgetField, type AgWidgetParams } from 'ag-studio';
import { Layout } from '../../components/Layout';
import { Button, Notice, PageTitle } from '../../components/ui';
import { askInsights, useInsights } from '../../lib/insightsApi';
import { agStudioLicenseKey } from '../../lib/insightsChoice';
import { EVENT_KIND_LABELS, money, type InsightsPayload } from '../../../../shared/insights';

// ---------- Theme: SaySafe ivory / navy / teal ----------
const SANS = "'Atkinson Hyperlegible Next', system-ui, sans-serif";
const SERIF = "'Fraunces Variable', Georgia, serif";
const theme = studioTheme.withParams({
  accentColor: '#066a5f',
  backgroundColor: '#ffffff',
  foregroundColor: '#15283b',
  borderColor: '#dfe5df',
  browserColorScheme: 'light',
  fontFamily: SANS,
  fontSize: 15,
  chartFontFamily: SANS,
  gridFontFamily: SANS,
  studioPanelHeaderFontFamily: SERIF,
});

// ---------- Data sources ----------
function toSources(d: InsightsPayload) {
  const payments = d.payments.map((p) => ({
    ref: p.id.slice(-6),
    id: p.id,
    created: p.createdAt.slice(0, 16).replace('T', ' ') + ' UTC',
    day: p.day,
    product: p.product,
    merchant: p.merchant,
    amount: p.amount,
    currency: p.currency,
    status: p.stateLabel,
    source: p.source === 'sandbox' ? 'PayPal sandbox' : 'Example data',
    approval: p.approvalStatus ?? 'not needed',
    awaiting: p.awaitingMyDecision ? 1 : 0,
    expires: p.approvalExpiresAt ?? '',
    paidTotal: p.state === 'CAPTURED' && (p.capturedCurrency ?? p.currency) === d.currency ? (p.capturedAmount ?? p.amount) : 0,
    paidCount: p.state === 'CAPTURED' ? 1 : 0,
    declined: p.approvalStatus === 'declined' ? 1 : 0,
    capture: p.hasCapture ? 'Captured' : p.hasPayPalOrder ? 'Order created' : 'No PayPal order',
    capturedAmount: p.capturedAmount ?? 0,
    capturedCurrency: p.capturedCurrency ?? '',
    webhook: p.hasCapture ? (p.webhookConfirmed ? 'Confirmed' : 'Pending') : 'n/a',
    webhookAt: p.webhookConfirmedAt ?? '',
  }));
  const activity = [
    ...d.events.map((e) => ({ id: e.id, at: e.at, day: e.day, kind: EVENT_KIND_LABELS[e.kind], label: e.label, actor: e.actor, events: 1 })),
  ];
  const scans = d.scans.length;
  const t = (id: string, name: string, format: string, extra: Record<string, unknown> = {}) => ({ id, name, format, ...extra });
  const eurFmt = { format: new Intl.NumberFormat('en-IE', { style: 'currency', currency: d.currency }) };
  return {
    description: `Read-only safety and payment activity for ${d.elder.name}'s SaySafe household. All payments are PayPal sandbox (no real money). Rows with source "Example data" are seeded demo rows. Paid totals count only payments with status Paid.`,
    sources: [
      {
        id: 'payments', name: 'Payments', description: 'One row per purchase request.', data: payments,
        fields: [
          t('ref', 'Ref', 'textFormat'), t('id', 'Request id', 'textFormat', { hide: true }), t('created', 'Created', 'textFormat'), t('day', 'Day', 'textFormat'),
          t('product', 'Purchase', 'textFormat'), t('merchant', 'Shop', 'textFormat'), t('amount', 'Amount', 'currencyFormat', { formatOptions: eurFmt }),
          t('currency', 'Currency', 'textFormat'), t('status', 'Status', 'textFormat'), t('source', 'Source', 'textFormat'), t('approval', 'Family decision', 'textFormat'),
          t('awaiting', 'Awaiting my decision', 'integerFormat'), t('expires', 'Approval expires', 'textFormat'),
          t('paidTotal', 'Paid total (Paid only)', 'currencyFormat', { formatOptions: eurFmt }), t('paidCount', 'Paid purchases', 'integerFormat'), t('declined', 'Declined', 'integerFormat'),
          t('capture', 'PayPal capture', 'textFormat'), t('capturedAmount', 'Captured amount', 'decimalFormat'), t('capturedCurrency', 'Captured currency', 'textFormat'),
          t('webhook', 'Webhook', 'textFormat'), t('webhookAt', 'Webhook confirmed at', 'textFormat'),
        ],
      },
      {
        id: 'activity', name: 'Protection activity', description: `Timeline of purchase steps, family decisions, PayPal confirmations and shared scam checks (${scans} shared scam checks).`, data: activity,
        fields: [
          t('id', 'Event id', 'textFormat', { hide: true }), t('at', 'When', 'textFormat'), t('day', 'Day', 'textFormat'), t('kind', 'Kind', 'textFormat'),
          t('label', 'What happened', 'textFormat'), t('actor', 'Who', 'textFormat'), t('events', 'Events', 'integerFormat'),
        ],
      },
    ],
  };
}

// ---------- Custom widget helpers ----------
// Note: getSchema() omits hidden fields, so custom widgets only request visible ones (e.g. Ref, not the hidden id).
function useFields(params: AgWidgetParams) {
  const { widgetApi } = params;
  return useMemo(() => {
    const map = new Map<string, AgWidgetField>();
    for (const table of widgetApi.getSchema()) for (const f of table.fields) { map.set(String(f.fieldId), f); map.set(`${table.id}.${f.key}`, f); }
    return map;
  }, [widgetApi, params]); // eslint-disable-line react-hooks/exhaustive-deps
}

function useRows(params: AgWidgetParams, ids: string[]) {
  const fields = useFields(params);
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const { widgetApi } = params;
  useEffect(() => {
    let alive = true;
    const fs = ids.map((id) => fields.get(id)).filter(Boolean) as AgWidgetField[];
    if (fs.length !== ids.length) { setRows([]); widgetApi.setDisplayState('displayed'); return; }
    widgetApi.setDisplayState('loading', { prominent: rows === null });
    widgetApi.getData({ fields: fs }).then((res) => {
      if (!alive) return;
      setRows(res.results.rows.map((r) => Object.fromEntries(ids.map((id, i) => [id.split('.')[1], r[fs[i].key]]))));
      widgetApi.setDisplayState('displayed');
    }).catch(() => { if (alive) { setRows([]); widgetApi.setDisplayState('displayed'); } });
    return () => { alive = false; };
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}

const box: React.CSSProperties = { height: '100%', overflow: 'auto', padding: '4px 8px', fontFamily: SANS, color: '#15283b', fontSize: 15 };
const h3: React.CSSProperties = { fontFamily: SERIF, fontWeight: 600, fontSize: 18, margin: '2px 0 8px' };
const empty: React.CSSProperties = { color: '#3d4f61', margin: 0 };
const when = (iso: string) => (iso ? new Date(iso).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

function ProtectionActivityWidget(params: AgWidgetParams) {
  const rows = useRows(params, ['activity.at', 'activity.kind', 'activity.label', 'activity.actor']);
  const sorted = (rows ?? []).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 40);
  const dot: Record<string, string> = { 'Scam check': '#9e1d2c', 'Family decision': '#8f4d0c', 'PayPal confirmation': '#066a5f', 'Purchase step': '#3d4f61' };
  return (
    <div style={box}>
      <h3 style={h3}>Protection Activity</h3>
      {rows && sorted.length === 0 ? <p style={empty}>No activity yet. Scam checks your relative shares, your decisions and PayPal confirmations will appear here.</p> : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {sorted.map((r, i) => (
            <li key={`${r.at}-${i}`} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid #dfe5df' }}>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: 5, marginTop: 6, flex: 'none', background: dot[r.kind] ?? '#3d4f61' }} />
              <span><strong>{r.label}</strong><br /><span style={{ color: '#3d4f61', fontSize: 13 }}>{r.kind} · {r.actor} · {when(r.at)}</span></span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function AwaitingDecisionWidget(params: AgWidgetParams) {
  const rows = useRows(params, ['payments.ref', 'payments.product', 'payments.amount', 'payments.awaiting', 'payments.expires']);
  const list = (rows ?? []).filter((r) => r.awaiting === 1);
  return (
    <div style={box}>
      <h3 style={h3}>Awaiting My Decision</h3>
      {rows && list.length === 0 ? <p style={empty}>Nothing is waiting for your decision.</p> : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {list.map((r) => <li key={r.ref} style={{ border: '2px solid #8f4d0c', borderRadius: 12, padding: '8px 10px', marginBottom: 8 }}><strong>{r.product}</strong> · {money(Number(r.amount))}<br /><span style={{ color: '#3d4f61', fontSize: 13 }}>Expires {when(r.expires)}</span></li>)}
        </ul>
      )}
      {list.length > 0 && <a href="/family#pending-h" style={{ color: '#066a5f', fontWeight: 700 }}>Approve or decline on the Family page →</a>}
      <p style={{ ...empty, fontSize: 13, marginTop: 6 }}>Decisions are made on the Family page only. This dashboard is read-only.</p>
    </div>
  );
}

function PaymentEvidenceWidget(params: AgWidgetParams) {
  const rows = useRows(params, ['payments.ref', 'payments.product', 'payments.status', 'payments.capture', 'payments.capturedAmount', 'payments.capturedCurrency', 'payments.webhook', 'payments.webhookAt', 'payments.source']);
  const list = (rows ?? []).filter((r) => r.capture !== 'No PayPal order' || r.status === 'Paid');
  return (
    <div style={box}>
      <h3 style={h3}>Payment Evidence</h3>
      {rows && list.length === 0 ? <p style={empty}>No PayPal orders yet. Once a purchase reaches PayPal, its capture and webhook confirmation are shown here.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ textAlign: 'left' }}><th scope="col">Purchase</th><th scope="col">Capture</th><th scope="col">Amount</th><th scope="col">Webhook</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.ref} style={{ borderTop: '1px solid #dfe5df', verticalAlign: 'top' }}>
                <td style={{ padding: '4px 4px 4px 0' }}>{r.product}<br /><span style={{ fontSize: 12, color: r.source === 'PayPal sandbox' ? '#055248' : '#8f4d0c', fontWeight: 700 }}>{r.source}</span></td>
                <td>{r.capture}<br /><span style={{ fontSize: 12, color: '#3d4f61' }}>{r.status}</span></td>
                <td>{r.capturedCurrency ? money(Number(r.capturedAmount), r.capturedCurrency) : '—'}</td>
                <td>{r.webhook === 'Confirmed' ? `Confirmed ${when(r.webhookAt)}` : r.webhook}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const custom = (id: string, label: string, comp: any, description: string) => ({
  id, label, comp,
  icon: { className: 'ag-icon-grid' },
  form: (p: any) => p.createDefaults({ dataMappingItems: [] }),
  defaultSize: { width: 480, height: 360 },
  minSize: { width: 260, height: 160 },
  ai: { description },
});

// ---------- Report layout ----------
function reportState(narrow: boolean) {
  const L = (x: number, y: number, w: number, h: number) => ({ xTrack: x, yTrack: y, xSpan: w, ySpan: h });
  const title = (text: string) => ({ title: { enabled: true, text } });
  const widgets: Record<string, any> = {
    kpiPaid: { type: 'value', dataMapping: { value: [{ id: 'payments.paidTotal', aggregation: 'sum' }] }, format: title('Paid total') },
    kpiAwait: { type: 'value', dataMapping: { value: [{ id: 'payments.awaiting', aggregation: 'sum' }] }, format: title('Awaiting my decision') },
    kpiDeclined: { type: 'value', dataMapping: { value: [{ id: 'payments.declined', aggregation: 'sum' }] }, format: title('Declined') },
    kpiCount: { type: 'value', dataMapping: { value: [{ id: 'payments.paidCount', aggregation: 'sum' }] }, format: title('Paid purchases') },
    chart: { type: 'column-chart-stacked', dataMapping: { categoryKey: [{ id: 'activity.day' }], valueKey: [{ id: 'activity.events', aggregation: 'sum' }], legendKey: [{ id: 'activity.kind' }] }, format: title('Activity over time') },
    awaiting: { type: 'awaitingDecision', dataMapping: {} },
    donut: { type: 'donut-chart', dataMapping: { categoryKey: [{ id: 'payments.status' }], valueKey: [{ id: 'payments.amount', aggregation: 'count' }] }, format: title('Purchases by status (click to filter)') },
    fStatus: { type: 'list-filter', dataMapping: { value: [{ id: 'payments.status' }] }, format: title('Filter by status') },
    fSource: { type: 'list-filter', dataMapping: { value: [{ id: 'payments.source' }] }, format: title('Sandbox or example') },
    grid: { type: 'grid', dataMapping: { cols: [{ id: 'payments.created' }, { id: 'payments.ref' }, { id: 'payments.product' }, { id: 'payments.merchant' }, { id: 'payments.status' }, { id: 'payments.approval' }, { id: 'payments.source' }, { id: 'payments.webhook' }, { id: 'payments.amount', aggregation: 'sum' }] }, format: title('Payment ledger') },
    activity: { type: 'protectionActivity', dataMapping: {} },
    evidence: { type: 'paymentEvidence', dataMapping: {} },
  };
  const widgetLayout = narrow
    ? {
        kpiPaid: L(0, 0, 12, 8), kpiAwait: L(12, 0, 12, 8), kpiDeclined: L(0, 8, 12, 8), kpiCount: L(12, 8, 12, 8),
        awaiting: L(0, 16, 24, 16), chart: L(0, 32, 24, 18), donut: L(0, 50, 24, 18), fStatus: L(0, 68, 24, 14), fSource: L(0, 82, 24, 10),
        grid: L(0, 92, 24, 22), evidence: L(0, 114, 24, 22), activity: L(0, 136, 24, 26),
      }
    : {
        kpiPaid: L(0, 0, 6, 7), kpiAwait: L(6, 0, 6, 7), kpiDeclined: L(12, 0, 6, 7), kpiCount: L(18, 0, 6, 7),
        chart: L(0, 7, 15, 18), awaiting: L(15, 7, 9, 18),
        donut: L(0, 25, 10, 17), fStatus: L(10, 25, 7, 17), fSource: L(17, 25, 7, 17),
        grid: L(0, 42, 24, 24),
        activity: L(0, 66, 12, 24), evidence: L(12, 66, 12, 24),
      };
  return {
    pages: [{ id: 'insights', name: 'Family Safety Insights', widgets, widgetLayout }],
    selectedPageId: 'insights',
    panels: { filters: { collapsed: true } },
  };
}

// ---------- Read-only agent: Custom Runner over our server route ----------
function lastUserText(input: { messages: { role: string; content?: unknown }[] }) {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

const insightsAgent: AgAiAgentRunner = {
  id: 'insights',
  name: 'SaySafe Insights (read-only)',
  description: 'Answers questions about this household\'s purchases, approvals, PayPal confirmations and scam checks. Read-only.',
  // No tools: this agent cannot change anything in Studio or in SaySafe.
  tools: () => [],
  run: async function* (input, ctx): AsyncGenerator<AgAiEvent> {
    const { threadId, runId } = input;
    yield { type: 'RUN_STARTED', threadId, runId };
    const messageId = `msg-${runId}`;
    yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' };
    let text: string;
    try {
      if (ctx.signal?.aborted) return;
      text = (await askInsights(lastUserText(input as any).slice(0, 500) || 'Summarise our activity')).answer;
    } catch (e: any) {
      text = e?.message ?? 'Insights are not available right now.';
    }
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text };
    yield { type: 'TEXT_MESSAGE_END', messageId };
    yield { type: 'RUN_FINISHED', threadId, runId };
  },
};

const PROMPTS = [
  { label: 'Waiting for me', prompt: 'Which purchases are waiting for my approval?' },
  { label: 'Declined', prompt: 'Show transactions that were declined' },
  { label: 'Paid this week', prompt: 'How much was paid through our demo checkout this week?' },
  { label: 'Webhook pending', prompt: 'Show payments whose webhook confirmation is still pending' },
];

function AskStudio({ harness }: { harness: React.RefObject<AgAiHarness | null> }) {
  const [q, setQ] = useState('');
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [, force] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const l = () => force((n) => n + 1);
    session.addEventListener('changed', l);
    return () => session.removeEventListener('changed', l);
  }, [session]);
  const ask = async (text: string) => {
    if (!text.trim()) return;
    setErr(null);
    try {
      const h = harness.current;
      if (!h) throw new Error('The assistant is still starting. Try again in a moment.');
      const s = session ?? (await h.createThread({ agentId: 'insights', title: 'Insights' }));
      if (!session) setSession(s);
      s.sendMessage(text.trim());
      setQ('');
    } catch (e: any) { setErr(e.message); }
  };
  const lastAssistant = session ? [...session.messages].reverse().find((m) => m.role === 'assistant') : undefined;
  const answer = lastAssistant?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
  const busy = session?.status === 'running';
  return (
    <section aria-labelledby="ask-studio-h" className="mb-6 rounded-[var(--radius-card)] border border-line bg-paper p-5">
      <h2 id="ask-studio-h" className="text-2xl">Ask the read-only insights agent</h2>
      <p className="text-base text-ink-soft">AG Studio Agent Framework (custom runner). It answers from your household's data only and cannot approve, pay or change anything.</p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); ask(q); }} className="mt-3 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[12rem]"><label htmlFor="ask-studio-q" className="block font-bold mb-1 text-base">Your question</label><input id="ask-studio-q" value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} className="w-full min-h-12 rounded-2xl border-2 border-line px-4 bg-paper focus:border-teal outline-none text-base" /></div>
        <Button type="submit" busy={busy} className="!min-h-12">Ask</Button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">{PROMPTS.map((p) => <button key={p.label} type="button" onClick={() => ask(p.prompt)} className="rounded-full border-2 border-line px-3 py-1 text-sm font-bold hover:border-teal min-h-10">{p.prompt}</button>)}</div>
      <div aria-live="polite">
        {err && <div className="mt-3"><Notice tone="danger" title={err} /></div>}
        {answer && <p className="mt-4 rounded-2xl bg-teal-soft p-4 whitespace-pre-line">{answer}</p>}
      </div>
    </section>
  );
}

export default function StudioDashboard() {
  const { data, error } = useInsights(60000);
  const [mode, setMode] = useState<AgStudioMode>('view');
  const narrow = typeof window !== 'undefined' && window.innerWidth < 760;
  const initialState = useMemo(() => reportState(narrow), [narrow]);
  const sources = useMemo(() => (data ? toSources(data) : undefined), [data]);
  const harnessRef = useRef<AgAiHarness | null>(null);
  // One harness instance, shared by Studio's own AI panel (edit mode) and the view-mode ask box above.
  // Studio builds `ai` lazily, so the ask box also creates it from the API once Studio is ready.
  const buildHarness = useCallback((api: any) => (harnessRef.current ??= createAiHarness(api, () => ({ agents: [insightsAgent], primary: 'insights', promptStarters: PROMPTS }))), []);
  const ai = useCallback(({ api }: { api: any }) => buildHarness(api), [buildHarness]);
  const onApiReady = useCallback((e: { api: any }) => { buildHarness(e.api); }, [buildHarness]);
  const widgets = useMemo(() => (base: any) => createWidgets({
    additionalTypes: [
      custom('protectionActivity', 'Protection Activity', ProtectionActivityWidget, 'Timeline of shared scam checks, family decisions and PayPal confirmations.'),
      custom('awaitingDecision', 'Awaiting My Decision', AwaitingDecisionWidget, 'Purchases waiting for the signed-in family member to approve or decline (decisions happen on the Family page).'),
      custom('paymentEvidence', 'Payment Evidence', PaymentEvidenceWidget, 'PayPal capture status, captured amount and currency, and signed webhook confirmation.'),
    ] as any,
    menu: [...base.menu, { label: 'SaySafe', widgetIds: ['protectionActivity', 'awaitingDecision', 'paymentEvidence'] }],
  } as any), []);
  const licenseKey = agStudioLicenseKey(import.meta.env);
  return (
    <Layout mode="family" wide>
      <PageTitle eyebrow="Family · Insights · AG Studio" title={data ? `${data.elder.name}'s safety at a glance` : 'Family Safety Insights'} lead="AG Studio view of the same read-only data as the standard dashboard." />
      <p className="-mt-4 mb-6 flex flex-wrap gap-x-5 gap-y-2 items-center">
        <Link to="/family" className="font-bold text-teal underline">Back to Family page</Link>
        <Link to="/family/insights" className="font-bold text-teal underline">Standard dashboard</Link>
        <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode((m) => (m === 'view' ? 'edit' : 'view'))} className="rounded-full border-2 border-line px-4 min-h-11 font-bold text-base">{mode === 'view' ? 'Edit layout' : 'Done editing'}</button>
      </p>
      {error && <div className="mb-6"><Notice tone="danger" title={error} /></div>}
      <AskStudio harness={harnessRef} />
      <div style={{ height: narrow ? 2800 : 1520 }} className="rounded-[var(--radius-card)] border border-line overflow-hidden bg-ivory">
        <AgStudioProvider modules={[AgStudioAiModule]} {...(licenseKey ? { licenseKey } : {})}>
          <AgStudio
            style={{ height: '100%', width: '100%' }}
            theme={theme}
            data={sources as any}
            initialState={initialState as any}
            widgets={widgets as any}
            mode={mode}
            ai={ai as any}
            onApiReady={onApiReady as any}
            layout={{ minWidth: narrow ? 300 : 720, backgroundColor: '#f7f8f4', widgetBorderRadius: 16, widgetBorderColor: '#dfe5df' }}
            panels={{ view: narrow ? {} : { right: ['filters'] }, edit: { left: ['data'], right: ['edit', 'filters', 'ai'] } }}
            enableFilterEditingInViewMode
          />
        </AgStudioProvider>
      </div>
    </Layout>
  );
}
