/**
 * shared/feed-currency.ts
 *
 * A SimpleFin account whose `currency` is blank. The protocol says every
 * account carries one, but some providers send `""` (seen on a retirement
 * plan). Every write names its cash asset `$CASH-<currency>`, so a blank one
 * became `$CASH-`, which Wealthfolio refuses: "Invalid symbol '$CASH-'. Please
 * search for a valid ticker." Every row of the account failed to import.
 *
 * Filled once, right after the download, so all of the sync (rows, the opening
 * balance, drift, holdings snapshots) reads one currency for the account.
 */
import type { SimplefinAccount } from './types.js';

const blank = (c: string | null | undefined): boolean => !c || c.trim() === '';

export interface FilledCurrencies {
  /** The feed, with a blank currency filled where it could be. Accounts that
   *  already had one are the same objects. */
  accounts: SimplefinAccount[];
  /** Mapped accounts still without a currency: their rows will be refused. */
  unresolved: SimplefinAccount[];
}

/**
 * A blank currency, filled from what else says what money the account is in:
 *  1. the mapped Wealthfolio account's own currency (Wealthfolio requires one,
 *     and it is the currency every row is written into anyway);
 *  2. otherwise its holdings', when they all name the same one.
 * Never a guessed USD: an account in another currency would be booked wrong
 * with no error at all, which is worse than the refusal it replaces.
 */
export function fillFeedCurrencies(
  accounts: readonly SimplefinAccount[],
  mapping: Readonly<Record<string, string | null | undefined>>,
  wfCurrencies: ReadonlyMap<string, string | null | undefined>,
): FilledCurrencies {
  const unresolved: SimplefinAccount[] = [];
  const filled = accounts.map((account) => {
    if (!blank(account.currency)) return account;
    const wfId = mapping[account.id];
    const fromWf = wfId ? wfCurrencies.get(wfId) : undefined;
    const held = new Set(
      (account.holdings ?? []).map((h) => h.currency?.trim()).filter((c): c is string => !!c),
    );
    const currency = !blank(fromWf) ? fromWf!.trim() : held.size === 1 ? [...held][0] : null;
    if (currency) return { ...account, currency };
    if (wfId) unresolved.push(account);
    return account;
  });
  return { accounts: filled, unresolved };
}
