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

/**
 * Composite identity for a row inside a sync run: WHICH ACCOUNT plus WHICH
 * SimpleFin transaction.
 *
 * A bare transaction id is NOT an identity across accounts. SimpleFin issues ONE
 * transaction id for BOTH sides of a transfer between two accounts it connects
 * (confirmed against real feeds), so any map or set keyed by tx id alone that
 * spans accounts has one leg silently overwrite the other. What that cost, before
 * this key existed: an outflow written back as an inflow, both legs of a pair
 * resolving to the SAME stored row, one account's leg labelled with the other's
 * bank description, and the wrong sign fed into drift and the starting-balance
 * baseline.
 *
 * NUL as the separator, deliberately: it cannot occur in a SimpleFin account id
 * or transaction id (nor in any Wealthfolio id), so no pair of real ids can
 * collide with another pair, however either id is punctuated. Keys are never
 * parsed back apart — always rebuilt from the two components — so the separator
 * only has to be unambiguous, not readable.
 *
 * The `accountId` component is the SIMPLEFIN account id throughout the sync core,
 * matching `TransferCandidate.accountId`, so one convention holds everywhere.
 */
export const accountTxKey = (accountId: string, txId: string) => `${accountId}\u0000${txId}`;

/** One side of a pair. Both fields are needed: with a shared transaction id the
 *  `txId` alone does not say which of the two legs is meant. */
export interface TransferLegRef {
  accountId: string;
  txId: string;
}

export interface TransferPair {
  out: TransferLegRef;
  in: TransferLegRef;
}

export interface TransferDetection {
  /** Resolved type per LEG, keyed by `accountTxKey(accountId, txId)` — never by
   *  tx id alone, or a shared-id pair would record only its second leg. */
  typeByAccountTx: Map<string, 'TRANSFER_OUT' | 'TRANSFER_IN'>;
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

  // Keyed per LEG, not per tx id: a positive in account B must not be marked
  // "already used" by an unrelated positive that happens to carry the same
  // transaction id in account C.
  const usedPositives = new Set<string>();
  const pairs: TransferPair[] = [];
  const typeByAccountTx = new Map<string, 'TRANSFER_OUT' | 'TRANSFER_IN'>();

  for (const neg of negatives) {
    const negCents = Math.round(Math.abs(neg.amount) * 100);
    let best: TransferCandidate | null = null;
    let bestGap = Infinity;
    // positives are pre-sorted by (posted, txId): the first candidate at a
    // given gap wins, which makes tie-breaking deterministic
    for (const pos of positives) {
      if (usedPositives.has(accountTxKey(pos.accountId, pos.txId))) continue;
      // Different ACCOUNTS is the whole test — a shared transaction id is not
      // only allowed here, it is the strongest possible evidence of a genuine
      // internal transfer, since SimpleFin issues one id for both sides of a
      // transfer it can see end to end. The same-account guard is also what
      // makes "a leg cannot pair with itself" true by construction.
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
      usedPositives.add(accountTxKey(best.accountId, best.txId));
      pairs.push({
        out: { accountId: neg.accountId, txId: neg.txId },
        in: { accountId: best.accountId, txId: best.txId },
      });
      typeByAccountTx.set(accountTxKey(neg.accountId, neg.txId), 'TRANSFER_OUT');
      typeByAccountTx.set(accountTxKey(best.accountId, best.txId), 'TRANSFER_IN');
    }
  }

  return { typeByAccountTx, pairs };
}
