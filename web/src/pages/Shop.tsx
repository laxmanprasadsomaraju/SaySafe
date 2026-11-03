import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Search, Star, ShieldCheck, Users, ArrowLeft, Lock } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, MicButton, Caption, Notice, SandboxBadge } from '../components/ui';
import { api, eur, newKey, type Product } from '../lib/api';
import { speech, useVoiceInput } from '../lib/voice';
import { useMe } from '../lib/session';
import { normaliseLang } from '../../../shared/lang';

interface Quote { lines: { productId: string; name: string; unitCents: number; quantity: number; lineCents: number; image: string }[]; totalCents: number; currency: string; merchant: string; needsFamily: boolean; thresholdCents: number; spoken: string }

export default function Shop() {
  const me = useMe('elder');
  const nav = useNavigate();
  const loc = useLocation() as { state?: { query?: string; result?: any } };
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [caption, setCaption] = useState<string | null>(null);
  const [captionLang, setCaptionLang] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [paying, setPaying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newKey());
  const reviewRef = useRef<HTMLDivElement>(null);

  const [discoverQuery, setDiscoverQuery] = useState<string | null>(null);
  const turn = useRef(0);
  const applyAssistant = (r: any) => {
    setDiscoverQuery(r.discover?.query ?? null);
    if (r.discover && !r.discover.suggested) { nav('/discover', { state: { query: r.discover.query } }); return; }
    if (r.intent.action === 'shop') { setProducts(r.products); setQuote(null); }
    if (r.intent.action === 'select_product' && r.intent.choice_index && products[r.intent.choice_index - 1]) { choose(products[r.intent.choice_index - 1]); return; }
    if (r.intent.action === 'confirm' && quote) { pay(); return; }
    if (r.intent.action === 'cancel') { setQuote(null); }
    if (r.intent.action === 'check_message') { nav('/check'); return; }
    setCaption(r.reply); setCaptionLang(r.replyLang); speech.speak(r.reply, { turn: turn.current, lang: normaliseLang(r.replyLang) });
  };

  const ask = useCallback(async (text: string) => {
    setBusy(true); setErr(null); setCaption(`You said: “${text}”`);
    turn.current = speech.beginTurn();
    try {
      const myTurn = turn.current;
      const r = await api('/api/assistant', { body: { text, step: quote ? 'review' : products.length ? 'choosing' : 'shop', lastResults: products.map((p) => p.name) } });
      if (!speech.isCurrent(myTurn)) return; // stale reply: a newer request, Stop, or navigation happened
      applyAssistant(r);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); speech.endThinking(); }
  }, [products, quote]); // eslint-disable-line

  useEffect(() => { if (loc.state?.result) { turn.current = speech.generation; applyAssistant(loc.state.result); } else api<Product[]>('/api/products').then((p) => setProducts(p.slice(0, 6))); }, []); // eslint-disable-line
  const voice = useVoiceInput(ask);

  const choose = async (p: Product) => {
    setErr(null);
    try {
      const q = await api<Quote>('/api/quote', { body: { items: [{ productId: p.id, quantity: 1 }] } });
      key.current = newKey();
      setQuote(q);
      const extra = q.needsFamily ? ` This is above your protected limit of ${eur(q.thresholdCents)}, so I'll ask your family member to check it first.` : ' Would you like to pay with PayPal?';
      setCaption(q.spoken + extra); setCaptionLang(undefined); speech.speak(q.spoken + extra);
      setTimeout(() => reviewRef.current?.focus(), 50);
    } catch (e: any) { setErr(e.message); }
  };

  const pay = async () => {
    if (!quote) return;
    setPaying(true); setErr(null);
    try {
      const r = await api('/api/payments', { body: { items: quote.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), idempotencyKey: key.current } });
      if (r.approveUrl) { speech.stop(); window.location.assign(r.approveUrl); return; }
      nav(`/order/${r.request.id}`);
    } catch (e: any) { setErr(e.message); setPaying(false); }
  };

  if (!me) return <Layout><p>Loading…</p></Layout>;
  return (
    <Layout>
      <PageTitle eyebrow="Shop by voice" title={quote ? 'Check before you pay' : 'What do you need?'} lead={quote ? 'Here is exactly what you would pay, and who you would pay.' : 'Tell me, for example: “Find me a reliable kettle under €40.”'} />
      {!quote && (
        <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-8 items-center">
          <MicButton state={voice.state} onClick={voice.toggle} />
          <div className="space-y-4 min-w-0">
            <form className="flex gap-3" onSubmit={(e) => { e.preventDefault(); if (query.trim()) ask(query.trim()); }}>
              <label htmlFor="q" className="sr-only">Type what you are looking for</label>
              <input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type it here instead" className="flex-1 min-w-0 min-h-14 rounded-full border-2 border-line px-6 bg-paper focus:border-teal outline-none" />
              <Button type="submit" busy={busy} icon={<Search className="size-6" aria-hidden />}>Find</Button>
            </form>
            {voice.error && <p role="alert" className="text-danger font-bold">{voice.error}</p>}
            <Caption text={caption} lang={captionLang} />
          </div>
        </div>
      )}
      {err && <div className="mt-6"><Notice tone="danger" title={err} /></div>}
      {!quote && discoverQuery && (
        <div className="mt-6"><Notice tone="info" title="Not in the demo shop">
          <Link to="/discover" state={{ query: discoverQuery }} className="font-bold text-teal underline underline-offset-4">Look for “{discoverQuery}” in listings found for Ireland</Link>. You would buy on the shop’s own website.
        </Notice></div>
      )}
      {!quote && <p className="mt-6 text-lg text-ink-soft">This is the SaySafe Demo Shop: demo products, real PayPal sandbox payments. <Link to="/discover" className="font-bold text-teal underline underline-offset-4">Compare real shops instead</Link> · <Link to="/preferences" className="font-bold text-teal underline underline-offset-4">My preferences</Link></p>}

      {!quote && products.length > 0 && (
        <section aria-label="Options" className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {products.map((p, i) => (
            <Card key={p.id} as="article" className="overflow-hidden flex flex-col fade-up">
              <div className="aspect-[4/3] bg-teal-soft"><img src={`/products/${p.image}`} alt="" className="size-full object-cover" loading="lazy" /></div>
              <div className="p-5 flex flex-col flex-1">
                <p className="text-sm font-bold text-teal uppercase tracking-wider">Option {i + 1}</p>
                <h2 className="text-[1.45rem] mt-1">{p.name}</h2>
                <p className="mt-1 flex items-center gap-1 text-base text-ink-soft"><Star className="size-4 fill-amber text-amber" aria-hidden />{p.rating} out of 5</p>
                <p className="mt-2 text-ink-soft text-lg flex-1">It's {p.plainWords}</p>
                <div className="mt-4 flex items-center justify-between gap-3">
                  <span className="font-display text-3xl font-semibold">{eur(p.priceCents)}</span>
                  <Button onClick={() => choose(p)} aria-label={`Choose ${p.name}, ${eur(p.priceCents)}`}>Choose</Button>
                </div>
              </div>
            </Card>
          ))}
        </section>
      )}

      {quote && (
        <div ref={reviewRef} tabIndex={-1} className="grid lg:grid-cols-[1.2fr_1fr] gap-6 items-start outline-none fade-up">
          <Card className="p-6 md:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl">Your order</h2><SandboxBadge /></div>
            <ul className="mt-5 divide-y divide-line">
              {quote.lines.map((l) => (
                <li key={l.productId} className="py-4 flex gap-4 items-center">
                  <img src={`/products/${l.image}`} alt="" className="size-20 rounded-2xl object-cover bg-teal-soft" />
                  <div className="flex-1"><p className="font-bold">{l.name}</p><p className="text-ink-soft text-lg">Quantity {l.quantity}</p></div>
                  <p className="font-bold">{eur(l.lineCents)}</p>
                </li>
              ))}
            </ul>
            <dl className="mt-4 space-y-2 text-lg">
              <div className="flex justify-between"><dt className="text-ink-soft">Shop</dt><dd className="font-bold text-right">{quote.merchant}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-soft">Delivery and fees</dt><dd className="font-bold">€0.00</dd></div>
              <div className="flex justify-between border-t border-line pt-3 text-[1.5rem]"><dt className="font-bold">Total</dt><dd className="font-display font-semibold">{eur(quote.totalCents)} <span className="text-base font-sans text-ink-soft">{quote.currency}</span></dd></div>
            </dl>
          </Card>
          <div className="space-y-5">
            <Card className="p-6 space-y-4">
              <p className="flex items-start gap-3"><ShieldCheck className="size-7 text-teal shrink-0" aria-hidden /><span><span className="font-bold block">Safety check passed</span><span className="text-ink-soft text-lg">Known shop, normal price, euro currency.</span></span></p>
              <p className="flex items-start gap-3"><Users className={`size-7 shrink-0 ${quote.needsFamily ? 'text-amber' : 'text-teal'}`} aria-hidden /><span><span className="font-bold block">{quote.needsFamily ? 'Family check needed' : 'No family check needed'}</span><span className="text-ink-soft text-lg">Your protected limit is {eur(quote.thresholdCents)}.</span></span></p>
              <p className="flex items-start gap-3"><Lock className="size-7 text-teal shrink-0" aria-hidden /><span><span className="font-bold block">You approve the payment at PayPal</span><span className="text-ink-soft text-lg">SaySafe never sees your PayPal password.</span></span></p>
            </Card>
            <Caption text={caption} lang={captionLang} />
            <div className="flex flex-col gap-3">
              <Button onClick={pay} busy={paying}>{quote.needsFamily ? 'Ask my family to check' : 'Continue to PayPal'}</Button>
              <Button variant="secondary" icon={<ArrowLeft className="size-6" aria-hidden />} onClick={() => { setQuote(null); setCaption(null); }} disabled={paying}>Cancel, go back</Button>
            </div>
            <div className="flex flex-col items-center pt-2"><MicButton size="md" state={voice.state} onClick={voice.toggle} label="Or say “yes” or “cancel”" /></div>
          </div>
        </div>
      )}
    </Layout>
  );
}
