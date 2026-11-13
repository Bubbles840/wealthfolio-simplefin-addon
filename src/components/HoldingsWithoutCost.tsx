import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Button, Why } from './ui';
import { useDismissals } from './UncategorizedList';
import { holdingsWithoutCost } from '../../shared/holdings';
import type { AccountMapping } from '../../shared/types';
import { INVESTMENT_ACCOUNT_TYPES } from '../../shared/sync-core';
import { mergeDismissals, type DismissalLedger } from '../../shared/uncategorized';
import { SecretsStore } from '../utils/secrets';

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
    // Left out: unknown is not "has no cost". A read that resolved to no list
    // drops only its own account.
    if (read.status !== 'fulfilled' || !Array.isArray(read.value)) return [];
    return holdingsWithoutCost(read.value as any[]).map((symbol) => ({ symbol, account: String(a.name ?? a.id), accountId: String(a.id) }));
  });
}

/** Every hide and every read of the hidden list, in order, across mounts:
 *  a second hide, or a Home opened again, never reads the secret before an
 *  earlier hide is saved. */
let hideQueue: Promise<unknown> = Promise.resolve();
function afterHides<T>(step: () => Promise<T>): Promise<T> {
  const run = hideQueue.then(step, step);
  hideQueue = run.catch(() => {});
  return run;
}

/** The key a hidden holding is stored under. */
export const hiddenKey = (r: HoldingWithoutCost): string => `${r.accountId}|${r.symbol}`;

/**
 * A banner on Home listing the holdings Wealthfolio has no cost for, until it
 * has one. The sync carries a cost Wealthfolio already has from day to day and
 * says once when it cannot; this list is what stays, without repeating an
 * alert. Read again after the add-on's own sync (`syncing` turning false) and
 * whenever the page re-reads balances (`refresh`), which a companion's sync
 * also brings.
 *
 * Each holding can be hidden ("Don't show"), for a provider that never sends
 * a cost: kept in a secret, so it holds across browsers, until Reset. A hidden
 * holding stays hidden; one that gets a cost leaves the list anyway, and a new
 * holding without one still shows.
 */
export function HoldingsWithoutCost({ ctx, mapping, syncing, refresh }: {
  ctx: AddonContext;
  mapping: AccountMapping;
  syncing: boolean;
  /** Changes when the page re-reads what the syncs wrote. */
  refresh?: unknown;
}) {
  const store = useMemo(() => new SecretsStore(ctx), [ctx]);
  const [rows, setRows] = useState<HoldingWithoutCost[]>([]);
  const [hidden, setHidden] = useState<DismissalLedger>({});
  const [failed, setFailed] = useState(false);
  // Counts hides and undos, so a read that started before one doesn't undo it.
  const acted = useRef(0);
  const key = JSON.stringify(mapping);
  useEffect(() => {
    if (syncing) return;
    let live = true;
    const at = acted.current;
    // Read together, so a hidden holding never flashes up first, and after any
    // hide still being saved. A hidden list that cannot be read hides nothing.
    Promise.all([readHoldingsWithoutCost(ctx, mapping), afterHides(() => store.getHiddenCostHoldings()).catch(() => ({}))])
      .then(([r, h]) => {
        if (!live) return;
        setRows(r);
        if (acted.current === at) setHidden(h);
      }, () => { if (live) setRows([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key, syncing, refresh]);
  const onHiddenChange = useCallback((next: DismissalLedger) => {
    const base = hidden;
    acted.current += 1;
    setHidden(next);
    setFailed(false);
    afterHides(() => store.editHiddenCostHoldings(base, next)).catch(() => {
      // Take back only this change, and say so.
      setHidden((now) => mergeDismissals(now, next, base));
      setFailed(true);
    });
  }, [hidden, store]);
  const { justDismissed, dismiss, undo } = useDismissals(hidden, onHiddenChange);
  const shown = rows.filter((r) => !(hiddenKey(r) in hidden));
  const notes = (
    <>
      {justDismissed && justDismissed in hidden && (
        <div className="sfin-uncat-undo">
          <span className="sfin-subtle">Hidden.</span>
          <Button variant="ghost" onClick={undo}>Undo</Button>
        </div>
      )}
      {failed && <div className="sfin-subtle">That could not be saved, so the list is as it was.</div>}
    </>
  );
  if (shown.length === 0) {
    return justDismissed || failed ? <div role="status">{notes}</div> : null;
  }
  const one = shown.length === 1;
  return (
    <div className="sfin-banner-warn" role="status" aria-label="Holdings without a cost">
      <div className="sfin-banner-body">
        <div>
          Wealthfolio has no cost for {one ? 'this holding' : `${shown.length} holdings`}, so{' '}
          {one ? 'its account shows' : 'their accounts show'} no gain:
        </div>
        <ul className="sfin-banner-list">
          {shown.map((r) => (
            <li key={hiddenKey(r)}>
              <b>{r.symbol}</b> · {r.account}{' '}
              <Button
                variant="ghost"
                onClick={() => dismiss(hiddenKey(r))}
                title="Stop listing this holding here"
                aria-label={`Don't show ${r.symbol} in ${r.account}`}
              >
                Don't show
              </Button>
            </li>
          ))}
        </ul>
        {notes}
        <div className="sfin-banner-note">
          Give {one ? 'it' : 'each'} a cost in Wealthfolio: on the holding, in an account
          tracked by holdings; with the buy activity, in one tracked by transactions.{' '}
          {one ? 'It leaves' : 'Each leaves'} this list once Wealthfolio has a cost.
          If your provider never sends one and you don't track gains, choose Don't show.
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
