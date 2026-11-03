# Payment recovery and evidence

PayPal is the source of truth. SaySafe recovers from a lost redirect, a lost webhook, a lost capture response and
a server restart by **reading** the PayPal order. Recovery never captures on its own.

## reconcile(requestId) — `server/payments/reconcile.ts`

Applies to local records in `PAYER_APPROVAL_PENDING`, `PAYER_APPROVED` or `CAPTURE_PENDING` that have a
`paypal_order_id`. It calls `GET /v2/checkout/orders/:id` and:

| PayPal says | Local effect | Outcome |
|---|---|---|
| `COMPLETED`, capture `COMPLETED`, custom_id + amount + currency match | step to `CAPTURED` (actor `reconcile`), capture id/amount stored | `captured` |
| `COMPLETED`, capture `PENDING` | `CAPTURE_PENDING` (money in flight) | `pending` |
| `COMPLETED` or `APPROVED` with a different custom_id / amount / currency | nothing; `evidence.reconcile_mismatch` audit row | `mismatch` |
| `APPROVED` and local is `PAYER_APPROVAL_PENDING` | `PAYER_APPROVED` (buyer approved). **No capture.** | `buyer_approved` |
| `VOIDED` | `CANCELLED`, pending approvals invalidated | `cancelled` |
| 404, record older than 3 h and not `CAPTURE_PENDING` | `CANCELLED` (order expired at PayPal) | `cancelled` |
| `CREATED` / `PAYER_ACTION_REQUIRED` / `SAVED` | nothing | `pending` |
| network error, timeout, 5xx, recent 404 | **nothing** | `unknown` |

Capture after `buyer_approved` happens only when the user taps **Finish payment**
(`POST /api/payments/:id/finish` → `confirmAndCapture`), which repeats every check: order id, custom_id, amount,
currency, PayPal status and family approval. Retries reuse `PayPal-Request-Id: capture-{id}`, so PayPal cannot
capture twice.

A missing local record never triggers anything: `reconcile` throws `not_found`, and `/checkout/return`
without a session (`ReturnGate`) stays read-only via `GET /api/paypal/orders/:orderId/status`.

## When it runs

- **Order page** (`/order/:id`): on load for unfinished payments (this is also the lost-redirect path: opening
  the page directly works), from the **Check with PayPal** button, and every 6 s while `CAPTURE_PENDING`.
  Server throttle: one PayPal read per request per 5 s, plus a 10/min per-IP limiter on the route.
- **Lazy sweep**: `GET /api/payments` (elder home) and `GET /api/family/overview` (family dashboard) reconcile the
  household's pending records untouched for 2+ minutes. At most once a minute per household, 5 records per sweep,
  bounded to a 4 s wait so the dashboard always loads.

### Optional free scheduled trigger (not built)

Not needed for correctness. If wanted, a free GitHub Actions `schedule:` workflow could call a token-protected
sweep endpoint every 15 minutes. That endpoint does not exist on this branch: adding it means a new `SWEEP_TOKEN`
env var and a route that sweeps stale records across households. Note Render Free sleeps when idle and its
SQLite file is wiped on restart, so a cron mainly helps a persistent DB. No paid cron is used.

## Lost webhook

Reconcile (or the capture response) establishes capture truth. The receipt says
"Checked directly with PayPal. Signed PayPal notice not received yet." until a signature-verified
`PAYMENT.CAPTURE.COMPLETED` for that capture id is stored.

## Evidence timeline — `server/payments/timeline.ts`

Returned as `timeline` on `GET /api/payments/:id` and `POST /api/payments/:id/reconcile`, labelled
**"PayPal Sandbox — no real money"**. No new table: built from `audit_log` transitions, `audit_log` `evidence.*`
rows (PayPal's own timestamps) and `webhook_events`.

| Event | Source | Verification |
|---|---|---|
| Order created | SaySafe server · PayPal order `ABCD…WXYZ` (truncated) | amount and items from the catalogue |
| Buyer approved at PayPal | PayPal redirect, or Checked with PayPal (reconcile) | order status APPROVED read from PayPal's API; amount and currency matched |
| Payment captured | PayPal capture response / reconcile / signed webhook | amount and currency matched |
| Signed PayPal notice received | PayPal webhook | signature verified with verify-webhook-signature |

Out-of-order arrival (webhook before capture response) does not regress state: the service accepts the capture
already recorded with the same capture id instead of failing with a conflict. Events keep PayPal's causal order
(created → approved → captured → notice) regardless of arrival order; duplicates collapse to one.

## Webhook storage and PII

Only signature-verified events are stored, deduplicated by event id. The stored payload is reduced to:
`id, event_type, resource_type, resource_id, status, amount, currency, custom_id, order_id, create_time,
resource_create_time`. Payer name, email and address are not kept. Older rows written before this change may
still hold full payloads (`payload_json`); a one-off cleanup was not run.

## Tests

`tests/payment-recovery.test.ts`, `tests/payment-restart.test.ts` (DB file closed and reopened).
