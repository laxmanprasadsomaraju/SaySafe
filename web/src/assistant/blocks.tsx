/**
 * The component REGISTRY: the only things the Assistant can show inside the conversation.
 * Each entry renders one validated block (see schemas.ts) as plain React text. No HTML from data, ever.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldAlert, ShieldQuestion, ShieldCheck, ExternalLink, Users, Store, X, Receipt as ReceiptIcon, Clock, CheckCircle2, XCircle, ChevronRight, Columns3, Wallet, Lock, Volume2, RotateCcw } from 'lucide-react';
import { ServerPayment, ServerActivity, parseServer, familyStatusFrom, familyReviewFrom, receiptFrom, refundFrom, historyFrom, type Block, type BlockOf, type ProductItem } from './schemas';
import { api } from '../lib/api';
import { goToPayPal } from '../lib/handoff';
import { markPayPalReturn } from './thread';
import { speech } from '../lib/voice';
import { paymentLabel, verdictLabel, money as moneyCents, when, fetchActivity, shortStatus, truncateRef, TONE_CLS, type Tone } from '../lib/activity';
import { shortTitle } from '../../../shared/shopping';

export interface BlockActions {
  openItem: (item: ProductItem, source: 'channel3' | 'demo') => void;
  compare: (block: BlockOf<'product_cards'>) => void;
  allow: (block: BlockOf<'payment_prep'>) => void;
  deny: (block: BlockOf<'payment_prep'>) => void;
  share: (block: BlockOf<'scam_result'>) => void;
  /** Swap one card for its newer version (data always re-read from the server first). */
  replace: (old: Block, next: Block) => void;
  /** Append a receipt / refund card for this purchase (re-read from the server). */
  receipt: (requestId: string) => void;
  refund: (requestId: string) => void;
  /** A card learned newer server data for a purchase: other cards about it (e.g. the receipt) update too. */
  synced?: (p: ServerPayment) => void;
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
    <div className={`border-l-[8px] rounded-[var(--radius-card)] p-4 sm:p-5 ${v.cls}`} data-card="scam_result">
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
    <div className={`${cardCls} p-2 sm:p-3`} data-card="product_cards">
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
    <div className={`${cardCls} p-4`} data-card="compare">
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
    <div className={`${cardCls} p-4 sm:p-5 ${b.status === 'ready' ? 'border-2 border-teal' : ''}`} data-card="payment_prep">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xl flex items-center gap-2"><Wallet className="size-6 text-teal" aria-hidden />Review purchase</h3>
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

// ---------- Shared bits for the payment cards ----------
const btnPrimary = 'min-h-14 rounded-full bg-teal text-white font-bold px-5 hover:bg-teal-deep disabled:opacity-60';
const btnSecondary = 'min-h-12 rounded-full border-2 border-line bg-paper font-bold px-4 hover:border-teal disabled:opacity-60';
const linkCls = 'font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center';
function Pill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`inline-flex items-center rounded-full border px-3 py-0.5 text-sm font-bold ${TONE_CLS[tone]}`}>{label}</span>;
}
/** Re-reads one purchase from the server (validated). Elder: /api/payments/:id. Family: /api/family/requests/:id. */
export async function fetchPayment(id: string, as: 'elder' | 'family' = 'elder'): Promise<ServerPayment> {
  return parseServer(ServerPayment, await api(as === 'family' ? `/api/family/requests/${id}` : `/api/payments/${id}`));
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });

// ---------- Mary: family review status (live) ----------
const TERMINAL = ['CAPTURED', 'CANCELLED', 'BLOCKED', 'FAILED', 'REFUNDED', 'REFUND_PENDING'];
function familyLook(b: BlockOf<'family_status'>): { pill: string; tone: Tone; title: string; note: string | null; icon: typeof Clock } {
  const ap = b.approvalStatus;
  if (b.state === 'FAMILY_APPROVAL_PENDING' && ap === 'expired') return { pill: 'Expired', tone: 'muted', title: 'The family review expired', note: 'Nothing was paid. You can ask again from the Demo Shop.', icon: XCircle };
  if (b.state === 'FAMILY_APPROVAL_PENDING') return { pill: 'Pending', tone: 'pending', title: 'Waiting for your family member', note: 'Nothing is paid yet. This updates by itself when they answer.', icon: Clock };
  if (b.state === 'CANCELLED' && ap === 'declined') return { pill: 'Declined', tone: 'danger', title: 'Your family member said no', note: 'Nothing was paid.', icon: XCircle };
  if (b.state === 'FAMILY_APPROVED') return { pill: 'Approved', tone: 'ok', title: 'Your family member said yes', note: 'You still approve the payment yourself at PayPal.', icon: CheckCircle2 };
  if (b.state === 'PAYER_APPROVAL_PENDING') return { pill: ap === 'approved' ? 'Approved' : 'Pending', tone: 'pending', title: 'Waiting for your PayPal approval', note: 'Nothing is paid until PayPal confirms.', icon: Clock };
  if (b.state === 'CAPTURED') return { pill: 'Paid', tone: 'ok', title: 'Paid — confirmed by PayPal', note: null, icon: CheckCircle2 };
  const s = shortStatus(b.state, { approval: ap });
  return { pill: s.label, tone: s.tone, title: paymentLabel(b.state), note: s.detail ?? null, icon: TERMINAL.includes(b.state) ? XCircle : Clock };
}
function FamilyStatusCard({ b, act }: { b: BlockOf<'family_status'>; act: BlockActions }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const cur = useRef(b); cur.current = b;
  const refresh = async (manual = false) => {
    if (manual) setChecking(true);
    try {
      const next = familyStatusFrom(await fetchPayment(b.requestId));
      const was = cur.current;
      if (next.state !== was.state || next.approvalStatus !== was.approvalStatus || manual) act.replace(was, next);
      if (manual) setErr(null);
    } catch (e: any) { if (manual) setErr(e.message); }
    finally { if (manual) setChecking(false); }
  };
  // Survives reload: always re-read once on mount; poll while the family member still has to answer.
  useEffect(() => { void refresh(); }, [b.requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = b.state === 'FAMILY_APPROVAL_PENDING' && b.approvalStatus !== 'expired';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [waiting, b.requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const toPayPal = async () => {
    setBusy(true); setErr(null);
    try {
      const { approveUrl } = await api<{ approveUrl: string }>(`/api/payments/${b.requestId}/checkout`, { body: {} });
      if (typeof approveUrl !== 'string' || !/^https:\/\//.test(approveUrl)) throw new Error('PayPal did not return an approval page. Nothing was paid.');
      markPayPalReturn(b.requestId);
      goToPayPal(approveUrl);
    } catch (e: any) { setErr(e.message); setBusy(false); void refresh(); }
  };
  const look = familyLook(b);
  return (
    <div className={`${cardCls} p-4 sm:p-5 ${waiting ? 'border-2 border-amber' : ''}`} data-card="family_status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold uppercase tracking-wider text-ink-soft flex items-center gap-2"><Users className="size-5" aria-hidden />Family review</p>
        <Pill label={look.pill} tone={look.tone} />
      </div>
      <p className="mt-2 font-bold text-lg flex items-center gap-2" aria-live="polite"><look.icon className={`size-6 shrink-0 ${look.tone === 'ok' ? 'text-teal' : look.tone === 'danger' ? 'text-danger' : look.tone === 'pending' ? 'text-amber' : 'text-ink-soft'}`} aria-hidden />{look.title}</p>
      <p className="mt-1 break-words">{b.item} · <span className="font-bold">{moneyCents(b.amountCents, b.currency)} {b.currency}</span></p>
      {look.note && <p className="mt-1 text-base text-ink-soft">{look.note}</p>}
      {b.state === 'BLOCKED' && b.reasons?.length ? <p className="mt-2 text-base">{b.reasons.join(' ')}</p> : null}
      <p className="mt-2"><Sandbox /></p>
      {err && <p role="alert" className="mt-2 text-danger font-bold">{err}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {(b.state === 'FAMILY_APPROVED' || b.state === 'PAYER_APPROVAL_PENDING') && <button type="button" onClick={toPayPal} disabled={busy} className={btnPrimary}>{busy ? 'Opening PayPal…' : 'Continue to PayPal'}</button>}
        {b.state === 'CAPTURED' && <button type="button" onClick={() => act.receipt(b.requestId)} className={btnPrimary}>Show my receipt</button>}
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {!TERMINAL.includes(b.state) && <button type="button" onClick={() => void refresh(true)} disabled={checking} className={linkCls}>{checking ? 'Checking…' : 'Check now'}</button>}
          <Link to={`/order/${b.requestId}`} className={linkCls}>Open details</Link>
        </div>
      </div>
    </div>
  );
}

// ---------- Alex: family review with Approve / Decline ----------
function FamilyReviewCard({ b, act }: { b: BlockOf<'family_review'>; act: BlockActions }) {
  const [busy, setBusy] = useState<null | 'approve' | 'decline'>(null);
  const cur = useRef(b); cur.current = b;
  const sync = async (error: string | null = null) => {
    try { const p = await fetchPayment(b.requestId, 'family'); const next = familyReviewFrom(p); if (next) act.replace(cur.current, { ...next, error }); }
    catch (e: any) { if (error) act.replace(cur.current, { ...cur.current, error }); else act.replace(cur.current, { ...cur.current, error: String(e.message).slice(0, 300) }); }
  };
  useEffect(() => { void sync(); }, [b.requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(decision);
    try {
      // The server checks role, household, the exact basket (fingerprint) and expiry. The card only asks.
      const p = parseServer(ServerPayment, await api(`/api/family/requests/${b.requestId}/decision`, { body: { decision, approvalId: b.approvalId } }));
      const next = familyReviewFrom({ ...p, elderName: b.elderName });
      if (next) act.replace(cur.current, next);
    } catch (e: any) { await sync(String(e.message).slice(0, 300)); }
    finally { setBusy(null); }
  };
  const expired = b.approvalStatus === 'expired' || (b.approvalStatus === 'pending' && b.expiresAt < Date.now());
  const pending = b.approvalStatus === 'pending' && !expired && b.state === 'FAMILY_APPROVAL_PENDING';
  const look: { pill: string; tone: Tone; text: string } = pending ? { pill: 'Pending', tone: 'pending', text: `Expires at ${clock(b.expiresAt)}. Your answer applies only to this exact item and price.` }
    : expired ? { pill: 'Expired', tone: 'muted', text: 'This request expired. Nothing was paid. They can ask again.' }
    : b.approvalStatus === 'approved' ? { pill: 'Approved', tone: 'ok', text: `You approved it. ${b.elderName ?? 'They'} still approve${b.elderName ? 's' : ''} the payment at PayPal. You can’t pay from their account.` }
    : b.approvalStatus === 'declined' ? { pill: 'Declined', tone: 'danger', text: 'You declined it. Nothing was paid.' }
    : { pill: paymentLabel(b.state), tone: 'muted', text: 'This request is no longer waiting for you.' };
  const who = b.elderName ?? 'Your relative';
  return (
    <div className={`${cardCls} p-4 sm:p-5 ${pending ? 'border-2 border-amber' : ''}`} data-card="family_review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold uppercase tracking-wider text-ink-soft flex items-center gap-2"><Users className="size-5" aria-hidden />{who} asks you to check</p>
        <Pill label={look.pill} tone={look.tone} />
      </div>
      <ul className="mt-3 divide-y divide-line">
        {b.lines.map((l, i) => (
          <li key={i} className="py-2 flex items-center gap-3">
            <Thumb src={/^[A-Za-z0-9._-]+$/.test(l.image) ? `/products/${l.image}` : null} alt="" size="size-14" />
            <span className="flex-1 min-w-0 font-bold break-words">{l.name}<span className="font-normal text-ink-soft"> × {l.quantity}</span></span>
            <span className="font-bold">{moneyCents(l.lineCents, b.currency)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-2 space-y-1 text-base">
        <div className="flex flex-wrap justify-between gap-x-3"><dt className="text-ink-soft">Shop</dt><dd className="font-bold text-right">{b.merchant}</dd></div>
        <div className="flex justify-between gap-3 border-t border-line pt-2 text-[1.2rem]"><dt className="font-bold">Total</dt><dd className="font-display font-semibold">{moneyCents(b.amountCents, b.currency)} {b.currency}</dd></div>
      </dl>
      <p className="mt-2"><Sandbox /></p>
      <p className="mt-2 text-base text-ink-soft" aria-live="polite">{look.text}</p>
      {b.error && <p role="alert" className="mt-2 text-danger font-bold">{b.error}</p>}
      {pending && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button type="button" onClick={() => void decide('decline')} disabled={busy !== null} className="min-h-14 rounded-full border-2 border-danger text-danger bg-paper font-bold hover:bg-danger-soft disabled:opacity-50">{busy === 'decline' ? 'Working…' : 'Decline'}</button>
          <button type="button" onClick={() => void decide('approve')} disabled={busy !== null} className={btnPrimary}>{busy === 'approve' ? 'Working…' : 'Approve'}</button>
        </div>
      )}
    </div>
  );
}

// ---------- Receipt ----------
function ReceiptCard({ b, act }: { b: BlockOf<'receipt'>; act: BlockActions }) {
  const r = b.receipt;
  const cur = useRef(b); cur.current = b;
  // Re-read on mount: the signed PayPal notice or a refund may have arrived since this card was added.
  useEffect(() => {
    fetchPayment(b.requestId).then((p) => {
      const next = receiptFrom(p);
      const was = cur.current;
      if (next && (next.receipt.webhookConfirmed !== was.receipt.webhookConfirmed || next.state !== was.state || next.refundStatus !== was.refundStatus || next.captureVerified !== was.captureVerified)) act.replace(was, next);
    }).catch(() => {});
  }, [b.requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const amount = money(Number(r.amount), r.currency);
  const spoken = `${moneyCents(Math.round(Number(r.amount) * 100), r.currency)} to ${r.payee.replace(' (sandbox)', '')}. ${r.webhookConfirmed ? 'PayPal confirmed it and sent a signed notice.' : 'PayPal confirmed it.'} This was a sandbox payment, so no real money moved.`;
  const st = b.state === 'REFUNDED' ? shortStatus('REFUNDED') : b.refundStatus ? shortStatus(b.refundStatus) : shortStatus(b.state, { webhookConfirmed: r.webhookConfirmed });
  const row = (k: string, v: ReactNode) => <><dt className="text-ink-soft">{k}</dt><dd className="font-bold min-w-0 break-words">{v}</dd></>;
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="receipt">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold uppercase tracking-wider text-ink-soft flex items-center gap-2"><ReceiptIcon className="size-5" aria-hidden />Receipt</p>
        <Sandbox />
      </div>
      <p className="mt-2 font-display text-4xl font-semibold leading-none">{amount}</p>
      <p className="mt-2 flex flex-wrap items-center gap-2"><Pill label={st.label} tone={st.tone} />{st.extra && <Pill label={st.extra} tone={r.webhookConfirmed ? 'ok' : 'pending'} />}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
        {row('Item', b.item)}
        {row('Shop', b.merchant)}
        {row('Amount', `${amount} ${r.currency}`)}
        {b.familyApproval && row('Family', b.familyApproval === 'approved' ? 'Approved' : b.familyApproval)}
        {row('Your approval', b.buyerApproved ? 'Approved at PayPal' : 'Not recorded')}
        {row('Capture', b.captureVerified ? 'Captured · checked with PayPal' : 'Captured')}
        {row('Webhook', r.webhookConfirmed ? 'Verified — signed PayPal notice' : 'Verification pending')}
        {row('Reference', <span title={r.orderId}>{truncateRef(r.orderId)}<span className="sr-only"> (full reference {r.orderId})</span></span>)}
        {row('Refund', b.state === 'REFUNDED' ? 'Refunded' : b.refundStatus === 'REFUND_REQUESTED' ? 'Request sent — not refunded yet' : b.refundStatus === 'REFUND_PENDING' ? 'Pending — not confirmed yet' : 'None')}
        {row('When', when(b.at))}
      </dl>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
        <Link to={`/order/${b.requestId}`} className={linkCls}>Open full receipt</Link>
        {b.state === 'CAPTURED' && <button type="button" onClick={() => act.refund(b.requestId)} className={linkCls}>Refund options</button>}
        <button type="button" onClick={() => speech.speak(spoken, { priority: 'user' })} className={`${linkCls} gap-1`}><Volume2 className="size-5" aria-hidden />Read aloud</button>
      </div>
    </div>
  );
}

// ---------- History with search ----------
function PaymentHistoryCard({ b, act }: { b: BlockOf<'payment_history'>; act: BlockActions }) {
  const nav = useNavigate();
  const [q, setQ] = useState(b.query ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useRef(`hq-${Math.random().toString(36).slice(2, 8)}`).current;
  const search = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const a = parseServer(ServerActivity, await fetchActivity({ q: q.trim() || undefined, limit: 5, as: b.as === 'family' ? 'family' : undefined })); act.replace(b, historyFrom(a, q.trim(), b.as)); }
    catch (er: any) { setErr(er.message); }
    finally { setBusy(false); }
  };
  return (
    <div className={`${cardCls} p-2 sm:p-3`} data-card="payment_history">
      <form role="search" onSubmit={search} className="flex gap-2 p-2">
        <label htmlFor={id} className="sr-only">Search your history</label>
        <input id={id} type="search" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. kettle" className="flex-1 min-w-0 min-h-12 rounded-full border-2 border-line bg-paper px-4 focus:border-teal outline-none" />
        <button type="submit" disabled={busy} className="min-h-12 px-4 rounded-full bg-teal text-white font-bold disabled:opacity-60">{busy ? '…' : 'Search'}</button>
      </form>
      {err && <p role="alert" className="px-3 text-danger font-bold">{err}</p>}
      {b.query && <p className="px-3 text-base text-ink-soft" role="status">{b.total} result{b.total === 1 ? '' : 's'} for “{b.query}”</p>}
      {b.items.length === 0 ? <p className="p-3 text-ink-soft">{b.query ? 'Nothing matches.' : 'Nothing yet.'}</p> : (
        <ul className="divide-y divide-line">
          {b.items.map((it) => {
            const s = it.type === 'scan' ? { label: verdictLabel(it.status), tone: 'muted' as Tone } : shortStatus(it.status, { webhookConfirmed: it.webhookConfirmed });
            const inner = (
              <span className="min-w-0 flex-1">
                <span className="block font-bold break-words">{it.type === 'scan' ? 'Scam check: ' : ''}{it.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-base text-ink-soft">{it.amountCents !== null && <span className="font-bold text-navy">{moneyCents(it.amountCents, it.currency)}</span>}<Pill label={s.label} tone={s.tone} />{when(it.at)}</span>
              </span>
            );
            return (
              <li key={it.id}>
                {it.type === 'payment' && b.as !== 'family'
                  ? <button type="button" onClick={() => nav(`/order/${it.id}`)} className="w-full flex items-center gap-3 p-2 text-left min-h-14 hover:text-teal">{inner}<ChevronRight className="size-6 text-teal shrink-0" aria-hidden /><span className="sr-only">Open receipt</span></button>
                  : <div className="flex items-center gap-3 p-2 min-h-14">{inner}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-2 pb-1"><Link to={b.as === 'family' ? '/activity?as=family' : '/activity'} className={linkCls}>See all in Activity{b.total > b.items.length ? ` (${b.total})` : ''}</Link></p>
    </div>
  );
}

// ---------- Refund request / status ----------
function RefundCard({ b, act }: { b: BlockOf<'refund'>; act: BlockActions }) {
  const [busy, setBusy] = useState(false);
  const cur = useRef(b); cur.current = b;
  useEffect(() => { fetchPayment(b.requestId).then((p) => { const n = refundFrom(p); if (n.status !== cur.current.status) act.replace(cur.current, n); }).catch(() => {}); }, [b.requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = async () => {
    setBusy(true);
    try { const p = parseServer(ServerPayment, await api(`/api/payments/${b.requestId}/refund-request`, { body: {} })); act.replace(cur.current, refundFrom(p)); act.synced?.(p); }
    catch (e: any) { act.replace(cur.current, { ...cur.current, error: String(e.message).slice(0, 300) }); }
    finally { setBusy(false); }
  };
  const look: { pill: string; tone: Tone; title: string; text: string } = {
    can_request: { pill: 'Captured', tone: 'ok' as Tone, title: 'You can ask the shop for a refund', text: 'This sends a request to the Demo Shop. It is not a refund: the shop decides, and only PayPal’s answer makes it “Refunded”.' },
    REFUND_REQUESTED: { pill: 'Refund requested', tone: 'pending' as Tone, title: 'Request sent — not refunded yet', text: `The shop decides. You have not been refunded.${b.requestedAt ? ` Sent ${when(b.requestedAt.includes('T') ? b.requestedAt : `${b.requestedAt.replace(' ', 'T')}Z`)}.` : ''}` },
    REFUND_PENDING: { pill: 'Pending', tone: 'pending' as Tone, title: 'Refund sent to PayPal — not confirmed yet', text: 'PayPal has not confirmed it. This updates when it does.' },
    REFUNDED: { pill: 'Refunded', tone: 'ok' as Tone, title: 'Refunded', text: 'The Demo Shop refunded this through PayPal (Sandbox, no real money).' },
    not_eligible: { pill: 'Not available', tone: 'muted' as Tone, title: 'No refund request for this purchase', text: 'Only a finished (captured) payment can have a refund request.' },
  }[b.status];
  return (
    <div className={`${cardCls} p-4 sm:p-5`} data-card="refund">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold uppercase tracking-wider text-ink-soft flex items-center gap-2"><RotateCcw className="size-5" aria-hidden />Refund</p>
        <Pill label={look.pill} tone={look.tone} />
      </div>
      <p className="mt-2 font-bold text-lg" aria-live="polite">{look.title}</p>
      <p className="mt-1 break-words">{b.item} · <span className="font-bold">{moneyCents(b.amountCents, b.currency)} {b.currency}</span></p>
      <p className="mt-1 text-base text-ink-soft">{look.text}</p>
      <p className="mt-2"><Sandbox /></p>
      {b.error && <p role="alert" className="mt-2 text-danger font-bold">{b.error}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {b.status === 'can_request' && <button type="button" onClick={() => void ask()} disabled={busy} className={btnSecondary}>{busy ? 'Sending…' : 'Request a refund'}</button>}
        <Link to={`/order/${b.requestId}`} className={linkCls}>Open full receipt</Link>
      </div>
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
  family_review: ({ b, act }) => <FamilyReviewCard b={b} act={act} />,
  receipt: ({ b, act }) => <ReceiptCard b={b} act={act} />,
  payment_history: ({ b, act }) => <PaymentHistoryCard b={b} act={act} />,
  refund: ({ b, act }) => <RefundCard b={b} act={act} />,
  trusted_links: ({ b }) => <TrustedLinksCard b={b} />,
};
export function RenderBlock({ b, act }: { b: Block; act: BlockActions }) {
  const C = REGISTRY[b.kind] as (p: { b: Block; act: BlockActions }) => ReactNode;
  return <>{C({ b, act })}</>;
}
export const short = shortTitle;
