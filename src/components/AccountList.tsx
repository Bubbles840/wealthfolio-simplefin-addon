import React from 'react';
import { CheckIcon, AlertIcon } from './ui';
import type { AccountBalanceInfo } from '../utils/secrets';
import type { AccountMapping } from '../../shared/types';

/** Currency text for a balance or an amount. Exported: the Home banners name
 *  the same amounts the rows below them show, and must format them the same. */
export function money(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Two-character badge from an account name: "Spend (1234)" → "SP". */
function initials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '');
  return (clean.slice(0, 2) || '••').toUpperCase();
}

function formatAsOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export interface AccountListProps {
  mapping: AccountMapping;
  balances: Record<string, AccountBalanceInfo>;
  sfinNames: Record<string, string>;
  /** Wealthfolio's own account names, so a row can say what it maps ONTO — and,
   *  by their absence, that the target account no longer exists. */
  wfNames: Record<string, string>;
  onOpenAccount: (wfAccountId: string) => void;
}

/** "2 accounts · 1 off by $36.10": the collapsed Accounts card's summary and
 *  the Home tile's subline, so the two can never disagree. */
export function accountsSummary(mapping: AccountMapping, balances: Record<string, AccountBalanceInfo>): string {
  const ids = Object.keys(mapping).filter((id) => !!mapping[id]);
  if (ids.length === 0) return 'No accounts mapped';
  const head = `${ids.length} account${ids.length === 1 ? '' : 's'}`;
  const off = ids.filter((id) => balances[id]?.drift != null);
  if (off.length === 0) return head;
  if (off.length === 1) {
    const b = balances[off[0]]!;
    return `${head} · 1 off by ${money(Math.abs(b.drift as number), b.currency)}`;
  }
  return `${head} · ${off.length} off`;
}

/**
 * Every mapped account with its balance and whether that balance was checked
 * against the bank. Moved out of the Overview tab (1.57) so Settings → Accounts
 * can show the same rows the mapping beneath them is about.
 */
export function AccountList({ mapping, balances, sfinNames, wfNames, onOpenAccount }: AccountListProps) {
  const entries = Object.entries(mapping).filter(([, wfId]) => !!wfId);
  const asOf = entries
    .map(([sfinId]) => balances[sfinId]?.date)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => b - a)[0];
  const rows = entries.length === 0
    ? <div className="sfin-subtle">No accounts mapped yet.</div>
    : entries.map(([sfinId, wfId]) => {
      const info = balances[sfinId];
      const name = sfinNames[sfinId] ?? sfinId;
      const exists = !!wfNames[wfId];
      const open = () => { if (exists) onOpenAccount(wfId); };
      return (
        // One full-width card per account, stacked. A grid of two columns
        // made the balance and its chip compete with the neighbouring
        // account's name; a row that spans the width does not.
        <div
          className={`sfin-card sfin-acct-card${exists ? ' sfin-acct-card--link' : ''}`}
          key={sfinId}
          {...(exists
            ? {
                role: 'button',
                tabIndex: 0,
                title: 'Open this account in Wealthfolio',
                onClick: open,
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
                },
              }
            : {})}
        >
          <div className="sfin-acct-left">
            <div className="sfin-avatar">{initials(name)}</div>
            <div className="sfin-acct-ident">
              <div className="sfin-acct-name">{name}</div>
              <div className="sfin-acct-map">
                {exists ? (
                  `→ ${wfNames[wfId]}`
                ) : (
                  <span className="sfin-acct-gone">account no longer exists — reset &amp; re-map</span>
                )}
              </div>
            </div>
          </div>
          <div className="sfin-acct-right">
            <div className="sfin-bal">{info && info.balance != null ? money(info.balance, info.currency) : '—'}</div>
            {/* THREE states, not two. `drift == null` used to render a green
                "in sync" chip, but it is also what "could not check" looks
                like — an account is incomparable for several ordinary reasons
                (a pending row, a run that updated or deleted anything, a
                pruned duplicate, a planned create that never landed). Calling
                those "in sync" claims a verification that did not happen, and
                two phantom drift episodes on one account were read as verified
                balances because of it. `measured` distinguishes them; absent
                means unmeasured, since a snapshot from an older build has
                proved nothing about the current state either. */}
            {info && info.balance != null && (info.drift != null ? (
              <span className="sfin-chip sfin-chip--off"><AlertIcon /> off by {money(Math.abs(info.drift), info.currency)}</span>
            ) : (info as { measured?: boolean }).measured ? (
              <span className="sfin-chip"><CheckIcon /> in sync</span>
            ) : (
              <span
                className="sfin-chip sfin-chip--muted"
                title={
                  'This sync could not compare the two balances — usually a pending '
                  + 'transaction, or a row it reconciled or could not write. Nothing is '
                  + 'wrong; it just was not checked. The next sync normally can.'
                }
              >
                not checked
              </span>
            ))}
          </div>
        </div>
      );
    });
  // No frame or heading of its own: it sits inside Settings' Accounts card,
  // which has both.
  return (
    <div className="sfin-accts--bare">
      {asOf && <div className="sfin-subtle sfin-accts-asof">balances as of {formatAsOf(asOf)}</div>}
      {rows}
    </div>
  );
}
