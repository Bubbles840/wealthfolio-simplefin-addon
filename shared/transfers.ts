/**
 * Automatic transfer-pair detection across synced accounts.
 *
 * Two transactions form a transfer pair when they sit in different accounts,
 * have equal absolute amounts (cent precision) with opposite signs, and
 * posted within TRANSFER_MATCH_WINDOW_SECONDS of each other. Matching is
 * greedy (nearest posted date first) and deterministic: candidates are
 * processed in (posted, txId) order, so ties resolve to the earlier-posted,
 * then lexicographically-first counterpart.
 *
 * Rule-typed transactions never participate — an explicit user rule always
 * wins over auto-detection.
 */

// 5 days: a card payment's two sides (checking debit + card credit) can post a
// few days apart, and a bank bill-pay straddling a weekend can take 4-5 days.
// Distinctive amounts make false pairs at this width negligible.
export const TRANSFER_MATCH_WINDOW_SECONDS = 5 * 24 * 60 * 60;

export interface TransferCandidate {
  /** SimpleFin transaction id (or activity id in the reconciliation sweep) */
  txId: string;
  /** Account the transaction belongs to — pairs must span two accounts */
  accountId: string;
  /** Unix seconds */
  posted: number;
  /** Signed amount */
  amount: number;
  /** True when a user mapping rule set the type — excluded from pairing */
  ruleTyped: boolean;
  /** Wealthfolio account type (e.g. 'CREDIT_CARD'); optional. A credit card's
   *  negative side (a charge) is never auto-typed TRANSFER_OUT — on cards,
   *  transfers classify as Ignored in spending, so a coincidental match would
   *  silently hide a real purchase. The card's positive side (a payment
   *  received) can still become TRANSFER_IN. */
  accountType?: string;
}

export interface TransferPair {
  outTxId: string;
  inTxId: string;
}

export interface TransferDetection {
  typeByTxId: Map<string, 'TRANSFER_OUT' | 'TRANSFER_IN'>;
  pairs: TransferPair[];
}

export function detectTransferPairs(candidates: TransferCandidate[]): TransferDetection {
  const eligible = candidates
    .filter((c) => !c.ruleTyped && Number.isFinite(c.amount) && c.amount !== 0)
    .sort((a, b) => a.posted - b.posted || a.txId.localeCompare(b.txId));

  // A credit card's negative (a charge) is never eligible as the OUT side of
  // an auto-detected transfer — see accountType doc above.
  const negatives = eligible.filter((c) => c.amount < 0 && c.accountType !== 'CREDIT_CARD');
  const positives = eligible.filter((c) => c.amount > 0);

  const usedPositives = new Set<string>();
  const pairs: TransferPair[] = [];
  const typeByTxId = new Map<string, 'TRANSFER_OUT' | 'TRANSFER_IN'>();

  for (const neg of negatives) {
    const negCents = Math.round(Math.abs(neg.amount) * 100);
    let best: TransferCandidate | null = null;
    let bestGap = Infinity;
    // positives are pre-sorted by (posted, txId): the first candidate at a
    // given gap wins, which makes tie-breaking deterministic
    for (const pos of positives) {
      if (usedPositives.has(pos.txId)) continue;
      if (pos.accountId === neg.accountId) continue;
      if (Math.round(pos.amount * 100) !== negCents) continue;
      const gap = Math.abs(pos.posted - neg.posted);
      if (gap > TRANSFER_MATCH_WINDOW_SECONDS) continue;
      if (gap < bestGap) {
        best = pos;
        bestGap = gap;
      }
    }
    if (best) {
      usedPositives.add(best.txId);
      pairs.push({ outTxId: neg.txId, inTxId: best.txId });
      typeByTxId.set(neg.txId, 'TRANSFER_OUT');
      typeByTxId.set(best.txId, 'TRANSFER_IN');
    }
  }

  return { typeByTxId, pairs };
}
