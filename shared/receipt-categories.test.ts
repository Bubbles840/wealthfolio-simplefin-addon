import { describe, it, expect } from 'vitest';
import {
  CATEGORY_EXAMPLES_LIMIT, categoryChatRequest, categoryPrompt, itemKey, parseCategories, rememberedCategory,
  type CategoryChoice, type ItemFiling,
} from './receipt-categories.js';

const CHOICES: CategoryChoice[] = [
  { id: 'cat-gro', key: 'groceries', path: 'Groceries' },
  { id: 'cat-home', key: 'shopping_home', path: 'Shopping / Home Goods' },
];

describe('rememberedCategory', () => {
  it('answers from the newest confirmation of the same item, ignoring case and punctuation', () => {
    const filings: ItemFiling[] = [{ text: 'ORG CARROTS', categoryId: 'cat-home' }, { text: 'Org. Carrots', categoryId: 'cat-gro' }];
    expect(rememberedCategory('org carrots', filings)).toBe('cat-gro');
    expect(rememberedCategory('KALE', filings)).toBeNull();
    expect(itemKey('  ORG OAT-BR ')).toBe('org oat br');
  });
});

describe('the request', () => {
  it('asks for exactly one known key per item', () => {
    const body = categoryChatRequest('m', 'Corner Market', ['BREAD', 'LAMP'], CHOICES, []);
    expect(body.format.properties.categories).toMatchObject({ minItems: 2, maxItems: 2, items: { enum: ['groceries', 'shopping_home'] } });
    expect(body.messages[0].content).toContain('1. BREAD\n2. LAMP');
  });

  it('shows the newest earlier confirmations as examples, and only for categories still offered', () => {
    const filings: ItemFiling[] = [
      ...Array.from({ length: CATEGORY_EXAMPLES_LIMIT + 2 }, (_, n) => ({ text: `ITEM ${n}`, categoryId: 'cat-gro' })),
      { text: 'OLD CATEGORY', categoryId: 'cat-gone' },
    ];
    const prompt = categoryPrompt('', ['X'], CHOICES, filings);
    expect(prompt).toContain(`- ITEM ${CATEGORY_EXAMPLES_LIMIT + 1} → Groceries`);
    expect(prompt).not.toContain('- ITEM 1 →');
    expect(prompt).not.toContain('OLD CATEGORY');
    expect(prompt).toMatch(/^These items were bought\. /);
  });
});

describe('parseCategories', () => {
  it('maps keys to category ids', () => {
    expect(parseCategories('{"categories":["shopping_home","groceries"]}', CHOICES, 2)).toEqual(['cat-home', 'cat-gro']);
  });

  it('refuses a wrong count, an unknown key or a broken answer', () => {
    expect(parseCategories('{"categories":["groceries"]}', CHOICES, 2)).toBeNull();
    expect(parseCategories('{"categories":["groceries","toys"]}', CHOICES, 2)).toBeNull();
    expect(parseCategories('not json', CHOICES, 1)).toBeNull();
  });
});
