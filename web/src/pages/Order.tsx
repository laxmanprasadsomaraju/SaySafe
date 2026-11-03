import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, XCircle, Volume2, Receipt, PackageX, RefreshCw, ShieldCheck, CircleDashed, RotateCcw } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, Notice, SandboxBadge } from '../components/ui';
import { api, eur, type PaymentRequest, type PaymentState, type PaymentTimeline, type ReconcileOutcome } from '../lib/api';
import { speech } from '../lib/voice';
import { spokenReceipt, spokenFamily } from '../lib/spoken';
import { useMe } from '../lib/session';
import { goToPayPal } from '../lib/handoff';
import { LeaveGuard } from '../components/LeaveGuard';

export function stateLabel(s: PaymentState) {
  return ({
    DRAFT: 'Started', RISK_REVIEW: 'Checking', BLOCKED: 'Stopped for safety', FAMILY_APPROVAL_PENDING: 'Waiting for family',
    FAMILY_APPROVED: 'Family approved — ready to pay', PAYER_APPROVAL_PENDING: 'Waiting for your PayPal approval', PAYER_APPROVED: 'Approved — finishing',
    CAPTURE_PENDING: 'Payment processing', CAPTURED: 'Paid', FAILED: 'Did not go through', CANCELLED: 'Cancelled', REFUND_PENDING: 'Refund pending', REFUNDED: 'Refunded',
  } as Record<PaymentState, string>)[s];
}

export { spokenReceipt };

const RECONCILABLE: PaymentState[] = ['PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'CAPTURE_PENDING', 'REFUND_PENDING'];

function outcomeText(o: ReconcileOutcome): string {
  return ({
    captured: 'PayPal confirms this payment was captured.',
    buyer_approved: 'PayPal shows you approved this payment. Nothing has been taken yet: tap “Finish payment” when you are ready.',
    cancelled: 'PayPal shows this order was cancelled or has expired. No money was taken.',
    pending: 'PayPal has not finished this yet. Nothing more is needed from you right now.',
    unknown: 'I could not reach PayPal just now. Nothing was changed. You can check again in a moment.',
    mismatch: 'PayPal’s details do not match this purchase, so I have not marked it as paid.',
    refunded: 'PayPal confirms this payment was refunded.',
    refund_failed: 'PayPal did not complete the refund. The payment is still paid.',
    no_change: 'Up to date with PayPal.', throttled: 'Up to date with PayPal.', not_applicable: 'Up to date with PayPal.',
  } as Record<ReconcileOutcome, string>)[o];
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'medium' }) : '');

function Timeline({ t }: { t: PaymentTimeline }) {
  if (!t.events.length && !t.pending.length) return null;
  return (
    <section className="mt-6" aria-labelledby="evidence-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="evidence-h" className="font-bold text-xl">Payment evidence</h2>
        <span className="text-sm font-bold text-ink-soft">{t.label}</span>
      </div>
      <ol className="mt-3 space-y-3">
        {t.events.map((e) => (
          <li key={e.kind} className="flex gap-3">
            <ShieldCheck className={`size-6 shrink-0 mt-0.5 ${e.verified ? 'text-teal' : 'text-danger'}`} aria-hidden />
            <div>
              <p className="font-bold">{e.label} <span className="font-normal text-ink-soft">· {when(e.paypalTime ?? e.at)}{e.paypalTime ? ' (PayPal time)' : ''}</span></p>
              <p className="text-base text-ink-soft">Source: {e.source}</p>
              <p className="text-base text-ink-soft">{e.verified ? 'Verified: ' : 'Not verified: '}{e.verification}</p>
            </div>
          </li>
        ))}
        {t.pending.map((p) => (
          <li key={p} className="flex gap-3 text-ink-soft"><CircleDashed className="size-6 shrink-0 mt-0.5" aria-hidden /><p>{p}</p></li>
        ))}
      </ol>
    </section>
  );
}

/** Shows one purchase. Also handles the return from PayPal (/checkout/return?rid=..&token=ORDERID). */
export default function Order({ fromPayPal = false }: { fromPayPal?: boolean }) {
  const me = useMe('elder');
  const params = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const id = params.id ?? sp.get('rid') ?? '';
  const [r, setR] = useState<PaymentRequest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const spoke = useRef(false);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);

  const load = () => api<PaymentRequest>(`/api/payments/${id}`).then((x) => { setR(x); return x; }).catch((e) => { setErr(e.message); return null; });
  /** Read-only check with PayPal (never captures). Runs on load for unfinished payments and from the button. */
  const checkWithPayPal = async (manual = false) => {
    setChecking(true);
    try {
      const out = await api<{ outcome: ReconcileOutcome; request: PaymentRequest }>(`/api/payments/${id}/reconcile`, { body: {} });
      setR(out.request);
      if (manual || !['no_change', 'throttled', 'not_applicable', 'pending'].includes(out.outcome)) setCheckMsg(outcomeText(out.outcome));
    } catch (e: any) { if (manual) setErr(e.message); }
    finally { setChecking(false); }
  };
  const finish = async () => {
    setBusy(true); setErr(null);
    try { setR(await api<PaymentRequest>(`/api/payments/${id}/finish`, { body: {} })); await load(); }
    catch (e: any) { setErr(e.message); await load(); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!me || !id) return;
    if (fromPayPal) {
      const token = sp.get('token');
      if (!token) { setErr('PayPal did not send back an order reference. Nothing was charged.'); load().then((x) => { if (x && RECONCILABLE.includes(x.state)) checkWithPayPal(); }); return; }
      setBusy(true);
      api<PaymentRequest>(`/api/payments/${id}/confirm`, { body: { orderId: token }, idempotent: true })
        .then((x) => { setR(x); nav(`/order/${id}`, { replace: true }); load(); })
        .catch((e) => { setErr(e.message); load(); })
        .finally(() => setBusy(false));
    } else {
      // Also the path for a lost redirect: opening /order/:id directly asks PayPal what really happened.
      load().then((x) => { if (x && RECONCILABLE.includes(x.state)) checkWithPayPal(); });
    }
  }, [me, id]); // eslint-disable-line

  // Poll while waiting for family or for a pending capture.
  useEffect(() => {
    if (!r) return;
    const waitingNotice = r.state === 'CAPTURED' && r.receipt && !r.receipt.webhookConfirmed;
    if (!['FAMILY_APPROVAL_PENDING', 'CAPTURE_PENDING', 'REFUND_PENDING'].includes(r.state) && !waitingNotice) return;
    const viaPayPal = r.state === 'CAPTURE_PENDING' || r.state === 'REFUND_PENDING';
    const t = setInterval(() => (viaPayPal ? checkWithPayPal() : load()), viaPayPal ? 6000 : 4000);
    const stop = waitingNotice ? setTimeout(() => clearInterval(t), 120_000) : undefined;
    return () => { clearInterval(t); if (stop) clearTimeout(stop); };
  }, [r?.state, r?.receipt?.webhookConfirmed]); // eslint-disable-line

  useEffect(() => {
    if (!r || spoke.current) return;
    if (r.state === 'CAPTURED') { speech.speak(spokenReceipt(r), { priority: 'auto' }); spoke.current = true; }
    if (r.state === 'FAMILY_APPROVAL_PENDING') { speech.speak(spokenFamily(r.state), { priority: 'auto' }); spoke.current = true; }
  }, [r]);

  const checkout = async () => {
    setBusy(true); setErr(null);
    try { const { approveUrl } = await api(`/api/payments/${id}/checkout`, { body: {} }); goToPayPal(approveUrl); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const askRefund = async () => {
    setBusy(true); setErr(null);
    try { setR(await api<PaymentRequest>(`/api/payments/${id}/refund-request`, { body: {} })); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const cancel = async () => { setBusy(true); try { setR(await api(`/api/payments/${id}/cancel`, { body: {} })); } catch (e: any) { setErr(e.message); } setBusy(false); };

  if (!me) return <Layout><p>Loading…</p></Layout>;
  if (fromPayPal && busy) return <Layout><PageTitle title="Confirming with PayPal…" lead="I'm checking with PayPal that your payment really went through. Please wait a moment." /></Layout>;
  if (!r) return <Layout>{err ? <Notice tone="danger" title={err} /> : <p>Loading…</p>}</Layout>;

  const paid = r.state === 'CAPTURED';
  const Icon = paid ? CheckCircle2 : ['BLOCKED', 'FAILED', 'CANCELLED'].includes(r.state) ? XCircle : Clock;
  return (
    <Layout>
      <PageTitle eyebrow="Your purchase" title={paid ? 'Payment successful' : stateLabel(r.state)} />
      <LeaveGuard when={r.state === 'FAMILY_APPROVAL_PENDING' || r.state === 'PAYER_APPROVAL_PENDING'} id={r.id} title={r.state === 'FAMILY_APPROVAL_PENDING' ? 'Still waiting for your family member' : 'Still waiting for your PayPal approval'} detail="This purchase isn’t finished." />
      {err && <div className="mb-6"><Notice tone="danger" title={err} /></div>}
      <div className="grid lg:grid-cols-[1.2fr_1fr] gap-6 items-start">
        <Card className="p-6 md:p-8">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <p className={`flex items-center gap-2 font-bold text-xl ${paid ? 'text-teal' : 'text-navy'}`}><Icon className="size-8" aria-hidden />{stateLabel(r.state)}</p>
            <SandboxBadge />
          </div>
          <ul className="mt-5 divide-y divide-line">
            {r.items.map((l) => (
              <li key={l.productId} className="py-4 flex gap-3 sm:gap-4 items-center">
                <img src={`/products/${l.image}`} alt="" className="size-12 sm:size-16 rounded-xl object-cover bg-teal-soft" />
                <p className="flex-1 min-w-0 font-bold break-words hyphens-auto" lang="en">{l.name} <span className="font-normal text-ink-soft">× {l.quantity}</span></p>
                <p className="font-bold">{eur(l.lineCents)}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex justify-between text-[1.4rem]"><span className="font-bold">Total</span><span className="font-display font-semibold">{eur(r.amountCents)} {r.currency}</span></p>
          <p className="mt-1 text-ink-soft text-lg">Shop: {r.merchant}</p>
          {r.receipt && (
            <div className="mt-6 rounded-2xl bg-teal-soft p-5">
              <p className="font-bold flex items-center gap-2"><Receipt className="size-6 text-teal" aria-hidden />Receipt confirmed by PayPal</p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-lg">
                <dt className="text-ink-soft">Amount</dt><dd className="font-bold">€{r.receipt.amount} {r.receipt.currency}</dd>
                <dt className="text-ink-soft">Paid to</dt><dd className="font-bold">{r.receipt.payee}</dd>
                <dt className="text-ink-soft">PayPal order</dt><dd className="font-bold break-all">{r.receipt.orderId}</dd>
                <dt className="text-ink-soft">Transaction</dt><dd className="font-bold break-all">{r.receipt.captureId}</dd>
              </dl>
              <p className="mt-3 text-base text-ink-soft">{r.receipt.webhookConfirmed ? 'PayPal also sent a signed notice confirming this capture.' : 'Checked directly with PayPal. Signed PayPal notice not received yet.'}</p>
            </div>
          )}
          {r.timeline && <Timeline t={r.timeline} />}
        </Card>
        <div className="space-y-4">
          {r.state === 'FAMILY_APPROVAL_PENDING' && <Notice tone="warn" title="Waiting for your family member">I've sent them the exact item, shop and price. This page updates by itself.</Notice>}
          {r.state === 'FAMILY_APPROVED' && <Notice tone="ok" title="Your family member said yes.">You still approve the payment yourself at PayPal.</Notice>}
          {checkMsg && <Notice tone={checkMsg.startsWith('PayPal’s details') ? 'danger' : 'info'} title={checkMsg} />}
          {r.state === 'PAYER_APPROVED' && <Notice tone="info" title="Approved at PayPal, not paid yet.">Nothing is taken until you tap “Finish payment”. I check the amount and any family approval again first.</Notice>}
          {r.state === 'PAYER_APPROVED' && <Button className="w-full" onClick={finish} busy={busy}>Finish payment</Button>}
          {r.state === 'BLOCKED' && <Notice tone="danger" title="Stopped for your safety">{r.risk?.reasons.join(' ')}</Notice>}
          {r.state === 'CANCELLED' && r.approval?.status === 'declined' && <Notice tone="info" title="Your family member said no this time.">{r.approval.reason ?? 'Maybe talk it over together.'}</Notice>}
          {(r.state === 'FAMILY_APPROVED' || r.state === 'PAYER_APPROVAL_PENDING') && <Button className="w-full" onClick={checkout} busy={busy}>Continue to PayPal</Button>}
          {RECONCILABLE.includes(r.state) && <Button className="w-full" variant="secondary" icon={<RefreshCw className="size-6" aria-hidden />} onClick={() => checkWithPayPal(true)} busy={checking} disabled={busy}>Check with PayPal</Button>}
          {['FAMILY_APPROVAL_PENDING', 'FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED'].includes(r.state) && <Button className="w-full" variant="secondary" onClick={cancel} disabled={busy}>Cancel this purchase</Button>}
          {paid && <Button className="w-full" variant="secondary" icon={<Volume2 className="size-6" aria-hidden />} onClick={() => speech.speak(spokenReceipt(r), { priority: 'user' })}>Read my receipt</Button>}
          {r.refund?.status === 'REFUND_REQUESTED' && <Notice tone="info" title="Request sent — not refunded yet">The shop decides. You have not been refunded. If it is refunded, this page will say “Refunded”.</Notice>}
          {r.refund?.status === 'REFUND_PENDING' && <Notice tone="info" title="Refund sent to PayPal — not confirmed yet">PayPal has not confirmed it. This page updates when it does.</Notice>}
          {r.state === 'REFUNDED' && <Notice tone="ok" title="Refunded">The Demo Shop refunded this payment through PayPal (Sandbox — no real money).</Notice>}
          {paid && r.refund?.canRequest && <Button className="w-full" variant="secondary" icon={<RotateCcw className="size-6" aria-hidden />} onClick={askRefund} busy={busy}>Request a refund</Button>}
          {paid && <Button className="w-full" variant="ghost" icon={<PackageX className="size-6" aria-hidden />} onClick={() => nav('/help', { state: { problem: true, requestId: r.id } })}>Problem with this order?</Button>}
          <Button className="w-full" variant="ghost" onClick={() => nav('/home')}>Back to home</Button>
        </div>
      </div>
    </Layout>
  );
}
