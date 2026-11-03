/**
 * The component REGISTRY: the only things the Assistant can show inside the conversation.
 * Each entry renders one validated block (see schemas.ts) as plain React text. No HTML from data, ever.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldAlert, ShieldQuestion, ShieldCheck, ExternalLink, Users, Store, X, Receipt as ReceiptIcon, Clock, CheckCircle2, XCircle, ChevronRight, Columns3, Wallet, Lock, Volume2 } from 'lucide-react';
import type { Block, BlockOf, ProductItem } from './schemas';
import { api, type PaymentRequest } from '../lib/api';
import { goToPayPal } from '../lib/handoff';
import { speech } from '../lib/voice';
import { paymentLabel, verdictLabel, money as moneyCents, when } from '../lib/activity';
import { shortTitle } from '../../../shared/shopping';

export interface BlockActions {
  openItem: (item: ProductItem, source: 'channel3' | 'demo') => void;
  compare: (block: BlockOf<'product_cards'>) => void;
  allow: (block: BlockOf<'payment_prep'>) => void;
  deny: (block: BlockOf<'payment_prep'>) => void;
  share: (block: BlockOf<'scam_result'>) => void;
  update: (next: Block) => void;
}

const money = (n: number, c: string) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: c }).format(n);
const cardCls = 'rounded-[var(--radius-card)] border border-line bg-paper shadow-[var(--shadow-card)]';
const Sandbox = () => <span className="inline-flex items-center rounded-full bg-amber-soft text-amber font-bold text-sm px-3 py-0.5 border border-amber/30">PayPal Sandbox · no real money</span>;

// ---------- Scam result ----------
const VERDICT: Record<string, { icon: typeof ShieldAlert; cls: string; ic: string }> = {
  suspicious: { icon: ShieldAlert, cls: 'bg-danger-soft border-danger', ic: 'text-danger' },
  needs_verification: { icon: ShieldQuestion, cls: 'bg-amber-soft border-amber', ic: 'text-amber' },
  needs_checking: { icon: ShieldQuestion, cls: 'bg-amber-soft border-amber', ic: 'text-amber' },
  verified_official_contact: { icon: ShieldCheck, cls: 'bg-teal-soft border-teal', ic: 'text-teal' },
  no_obvious_warning_signs: { icon: ShieldCheck, cls: 'bg-teal-soft border-teal', ic: 'text-teal' },
};
function ScamResultCard({ b, act }: { b: BlockOf<'scam_result'>; act: BlockActions }) {
  const v = VERDICT[b.verdict] ?? VERDICT.needs_checking;
  const top = b.signals.filter((s) => s.severity !== 'info').slice(0, 3);
  return (
    <div className={`border-l-[8px] rounded-[var(--radius-card)] p-4 sm:p-5 ${v.cls}`}>
      <p className={`flex items-center gap-2 font-bold uppercase tracking-wider text-sm ${v.ic}`}><v.icon className="size-6" aria-hidden />{verdictLabel(b.verdict)}</p>
      <h3 className="text-[1.4rem] mt-1 break-words">{b.headline}</h3>
      <p className="mt-2 break-words">{b.summary}</p>
      {b.aiNotice && <p className="mt-2 text-base text-ink-soft">{b.aiNotice}. The safe steps are the same.</p>}
      {top.length > 0 && (
        <ul className="mt-3 space-y-2">
          {top.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className={`mt-2.5 size-2.5 rounded-full shrink-0 ${s.severity === 'high' ? 'bg-danger' : 'bg-amber'}`} aria-hidden />
              <span className="min-w-0"><span className="font-bold">{s.title}</span><span className="sr-only"> ({s.severity === 'high' ? 'strong warning' : 'warning'})</span>{s.evidence && <span className="block text-base text-ink-soft break-all">Seen: {s.evidence}</span>}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {b.safeActions[0] && (
          <a href={b.safeActions[0].url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-between gap-3 rounded-2xl bg-teal text-white font-bold px-5 min-h-14 hover:bg-teal-deep">
            <span>{b.safeActions[0].label}</span><ExternalLink className="size-5 shrink-0" aria-hidden /><span className="sr-only"> (opens PayPal in a new tab)</span>
          </a>
        )}
        <button type="button" disabled={b.shared} onClick={() => act.share(b)} className="inline-flex items-center justify-center gap-2 rounded-full border-2 border-line bg-paper font-bold px-5 min-h-12 hover:border-teal disabled:opacity-60">
          <Users className="size-5" aria-hidden />{b.shared ? 'Sent to your family' : 'Ask a family member'}
        </button>
        <Link to="/check" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">Open the full check page</Link>
      </div>
    </div>
  );
}

// ---------- Product cards ----------
function Thumb({ src, alt, size = 'size-16' }: { src: string | null; alt: string; size?: string }) {
  return (
    <span className={`${size} shrink-0 rounded-xl bg-white border border-line grid place-items-center overflow-hidden`}>
      {src ? <img src={src} alt={alt} className="max-h-full max-w-full object-contain" loading="lazy" referrerPolicy="no-referrer" /> : <Store className="size-7 text-ink-soft" aria-hidden />}
    </span>
  );
}
function ProductCardsBlock({ b, act }: { b: BlockOf<'product_cards'>; act: BlockActions }) {
  const [all, setAll] = useState(false);
  const shown = all ? b.items : b.items.slice(0, 3);
  return (
    <div className={`${cardCls} p-2 sm:p-3`}>
      <ul aria-label={b.source === 'demo' ? 'Demo Shop options' : 'Shop listings'}>
        {shown.map((p, i) => (
          <li key={p.id}>
            <button type="button" onClick={() => act.openItem(p, b.source)} className="w-full flex items-center gap-3 p-2 rounded-2xl text-left hover:bg-teal-soft min-h-20"
              aria-label={`${p.title}, ${money(p.price, p.currency)} at ${p.retailer}${p.role === 'best' ? ', best match' : ''}. Open details`}>
              <Thumb src={p.image} alt="" />
              <span className="min-w-0 flex-1">
                {p.role === 'best' && i === 0 && <span className="block text-sm font-bold uppercase tracking-wider text-teal">Best match</span>}
                <span className="block font-bold leading-snug line-clamp-2 break-words">{p.title}</span>
                <span className="block text-base text-ink-soft truncate">{p.retailer}</span>
                <span className="block font-bold">{money(p.price, p.currency)}{p.compareAt && p.compareAt > p.price ? <span className="font-normal text-base text-ink-soft"> · was {money(p.compareAt, p.currency)}</span> : null}</span>
              </span>
              <ChevronRight className="size-6 text-teal shrink-0" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 px-2 pb-1 pt-1">
        {b.items.length > 3 && <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="min-h-12 px-4 rounded-full border-2 border-line font-bold hover:border-teal">{all ? 'Show fewer' : `Show ${b.items.length - 3} more`}</button>}
        {b.items.length > 1 && <button type="button" onClick={() => act.compare(b)} className="min-h-12 px-4 rounded-full border-2 border-line font-bold hover:border-teal inline-flex items-center gap-2"><Columns3 className="size-5" aria-hidden />Compare</button>}
      </div>
      <p className="px-2 pb-2 text-sm text-ink-soft">{b.source === 'demo' ? 'SaySafe Demo Shop: demo products, PayPal Sandbox payments.' : `Found with Channel3${b.fetchedAt ? ` at ${new Date(b.fetchedAt).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}` : ''}. Prices can change. You buy on the shop’s own website; SaySafe hasn’t checked these shops.`}{b.note ? ` ${b.note}` : ''}</p>
    </div>
  );
}

/** Bottom sheet for one product. Channel3: "View on retailer site" only. Demo Shop: prepare a sandbox payment. */
export function ProductSheet({ item, source, onClose, onPrepare }: { item: ProductItem; source: 'channel3' | 'demo'; onClose: () => void; onPrepare: (p: ProductItem) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal?.(); return () => { if (d?.open) d.close(); }; }, []);
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }} aria-labelledby="sheet-title"
      className="mt-auto mb-0 mx-auto w-full max-w-xl max-h-[92dvh] rounded-t-[1.75rem] sm:rounded-[1.75rem] sm:mb-auto bg-paper text-navy p-0 border-0 overflow-y-auto">
      <div className="relative bg-white grid place-items-center h-56 sm:h-72 overflow-hidden">
        {item.image ? <img src={item.image} alt={item.imageAlt} className="h-full w-full object-contain p-4" referrerPolicy="no-referrer" /> : <Store className="size-16 text-ink-soft" aria-label="No photo available" />}
        <button type="button" onClick={onClose} aria-label="Close" className="absolute top-3 right-3 size-12 rounded-full bg-paper border-2 border-line grid place-items-center hover:border-teal"><X className="size-6" aria-hidden /></button>
      </div>
      <div className="p-5 sm:p-6">
        <p className="text-base text-ink-soft">Sold by: <span className="font-bold text-navy">{item.retailer}</span></p>
        <h2 id="sheet-title" className="text-[1.5rem] mt-1 break-words">{item.title}</h2>
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2"><span className="font-display text-3xl font-semibold">{money(item.price, item.currency)}</span>{item.compareAt && item.compareAt > item.price && <span className="text-base text-ink-soft line-through">{money(item.compareAt, item.currency)}</span>}</p>
        {source === 'channel3' && <p className="text-base text-ink-soft">{item.availability === 'InStock' ? 'Listed as in stock' : item.availability === 'OutOfStock' ? 'Listed as out of stock' : 'Stock not listed'}</p>}
        {item.reasons && item.reasons.length > 0 && <p className="mt-3 rounded-xl bg-teal-soft px-4 py-3 text-base"><span className="font-bold">Why: </span>{item.reasons.slice(0, 3).join('; ')}.</p>}
        {item.features.length > 0 && <ul className="mt-3 text-base text-ink-soft list-disc pl-5">{item.features.slice(0, 4).map((f) => <li key={f}>{f}</li>)}</ul>}
        <div className="mt-5 flex flex-col gap-2">
          {source === 'channel3' && item.url && (
            <a href={item.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center justify-center gap-2 min-h-14 rounded-full bg-navy text-white px-5 font-bold hover:bg-teal-deep">
              View on retailer site<ExternalLink className="size-5" aria-hidden /><span className="sr-only"> (opens {item.retailer} in a new tab)</span>
            </a>
          )}
          {source === 'channel3' && <p className="text-sm text-ink-soft text-center">SaySafe doesn’t sell this or take payment for it. Family checks don’t cover other shops.</p>}
          {source === 'demo' && item.productId && (
            <button type="button" onClick={() => onPrepare(item)} className="inline-flex items-center justify-center gap-2 min-h-14 rounded-full bg-teal text-white px-5 font-bold hover:bg-teal-deep">
              <Wallet className="size-5" aria-hidden />Prepare PayPal Sandbox payment
            </button>
          )}
          <button type="button" onClick={onClose} className="min-h-12 font-bold text-teal underline underline-offset-4">Close</button>
        </div>
      </div>
    </dialog>
  );
}

// ---------- Compare ----------
function CompareBlock({ b }: { b: BlockOf<'compare'> }) {
  return (
    <div className={`${cardCls} p-4`}>
      <h3 className="text-xl">Side by side</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {b.names.map((name, col) => (
          <section key={name + col} className="rounded-2xl border border-line p-3" aria-label={name}>
            <h4 className="font-bold break-words">{name}</h4>
            <dl className="mt-2 text-base space-y-1">
              {b.rows.map((r) => (
                <div key={r.label} className="flex flex-wrap gap-x-2"><dt className="text-ink-soft">{r.label}:</dt><dd className="min-w-0 break-words">{r.values[col] ?? <span className="italic text-ink-soft">Not listed</span>}</dd></div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="mt-3 text-sm text-ink-soft">Only what each listing states. “Not listed” means the shop didn’t give it.</p>
    </div>
  );
}

// ---------- Demo Shop payment prep (the approval card) ----------
function PaymentPrepCard({ b, act }: { b: BlockOf<'payment_prep'>; act: BlockActions }) {
  const done = b.status === 'denied' || b.status === 'sent';
  return (
    <div className={`${cardCls} p-4 sm:p-5 ${b.status === 'ready' ? 'border-2 border-teal' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xl flex items-center gap-2"><Wallet className="size-6 text-teal" aria-hidden />Check before you pay</h3>
        <Sandbox />
      </div>
      <p className="mt-1 text-base text-ink-soft">{b.merchant} would take this PayPal Sandbox payment.</p>
      <ul className="mt-3 divide-y divide-line">
        {b.lines.map((l) => (
          <li key={l.productId} className="py-2 flex items-center gap-3">
            <Thumb src={`/products/${l.image}`} alt="" size="size-14" />
            <span className="flex-1 min-w-0 font-bold break-words">{l.name}<span className="font-normal text-ink-soft"> × {l.quantity}</span></span>
            <span className="font-bold">{moneyCents(l.lineCents, b.currency)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-2 space-y-1 text-base">
        <div className="flex flex-wrap justify-between gap-x-3"><dt className="text-ink-soft">Pay with</dt><dd className="font-bold text-right inline-flex items-center gap-1"><Lock className="size-4 shrink-0" aria-hidden />PayPal (you approve there)</dd></div>
        <div className="flex flex-wrap justify-between gap-x-3"><dt className="text-ink-soft">Family check</dt><dd className="font-bold text-right">{b.needsFamily ? `Yes, above your ${moneyCents(b.thresholdCents, b.currency)} limit` : 'Not needed'}</dd></div>
        <div className="flex justify-between gap-3 border-t border-line pt-2 text-[1.2rem]"><dt className="font-bold">Total</dt><dd className="font-display font-semibold">{moneyCents(b.totalCents, b.currency)} {b.currency}</dd></div>
      </dl>
      {b.status === 'error' && b.error && <p role="alert" className="mt-3 text-danger font-bold">{b.error}</p>}
      {b.status === 'denied' && <p className="mt-3 font-bold">You said no. Nothing was paid.</p>}
      {b.status === 'sent' && b.requestId && <p className="mt-3"><Link className="font-bold text-teal underline underline-offset-4" to={`/order/${b.requestId}`}>Open this purchase</Link></p>}
      {!done && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button type="button" onClick={() => act.deny(b)} disabled={b.status === 'sending'} className="min-h-14 rounded-full border-2 border-line bg-paper font-bold hover:border-teal disabled:opacity-50">Deny</button>
          <button type="button" onClick={() => act.allow(b)} disabled={b.status === 'sending'} aria-busy={b.status === 'sending' || undefined} className="min-h-14 rounded-full bg-teal text-white font-bold hover:bg-teal-deep disabled:opacity-60 px-2 leading-tight">
            {b.status === 'sending' ? 'Working…' : 'Allow'}<span className="sr-only">{b.needsFamily ? ': ask my family to check' : ': continue to PayPal'}</span>
          </button>
        </div>
      )}
      {!done && <p className="mt-2 text-sm text-ink-soft">{b.needsFamily ? 'Allow sends it to your family member to check. You still approve at PayPal afterwards.' : 'Allow takes you to PayPal to approve. Nothing is paid until PayPal confirms.'}</p>}
    </div>
  );
}

// ---------- Family review status ----------
function FamilyStatusCard({ b, act }: { b: BlockOf<'family_status'>; act: BlockActions }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (b.state !== 'FAMILY_APPROVAL_PENDING') return;
    const t = setInterval(() => {
      api<PaymentRequest>(`/api/payments/${b.requestId}`).then((r) => { if (r.state !== b.state) act.update({ ...b, state: r.state, approvalStatus: r.approval?.status ?? null }); }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [b.state, b.requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const toPayPal = async () => {
    setBusy(true); setErr(null);
    try { const { approveUrl } = await api<{ approveUrl: string }>(`/api/payments/${b.requestId}/checkout`, { body: {} }); goToPayPal(approveUrl); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const declined = b.state === 'CANCELLED' && b.approvalStatus === 'declined';
  const Icon = b.state === 'FAMILY_APPROVAL_PENDING' ? Clock : b.state === 'FAMILY_APPROVED' || b.state === 'CAPTURED' ? CheckCircle2 : XCircle;
  return (
    <div className={`${cardCls} p-4 sm:p-5 ${b.state === 'FAMILY_APPROVAL_PENDING' ? 'border-2 border-amber' : ''}`} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold text-lg flex items-center gap-2"><Icon className={`size-6 ${b.state === 'FAMILY_APPROVAL_PENDING' ? 'text-amber' : 'text-teal'}`} aria-hidden />{declined ? 'Your family member said no' : paymentLabel(b.state)}</p>
        <Sandbox />
      </div>
      <p className="mt-1 break-words">{b.item} · <span className="font-bold">{moneyCents(b.amountCents, b.currency)}</span></p>
      {b.state === 'FAMILY_APPROVAL_PENDING' && <p className="mt-2 text-base text-ink-soft">Nothing is paid yet. This updates by itself when they answer.</p>}
      {b.state === 'BLOCKED' && b.reasons?.length ? <p className="mt-2 text-base">{b.reasons.join(' ')}</p> : null}
      {declined && <p className="mt-2 text-base">Nothing was paid.</p>}
      {err && <p role="alert" className="mt-2 text-danger font-bold">{err}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {(b.state === 'FAMILY_APPROVED' || b.state === 'PAYER_APPROVAL_PENDING') && <button type="button" onClick={toPayPal} disabled={busy} className="min-h-14 rounded-full bg-teal text-white font-bold px-5 hover:bg-teal-deep disabled:opacity-60">{busy ? 'Opening PayPal…' : 'Continue to PayPal'}</button>}
        <Link to={`/order/${b.requestId}`} className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">Open details</Link>
      </div>
    </div>
  );
}

// ---------- Receipt ----------
function ReceiptCard({ b }: { b: BlockOf<'receipt'> }) {
  const r = b.receipt;
  const spoken = `${moneyCents(Math.round(Number(r.amount) * 100), r.currency)} to ${r.payee.replace(' (sandbox)', '')}. ${r.webhookConfirmed ? 'PayPal confirmed it and sent a signed notice.' : 'PayPal confirmed it.'} This was a sandbox payment, so no real money moved.`;
  return (
    <div className={`${cardCls} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xl flex items-center gap-2"><ReceiptIcon className="size-6 text-teal" aria-hidden />{b.state === 'CAPTURED' ? 'Receipt confirmed by PayPal' : paymentLabel(b.state)}</h3>
        <Sandbox />
      </div>
      <p className="mt-1 break-words">{b.item}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
        <dt className="text-ink-soft">Amount</dt><dd className="font-bold">{money(Number(r.amount), r.currency)} {r.currency}</dd>
        <dt className="text-ink-soft">Paid to</dt><dd className="font-bold break-words">{r.payee}</dd>
        <dt className="text-ink-soft">When</dt><dd className="font-bold">{when(b.at)}</dd>
        <dt className="text-ink-soft">PayPal order</dt><dd className="font-bold break-all">{r.orderId}</dd>
        <dt className="text-ink-soft">Transaction</dt><dd className="font-bold break-all">{r.captureId}</dd>
      </dl>
      <p className="mt-2 text-sm text-ink-soft">{r.webhookConfirmed ? 'PayPal also sent a signed notice confirming this capture.' : 'Checked directly with PayPal. Signed PayPal notice not received yet.'}{b.evidenceLabel ? ` ${b.evidenceLabel}.` : ''}</p>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
        <Link to={`/order/${b.requestId}`} className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">Open full receipt and timeline</Link>
        <button type="button" onClick={() => speech.speak(spoken, { priority: 'user' })} className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center gap-1"><Volume2 className="size-5" aria-hidden />Read aloud</button>
      </div>
    </div>
  );
}

// ---------- Payment history ----------
function PaymentHistoryCard({ b }: { b: BlockOf<'payment_history'> }) {
  const nav = useNavigate();
  return (
    <div className={`${cardCls} p-2 sm:p-3`}>
      {b.items.length === 0 ? <p className="p-3 text-ink-soft">No payments yet.</p> : (
        <ul className="divide-y divide-line">
          {b.items.map((it) => (
            <li key={it.id}>
              <button type="button" onClick={() => nav(`/order/${it.id}`)} className="w-full flex items-center gap-3 p-2 text-left min-h-14 hover:text-teal">
                <span className="min-w-0 flex-1"><span className="block font-bold break-words">{it.title}</span><span className="block text-base text-ink-soft">{moneyCents(it.amountCents, it.currency)} · {paymentLabel(it.status)} · {when(it.at)}</span></span>
                <ChevronRight className="size-6 text-teal shrink-0" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="px-2 pb-1"><Link to="/activity" className="font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center">See all in Activity{b.total > b.items.length ? ` (${b.total})` : ''}</Link></p>
    </div>
  );
}

// ---------- Trusted help links ----------
function TrustedLinksCard({ b }: { b: BlockOf<'trusted_links'> }) {
  return (
    <ul className={`${cardCls} p-2 divide-y divide-line`}>
      {b.items.map((l) => (
        <li key={l.label}>
          {'to' in l
            ? <Link to={l.to} className="flex items-center justify-between gap-3 p-3 min-h-14 font-bold hover:text-teal">{l.label}<ChevronRight className="size-5 shrink-0" aria-hidden /></Link>
            : <a href={l.href} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3 p-3 min-h-14 font-bold hover:text-teal">{l.label}<ExternalLink className="size-5 shrink-0" aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a>}
        </li>
      ))}
    </ul>
  );
}

/** The registry itself: kind -> component. Nothing outside this map can be rendered in the conversation. */
export const REGISTRY: { [K in Block['kind']]: (p: { b: BlockOf<K>; act: BlockActions }) => ReactNode } = {
  scam_result: ({ b, act }) => <ScamResultCard b={b} act={act} />,
  product_cards: ({ b, act }) => <ProductCardsBlock b={b} act={act} />,
  compare: ({ b }) => <CompareBlock b={b} />,
  payment_prep: ({ b, act }) => <PaymentPrepCard b={b} act={act} />,
  family_status: ({ b, act }) => <FamilyStatusCard b={b} act={act} />,
  receipt: ({ b }) => <ReceiptCard b={b} />,
  payment_history: ({ b }) => <PaymentHistoryCard b={b} />,
  trusted_links: ({ b }) => <TrustedLinksCard b={b} />,
};
export function RenderBlock({ b, act }: { b: Block; act: BlockActions }) {
  const C = REGISTRY[b.kind] as (p: { b: Block; act: BlockActions }) => ReactNode;
  return <>{C({ b, act })}</>;
}
export const short = shortTitle;
