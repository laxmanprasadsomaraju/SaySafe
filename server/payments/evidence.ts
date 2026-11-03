/**
 * Payment evidence: extra facts PayPal told us (its own timestamps, capture ids) that the state
 * transition rows in audit_log do not carry. Stored in audit_log as `evidence.<kind>` rows, so there
 * is no new table. Duplicates (same kind, request and capture id) are ignored.
 * Never store payer name, email or address here.
 */
import { db, audit } from '../db/index.js';

export type EvidenceKind = 'capture' | 'buyer_approved' | 'reconcile_mismatch';
export interface EvidenceDetail {
  source: 'capture_response' | 'reconcile' | 'paypal_webhook' | 'paypal_redirect';
  captureId?: string | null;
  amount?: string | null;
  currency?: string | null;
  paypalTime?: string | null;
  note?: string;
}

export function recordEvidence(r: { id: string; household_id: string }, kind: EvidenceKind, d: EvidenceDetail) {
  const rows = db.prepare('SELECT detail_json FROM audit_log WHERE target=? AND action=?').all(r.id, `evidence.${kind}`) as { detail_json: string | null }[];
  const dup = rows.some((x) => {
    try { const j = JSON.parse(x.detail_json ?? '{}'); return j.source === d.source && (j.captureId ?? null) === (d.captureId ?? null); } catch { return false; }
  });
  if (dup) return false;
  audit(r.household_id, d.source === 'paypal_webhook' ? 'paypal-webhook' : d.source === 'reconcile' ? 'reconcile' : 'paypal', `evidence.${kind}`, r.id, d);
  return true;
}
