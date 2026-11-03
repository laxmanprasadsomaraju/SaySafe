/**
 * Restart simulation: the DB file is closed and reopened (fresh modules, fresh connection, empty
 * in-memory throttles), then reconcile recovers the truth from PayPal (a TEST DOUBLE here).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = vi.hoisted(() => {
  const f = `${process.env.TMPDIR ?? '/tmp'}/saysafe-restart-${process.pid}-${Date.now()}.db`;
  process.env.DATABASE_FILE = f;
  return f;
});

const orders = new Map<string, any>();
const pp = vi.hoisted(() => ({ loseCaptureResponse: false, getOrderFailures: 0 }));
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => { if (pp.getOrderFailures > 0) { pp.getOrderFailures--; throw new Error('ECONNRESET'); } return orders.get(id); }),
  captureOrder: vi.fn(async (id: string) => {
    const o = orders.get(id);
    if (o.status !== 'COMPLETED') {
      o.status = 'COMPLETED';
      o.purchase_units[0].payments = { captures: [{ id: 'CAP' + id, status: 'COMPLETED', amount: o.purchase_units[0].amount, create_time: '2026-11-03T00:20:00Z' }] };
    }
    if (pp.loseCaptureResponse) { pp.loseCaptureResponse = false; pp.getOrderFailures = 1; throw new Error('socket hang up'); }
    return o;
  }),
  // Payments v2 GET capture: the capture as PayPal holds it on the order (with custom_id + order link, like the real API).
  getCapture: vi.fn(async (capId: string) => {
    for (const o of orders.values()) {
      const c = o.purchase_units?.[0]?.payments?.captures?.find((x: any) => x.id === capId);
      if (c) return { ...c, custom_id: o.purchase_units[0].custom_id, supplementary_data: { related_ids: { order_id: o.id } } };
    }
    const e: any = new Error('RESOURCE_NOT_FOUND'); e.status = 404; throw e;
  }),
  refundCapture: vi.fn(async () => ({ status: 'COMPLETED' })),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: (o: any) => o.links[0].href,
}));

describe('server restart (DB file closed and reopened)', () => {
  it('recovers a capture whose response was lost, and a buyer approval whose redirect was lost, from PayPal after reopening', async () => {
    expect(file).not.toBe(':memory:');
    const { db } = await import('../server/db/index');
    const pay = await import('../server/payments/service');
    const hh = 'hh_restart', u = 'usr_restart';
    db.prepare("INSERT INTO users (id,name,role) VALUES (?,?,'elder')").run(u, 'Mary');
    db.prepare('INSERT INTO households (id, elder_id) VALUES (?,?)').run(hh, u);
    db.prepare('INSERT INTO spending_policies (household_id, approval_threshold_cents) VALUES (?,?)').run(hh, 7500);

    const a = await pay.createRequest(hh, u, [{ productId: 'kettle-classic', quantity: 1 }], 'restart-key-a1', 'http://localhost');
    const oidA = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(a.request.id) as any).o;
    orders.get(oidA).status = 'APPROVED';
    pp.loseCaptureResponse = true;
    await expect(pay.confirmAndCapture(hh, u, a.request.id, oidA)).rejects.toThrow(/not answered yet/);

    const b = await pay.createRequest(hh, u, [{ productId: 'toaster', quantity: 1 }], 'restart-key-b1', 'http://localhost');
    const oidB = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(b.request.id) as any).o;
    orders.get(oidB).status = 'APPROVED'; // buyer approved at PayPal; the redirect back never arrived

    expect(fs.existsSync(file)).toBe(true); // a real file, not :memory:
    db.close(); // "restart"
    vi.resetModules();

    const db2 = (await import('../server/db/index')).db;
    const { reconcile } = await import('../server/payments/reconcile');
    const client = await import('../server/paypal/client');
    expect((db2.prepare('SELECT state FROM payment_requests WHERE id=?').get(a.request.id) as any).state).toBe('CAPTURE_PENDING');
    expect(await reconcile(a.request.id)).toEqual({ outcome: 'captured', state: 'CAPTURED' });
    expect(await reconcile(b.request.id)).toEqual({ outcome: 'buyer_approved', state: 'PAYER_APPROVED' });
    expect((client.captureOrder as any).mock.calls.filter((c: any[]) => c[0] === oidB).length).toBe(0);
    expect((client.captureOrder as any).mock.calls.filter((c: any[]) => c[0] === oidA).length).toBe(1);
    db2.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    void os; void path;
  });
});
