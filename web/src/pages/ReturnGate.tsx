import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Card, PageTitle, LinkButton } from '../components/ui';
import { api } from '../lib/api';
import Order from './Order';

interface Status { orderId: string; orderStatus: string; requestId: string; amount: string; currency: string; capture: { id: string; status: string; amount: string; currency: string; time: string } | null }

/**
 * Return from PayPal. With a live session, the normal confirm-and-capture flow runs.
 * Without Mary's session we never capture. Her linked family helper (same household) can still see what PayPal says;
 * anyone else is asked to sign in (the status route is owner-only).
 */
export default function ReturnGate() {
  const [sp] = useSearchParams();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const token = sp.get('token');

  useEffect(() => { api('/api/me').then((m) => setHasSession(Boolean(m.elder))).catch(() => setHasSession(false)); }, []);
  useEffect(() => {
    if (hasSession !== false) return;
    if (!token) { setErr('PayPal did not send back an order reference.'); return; }
    api<Status>(`/api/paypal/orders/${encodeURIComponent(token)}/status`).then(setSt).catch((e) => setErr(e.message));
  }, [hasSession, token]);

  if (hasSession === null) return <Layout><p>Checking…</p></Layout>;
  if (hasSession) return <Order fromPayPal />;
  const paid = st?.capture?.status === 'COMPLETED';
  return (
    <Layout>
      <PageTitle eyebrow="Payment check" title={paid ? 'PayPal confirms this payment' : st ? 'No payment was taken' : err ? 'Sign in to see this payment' : 'Checking with PayPal'} lead={st ? "This browser isn't signed in as the buyer, so I asked PayPal directly. Nothing is charged from this page. Sign in on the device you started on to finish." : "This browser isn't signed in to SaySafe (for example a different browser, a private window, or an expired session). Nothing is charged from this page. Open SaySafe on the device you started on to finish; your purchase is kept there."} />
      <Card className="p-6 md:p-8 max-w-2xl">
        {err && <p className="flex gap-2 text-danger font-bold"><CircleAlert className="size-6 shrink-0" aria-hidden />{err}</p>}
        {st && (
          <>
            <p className="font-bold flex items-center gap-2">{paid ? <CheckCircle2 className="size-6 text-teal" aria-hidden /> : <CircleAlert className="size-6 text-amber" aria-hidden />}
              {paid ? 'Paid: capture completed at PayPal' : st.orderStatus === 'APPROVED' ? 'Approved at PayPal but not captured. No money was taken.' : `PayPal status: ${st.orderStatus}. No money was taken.`}</p>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-lg">
              <dt className="text-ink-soft">Amount</dt><dd className="font-bold">{st.capture?.amount ?? st.amount} {st.capture?.currency ?? st.currency}</dd>
              <dt className="text-ink-soft">PayPal order</dt><dd className="font-bold break-all">{st.orderId}</dd>
              {st.capture && <><dt className="text-ink-soft">Transaction</dt><dd className="font-bold break-all">{st.capture.id}</dd></>}
              {st.capture?.time && <><dt className="text-ink-soft">Captured</dt><dd className="font-bold">{Number.isNaN(Date.parse(st.capture.time)) ? st.capture.time : new Date(st.capture.time).toLocaleString('en-IE')}</dd></>}
            </dl>
            <p className="mt-4 text-base text-ink-soft">PayPal sandbox · demo money. Read directly from PayPal, not from SaySafe’s records.</p>
          </>
        )}
        <div className="mt-6"><LinkButton to="/">Back to home</LinkButton></div>
      </Card>
    </Layout>
  );
}
