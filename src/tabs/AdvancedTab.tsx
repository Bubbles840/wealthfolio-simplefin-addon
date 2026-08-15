import React, { useCallback, useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync } from '../utils/sync';
import { Button, CollapsibleCard, ErrorBox } from '../components/ui';
import { AmazonCard, type AmazonDraftState } from '../components/AmazonCard';
import { AccountMapper } from '../components/AccountMapper';
import { RuleEditor } from '../components/RuleEditor';
import { fetchAccounts } from '../utils/simplefin';
import type { SecretsStore, CategoryCatalogEntry } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { MappingRule, SimplefinAccount, AccountMapping } from '../../shared/types';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
 *  silently forgets that card's last-open state, which is fine, but a stored
 *  blob keyed on the old string would never match again. */
export const CARD = {
  accounts: 'accounts',
  autoSync: 'auto-sync',
  docker: 'docker',
  amazon: 'amazon',
  amazonGuide: 'amazon-guide',
  rules: 'rules',
} as const;

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  scheduler: Scheduler;
  onReset: () => void;
  /** The Amazon card's draft, owned by the page: it holds an app password, and
   *  this panel is unmounted the moment another tab is selected. Passed straight
   *  through — nothing else on this tab reads it. */
  amazon: AmazonDraftState;
  /** Loaded once by the page (the Notifications tab needs it too), so it
   *  arrives as a prop rather than being fetched a second time here. */
  categories: CategoryCatalogEntry[];
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

/**
 * Everything that is set up once and then only checked, plus the destructive
 * reset flow.
 *
 * Owns its own auto-sync / auto-heal / transaction-rule state, loaded here
 * rather than in the page's mega-load: nothing outside this tab reads any of
 * it (the scheduler itself is (re)started elsewhere — see `addon.tsx` — so a
 * tab that has never been opened still keeps syncing on schedule).
 */
export function AdvancedTab({
  ctx, store, scheduler, onReset, amazon, categories, isOpen, toggleCard,
}: Props) {
  const [scheduleHours, setScheduleHours] = useState<number | null>(null);
  const [autoHeal, setAutoHeal] = useState(false);
  const [autoAdjust, setAutoAdjust] = useState(false);
  const [rules, setRules] = useState<MappingRule[]>([]);
  // Reset's own two-step inline confirm. window.confirm is silently
  // suppressed in the addon sandbox (the iframe is sandbox="allow-scripts"
  // with no allow-modals), which is why confirmation is rendered inline
  // instead of via a native dialog.
  const [confirmingReset, setConfirmingReset] = useState(false);

  // ── Accounts card ────────────────────────────────────────────────────────
  // The live SimpleFin account list, fetched on demand rather than with the
  // rest of this tab's state: it costs a network round-trip to the bridge, and
  // the overwhelmingly common visit to this tab is for something else.
  const [sfAccounts, setSfAccounts] = useState<SimplefinAccount[] | null>(null);
  const [mapping, setMapping] = useState<AccountMapping>({});
  /**
   * Whether the stored mapping has actually been READ yet — `{}` alone cannot
   * say, and the difference is destructive here. `AccountMapper` snapshots
   * `initialMapping` into its own state at mount and never re-reads it, so a
   * mapper mounted before the load resolved would show every account
   * unmapped; mapping one account and saving would then write a
   * single-entry mapping over all the others, silently un-syncing them.
   *
   * Unlikely (the secret read is local and the account list needs a bridge
   * round-trip) but cheap to make impossible.
   */
  const [mappingLoaded, setMappingLoaded] = useState(false);
  /** Set when that read REJECTED, so the card can say so instead of showing a
   *  "Loading…" line that will never resolve. Kept separate from
   *  `mappingLoaded`, which stays false — the mapper must not render over a
   *  mapping we failed to read. */
  const [mappingLoadFailed, setMappingLoadFailed] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState('');
  const [mappingSaved, setMappingSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      store.getSyncScheduleHours(),
      store.getAutoHeal(),
      store.getAutoAdjust(),
      store.getMappingRules(),
      store.getAccountMapping(),
    ]).then(([hours, heal, adjust, r, m]) => {
      setScheduleHours(hours);
      setAutoHeal(heal);
      setAutoAdjust(adjust);
      setRules(r);
      setMapping(m ?? {});
      setMappingLoaded(true);
    }).catch(() => {
      // `mappingLoaded` deliberately stays FALSE: it gates the mapper, and
      // rendering one over an unread mapping is the destructive case it exists
      // to prevent (map one account, save, and the unread ones are dropped).
      // What this fixes is the other half — an unhandled rejection, and a card
      // that sat on "Loading…" forever with nothing saying why.
      setMappingLoadFailed(true);
    });
  }, [store]);

  /**
   * Re-reads the account list from SimpleFin so newly-linked banks appear
   * without re-running setup (which would clear every other setting).
   *
   * Also refreshes the stored account NAMES, the same way setup does: those
   * names label the balance rows on the Overview, and an account linked after
   * setup has never had a name recorded for it.
   */
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError('');
    setMappingSaved(false);
    try {
      const accessUrl = await store.getAccessUrl();
      if (!accessUrl) {
        setAccountsError('No SimpleFin connection — run setup first.');
        return;
      }
      const authKey = await store.getAuthB64Key();
      // A one-day window: this needs the account LIST, not history, and the
      // narrow window keeps a refresh cheap on the bridge.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const set = await fetchAccounts(accessUrl, yesterday, ctx.api.network, authKey);
      if (set.errors.length > 0) setAccountsError(`SimpleFin: ${set.errors.join('; ')}`);
      setSfAccounts(set.accounts);
      // MERGED into the stored names, never replacing them. SimpleFin can
      // return one institution's accounts alongside an error for another, and a
      // wholesale write would erase the names of everything missing from this
      // response — leaving the Overview's balance rows labelled with raw
      // SimpleFin ids until some later refresh happened to be complete. Setup
      // can overwrite (the user is watching it); a background refresh cannot.
      const existingNames = await store.getAccountNames().catch(() => ({}));
      await store.setAccountNames({
        ...existingNames,
        ...Object.fromEntries(set.accounts.map((a) => [a.id, a.name])),
      }).catch(() => {});
    } catch (e: any) {
      setAccountsError(e?.message ?? 'Could not reach SimpleFin');
    } finally {
      setAccountsLoading(false);
    }
  }, [ctx, store]);

  const saveMapping = useCallback(async (m: AccountMapping) => {
    setAccountsError('');
    try {
      await store.setAccountMapping(m);
      setMapping(m);
      setMappingSaved(true);
    } catch (e: any) {
      setAccountsError(e?.message ?? 'Failed to save account mapping');
    }
  }, [store]);

  const changeInterval = useCallback(async (hours: number) => {
    setScheduleHours(hours);
    await store.setSyncScheduleHours(hours);
    scheduler.stop();
    if (hours > 0) {
      scheduler.start(hours, () => store.getLastSyncAt(), () => runSync(ctx, store));
    }
  }, [ctx, store, scheduler]);

  const handleReset = useCallback(async () => {
    scheduler.stop();
    await store.clearAll();
    onReset();
  }, [scheduler, store, onReset]);

  // ── Collapsed-header summaries ───────────────────────────────────────────
  // Each collapsible card reports its own configuration as text in its header,
  // so a closed card still answers "is this on, and set to what?". The
  // Auto-sync summary also replaces the Overview's old auto-sync stat tile,
  // deleted on the understanding that this header carries that information now.
  const autoSyncSummary = `${scheduleHours ? `Every ${scheduleHours}h` : 'Off'} · ${
    autoAdjust ? 'aggressive auto re-scan' : autoHeal ? 'auto re-scan on' : 'auto re-scan off'
  }`;

  const rulesSummary =
    rules.length === 0
      ? 'None — using the +/− defaults'
      : `${rules.length} rule${rules.length === 1 ? '' : 's'}`;

  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const accountsSummary = `${mappedCount} account${mappedCount === 1 ? '' : 's'} mapped`;

  return (
    <>
      {/* First card on the tab: linking a new account at your bank is the one
          thing here that silently changes what syncs, and until this existed
          the only way to map it was Reset — which clears every other setting.
          Fetch is on open, not on mount: it costs a bridge round-trip and most
          visits to this tab are for something else. */}
      <CollapsibleCard
        id={CARD.accounts}
        title="Accounts"
        summary={accountsSummary}
        open={isOpen(CARD.accounts)}
        onToggle={() => {
          const opening = !isOpen(CARD.accounts);
          toggleCard(CARD.accounts);
          if (opening && sfAccounts === null && !accountsLoading) void loadAccounts();
        }}
      >
        <div className="sfin-subtle" style={{ marginBottom: 12 }}>
          Accounts you link at SimpleFin after setup are not synced until they are
          mapped here. Clearing a row stops syncing that account — transactions
          already imported into Wealthfolio stay.
        </div>

        {accountsError && <ErrorBox>{accountsError}</ErrorBox>}

        {mappingLoadFailed ? (
          <ErrorBox>
            Could not read your saved account mapping, so the mapper is hidden — editing
            it from here could overwrite mappings that were not loaded. Reload the page
            and try again.
          </ErrorBox>
        ) : (accountsLoading && sfAccounts === null) || (sfAccounts !== null && !mappingLoaded) ? (
          <div className="sfin-subtle">Loading accounts from SimpleFin…</div>
        ) : sfAccounts === null ? (
          <Button variant="outline" onClick={() => void loadAccounts()}>
            Load accounts
          </Button>
        ) : (
          <>
            <AccountMapper
              ctx={ctx}
              simplefinAccounts={sfAccounts}
              initialMapping={mapping}
              onSave={saveMapping}
            />
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button variant="ghost" onClick={() => void loadAccounts()} disabled={accountsLoading}>
                {accountsLoading ? 'Refreshing…' : 'Refresh from SimpleFin'}
              </Button>
              {/* Confirmation is worth a line of its own: the mapper's Save
                  button gives no feedback, and saving a mapping that changes
                  what syncs should not look identical to doing nothing. */}
              {mappingSaved && <span className="sfin-subtle">Mapping saved.</span>}
            </div>
          </>
        )}
      </CollapsibleCard>

      <CollapsibleCard
        id={CARD.autoSync}
        title="Auto-sync"
        summary={autoSyncSummary}
        open={isOpen(CARD.autoSync)}
        onToggle={() => toggleCard(CARD.autoSync)}
      >
        <div className="sfin-field-row">
          <label htmlFor="sfin-interval" className="sfin-section-label">
            Auto-sync interval
          </label>
          <select
            id="sfin-interval"
            className="sfin-select"
            value={scheduleHours ?? 0}
            onChange={(e) => changeInterval(Number(e.target.value))}
          >
            <option value={0}>Off</option>
            <option value={1}>Every 1 hour</option>
            <option value={4}>Every 4 hours</option>
            <option value={8}>Every 8 hours</option>
            <option value={24}>Every 24 hours</option>
          </select>
        </div>
        <div className="sfin-subtle sfin-autosync-hint">
          Syncs when this page is open and it&apos;s been this long since the last run.
        </div>

        <div className="sfin-checks sfin-autosync-checks">
          <label className="sfin-check">
            <input
              type="checkbox"
              checked={autoHeal}
              onChange={async (e) => {
                setAutoHeal(e.target.checked);
                await store.setAutoHeal(e.target.checked);
              }}
            />
            <span>
              {/* Plain label; the title keeps the term the logs, the docs and the
                  companion's own setting use, exactly as the header's Deep scan
                  button does. */}
              <span className="sfin-check-name" title="Called auto-heal in the logs and in the companion">
                Auto re-scan
              </span>
              <span className="sfin-subtle">
                {' '}— re-scan ~45 days each sync to catch missing transactions and check
                balances. Balance adjustments stay manual.
              </span>
            </span>
          </label>

          <label className="sfin-check">
            <input
              type="checkbox"
              checked={autoAdjust}
              onChange={async (e) => {
                setAutoAdjust(e.target.checked);
                await store.setAutoAdjust(e.target.checked);
              }}
            />
            <span>
              <span
                className="sfin-check-name"
                title="Called aggressive auto-heal in the logs and in the companion"
              >
                Aggressively auto re-scan
              </span>
              <span className="sfin-subtle">
                {' '}— also auto-insert balance adjustments for any residual, without asking
                (includes the re-scan). Forces balances to match your bank on every sync.
              </span>
            </span>
          </label>
        </div>
      </CollapsibleCard>

      {/* Its own card rather than a nested disclosure inside Auto-sync: with
          both collapsed the two headers cost less than a card containing a
          second collapse control, and each gets a summary of its own. There is
          no state to report here — the addon cannot see whether the container
          is running — so the summary says what it is for. */}
      <CollapsibleCard
        id={CARD.docker}
        title="Background sync (Docker)"
        summary="Keeps syncing even when Wealthfolio is closed"
        open={isOpen(CARD.docker)}
        onToggle={() => toggleCard(CARD.docker)}
      >
        <div>
          <div className="sfin-subtle sfin-docker-intro">
            Add this service to your <code>docker-compose.yml</code>. You can customize the sync rate via <code>SYNC_SCHEDULE</code>:
          </div>
          {/* The snippet has to be COMPLETE, because it is the only setup
              instruction most people will ever read. It used to set neither
              WEALTHFOLIO_DB_PATH nor a mount for the database, so following it
              exactly produced a companion that synced fine and a "Needs a
              category" tile that never appeared, with nothing on screen to say
              why. The directory is mounted, not the .db file: reading live data
              needs the -wal/-shm files beside it — see the comment in
              companion/src/sqlite-native.ts — and a file-only mount silently
              serves whatever was last checkpointed, which has been observed two
              days stale. */}
          <pre className="sfin-pre sfin-docker-pre">
            {`services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    container_name: simplefin-sync
    restart: always
    network_mode: host
    environment:
      - WEALTHFOLIO_API_URL=http://127.0.0.1:8088
      - WEALTHFOLIO_PASSWORD=your_wealthfolio_password
      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db
      - SYNC_SCHEDULE=0 */6 * * *          # Change cron schedule here (e.g. 0 */3 * * * for every 3h)
      - MIN_SYNC_INTERVAL_HOURS=1          # Minimum interval cooldown between syncs
    volumes:
      # The FOLDER holding wealthfolio.db, read-only — not the .db file itself,
      # which hides the -wal file and serves stale data.
      - /path/to/wealthfolio:/mnt/wealthfolio:ro`}
          </pre>
          <div className="sfin-subtle sfin-docker-note">
            The database mount is what lets the companion count spending that still
            needs a category, and fill in category names and budgets in its reports.
            Point it at the folder that contains <code>wealthfolio.db</code>.
          </div>
        </div>
      </CollapsibleCard>

      {/* Directly below the Docker card: it is the companion that reads the
          mailbox, so this is only useful to someone who has just set that up. */}
      <AmazonCard
        amazon={amazon}
        cardId={CARD.amazon}
        guideId={CARD.amazonGuide}
        open={isOpen(CARD.amazon)}
        guideOpen={isOpen(CARD.amazonGuide)}
        onToggle={() => toggleCard(CARD.amazon)}
        onToggleGuide={() => toggleCard(CARD.amazonGuide)}
        categories={categories}
      />

      {/* The card's own open state replaces the old "Edit"/"Done" toggle: this
          card had a read-only list AND a disclosure to reach the editor, which
          was two controls for one question. The header summary now answers "do
          I have rules?", and opening goes straight to the editor — which lists
          every rule and restates the +/− defaults itself, so nothing is lost. */}
      <CollapsibleCard
        id={CARD.rules}
        title="Transaction rules"
        summary={rulesSummary}
        open={isOpen(CARD.rules)}
        onToggle={() => toggleCard(CARD.rules)}
      >
        <RuleEditor
          rules={rules}
          onChange={async (r) => {
            setRules(r);
            await store.setMappingRules(r);
          }}
        />
      </CollapsibleCard>

      <div className="sfin-callout sfin-advanced-callout">
        Imported bank transactions appear under <strong>Activities</strong>. To see them in the{' '}
        <strong>Spending</strong> tab with categories and budgets, enable the Spending Tracker for
        your mapped accounts: <strong>Settings → Spending Tracker</strong>.
      </div>

      {/* A destructive boundary, not a bare button under unrelated settings:
          the old layout put "Reset Setup" directly below the Spending-Tracker
          callout with nothing to mark it apart from everything else on the
          page.

          The copy below has to match what `clearAll` actually deletes: every
          key in `SecretsStore`'s KEYS map, which is everything this tab (and
          Notifications) configures — not just the account mapping. */}
      <div className="sfin-danger-card">
        <b>Reset connection</b>
        <div className="sfin-subtle sfin-danger-note">
          Clears every SimpleFin Sync setting — the connection, account mapping, sync
          schedule, transaction rules, and any Telegram or Amazon setup. Transactions
          already imported into Wealthfolio stay.
        </div>
        <div className="sfin-danger-actions">
          {!confirmingReset ? (
            <Button variant="destructive" onClick={() => setConfirmingReset(true)}>
              Reset…
            </Button>
          ) : (
            <>
              <Button variant="destructive" onClick={handleReset}>Yes, reset everything</Button>
              <Button variant="ghost" onClick={() => setConfirmingReset(false)}>Cancel</Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
