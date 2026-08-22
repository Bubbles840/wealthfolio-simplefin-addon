/**
 * companion/src/amazon-filing.ts
 *
 * Filing an Amazon charge into the category its order label resolves to.
 *
 * The Amazon feature stopped one step short of what its name promises. A
 * matched charge gets its label written into the description (`… · Amazon:
 * Skincare`) and the label→category mapping is recorded and announced — but
 * nothing ever put a category on the transaction. The design assumed a
 * Wealthfolio categorisation rule would match that description, and nothing
 * creates those rules either, so a user with no hand-written rules watched
 * every Amazon charge land uncategorised while the addon reported the category
 * it "would" have used.
 *
 * `resolveAmazonCategory`'s own contract says otherwise — "Nothing is ever left
 * uncategorized" — so this closes the gap rather than adding a feature.
 *
 * Runs as a SWEEP over uncategorised rows rather than only over what a sync
 * just imported: charges stranded by the old behaviour are exactly the ones a
 * user wants fixed, and a charge whose order email arrives days after the
 * charge is only labelled on a later sync anyway.
 */
import { resolveAmazonCategory, type AmazonMailConfig } from '../../shared/amazon-config.js';

/** Pulls the label out of an enriched note. `amazonDescription` writes
 *  ` · Amazon: <label>` (single) or ` · Amazon: mixed — a + b` (several), and
 *  the note carries a ` · TRN-…` suffix after it. */
export function amazonLabelFromNote(note: string): string | null {
  const m = /·\s*Amazon:\s*([^·]+)/.exec(note);
  if (!m) return null;
  const label = m[1].trim();
  if (!label) return null;
  // A MIXED order is deliberately not filed. One charge covering $190 of
  // electronics and $10 of groceries has no honest single category, and
  // `amazonDescription` formats it precisely so that nothing can match it —
  // it belongs in the needs-a-category sweep for a human to split.
  if (/^mixed\b/i.test(label)) return null;
  return label;
}

export interface AmazonFilingDeps {
  /** Uncategorised rows in the window, as the notice's sweep already reads. */
  uncategorized(): Promise<Array<{ activityId: string; notes: string }>>;
  /** Every spending category, for name → id. */
  categories(): Promise<Array<{ id: string; name: string }>>;
  readConfig(): Promise<AmazonMailConfig | null>;
  assign(activityId: string, categoryId: string): Promise<void>;
  log(msg: string): void;
}

export interface AmazonFilingResult {
  filed: number;
  /** Labels whose resolved category does not exist in this Wealthfolio. */
  unknownCategories: string[];
}

/**
 * Files every uncategorised Amazon-labelled charge it can. Never throws: this
 * runs after a sync that has already succeeded, and a filing failure must not
 * be reported as a sync failure.
 */
export async function fileAmazonCharges(deps: AmazonFilingDeps): Promise<AmazonFilingResult> {
  const result: AmazonFilingResult = { filed: 0, unknownCategories: [] };
  try {
    const rows = await deps.uncategorized();
    const labelled = rows
      .map((r) => ({ row: r, label: amazonLabelFromNote(r.notes) }))
      .filter((x): x is { row: typeof rows[number]; label: string } => x.label !== null);
    if (labelled.length === 0) return result;

    const cfg = (await deps.readConfig()) ?? {};
    const categories = await deps.categories();
    // Case-insensitive: the label rules and the user's overrides are written by
    // hand, and "personal care" should find "Personal Care" rather than
    // silently file nothing.
    const byName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));

    for (const { row, label } of labelled) {
      const { category } = resolveAmazonCategory(label, cfg);
      const categoryId = byName.get(category.trim().toLowerCase());
      if (!categoryId) {
        // A category the mapping names but this Wealthfolio does not have —
        // reported rather than retried silently every sync forever.
        if (!result.unknownCategories.includes(category)) result.unknownCategories.push(category);
        continue;
      }
      try {
        await deps.assign(row.activityId, categoryId);
        result.filed += 1;
      } catch (err) {
        // Per row: one refusal must not abandon the rest of the batch.
        deps.log(`Amazon filing: could not file ${row.activityId} under ${category}: ${String(err)}`);
      }
    }
  } catch (err) {
    deps.log(`Amazon filing sweep failed: ${String(err)}`);
  }
  return result;
}
