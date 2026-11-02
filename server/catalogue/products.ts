/**
 * SaySafe Demo Shop — a sandbox-only storefront. All products are fictional demo items;
 * images are original illustrations made for this project. Checkout is a PayPal SANDBOX transaction.
 */
export interface Product {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  currency: 'EUR';
  merchant: string;
  rating: number;
  description: string;
  plainWords: string; // how the assistant explains it out loud
  features: string[];
  image: string; // served from /products/
  keywords: string[];
}

export const DEMO_MERCHANT = 'SaySafe Demo Shop (sandbox)';

export const PRODUCTS: Product[] = [
  { id: 'kettle-classic', name: 'Easy-Pour Electric Kettle 1.5L', category: 'Kitchen', priceCents: 3200, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.7,
    description: 'Lightweight 1.5 litre kettle with a large, easy-to-read water window, cool-touch handle and automatic switch-off.',
    plainWords: 'a light kettle with a big water window and a handle that stays cool. It switches itself off.',
    features: ['Auto switch-off', 'Cool-touch handle', 'Large water window'], image: 'kettle.webp', keywords: ['kettle', 'tea', 'boil', 'water', 'electric kettle'] },
  { id: 'kettle-quiet', name: 'Whisper Quiet Kettle 1.7L', category: 'Kitchen', priceCents: 3850, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.5,
    description: 'Quiet-boil kettle with keep-warm setting and a light that shows when it is on.',
    plainWords: 'a quieter kettle that keeps water warm, with a light so you can see it is on.',
    features: ['Quiet boil', 'Keep warm', 'On light'], image: 'kettle-quiet.webp', keywords: ['kettle', 'quiet', 'tea', 'boil'] },
  { id: 'coffee-maker', name: 'One-Button Coffee Maker', category: 'Kitchen', priceCents: 6500, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.4,
    description: 'Filter coffee maker with one large start button and a 40-minute safety switch-off.',
    plainWords: 'a coffee maker with one big button. It turns itself off after 40 minutes.',
    features: ['One large button', 'Auto off after 40 min', '10 cups'], image: 'coffee.webp', keywords: ['coffee', 'coffee maker', 'filter'] },
  { id: 'microwave', name: 'Simple Dial Microwave 20L', category: 'Kitchen', priceCents: 12000, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.6,
    description: '20 litre microwave with two large dials instead of small buttons, and a loud finished chime.',
    plainWords: 'a microwave with two big dials instead of tiny buttons, and a loud chime when food is ready.',
    features: ['Two large dials', 'Loud chime', '700W'], image: 'microwave.webp', keywords: ['microwave', 'oven', 'heat food'] },
  { id: 'toaster', name: 'Wide-Slot Toaster', category: 'Kitchen', priceCents: 2900, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.3,
    description: 'Two-slice toaster with extra-wide slots, high-lift lever and crumb tray.',
    plainWords: 'a toaster with wide slots and a lever that lifts the toast up high so it is easy to reach.',
    features: ['Wide slots', 'High lift', 'Crumb tray'], image: 'toaster.webp', keywords: ['toaster', 'toast', 'bread'] },
  { id: 'phone-big-button', name: 'Big Button Home Phone', category: 'Home', priceCents: 4500, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.6,
    description: 'Corded home phone with large buttons, loud ringer and three photo speed-dial keys.',
    plainWords: 'a home phone with big buttons, a loud ring, and three photo buttons to call family quickly.',
    features: ['Large buttons', 'Photo speed-dial', 'Loud ringer'], image: 'phone.webp', keywords: ['phone', 'telephone', 'landline', 'big button'] },
  { id: 'reading-lamp', name: 'Bright Reading Lamp', category: 'Home', priceCents: 3500, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.5,
    description: 'LED floor reading lamp with a flexible neck and a foot switch.',
    plainWords: 'a bright reading lamp with a bendy neck. You switch it on with your foot.',
    features: ['Bright LED', 'Flexible neck', 'Foot switch'], image: 'lamp.webp', keywords: ['lamp', 'light', 'reading'] },
  { id: 'pill-organiser', name: 'Weekly Pill Organiser with Alarm', category: 'Health', priceCents: 1900, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.4,
    description: '7-day pill box with morning and evening compartments and a gentle reminder alarm.',
    plainWords: 'a pill box for the week, with morning and evening sections and a gentle reminder alarm.',
    features: ['7 days', 'AM and PM', 'Reminder alarm'], image: 'pills.webp', keywords: ['pill', 'pills', 'medicine', 'tablet', 'organiser', 'organizer'] },
  { id: 'heated-throw', name: 'Soft Heated Throw', category: 'Home', priceCents: 5900, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.7,
    description: 'Machine-washable heated throw with 3 heat levels and auto-off after 3 hours.',
    plainWords: 'a soft heated blanket with three heat levels. It turns itself off after three hours.',
    features: ['3 heat levels', 'Auto off', 'Washable'], image: 'throw.webp', keywords: ['blanket', 'throw', 'heated', 'warm'] },
  { id: 'radio', name: 'Easy Tune Radio', category: 'Home', priceCents: 3900, currency: 'EUR', merchant: DEMO_MERCHANT, rating: 4.5,
    description: 'DAB+ and FM radio with three large preset buttons and a big volume knob.',
    plainWords: 'a radio with three big buttons for your favourite stations and a large volume knob.',
    features: ['DAB+ and FM', '3 presets', 'Big volume knob'], image: 'radio.webp', keywords: ['radio', 'music', 'news'] },
];

export function getProduct(id: string) {
  return PRODUCTS.find((p) => p.id === id) ?? null;
}

/** Deterministic search used directly and as the tool behind the AI shopping agent. */
export function searchProducts(query: string, maxPriceCents?: number | null, limit = 3) {
  const q = query.toLowerCase();
  const terms = q.split(/[^a-z]+/).filter((t) => t.length > 2);
  const scored = PRODUCTS.map((p) => {
    let score = 0;
    for (const k of p.keywords) if (q.includes(k)) score += 3;
    for (const t of terms) {
      if (p.name.toLowerCase().includes(t)) score += 2;
      if (p.category.toLowerCase() === t) score += 1;
    }
    return { p, score };
  })
    .filter((x) => x.score > 0)
    .filter((x) => maxPriceCents == null || x.p.priceCents <= maxPriceCents)
    .sort((a, b) => b.score - a.score || b.p.rating - a.p.rating);
  return scored.slice(0, limit).map((x) => x.p);
}
