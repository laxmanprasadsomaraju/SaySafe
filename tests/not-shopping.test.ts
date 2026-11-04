import { describe, it, expect } from 'vitest';
import { routeAssistant } from '../server/assistant/route';
import { looksLikeProductSearch } from '../server/assistant/shopping';
import { runTool } from '../server/assistant/tools';

describe('account questions are never product searches', () => {
  const balance = ['I want to check my account balance.', 'What is my balance?', "What's my PayPal balance", 'How much money do I have in my account?', 'show me my bank balance', 'how much money do i have'];
  it.each(balance)('%s → account_balance, not Channel3', (q) => {
    expect(routeAssistant(q)?.tool).toBe('account_balance');
    expect(looksLikeProductSearch(q)).toBe(false);
  });
  const tasks = ['I want to change my password', 'I need to talk to someone', 'I want to cancel my order', 'can you check my last payment', 'I want to report a scam', 'help me sign in', 'I want to update my profile'];
  it.each(tasks)('%s is not a product search', (q) => expect(looksLikeProductSearch(q)).toBe(false));
  const products = ['find a kettle', 'Show me women\'s Nike T-shirts', 'I want to buy a PS5 for my grandson', 'I want a set of knives', 'I need a microwave under €150', 'find me a new balance trainer'];
  it.each(products)('%s is still a product search', (q) => expect(looksLikeProductSearch(q)).toBe(true));
  it('New Balance trainers are not a balance question', () => expect(routeAssistant('show me new balance trainers')?.tool).not.toBe('account_balance'));
  it('balance reply says SaySafe cannot see it and never invents a figure', async () => {
    const r = await runTool('account_balance', {}, null);
    expect(r.reply).toMatch(/can't see your bank or PayPal balance/);
    expect(r.reply).not.toMatch(/€\s?\d/);
  });
});
