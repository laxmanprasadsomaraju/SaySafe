/**
 * Learn SaySafe: the content of every guide, the Judges' Guide and the hub sections, in one typed file so the pages,
 * the search and the docs tests (tests/learn-docs.test.ts, scripts/docs-walkthrough.mjs) read the same source.
 *
 * Writing rules (checked by tests/learn-docs.test.ts): plain English, numbered steps, no credentials, never "safe" as a
 * verdict, never claims of wallet access, personal transfers, PayPal endorsement or untested browsers/languages.
 * Screenshots are referenced by id ("g05/03-back-from-paypal"); scripts/shots-docs.mjs produces them and
 * web/public/docs-assets/manifest.json says where each came from (local test build or hosted).
 */

export interface ShotRef { id: string; alt: string; cap: string }
export interface Step { t: string; prompt?: string; shots?: ShotRef[]; optional?: boolean; label?: string }
export interface Guide {
  n: number; slug: string; title: string; summary: string; minutes: number;
  /** Hub sections this guide belongs to. */
  sections: SectionId[];
  intro?: string; steps: Step[]; notes?: string[]; related?: string[];
}
export type SectionId = 'getting-started' | 'how-it-works' | 'guides' | 'use-cases' | 'family' | 'paypal' | 'voice' | 'payment-memory' | 'subscriptions' | 'scam' | 'shopping' | 'insights' | 'privacy' | 'faq' | 'troubleshooting';

/** The value proposition, word for word (README, Learn, Features, Judges, video). */
export const VALUE_PROP = 'SaySafe helps people understand payment requests, avoid accidental repeat payments, get trusted assistance and verify payments.';
/** Official Devpost deadline. */
export const DEADLINE = 'Thu 12 Nov 2026, 12:00 PM PST (20:00 GMT)';
export const REPO = 'https://github.com/laxmanprasadsomaraju/SaySafe';
export const APP_URL = 'https://saysafe.onrender.com';

export const GUIDES: Guide[] = [
  {
    n: 1, slug: 'getting-started', title: 'Getting started as Mary', minutes: 2, sections: ['getting-started'],
    summary: 'Open the demo as Mary in under a minute. No sign-up, labelled sample data, test money only.',
    intro: 'Mary is the person SaySafe is built for: someone who wants a second look before paying. In the demo you play Mary, with your own private copy of her account.',
    steps: [
      { t: 'Open the SaySafe website and choose “Try as Mary”. If the page says it is waking up, wait up to a minute: the free server sleeps when nobody is using it.', shots: [{ id: 'g01/01-landing', alt: 'SaySafe landing page with the headline “Ask first. Pay with confidence.” and a Try as Mary button outlined.', cap: 'The landing page. “Try as Mary” starts the demo.' }] },
      { t: 'SaySafe creates a private demo household for Mary, with a €75 family limit and sample data. Nobody else can see it. You land on the Assistant’s welcome card, which lists things to try.', shots: [{ id: 'g01/02-welcome', alt: 'The SaySafe Assistant welcome card with six suggested questions such as “Check this suspicious message” and “Show my subscriptions”.', cap: 'The welcome card: tap any question to try it.' }] },
      { t: 'Use the four tabs: Home, Assistant, Activity and Profile. They are at the bottom of the screen on a phone and at the top on a computer (where Insights is a fifth tab).', shots: [{ id: 'g01/03-home', alt: 'Mary’s Home screen with four shortcut tiles: Check a message, Find a product, Get trusted help and My payments.', cap: 'Home: four shortcuts, what is waiting, and recent activity.' }] },
      { t: 'Look for the labels. “Sample data” means an illustrative example with no PayPal record: it can’t be paid, approved, refunded or checked with PayPal. “Real PayPal Sandbox transaction” means a Demo Shop payment you made here with test money. “Recorded by you — not verified” means only what you typed.' },
      { t: 'To start again, open Profile › Demo & help and choose “Reset Mary’s demo”. Sample data goes back as it was; your real sandbox payments are kept.', shots: [{ id: 'g01/04-demo-help', alt: 'Profile, Demo and help section with the Reset Mary’s demo button outlined.', cap: 'Profile › Demo & help: reset, Try as Alex and the guides.' }] },
    ],
    notes: ['The demo lives in this browser. Another browser starts a new demo.', 'Everything uses the PayPal Sandbox, PayPal’s test system. No real money moves and nothing is delivered.'],
    related: ['check-a-suspicious-message', 'have-i-already-paid'],
  },
  {
    n: 2, slug: 'check-a-suspicious-message', title: 'Checking a suspicious message', minutes: 3, sections: ['scam'],
    summary: 'Paste a message, link, email address, phone number or screenshot. SaySafe explains the warning signs it found.',
    intro: 'Three training examples are built in, so you can see each kind of result without pasting anything real. SaySafe reads the words only: it never opens links, calls numbers or contacts the sender.',
    steps: [
      { t: 'In the Assistant, tap “Check this suspicious message” on the welcome card, or choose “Check a message” on Home.', shots: [{ id: 'g02/01-training-examples', alt: 'A card with three training examples, each with a “Check this training example” button.', cap: 'Three fictional training examples, ready to check.' }] },
      { t: 'Check the first example: a PayPal-style invoice that asks you to phone a “billing department” to cancel. SaySafe marks it Suspicious and quotes the exact words that worried it: a phone number it cannot verify, and pressure to act within 24 hours.', shots: [{ id: 'g02/02-fake-invoice', alt: 'Scam check result: Suspicious. This message may be a scam. Reasons: a phone number we cannot verify; it pressures you to act fast.', cap: 'A fake invoice with a fraudulent support number: Suspicious.' }] },
      { t: 'Check the second example: “Hi Mum, it’s Sarah… this is my new number”. SaySafe compares it with the number saved for Sarah in Mary’s trusted contacts, says it doesn’t match, and tells Mary to call the number she saved.', shots: [{ id: 'g02/03-hi-mum', alt: 'Scam check result warning that the number in the message is not the one saved for Sarah, with advice to call Sarah’s saved number.', cap: '“Hi Mum, new number”: a contact mismatch.' }] },
      { t: 'Check the third example: an ordinary order notice with no link, no number to call and no request for money. The result is “No obvious warning signs”. That is not proof the message is genuine: SaySafe never calls a message, link or seller safe.', shots: [{ id: 'g02/04-order-notice', alt: 'Scam check result: No obvious warning signs, with a reminder that this is not a guarantee.', cap: 'A genuine-looking notice: no obvious warning signs, still not proof.' }] },
      { t: 'To check your own message, paste it into the Assistant (or tap + to add a screenshot) and send it. Follow the safe next steps: for PayPal, type paypal.com yourself rather than using a link or number from the message.', prompt: 'PayPal: your account is on hold. You owe €120 for a microwave order. Call 01 555 0199 to cancel.' },
    ],
    notes: ['Results: Suspicious (clear warning signs), Needs checking (something couldn’t be confirmed), No obvious warning signs (not a guarantee).', 'A real paypal.com link does not make a request honest: scammers send genuine PayPal invoices with a fake phone number inside.', 'Scam checks make mistakes. On 42 unseen test messages there were 2 false alarms and 1 missed scam.', 'Screenshots are read in memory and not stored. Please don’t paste real card numbers, passwords or one-time codes.'],
    related: ['trusted-contacts-and-send-money', 'have-i-already-paid'],
  },
  {
    n: 3, slug: 'have-i-already-paid', title: 'Someone says I owe €120. Have I already paid?', minutes: 2, sections: ['payment-memory'],
    summary: 'Check Mary’s own records before paying someone twice, including the John Smith €80 possible duplicate.',
    intro: 'Scammers often ask for money you have already paid. SaySafe looks through the records Mary keeps in SaySafe and her Demo Shop payments, and shows possible matches. It never says “you already paid”: a matching amount is not proof.',
    steps: [
      { t: 'In the Assistant, type the question below.', prompt: 'I received a message saying I owe €120. Can you check whether I already paid?' },
      { t: 'SaySafe shows possible matches with the recipient, amount, date, note and where the record came from. Here the match is a €120 boiler service Mary recorded, marked “Sample data”. The card says plainly that a matching amount is not proof.', shots: [{ id: 'g03/01-owe-120', alt: 'Possible matches card for €120: Shannon Boiler Services, Annual boiler service, labelled Sample data.', cap: 'Possible matches, each labelled with where it came from.' }] },
      { t: 'Now try a possible duplicate. Mary recorded two €80 bank transfers to John Smith, two days apart.', prompt: 'Did I already pay John €80?' },
      { t: 'SaySafe flags a possible duplicate and suggests checking with John or the bank statement before paying again.', shots: [{ id: 'g03/02-john-duplicate', alt: 'Payment matches card showing two €80 payments to John Smith with a possible duplicate warning.', cap: 'Two €80 payments to John Smith: a possible duplicate.' }] },
      { t: 'If nothing is found, that does not mean you have not paid. SaySafe cannot see your bank, your PayPal wallet or payments made outside SaySafe.' },
    ],
    notes: ['Records you type are marked “Recorded by you — not verified”.', 'These records are private to Mary: her family helper never sees them. Delete them in Profile › Privacy & data.'],
    related: ['activity-search', 'check-a-suspicious-message'],
  },
  {
    n: 4, slug: 'find-real-products', title: 'Finding real products (Channel3)', minutes: 2, sections: ['shopping'],
    summary: 'Ask for what you need and compare real products from real shops. You buy those on the shop’s own website.',
    intro: 'SaySafe searches Channel3 for real products with prices and pictures. This is discovery only: buying a real product happens on the retailer’s own site, where SaySafe can’t protect the payment. That is different from the SaySafe Demo Shop, the one pretend shop where SaySafe’s family review, PayPal Sandbox payment and receipt work.',
    steps: [
      { t: 'In the Assistant, ask for a product in your own words.', prompt: 'Can you help me buy a microwave instead?' },
      { t: 'SaySafe shows real listings found with Channel3: name, price, shop and a short spec line. The card says “You buy on the shop’s own website” and when the prices were found.', shots: [{ id: 'g04/01-listings', alt: 'Shop listings card with three real microwaves, their shops and prices, and Show more and Compare buttons.', cap: 'Real listings from Channel3. Prices can change.' }] },
      { t: 'Tap a listing for details. “View on retailer site” opens the shop’s own page in a new tab. There is no PayPal button here, because SaySafe never pays a retailer.', shots: [{ id: 'g04/02-listing-detail', alt: 'Listing details sheet with a View on retailer site link outlined and no payment button.', cap: 'Details open the shop’s site. No payment in SaySafe.' }] },
      { t: 'Tap “Compare” to see the listings side by side, or ask “show me cheaper ones”.', optional: true, shots: [{ id: 'g04/03-compare', alt: 'Compare card listing price, shop and key specs of the microwaves side by side.', cap: 'Compare, side by side.' }] },
      { t: 'After the real listings, SaySafe offers the separate SaySafe Demo Shop item, paid with PayPal Sandbox. Say “Let’s buy the demo microwave” to try the protected purchase (guide 5).', shots: [{ id: 'g04/04-demo-shop-offer', alt: 'Demo Shop options list with the Simple Dial Microwave 20L for €120, PayPal Sandbox.', cap: 'The Demo Shop offer is shown separately.' }] },
      { t: 'If the Demo Shop has nothing like what you asked for, SaySafe says so plainly and offers “Search real shops”, which looks for it with Channel3.' },
    ],
    notes: ['Ratings and specs are shown as Channel3 lists them. SaySafe does not read reviews or check the shops.', 'Your shopping preferences in Profile only change the order of results.'],
    related: ['paypal-sandbox-purchase'],
  },
  {
    n: 5, slug: 'paypal-sandbox-purchase', title: 'A PayPal Sandbox demo purchase', minutes: 3, sections: ['paypal'],
    summary: 'Buy a Demo Shop item with test money: review, approve on PayPal’s own sandbox page, and get a receipt checked with PayPal.',
    intro: 'Only SaySafe Demo Shop items can be paid inside SaySafe, and only with the PayPal Sandbox (test money). The price comes from SaySafe’s server, not from the AI.',
    steps: [
      { t: 'In the Assistant, ask for the Demo Shop item.', prompt: 'Let’s buy the demo microwave.' },
      { t: 'Check the purchase card: Simple Dial Microwave 20L, SaySafe Demo Shop, €120.00 EUR, “PayPal Sandbox · no real money”. Because it is above Mary’s €75 limit, the button asks her family first. Nothing is paid yet.', shots: [{ id: 'g05/01-purchase-card', alt: 'Purchase card: Simple Dial Microwave 20L, €120.00 EUR, above your €75.00 limit, with an Allow button outlined.', cap: 'The exact item, shop and server price.' }] },
      { t: 'Under €75 you go straight to PayPal. Over €75, the family review comes first (guide 6). When the card says “Approved”, choose “Continue to PayPal”.', shots: [{ id: 'g05/02-continue-to-paypal', alt: 'Family review card saying Approved with a Continue to PayPal button outlined.', cap: 'After family approval: Continue to PayPal.' }] },
      { t: 'PayPal’s own sandbox page opens. Log in with a PayPal Sandbox buyer (personal) account and approve. Your normal PayPal login does not work there. Judges: the sandbox buyer login is in the Devpost testing instructions only; it is never shown on this site or in the code.', label: 'On PayPal’s page' },
      { t: 'You come back to SaySafe. It checks the order with PayPal (amount, currency and item), captures the payment once, and shows the receipt.', shots: [{ id: 'g05/03-back-from-paypal', alt: 'Receipt screen after returning from PayPal: €120.00, Captured, with the item and shop.', cap: 'Back from PayPal: the receipt.' }] },
      { t: 'If you cancel on PayPal’s page, you come back with nothing charged.' },
    ],
    notes: ['SaySafe never sees your PayPal password.', 'Family approval is not the same as PayPal approval. Alex’s “yes” only lets Mary continue; Mary still approves the payment herself at PayPal.', 'SaySafe is an independent project, not affiliated with or endorsed by PayPal.'],
    related: ['family-approval', 'verified-receipt'],
  },
  {
    n: 6, slug: 'family-approval', title: 'Family approval: Mary and Alex', minutes: 3, sections: ['family'],
    summary: 'Purchases over €75 wait for Alex, Mary’s trusted family helper, to approve or decline that exact item and price.',
    intro: 'Alex sees and answers only the purchase requests Mary’s limit sends to him. He can never pay from Mary’s account, approve the PayPal step or change her limit. In the demo you switch between Mary and Alex in the same browser.',
    steps: [
      { t: 'As Mary, start a Demo Shop purchase over €75 (guide 5) and choose to ask your family. The card says “Family review: Pending” and offers “Try as Alex too”.', shots: [{ id: 'g06/01-mary-waiting', alt: 'Mary’s family review card: Pending, with a Try as Alex too button outlined.', cap: 'Mary’s view: waiting for family.' }] },
      { t: 'On the pending card, choose “Try as Alex too” (the same button is in Profile › Demo & help). If SaySafe asks before leaving the page, choose “Leave, keep it saved”: leaving never cancels the purchase.' },
      { t: 'Alex sees the exact item, shop, amount and currency, who is asking and when the request expires. He chooses Approve or Decline.', shots: [{ id: 'g06/02-alex-review', alt: 'Alex’s family review card: Mary asks you to check, Simple Dial Microwave 20L, €120.00 EUR, expiry time, Approve and Decline buttons.', cap: 'Alex’s view: the exact purchase, Approve or Decline.' }] },
      { t: 'The answer applies only to this purchase and expires after 30 minutes. Approving twice changes nothing.', shots: [{ id: 'g06/03-alex-approved', alt: 'Alex’s card now shows Approved.', cap: 'Approved, for this purchase only.' }] },
      { t: 'Alex’s Home shows the requests waiting for him and the ones he has answered. Only Mary can change her limit.', optional: true, shots: [{ id: 'g06/04-alex-family-home', alt: 'Alex’s family Home on a computer: Helping Mary stay safe, requests waiting for him, recent activity and a What you can see card.', cap: 'Alex’s family Home.' }] },
      { t: 'Go back to Mary with Profile › “Back to Mary (if you’re trying the demo)”, then open the Assistant.', shots: [{ id: 'g06/05-back-to-mary', alt: 'Alex’s Profile with the Back to Mary link outlined.', cap: 'Switch back to Mary.' }] },
      { t: 'Mary’s same card now says “Approved” with “Continue to PayPal”. She still approves the payment herself at PayPal.', shots: [{ id: 'g06/06-mary-approved', alt: 'Mary’s card now says Approved with a Continue to PayPal button.', cap: 'Mary’s card refreshed: Approved.' }] },
    ],
    notes: ['Family approval is SaySafe’s own check. PayPal buyer approval is Mary logging in to PayPal and approving. Both are needed over the limit; neither replaces the other.', 'Mary can’t approve her own request. If Alex declines, nothing can be paid.', 'What Alex sees: only the purchases sent to him for a check: the item, the shop, the amount, and whether it was paid in the end. Everything under Mary’s limit stays private. Mary can choose to share more with two separate switches in Profile › Family sharing, both off to start with and easy to turn off again: “Share spending summaries with Alex” (totals only) and “Share my purchase history with Alex”. Alex never sees Mary’s conversations, other payments, contacts or subscriptions. SaySafe’s server enforces this.', 'In real use Alex joins with a one-time code from Mary (Profile › Trusted family). Tested with two browser sessions, not two physical phones.'],
    related: ['paypal-sandbox-purchase', 'insights'],
  },
  {
    n: 7, slug: 'verified-receipt', title: 'A verified receipt: “Did my payment go through?”', minutes: 2, sections: ['paypal', 'payment-memory'],
    summary: 'Ask in plain words and get the receipt card. Learn what Captured, Verification pending and Webhook verified mean.',
    intro: 'SaySafe only says “paid” once PayPal confirms the capture. A second, independent confirmation arrives as PayPal’s signed notice (a webhook), which SaySafe verifies with PayPal.',
    steps: [
      { t: 'After a Demo Shop payment, ask the Assistant:', prompt: 'Did my payment go through?' },
      { t: 'The receipt card shows the item, €120.00, PayPal Sandbox, the status, a capture reference, the family approval and the webhook status, with “View in Activity”. Asking again shows the same receipt: it never pays twice.', shots: [{ id: 'g07/01-receipt-card', alt: 'Receipt card in the Assistant: Simple Dial Microwave 20L, €120.00, Captured, Family approved, webhook status, View in Activity.', cap: 'The receipt card in the Assistant.' }] },
      { t: 'Open the full receipt for every detail: shop, amount, your approval at PayPal, the capture checked with PayPal, the webhook status and the PayPal order reference.', shots: [{ id: 'g07/02-receipt-page', alt: 'Full receipt page: €120.00, Captured, Verification pending, shop, amount, mode PayPal Sandbox, family approval and capture rows.', cap: 'The full receipt.' }] },
      { t: 'Read the timeline: order created, family decision, buyer approved at PayPal, payment captured, capture checked with PayPal, and the signed PayPal notice. Each step says where it came from and what was verified.', shots: [{ id: 'g07/03-timeline', alt: 'Payment evidence timeline listing each step with its source and what was verified.', cap: 'The evidence timeline.' }] },
      { t: '“Captured” comes first, from PayPal’s capture response, checked again with PayPal’s Payments API. “Verification pending” means PayPal’s signed notice hasn’t arrived yet; it usually arrives within seconds. Reload and it changes to “Verified — signed PayPal notice”.' },
    ],
    notes: ['Sample vs real: a “Sample data” purchase has no PayPal record and can’t be checked. A “Real PayPal Sandbox transaction” is one you made here with test money.', 'Pending: “Waiting for your PayPal approval” means PayPal hasn’t been approved yet; “Payment processing” means PayPal hasn’t finished. Cancelled: nothing was paid.', 'Real hosted sandbox evidence: captures 96T3543906935310P, 19D86010XS597545K and 0E885908SW635761P (test money).'],
    related: ['activity-search', 'troubleshooting'],
  },
  {
    n: 8, slug: 'activity-search', title: 'Finding anything in Activity', minutes: 1, sections: ['payment-memory'],
    summary: 'Every payment, family decision, scam check and refund in one list, with search and filters.',
    steps: [
      { t: 'Open the Activity tab. It lists purchases and payments, family reviews and scam checks, newest first, each with its label.', shots: [{ id: 'g08/01-activity', alt: 'Activity on a computer with a search box, filter buttons and a list of purchases labelled Real PayPal Sandbox transaction or Sample data.', cap: 'Activity: everything in one place.' }] },
      { t: 'Type in the search box, for example “microwave”, and press Enter or the search button.', prompt: 'microwave', shots: [{ id: 'g08/02-search', alt: 'Activity search box with microwave typed and matching results below.', cap: 'Search by item, shop or person.' }] },
      { t: 'Use the filters: All, Waiting, Purchases & payments, Scam checks, Family reviews and Refunds. “Amount and date” narrows it further.', shots: [{ id: 'g08/03-filters', alt: 'Activity filter buttons: All, Waiting, Purchases and payments, Scam checks, Family reviews, Refunds.', cap: 'Filters.' }] },
      { t: 'Open any row for its details or receipt. You can also ask the Assistant “Show my payments”.' },
    ],
    related: ['verified-receipt', 'have-i-already-paid'],
  },
  {
    n: 9, slug: 'subscriptions', title: 'Subscriptions', minutes: 2, sections: ['subscriptions'],
    summary: 'See what comes out regularly, what costs most and what is next, and get guidance on cancelling.',
    intro: 'Mary’s sample subscriptions are illustrative examples with illustrative amounts, labelled “Sample data”. SaySafe adds up what you pay; it cannot see subscriptions you haven’t added.',
    steps: [
      { t: 'Ask the Assistant:', prompt: 'Show my subscriptions', shots: [{ id: 'g09/01-subscriptions', alt: 'Subscriptions card listing sample subscriptions with monthly and yearly totals, labelled Sample data.', cap: 'Subscriptions with monthly and yearly totals.' }] },
      { t: 'Ask follow-ups: “Which costs the most?” or “What’s coming out next?”.', optional: true },
      { t: 'Tap a subscription, then “Help me cancel”, or ask to cancel one. For a company outside SaySafe this is guidance only: cancel with the company itself, and stop any PayPal automatic payment in PayPal yourself. SaySafe can’t cancel other companies’ subscriptions.', shots: [{ id: 'g09/02-cancel-help', alt: 'Cancel help card with two steps: cancel the service with the company, and stop the PayPal automatic payment yourself.', cap: 'Cancelling: guidance only for outside companies.' }] },
      { t: 'When you tell SaySafe you have cancelled, it shows “You told SaySafe this is cancelled — not confirmed by the provider”.' },
      { t: 'The SaySafe Demo Membership is different: a PayPal Sandbox subscription (test money) that SaySafe can start and cancel through PayPal’s Subscriptions API, only when you tap the button. Saying “yes” never cancels it.', optional: true, shots: [{ id: 'g09/03-demo-membership', alt: 'Demo Membership card with a Start Demo Membership button.', cap: 'The Demo Membership (PayPal Sandbox).' }] },
    ],
    notes: ['Demo Membership status: cancelling through PayPal’s Subscriptions API is proven in the PayPal Sandbox by script (approved, cancelled, then read back as CANCELLED). Doing it through the app on the hosted demo is not yet verified, so treat it as unverified there.', 'SaySafe does not send reminders before a charge.'],
    related: ['insights'],
  },
  {
    n: 10, slug: 'trusted-contacts-and-send-money', title: 'Trusted contacts and sending money', minutes: 2, sections: ['scam', 'payment-memory'],
    summary: 'Find the real numbers of people you trust, and hand off to PayPal’s own Send money page. SaySafe never sends money.',
    steps: [
      { t: 'Ask the Assistant:', prompt: 'Find Alex in my contacts', shots: [{ id: 'g10/01-find-alex', alt: 'Contact card for Alex Byrne, family helper, with a saved phone number and email.', cap: 'A trusted contact, saved by Mary.' }] },
      { t: 'Contacts are “Saved by you — not verified”. When a message claims to be from someone but uses another number, the scam check says so (guide 2).' },
      { t: 'To pay someone you know, ask:', prompt: 'Send Alex €50' },
      { t: 'Choose the right person, confirm the details are right, then choose “Open PayPal Send money”. That opens PayPal’s own page, where you sign in and send it yourself. Nothing is sent by SaySafe.', shots: [{ id: 'g10/02-send-money', alt: 'Send money card: Step 3 of 3, Send it yourself in PayPal, €50.00 to Alex Byrne, not sent yet, with an Open PayPal Send money button.', cap: 'Hand-off to PayPal’s Send money page.' }] },
    ],
    notes: ['SaySafe’s PayPal connection is a shop (merchant) account. It can take payment for Demo Shop items you approve, but it can’t take money from your PayPal wallet or send money to a person.', 'Sample contacts use fictional numbers reserved for TV drama and @example.com emails.', 'Contacts are never sent to the AI service and never shown to your family member.'],
    related: ['check-a-suspicious-message'],
  },
  {
    n: 11, slug: 'voice', title: 'Using your voice', minutes: 2, sections: ['voice'],
    summary: 'Tap Speak, say what you need, and SaySafe sends it. Typing always works too.',
    steps: [
      { t: 'In the Assistant, tap “Speak” and allow the microphone when your browser asks. Nothing is recorded until you allow it and tap.', shots: [{ id: 'g11/02-speak-button', alt: 'Assistant composer with the Speak button outlined next to the text box.', cap: 'Tap Speak to talk.' }] },
      { t: 'Say what you need, for example “find me a microwave under 150 euro”, then stop talking. SaySafe sends it after a short pause. Tap again to cancel while it is listening: nothing is sent.' },
      { t: 'Spoken replies are off until you turn them on: SaySafe never plays sound by itself. Press “Turn on spoken replies” at the top of the Assistant or in Profile › Voice & conversation. Every reply is always shown as text too, and Stop or Escape silences it at any time.', shots: [{ id: 'g11/01-voice-settings', alt: 'Profile Voice and conversation settings with the spoken replies switch and speed setting outlined.', cap: 'Voice settings in Profile.' }] },
      { t: 'Saying “yes” never pays. You still approve at PayPal, and wait for family over your limit.' },
    ],
    notes: ['English is the only verified language. Other reply languages in Profile are beta and unverified.', 'Tested in Chromium-based browsers (Chrome, Edge) with a simulated microphone. Voice on iPhone Safari hasn’t been verified: please type on iPhone.', 'Voice clips are sent to an AI speech service to turn them into text, and are not stored.'],
    related: ['settings-and-accessibility'],
  },
  {
    n: 12, slug: 'insights', title: 'Insights for Mary and Alex', minutes: 2, sections: ['insights'],
    summary: 'A calm, read-only summary: Mary’s own at /insights, and Alex’s family dashboard at /family/insights.',
    steps: [
      { t: 'Mary: on Home, choose “View insights” (or the Insights tab on a computer, or ask “Show my insights”).', shots: [{ id: 'g12/01-home-insights-card', alt: 'Home insights card with a View insights button outlined.', cap: 'Home › View insights.' }] },
      { t: 'Mary’s insights show payments by kind of record, purchases waiting for approval, possible repeat payments, subscriptions, what comes out next, messages checked and PayPal Sandbox outcomes. “Real PayPal Sandbox”, “Recorded by you” and “Sample data” are never added together.', shots: [{ id: 'g12/02-mary-insights', alt: 'Mary’s Insights page with spending by kind of record and the sandbox payment shown separately from sample data.', cap: 'Mary’s insights (/insights).' }] },
      { t: 'Alex: open the Family page and choose Insights (or /family/insights). He sees purchases waiting for a decision, decisions made, sandbox captures confirmed by PayPal, signed webhooks, scam checks Mary shared, a 14-day chart with a table version, and a searchable ledger.', shots: [{ id: 'g12/03-alex-insights', alt: 'Alex’s Family Safety Insights dashboard with KPI tiles, a chart and a ledger.', cap: 'Alex’s family dashboard (/family/insights).' }] },
      { t: 'What Alex’s Insights use: only records Mary’s permissions allow, which means the requests sent to him and scam checks she shares, plus spending totals or individual purchases only if she has turned on the matching sharing switch. He never sees her conversations, other transactions, contacts or subscriptions, and can’t change her limit. Insights can explain; it can’t approve, pay or change anything.' },
    ],
    notes: ['Example rows are labelled and never counted in the PayPal totals.', 'Asking Insights a question sends a summary of the records that person is allowed to see to the AI service (Groq) to write the answer. Alex’s questions use only permission-filtered records, never Mary’s unrestricted history. Saved contacts and typed payment records are never sent.', 'The public site uses SaySafe’s own native React dashboard. An optional AG Studio view exists for evaluation only and is not enabled publicly.'],
    related: ['family-approval', 'verified-receipt'],
  },
  {
    n: 13, slug: 'settings-and-accessibility', title: 'Settings and accessibility', minutes: 2, sections: ['voice', 'privacy'],
    summary: 'Bigger text, high contrast, reduced motion, voice, reply language, shopping preferences, privacy, family and demo reset.',
    steps: [
      { t: 'Open Profile. Settings are grouped into Personal experience, Account & preferences, and Demo & help, with quick links at the top.', shots: [{ id: 'g13/01-profile', alt: 'Profile on a computer with Voice and conversation, Accessibility, Language, Shopping, Trusted family and Privacy sections.', cap: 'Profile, all settings in one place.' }] },
      { t: 'Accessibility: “Bigger text”, “High contrast” and “Reduce motion”. They are saved on this device. Bigger text and contrast are also in the Assistant under Menu › Display.', shots: [{ id: 'g13/02-accessibility', alt: 'Accessibility settings with Bigger text, High contrast and Reduce motion switches.', cap: 'Accessibility switches.' }, { id: 'g13/03-assistant-menu', alt: 'Assistant Menu open with New conversation, Voice settings and Display, showing Bigger text and High contrast switches.', cap: 'Assistant › Menu › Display.' }] },
      { t: 'Voice & conversation: spoken replies, speed and read-everything (guide 11). Language (beta): the reply language; screens stay in English.' },
      { t: 'Shopping preferences change only the order of product results. Trusted family shows who is connected. Family sharing shows Mary’s limit (only Mary can change it) and the two sharing switches, “Share spending summaries with Alex” and “Share my purchase history with Alex” (both off to start with). Privacy & data lets you clear the conversation and delete what you saved.' },
      { t: 'What SaySafe remembers (Mary only): off until Mary turns on “Remember my preferences”. Then a clear shopping preference she says, such as “remember I like black” or “keep my budget below €100”, is saved and shapes real-shop results; “Forget that” or the Remove and Clear buttons delete it. It is never proof of payment, Alex can’t see it, and only product words go to Channel3.' },
      { t: 'Demo & help: Things to try, Try as Alex too, Reset Mary’s demo, and these guides.' },
    ],
    notes: ['Everything works with a keyboard: Tab to move, and “Skip to main content” at the top.', 'Checked with automated accessibility tools (axe, WCAG 2.2 AA rules) on the pages tested, at emulated phone and desktop sizes. Automated checks are a floor: not yet tested with screen reader users or with older adults.'],
    related: ['voice'],
  },
  {
    n: 14, slug: 'troubleshooting', title: 'Troubleshooting', minutes: 3, sections: ['troubleshooting'],
    summary: 'Slow first load, PayPal sandbox login, microphone, pending payments, receipts, sample data and retries.',
    steps: [
      { t: 'The first page takes a long time. The free server (Render Free) sleeps when idle; the first visit can take about 60 seconds to wake it. Wait, then it is quick.', label: 'Slow first load' },
      { t: 'PayPal won’t accept my login. The PayPal page is the sandbox: it needs a PayPal Sandbox buyer account, not your real PayPal login. Judges: use the login in the Devpost testing instructions.', label: 'Sandbox login' },
      { t: 'The microphone doesn’t work. Allow the microphone in your browser’s site settings and try again, use Chrome or Edge, or type instead. Voice on iPhone Safari hasn’t been verified: please type on iPhone.', label: 'Microphone denied' },
      { t: 'It says Pending. “Waiting for family” needs Alex’s answer; “Waiting for your PayPal approval” needs you on PayPal’s page; “Payment processing” is PayPal finishing. Open the purchase in Activity and choose “Check with PayPal” to see where it is.', label: 'Pending' },
      { t: 'My receipt says Verification pending. PayPal’s signed notice usually arrives within seconds. Reload the receipt. The payment is already captured and checked with PayPal; only the second confirmation is waiting.', label: 'Receipt delay' },
      { t: 'I closed the page while paying. Nothing is charged twice. Ask “Did my payment go through?” or open the purchase in Activity and choose “Check with PayPal”. If PayPal shows you approved it, choose “Finish payment”. This safe status check never captures twice.', label: 'Safe status check' },
      { t: 'I can’t pay a sample purchase. Purchases marked “Sample data” are illustrations with no PayPal record. They can’t be paid, approved, refunded or checked with PayPal. Buy a Demo Shop item to make a real sandbox payment.', label: 'Sample not checkoutable', shots: [{ id: 'g14/01-sample-order', alt: 'A sample purchase page marked Sample data, Illustrative — no PayPal record, explaining it can’t be paid or checked with PayPal.', cap: 'A sample purchase: illustration only.' }] },
      { t: 'SaySafe won’t cancel my subscription. For companies outside SaySafe it gives guidance only: cancel with the company and in PayPal yourself.', label: 'External subscriptions' },
      { t: 'No products found. Try simpler words (“microwave”, “kettle under €40”) or ask SaySafe to search real shops. Channel3 results change over time.', label: 'No results' },
      { t: 'Something failed. Use the “Retry” or “Check with PayPal” button on the card. Retrying never creates a second payment: SaySafe reuses the same PayPal request and captures at most once. (Duplicate confirms and lost redirects were checked live on the sandbox; capture timeouts are covered by automated tests with a PayPal test double.)', label: 'Retry without duplicates' },
    ],
    related: ['verified-receipt', 'paypal-sandbox-purchase'],
  },
];

export const guideBySlug = (slug: string) => GUIDES.find((g) => g.slug === slug);

export const SECTIONS: { id: SectionId; title: string; blurb: string }[] = [
  { id: 'getting-started', title: 'Getting Started', blurb: 'Open the demo as Mary and find your way around.' },
  { id: 'how-it-works', title: 'How SaySafe Works', blurb: 'Before, during and after a payment, and the rule behind it.' },
  { id: 'guides', title: 'Step-by-Step Guides', blurb: 'Fourteen short guides with real screenshots.' },
  { id: 'use-cases', title: 'Use Cases', blurb: 'Everyday moments where a second look helps.' },
  { id: 'family', title: 'Family Circle', blurb: 'Alex reviews purchases over Mary’s limit.' },
  { id: 'paypal', title: 'PayPal Sandbox Payments', blurb: 'Test-money checkout and receipts checked with PayPal.' },
  { id: 'voice', title: 'Voice Assistant', blurb: 'Tap to talk, replies always shown as text.' },
  { id: 'payment-memory', title: 'Payment Memory', blurb: '“Have I already paid?”, receipts and Activity.' },
  { id: 'subscriptions', title: 'Subscriptions', blurb: 'What comes out regularly, and how to cancel.' },
  { id: 'scam', title: 'Scam Guardian', blurb: 'Warning signs in messages, links and numbers.' },
  { id: 'shopping', title: 'Shopping Assistant', blurb: 'Real products to compare, and the Demo Shop.' },
  { id: 'insights', title: 'Insights', blurb: 'Read-only summaries for Mary and Alex.' },
  { id: 'privacy', title: 'Privacy & Security', blurb: 'What SaySafe keeps, sees and never does.' },
  { id: 'faq', title: 'FAQ', blurb: 'Short answers to common questions.' },
  { id: 'troubleshooting', title: 'Troubleshooting', blurb: 'Slow load, login, microphone, pending payments.' },
];

export const HOW_IT_WORKS = [
  { when: 'Before you pay', items: ['Check a suspicious message, link, number or screenshot (Scam Guardian).', 'Ask “have I already paid?” against your own records.', 'Compare real products, or review the exact Demo Shop item and server price.'] },
  { when: 'While you pay', items: ['Over your limit, your family helper approves or declines that exact purchase.', 'You approve the payment yourself on PayPal’s own sandbox page.', 'SaySafe re-checks amount and currency with PayPal and captures once.'] },
  { when: 'After you pay', items: ['A receipt that says “paid” only after PayPal confirms the capture.', 'PayPal’s signed notice verified; the same receipt when you ask again.', 'Activity and Insights, with real sandbox and sample data kept apart.'] },
];

export const USE_CASES = [
  { t: 'An invoice says call this number to cancel', d: 'Paste it in. SaySafe points out the phone number and the pressure, and tells you to type paypal.com yourself.', guide: 'check-a-suspicious-message' },
  { t: '“Hi Mum, I’ve a new number”', d: 'SaySafe compares the number with the one you saved and tells you to call the saved one first.', guide: 'check-a-suspicious-message' },
  { t: 'A message says you still owe €120', d: 'Check your own records for a possible match before paying again.', guide: 'have-i-already-paid' },
  { t: 'Paid the gardener twice?', d: 'Two similar payments a few days apart are flagged as a possible duplicate.', guide: 'have-i-already-paid' },
  { t: 'Buying something bigger', d: 'Over your limit, someone you trust checks the exact item and price first.', guide: 'family-approval' },
  { t: '“Did it go through?”', d: 'Ask in plain words. You get the receipt checked with PayPal, never a second charge.', guide: 'verified-receipt' },
];

export const PRIVACY = [
  'Payments use the PayPal Sandbox only: test money, no real deliveries. You approve on PayPal’s page; SaySafe never sees your PayPal password.',
  'SaySafe can’t read your PayPal account, bank, inbox or text messages, can’t take money from your wallet and can’t send money to a person.',
  'The AI explains and suggests. Paying, approving, capturing and cancelling are buttons checked by SaySafe’s server, never the AI.',
  'Scam checks keep the result, not the message. Screenshots are read in memory and not stored.',
  'Messages, screenshots and voice clips you send are processed by an AI service (Groq). Insights questions also send a summary of the records the asker is allowed to see (for Alex, only permission-filtered records). Product searches go to Channel3. Saved contacts and typed payment records are not sent to the AI.',
  'The server can be configured with a fallback AI provider (an OpenAI-compatible service such as Gemini) for when Groq is unavailable. The README says whether the hosted demo uses one.',
  'Your family helper sees only the purchase requests sent to them (shop, item, amount, status) and scam checks you choose to share. Purchases under your limit stay private. You can choose to share spending totals (“Share spending summaries with Alex”) or each purchase (“Share my purchase history with Alex”); both are off to start with and you can turn them off any time. They never see your conversations, other transactions, contacts or subscriptions, can’t change your limit, and can never pay or refund. The server enforces this.',
  'Memory (“What SaySafe remembers” in Profile) is off until you turn it on, and it is yours only: your family helper can’t see it. It keeps clear shopping preferences you state (a colour, a brand, a budget) and the last few products you talked about. It is never proof of payment: “did I pay?” is answered only from payment records. Only product words, such as a colour, are sent to Channel3 with a search. You can change, remove or clear it any time.',
  'Please don’t paste real card numbers, passwords or one-time codes into this demo.',
];

export const FAQ: { q: string; a: string }[] = [
  { q: 'Does SaySafe use real money?', a: 'No. Every payment uses the PayPal Sandbox, PayPal’s test system. No real money moves and nothing is delivered.' },
  { q: 'Can SaySafe tell me a message is genuine?', a: 'No. The best result is “No obvious warning signs”, which is not a guarantee. SaySafe never calls a message, link or seller safe.' },
  { q: 'Can my family member pay with my account?', a: 'No. They can approve or decline a purchase over your limit, but you always approve the payment yourself on PayPal’s page.' },
  { q: 'What can my family helper see?', a: 'Only the purchases your limit sends to them for a check: the item, the shop, the amount, and whether it was paid in the end. Purchases under your limit stay private. If you want, you can share your spending totals, or each purchase, with two separate switches. Both start off, and you can turn them off any time. Only you can change your limit.' },
  { q: 'Does SaySafe remember what I tell it?', a: 'Only if you turn on “Remember my preferences” in Profile › What SaySafe remembers. Then it keeps the shopping preferences you state, which you can change or clear. Your family helper can’t see them, and a remembered conversation is never proof that you paid.' },
  { q: 'Can the AI buy something on its own?', a: 'No. The AI only explains and suggests. Paying and approving are separate steps checked by SaySafe’s server.' },
  { q: 'Can I buy the Channel3 products inside SaySafe?', a: 'No. They open the shop’s own website. Only the SaySafe Demo Shop takes a (sandbox) payment inside SaySafe.' },
  { q: 'Can SaySafe send money to a friend?', a: 'No. It opens PayPal’s own Send money page, where you send it yourself.' },
  { q: 'Can SaySafe get my money back?', a: 'It can’t promise a refund or open a dispute. It shows the steps: contact the shop first, then PayPal’s Resolution Centre.' },
  { q: 'Which languages and browsers work?', a: 'English is verified. Other reply languages are beta. Voice is tested in Chrome and Edge with a simulated microphone; voice on iPhone Safari hasn’t been verified (typing works everywhere).' },
  { q: 'Is SaySafe part of PayPal?', a: 'No. SaySafe is an independent open-source hackathon project, not affiliated with or endorsed by PayPal.' },
];

/** Judge's Guide — Test SaySafe in 5 Minutes. Shot ids reuse the guide screenshots. */
export const JUDGE_STEPS: { t: string; prompt?: string; optional?: boolean; shot?: ShotRef; guide?: string; ui?: string[] }[] = [
  { t: 'Open the live app and choose “Try as Mary”. The first load after idle can take about 60 seconds (free hosting).', ui: ['Try as Mary'], shot: { id: 'g01/01-landing', alt: 'Landing page with Try as Mary outlined.', cap: 'Try as Mary' }, guide: 'getting-started' },
  { t: 'In the Assistant, ask whether Mary already paid a €120 request. Note the “Sample data” label and that a match is not proof.', prompt: 'I received a message saying I owe €120. Can you check whether I already paid?', shot: { id: 'g03/01-owe-120', alt: 'Possible matches for €120, labelled Sample data.', cap: 'Possible matches, labelled' }, guide: 'have-i-already-paid' },
  { t: 'Ask for a product. Real Channel3 listings open the retailer’s site; the Demo Shop offer is shown separately.', prompt: 'Can you help me buy a microwave instead?', shot: { id: 'g04/01-listings', alt: 'Real listings from Channel3.', cap: 'Real listings (Channel3)' }, guide: 'find-real-products' },
  { t: 'Buy the Demo Shop item. Check the card: €120.00 EUR, above the €75 limit. Choose “Allow” to ask family.', prompt: 'Let’s buy the demo microwave.', ui: ['Allow'], shot: { id: 'g05/01-purchase-card', alt: 'Purchase card with €120.00 EUR and Allow.', cap: 'Exact item and server price' }, guide: 'paypal-sandbox-purchase' },
  { t: 'The card shows “Family review: Pending”. Choose “Try as Alex too” (if asked, “Leave, keep it saved”).', ui: ['Try as Alex too'], shot: { id: 'g06/01-mary-waiting', alt: 'Pending family review with Try as Alex too.', cap: 'Waiting for family' }, guide: 'family-approval' },
  { t: 'As Alex, check the exact item, amount and expiry, then choose “Approve”.', ui: ['Approve'], shot: { id: 'g06/02-alex-review', alt: 'Alex’s review card with Approve.', cap: 'Alex approves' }, guide: 'family-approval' },
  { t: 'Go back to Mary: Profile › “Back to Mary”, then Assistant. The same card now says “Approved”. Choose “Continue to PayPal”.', ui: ['Back to Mary', 'Continue to PayPal'], shot: { id: 'g06/06-mary-approved', alt: 'Mary’s card Approved with Continue to PayPal.', cap: 'Continue to PayPal' }, guide: 'family-approval' },
  { t: 'On PayPal’s sandbox page, log in with the judge sandbox buyer from the Devpost testing instructions and approve EUR 120.00. (Never a real PayPal login.)', guide: 'paypal-sandbox-purchase' },
  { t: 'Back in SaySafe, read the receipt: Captured, checked with PayPal. Reload after a few seconds to see “Verified — signed PayPal notice”.', shot: { id: 'g07/02-receipt-page', alt: 'Receipt page: Captured.', cap: 'Receipt checked with PayPal' }, guide: 'verified-receipt' },
  { t: 'Ask again. You get the same receipt; nothing is charged twice.', prompt: 'Did my payment go through?', shot: { id: 'g07/01-receipt-card', alt: 'Receipt card in the Assistant.', cap: 'Same receipt' }, guide: 'verified-receipt' },
  { t: 'Open Activity: the purchase is labelled “Real PayPal Sandbox transaction”, next to sample rows.', ui: ['Activity'], shot: { id: 'g08/01-activity', alt: 'Activity list with labels.', cap: 'Activity' }, guide: 'activity-search' },
  { t: 'Open Insights: Home › “View insights” for Mary; Alex’s dashboard is at /family/insights.', optional: true, ui: ['View insights'], shot: { id: 'g12/02-mary-insights', alt: 'Mary’s insights.', cap: 'Insights' }, guide: 'insights' },
  { t: 'Try a scam check: on Home choose “Things to try”, then “Check this suspicious message” and “Check this training example” (expect “Suspicious” for the fake invoice). Or choose “Check a message” on Home and paste the message below.', optional: true, ui: ['Things to try', 'Check this suspicious message', 'Check this training example', 'Check a message'], prompt: 'PayPal: your account is on hold. You owe €120 for a microwave order. Call 01 555 0199 to cancel.', shot: { id: 'g02/02-fake-invoice', alt: 'Suspicious result.', cap: 'Scam check' }, guide: 'check-a-suspicious-message' },
];

export function guideText(g: Guide): string {
  return [g.title, g.summary, g.intro ?? '', ...g.steps.flatMap((s) => [s.t, s.prompt ?? '', s.label ?? '', ...(s.shots ?? []).map((x) => x.cap)]), ...(g.notes ?? [])].join(' ');
}
