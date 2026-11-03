/**
 * Payment evidence: extra facts PayPal told us (its own timestamps, capture/refund ids) that the state
 * transition rows in audit_log do not carry. Stored in audit_log as `evidence.<kind>` rows, so there
 * is no new table. Duplicates (same kind, source, capture id and refund id) are ignored.
 * Never store payer name, email or address here.
 */
import { db, audit } from '../db/index.js';

export type EvidenceKind =
  | 'capture' | 'capture_verified' | 'buyer_approved' | 'reconcile_mismatch'
  | 'refund_completed' | 'refund_verified' | 'refund_mismatch';
export interface EvidenceDetail {
  /** payments-v2 = read back with GET /v2/payments/captures/{id} or GET /v2/payments/refunds/{id}. */
  source: 'capture_response' | 'reconcile' | 'paypal_webhook' | 'paypal_redirect' | 'payments-v2' | 'refund_response';
  captureId?: string | null;
  refundId?: string | null;
  status?: string | null;
  amount?: string | null;
  currency?: string | null;
  paypalTime?: string | null;
  note?: string;
}

const ACTOR: Record<EvidenceDetail['source'], string> = {
  paypal_webhook: 'paypal-webhook', reconcile: 'reconcile', capture_response: 'paypal', paypal_redirect: 'paypal',
  'payments-v2': 'paypal-v2', refund_response: 'paypal',
};

export function recordEvidence(r: { id: string; household_id: string }, kind: EvidenceKind, d: EvidenceDetail) {
  const rows = db.prepare('SELECT detail_json FROM audit_log WHERE target=? AND action=?').all(r.id, `evidence.${kind}`) as { detail_json: string | null }[];
  const dup = rows.some((x) => {
    try {
      const j = JSON.parse(x.detail_json ?? '{}');
      return j.source === d.source && (j.captureId ?? null) === (d.captureId ?? null) && (j.refundId ?? null) === (d.refundId ?? null) && (j.status ?? null) === (d.status ?? null);
    } catch { return false; }
  });
  if (dup) return false;
  audit(r.household_id, ACTOR[d.source], `evidence.${kind}`, r.id, d);
  return true;
}

export function evidenceRows(requestId: string, kind: EvidenceKind) {
  return (db.prepare('SELECT detail_json, at FROM audit_log WHERE target=? AND action=? ORDER BY id ASC').all(requestId, `evidence.${kind}`) as { detail_json: string | null; at: string }[])
    .map((x) => { try { return { ...JSON.parse(x.detail_json ?? '{}'), at: x.at } as EvidenceDetail & { at: string }; } catch { return null; } })
    .filter(Boolean) as (EvidenceDetail & { at: string })[];
}
