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

## Payments v2 capture check — `server/payments/captureCheck.ts`

`GET /v2/payments/captures/{id}` (`getCapture` in `server/paypal/client.ts`) is the authority on the money once an
order is `COMPLETED`. It is read:

- by **reconcile** after the order reads `COMPLETED`: the capture id, `custom_id`, order link, amount and currency
  must match the local record. `COMPLETED` → `CAPTURED`; `PENDING` → stays `CAPTURE_PENDING`; `REFUNDED` →
  `CAPTURED` then `REFUNDED`; unreachable → `unknown` (nothing changes); any difference → `mismatch`.
- by the **receipt** (`GET /api/payments/:id`) for a captured payment with no Payments v2 evidence yet (3 s bounded,
  at most once a minute per payment). If PayPal shows the capture `REFUNDED`, the record follows PayPal.
- by the **admin refund**, before any money moves.

Each read records `evidence.capture_verified` (source `payments-v2`), shown on the timeline as
"Capture checked with PayPal".

## Refunds — `server/payments/refund.ts`

Full refunds of **Demo Shop** captures only. Partial refunds are **not supported** (a smaller `amount` is
rejected with `partial_refund_unsupported`; a capture PayPal shows as `PARTIALLY_REFUNDED` is left for manual review).

| Who | Can | Route |
|---|---|---|
| Elder (buyer) | **Request** a refund. Records `REFUND_REQUESTED` in `refund_requests`; the payment stays `CAPTURED`; the UI says "Request sent — not refunded yet". Never calls PayPal. | `POST /api/payments/:id/refund-request` |
| Family member | Nothing (the old `/api/family/requests/:id/refund` was removed) | — |
| Merchant admin | Execute a full refund | `POST /api/admin/payments/:id/refund` |

Merchant admin = the `ADMIN_TOKEN` env var (at least 24 characters), sent as the `X-Admin-Token` header and compared
in constant time (SHA-256 of both sides + `timingSafeEqual`). Missing header → 401, wrong token → 403. With
`ADMIN_TOKEN` unset (or too short) every admin route answers **503 "Refunds not enabled"**. 10 requests/min per IP.

### Checks before PayPal is called

1. Payment exists (optional `householdId` in the body must match → else 404), merchant is the Demo Shop.
2. State is `CAPTURED` (already `REFUNDED` → 200 with the stored result, `duplicate: true`, no PayPal call).
3. Stored capture amount/currency equal the approved amount; optional `captureId` in the body equals the record.
4. `GET /v2/payments/captures/{id}`: same capture id, `custom_id`, order, amount, currency, status `COMPLETED`.
   PayPal already shows `REFUNDED` → 409 `already_refunded` (record moved to `REFUNDED`, no POST).
5. In ONE DB transaction: the `refunds` row is written with `paypal_request_id = refund-{paymentId}-{attempt}` and
   the state moves `CAPTURED → REFUND_PENDING`. Only then is `POST /v2/payments/captures/{id}/refund` sent with
   that `PayPal-Request-Id` (body: `custom_id` = payment id, `note_to_payer`; no amount = full).

### Outcomes

| PayPal | Local result | HTTP |
|---|---|---|
| 201 `COMPLETED`, id/amount/currency/custom_id/`up` capture link match | `REFUNDED`; then `GET /v2/payments/refunds/{id}` records `refund_verified` | 200 |
| 201 `PENDING` | stays `REFUND_PENDING` (reconcile resolves via GET refund) | 202 |
| 4xx (e.g. `REFUND_NOT_ALLOWED`) | refund row `FAILED`, state back to `CAPTURED`, error names PayPal's issue. A later retry uses attempt+1 (new key) | 422 |
| 422 `CAPTURE_FULLY_REFUNDED` | resolved by reading PayPal (GET capture) | 200/202 |
| timeout / network / 5xx | stays `REFUND_PENDING`, row `UNKNOWN` | 202 |

Concurrent duplicate calls in one process share one in-flight attempt (one PayPal call, same result). Across
processes the optimistic lock on `CAPTURED → REFUND_PENDING` lets only one through; a retry of a `REFUND_PENDING`
record re-sends the **same** stored `PayPal-Request-Id`, which PayPal answers with the original refund (verified live:
same key → same refund id `1M659057GE5643901`; a new key on that capture → 422 `CAPTURE_FULLY_REFUNDED`).

### Reconcile of `REFUND_PENDING` (read-only)

`reconcile()` (Order page "Check with PayPal", lazy sweep, or `POST /api/admin/payments/:id/reconcile`):
with a stored refund id → `GET /v2/payments/refunds/{id}` (`COMPLETED` → `REFUNDED`, `FAILED`/`CANCELLED` → `CAPTURED`);
without one (response lost) → `GET /v2/payments/captures/{id}` (`REFUNDED` → `REFUNDED`, `PARTIALLY_REFUNDED` →
`mismatch`, still `COMPLETED` → `pending`). Reconcile never sends a refund; the admin re-runs the refund call, which
reuses the stored key.

### Refund webhook

A signature-verified `PAYMENT.CAPTURE.REFUNDED` (resource = the refund) is correlated by refund id, then the capture
id from the refund's `up` link, then `custom_id`; any disagreement, a non-full amount or a non-`COMPLETED` status
changes nothing. It may arrive before our POST returns: it moves `REFUND_PENDING → REFUNDED` and the late response is
accepted without regressing. Events are deduplicated by event id (and a second distinct event → `already_refunded`).
The stored minimal payload now also keeps `capture_id` (from the `up` link).

### Timeline events

You asked for a refund (request only) → Refund requested from PayPal → Refund completed (PayPal refund response /
signed webhook / reconcile) → Refund checked with PayPal (Payments v2 GET refund, or GET capture shows REFUNDED) →
Signed PayPal refund notice received.

### Admin curl

```bash
export SAYSAFE=https://saysafe.onrender.com        # or http://localhost:8787
export ADMIN_TOKEN=...                              # the value set on Render
# look at a payment (state, refund execution row, timeline)
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" "$SAYSAFE/api/admin/payments/pay_XXXXXXXX" | jq '{state, refund, refundExecution}'
# full refund (amount optional; it must equal the full captured amount)
curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount":"32.00","currency":"EUR"}' "$SAYSAFE/api/admin/payments/pay_XXXXXXXX/refund" | jq '{status, outcome, refundId, duplicate, message}'
# resolve a REFUND_PENDING (read-only at PayPal)
curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{}' \
  "$SAYSAFE/api/admin/payments/pay_XXXXXXXX/reconcile" | jq '{outcome, state}'
```

### Live sandbox evidence (2026-11-03)

One existing sandbox capture was refunded directly through the PayPal API to record real shapes
(`tests/fixtures/paypal-refund-*.json`, `paypal-capture-*.json`; payer/payee e-mails stripped):
capture `7GW748197L509353B` (€32.00 EUR, custom_id `pay_kPyY4csvcw_9`) → refund `1M659057GE5643901`, `COMPLETED`,
€32.00 EUR; `GET /v2/payments/refunds/1M659057GE5643901` → `COMPLETED`; `GET` capture → `REFUNDED`.
