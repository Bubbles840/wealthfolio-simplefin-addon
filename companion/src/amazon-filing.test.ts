import { describe, it, expect, vi } from 'vitest';
import { fileAmazonCharges, amazonLabelFromNote } from './amazon-filing.js';

const CATEGORIES = [
  { id: 'cat-health', name: 'Health & Wellness' },
  { id: 'cat-personal', name: 'Personal Care' },
  { id: 'cat-housing', name: 'Housing' },
  { id: 'cat-shopping', name: 'Shopping' },
];

function make(over: Partial<Parameters<typeof fileAmazonCharges>[0]> = {}) {
  const assigned: Array<[string, string]> = [];
  const deps = {
    uncategorized: vi.fn(async () => [] as Array<{ activityId: string; notes: string }>),
    categories: vi.fn(async () => CATEGORIES),
    readConfig: vi.fn(async () => ({} as any)),
    assign: vi.fn(async (a: string, c: string) => { assigned.push([a, c]); }),
    log: vi.fn(),
    ...over,
  };
  return { deps, assigned };
}

describe('amazonLabelFromNote', () => {
  it('reads the label out of an enriched note', () => {
    expect(amazonLabelFromNote('Amazon · Amazon: Skincare · TRN-abc')).toBe('Skincare');
  });

  it('returns null for a note with no Amazon label', () => {
    expect(amazonLabelFromNote('TRADER JOE S #628 · TRN-abc')).toBeNull();
  });

  it('refuses a MIXED order', () => {
    // One charge covering several categories has no honest single answer —
    // `amazonDescription` formats it so nothing can match, deliberately, and it
    // belongs in the needs-a-category sweep for a human to split.
    expect(amazonLabelFromNote('Amazon · Amazon: mixed — Tools + Groceries · TRN-x')).toBeNull();
  });
});

describe('fileAmazonCharges', () => {
  it('files a labelled charge under the category its label maps to', async () => {
    // The live case: three Amazon charges sat uncategorized while the addon
    // reported the category it "would" have used, because nothing ever
    // assigned it.
    const { deps, assigned } = make({
      uncategorized: vi.fn(async () => [
        { activityId: 'a1', notes: 'Amazon · Amazon: Skincare · TRN-1' },
        { activityId: 'a2', notes: 'Amazon · Amazon: Tools · TRN-2' },
      ]),
    });
    const res = await fileAmazonCharges(deps as any);
    expect(res.filed).toBe(2);
    expect(assigned).toEqual([['a1', 'cat-personal'], ['a2', 'cat-housing']]);
  });

  it('honours a user override ahead of the built-in rules', async () => {
    const { deps, assigned } = make({
      uncategorized: vi.fn(async () => [{ activityId: 'a1', notes: 'Amazon · Amazon: Tools · TRN-1' }]),
      readConfig: vi.fn(async () => ({ labelOverrides: { Tools: 'Shopping' } } as any)),
    });
    await fileAmazonCharges(deps as any);
    expect(assigned).toEqual([['a1', 'cat-shopping']]);
  });

  it('leaves a mixed-category order alone', async () => {
    const { deps, assigned } = make({
      uncategorized: vi.fn(async () => [
        { activityId: 'a1', notes: 'Amazon · Amazon: mixed — Tools + Groceries · TRN-1' },
      ]),
    });
    const res = await fileAmazonCharges(deps as any);
    expect(res.filed).toBe(0);
    expect(assigned).toEqual([]);
  });

  it('ignores rows that are not Amazon at all', async () => {
    const { deps, assigned } = make({
      uncategorized: vi.fn(async () => [{ activityId: 'a1', notes: 'CHILI\'S HURSTBOURNE · TRN-1' }]),
    });
    await fileAmazonCharges(deps as any);
    expect(assigned).toEqual([]);
  });

  it('leaves a label NO rule matched unfiled, and reports it', async () => {
    // The default is a guess. Filing on a guess buries it where nothing shows
    // it, destroying the "needs a rule" signal the Amazon card counts on — and
    // an uncategorised charge is at least visible.
    const { deps, assigned } = make({
      uncategorized: vi.fn(async () => [
        { activityId: 'a1', notes: 'Amazon · Amazon: Something Unusual · TRN-1' },
      ]),
    });
    const res = await fileAmazonCharges(deps as any);
    expect(assigned).toEqual([]);
    expect(res.filed).toBe(0);
    expect(res.needRule).toEqual(['Something Unusual']);
  });

  it('files an unmatched label once the user overrides it', async () => {
    // The override IS the rule — `resolveAmazonCategory` reports `matched` for
    // it — so the "Change: <label>" button in Telegram makes it file.
    const { deps, assigned } = make({
      uncategorized: vi.fn(async () => [
        { activityId: 'a1', notes: 'Amazon · Amazon: Something Unusual · TRN-1' },
      ]),
      readConfig: vi.fn(async () => ({ labelOverrides: { 'Something Unusual': 'Housing' } } as any)),
    });
    await fileAmazonCharges(deps as any);
    expect(assigned).toEqual([['a1', 'cat-housing']]);
  });

  it('reports a category this Wealthfolio does not have, instead of retrying it silently', async () => {
    const { deps, assigned } = make({
      uncategorized: vi.fn(async () => [{ activityId: 'a1', notes: 'Amazon · Amazon: Pet Supplies · TRN-1' }]),
      categories: vi.fn(async () => [{ id: 'cat-shopping', name: 'Shopping' }]),
      readConfig: vi.fn(async () => ({ labelOverrides: { 'Pet Supplies': 'Pet Care' } } as any)),
    });
    const res = await fileAmazonCharges(deps as any);
    expect(assigned).toEqual([]);
    expect(res.unknownCategories).toEqual(['Pet Care']);
  });

  it('matches a category name case-insensitively', async () => {
    const { deps, assigned } = make({
      uncategorized: vi.fn(async () => [{ activityId: 'a1', notes: 'Amazon · Amazon: Tools · TRN-1' }]),
      readConfig: vi.fn(async () => ({ labelOverrides: { Tools: 'housing' } } as any)),
    });
    await fileAmazonCharges(deps as any);
    expect(assigned).toEqual([['a1', 'cat-housing']]);
  });

  it('keeps filing the rest when one row is refused', async () => {
    const { deps } = make({
      uncategorized: vi.fn(async () => [
        { activityId: 'bad', notes: 'Amazon · Amazon: Tools · TRN-1' },
        { activityId: 'good', notes: 'Amazon · Amazon: Skincare · TRN-2' },
      ]),
      assign: vi.fn(async (id: string) => { if (id === 'bad') throw new Error('refused'); }),
    });
    const res = await fileAmazonCharges(deps as any);
    expect(res.filed).toBe(1);
  });

  it('never throws when the sweep itself fails', async () => {
    // It runs after a sync that already succeeded; a filing problem is not a
    // sync failure.
    const { deps } = make({ uncategorized: vi.fn(async () => { throw new Error('no database'); }) });
    await expect(fileAmazonCharges(deps as any)).resolves.toEqual({ filed: 0, unknownCategories: [], needRule: [] });
  });

  it('does nothing, and reads nothing, when no row carries a label', async () => {
    const { deps } = make({
      uncategorized: vi.fn(async () => [{ activityId: 'a1', notes: 'PANERA BREAD · TRN-1' }]),
    });
    await fileAmazonCharges(deps as any);
    expect(deps.categories).not.toHaveBeenCalled();
    expect(deps.readConfig).not.toHaveBeenCalled();
  });
});
