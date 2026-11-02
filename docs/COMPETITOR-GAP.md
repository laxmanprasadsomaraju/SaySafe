# Competitor gap: SaySafe vs SIKA Pay

Source: public repo github.com/dav9fulldev/sika-agent, shallow clone of HEAD on 2026-10-31, read 2026-11-02.
We did not run their code. Their README claims are marked "claimed"; anything we checked in their source is marked "checked". We copied no code or design.

## Where SIKA is ahead (we will not chase these)
| Area | SIKA | SaySafe |
|---|---|---|
| PayPal surface | Orders v2, Vault, conditional authorisations, subscriptions, Agent Toolkit, MCP (claimed) | Orders v2 create/approve/capture, refund, webhooks. No vault, subscriptions or payouts in MVP by choice |
| Platforms | Flutter Android app + web dashboard + Cloud Run (claimed) | Responsive web app (works on phone browsers) |
| Test volume | 231 `def test_` in backend (checked; README says 242) + Flutter tests | 53 unit/HTTP tests + 11-step browser end-to-end + axe audit |
| Product search | Channel3 search and price alerts (claimed) | Small demo catalogue (simulated) |

## Where SaySafe is different (our three bets)
| Differentiator | SIKA | SaySafe |
|---|---|---|
| 1. Scam / fake-PayPal-support guardian | No scam, phishing or fraud module found. A grep for scam/phish/fraud in backend + mobile matched only a camera variable (checked) | Text, link, email, phone and screenshot checks; deterministic URL rules (look-alikes, punycode, `paypal.com.evil.net`, shorteners); curated official-PayPal directory; invoice/money-request scam rule; AI explanation in plain spoken English; never says "safe" |
| 2. Trusted family protection | No family / caregiver / guardian concept found (checked). Has a server spending limit and an agent-authorisation screen (claimed) | Paired family member with own login; per-household limit; approve/decline per exact item and price; expiry; audit history; server rejects bypass attempts (tested). Family never replaces the payer's own PayPal approval |
| 3. Elder-first UX | General consumer wallet UI, dark dashboard (checked in HTML templates) | Three-button home, 20px+ type, 48px+ targets, AA/AAA contrast tokens, spoken replies with captions, bigger-text and high-contrast toggles; axe: 0 violations on 6 screens |

## Risks for us
- Judges may reward API breadth. Answer: depth on safety + a memorable demo, and say clearly what is real.
- Devpost inspiration list names "simpler checkout for seniors", so other elder entries are likely.
- Our PayPal buyer approval on PayPal's own page is not yet recorded end to end (needs a sandbox personal buyer login).

## What is real vs simulated (SaySafe, 2026-11-02)
- Real: PayPal sandbox OAuth, order create, redirect to PayPal sandbox approval page (browser-tested), capture (verified with sandbox test card via API), Groq text AI, server-side approvals.
- Not yet verified live: buyer login on PayPal's page, webhooks (needs deployed URL), screenshot vision model, microphone in a real browser, refund.
- Simulated: product catalogue, shop name, money (sandbox only). PhishTank / Web Risk: code path present only if keys are set; not active in demo.
