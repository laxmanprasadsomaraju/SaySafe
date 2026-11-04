/**
 * LeaveGuard: "Try as Alex too" on Mary's pending family-review card acknowledges the leave and navigates in the
 * same tick, before React re-renders. The blocker must read the acknowledgement at navigation time, so the
 * "Still waiting for your family member" dialog does not pop up for a leave the person chose on purpose.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const store = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};
const { leaveBlocker, acknowledgeLeave } = await import('../web/src/components/LeaveGuard');

const nav = { currentLocation: { pathname: '/assistant' }, nextLocation: { pathname: '/family/assistant' } };

describe('LeaveGuard', () => {
  beforeEach(() => store.clear());
  it('holds a leave while a family review is pending', () => {
    expect(leaveBlocker(true, 'req-1')(nav)).toBe(true);
  });
  it('after "Try as Alex too" acknowledges, the blocker built before the ack (same render) lets the leave through', () => {
    const shouldBlock = leaveBlocker(true, 'req-1'); // built during the render that showed the pending card
    acknowledgeLeave('req-1'); // TryAlexHere: acknowledge, then navigate without a re-render in between
    expect(shouldBlock(nav)).toBe(false);
  });
  it('the acknowledgement is per purchase and nothing else changes', () => {
    acknowledgeLeave('req-1');
    expect(leaveBlocker(true, 'req-2')(nav)).toBe(true);
    expect(leaveBlocker(false, 'req-2')(nav)).toBe(false);
    expect(leaveBlocker(true, 'req-2')({ currentLocation: { pathname: '/assistant' }, nextLocation: { pathname: '/assistant' } })).toBe(false);
  });
});
