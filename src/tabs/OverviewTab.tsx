import React, { useCallback, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { applyBalanceAdjustment, applyBaselineCorrection } from '../utils/sync';
import type { SyncResult } from '../utils/sync';
import { BASELINE_FIX_MIN_DRIFT_AGE_MS } from '../../shared/sync-core';
import { Button, SectionLabel, CheckIcon, AlertIcon } from '../components/ui';
import { SetupChecklist } from '../components/SetupChecklist';
import { UncategorizedList, useDismissals } from '../components/UncategorizedList';
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized';
import type { TabId } from '../components/Tabs';
// Card ids only — the banner's CTA has to name the card it opens, and the
// Advanced tab owns that id set. One-way: AdvancedTab imports nothing here.
import { CARD as ADVANCED_CARD } from './AdvancedTab';
import type { SecretsStore, AccountBalanceInfo } from '../utils/secrets';
import type { AccountMapping, UnmappedAccount } from '../../shared/types';

/** Ids for this tab's collapsible sections. Following the `NOTIF_CARD`
 *  precedent (`src/tabs/NotificationsTab.tsx`): the page owns the open-state
 *  map, this tab owns the keys into it. */
export const OVERVIEW_CARD = { uncategorized: 'uncategorized-list' } as const;

/** The offer a sync attaches to an account when it proved the drift belongs to
 *  the starting-balance baseline rather than to any transaction. */
type BaselineFixOffer = {
  activityId: string;
  currentAmount: number;
  suggestedAmount: number;
};

function money(amount: number, currency = 'USD'): string {
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

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  mapping: AccountMapping;
  sfinNames: Record<string, string>;
  /** Wealthfolio's own account names, so a row can say what it maps ONTO — and,
   *  by their absence, that the target account no longer exists. */
  wfNames: Record<string, string>;
  balances: Record<string, AccountBalanceInfo>;
  syncing: boolean;
  healing: boolean;
  doHeal: () => void;
  imported: number | null;
  prunedDuplicates: SyncResult['prunedDuplicates'];
  /** SimpleFin accounts the last sync had no mapping for. Read by the PAGE from
   *  the secret every sync writes, rather than from a sync's return value: the
   *  run that discovers a newly-linked bank is normally the companion's. */
  unmappedAccounts: UnmappedAccount[];
  /** The companion's uncategorized count AND the rows behind it. Read by the
   *  PAGE, on the same refresh path as the balances: the companion republishes
   *  it every sync, so a count this tab loaded once on mount sat stale for the
   *  whole session. `null` is the standalone-addon case — the SDK exposes no
   *  category data, so the tile is simply absent rather than guessing. Typed off
   *  the store method rather than hand-widened, so this shape can never drift
   *  from what `getUncategorizedStatus` actually returns. */
  uncategorized: Awaited<ReturnType<SecretsStore['getUncategorizedStatus']>>;
  /** Which rows the user has chosen to stop seeing. Lives in the SHELL
   *  (`SyncPage`), not this tab: inactive tabs unmount (see `TabPanel`), and a
   *  dismissal held here would resurrect on a trip to another tab and back. */
  dismissals: DismissalLedger;
  onDismissalsChange: (next: DismissalLedger) => void;
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
  /** Re-read the balance snapshots. The page owns `balances` (a sync writes
   *  them too), so an adjustment made here has to ask for the refresh. */
  onBalancesChanged: () => void;
  onClearError: () => void;
  onError: (e: any, fallback: string) => void;
  companionVersion: string | null;
  telegramConfigured: boolean;
  amazonConfigured: boolean;
  checklistDismissed: boolean;
  onDismissChecklist: () => void;
  /** `openCardId` also expands that card on the destination tab — a CTA naming
   *  a specific card has to actually open it. */
  onNavigate: (tab: TabId, openCardId?: string) => void;
}

/**
 * The daily-glance half of the page: what needs attention (banners), what is
 * still worth setting up (checklist), the three headline numbers, and every
 * mapped account with its balance.
 *
 * Deliberately NOT a tile for balance discrepancies: a drift is per-account and
 * event-driven, so a permanent tile would spend most of its life reading "0" —
 * the banner above and the per-account chip below say it where it can be acted
 * on. "Needs a category" can only come from the companion: the addon SDK
 * exposes no category data, so a null status means the tile is simply absent.
 */
export function OverviewTab({
  ctx, store, mapping, sfinNames, wfNames, balances, syncing, healing, doHeal,
  imported, prunedDuplicates, unmappedAccounts, uncategorized, dismissals, onDismissalsChange,
  isOpen, toggleCard, onBalancesChanged, onClearError, onError,
  companionVersion, telegramConfigured, amazonConfigured, checklistDismissed,
  onDismissChecklist, onNavigate,
}: Props) {
  const [fixingBaseline, setFixingBaseline] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const { justDismissed, dismiss, undo } = useDismissals(dismissals, onDismissalsChange);

  // Plug the residual: add a one-time balance-adjustment entry for an account.
  const doFixBaseline = useCallback(
    async (sfinId: string, wfId: string, currency: string, suggestedAmount: number) => {
      setFixingBaseline(sfinId);
      onClearError();
      try {
        await applyBaselineCorrection(ctx, store, {
          sfinAccountId: sfinId,
          wfAccountId: wfId,
          currency,
          suggestedAmount,
        });
        onBalancesChanged();
      } catch (e: any) {
        onError(e, 'Baseline correction failed');
      } finally {
        setFixingBaseline(null);
      }
    },
    [ctx, store, onBalancesChanged, onClearError, onError],
  );

  const doAdjust = useCallback(
    async (sfinId: string, wfId: string, currency: string, amount: number) => {
      setAdjusting(sfinId);
      onClearError();
      try {
        await applyBalanceAdjustment(ctx, store, { sfinAccountId: sfinId, wfAccountId: wfId, currency, amount });
        onBalancesChanged();
      } catch (e: any) {
        onError(e, 'Adjustment failed');
      } finally {
        setAdjusting(null);
      }
    },
    [ctx, store, onBalancesChanged, onClearError, onError],
  );

  const visibleRows = uncategorized
    ? visibleUncategorized(uncategorized.rows, dismissals)
    : [];
  // The tile subtracts locally-known dismissals so it can never disagree with
  // the list under it. `count` is the companion's true total as of its last
  // publish; dismissals made since then are not in it yet, so this can only
  // subtract a dismissal it can SEE is still counted (i.e. its row is present in
  // this publish) — otherwise a dismissal of a row the companion had already
  // dropped (recategorized, or simply not republished) would double-subtract and
  // understate the backlog.
  const uncatCount = uncategorized
    ? Math.max(0, uncategorized.count - Object.keys(dismissals)
        .filter((id) => uncategorized.rows.some((r) => r.activityId === id)).length)
    : 0;

  const mappedEntries = Object.entries(mapping);
  const mappedCount = mappedEntries.length;
  const driftAccounts = mappedEntries.filter(([sfinId]) => balances[sfinId]?.drift != null);
  const asOf = mappedEntries
    .map(([sfinId]) => balances[sfinId]?.date)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => b - a)[0];

  return (
    <>
      {/* An account SimpleFin is offering that nothing is mapped to. First
          banner on the page because it is the only one that means data is
          MISSING rather than wrong: until it is mapped, every sync silently
          imports nothing from that account. Linking a bank at SimpleFin used
          to produce exactly this with no indication anywhere (Robinhood Gold,
          2026-08-13) — the account simply never appeared in Wealthfolio.

          Not dismissable, deliberately: it clears itself the moment the next
          sync sees a mapping, and a dismissed banner would leave the account
          silently unsynced all over again. */}
      {unmappedAccounts.length > 0 && (
        <div className="sfin-banner-warn">
          <div className="sfin-banner-body">
            <div>
              {unmappedAccounts.length === 1 ? 'A new SimpleFin account is' : `${unmappedAccounts.length} SimpleFin accounts are`}{' '}
              not mapped to Wealthfolio, so nothing from{' '}
              {unmappedAccounts.length === 1 ? 'it' : 'them'} is being imported:
            </div>
            <ul className="sfin-banner-list">
              {unmappedAccounts.map((a) => (
                <li key={a.sfinAccountId}>
                  <b>{a.accountName}</b>
                  {a.orgName ? ` · ${a.orgName}` : ''}
                </li>
              ))}
            </ul>
            <div className="sfin-banner-note">
              Map {unmappedAccounts.length === 1 ? 'it' : 'them'} under Advanced → Accounts.
              Existing settings are untouched — there is no need to run setup again.
            </div>
          </div>
          {/* Names the card explicitly so the CTA lands on it open, rather
              than on a tab where it is one of five collapsed headers. */}
          <Button variant="outline" onClick={() => onNavigate('advanced', ADVANCED_CARD.accounts)}>
            Open Accounts
          </Button>
        </div>
      )}

      {/* What the reconcile sweep deleted. A needs-to-be-seen notice rather than
          a collapsible detail: rows were removed from the user's ledger without
          being asked about, so each one is itemised with the figure, date,
          description and account — enough to go and verify in Wealthfolio. */}
      {prunedDuplicates.length > 0 && (
        <div className="sfin-banner-warn">
          <div className="sfin-banner-body">
            <div>
              Removed {prunedDuplicates.length} duplicate{' '}
              {prunedDuplicates.length === 1 ? 'activity' : 'activities'} — each of these
              was stored twice, so the extra copy was deleted.
            </div>
            <ul className="sfin-banner-list">
              {prunedDuplicates.map((p) => (
                <li key={p.wfId}>
                  <b>{money(p.amountCents / 100, p.currency)}</b> · {p.date}
                  {p.description ? ` · ${p.description}` : ''} · {p.accountName}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {driftAccounts.map(([sfinId, wfId]) => {
        const info = balances[sfinId];
        const drift = info.drift as number;
        // Offered only when a heal proved every transaction reconciles, which
        // makes the starting balance the only thing left that can be wrong. When
        // it's present the plug is demoted: it would date this correction today
        // and leave the wrong baseline in place.
        const baselineFix = (info as { baselineFix?: BaselineFixOffer }).baselineFix;
        // A YOUNG dated drift is usually the bank's balance running ahead of its
        // own transaction feed — posted activity SimpleFin hasn't published yet,
        // which resolves itself in days. It gets the calm banner with NO plug
        // button: the red banner's `Add $X` was a loaded gun, since plugging lag
        // double-counts the moment the feed catches up. An undatable drift
        // (under the alert threshold, so no episode) keeps the old treatment —
        // that's the small-divergence case the plug exists for.
        const driftSince = (info as { driftSince?: string | null }).driftSince;
        const waitingOnFeed =
          !!driftSince && Date.now() - Date.parse(driftSince) < BASELINE_FIX_MIN_DRIFT_AGE_MS;
        if (waitingOnFeed) {
          return (
            <div className="sfin-banner-wait" key={sfinId}>
              <div className="sfin-banner-body">
                {/* Direction matters, and this used to assert one regardless of sign.
                    `drift = bankBalance − wealthfolioValuation`, so POSITIVE means the
                    bank is ahead of what its own feed explains — real lag, clears
                    itself. NEGATIVE means Wealthfolio holds more than the bank does,
                    which lag cannot cause and which does NOT clear on its own; telling
                    someone to wait it out is then advice to ignore a real problem. */}
                {drift > 0 ? (
                  <>
                    <div>
                      <b>{sfinNames[sfinId] ?? sfinId}</b>: the bank is ahead of its own
                      transaction feed by <b>{money(drift, info.currency)}</b> — it reports{' '}
                      <b>{money(info.balance ?? 0, info.currency)}</b>.
                    </div>
                    <div className="sfin-banner-note">
                      The bank&apos;s balance usually includes recent activity its transaction
                      list hasn&apos;t published yet — a transfer still in flight is the common
                      one. This typically clears in a few days on its own. A deep scan
                      re-checks the last 90 days if you would rather not wait.
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <b>{sfinNames[sfinId] ?? sfinId}</b>: Wealthfolio holds{' '}
                      <b>{money(Math.abs(drift), info.currency)}</b> more than the bank
                      reports (<b>{money(info.balance ?? 0, info.currency)}</b>).
                    </div>
                    <div className="sfin-banner-note">
                      Feed lag cannot cause this direction — lag makes the bank look ahead,
                      not behind. Something is likely recorded twice, or a withdrawal
                      hasn&apos;t imported. A deep scan of the last 90 days is the first thing
                      to try; don&apos;t add a plug, which would only widen the gap.
                    </div>
                  </>
                )}
                {/* Same operation, same name as the header button — one flag
                    (`healing`) drives both, so two labels for it read as two
                    different features. The 90-day window it re-scans is stated in
                    the note above rather than crammed into the label. */}
                <div className="sfin-banner-actions">
                  <Button variant="outline" onClick={doHeal} disabled={healing || syncing}>
                    {healing ? 'Deep scanning…' : 'Deep scan'}
                  </Button>
                </div>
              </div>
            </div>
          );
        }
        return (
          <div className="sfin-banner-warn" key={sfinId}>
            <div className="sfin-banner-body">
              <div>
                <b>{sfinNames[sfinId] ?? sfinId}</b> is off by{' '}
                <b>{money(Math.abs(drift), info.currency)}</b> — SimpleFin reports{' '}
                <b>{money(info.balance ?? 0, info.currency)}</b>.
              </div>
              {/* Either way, say what a deep scan would do — including the window
                  it covers, which used to be carried by the button's own label. */}
              {baselineFix ? (
                <div className="sfin-banner-note">
                  Every transaction reconciles — the opening balance looks wrong, not your
                  history.
                </div>
              ) : (
                <div className="sfin-banner-note">
                  A deep scan re-checks the last 90 days for anything missing before you
                  adjust the balance by hand.
                </div>
              )}
              <div className="sfin-banner-actions">
                <Button variant="outline" onClick={doHeal} disabled={healing || syncing}>
                  {healing ? 'Deep scanning…' : 'Deep scan'}
                </Button>
                {baselineFix && (
                  <Button
                    variant="outline"
                    title="Correct this account's opening balance — the starting-balance baseline that stands for everything that happened before the first sync"
                    onClick={() =>
                      doFixBaseline(sfinId, wfId, info.currency, baselineFix.suggestedAmount)
                    }
                    disabled={fixingBaseline === sfinId || healing || syncing}
                  >
                    {fixingBaseline === sfinId
                      ? 'Fixing opening balance…'
                      : `Fix opening balance: ${money(baselineFix.currentAmount, info.currency)} → ${money(baselineFix.suggestedAmount, info.currency)}`}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  title={
                    baselineFix
                      ? 'Add a one-time adjustment dated today instead. Leaves the wrong opening balance in place.'
                      : 'Add a one-time balance adjustment so this account matches your bank'
                  }
                  onClick={() => doAdjust(sfinId, wfId, info.currency, drift)}
                  disabled={adjusting === sfinId || healing || fixingBaseline === sfinId}
                >
                  {adjusting === sfinId
                    ? 'Adjusting…'
                    : `${drift > 0 ? 'Add' : 'Subtract'} ${money(Math.abs(drift), info.currency)}${baselineFix ? ' (plug instead)' : ''}`}
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Between the alerts and the numbers: what is wrong outranks what is
          unfinished, and both outrank the stats. */}
      <SetupChecklist
        companionVersion={companionVersion}
        telegramConfigured={telegramConfigured}
        amazonConfigured={amazonConfigured}
        dismissed={checklistDismissed}
        onDismiss={onDismissChecklist}
        onNavigate={onNavigate}
      />

      {/* Two tiles or three — the strip's columns come from what is rendered
          (see `.sfin-strip`), so a missing companion leaves no empty column. */}
      <div className="sfin-strip">
        <div className="sfin-tile sfin-tile--green">
          <SectionLabel>Accounts synced</SectionLabel>
          <div className="sfin-tile-val">{mappedCount}</div>
        </div>
        <div className="sfin-tile sfin-tile--blue">
          <SectionLabel>Imported last run</SectionLabel>
          <div className="sfin-tile-val">{imported ?? '—'}</div>
          {/* The figure is a COUNT of transactions, which the number alone was
              read as a dollar amount often enough to be worth spelling out. */}
          <div className="sfin-tile-sub">transactions</div>
        </div>
        {/* Doubles as the disclosure trigger once there is a list to show — one
            surface for the number instead of the tile plus a separate bar
            repeating it underneath. Gated on ROWS, not on the count: a v1.10.0
            companion can publish a count with no rows, and a chevron that
            expands onto nothing is worse than no chevron — that case keeps the
            plain, non-interactive tile it always had. */}
        {uncategorized && (
          visibleRows.length > 0 ? (
            <button
              type="button"
              className="sfin-tile sfin-tile--purple sfin-tile--toggle"
              title={`As of ${uncategorized.asOf}`}
              aria-expanded={isOpen(OVERVIEW_CARD.uncategorized)}
              // Same rule as the page's Disclosure: only points at the panel
              // while the panel actually exists.
              {...(isOpen(OVERVIEW_CARD.uncategorized)
                ? { 'aria-controls': OVERVIEW_CARD.uncategorized }
                : {})}
              // The tile's own contents ("Needs a category" / "7" / "from your
              // companion") read as a fragmented accessible name; this is the
              // same wording the separate disclosure header used to carry.
              aria-label={`${uncatCount} need${uncatCount === 1 ? 's' : ''} a category`}
              onClick={() => toggleCard(OVERVIEW_CARD.uncategorized)}
            >
              <div className="sfin-tile-head">
                <SectionLabel>Needs a category</SectionLabel>
                <span className="sfin-chevron" data-open={isOpen(OVERVIEW_CARD.uncategorized)} aria-hidden>▼</span>
              </div>
              <div className="sfin-tile-val">{uncatCount}</div>
              <div className="sfin-tile-sub">from your companion</div>
            </button>
          ) : (
            <div className="sfin-tile sfin-tile--purple" title={`As of ${uncategorized.asOf}`}>
              <SectionLabel>Needs a category</SectionLabel>
              <div className="sfin-tile-val">{uncatCount}</div>
              <div className="sfin-tile-sub">from your companion</div>
            </div>
          )
        )}
      </div>

      {uncategorized && isOpen(OVERVIEW_CARD.uncategorized) && (
        <UncategorizedList
          rows={visibleRows}
          total={uncatCount}
          id={OVERVIEW_CARD.uncategorized}
          onDismiss={dismiss}
          justDismissed={justDismissed}
          onUndo={undo}
          onOpenActivities={() => { ctx.api.navigation.navigate('/activities').catch(() => {}); }}
        />
      )}

      <div className="sfin-accts">
        <div className="sfin-card-head">
          {/* Just "Accounts": the count is already the first stat tile, and
              printing it twice within 100px of itself read as clutter. */}
          <SectionLabel>Accounts</SectionLabel>
          {asOf && <span className="sfin-subtle sfin-accts-asof">balances as of {formatAsOf(asOf)}</span>}
        </div>
        {mappedEntries.map(([sfinId, wfId]) => {
          const info = balances[sfinId];
          const name = sfinNames[sfinId] ?? sfinId;
          const exists = !!wfNames[wfId];
          const open = () => { if (exists) ctx.api.navigation.navigate(`/accounts/${wfId}`).catch(() => {}); };
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
        })}
      </div>
    </>
  );
}
