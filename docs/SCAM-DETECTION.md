# SaySafe scam detection: how it works, what it can and cannot tell you

Branch `scam-audit`, written 2026-11-03. This document is deliberately blunt about limits.

## The short version

* SaySafe reads the words, links, email addresses and phone numbers **in the message the user pastes or screenshots**. It never opens links, never calls numbers, never contacts the sender, and has no access to the user's PayPal account, bank, email inbox or chats.
* **It verifies nothing about the sender or the transaction.** A result is a judgement about the *text*, not proof that a payment, invoice or sender is real or fake.
* URL checks are **lexical only**: domain parsing (public suffix list via `tldts`), look-alikes, punycode, shorteners, `@` tricks, raw IPs. Optional third-party URL lists (Google Web Risk, PhishTank) exist in code but are **not configured** in `render.yaml`, so in production nothing is independently checked.
* There are exactly three verdicts: **Suspicious**, **Needs checking**, **No obvious warning signs**. SaySafe never says "safe", "real" or "legitimate". "No obvious warning signs" always carries: *"SaySafe can't confirm who sent this or whether a payment is real. Check in the official PayPal app."*

## Finding sources (shown next to every finding in the UI)

| Label | Meaning | Where |
|---|---|---|
| **Deterministic rule** | A fixed pattern in SaySafe's code matched the message (exact span quoted). Same input → same result. | `server/scam/rules.ts`, `indicators.ts`, `evidence.ts`, local blocklist in `reputation.ts` |
| **AI judgement** | The language model's opinion. Can be wrong, can hallucinate reasons. | `server/scam/guardian.ts` (`scanMessage`) |
| **Independently verified** | An outside source confirmed something. Only possible today if `GOOGLE_WEB_RISK_API_KEY` or `PHISHTANK_APP_KEY` is set and a URL is **listed** as bad. Not configured in production, so in practice **nothing** is independently verified. A URL that no list contains is "unknown", never "safe". | `server/scam/reputation.ts` |

## Pipeline

### Text (`POST /api/scan` → `scanMessage`)
1. **Normalise**: NFKC, cap 20 000 chars (`rules.ts analyseText`). API input is capped at 8 000 chars (zod, `server/app.ts`).
2. **Extract** (`evidence.ts`): links (scheme URLs + bare domains validated against the public suffix list), email addresses, phone numbers (phone-shaped only; dates, amounts, time ranges and labelled order/invoice/transaction IDs are excluded).
3. **Link analysis** (`rules.ts analyseLink`, deterministic): official `paypal.com` / `paypal.me` recognised by registrable domain; PayPal pages *anyone can create* (invoices, money requests, paypal.me) flagged as "real PayPal page that anyone can send"; `@` trick, raw IP, punycode/IDN, shortener, brand in subdomain, brand look-alike/typosquat, brand only in the path, sign-in/"verify" words on non-PayPal sites, plain http.
4. **Email analysis**: exact match to the one verified PayPal address (`phishing@paypal.com`), other `@paypal.com` (unverified, can be spoofed), brand look-alike domains, free-mail "support" addresses, any other address (unverified).
5. **Wording indicators** (`indicators.ts`, deterministic, whole-word regexes with the exact span quoted): urgency/threats, "account limited/suspended", requests for codes/passwords/card details (negation-aware: "never share this code" is not a request), one-time code present, remote-access apps/screen sharing, gift cards, crypto, "call us"/helplines, **call to cancel/refund**, unexpected charge/renewal/"if this wasn't you", **phone number + unexpected charge** (the PayPal fake-invoice phone scam), payment asks, pay-through-a-link, overpayment/refund stories, "Hi Mum, new number", secrecy ("don't tell anyone"), "safe account", romance/investment, prizes, QR codes, generic greetings.
6. **Local blocklist** (`reputation.ts`, 3 demo domains) and optional Web Risk / PhishTank lookups (URL string only; never fetched by SaySafe).
7. **Deterministic verdict** (`verdicts.ts decideFromSignals`):
   * any high signal → **Suspicious**
   * medium signals from 2+ risk families where at least one is a deception family (pressure, link, identity, story, charge, secret) → **Suspicious**
   * a story/pressure/charge/secret signal plus a non-PayPal link → **Suspicious**
   * any other medium signal, a phone number, an unknown link or email, a one-time code, an invoice/money-request link, or an uncertain screenshot → **Needs checking**
   * nothing found → **No obvious warning signs** (+ disclosure)
   * A genuine `paypal.com` link never lowers anything; a lone verified PayPal help/home page is the only link that does not force "Needs checking".
8. **AI layer** (text model **Groq `openai/gpt-oss-20b`**, `GROQ_FAST_MODEL`; fallback endpoint only if `AI_FALLBACK_*` is set). The message is sent as untrusted data inside `<untrusted_message>`, with the rule signals. Output is schema-checked JSON. Merge (`verdicts.ts mergeWithAi`):
   * AI can **raise** a verdict and can **never lower** one. A rule-based Suspicious stays Suspicious.
   * AI "suspicious" raises Needs checking → Suspicious, and No obvious warning signs → Needs checking (one step; see "Live results" for why).
   * AI "needs_verification" is the model's floor (it may not say anything better), so on its own it does not move "No obvious warning signs" unless the model also lists something risky in `asks_for`.
   * The AI can never produce "No obvious warning signs".
9. **Spoken summary**: the model's summary is used only when the model's verdict equals the final verdict; otherwise a fixed sentence is used. "No obvious warning signs" always uses the fixed sentence that includes the disclosure.
10. **Stored**: `security_scans` keeps only the verdict code and the headline, never the message.

### Links / URLs
Lexical only (step 3). SaySafe does **not** resolve shorteners, follow redirects, fetch pages, check certificates, WHOIS age or hosting. Anything not on PayPal's own domain is at best "a link SaySafe cannot check" (Needs checking).

### Invoices and money requests
A real `paypal.com/invoice/...` or `paypal.me/...` link proves only that the page is on PayPal, **not** that the sender is honest: any PayPal user can send an invoice or request with arbitrary notes. Rules: such a link is always at least **Needs checking**; with a phone number next to a charge/renewal/purchase claim, or with call-to-cancel/refund wording, it is **Suspicious**.

### Screenshots (`POST /api/scan/image`)
Magic-byte check (PNG/JPEG/WebP), 4 MB max, held in memory only. The vision model **Groq `qwen/qwen3.8-27b`** (`GROQ_VISION_MODEL`) transcribes text, links, emails and phones and flags unclear characters; the transcript then goes through the text pipeline above. If the model reports unclear characters, "No obvious warning signs" is impossible (becomes Needs checking). The transcription itself is **AI judgement**: an OCR mistake (l/I, 0/O) can hide a look-alike domain.

### "Why?" follow-up (`POST /api/scan/explain` → `explainMore`)
Free-text answer from the fast model, max ~3 sentences, told never to call a message safe. It is given the verdict and signal titles **from the request body** (client-supplied), so it is only as trustworthy as the client; it never changes a verdict.

### Verdict codes and backward compatibility
| New (API `verdict`, DB `security_scans.verdict`) | Label | Legacy code (API `legacyVerdict`, old rows) |
|---|---|---|
| `suspicious` | Suspicious | `suspicious` |
| `needs_checking` | Needs checking | `needs_verification` |
| `no_obvious_warning_signs` | No obvious warning signs | `verified_official_contact` |

`normalizeVerdict()` (`server/scam/verdicts.ts`) maps old rows and unknown values (unknown → Needs checking). `/api/family/overview` returns normalised verdicts plus `verdictLabel`. **The Family Safety Insights dashboard being built on `main` reads `security_scans.verdict` directly (`server/insights/model.ts`) and should call `normalizeVerdict()` after merge.**

## Evidence, next steps, limits (`server/scam/evidence.ts`, UI `web/src/components/ScanDetails.tsx`)
* Every finding shows the **exact matched span** with a little context (quoted, truncated by code points, bidi-override/zero-width characters stripped). It is rendered as React text (HTML-escaped by React); `escapeHtml()` exists for any non-React use.
* Every result lists **"What SaySafe could not verify"** (sender, whether any payment is real, where links lead, who answers numbers, email ownership, screenshot accuracy).
* Safe next steps, each source opened on 2026-11-03:
  * Open the PayPal app or type paypal.com yourself; don't use links — https://www.paypal.com/ie/security/learn-about-fake-messages ("Type the URL directly yourself").
  * Never call numbers in the message; use the Help Centre contact page https://www.paypal.com/ie/smarthelp/contact-us (linked from the page above: "Only contact PayPal via the Contact page in our Help Centre").
  * Don't share codes or passwords — same page ("Account info, passwords and validation codes are for your eyes and ears only").
  * Report: forward to **phishing@paypal.com** — verified on https://www.paypal.com/ie/security/report-suspicious-messages ("Forward the entire email to phishing@paypal.com and delete it").
  * Ireland: contact your bank and report to your local Garda station — https://www.garda.ie/en/crime/fraud/what-are-the-6-most-common-types-of-fraud-in-ireland-today-and-how-to-avoid-becoming-a-victim-.html (independently verify; never use contact details supplied by the caller/texter; report attempted fraud too).

## Weaknesses found in the original code (origin/main 6e66af0)

| # | Weakness | Where (original) | Status |
|---|---|---|---|
| 1 | Keyword matching by **substring**: `'pin'` matched "shi**pp**in**g**"/"sho**pin**g" → "asks for private details" (high) → **Suspicious** for ordinary delivery notices; `'pay'` matched "**Pay**Pal"; `'locked'` matched "b**locked**"; `'limited'` matched "un**limited**"; `'otp'` inside other words. | `rules.ts` L45–54 lists, L207 `text.includes(w)` | Fixed: whole-word regexes in `indicators.ts` |
| 2 | Sensitive-word list fired on **warnings** ("we will never ask for your PIN") → Suspicious for genuine bank/PayPal notices. | `rules.ts` L49 | Fixed: negation-aware request detection |
| 3 | Bare-domain extraction used a hand-written TLD list without `ly`, `gl`, `gd`, `at`, `gy`, `cc`, `in`… so `bit.ly/x` without `https://` was **not seen at all**. | `rules.ts` L39 `URL_RE` | Fixed: public-suffix validation (`evidence.ts extractLinks`) |
| 4 | Phone regex matched dates, long order/transaction IDs and receipt numbers; "contact" anywhere made it medium. | `rules.ts` L41, L170 | Fixed: phone-shape + label/date/amount exclusions |
| 5 | Evidence for wording signals was the keyword list, not the text ("urgent, limited"), so users could not see what triggered it. | `rules.ts` urgency/sensitive signals | Fixed: exact quoted span |
| 6 | Typosquat threshold: edit distance ≤ 2 on any ≥4-letter label (e.g. "payday" ≈ "paypal"). | `rules.ts` L147 | Tightened: ≤1, or ≤2 only with digits |
| 7 | "Verified official contact" only reachable for a single token; any ordinary harmless message was "needs verification", so the scale effectively had two values and the label implied verification SaySafe never did. | `rules.ts` L235–246 | Replaced by the 3-verdict policy |
| 8 | No rule for the **phone + unexpected charge** combination unless specific words ("did not authorise", "Norton") appeared; e.g. a money request saying "your order is confirmed, to cancel call…" was only "needs verification". | `rules.ts` INVOICE_SCAM | Fixed: `phone_with_charge`, `call_to_cancel` |
| 9 | Missing scam families: "Hi Mum new number", safe-account, secrecy, overpayment, romance/investment, prizes, QR codes, remote-access apps beyond AnyDesk/TeamViewer, crypto as a separate signal, code request phrased "forward it to me". | `rules.ts` | Added in `indicators.ts` |
| 10 | AI output schema too strict (`reasons` items ≤ 200 chars): in the live run the model's normal answers failed validation and the **AI layer silently dropped out** (`ai.error = "AI returned invalid structured output"`). | `guardian.ts` L9 | Fixed: trim instead of reject. Still happens occasionally (3 of 66 live cases). |
| 11 | When the AI was used, its "needs_verification" (the only non-scam value it is allowed) lowered a rules "verified" to "needs verification" every time, so the best verdict was unreachable whenever AI was on. | `guardian.ts` L91, `rules.ts` L255 | Fixed: `mergeWithAi` |
| 12 | `explainMore` takes `scan.verdict`/signals from the request body. | `app.ts` L157, `guardian.ts` L138 | Documented, unchanged (no verdict effect) |
| 13 | Threat-intel lookups exist but no keys are configured in `render.yaml`; the local list has 3 demo domains. | `reputation.ts` L17–40 | Documented |
| 14 | Only one brand (`paypal`) is protected for look-alikes. | `directory.ts PROTECTED_BRANDS` | Documented |

## Test set and results

`tests/fixtures/scam-eval/cases.json`: **52** author-written, non-identifying cases (19 legitimate, 33 scam): PayPal-style receipts with no ask, friends splitting a bill, delivery notices without links, bank reminders, a genuine-style PayPal one-time code, obvious scams, convincing scams (look-alike domains, punycode, shorteners, "account limited", fake refunds, code requests, remote access, crypto, gift cards, "Hi Mum new number", romance), and 7 invoices/requests on the genuine PayPal domain with fraudulent phone or refund instructions. `holdout.json`: 12 more, written after the first fix round.

**These sets are small and were written by the same author who changed the rules. The counts below are not accuracy figures and say little about real-world performance.** "Expected" is the verdict the policy should give, so a genuine friend's request for money is correctly "Needs checking".

### Offline, deterministic layer only (`tests/scam-eval.test.ts`, no AI, no network)

| Run | cases.json (52) matches | FP (legit → Suspicious) | FN (scam → No obvious) | holdout (12) matches |
|---|---|---|---|---|
| Original rules (origin/main), legacy verdicts mapped | 26 | 5 | 0 | 3 (FP 1) |
| After fix round 1 (tuned on cases.json) | 52 | 0 | 0 | **7** — FN 1 (`ho-scam-bank-safe-account` got "No obvious warning signs"), 4 under-warnings, 1 over-warning |
| After fix round 2 (current) | 52 | 0 | 0 | 12 (one label corrected: the neighbour is paying the user) |

Round 1 → 52/52 on the set it was tuned on, but only 7/12 on unseen cases, which is the honest picture of how well these rules generalise. Round 2 fixes were generic (safe-account wording, secrecy, "it's me", "don't recognise", "authorised", refund asks only when imperative), but after them the holdout is no longer held out.

Original-rules false positives (all from substring matching): `legit-delivery-shipping-update`, `legit-bank-statement-reminder`, `legit-paypal-otp`, `legit-password-changed-notice` (all "pin"/"otp"/"password" inside text), `legit-plumber-invoice-phone`.

Confusion matrix, current offline rules, cases.json (rows expected, columns actual):

| | Suspicious | Needs checking | No obvious |
|---|---|---|---|
| Suspicious (31) | 31 | 0 | 0 |
| Needs checking (9) | 0 | 9 | 0 |
| No obvious (12) | 0 | 0 | 12 |

### Live, full pipeline (`scripts/scam-eval-live.mjs`, 2026-11-03, Groq `openai/gpt-oss-20b` + `qwen/qwen3.8-27b`)
Raw per-case results: `tests/fixtures/scam-eval/live-results.json`.

cases.json (52): 44 match. FN (scam → No obvious): **0**. FP (legit → Suspicious): **6**, all caused by the AI raising a rules "Needs checking" to Suspicious:
`legit-friend-asks-share`, `legit-friend-paypal-me`, `legit-paypal-otp`, `legit-plumber-invoice-phone`, `legit-password-changed-notice`, `legit-club-money-request`. Two more over-warnings on scams the policy rates "Needs checking" (`scam-hi-dad-new-number-first`, `pp-request-phone-no-charge-claim`). AI output failed validation (AI not used) on 2 cases.

| | Suspicious | Needs checking | No obvious |
|---|---|---|---|
| Suspicious (31) | 31 | 0 | 0 |
| Needs checking (9) | 8 | 1 | 0 |
| No obvious (12) | 0 | 0 | 12 |

holdout.json (12): 11 match; 1 over-warning (`ho-scam-paypal-me-deposit` raised to Suspicious, which is arguably right). AI not used on 1.
Screenshots (2 PNG fixtures through the vision model): 2 of 2 Suspicious.

What the live run shows: the model is told it may only say "suspicious" or "needs_verification", and it says "suspicious" for almost anything that mentions money, a code or a phone number, with reasons that are sometimes invented (e.g. "the transaction ID looks fabricated" for a plain receipt, in an earlier probe). In a first probe, before the one-step cap, it also turned plain PayPal receipts into Suspicious; that is why AI doubt alone now only moves "No obvious warning signs" to "Needs checking". The AI adds little detection on this set (the rules already catch every scam) and adds over-warnings. Options for later: give the model a calibrated three-value output, or require a deception-family rule signal before AI can raise Needs checking → Suspicious.

## WhatsApp warning share (`web/src/components/ShareWarning.tsx`, `web/src/lib/shareText.ts`)
* Optional button on every result: **Share warning on WhatsApp** → shows a preview of exactly what will be shared → **Open WhatsApp** (`https://wa.me/?text=…`, no phone number; the user picks the contact), **Share another way** (Web Share API, only when `navigator.share` exists), **Copy text**.
* Text = verdict + up to 2 generic warning phrases chosen by signal **code** (never the evidence, titles or message) + the safe next step + `https://saysafe.onrender.com/guide`. A sanitizer then strips anything that looks like a URL (except the SaySafe link and the bare advice "paypal.com"), email, phone number or long ID.
* Unit tests (`tests/share-text.test.ts`) feed a message full of names, invoice/capture/order IDs, phone numbers, emails and URLs and assert none survive.
* No WhatsApp Business API, no contact access, nothing sent by SaySafe.

## Android share target (`web/public/manifest.webmanifest`)
* Added a web app manifest (name, `start_url`, `display: standalone`, 192/512 PNG icons) and `share_target` **GET** `/check/share?title&text&url`. The Check page **prefills** the message box and shows a notice; it never auto-submits. The shared text survives the sign-in redirect via `sessionStorage` (one read, then deleted).
* Requirements read on 2026-11-03: MDN `share_target` (https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target): the PWA must be **installed**; files require `method: POST`, `enctype: multipart/form-data` and a `files` entry, handled by the server or a service-worker `fetch` handler. Chrome (https://developer.chrome.com/docs/capabilities/web-apis/web-share-target): must meet installability criteria and be installed; on Android the `url` field is often empty and URLs arrive in `text`. Installability (https://web.dev/articles/install-criteria) lists HTTPS + manifest with name, 192/512 icons, `start_url`, `display`; it no longer lists a service worker.
* **No service worker exists** and none was added. **Image sharing is not implemented**: a manifest can have only one `share_target`, so accepting screenshots means switching the text path to POST multipart and adding a service worker to hand the file to the page (or a server endpoint that would have to hold the image, which contradicts "processed in memory, never stored"). That was judged not small and not safe to ship untested. Paste and "Upload a screenshot" remain the fallbacks.
* Works only in **Chrome on Android after installing SaySafe** (Add to Home screen / Install app). **Not supported on iOS/Safari.** **Untested on a real device**; verified only by unit tests and a desktop Playwright visit to `/check/share?…`.

## What SaySafe could not verify (always shown)
Who really sent the message; whether any payment, invoice, refund or charge is real; where links lead; who answers phone numbers; who owns email addresses; whether a screenshot was read perfectly.
