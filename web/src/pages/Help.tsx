/**
 * Help centre (/help): public, step-by-step help for every part of SaySafe, searchable and anchored
 * (/help#family-reviews). When Mary is signed in, her own trusted-help tools (order problem, family code)
 * appear at the top, so the existing "Problem with this order?" and "Invite a family member" links keep working.
 * Screenshots are real captures of the Check, Family and Receipt screens (web/public/screens). Tabs that are
 * being redesigned (Home, Assistant, Activity, Profile) are referred to by name only.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ExternalLink, Mail, PackageX, Users, Receipt, ShieldCheck, Search, X } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, Notice, SandboxBadge } from '../components/ui';
import { api, eur, type PaymentRequest } from '../lib/api';
import { speak } from '../lib/voice';

interface Trusted { helpPages: { id: string; label: string; value: string; verifiedOn: string; note?: string }[]; emails: { value: string; label: string; verifiedOn: string }[] }
type Shot = { src: string; alt: string; cap: string };
interface Topic { id: string; title: string; summary: string; steps?: string[]; body?: ReactNode; bodyText?: string; notes?: string[]; shots?: Shot[] }

const REPO = 'https://github.com/laxmanprasadsomaraju/SaySafe';

const FAQ: { q: string; a: string }[] = [
  { q: 'Does SaySafe use real money?', a: 'No. Every payment uses the PayPal sandbox, PayPal’s test system. No real money moves and nothing is delivered.' },
  { q: 'Can SaySafe tell me a message is safe?', a: 'No. The best result is “No obvious warning signs”, which is not a guarantee. SaySafe never calls a message, link or seller safe.' },
  { q: 'Can my family member pay with my account?', a: 'No. They can approve or decline a purchase over your limit, but you always approve the payment yourself on PayPal’s page.' },
  { q: 'Can the AI buy something on its own?', a: 'No. The AI only explains and suggests. Paying, approving and refunding are separate steps that you, your family or the shop take, checked by SaySafe’s server.' },
  { q: 'Can I buy the Channel3 products inside SaySafe?', a: 'No. Channel3 results open the shop’s own website, where you buy as normal. Only the SaySafe Demo Shop takes a (sandbox) payment inside SaySafe.' },
  { q: 'Will SaySafe read my PayPal account, emails or texts?', a: 'No. It only sees what you paste, upload or say to it. It cannot see your PayPal account, inbox or messages.' },
  { q: 'What happens if I close the page while paying?', a: 'Nothing is charged twice. Open Activity, find the purchase and choose “Check with PayPal”. If PayPal shows you approved it, choose Finish.' },
  { q: 'Can SaySafe get my money back?', a: 'It cannot promise a refund or open a dispute for you. It shows the steps: contact the shop first, then PayPal’s Resolution Centre.' },
  { q: 'The first page is slow. Is it broken?', a: 'The free server sleeps when nobody is using it. The first visit can take about a minute to wake it. After that it is quick.' },
  { q: 'Is SaySafe part of PayPal?', a: 'No. SaySafe is an independent open-source hackathon project. It is not affiliated with or endorsed by PayPal.' },
];

const TOPICS: Topic[] = [
  {
    id: 'try-as-mary', title: 'Try as Mary: a five-minute walkthrough', summary: 'What the sample data is, how it is labelled, and what to try.',
    steps: [
      'Choose “Try as Mary” on the SaySafe website. You get your own private copy of Mary’s account, with sample data. Other visitors can’t see it, and it is kept in the database, so it is still there after the server restarts.',
      'The welcome card in the Assistant has six questions to tap: check a suspicious message, show my last payment, did I already pay for the microwave, show my subscriptions, find Alex, and buy a demo item.',
      'Payments: try “Did I already pay John €80?”. Two sample bank transfers to John Smith, two days apart, show a possible duplicate. “Show my payments” lists everything in Activity.',
      'Subscriptions: “Show my subscriptions”, “Which costs the most?”, “What’s coming out next?” and “Cancel my streaming subscription”. The sample subscriptions (StreamBox Plus, TuneWave Premium, The Daily Ledger, ParcelPass) are made-up companies, so instead of a cancellation link you see a “This is sample data” note. For a subscription you add yourself, SaySafe shows the company’s own cancellation steps; it can’t cancel other companies for you. The SaySafe Demo Membership is a real PayPal Sandbox subscription you can start and then cancel inside the chat.',
      'Contacts: “Find Alex”, “Show my contacts”, “Who is my gardener?”. “Send Alex €50” finds Alex, lets you check the details, then opens PayPal’s own Send money page. Nothing is sent by SaySafe.',
      'Scam training: the three “Training example” messages (a PayPal invoice with a phone number, “Hi Mum, new number”, and an ordinary order notice) show a warning, a contact mismatch, and no obvious warning signs.',
      'Family: buy something above €75 as Mary, then on the pending card choose “Try as Alex too” (the same button is in Profile › Demo & help) to approve or decline it as Alex. Come back with Profile › “Back to Mary”. Mary can’t approve her own purchase.',
      'Profile › Mary’s demo › “Reset Mary’s demo” puts the sample data back. Your real sandbox payments and anything you typed are kept. “SaySafe website” (top of every screen) goes back to the website without signing out.',
    ],
    notes: [
      'Labels: “Sample data” = illustrative, with no PayPal record — it can’t be paid, approved, refunded or checked with PayPal. “Real PayPal Sandbox transaction” = a Demo Shop payment you made here (no real money). “Recorded by you — not verified” = only what you typed.',
      'Sample contacts use fictional numbers from ranges reserved for TV drama and @example.com emails, so Call and Email are turned off for them.',
    ],
  },
  {
    id: 'flagship', title: 'The main demo: Mary, Alex, PayPal Sandbox and a checked receipt', summary: 'The whole journey in about three minutes, with test money only.',
    steps: [
      'Choose “Try as Mary”. You get a private demo household with labelled sample data and a €75 family limit.',
      'In the Assistant, type “I received a message saying I owe €120. Can you check whether I already paid?”. SaySafe looks through Mary’s own records and shows possible matches. Sample records are marked “Sample data”: they are examples, not real payments, and a matching amount is not proof.',
      'Ask “Can you help me buy a microwave instead?”. You see real products from Channel3 (bought on the shop’s own website), and separately the SaySafe Demo Shop microwave for €120 (PayPal Sandbox). Say “Let’s buy the demo microwave”, check the item, shop and price on the review card, and ask your family to check. Nothing is paid yet.',
      'Choose “Try as Alex too” on the family review card (or in Profile › Demo & help) to open Alex’s family view. Alex sees the exact item and price and chooses Approve. The answer expires and applies only to this purchase.',
      'Back as Mary, the same card now says “Approved”. Choose “Continue to PayPal” and approve on PayPal’s own sandbox page with a sandbox buyer account (judges: see the testing instructions on Devpost).',
      'SaySafe checks the order with PayPal, captures it once and shows the receipt. It says “Captured” first, then “Webhook verified” once PayPal’s signed notice arrives (usually within seconds; reload to see it).',
      'Ask “Did my payment go through?”, or open Activity: the purchase is labelled “Real PayPal Sandbox transaction”. Reloading or asking again never charges twice.',
      'Finish with Insights: Mary’s “View insights” on Home, or Alex’s “View insights” on the Family page.',
    ],
    notes: [
      'PayPal Sandbox is PayPal’s test system. No real money moves and nothing is delivered.',
      'SaySafe is an independent project. It is not affiliated with or endorsed by PayPal.',
    ],
  },
  {
    id: 'getting-started', title: 'Getting started', summary: 'Open the demo as Mary in under a minute. No sign-up.',
    steps: [
      'Go to the SaySafe home page and choose “Try as Mary”.',
      'SaySafe creates a private demo household for “Mary”, with a €75 family limit and labelled sample data. Nobody else can see it.',
      'You land on the Assistant’s welcome card. After that, use the four tabs at the bottom of the screen (at the top on a computer): Home, Assistant, Activity and Profile.',
      'Home shows your shortcuts. Assistant is where you check messages, ask questions and shop. Activity is your history. Profile holds your settings, family and help.',
      'If a page says it is waking up, wait a moment. The free server sleeps when idle.',
    ],
    notes: ['The demo session lives in this browser. Opening SaySafe in another browser starts a new demo.'],
  },
  {
    id: 'checking-messages', title: 'Checking suspicious messages', summary: 'Paste or upload a message, link, email address, phone number or screenshot.',
    steps: [
      'Open the Assistant and choose “Check a message”, or tell the Assistant “check this message”.',
      'Paste the text of the message, or a link, email address or phone number. You can also upload a screenshot.',
      'Try the sample “PayPal” invoice first to see how a result looks.',
      'Send it. SaySafe reads the words only. It never opens links, calls numbers or contacts the sender.',
      'Read the result and the safe next steps. You can ask for it to be read aloud, or share it with your family helper.',
    ],
    notes: ['On an Android phone with SaySafe installed, you may be able to share a message straight into SaySafe. This has not been tested on a real device yet.', 'Screenshots are read by an AI model and are not stored.'],
  },
  {
    id: 'scam-results', title: 'Reading scam results', summary: 'Three possible results, and what each one means.',
    body: (
      <ul className="mt-4 grid gap-3 text-lg">
        <li><b>Suspicious:</b> SaySafe found clear warning signs, such as a phone number in an invoice note, pressure to act now, or a request for a code or password. Do not pay, call or click.</li>
        <li><b>Needs checking:</b> something could not be confirmed, such as an unknown link, phone number or email address. Check it yourself through PayPal’s own website.</li>
        <li><b>No obvious warning signs:</b> nothing worrying was found in what you shared. <b>This is not a guarantee it is safe.</b></li>
      </ul>
    ),
    bodyText: 'Suspicious Needs checking No obvious warning signs not a guarantee',
    steps: [
      'Look at the result at the top.',
      'Read “Why”: each reason quotes the exact words that worried SaySafe, and says whether it came from a fixed rule or the AI.',
      'Read “What SaySafe could not verify”: SaySafe never confirms who sent a message.',
      'Follow the safe next steps. For PayPal, type paypal.com yourself or use the official links on this page.',
    ],
    notes: ['A real paypal.com link does not make a request honest. Scammers send genuine PayPal invoices with a fake phone number inside.'],
    shots: [{ src: '/screens/check-result.webp', alt: 'SaySafe result screen: Suspicious. This message may be a scam, with the reasons listed and a Read it to me again button.', cap: 'A “Suspicious” result for the sample invoice' }],
  },
  {
    id: 'real-products', title: 'Searching for real products', summary: 'Ask for what you need and compare real products from Channel3.',
    steps: [
      'Open the Assistant and say or type what you need, for example “a reliable kettle under €40”.',
      'SaySafe searches Channel3 and shows real products with pictures, prices and the shop’s name.',
      'It suggests a best match, a lower-cost option and another option. Ask “show me cheaper ones” to narrow it down.',
      'Choose “Compare” to see them side by side.',
      'To buy, choose the shop link. It opens the shop’s own website in a new tab.',
    ],
    notes: ['Ratings are shown as listed by Channel3. SaySafe does not read reviews.', 'Your shopping preferences (in Profile) only change the order of results.'],
  },
  {
    id: 'shop-difference', title: 'External shopping and the Demo Shop', summary: 'Why some products open another website and others go to PayPal.',
    body: (
      <div className="mt-4 grid sm:grid-cols-2 gap-4 text-lg">
        <div className="rounded-2xl border-2 border-line p-5"><p className="font-bold text-xl">Channel3 products</p><p className="mt-2 text-ink-soft">Real products from real shops. SaySafe helps you find and compare them. You buy on the shop’s own website. SaySafe never pays a retailer and cannot protect that purchase.</p></div>
        <div className="rounded-2xl border-2 border-teal p-5"><p className="font-bold text-xl">SaySafe Demo Shop</p><p className="mt-2 text-ink-soft">A pretend shop made for this demo, with 10 items. It is the only place where SaySafe’s family review, PayPal sandbox payment and receipt work. Test money only.</p></div>
      </div>
    ),
    bodyText: 'Channel3 real shops retailer website Demo Shop pretend sandbox test money',
  },
  {
    id: 'family-reviews', title: 'Family reviews', summary: 'A trusted helper approves or declines purchases over your limit.',
    steps: [
      'In Profile, choose “Invite a family member” (or “Get trusted help”) and create a one-time code. It works once and expires.',
      'Your helper opens the family page (“/family”) on their own phone or browser and enters the code. In the demo, you can open “Alex’s family view” in a new tab.',
      'As Mary, choose a Demo Shop item over €75, for example the €120 microwave. It shows “Waiting for family”.',
      'Alex sees the exact item, shop and price, and chooses Approve or Decline. The answer applies only to that purchase and expires after 30 minutes.',
      'If Alex approves, Mary continues to PayPal and approves the payment herself. If Alex declines, nothing can be paid.',
      'Alex sees only the requests sent to him, scam checks Mary shares, and a read-only Insights dashboard (see “Insights”). Purchases under the limit stay private unless Mary turns on a switch in Profile › Family sharing (see “What Alex can see”). Only Mary can change her limit.',
    ],
    notes: ['Alex can never pay from Mary’s account or approve the PayPal step.', 'Tested with two browser sessions. Not yet tested on two physical phones.'],
    shots: [
      { src: '/screens/family-waiting.webp', alt: 'Mary’s screen: Waiting for family, Simple Dial Microwave 20L, €120, with a Cancel this purchase button.', cap: 'Mary’s phone: waiting for family' },
      { src: '/screens/family-request.webp', alt: 'Alex’s screen: Above Mary’s limit of €75, the microwave for €120, with Approve and Decline buttons.', cap: 'Alex’s phone: Approve or Decline' },
    ],
  },
  {
    id: 'what-alex-can-see', title: 'What Alex can see', summary: 'Alex only sees purchases that need his OK. You choose if he sees more.',
    steps: [
      'Alex sees a purchase only when it is over your limit and needs his OK. He sees the item, the shop, the price, and later whether it was paid.',
      'Purchases under your limit are private. Alex does not see them.',
      'Alex never sees your conversations, contacts, subscriptions or the payment records you typed in.',
      'Only you can change your limit. Go to Profile, then “Family sharing”.',
      'Want Alex to see more? In “Family sharing”, turn on “Share spending summaries” for totals only, or “Share my purchase history” for each Demo Shop purchase. Both start off.',
      'Changed your mind? Turn it off. Alex stops seeing it straight away, and so does his Insights assistant.',
      'Scam checks are shared one at a time, only when you choose “Send to family”.',
    ],
    notes: ['SaySafe checks these rules on its server, not just on the screen.'],
  },
  {
    id: 'paypal-sandbox', title: 'PayPal sandbox payments', summary: 'How a Demo Shop purchase is paid, with test money.',
    steps: [
      'Choose a Demo Shop item and review the exact item, shop and price.',
      'Choose “Continue to PayPal”. PayPal’s own sandbox page opens.',
      'Log in with a PayPal sandbox personal (buyer) account. Your normal PayPal login will not work here. Developers can create one free at developer.paypal.com.',
      'Approve the payment on PayPal’s page. You come back to SaySafe.',
      'SaySafe checks the order with PayPal (amount, currency and item) and only then takes the payment, once.',
      'If you cancel at PayPal, you come back with nothing charged.',
    ],
    notes: ['If the page never comes back after you approve, open Activity, open the purchase and choose “Check with PayPal”, then Finish. You are never charged twice.'],
  },
  {
    id: 'history-receipts', title: 'Payment history and receipts', summary: 'Find any purchase, scam check or family decision again.',
    steps: [
      'Open Activity. It lists your payments, family decisions and scam checks, newest first.',
      'Use the search box, for example “kettle”, or the filters.',
      'Open a payment to see its receipt: amount, item, shop and PayPal’s order and transaction numbers.',
      'The timeline shows each step: created, family decision, PayPal approval, capture, and PayPal’s signed confirmation. A step is marked verified only when PayPal’s signature check passed.',
      'Choose “Read my receipt” to hear it.',
      'If something is wrong, choose “Problem with this order?”. If you need your money back, you can request a refund from the shop. A request is not a refund: the receipt says “Refunded” only when PayPal confirms it.',
    ],
    notes: ['The Activity screen is being reorganised, so labels may differ slightly.'],
    shots: [{ src: '/screens/receipt.webp', alt: 'SaySafe receipt: Paid, Easy-Pour Electric Kettle, €32.00 EUR, Receipt confirmed by PayPal, with order and transaction numbers.', cap: 'A real sandbox receipt (test money)' }],
  },
  {
    id: 'insights', title: 'Insights', summary: 'A calm summary of your payments, approvals and scam checks.',
    steps: [
      'Mary: open Home and choose “View insights”, choose “Insights” at the top of the screen on a computer, or ask the Assistant “Show my insights”. The page is at /insights.',
      'It shows payments by kind of record, purchases waiting for approval, possible repeat payments, subscriptions, what is coming out next, the messages you checked and your PayPal Sandbox outcomes.',
      'Each kind of record is kept apart: “Real PayPal Sandbox”, “Recorded by you” and “Sample data” are never added together.',
      'Alex (the family helper): open the Family page and choose “View insights”, or “Insights” at the top on a computer. The page is at /family/insights.',
      'Alex’s dashboard shows purchases waiting for a decision, decisions made, sandbox captures confirmed by PayPal, signed webhooks, shared scam checks, a 14-day chart with a table version, and a searchable ledger. Example rows are labelled and not counted in the PayPal totals.',
      'You can ask questions about the activity. Answers are read-only: Insights can explain what happened, but it can’t approve, pay or change anything.',
    ],
    notes: [
      'The public site uses SaySafe’s own native React dashboard. An optional AG Studio view exists for evaluation only and is not enabled publicly.',
      'Mary’s private scam checks are only visible to Alex if Mary shares them.',
    ],
  },
  {
    id: 'already-paid', title: 'Have I already paid?', summary: 'Check your own records before you pay someone twice.',
    steps: [
      'In the Assistant, ask “Did I already pay John €80?”, or tap “Did I already pay someone?”.',
      'SaySafe looks through payment records you typed in yourself and your SaySafe Demo Shop payments.',
      'Each record you typed is marked “Recorded by you — not verified”. It is not proof the money arrived.',
      'If a name or amount only partly matches, the card says so. If nothing is found, that does not mean you have not paid.',
      'Before paying again, check with the person or your bank statement.',
    ],
    notes: ['SaySafe cannot see your bank, your PayPal wallet or payments made outside SaySafe. Importing statements is planned, not available.', 'Records are private to you: your family member never sees them. Delete them all in Profile › Privacy & data › Delete all my companion data.'],
  },
  {
    id: 'subscriptions', title: 'Subscriptions', summary: 'Add up what you pay regularly, and get help cancelling.',
    steps: [
      'In the Assistant, ask “What do I pay every month?”, or open Profile › Privacy & data › My subscriptions.',
      'Add each subscription yourself: the company, the amount and how often. SaySafe adds up the monthly and yearly cost.',
      'To cancel one with another company, SaySafe shows that company’s official cancel page and PayPal’s automatic payments page. You cancel there yourself.',
      'When you tell SaySafe you have cancelled, it shows “You told SaySafe this is cancelled — not confirmed by the provider”.',
      'The SaySafe Demo Membership (PayPal sandbox, test money) is the only subscription SaySafe can cancel for you, and only after you tap “Cancel billing via PayPal”. Saying “yes” never cancels it. It says cancelled only when PayPal confirms.',
    ],
    notes: ['SaySafe does not send reminders before a charge. It cannot see subscriptions you have not added.', 'Totals are your own figures and are never converted between currencies.'],
  },
  {
    id: 'trusted-contacts', title: 'Trusted contacts', summary: 'Save the real numbers of the people you trust.',
    steps: [
      'Open Profile › Privacy & data › Trusted contacts, or ask the Assistant “What’s my son’s number?”.',
      'Add a name, who they are to you (for example “son”) and their phone number or email.',
      'When a message says it is from them but uses a different number, the scam check tells you, and shows the last four digits of the number you saved.',
      'Call the number you saved before you do anything the message asks.',
    ],
    notes: ['Contacts are “Saved by you — not verified”. SaySafe does not check who owns a number, and a message can fake a familiar number.', 'Your contacts are never sent to the AI service and are never shown to your family member.'],
  },
  {
    id: 'voice', title: 'Voice commands and Stop', summary: 'Tap to talk, tap again to cancel, and Stop at any time.',
    steps: [
      'Spoken replies are off until you turn them on: SaySafe never plays sound by itself on a first visit. Press “Turn on spoken replies” at the top of the Assistant or in Profile › Voice & conversation. Your choice is remembered on this device.',
      'If your browser holds sound back until you tap the page, SaySafe shows “Tap to enable sound”.',
      'Tap the microphone and allow microphone access when your browser asks. The microphone works the same whether spoken replies are on or off.',
      'Say what you need, for example “find me a microwave under 150 euro”, then stop talking. SaySafe sends it after a short pause.',
      'To cancel while it is listening, tap the microphone again. Nothing is sent.',
      'While SaySafe is speaking, tap the microphone to interrupt and speak, or press Stop. On a keyboard, Escape also stops it.',
      'If nothing is heard, it says “I didn’t hear anything. Tap to try again.”',
      'Saying “yes” never pays. You still approve at PayPal, or wait for family over your limit.',
    ],
    notes: ['You cannot talk over SaySafe without tapping (no hands-free mode).', 'Voice has been tested in Chrome on a computer with a simulated microphone. It has not been tested on real phones yet.', 'Typing always works instead.'],
    shots: [{ src: '/screens/shop-voice.webp', alt: 'SaySafe shopping screen: a large Tap to speak microphone button, a text box with I need a kettle, and the spoken reply shown as a caption.', cap: 'Every spoken reply is also shown as text' }],
  },
  {
    id: 'accessibility', title: 'Accessibility controls', summary: 'Bigger text, high contrast, captions and keyboard use.',
    steps: [
      'Use “Bigger text” and “Contrast” to make the screen easier to read. They are in Profile › Accessibility, and in the Assistant under Menu › Display.',
      'Voice settings (spoken replies on or off, read replies automatically, speed, read everything) are in Profile. Spoken replies start off.',
      'Animations switch off when your device asks for reduced motion.',
      'Everything works with a keyboard. Press Tab to move, and use “Skip to main content” at the top.',
    ],
    notes: ['Checked with automated accessibility tools (axe, WCAG 2.2 AA rules). Not yet tested with older adults or with VoiceOver, TalkBack or NVDA users.'],
  },
  {
    id: 'languages', title: 'Supported languages', summary: 'English, plus a beta reply language.',
    steps: [
      'Screens are in English.',
      'In Profile, you can choose a reply language (beta): English, Español, Polski, Français, Deutsch or Português.',
      'This changes what SaySafe says and listens for. Prices stay in euro and product search stays in English.',
    ],
    notes: ['Only English has been verified. Irish, Hindi and Arabic are not offered yet.'],
  },
  {
    id: 'privacy', title: 'Privacy and data', summary: 'What SaySafe keeps, and what it never sees.',
    steps: [
      'SaySafe stores your demo household, family links, spending limit, sharing choices, purchases, family decisions, PayPal confirmations and shared scam checks, so they survive a restart.',
      'Your family helper sees only purchases that need their OK, unless you share more (see “What Alex can see”).',
      'For a scam check it keeps the result and headline. Uploaded screenshots are not stored.',
      'Shopping preferences are saved for your demo account; edit or clear them in Profile. Voice settings stay on this device.',
      'What SaySafe remembers comes in two separate parts. You will find both in Profile › What SaySafe remembers.',
      'Your preferences (long-term memory). This is on unless you turn it off. It keeps only shopping preferences you clearly tell SaySafe, like “I prefer black” or “keep my budget under €150”. You can see, change or remove each one, clear them all, or turn memory off. Your family can’t see them. The demo starts with two labelled “Sample” preferences that you can remove.',
      'Recent conversation (short-term). SaySafe keeps your last 10 messages and the last 20 products it showed you, for 14 days, only so “that one” or “the cheaper one” makes sense later. This is kept even when memory is off. Delete it with “Clear conversation”. It is never proof of a payment.',
      'When memory is off: nothing new is saved, saved preferences are not used for search results, and only the recent conversation above is kept.',
      'Earlier messages are not shown again when you open a new tab or come back later. SaySafe still understands “that one” from the recent conversation, but it does not display the old messages.',
      'Messages, screenshots and voice clips you send are processed by Groq’s AI service. Product searches go to Channel3. Payments go to PayPal’s sandbox.',
      'SaySafe never sees your PayPal password, bank, inbox or text messages.',
    ],
    notes: ['This is a demo. Please do not paste real card numbers, passwords or one-time codes.'],
  },
  {
    id: 'faq', title: 'Frequently asked questions', summary: 'Short answers to common questions.',
    body: (
      <dl className="mt-4 grid gap-5 text-lg">
        {FAQ.map((f) => <div key={f.q}><dt className="font-bold text-navy">{f.q}</dt><dd className="mt-1 text-ink-soft">{f.a}</dd></div>)}
      </dl>
    ),
    bodyText: FAQ.map((f) => `${f.q} ${f.a}`).join(' '),
  },
  {
    id: 'limitations', title: 'Security & limitations', summary: 'Sandbox only, what the AI can never do, and what is not tested yet.',
    body: (
      <ul className="mt-4 grid gap-3 text-lg list-disc pl-6">
        <li>PayPal Sandbox only: every payment uses fake test money. No real money moves and nothing is delivered.</li>
        <li>No real PayPal accounts: only PayPal Sandbox test accounts work. Never enter your real PayPal login.</li>
        <li>The AI never pays and never approves. It only suggests; you approve at PayPal yourself, and your family member approves purchases over your limit.</li>
        <li>Only English is verified. Other reply languages are beta and unverified.</li>
        <li>Voice is tap-to-talk and tested only in Chromium (Chrome) with a simulated microphone. Real phones and other browsers are not tested. Spoken replies are off until you turn them on.</li>
        <li>Scam detection is not independently verified. It makes mistakes: on 42 unseen test messages, 2 false alarms and 1 missed scam. Nothing about the sender is verified, and links are never opened.</li>
        <li>Sample subscriptions and records use made-up company names and are labelled “Sample”. They are not real accounts.</li>
        <li>The hosted demo runs on free hosting: after a quiet spell the first visit can take about 60 seconds to wake up.</li>
        <li>Judges’ PayPal Sandbox buyer login is shared only through Devpost, never in the app.</li>
        <li>SaySafe cannot stop payments made outside SaySafe, read your PayPal account, open disputes or promise refunds.</li>
        <li>Channel3 purchases happen on other websites and are not covered by SaySafe’s checks.</li>
        <li>Shop refunds are switched off on the hosted demo; you can request one, but it will not be completed there.</li>
        <li>Not yet tested with older adults; only scripted walkthroughs. Android sharing is untested on a device.</li>
      </ul>
    ),
    bodyText: 'security sandbox fake money test accounts real paypal AI never pays approves english only voice chromium spoken replies scam detection not independently verified false alarms missed scam sample cold start 60 seconds free hosting judges login devpost refunds languages not tested Android',
  },
];

const haystack = (t: Topic) => [t.title, t.summary, ...(t.steps ?? []), ...(t.notes ?? []), t.bodyText ?? ''].join(' ').toLowerCase();

export default function Help() {
  const nav = useNavigate();
  const loc = useLocation() as { hash: string; state?: { problem?: boolean; requestId?: string } };
  const [who, setWho] = useState<'elder' | 'family' | 'public' | null>(null);
  const [trusted, setTrusted] = useState<Trusted | null>(null);
  const [orders, setOrders] = useState<PaymentRequest[]>([]);
  const [selected, setSelected] = useState<PaymentRequest | null>(null);
  const [invite, setInvite] = useState<{ code: string; expiresInMinutes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    api<Trusted>('/api/trusted').then(setTrusted).catch(() => {});
    api<{ elder?: unknown; family?: unknown }>('/api/me').then((r) => setWho(r.elder ? 'elder' : r.family ? 'family' : 'public')).catch(() => setWho('public'));
  }, []);

  useEffect(() => {
    if (who !== 'elder') return;
    api<PaymentRequest[]>('/api/payments').then((o) => {
      const paid = o.filter((x) => x.state === 'CAPTURED' || x.state === 'REFUNDED');
      setOrders(paid);
      if (loc.state?.problem) {
        const pick = paid.find((x) => x.id === loc.state?.requestId) ?? paid[0] ?? null;
        setSelected(pick);
        if (pick) speak(`Sorry your ${pick.items[0].name} hasn't arrived. Start by contacting the shop; the steps are on screen.`);
      }
    }).catch(() => {});
  }, [who]); // eslint-disable-line

  // Anchored links (/help#voice): scroll once the page has rendered (Layout resets scroll on route change).
  useEffect(() => {
    if (!who || !loc.hash) return;
    const el = document.getElementById(decodeURIComponent(loc.hash.slice(1)));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }, [who, loc.hash]);

  const makeInvite = async () => { setErr(null); try { setInvite(await api('/api/family/invite', { body: {} })); } catch (e: any) { setErr(e.message); } };
  const page = (id: string) => trusted?.helpPages.find((p) => p.id === id);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (needle ? TOPICS.filter((t) => needle.split(/\s+/).every((w) => haystack(t).includes(w))) : TOPICS), [needle]);

  return (
    <Layout mode={who === 'elder' ? 'elder' : who === 'family' ? 'family' : 'public'}>
      <div className={who === 'elder' || who === 'family' ? '' : 'wrap py-10 md:py-14'}>
        <header className="max-w-3xl">
          <SandboxBadge />
          <h1 className="mt-5 display-2">SaySafe Help centre</h1>
          <p className="mt-4 text-xl text-ink-soft leading-relaxed">Step-by-step help for checking messages, shopping, family reviews and PayPal sandbox payments. No real money moves in this demo.</p>
          <p className="mt-4 text-lg"><Link to="/learn" className="link" data-testid="help-learn-link">Learn SaySafe: 14 illustrated step-by-step guides</Link> · <Link to="/judges" className="link">Judges’ Guide</Link></p>
        </header>

        {who === 'elder' && selected && (
          <Card className="mt-8 p-5 sm:p-8 border-2 border-amber">
            <h2 className="text-2xl flex items-center gap-2"><PackageX className="size-7 shrink-0 text-amber" aria-hidden />Problem with your order</h2>
            <p className="mt-2 text-lg break-words">{selected.items.map((i) => i.name).join(', ')} · {eur(selected.amountCents)} · paid to {selected.receipt?.payee}</p>
            <ol className="mt-5 space-y-4">
              <li className="flex gap-4"><span className="size-9 rounded-full bg-teal text-white grid place-items-center font-bold shrink-0">1</span><div className="min-w-0"><p className="font-bold">Look at your receipt</p><Button variant="ghost" className="!px-0" icon={<Receipt className="size-5" aria-hidden />} onClick={() => nav(`/order/${selected.id}`)}>Open receipt</Button></div></li>
              <li className="flex gap-4"><span className="size-9 rounded-full bg-teal text-white grid place-items-center font-bold shrink-0">2</span><div className="min-w-0"><p className="font-bold">Contact the shop first</p><p className="text-ink-soft text-lg">Most delivery problems are fixed by the seller. This is a demo shop, so no real parcel was sent.</p></div></li>
              <li className="flex gap-4"><span className="size-9 rounded-full bg-teal text-white grid place-items-center font-bold shrink-0">3</span><div className="min-w-0"><p className="font-bold">If it's not sorted, open a case with PayPal</p><p className="text-ink-soft text-lg">You do this yourself inside PayPal's Resolution Centre. SaySafe does not open cases for you and cannot promise a refund.</p>
                {page('help-resolution') && <a href={page('help-resolution')!.value} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-2 font-bold text-teal underline underline-offset-4 min-h-12">{page('help-resolution')!.label}<ExternalLink className="size-5" aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a>}
              </div></li>
              <li className="flex gap-4"><span className="size-9 rounded-full bg-teal text-white grid place-items-center font-bold shrink-0">4</span><div className="min-w-0"><p className="font-bold">Ask your family to help</p><p className="text-ink-soft text-lg">They can see this purchase in their SaySafe view.</p></div></li>
            </ol>
          </Card>
        )}

        {/* Trusted help: official links for everyone; Mary's own family code when signed in. */}
        <section aria-labelledby="trusted-h" className="mt-10 grid md:grid-cols-2 gap-5">
          <h2 id="trusted-h" className="sr-only">Trusted help</h2>
          <Card className="p-5 sm:p-6 min-w-0">
            <h3 className="text-2xl flex items-center gap-2"><ShieldCheck className="size-7 shrink-0 text-teal" aria-hidden />Official PayPal help</h3>
            <p className="mt-2 text-lg text-ink-soft">These go to PayPal’s own website. If you are ever unsure, type paypal.com yourself. Never call a number from a message.</p>
            <ul className="mt-4 space-y-3">
              {trusted?.helpPages.map((p) => (
                <li key={p.id}>
                  <a href={p.value} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3 rounded-2xl border-2 border-line hover:border-teal px-4 sm:px-5 py-3 min-h-16 font-bold break-words">{p.label}<ExternalLink className="size-5 shrink-0" aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a>
                  <p className="text-sm text-ink-soft mt-1 px-1 break-words">Checked on {p.verifiedOn} · {new URL(p.value).hostname}</p>
                </li>
              ))}
            </ul>
          </Card>
          <div className="space-y-5 min-w-0">
            <Card className="p-5 sm:p-6">
              <h3 className="text-2xl flex items-center gap-2"><Mail className="size-7 shrink-0 text-teal" aria-hidden />Report a fake message</h3>
              <p className="mt-2 text-lg break-words">Forward the whole message to <span className="font-bold">{trusted?.emails[0]?.value ?? 'phishing@paypal.com'}</span>, then delete it.</p>
              <p className="mt-1 text-base text-ink-soft">This address is for reporting only. PayPal will never ask you to pay or share a code by email.</p>
            </Card>
            {who === 'elder' && (
              <Card className="p-5 sm:p-6">
                <h3 className="text-2xl flex items-center gap-2"><Users className="size-7 shrink-0 text-teal" aria-hidden />Your trusted family member</h3>
                <p className="mt-2 text-lg">Give them this one-time code so they can join your SaySafe. They can review bigger purchases and see alerts you share. They can never pay from your account.</p>
                {invite ? (
                  <div className="mt-4 rounded-2xl bg-teal-soft p-5 text-center">
                    <p className="text-ink-soft">Your code</p>
                    <p className="font-display text-4xl sm:text-5xl tracking-[0.2em] font-semibold mt-1 break-all" aria-label={invite.code.split('').join(' ')}>{invite.code}</p>
                    <p className="text-base text-ink-soft mt-2 break-words">Works once, for {invite.expiresInMinutes} minutes. They enter it at <span className="font-bold">{location.host}/family</span></p>
                    <a href={`/family/pair?code=${invite.code}`} target="_blank" rel="noopener" className="mt-3 inline-block font-bold text-teal underline underline-offset-4">Demo: open Alex's family view in a new tab</a>
                  </div>
                ) : <Button className="mt-4" variant="secondary" onClick={makeInvite}>Create a family code</Button>}
                {err && <div className="mt-3"><Notice tone="danger" title={err} /></div>}
              </Card>
            )}
            {who === 'elder' && !selected && orders.length > 0 && <Button variant="secondary" className="w-full" icon={<PackageX className="size-6" aria-hidden />} onClick={() => setSelected(orders[0])}>My order hasn't arrived</Button>}
          </div>
        </section>

        {/* Search + contents */}
        <section aria-labelledby="topics-h" className="mt-12">
          <h2 id="topics-h" className="display-3">Help topics</h2>
          <form role="search" className="mt-5 max-w-xl" onSubmit={(e) => e.preventDefault()}>
            <label htmlFor="help-q" className="block font-bold text-lg">Search help</label>
            <div className="mt-2 flex gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="size-5 absolute left-4 top-1/2 -translate-y-1/2 text-ink-soft" aria-hidden />
                <input id="help-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="For example: refund, voice, family" className="w-full min-h-14 rounded-full border-2 border-line bg-paper pl-11 pr-4 text-lg focus:border-teal outline-none" aria-describedby="help-count" />
              </div>
              {q && <button type="button" onClick={() => setQ('')} className="inline-flex items-center gap-1 min-h-14 px-4 rounded-full font-bold text-teal hover:bg-teal-soft"><X className="size-5" aria-hidden />Clear</button>}
            </div>
            <p id="help-count" aria-live="polite" className="mt-2 text-base text-ink-soft">{needle ? (shown.length ? `${shown.length} topic${shown.length === 1 ? '' : 's'} found` : 'No topics found. Try another word, or browse the list below.') : `${TOPICS.length} topics`}</p>
          </form>
          <nav aria-label="Help topics" className="mt-6">
            <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {(needle && shown.length ? shown : TOPICS).map((t) => (
                <li key={t.id}><a href={`#${t.id}`} className="flex items-center gap-3 min-h-12 rounded-2xl px-3 py-2 font-bold text-teal hover:bg-teal-soft underline-offset-4 hover:underline"><span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-navy text-white text-sm">{TOPICS.indexOf(t) + 1}</span><span className="min-w-0 break-words">{t.title}</span></a></li>
              ))}
            </ul>
          </nav>
        </section>

        <div className="mt-10 space-y-6">
          {(needle && shown.length ? shown : needle ? [] : TOPICS).map((t) => <TopicCard key={t.id} t={t} n={TOPICS.indexOf(t) + 1} />)}
        </div>

        <footer className="mt-12 border-t border-line pt-6 flex flex-wrap gap-x-6 gap-y-3 text-lg font-bold">
          <Link to={who === 'elder' ? '/home' : who === 'family' ? '/family' : '/'} className="text-teal underline underline-offset-4 min-h-12 inline-flex items-center">{who === 'public' || !who ? 'Back to the start' : 'Back to Home'}</Link>
          <a href={REPO} className="text-teal underline underline-offset-4 min-h-12 inline-flex items-center" target="_blank" rel="noreferrer">Source code and setup (GitHub)<span className="sr-only"> (opens in a new tab)</span></a>
          <a href={`${REPO}/blob/main/docs/PRODUCT-OVERVIEW.md`} className="text-teal underline underline-offset-4 min-h-12 inline-flex items-center" target="_blank" rel="noreferrer">What’s built, and its status<span className="sr-only"> (opens in a new tab)</span></a>
        </footer>
      </div>
    </Layout>
  );
}

function TopicCard({ t, n }: { t: Topic; n: number }) {
  return (
    <article id={t.id} aria-labelledby={`${t.id}-h`} className="scroll-mt-24 bg-paper rounded-[var(--radius-card)] border border-line p-5 sm:p-8 min-w-0">
      <h3 id={`${t.id}-h`} className="text-[1.75rem] leading-tight flex gap-3"><span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-navy text-white font-bold text-lg">{n}</span><span className="min-w-0 break-words">{t.title}</span></h3>
      <p className="mt-3 text-lg text-ink-soft">{t.summary}</p>
      <div className={t.shots?.length ? 'mt-2 grid lg:grid-cols-[minmax(0,1fr)_auto] gap-8 items-start' : ''}>
        <div className="min-w-0">
          {t.body}
          {t.steps && (
            <ol className="mt-5 grid gap-3">
              {t.steps.map((s, i) => <li key={s} className="flex gap-3 text-lg leading-relaxed"><span aria-hidden className="font-display text-2xl leading-none text-teal w-6 shrink-0 text-right">{i + 1}</span><span className="min-w-0 break-words">{s}</span></li>)}
            </ol>
          )}
          {t.notes && (
            <div className="mt-5 rounded-2xl bg-amber-soft px-5 py-4">
              <p className="font-bold text-amber">Good to know</p>
              <ul className="mt-1 grid gap-1 text-base text-navy list-disc pl-5">{t.notes.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
        </div>
        {t.shots && (
          <div className="flex flex-wrap gap-5 justify-center">
            {t.shots.map((s) => (
              <figure key={s.src} className="w-[15rem] max-w-full">
                <div className="rounded-[1.75rem] bg-navy p-1.5"><img src={s.src} alt={s.alt} width={390} height={844} loading="lazy" decoding="async" className="block w-full rounded-[1.4rem] bg-paper" /></div>
                <figcaption className="mt-2 text-center text-base font-bold text-ink-soft">{s.cap}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
