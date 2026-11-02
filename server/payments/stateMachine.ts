export const STATES = [
  'DRAFT', 'RISK_REVIEW', 'BLOCKED', 'FAMILY_APPROVAL_PENDING', 'FAMILY_APPROVED',
  'PAYER_APPROVAL_PENDING', 'PAYER_APPROVED', 'CAPTURE_PENDING', 'CAPTURED', 'FAILED', 'CANCELLED', 'REFUNDED',
] as const;
export type PaymentState = (typeof STATES)[number];

/** The only legal transitions. Anything else throws. */
export const TRANSITIONS: Record<PaymentState, PaymentState[]> = {
  DRAFT: ['RISK_REVIEW', 'CANCELLED'],
  RISK_REVIEW: ['BLOCKED', 'FAMILY_APPROVAL_PENDING', 'PAYER_APPROVAL_PENDING', 'CANCELLED'],
  BLOCKED: [],
  FAMILY_APPROVAL_PENDING: ['FAMILY_APPROVED', 'CANCELLED'],
  FAMILY_APPROVED: ['PAYER_APPROVAL_PENDING', 'CANCELLED'],
  PAYER_APPROVAL_PENDING: ['PAYER_APPROVED', 'CANCELLED', 'FAILED'],
  PAYER_APPROVED: ['CAPTURE_PENDING', 'CANCELLED'],
  CAPTURE_PENDING: ['CAPTURED', 'FAILED'],
  CAPTURED: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export class TransitionError extends Error {
  constructor(public from: string, public to: string) {
    super(`Illegal payment transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: PaymentState, to: PaymentState) {
  if (!TRANSITIONS[from]?.includes(to)) throw new TransitionError(from, to);
}

export const TERMINAL: PaymentState[] = ['BLOCKED', 'FAILED', 'CANCELLED', 'REFUNDED'];
