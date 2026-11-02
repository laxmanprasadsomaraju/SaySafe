import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, XCircle, Volume2, Receipt, PackageX } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, Notice, SandboxBadge } from '../components/ui';
import { api, eur, type PaymentRequest, type PaymentState } from '../lib/api';
import { speak } from '../lib/voice';
import { useMe } from '../lib/session';

export function stateLabel(s: PaymentState) {
  return ({
    DRAFT: 'Started', RISK_REVIEW: 'Checking', BLOCKED: 'Stopped for safety', FAMILY_APPROVAL_PENDING: 'Waiting for family',
    FAMILY_APPROVED: 'Family approved — ready to pay', PAYER_APPROVAL_PENDING: 'Waiting for your PayPal approval', PAYER_APPROVED: 'Approved — finishing',
    CAPTURE_PENDING: 'Payment processing', CAPTURED: 'Paid', FAILED: 'Did not go through', CANCELLED: 'Cancelled', REFUNDED: 'Refunded',
  } as Record<PaymentState, string>)[s];
}

export function spokenReceipt(r: PaymentRequest) {
  if (!r.receipt) return '';
  const amt = `€${Number(r.receipt.amount).toFixed(Number(r.receipt.amount) % 1 ? 2 : 0)}`;
  return `Your payment of ${amt} to ${r.receipt.payee.replace(' (sandbox)', '')} was successful. This was a PayPal sandbox payment, so no real money moved.`;
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

  const load = () => api<PaymentRequest>(`/api/payments/${id}`).then(setR).catch((e) => setErr(e.message));

  useEffect(() => {
    if (!me || !id) return;
    if (fromPayPal) {
      const token = sp.get('token');
      if (!token) { setErr('PayPal did not send back an order reference. Nothing was charged.'); load(); return; }
      setBusy(true);
      api<PaymentRequest>(`/api/payments/${id}/confirm`, { body: { orderId: token } })
        .then((x) => { setR(x); nav(`/order/${id}`, { replace: true }); })
        .catch((e) => { setErr(e.message); load(); })
        .finally(() => setBusy(false));
    } else load();
  }, [me, id]); // eslint-disable-line

  // Poll while waiting for family or for a pending capture.
  useEffect(() => {
    if (!r) return;
    const waitingNotice = r.state === 'CAPTURED' && r.receipt && !r.receipt.webhookConfirmed;
    if (!['FAMILY_APPROVAL_PENDING', 'CAPTURE_PENDING'].includes(r.state) && !waitingNotice) return;
    const t = setInterval(load, 4000);
    const stop = waitingNotice ? setTimeout(() => clearInterval(t), 120_000) : undefined;
    return () => { clearInterval(t); if (stop) clearTimeout(stop); };
  }, [r?.state, r?.receipt?.webhookConfirmed]); // eslint-disable-line

  useEffect(() => {
    if (!r || spoke.current) return;
    if (r.state === 'CAPTURED') { speak(spokenReceipt(r)); spoke.current = true; }
    if (r.state === 'FAMILY_APPROVAL_PENDING') { speak("This purchase is above your protected spending limit. I've sent a review request to your trusted family member."); spoke.current = true; }
  }, [r]);

  const checkout = async () => {
    setBusy(true); setErr(null);
    try { const { approveUrl } = await api(`/api/payments/${id}/checkout`, { body: {} }); window.location.assign(approveUrl); }
    catch (e: any) { setErr(e.message); setBusy(false); }
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
      {err && <div className="mb-6"><Notice tone="danger" title={err} /></div>}
      <div className="grid lg:grid-cols-[1.2fr_1fr] gap-6 items-start">
        <Card className="p-6 md:p-8">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <p className={`flex items-center gap-2 font-bold text-xl ${paid ? 'text-teal' : 'text-navy'}`}><Icon className="size-8" aria-hidden />{stateLabel(r.state)}</p>
            <SandboxBadge />
          </div>
          <ul className="mt-5 divide-y divide-line">
            {r.items.map((l) => (
              <li key={l.productId} className="py-4 flex gap-4 items-center">
                <img src={`/products/${l.image}`} alt="" className="size-16 rounded-xl object-cover bg-teal-soft" />
                <p className="flex-1 font-bold">{l.name} <span className="font-normal text-ink-soft">× {l.quantity}</span></p>
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
              <p className="mt-3 text-base text-ink-soft">{r.receipt.webhookConfirmed ? 'PayPal also sent a signed notice confirming this capture.' : 'Checked directly with PayPal. PayPal’s signed notice usually follows within a minute.'}</p>
            </div>
          )}
        </Card>
        <div className="space-y-4">
          {r.state === 'FAMILY_APPROVAL_PENDING' && <Notice tone="warn" title="Waiting for your family member">I've sent them the exact item, shop and price. This page updates by itself.</Notice>}
          {r.state === 'FAMILY_APPROVED' && <Notice tone="ok" title="Your family member said yes.">You still approve the payment yourself at PayPal.</Notice>}
          {r.state === 'BLOCKED' && <Notice tone="danger" title="Stopped for your safety">{r.risk?.reasons.join(' ')}</Notice>}
          {r.state === 'CANCELLED' && r.approval?.status === 'declined' && <Notice tone="info" title="Your family member said no this time.">{r.approval.reason ?? 'Maybe talk it over together.'}</Notice>}
          {(r.state === 'FAMILY_APPROVED' || r.state === 'PAYER_APPROVAL_PENDING') && <Button className="w-full" onClick={checkout} busy={busy}>Continue to PayPal</Button>}
          {['FAMILY_APPROVAL_PENDING', 'FAMILY_APPROVED', 'PAYER_APPROVAL_PENDING'].includes(r.state) && <Button className="w-full" variant="secondary" onClick={cancel} disabled={busy}>Cancel this purchase</Button>}
          {paid && <Button className="w-full" variant="secondary" icon={<Volume2 className="size-6" aria-hidden />} onClick={() => speak(spokenReceipt(r))}>Read my receipt</Button>}
          {paid && <Button className="w-full" variant="ghost" icon={<PackageX className="size-6" aria-hidden />} onClick={() => nav('/help', { state: { problem: true, requestId: r.id } })}>Problem with this order?</Button>}
          <Button className="w-full" variant="ghost" onClick={() => nav('/home')}>Back to home</Button>
        </div>
      </div>
    </Layout>
  );
}
