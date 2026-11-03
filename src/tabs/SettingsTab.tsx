import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync } from '../utils/sync';
import { Button, CollapsibleCard, ErrorBox, Why } from '../components/ui';
import { AmazonCard, type AmazonDraftState } from '../components/AmazonCard';
import { AccountMapper } from '../components/AccountMapper';
import { RuleEditor } from '../components/RuleEditor';
import { mappingRuleProblem } from '../../shared/mapper';
import { IgnoreRulesEditor } from '../components/IgnoreRulesEditor';
import { AccountList, accountsSummary } from '../components/AccountList';
import { AccountAudit, ChecksCard, checksSummary } from '../components/AuditViews';
import { DockerSnippet } from '../components/DockerSnippet';
import type { AuditSnapshotRead } from '../../shared/audit-snapshot';
import { PoolCard } from '../components/PoolCard';
import { shortDate } from '../../shared/telegram';
import type { SemesterPoolConfig } from '../../shared/pool';
import { NotificationsTab, type TelegramDraftState } from './NotificationsTab';
import { ReceiptReaderConnect } from '../components/ReceiptReaderConnect';
import { fetchAccounts } from '../utils/simplefin';
import type { SecretsStore, CategoryCatalogEntry, AccountBalanceInfo } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { MappingRule, SimplefinAccount, AccountMapping } from '../../shared/types';
import type { LoanLinks } from '../../shared/loan-balances';
import type { RelinkDecisions } from '../../shared/relink';
import { companionUnderstandsRelinks } from '../../shared/version';
import { accountCreatedChange } from '../../shared/change-entries';
import { directCallLine } from '../../shared/simplefin-budget';
import { ChangeLogCard, syncNowSentence } from '../components/ChangeLogCard';
import { emptySyncOverrides, hasTxOverride, removeOverrideRow, type OverrideRow } from '../../shared/sync-overrides';
import type { ChangeLogItem } from '../../shared/change-log';
import type { UndoOp } from '../../shared/change-undo';
import { undoFromApp } from '../utils/change-undo';
import type { LinkPair } from '../../shared/audit-link';
import { linkFromApp, notTransferFromApp } from '../utils/audit-fix';
import type { HeldTransfer } from '../../shared/held-transfers';
import { ruleAccountOptions, type IgnoreRule } from '../../shared/ignore-rules';
import { isSimplefinNotice } from '../../shared/simplefin-payload';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
 *  silently forgets that card's last-open state, which is fine, but a stored
 *  blob keyed on the old string would never match again. */
/** The intervals offered here and in setup. The bridge refreshes from the bank
 *  every few hours, so anything shorter than 4 fetches nothing new. */
export const SYNC_INTERVALS: readonly number[] = [4, 6, 12, 24];

/** Another writer (the companion's payback rules) changed the stored list since this page read it. */
export const RULES_CHANGED_ELSEWHERE = 'Your rules changed elsewhere — reload them first.';

export const CARD = {
  accounts: 'accounts',
  autoSync: 'auto-sync',
  docker: 'docker',
  amazon: 'amazon',
  amazonGuide: 'amazon-guide',
  rules: 'rules',
  ignoreRules: 'ignore-rules',
  pool: 'pool',
  changeLog: 'change-log',
  checks: 'checks',
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
  /** Loaded once by the page (the Notifications cards need it too), so it
   *  arrives as a prop rather than being fetched a second time here. */
  categories: CategoryCatalogEntry[];
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
  /** The page's mapping, balance snapshots and names, for the account rows in
   *  the Accounts card (they moved here from Overview in 1.57). The PAGE's
   *  mapping, not this tab's own: the rows and Home's Accounts tile must count
   *  the same thing, and the names only make sense next to the mapping they
   *  were read with. */
  accountMapping: AccountMapping;
  balances: Record<string, AccountBalanceInfo>;
  sfinNames: Record<string, string>;
  wfNames: Record<string, string>;
  /** The Telegram draft, owned by the page so it outlives this panel. */
  telegramDraft: TelegramDraftState;
  /** Called after this tab writes the mapping or the account names, so the
   *  page re-reads both — otherwise a just-mapped account shows as its raw id
   *  with "account no longer exists". */
  onAccountsChanged?: () => void;
  /** 2c: the companion's audit snapshot, for the Checks card and the
   *  account chips. Absent (an older page): neither is shown. */
  auditSnapshot?: AuditSnapshotRead | null;
  /** 2c R2: after a fix on the Checks card, the page reads the snapshot again. */
  onAuditChanged?: () => void;
}

/**
 * Settings: everything configurable, on one page, under plain group headings
 * (1.57 — this was the Advanced tab, and absorbed Notifications and the parts
 * of Overview that were configuration).
 *
 * Originally: everything that is set up once and then only checked, plus the
 * destructive reset flow.
 *
 * Owns its own auto-sync / auto-heal / transaction-rule state, loaded here
 * rather than in the page's mega-load: nothing outside this tab reads any of
 * it (the scheduler itself is (re)started elsewhere — see `addon.tsx` — so a
 * tab that has never been opened still keeps syncing on schedule).
 */
export function SettingsTab({
  ctx, store, scheduler, onReset, amazon, categories, isOpen, toggleCard,
  accountMapping, balances, sfinNames, wfNames, telegramDraft, onAccountsChanged, auditSnapshot, onAuditChanged,
}: Props) {
  // The stored pool, for the card's collapsed summary. Read here and updated by
  // the card itself on Set / Clear: the companion's published status would lag
  // a change until the next sync, and say "Not set" over a card showing one.
  const [poolCfg, setPoolCfg] = useState<SemesterPoolConfig | null>(null);
  useEffect(() => {
    store.getSemesterPool?.().then((c) => setPoolCfg(c ?? null)).catch(() => {});
  }, [store]);
  const poolSummary = poolCfg
    ? `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(poolCfg.amountCents / 100)} until ${shortDate(poolCfg.endDate)}`
    : 'Not set';
  // 2c R2: Link on the Checks card, through the add-on's own host.
  const linkChecks = useCallback((pairs: LinkPair[]) => linkFromApp(ctx, store, pairs), [ctx, store]);
  const notTransfer = useCallback((h: HeldTransfer) => notTransferFromApp(ctx, store, h), [ctx, store]);
  const loadMarked = useCallback(async () => {
    const loaded = await store.readSyncOverrides?.();
    if (!loaded || loaded.unreadable) return null;
    return new Set(Object.keys(loaded.overrides.tx).filter((k) => hasTxOverride(loaded.overrides, k, 'notTransfer')));
  }, [store]);
  const [scheduleHours, setScheduleHours] = useState<number | null>(null);
  const [autoHeal, setAutoHeal] = useState(false);
  const [autoAdjust, setAutoAdjust] = useState(false);
  const [rules, setRules] = useState<MappingRule[]>([]);
  /** The rules as last read or saved here. Two writers (this page and the companion's payback
   *  rules) share the list, so a save re-reads it first and refuses when it is no longer this. */
  const knownRules = useRef<string>('[]');
  const rulesQueue = useRef<Promise<void>>(Promise.resolve());
  const [rulesNote, setRulesNote] = useState('');
  const [ignoreRules, setIgnoreRules] = useState<IgnoreRule[]>([]);
  /** The stored ignore rules could not be read: the editor turns read-only. */
  const [ignoreRulesUnreadable, setIgnoreRulesUnreadable] = useState(false);
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
  /** That list came with SimpleFin errors: the mapper asks no reconnection question over it. */
  const [sfAccountsHadErrors, setSfAccountsHadErrors] = useState(false);
  const [mapping, setMapping] = useState<AccountMapping>({});
  const [loanLinks, setLoanLinks] = useState<LoanLinks>({});
  /** null until read, and when the read fails: the mapper then asks nothing,
   *  since saving answers over an unread document would drop the others. */
  const [relinkDecisions, setRelinkDecisions] = useState<RelinkDecisions | null>(null);
  /** That read failed (a document it cannot read, most often): said above the
   *  mapper, which would otherwise just show no questions and no Undo. */
  const [relinkDecisionsUnreadable, setRelinkDecisionsUnreadable] = useState(false);
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
  /** SimpleFin accounts the user chose not to sync (from the Home banner).
   *  Surfaced here because that is the only place the decision can be undone —
   *  a preference with no visible off-switch is a trap. */
  const [ignoredAccounts, setIgnoredAccounts] = useState<string[]>([]);
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
      // Optional-called: a store without it (an older build, a test double)
      // would otherwise throw SYNCHRONOUSLY here and take the whole tab's
      // state load down with it — every card would then render defaults as
      // though they were the stored settings.
      store.getIgnoredAccounts?.() ?? [],
      store.getLoanLinks?.() ?? {},
    ]).then(([hours, heal, adjust, r, m, ignored, links]) => {
      // Optional-called: a store without it (an older build, a test double) reads none, quietly.
      if (typeof store.readRelinkDecisions === 'function') {
        Promise.resolve().then(() => store.readRelinkDecisions()).then((d) => {
          setRelinkDecisions(d);
          setRelinkDecisionsUnreadable(false);
        }).catch(() => {
          setRelinkDecisions(null);
          setRelinkDecisionsUnreadable(true);
        });
      }
      setScheduleHours(hours);
      setAutoHeal(heal);
      setAutoAdjust(adjust);
      setRules(r);
      knownRules.current = JSON.stringify(r);
      setMapping(m ?? {});
      setIgnoredAccounts(ignored ?? []);
      setLoanLinks(links ?? {});
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
   * names label the balance rows in this Accounts card, and an account linked after
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
      // A refresh is a SimpleFin download like any other: it counts (C5).
      const refused = await directCallLine(store, 'setup');
      if (refused) { setAccountsError(refused); return; }
      const authKey = await store.getAuthB64Key();
      // A one-day window: this needs the account LIST, not history, and the
      // narrow window keeps a refresh cheap on the bridge.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const set = await fetchAccounts(accessUrl, yesterday, ctx.api.network, authKey);
      if (set.errors.length > 0) setAccountsError(`SimpleFin: ${set.errors.join('; ')}`);
      // A notice the sync ignores too is no sign that an account is down.
      setSfAccountsHadErrors(set.errors.some((e) => !isSimplefinNotice(e)));
      setSfAccounts(set.accounts);
      // MERGED into the stored names, never replacing them. SimpleFin can
      // return one institution's accounts alongside an error for another, and a
      // wholesale write would erase the names of everything missing from this
      // response — leaving the balance rows labelled with raw
      // SimpleFin ids until some later refresh happened to be complete. Setup
      // can overwrite (the user is watching it); a background refresh cannot.
      const existingNames = await store.getAccountNames().catch(() => ({}));
      await store.setAccountNames({
        ...existingNames,
        ...Object.fromEntries(set.accounts.map((a) => [a.id, a.name])),
      }).catch(() => {});
      onAccountsChanged?.();
    } catch (e: any) {
      setAccountsError(e?.message ?? 'Could not reach SimpleFin');
    } finally {
      setAccountsLoading(false);
    }
  }, [ctx, store, onAccountsChanged]);

  const saveMapping = useCallback(async (m: AccountMapping, links: LoanLinks) => {
    setAccountsError('');
    try {
      await store.setAccountMapping(m);
      setMapping(m);
      await store.setLoanLinks?.(links);
      setLoanLinks(links);
      setMappingSaved(true);
      onAccountsChanged?.();
      // Mapping an account IS the decision to sync it, so it can no longer be
      // on the do-not-sync list. Leaving it there would be harmless today
      // (the list only suppresses a reminder about UNMAPPED accounts) but
      // wrong the moment the mapping is cleared again: the account would go
      // quiet with no reminder, which is the failure this whole feature
      // exists to prevent.
      const nowMapped = [...Object.keys(m).filter((id) => !!m[id]), ...Object.keys(links)];
      if (ignoredAccounts.some((id) => nowMapped.includes(id))) {
        const next = ignoredAccounts.filter((id) => !nowMapped.includes(id));
        setIgnoredAccounts(next);
        await store.setIgnoredAccounts(next).catch(() => {});
      }
    } catch (e: any) {
      setAccountsError(e?.message ?? 'Failed to save account mapping');
    }
  }, [store, ignoredAccounts, onAccountsChanged]);

  /** Undo the do-not-sync decision for every account it covers. Coarse on
   *  purpose: the list is short, and per-row undo would need the mapper to
   *  grow a second control for a preference most users never set. */
  const clearIgnored = useCallback(async () => {
    setIgnoredAccounts([]);
    try {
      await store.setIgnoredAccounts([]);
    } catch (e: any) {
      setAccountsError(e?.message ?? 'Could not update that preference');
      await store.getIgnoredAccounts().then(setIgnoredAccounts).catch(() => {});
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

  /** Saves the edited list unless the stored one changed since this page last read it.
   *  A rule that would match every transaction (an empty pattern, a new row not
   *  yet typed into) stays on screen but is never stored: see `mappingRuleProblem`. */
  const saveRules = useCallback((next: MappingRule[]) => {
    setRules(next);
    const run = async () => {
      try {
        const fresh = JSON.stringify(await store.getMappingRules());
        if (fresh !== knownRules.current) {
          setRulesNote(RULES_CHANGED_ELSEWHERE);
          return;
        }
        const usable = next.filter((r) => mappingRuleProblem(r) === null);
        await store.setMappingRules(usable);
        knownRules.current = JSON.stringify(usable);
        setRulesNote('');
      } catch (e: any) {
        setRulesNote(String(e?.message ?? e));
      }
    };
    rulesQueue.current = rulesQueue.current.then(run, run);
    return rulesQueue.current;
  }, [store]);
  const reloadRules = useCallback(async () => {
    try {
      const fresh = await store.getMappingRules();
      knownRules.current = JSON.stringify(fresh);
      setRules(fresh);
      setRulesNote('');
    } catch {
      setRulesNote("Couldn't reload your rules — try again.");
    }
  }, [store]);

  // Ignore rules (shared/ignore-rules.ts). Their own read, not part of the
  // Promise.all above: a failure there hides the account mapper, and an
  // unreadable rule list is no reason to. Optional-called for older stores and
  // test doubles, which then show no card.
  useEffect(() => {
    store.readIgnoreRules?.().then((read) => {
      if (read.kind === 'corrupt') setIgnoreRulesUnreadable(true);
      else setIgnoreRules(read.kind === 'ok' ? read.list : []);
    }).catch(() => setIgnoreRulesUnreadable(true));
  }, [store]);
  const saveIgnoreRules = useCallback(async (next: IgnoreRule[]) => {
    await store.setIgnoreRules(next);
    setIgnoreRules(next);
  }, [store]);
  /** The preview's feed: one SimpleFin download, made only when the person asks.
   *  Counted as a manual call (the 20 and the 5-minute gap): the button can be
   *  clicked again and again, and the headroom past 20 is Setup's and Refresh's. */
  const loadIgnorePreview = useCallback(async (days: number) => {
    const accessUrl = await store.getAccessUrl();
    if (!accessUrl) throw new Error('No SimpleFin connection — run setup first.');
    const refused = await directCallLine(store, 'manual');
    if (refused) throw new Error(refused);
    const authKey = await store.getAuthB64Key();
    const set = await fetchAccounts(accessUrl, new Date(Date.now() - days * 24 * 60 * 60 * 1000), ctx.api.network, authKey);
    return { accounts: set.accounts, errors: set.errors };
  }, [ctx, store]);

  // Stable, so the card reads once each time it opens. Optional-called: an
  // older store (or a test double) has no change log, which reads as empty.
  const loadChangeLog = useCallback(
    async () => (store.getChangeLog ? store.getChangeLog() : { entries: [], gaps: [], trimmed: 0, unreadable: [] }),
    [store],
  );
  // R2: Undo and Redo, the companion's version (the gate and the Telegram
  // pointer), Sync now (the Sync page's own forced run) and "Your overrides".
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
  /** The mapped accounts, the only ones a rule reaches. An account a confirmed
   *  re-link retired folds into the one that replaced it, but only once the
   *  companion reads confirmed re-links: an older one matches exact ids, and the
   *  editor must say what the scheduled syncs will do. */
  const ignoreRuleAccounts = useMemo(
    () => ruleAccountOptions(
      accountMapping, sfinNames,
      companionUnderstandsRelinks(companionVersion) ? relinkDecisions?.confirmed ?? [] : [],
      wfNames, loanLinks,
    ),
    [accountMapping, sfinNames, relinkDecisions, companionVersion, wfNames, loanLinks],
  );
  useEffect(() => {
    store.getCompanionVersion?.().then((v) => setCompanionVersion(v ?? null)).catch(() => {});
  }, [store]);
  const undoChange = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const syncNowForLog = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true, manual: true })), [ctx, store]);
  const loadOverrides = useCallback(
    async () => (store.readSyncOverrides ? store.readSyncOverrides() : { overrides: emptySyncOverrides(), unreadable: false }),
    [store],
  );
  const removeOverride = useCallback(async (row: OverrideRow, undoCovers: boolean) => {
    await store.editSyncOverrides?.((o) => removeOverrideRow(o, row, undoCovers));
  }, [store]);

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

  const ignoreRulesSummary = ignoreRulesUnreadable
    ? "Can't be read"
    : ignoreRules.length === 0
      ? 'None — every transaction is imported'
      : `Ignoring ${ignoreRules.length} pattern${ignoreRules.length === 1 ? '' : 's'}`;


  return (
    <>
      <h3 className="sfin-settings-group">Accounts</h3>
      {/* First card on the tab: linking a new account at your bank is the one
          thing here that silently changes what syncs, and until this existed
          the only way to map it was Reset — which clears every other setting.
          Fetch is on open, not on mount: it costs a bridge round-trip and most
          visits to this tab are for something else. */}
      <CollapsibleCard
        id={CARD.accounts}
        title="Accounts"
        summary={accountsSummary(accountMapping, balances)}
        open={isOpen(CARD.accounts)}
        // Opening shows the balances, from local snapshots. The bridge is asked
        // for the live account list only when "Edit mapping" is tapped: this
        // card is now opened mostly to look, and a look must not cost a
        // SimpleFin round-trip every time.
        onToggle={() => toggleCard(CARD.accounts)}
      >
        {/* Not over a mapping this tab failed to read: "No accounts mapped
            yet." beside "Could not read your saved account mapping" would be
            two contradicting statements. */}
        {!mappingLoadFailed && <AccountList
          mapping={accountMapping}
          balances={balances}
          sfinNames={sfinNames}
          wfNames={wfNames}
          onOpenAccount={(id) => { ctx.api.navigation.navigate(`/accounts/${id}`).catch(() => {}); }}
          renderExplanation={auditSnapshot
            ? (wfId) => <AccountAudit read={auditSnapshot} wfAccountId={wfId} companionVersion={companionVersion} now={new Date()} />
            : undefined}
        />}
        <div className="sfin-divider" />
        <div className="sfin-subtle" style={{ marginBottom: 12 }}>
          Accounts you link at SimpleFin after setup are not synced until they are
          mapped here. Clearing a row stops syncing that account — transactions
          already imported into Wealthfolio stay.
        </div>

        {/* The only place the Home banner's "Don't sync these" can be
            undone. A stored preference the user cannot see or reverse would be
            worse than the nagging it replaced. Names come from the live feed
            when it has been fetched, falling back to the raw id so an entry is
            never invisible. */}
        {ignoredAccounts.length > 0 && (
          <div className="sfin-callout" style={{ marginBottom: 12 }}>
            <div>
              <b>{ignoredAccounts.length} account{ignoredAccounts.length === 1 ? '' : 's'} set not to sync.</b>{' '}
              They are left out of the &quot;not mapped&quot; reminder and its Telegram
              notice. Mapping one below starts syncing it again.
            </div>
            <ul className="sfin-banner-list">
              {ignoredAccounts.map((id) => (
                <li key={id}>{sfAccounts?.find((a) => a.id === id)?.name ?? id}</li>
              ))}
            </ul>
            <div style={{ marginTop: 8 }}>
              <Button variant="outline" onClick={() => void clearIgnored()}>
                Remind me about {ignoredAccounts.length === 1 ? 'it' : 'them'} again
              </Button>
            </div>
          </div>
        )}

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
            Edit mapping
          </Button>
        ) : (
          <>
            {relinkDecisionsUnreadable && (
              <ErrorBox>
                Your answers about reconnected accounts can&rsquo;t be read, so no reconnection is asked
                about or can be undone here: saving would drop the answers that weren&rsquo;t understood.
                The sync acts only on the ones it can read.
              </ErrorBox>
            )}
            <AccountMapper
              ctx={ctx}
              simplefinAccounts={sfAccounts}
              initialMapping={mapping}
              initialLoanLinks={loanLinks}
              companionVersion={companionVersion}
              onSave={saveMapping}
              relinkDecisions={relinkDecisions ?? undefined}
              onRelinkDecisions={relinkDecisions
                ? async (change) => { const next = await store.updateRelinkDecisions(change); setRelinkDecisions(next); return next; }
                : undefined}
              sfinNames={sfinNames}
              feedReportedErrors={sfAccountsHadErrors}
              // A follow-up: a durable last-seen date. `account_balances` is
              // rebuilt each sync from that run's download, so an id that stopped
              // reporting is usually gone from it ("not reported recently").
              lastSeen={Object.fromEntries(Object.entries(balances).map(([id, b]) => [id, b.date]))}
              onAccountCreated={(created) => { void store.recordChange?.(accountCreatedChange(created)); }}
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

      {/* 2c: what Wealthfolio's Health page flags, from the companion's
          snapshot. Beside Accounts: Home's Accounts tile opens it when there
          is something to look at. Not there at all for an add-on-only
          install (no snapshot, no companion): a card that can only ever say
          "Need the companion" is noise. */}
      {auditSnapshot && !(auditSnapshot.kind === 'absent' && !companionVersion) && (
        <CollapsibleCard
          id={CARD.checks}
          title="Checks"
          summary={checksSummary(auditSnapshot, companionVersion)}
          open={isOpen(CARD.checks)}
          onToggle={() => toggleCard(CARD.checks)}
        >
          <ChecksCard
            read={auditSnapshot} companionVersion={companionVersion} now={new Date()}
            link={linkChecks} onFixed={onAuditChanged}
            notTransfer={typeof store.editSyncOverrides === 'function' ? notTransfer : undefined}
            loadMarked={loadMarked}
          />
        </CollapsibleCard>
      )}

      <h3 className="sfin-settings-group">Budget</h3>
      <CollapsibleCard
        id={CARD.pool}
        title="Semester pool"
        summary={poolSummary}
        open={isOpen(CARD.pool)}
        onToggle={() => toggleCard(CARD.pool)}
      >
        <PoolCard store={store} bare onChange={setPoolCfg} />
      </CollapsibleCard>

      <h3 className="sfin-settings-group">Notifications</h3>
      <NotificationsTab
        ctx={ctx}
        draft={telegramDraft}
        categories={categories}
        isOpen={isOpen}
        toggleCard={toggleCard}
      />
      <ReceiptReaderConnect store={store} isOpen={isOpen} toggleCard={toggleCard} />

      <h3 className="sfin-settings-group">Sync</h3>

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
            {SYNC_INTERVALS.map((h) => <option key={h} value={h}>Every {h} hours</option>)}
            {/* An interval stored by an older version (hourly, 8 hours) stays
                visible as itself rather than blanking the select. */}
            {scheduleHours !== null && scheduleHours > 0 && !SYNC_INTERVALS.includes(scheduleHours) && (
              <option value={scheduleHours}>Every {scheduleHours} hour{scheduleHours === 1 ? '' : 's'}</option>
            )}
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
        {/* The ONE compose service (shared/compose-snippet.ts, project 4): the
            README and docker-compose.example.yml carry the same text, and a
            test fails if they drift. This card fills in the browser's
            timezone; it never fills in a password. */}
        <DockerSnippet />
      </CollapsibleCard>

      {/* Every change the sync and you made, the same entries /changes shows,
          with Undo and Redo. Loads when opened. */}
      <CollapsibleCard
        id={CARD.changeLog}
        title="Change log"
        summary="What the sync and you changed, the last 90 days"
        open={isOpen(CARD.changeLog)}
        onToggle={() => toggleCard(CARD.changeLog)}
      >
        <ChangeLogCard
          load={loadChangeLog}
          undo={undoChange}
          companionVersion={companionVersion}
          onSyncNow={syncNowForLog}
          loadOverrides={loadOverrides}
          removeOverride={typeof store.editSyncOverrides === 'function' ? removeOverride : undefined}
        />
      </CollapsibleCard>

      <h3 className="sfin-settings-group">Categorizing</h3>
      {/* The companion reads the mailbox, so this is only useful to someone
          who has set up background sync above. */}
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
        <RuleEditor rules={rules} onChange={saveRules} accountNames={wfNames} />
        {rulesNote && (
          <div className="sfin-log-note" role="status">
            {rulesNote}
            {rulesNote === RULES_CHANGED_ELSEWHERE && <> <Button variant="outline" onClick={reloadRules}>Reload rules</Button></>}
          </div>
        )}
      </CollapsibleCard>

      {/* Beside Transaction rules, which choose what a row becomes; these
          choose which rows are never imported. */}
      {typeof store.readIgnoreRules === 'function' && (
        <CollapsibleCard
          id={CARD.ignoreRules}
          title="Ignore rules"
          summary={ignoreRulesSummary}
          open={isOpen(CARD.ignoreRules)}
          onToggle={() => toggleCard(CARD.ignoreRules)}
        >
          <IgnoreRulesEditor
            rules={ignoreRules}
            accounts={ignoreRuleAccounts}
            onChange={saveIgnoreRules}
            loadFeed={loadIgnorePreview}
            companionVersion={companionVersion}
            unreadable={ignoreRulesUnreadable}
          />
        </CollapsibleCard>
      )}

      <div className="sfin-callout sfin-advanced-callout">
        To see synced transactions in Wealthfolio&apos;s <strong>Spending</strong> page, turn on
        the Spending Tracker for your mapped accounts.
        <Why>
          Imported transactions always appear under Activities. The Spending page, with its
          categories and budgets, only counts accounts the Spending Tracker is on for:
          Wealthfolio&apos;s <strong>Settings → Spending Tracker</strong>.
        </Why>
      </div>

      {/* A destructive boundary, not a bare button under unrelated settings:
          the old layout put "Reset Setup" directly below the Spending-Tracker
          callout with nothing to mark it apart from everything else on the
          page.

          The copy below has to match what `clearAll` actually deletes: every
          key in `SecretsStore`'s KEYS map, which is everything this tab (and
          Notifications) configures — not just the account mapping. */}
      <h3 className="sfin-settings-group">Reset</h3>
      <div className="sfin-danger-card">
        <b>Reset connection</b>
        <div className="sfin-subtle sfin-danger-note">
          Clears every SimpleFin Sync setting — the connection, account mapping, sync
          schedule, transaction and ignore rules, the change log, and any Telegram or Amazon setup.
          Transactions already imported into Wealthfolio stay.
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
