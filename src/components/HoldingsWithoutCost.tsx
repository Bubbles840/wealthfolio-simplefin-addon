import React, { useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Why } from './ui';
import { holdingsWithoutCost } from '../../shared/holdings';
import type { AccountMapping } from '../../shared/types';

/** One holding Wealthfolio has no cost for, and the account it is in. */
export interface HoldingWithoutCost {
  symbol: string;
  account: string;
}

const INVESTMENT_TYPES = new Set(['SECURITIES', 'CRYPTOCURRENCY']);

/**
 * The holdings without a cost in the mapped investment accounts, read from
 * Wealthfolio itself: one holdings read per account. An account whose holdings
 * cannot be read is left out, so a failed read shows nothing rather than a
 * wrong list.
 */
export async function readHoldingsWithoutCost(ctx: AddonContext, mapping: AccountMapping): Promise<HoldingWithoutCost[]> {
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  const accounts = ((await ctx.api.accounts.getAll()) ?? []).filter((a: any) => mapped.has(a.id)
    && (INVESTMENT_TYPES.has(String(a.accountType ?? '')) || a.trackingMode === 'HOLDINGS'));
  const out: HoldingWithoutCost[] = [];
  for (const a of accounts as any[]) {
    try {
      const symbols = holdingsWithoutCost((await ctx.api.portfolio.getHoldings(a.id)) as any[]);
      for (const symbol of symbols) out.push({ symbol, account: String(a.name ?? a.id) });
    } catch {
      // Left out: unknown is not "has no cost".
    }
  }
  return out;
}

/**
 * A banner on Home listing the holdings Wealthfolio has no cost for, until it
 * has one. The sync carries a cost Wealthfolio already has from day to day and
 * says once when it cannot; this list is what stays, without repeating an
 * alert. Read again after every sync (`syncing` turning false).
 */
export function HoldingsWithoutCost({ ctx, mapping, syncing }: { ctx: AddonContext; mapping: AccountMapping; syncing: boolean }) {
  const [rows, setRows] = useState<HoldingWithoutCost[]>([]);
  const key = JSON.stringify(mapping);
  useEffect(() => {
    if (syncing) return;
    let live = true;
    readHoldingsWithoutCost(ctx, mapping).then((r) => { if (live) setRows(r); }, () => { if (live) setRows([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key, syncing]);
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
            <li key={`${r.account}|${r.symbol}`}>
              <b>{r.symbol}</b> · {r.account}
            </li>
          ))}
        </ul>
        <div className="sfin-banner-note">
          Enter the cost on {one ? 'the holding' : 'each holding'} in Wealthfolio.{' '}
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
