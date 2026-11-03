/**
 * Live bug (8bf88dd): "I want to buy a Nike t-shirt" said "I'll also look for it in real shops with Channel3" but only the
 * Demo Shop chips appeared. Root cause: speaking the first reply bumped the speech generation that was also used as
 * the turn token, so the Channel3 step of the same turn was dropped whenever spoken replies were on (speech.test.ts
 * covers the token). Here: the server never promises a search, hands the app the product to search, and the
 * "search real shops" variants are recognised (typed or spoken).
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.hoisted(() => { process.env.API_LIMIT_PER_MIN = '5000'; process.env.AI_SESSION_LIMIT_PER_MIN = '1000'; process.env.COMPANION_LIMIT_PER_MIN = '5000'; process.env.CHANNEL3_API_KEY = 'test-not-called'; });

import { createApp } from '../server/app';
import { realShopSearch, NOT_IN_DEMO_SPOKEN } from '../shared/realShops';

const app = createApp();
const H = { 'Content-Type': 'application/json' };

describe('"search real shops" variants (typed or spoken)', () => {
  it.each(['search real shops', 'Search real shops.', 'real shops', 'Real product search', 'search real products', 'Search the real shops please', 'look in real shops', 'ok, search real shops', 'real shops instead'])('%s → real-shop search (remembered product)', (t) => {
    expect(realShopSearch(t)).toEqual({ query: null });
  });
  it('a product after "for" is searched directly', () => {
    expect(realShopSearch('Search real shops for a Nike t-shirt')).toEqual({ query: 'nike t-shirt' });
    expect(realShopSearch('look in real shops for a kettle')).toEqual({ query: 'kettle' });
  });
  it.each(['I want to buy a microwave', 'What are real shops?', 'Did my payment go through?', 'Compare real shops for a kettle'])('not a bare real-shop search: %s', (t) => {
    expect(realShopSearch(t)).toBeNull();
  });
  it('the spoken line is the plain one', () => {
    expect(NOT_IN_DEMO_SPOKEN).toBe("That's not in the Demo Shop. Say 'search real shops' to find real products, or pick a demo item.");
  });
});

describe('server: a product that is not in the Demo Shop', () => {
  it.each(['I want to buy a Nike t-shirt', 'Help me buy a garden gnome', "I'd like to buy a yoga mat"])('%s → catalogue chips + the product to search, no promise', async (text) => {
    const a = request.agent(app);
    await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
    const r = (await a.post('/api/assistant').set(H).send({ text }).expect(200)).body;
    expect(r.intent.action).toBe('shop');
    expect(Array.isArray(r.catalogue) && r.catalogue.length > 0).toBe(true);
    expect(r.discover?.query).toBeTruthy(); // the app runs Channel3 for this BEFORE showing the chips
    expect(typeof r.realQuery).toBe('string');
    expect(r.realQuery.toLowerCase()).toContain(text.toLowerCase().match(/(t-shirt|gnome|yoga mat)/)![1]);
    expect(r.reply).toMatch(/^That's not in the Demo Shop\./);
    expect(r.reply).not.toMatch(/I'll also look|I will look|searching real shops/i); // never promises a search
    expect(r.reply).toMatch(/Say 'search real shops'/);
  });
});
