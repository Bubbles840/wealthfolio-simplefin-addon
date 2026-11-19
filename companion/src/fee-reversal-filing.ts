/**
 * Files each fee reversal under the spending category of the fee it reverses
 * (#79). Written through the same assignment path as the Amazon and payback
 * filings (never source 'rule', so the story names the sync as the filer).
 * The leftover income category stays in place; Undo restores nothing but
 * takes the spending filing off and sets noAutoFile.
 */
import { categoryFiledChange, type ChangeDraft } from '../../shared/change-entries.js';
import { FEE_REVERSAL_FILING_WHY, planFeeReversalFilings } from '../../shared/fee-reversal.js';
import { txIdFromComment } from '../../shared/sync-core.js';
import { accountTxKey } from '../../shared/transfers.js';
import type { NativeFeeReversalRow } from './sqlite-native.js';

export interface FeeReversalFilingDeps {
  /** The last 90 days. */
  rows(): Promise<NativeFeeReversalRow[]>;
  /** Spending taxonomy. */
  assign(activityId: string, categoryId: string): Promise<void>;
  record(draft: ChangeDraft): void;
  sfinAccountOf(wfAccountId: string): string | undefined;
  noAutoFile(txKey: string): boolean;
  anyNoAutoFile: boolean;
  log(msg: string): void;
  /** YYYY-MM-DD. */
  today: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function fileFeeReversals(deps: FeeReversalFilingDeps): Promise<{ filed: number }> {
  let filed = 0;
  try {
    const filings = planFeeReversalFilings(await deps.rows(), deps.today);
    for (const { refund, category } of filings) {
      const sfinId = deps.sfinAccountOf(refund.wfAccountId);
      const txId = txIdFromComment(refund.notes);
      const txKey = sfinId && txId ? accountTxKey(sfinId, txId) : undefined;
      if (txKey ? deps.noAutoFile(txKey) : deps.anyNoAutoFile) continue;
      try {
        await deps.assign(refund.activityId, category.categoryId);
      } catch (e) {
        deps.log(`Fee reversal filing: could not file ${refund.activityId}: ${errText(e)}`);
        continue;
      }
      filed++;
      const income = refund.income;
      try {
        deps.record(categoryFiledChange({
          actor: 'auto',
          account: { ...(sfinId ? { sfinId } : {}), wfId: refund.wfAccountId, name: refund.accountName },
          ...(txKey ? { txKey } : {}),
          activityId: refund.activityId,
          description: refund.description,
          amountCents: refund.amountCents,
          date: refund.date,
          before: income ? { ...income, taxonomyId: 'income_sources' } : null,
          after: { ...category, taxonomyId: 'spending_categories' },
          why: FEE_REVERSAL_FILING_WHY,
          ...(income ? { restore: [{ taxonomyId: 'income_sources', categoryId: income.categoryId }] } : {}),
        }));
      } catch (e) {
        deps.log(`Fee reversal filing: change log skipped for ${refund.activityId}: ${errText(e)}`);
      }
    }
  } catch (e) {
    deps.log(`Fee reversal filing skipped: ${errText(e)}`);
  }
  return { filed };
}
