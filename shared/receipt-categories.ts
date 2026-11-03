/**
 * shared/receipt-categories.ts
 *
 * The category each receipt item is proposed under: a second, text-only call
 * to the same model (docs/superpowers/specs/2026-10-29-receipt-reader-design.md).
 * The JSON schema lists the person's category keys as an enum, so every answer
 * is a real category, and asks for exactly one answer per item, in order.
 *
 * Items the person filed before are not asked about: `rememberedCategory`
 * answers them from earlier confirmations, so a correction sticks. The model
 * sees those confirmations too, as examples of how this person files things.
 *
 * Nothing here files anything: the bot shows the proposal and the person
 * confirms or changes it.
 */

/** A spending category the model may choose. */
export interface CategoryChoice {
  id: string;
  /** Stable key, e.g. "groceries"; what the model answers with. */
  key: string;
  /** Full path, e.g. "Food & Dining / Groceries"; what the model reads. */
  path: string;
}

/** An item the person confirmed under a category on an earlier receipt. */
export interface ItemFiling {
  text: string;
  categoryId: string;
}

/** How many earlier confirmations the prompt shows. */
export const CATEGORY_EXAMPLES_LIMIT = 40;

/** Item text compared without case, spacing or punctuation. */
export const itemKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The category this item was last confirmed under, if any (filings newest last). */
export function rememberedCategory(text: string, filings: readonly ItemFiling[]): string | null {
  const key = itemKey(text);
  for (let i = filings.length - 1; i >= 0; i--) if (itemKey(filings[i].text) === key) return filings[i].categoryId;
  return null;
}

export function categorySchema(choices: readonly CategoryChoice[], count: number) {
  return {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: { type: 'string', enum: choices.map((c) => c.key) },
      },
    },
    required: ['categories'],
  };
}

export function categoryPrompt(
  store: string, items: readonly string[], choices: readonly CategoryChoice[], filings: readonly ItemFiling[],
): string {
  const pathOf = new Map(choices.map((c) => [c.id, c.path]));
  const examples = filings
    .filter((f) => pathOf.has(f.categoryId))
    .slice(-CATEGORY_EXAMPLES_LIMIT)
    .map((f) => `- ${f.text} → ${pathOf.get(f.categoryId)}`);
  return [
    `These items were bought${store ? ` at ${store}` : ''}. Choose the spending category each one belongs in.`,
    'Store receipts abbreviate item names (for example ORG = organic): work out what each item is first.',
    'Prefer the most specific category that fits. Answer with one category key per item, in the same order as the items.',
    '',
    'Categories (key: path):',
    ...choices.map((c) => `- ${c.key}: ${c.path}`),
    ...(examples.length ? ['', 'How this person filed items before:', ...examples] : []),
    '',
    'Items:',
    ...items.map((text, n) => `${n + 1}. ${text}`),
  ].join('\n');
}

/** The request body for Ollama's /api/chat. */
export function categoryChatRequest(
  model: string, store: string, items: readonly string[], choices: readonly CategoryChoice[], filings: readonly ItemFiling[],
) {
  return {
    model,
    stream: false,
    format: categorySchema(choices, items.length),
    options: { temperature: 0 },
    messages: [{ role: 'user', content: categoryPrompt(store, items, choices, filings) }],
  };
}

/** The model's answer as category ids, one per item; null when it is not that. */
export function parseCategories(content: string, choices: readonly CategoryChoice[], count: number): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  const keys = (value as { categories?: unknown } | null)?.categories;
  if (!Array.isArray(keys) || keys.length !== count) return null;
  const idOf = new Map(choices.map((c) => [c.key, c.id]));
  const ids = keys.map((k) => (typeof k === 'string' ? idOf.get(k) : undefined));
  return ids.every((id): id is string => !!id) ? ids : null;
}
