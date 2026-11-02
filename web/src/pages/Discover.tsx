import { useState } from 'react';
import { Search, ExternalLink, Info, Store, Star } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, MicButton, Caption, Notice, LinkButton } from '../components/ui';
import { api } from '../lib/api';
import { speak, useVoiceInput } from '../lib/voice';
import { useMe } from '../lib/session';

interface Offer { retailer: string; url: string; price: number; compareAt: number | null; currency: string; availability: 'InStock' | 'OutOfStock' | 'Unknown'; condition: string | null }
interface Item { id: string; title: string; brand: string | null; image: string | null; imageAlt: string; features: string[]; rating: { value: number; count: number } | null; offers: Offer[] }
interface Result { source: 'channel3'; query: string; maxPrice: number | null; currency: string; fetchedAt: string; products: Item[]; reply: string }

const money = (n: number, c: string) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: c }).format(n);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });

export default function Discover() {
  const me = useMe('elder');
  const [query, setQuery] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ask = async (text: string) => {
    setBusy(true); setErr(null); setCaption(`You said: “${text}”`);
    try {
      const r = await api<Result>('/api/discover', { body: { text } });
      setRes(r); setCaption(r.reply); speak(r.reply);
    } catch (e: any) { setErr(e.message); setRes(null); }
    finally { setBusy(false); }
  };
  const voice = useVoiceInput(ask);

  if (!me) return <Layout><p>Loading…</p></Layout>;
  return (
    <Layout>
      <PageTitle eyebrow="Find real products" title="Compare real shops" lead="Say or type what you need, for example: “Find me a microwave under €150.” I search real Irish shop listings and show you where to buy." />
      <Notice tone="info" title="You buy on the shop’s own website">
        These are real listings from other shops, found with Channel3. SaySafe doesn’t sell them or take payment for them, and your family limit doesn’t apply there. Prices and stock can change, so always check on the shop’s page.
      </Notice>
      <div className="mt-8 grid grid-cols-1 md:grid-cols-[auto_1fr] gap-8 items-center">
        <MicButton state={busy ? 'processing' : voice.state} onClick={voice.toggle} />
        <div className="space-y-4 min-w-0">
          <form className="flex flex-wrap gap-3" onSubmit={(e) => { e.preventDefault(); if (query.trim()) ask(query.trim()); }}>
            <label htmlFor="dq" className="sr-only">Type what you are looking for</label>
            <input id="dq" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type it here instead" className="flex-1 min-w-[12rem] min-h-14 rounded-full border-2 border-line px-6 bg-paper focus:border-teal outline-none" />
            <Button type="submit" busy={busy} icon={<Search className="size-6" aria-hidden />}>Search</Button>
          </form>
          {voice.error && <p role="alert" className="text-danger font-bold">{voice.error}</p>}
          <Caption text={caption} />
        </div>
      </div>

      {err && <div className="mt-6"><Notice tone="danger" title={err} /></div>}

      {res && res.products.length === 0 && (
        <div className="mt-8"><Notice tone="info" title="No matching listings">Try other words, a higher price, or the SaySafe Demo Shop.</Notice></div>
      )}

      {res && res.products.length > 0 && (
        <section aria-label="Real products" className="mt-10">
          <p className="text-base text-ink-soft flex items-start gap-2"><Info className="size-5 shrink-0 mt-0.5" aria-hidden />
            <span>Found with Channel3 at {time(res.fetchedAt)}, showing prices listed in {res.currency}{res.maxPrice ? ` up to ${money(res.maxPrice, res.currency)}` : ''}. Prices aren’t converted. SaySafe hasn’t checked these shops.</span></p>
          <ul className="mt-5 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {res.products.map((p, i) => (
              <li key={p.id}>
                <Card as="article" className="overflow-hidden flex flex-col h-full">
                  <div className="aspect-[4/3] bg-white grid place-items-center">
                    {p.image ? <img src={p.image} alt={p.imageAlt} className="max-h-full max-w-full object-contain p-3" loading="lazy" referrerPolicy="no-referrer" /> : <Store className="size-12 text-ink-soft" aria-label="No photo available" />}
                  </div>
                  <div className="p-5 flex flex-col flex-1">
                    <p className="text-sm font-bold text-teal uppercase tracking-wider">Option {i + 1}{p.brand ? ` · ${p.brand}` : ''}</p>
                    <h2 className="text-[1.3rem] mt-1 leading-snug break-words">{p.title}</h2>
                    {p.rating && <p className="mt-1 flex items-center gap-1 text-base text-ink-soft"><Star className="size-4 fill-amber text-amber" aria-hidden />{p.rating.value.toFixed(1)} out of 5 ({p.rating.count} ratings)</p>}
                    {p.features.length > 0 && <ul className="mt-2 text-base text-ink-soft list-disc pl-5">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>}
                    <h3 className="mt-4 text-base font-bold">{p.offers.length > 1 ? `${p.offers.length} shops` : 'Shop'}</h3>
                    <ul className="mt-2 divide-y divide-line flex-1">
                      {p.offers.map((o) => (
                        <li key={o.url} className="py-3 flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block font-bold break-all">{o.retailer}</span>
                            <span className="block text-sm text-ink-soft">{o.availability === 'InStock' ? 'Listed as in stock' : o.availability === 'OutOfStock' ? 'Listed as out of stock' : 'Stock unknown'}{o.condition && o.condition !== 'new' ? ` · ${o.condition}` : ''}</span>
                          </span>
                          <span className="text-right">
                            <span className="block font-display text-2xl font-semibold">{money(o.price, o.currency)}</span>
                            {o.compareAt && o.compareAt > o.price && <span className="block text-sm text-ink-soft">was {money(o.compareAt, o.currency)}</span>}
                          </span>
                          <a href={o.url} target="_blank" rel="noopener noreferrer nofollow" className="w-full inline-flex items-center justify-center gap-2 min-h-12 rounded-full border-2 border-navy px-4 font-bold text-navy hover:bg-navy hover:text-white focus-visible:outline-4"
                            aria-label={`View ${p.title} at ${o.retailer}, ${money(o.price, o.currency)}. Opens the shop’s website in a new tab`}>
                            View at {o.retailer}<ExternalLink className="size-5" aria-hidden />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Card className="mt-10 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div><h2 className="text-xl">Want to try a protected payment?</h2><p className="text-ink-soft text-lg">The SaySafe Demo Shop uses real PayPal sandbox payments with family checks.</p></div>
        <LinkButton to="/shop" variant="secondary">Open the Demo Shop</LinkButton>
      </Card>
    </Layout>
  );
}
