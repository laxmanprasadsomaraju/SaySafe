import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { SandboxBadge } from '../components/ui';

type Step = { title: string; body: string; tag: 'Live' | 'Sandbox' | 'Test on your device' };
const STEPS: Step[] = [
  { title: 'Start as Mary', body: 'On the home page, choose “Try it free as Mary”. No sign-up. A private demo household is created for you, with a €75 family limit.', tag: 'Live' },
  { title: 'Check a suspicious message', body: 'Choose “Check a message”, then the sample invoice, or paste any text, link, email address or phone number. You can also upload a screenshot. SaySafe shows its verdict, the evidence it found and safe next steps, and can read the result aloud.', tag: 'Live' },
  { title: 'Shop with your voice or by typing', body: 'Choose “Shop by voice”. Tap the microphone and say “I need a kettle”, or type it. SaySafe reads back the exact item, shop and price before anything is paid.', tag: 'Test on your device' },
  { title: 'Pay with PayPal (sandbox)', body: 'Pick an item under €75 and continue to PayPal. Log in with a PayPal sandbox personal (buyer) account and approve. SaySafe re-checks the order with PayPal before it says “paid”. Cancelling at PayPal brings you back with nothing charged.', tag: 'Sandbox' },
  { title: 'Hear the receipt', body: 'The receipt shows PayPal’s own order and transaction numbers. Choose “Read my receipt” to hear it. The same words are always on screen.', tag: 'Test on your device' },
  { title: 'Bring in family for bigger purchases', body: 'Choose “Get trusted help” and create an invite code. Open the invite on a second phone or browser as the family member. Then, as Mary, choose something over €75, such as the €120 microwave. The family member sees the exact item and price and can approve or decline. Mary still approves the payment at PayPal herself.', tag: 'Live' },
];

const tagStyle: Record<Step['tag'], string> = {
  Live: 'bg-teal-soft text-teal',
  Sandbox: 'bg-amber-soft text-amber',
  'Test on your device': 'bg-ivory text-ink border border-line',
};

export default function Guide() {
  return (
    <Layout mode="public">
      <section className="wrap py-12 md:py-16 max-w-3xl">
        <SandboxBadge />
        <h1 className="mt-5 display-2">How to use SaySafe</h1>
        <p className="mt-4 text-xl text-ink-soft leading-relaxed">A two-minute walkthrough of the live demo. Payments use the PayPal sandbox, so no real money moves.</p>
        <ol className="mt-10 space-y-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="bg-paper rounded-[var(--radius-card)] border border-line p-5 sm:p-6 flex gap-4">
              <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-navy text-white font-bold text-lg">{i + 1}</span>
              <div className="min-w-0">
                <h2 className="text-2xl">{s.title}</h2>
                <p className={`mt-2 inline-block rounded-full px-3 py-1 text-sm font-bold ${tagStyle[s.tag]}`}>{s.tag}</p>
                <p className="mt-3 text-lg leading-relaxed text-ink-soft">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <h2 className="mt-12 text-2xl">Display and voice settings</h2>
        <p className="mt-3 text-lg leading-relaxed text-ink-soft">Every screen has Bigger text, Contrast and Voice buttons at the top. Spoken replies are optional and always shown as text too. Animations switch off if your device asks for reduced motion.</p>
        <h2 className="mt-10 text-2xl">What SaySafe never does</h2>
        <p className="mt-3 text-lg leading-relaxed text-ink-soft">It never pays without your approval at PayPal, never lets a family member pay from your account, never calls an unknown link “safe”, and never opens links found in messages.</p>
        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-lg font-bold">
          <Link to="/" className="link text-teal underline underline-offset-4 min-h-12 inline-flex items-center">Back to the start</Link>
          <a href="https://github.com/laxmanprasadsomaraju/SaySafe" className="link text-teal underline underline-offset-4 min-h-12 inline-flex items-center" target="_blank" rel="noreferrer">Source code and setup (GitHub)</a>
        </div>
      </section>
    </Layout>
  );
}
