/**
 * UI components rendered to static HTML (no browser): the Profile family-circle states (an error is an error with
 * Retry, never a silent blank or an endless "Loading…"), and WCAG 2.5.3 "label in name" on the product buttons
 * (axe label-content-name-mismatch): a product button's accessible name must contain its visible text.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { FamilyCircleBody, FamilySharingBody } from '../web/src/pages/Profile';
import { REGISTRY } from '../web/src/assistant/blocks';

const render = (el: any) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<span class="sr-only">.*?<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

describe('Profile › Trusted family circle', () => {
  it('shows an explicit error with a Retry button when /api/family/status fails', () => {
    const onRetry = vi.fn();
    const html = render(h(FamilyCircleBody, { circle: null, error: 'Server unavailable', onRetry }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="family-circle-error"');
    expect(text(html)).toMatch(/Couldn’t load your family circle: Server unavailable/);
    expect(text(html)).toMatch(/not an empty circle/);
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(html).not.toContain('Loading…');
  });
  it('Retry calls the loader again', () => {
    const onRetry = vi.fn();
    const el = FamilyCircleBody({ circle: null, error: 'x', onRetry }) as any;
    const btn = (el.props.children as any[]).find((c: any) => c?.type === 'button');
    btn.props.onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it('loading is a status, and a loaded circle shows members and the review limit', () => {
    expect(render(h(FamilyCircleBody, { circle: null, error: null, onRetry: () => {} }))).toContain('role="status"');
    const html = render(h(FamilyCircleBody, { circle: { active: [{ name: 'Alex' }], pendingInvites: 1, policy: { thresholdCents: 7500 } }, error: null, onRetry: () => {} }));
    expect(text(html)).toMatch(/Connected: Alex/);
    expect(text(html)).toMatch(/Above €75\.00 they review first\. They see only those purchases\. 1 unused invite code\./);
    expect(html).not.toContain('role="alert"');
  });
  it('Family sharing: both switches start Off, with plain copy, and Mary\'s own limit control', () => {
    const html = render(h(FamilySharingBody, { circle: { active: [{ name: 'Alex' }], pendingInvites: 0, policy: { thresholdCents: 7500 }, sharing: { shareSummaries: false, shareHistory: false } }, onChange: () => {} }));
    const t = text(html);
    expect(t).toMatch(/Alex only sees purchases that need their OK\. Turn these on if you want them to see more\./);
    expect(t).toMatch(/Share spending summaries with Alex/);
    expect(t).toMatch(/Share my purchase history with Alex/);
    expect((html.match(/role="switch" aria-checked="false"/g) ?? []).length).toBe(2);
    expect(t).toMatch(/Only you can change this\./);
    // No sharing info from the server (older server) -> still Off, never assumed On.
    const html2 = render(h(FamilySharingBody, { circle: { active: [], pendingInvites: 0, policy: { thresholdCents: 7500 } }, onChange: () => {} }));
    expect((html2.match(/aria-checked="true"/g) ?? []).length).toBe(0);
  });
});

describe('Product buttons: accessible name contains the visible label (WCAG 2.5.3)', () => {
  const item = (id: string, title: string, price: number, role?: 'best' | 'cheaper') => ({
    id, title, brand: null, image: null, imageAlt: title, features: [], price, compareAt: null, currency: 'EUR', retailer: 'SaySafe Demo Shop', url: null, availability: 'InStock' as const, productId: id, role,
  });
  const act: any = { openItem: () => {}, compare: () => {} };
  const html = render(h(REGISTRY.product_cards as any, { b: { kind: 'product_cards', source: 'demo', items: [item('microwave', 'Simple Dial Microwave 20L', 120, 'best'), item('toaster', 'Wide-Slot Toaster', 29, 'cheaper')] }, act }));
  const buttons = [...html.matchAll(/<li><button([^>]*)>(.*?)<\/button><\/li>/g)];

  it('renders one button per product', () => { expect(buttons).toHaveLength(2); });
  it('no aria-label overrides the visible text, so the name is the visible text itself (incl. "Best match")', () => {
    for (const [, attrs] of buttons) { expect(attrs).not.toMatch(/aria-label=/); expect(attrs).not.toMatch(/aria-labelledby=/); }
    const first = text(buttons[0][2]);
    expect(first).toMatch(/^Best match Simple Dial Microwave 20L SaySafe Demo Shop €120\.00/);
  });
  it("every button/link aria-label in the card contains its visible text (the rule covers widgets only)", () => {
    for (const m of html.matchAll(/<(button|a)([^>]*aria-label="([^"]*)"[^>]*)>(.*?)<\/\1>/g)) {
      const visible = text(m[4]);
      if (visible) expect(m[3].toLowerCase()).toContain(visible.toLowerCase());
    }
  });
});
