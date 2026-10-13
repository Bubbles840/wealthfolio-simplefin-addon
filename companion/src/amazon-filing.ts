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
 * `resolveAmazonCategory`'s own contract says the filing was always intended —
 * "Nothing is ever left uncategorized" — so this closes a gap rather than
 * adding a feature.
 *
 * With ONE deliberate departure from that sentence: a label no rule matched is
 * left unfiled. The rest of that contract explains why — such a label "is
 * reported once so it is one rule away from correct rather than silently
 * wrong" — and filing it under the default would destroy exactly that signal,
 * burying a mis-guessed category where nothing shows it. An uncategorised
 * charge is visible in the needs-a-category list; a wrongly filed one is not.
 *
 * Runs as a SWEEP over uncategorised rows rather than only over what a sync
 * just imported: charges stranded by the old behaviour are exactly the ones a
 * user wants fixed, and a charge whose order email arrives days after the
 * charge is only labelled on a later sync anyway.
 */
import { DEFAULT_AMAZON_CATEGORY, resolveAmazonCategory, type AmazonMailConfig } from '../../shared/amazon-config.js';
import { categoryFiledChange, type ChangeDraft } from '../../shared/change-entries.js';
import { descriptionFromComment, txIdFromComment } from '../../shared/sync-core.js';
import { accountTxKey } from '../../shared/transfers.js';

const SPENDING_TAXONOMY = 'spending_categories';

/** Pulls the label out of an enriched note. `amazonDescription` writes
 *  ` · Amazon: <label>` (single) or ` · Amazon: mixed — a + b` (several), and
 *  the note carries a ` · TRN-…` suffix after it. */
export function amazonLabelFromNote(note: string): string | null {
  const m = /·\s*Amazon:\s*([^·]+)/.exec(note);
  if (!m) return null;
  const label = m[1].trim();
  if (!label) return null;
  // A MIXED label comes back VERBATIM — `fileAmazonCharges` routes it to the
  // default category (the user's 2026-09-02 decision; it used to be swallowed
  // here so mixed orders stranded in the needs-a-category sweep forever).
  return label;
}

/** A row the filer may file. The optional fields describe it for the change
 *  log; `categoryId`/`categoryName` are the category a rule had given it. */
export interface AmazonFilingRow {
  activityId: string;
  notes: string;
  wfAccountId?: string;
  accountName?: string;
  /** Magnitude; `direction` carries the sign. */
  amountCents?: number;
  date?: string;
  direction?: 'in' | 'out';
  categoryId?: string;
  categoryName?: string;
}

export interface AmazonFilingDeps {
  /** Uncategorised rows in the window, as the notice's sweep already reads. */
  uncategorized(): Promise<AmazonFilingRow[]>;
  /**
   * Labelled Amazon rows whose spending category came from a categorization
   * RULE (assignment source "rule"). A rule runs on import, before the order
   * email arrives, so a broad one ("Amazon → Online Shopping") used to decide
   * every Amazon charge and the email's label never applied. Treated as a
   * fallback the label replaces. The filer's own assignment is "manual", which
   * rule re-runs never overwrite; a category the user chose is also "manual"
   * and never appears here.
   */
  ruleCategorized?(): Promise<AmazonFilingRow[]>;
  /** Every spending category, for name → id. */
  categories(): Promise<Array<{ id: string; name: string }>>;
  readConfig(): Promise<AmazonMailConfig | null>;
  assign(activityId: string, categoryId: string): Promise<void>;
  log(msg: string): void;
  /** The change log: one draft per filing Wealthfolio accepted. */
  record?(draft: ChangeDraft): void;
  /** The SimpleFin account behind a Wealthfolio one, for the entry's tx key. */
  sfinAccountOf?(wfAccountId: string): string | undefined;
  /** True when the person undid an automatic filing of this transaction
   *  (`noAutoFile`, shared/sync-overrides.ts): it is never filed again. */
  noAutoFile?(txKey: string): boolean;
  /** True when ANY `noAutoFile` override exists. A row whose tx key cannot be
   *  built (the account mapping could not be read) may then be one the person
   *  un-filed, so it is left alone this time. */
  anyNoAutoFile?: boolean;
}

export interface AmazonFilingResult {
  filed: number;
  /** Labels whose resolved category does not exist in this Wealthfolio. */
  unknownCategories: string[];
  /** Labels no rule matched, left unfiled on purpose — see below. */
  needRule: string[];
}

/**
 * Files every uncategorised Amazon-labelled charge it can. Never throws: this
 * runs after a sync that has already succeeded, and a filing failure must not
 * be reported as a sync failure.
 */
export async function fileAmazonCharges(deps: AmazonFilingDeps): Promise<AmazonFilingResult> {
  const result: AmazonFilingResult = { filed: 0, unknownCategories: [], needRule: [] };
  try {
    const seen = new Set<string>();
    const rows = [...(await deps.uncategorized()), ...((await deps.ruleCategorized?.()) ?? [])]
      .filter((r) => !seen.has(r.activityId) && seen.add(r.activityId));
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
    const nameOf = new Map(categories.map((c) => [c.id, c.name]));
    /** The change-log entry for a filing that just landed: what it was filed
     *  under before (a rule's choice, or nothing) and what it is now. A failed
     *  recording never touches the filing. */
    const recordFiling = (row: AmazonFilingRow, label: string, categoryId: string) => {
      if (!deps.record) return;
      try {
        const sfinId = row.wfAccountId ? deps.sfinAccountOf?.(row.wfAccountId) : undefined;
        const txId = txIdFromComment(row.notes);
        deps.record(categoryFiledChange({
          actor: 'auto',
          ...(row.wfAccountId ? { account: { ...(sfinId ? { sfinId } : {}), wfId: row.wfAccountId, name: row.accountName ?? '' } } : {}),
          ...(sfinId && txId ? { txKey: accountTxKey(sfinId, txId) } : {}),
          activityId: row.activityId,
          // The bank's own words: the label is the entry's `why`.
          description: descriptionFromComment(row.notes).split(' · Amazon: ')[0],
          ...(row.amountCents !== undefined ? { amountCents: row.direction === 'in' ? row.amountCents : -row.amountCents } : {}),
          ...(row.date ? { date: row.date } : {}),
          before: row.categoryId ? { categoryId: row.categoryId, categoryName: row.categoryName ?? '', taxonomyId: SPENDING_TAXONOMY } : null,
          after: { categoryId, categoryName: nameOf.get(categoryId) ?? '', taxonomyId: SPENDING_TAXONOMY },
          why: `Amazon: ${label}`,
        }));
      } catch (err) {
        deps.log(`Amazon filing: could not record the change for ${row.activityId}: ${String(err)}`);
      }
    };

    for (const { row, label } of labelled) {
      // Undone by the person: left exactly as they put it back. Without a tx
      // key there is no telling, so while any filing is undone it waits.
      const sfinId = row.wfAccountId ? deps.sfinAccountOf?.(row.wfAccountId) : undefined;
      const txId = txIdFromComment(row.notes);
      if (sfinId && txId ? deps.noAutoFile?.(accountTxKey(sfinId, txId)) : deps.anyNoAutoFile) continue;
      // A MIXED order goes straight to the configured default: one charge
      // covering several categories has no honest single label, no rule can
      // ever match it (so `needRule` nagging would be permanent), and leaving
      // it stranded meant hand-filing every mixed order forever. The default
      // category is the user's own knob for exactly this kind of judgment call.
      if (/^mixed\b/i.test(label)) {
        const fallback = cfg.defaultCategory || DEFAULT_AMAZON_CATEGORY;
        const fallbackId = byName.get(fallback.trim().toLowerCase());
        if (!fallbackId) {
          if (!result.unknownCategories.includes(fallback)) result.unknownCategories.push(fallback);
          continue;
        }
        try {
          await deps.assign(row.activityId, fallbackId);
          result.filed += 1;
          recordFiling(row, label, fallbackId);
        } catch (err) {
          deps.log(`Amazon filing: could not file mixed order ${row.activityId} under ${fallback}: ${String(err)}`);
        }
        continue;
      }
      const { category, matched } = resolveAmazonCategory(label, cfg);
      // A label NO rule matched only landed in the default category, and the
      // whole point of `matched` is that such a label stays visible — the
      // Amazon card counts them as "need a rule" and the notice reports each
      // one once. Filing it anyway would bury a label the user wanted
      // elsewhere under Shopping, silently, which is the opposite of what that
      // signal exists for. Reported instead, and left for the user or for the
      // "Change: <label>" button to decide.
      if (!matched) {
        if (!result.needRule.includes(label)) result.needRule.push(label);
        continue;
      }
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
        recordFiling(row, label, categoryId);
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
