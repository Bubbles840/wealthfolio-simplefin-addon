import React, { useCallback, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { applyBalanceAdjustment, applyBaselineCorrection } from '../utils/sync';
import type { SyncResult } from '../utils/sync';
import { BASELINE_FIX_MIN_DRIFT_AGE_MS } from '../../shared/sync-core';
import { Button, SectionLabel, Why } from '../components/ui';
import { SetupChecklist } from '../components/SetupChecklist';
import { UncategorizedList, useDismissals } from '../components/UncategorizedList';
import { money, accountsSummary } from '../components/AccountList';
import { shortDate } from '../../shared/telegram';
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized';
import type { TabId } from '../components/Tabs';
// Card ids only — the banner's CTA has to name the card it opens, and the
// Advanced tab owns that id set. One-way: AdvancedTab imports nothing here.
import { CARD as SETTINGS_CARD } from './SettingsTab';
import type { SecretsStore, AccountBalanceInfo } from '../utils/secrets';
import type { AccountMapping, UnmappedAccount } from '../../shared/types';

/** Ids for this tab's collapsible sections. Following the `NOTIF_CARD`
 *  precedent (`src/tabs/NotificationsTab.tsx`): the page owns the open-state
 *  map, this tab owns the keys into it. The value is unchanged from when this
 *  was the Overview tab, so a list someone left open stays open. */
export const HOME_CARD = { uncategorized: 'uncategorized-list' } as const;

/** The offer a sync attaches to an account when it proved the drift belongs to
 *  the starting-balance baseline rather than to any transaction. */
type BaselineFixOffer = {
  activityId: string;
  currentAmount: number;
  suggestedAmount: number;
};

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
  prunedDuplicates: SyncResult['prunedDuplicates'];
  /** SimpleFin accounts the last sync had no mapping for. Read by the PAGE from
   *  the secret every sync writes, rather than from a sync's return value: the
   *  run that discovers a newly-linked bank is normally the companion's. */
  unmappedAccounts: UnmappedAccount[];
  /** Record that the user does not want these accounts synced, silencing both
   *  this banner and the companion's Telegram notice for them. */
  onIgnoreAccounts: (ids: string[]) => void;
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
  /** Companion-published semester-pool status. Null — no pool, no companion,
   *  or an unreadable publish — simply means no tile, like `uncategorized`. */
  poolStatus: Awaited<ReturnType<SecretsStore['getPoolStatus']>>;
  /** The pool tile's tap: opens the pool's burn-down in the budget below. */
  onOpenPool: () => void;
}

/**
 * Home, above the budget: what needs attention (banners), what is still worth
 * setting up (checklist), and the status strip — accounts, what needs a
 * category, the pool. The account rows themselves live in Settings → Accounts
 * since 1.57; the Accounts tile is the way there.
 *
 * A balance difference is a banner (where it can be acted on) and a clause on
 * the Accounts tile, not a tile of its own: it is per-account and event-driven,
 * so a dedicated tile would spend most of its life reading "0". "Needs a category" can only come from the companion: the addon SDK
 * exposes no category data, so a null status means the tile is simply absent.
 */
export function HomeTab({
  ctx, store, mapping, sfinNames, wfNames, balances, syncing, healing, doHeal,
  prunedDuplicates, unmappedAccounts, onIgnoreAccounts, uncategorized, dismissals, onDismissalsChange,
  isOpen, toggleCard, onBalancesChanged, onClearError, onError,
  companionVersion, telegramConfigured, amazonConfigured, checklistDismissed,
  onDismissChecklist, onNavigate, poolStatus, onOpenPool,
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

  return (
    <>
      {/* An account SimpleFin is offering that nothing is mapped to. First
          banner on the page because it is the only one that means data is
          MISSING rather than wrong: until it is mapped, every sync silently
          imports nothing from that account. Linking a bank at SimpleFin used
          to produce exactly this with no indication anywhere (Robinhood Gold,
          2026-08-13) — the account simply never appeared in Wealthfolio.

          Dismissal is a RECORDED decision ("Don't sync these"), never a
          cosmetic hide: an account silently dropped from this list would be
          exactly the silence the banner exists to end. It reappears if that
          decision is undone in the Accounts card. */}
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
              Map {unmappedAccounts.length === 1 ? 'it' : 'them'} in Settings → Accounts, or
              choose <b>Don&apos;t sync</b>.
            </div>
            <Why>
              Mapping changes no other setting, and there is no need to run setup again.
              Not every account needs syncing: Don&apos;t sync stops this reminder, and you
              can undo it from the Accounts card.
            </Why>
            <div className="sfin-banner-actions">
              {/* Names the card explicitly so the CTA lands on it open, rather
                  than on a tab where it is one of five collapsed headers. */}
              <Button variant="outline" onClick={() => onNavigate('settings', SETTINGS_CARD.accounts)}>
                Open Accounts
              </Button>
              {/* An unmapped account is not always a mistake — it can be one
                  the user has no intention of tracking. This banner shipped
                  with no dismissal at all, so that deliberate choice read as a
                  permanent warning with nothing to do about it. Records the
                  decision rather than hiding the banner: the same list also
                  silences the companion's Telegram notice, and it survives a
                  reload. */}
              <Button
                variant="ghost"
                onClick={() => onIgnoreAccounts(unmappedAccounts.map((a) => a.sfinAccountId))}
              >
                Don&apos;t sync {unmappedAccounts.length === 1 ? 'it' : 'these'}
              </Button>
            </div>
          </div>
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
                      This typically clears on its own in a few days.
                    </div>
                    <Why>
                      The bank&apos;s balance usually includes recent activity its transaction
                      list hasn&apos;t published yet; a transfer still in flight is the common
                      one. A deep scan re-checks the last 90 days if you would rather not wait.
                    </Why>
                  </>
                ) : (
                  <>
                    <div>
                      <b>{sfinNames[sfinId] ?? sfinId}</b>: Wealthfolio holds{' '}
                      <b>{money(Math.abs(drift), info.currency)}</b> more than the bank
                      reports (<b>{money(info.balance ?? 0, info.currency)}</b>).
                    </div>
                    <div className="sfin-banner-note">
                      Try a deep scan first. Don&apos;t add a plug here.
                    </div>
                    <Why>
                      Feed lag cannot cause this direction: lag makes the bank look ahead, not
                      behind. Something is likely recorded twice, or a withdrawal hasn&apos;t
                      imported. A deep scan checks the last 90 days; a plug would only widen
                      the gap.
                    </Why>
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
        {/* The accounts, as a count and whether any balance disagrees with the
            bank. The rows themselves live in Settings → Accounts (1.57); this
            tile is the way there. "Imported last run" is gone: the header under
            the title already says how many the last run imported. */}
        <button
          type="button"
          className="sfin-tile sfin-tile--toggle"
          aria-label={`Accounts: ${accountsSummary(mapping, balances)}`}
          onClick={() => onNavigate('settings', SETTINGS_CARD.accounts)}
        >
          <SectionLabel>Accounts</SectionLabel>
          <div className="sfin-tile-val">{mappedCount}</div>
          <div className="sfin-tile-sub">
            {driftAccounts.length > 0
              ? accountsSummary(mapping, balances).split(' · ')[1]
              // "Matches" only when every account was actually compared: an
              // unchecked balance is an absence of information (see the
              // three-state chip in AccountList), not a clean bill.
              : mappedCount > 0 && mappedEntries.every(([id]) => (balances[id] as { measured?: boolean } | undefined)?.measured === true)
                ? 'all match the bank'
                : 'not all checked yet'}
          </div>
        </button>
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
              aria-expanded={isOpen(HOME_CARD.uncategorized)}
              // Same rule as the page's Disclosure: only points at the panel
              // while the panel actually exists.
              {...(isOpen(HOME_CARD.uncategorized)
                ? { 'aria-controls': HOME_CARD.uncategorized }
                : {})}
              // The tile's own contents ("Needs a category" / "7" / "from your
              // companion") read as a fragmented accessible name; this is the
              // same wording the separate disclosure header used to carry.
              aria-label={`${uncatCount} need${uncatCount === 1 ? 's' : ''} a category`}
              onClick={() => toggleCard(HOME_CARD.uncategorized)}
            >
              <div className="sfin-tile-head">
                <SectionLabel>Needs a category</SectionLabel>
                <span className="sfin-chevron" data-open={isOpen(HOME_CARD.uncategorized)} aria-hidden>▼</span>
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
        {/* The pool's remaining money, whole dollars like the report figures.
            Upcoming and gone phases render nothing — the same vanish-don't-
            explain rule the formatters follow. */}
        {poolStatus && (poolStatus.phase === 'active' || poolStatus.phase === 'ended') && (() => {
          const left = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
            .format(Math.abs(poolStatus.remainingCents) / 100);
          // The verdict the reports give, in the same words: whether the money
          // lasts, not a weekly rate the reader has to judge for themselves.
          const verdict = poolStatus.phase === 'ended'
            ? (poolStatus.remainingCents >= 0 ? 'left when the pool ended' : 'over when the pool ended')
            : poolStatus.spentCents <= 0
              ? `until ${shortDate(poolStatus.endDate)}`
              : poolStatus.runsOutBeforeEnd && poolStatus.projectedRunOutDate
                ? `out by ${shortDate(poolStatus.projectedRunOutDate)}`
                : `lasts past ${shortDate(poolStatus.endDate)}`;
          return (
            <button
              type="button"
              className="sfin-tile sfin-tile--toggle"
              title={`${poolStatus.startDate} until ${poolStatus.endDate}`}
              // One phrase for assistive tech, instead of the tile's three
              // fragments read run-together.
              aria-label={`Semester pool: ${left} ${poolStatus.remainingCents < 0 ? 'over' : 'left'}, ${verdict}`}
              onClick={onOpenPool}
            >
              <SectionLabel>Semester pool</SectionLabel>
              <div className="sfin-tile-val">{left}</div>
              <div className="sfin-tile-sub">{verdict}</div>
            </button>
          );
        })()}
      </div>

      {uncategorized && isOpen(HOME_CARD.uncategorized) && (
        <UncategorizedList
          rows={visibleRows}
          total={uncatCount}
          id={HOME_CARD.uncategorized}
          onDismiss={dismiss}
          justDismissed={justDismissed}
          onUndo={undo}
          onOpenActivities={() => { ctx.api.navigation.navigate('/activities').catch(() => {}); }}
        />
      )}

    </>
  );
}
