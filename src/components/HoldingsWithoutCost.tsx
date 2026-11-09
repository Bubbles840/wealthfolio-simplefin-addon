import React, { useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Why } from './ui';
import { holdingsWithoutCost } from '../../shared/holdings';
import type { AccountMapping } from '../../shared/types';
import { INVESTMENT_ACCOUNT_TYPES } from '../../shared/sync-core';

/** One holding Wealthfolio has no cost for, and the account it is in. */
export interface HoldingWithoutCost {
  symbol: string;
  account: string;
  accountId: string;
}

/**
 * The holdings without a cost in the mapped investment accounts that are in
 * use (not archived or inactive), read from Wealthfolio itself: one holdings
 * read per account, all at once. An account whose holdings cannot be read is
 * left out, so a failed read shows nothing rather than a wrong list.
 */
export async function readHoldingsWithoutCost(ctx: AddonContext, mapping: AccountMapping): Promise<HoldingWithoutCost[]> {
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  const accounts = (((await ctx.api.accounts.getAll()) ?? []) as any[]).filter((a) => mapped.has(a.id)
    && a.isArchived !== true && a.isActive !== false
    && (INVESTMENT_ACCOUNT_TYPES.has(String(a.accountType ?? '')) || a.trackingMode === 'HOLDINGS'));
  const reads = await Promise.allSettled(accounts.map((a) => ctx.api.portfolio.getHoldings(a.id)));
  return accounts.flatMap((a, i) => {
    const read = reads[i];
    // Left out: unknown is not "has no cost".
    if (read.status !== 'fulfilled') return [];
    return holdingsWithoutCost(read.value as any[]).map((symbol) => ({ symbol, account: String(a.name ?? a.id), accountId: String(a.id) }));
  });
}

/**
 * A banner on Home listing the holdings Wealthfolio has no cost for, until it
 * has one. The sync carries a cost Wealthfolio already has from day to day and
 * says once when it cannot; this list is what stays, without repeating an
 * alert. Read again after the add-on's own sync (`syncing` turning false) and
 * whenever the page re-reads balances (`refresh`), which a companion's sync
 * also brings.
 */
export function HoldingsWithoutCost({ ctx, mapping, syncing, refresh }: {
  ctx: AddonContext;
  mapping: AccountMapping;
  syncing: boolean;
  /** Changes when the page re-reads what the syncs wrote. */
  refresh?: unknown;
}) {
  const [rows, setRows] = useState<HoldingWithoutCost[]>([]);
  const key = JSON.stringify(mapping);
  useEffect(() => {
    if (syncing) return;
    let live = true;
    readHoldingsWithoutCost(ctx, mapping).then((r) => { if (live) setRows(r); }, () => { if (live) setRows([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key, syncing, refresh]);
  if (rows.length === 0) return null;
  const one = rows.length === 1;
  return (
    <div className="sfin-banner-warn" role="status" aria-label="Holdings without a cost">
      <div className="sfin-banner-body">
        <div>
          Wealthfolio has no cost for {one ? 'this holding' : `${rows.length} holdings`}, so{' '}
          {one ? 'its account shows' : 'their accounts show'} no gain:
        </div>
        <ul className="sfin-banner-list">
          {rows.map((r) => (
            <li key={`${r.accountId}|${r.symbol}`}>
              <b>{r.symbol}</b> · {r.account}
            </li>
          ))}
        </ul>
        <div className="sfin-banner-note">
          Give {one ? 'it' : 'each'} a cost in Wealthfolio: on the holding, in an account
          tracked by holdings; with the buy activity, in one tracked by transactions.{' '}
          {one ? 'It leaves' : 'Each leaves'} this list once Wealthfolio has a cost.
        </div>
        <Why>
          Some providers (often 401(k) plans) send positions without a cost. The sync
          keeps the cost Wealthfolio already has from day to day, but it cannot start
          one: a new holding, or a change it could not cost (a split, a large buy or
          sale, another currency), needs it from you once.
        </Why>
      </div>
    </div>
  );
}
