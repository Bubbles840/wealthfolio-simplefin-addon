import React, { useEffect, useState, useCallback } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync, INTERVAL_SKIP_MESSAGE, applyBalanceAdjustment } from '../utils/sync';
import { fetchAccounts } from '../utils/simplefin';
import { SyncStatus } from '../components/SyncStatus';
import { RuleEditor } from '../components/RuleEditor';
import { Button, Card, ErrorBox, SectionLabel } from '../components/ui';
import { sendTelegramMessage, getCategoryEmoji } from '../../shared/telegram';
import type { SecretsStore, AccountBalanceInfo } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { AccountMapping, MappingRule } from '../../shared/types';

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  onReset: () => void;
  scheduler: Scheduler;
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 13l4 4L19 7" />
  </svg>
);
const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8v5M12 16h.01" />
  </svg>
);

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

export function SyncPage({ ctx, store, onReset, scheduler }: Props) {
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [mapping, setMapping] = useState<AccountMapping>({});
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [scheduleHours, setScheduleHours] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [intervalBlocked, setIntervalBlocked] = useState(false);
  const [editingRules, setEditingRules] = useState(false);
  const [sfinNames, setSfinNames] = useState<Record<string, string>>({});
  const [wfNames, setWfNames] = useState<Record<string, string>>({});
  const [balances, setBalances] = useState<Record<string, AccountBalanceInfo>>({});
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [healing, setHealing] = useState(false);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [autoHeal, setAutoHeal] = useState(false);
  const [autoAdjust, setAutoAdjust] = useState(false);
  const [showDockerSetup, setShowDockerSetup] = useState(false);

  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [notifyOnImport, setNotifyOnImport] = useState(true);
  const [dailyReportEnabled, setDailyReportEnabled] = useState(true);
  const [weeklyReportEnabled, setWeeklyReportEnabled] = useState(true);
  const [dailyReportCategories, setDailyReportCategories] = useState<string[] | 'all'>('all');
  const [weeklyReportCategories, setWeeklyReportCategories] = useState<string[] | 'all'>('all');
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [showTelegramInstructions, setShowTelegramInstructions] = useState(false);

  const loadBalances = useCallback(() => {
    store.getAccountBalances().then(setBalances).catch(() => {});
  }, [store]);

  useEffect(() => {
    Promise.all([
      store.getLastSyncAt(),
      store.getAccountMapping(),
      store.getMappingRules(),
      store.getSyncScheduleHours(),
      store.getAccountNames(),
      store.getAccountBalances(),
      store.getAutoHeal(),
      store.getAutoAdjust(),
      store.getTelegramConfig(),
      store.getAvailableReportCategories(),
      ctx.api.accounts.getAll().catch(() => []),
    ]).then(([last, m, r, h, names, bal, ah, aa, tg, availableCats, wfAccounts]) => {
      setLastSyncAt(last);
      setMapping(m ?? {});
      setRules(r);
      setScheduleHours(h);
      setSfinNames(names);
      setBalances(bal);
      setAutoHeal(ah);
      setAutoAdjust(aa);
      setAvailableCategories(availableCats);
      if (tg) {
        setBotToken(tg.botToken ?? '');
        setChatId(tg.chatId ?? '');
        setNotifyOnImport(tg.notifyOnImport ?? true);
        setDailyReportEnabled(tg.dailyReportEnabled ?? true);
        setWeeklyReportEnabled(tg.weeklyReportEnabled ?? true);
        setDailyReportCategories(tg.dailyReportCategories ?? 'all');
        setWeeklyReportCategories(tg.weeklyReportCategories ?? 'all');
      }
      setWfNames(Object.fromEntries(wfAccounts.map((a) => [a.id, a.name])));

      // Backfill for installs set up before account names were captured
      if (Object.keys(names).length === 0 && m && Object.keys(m).length > 0) {
        backfillNames();
      }
    });

    async function backfillNames() {
      try {
        const accessUrl = await store.getAccessUrl();
        if (!accessUrl) return;
        const authKey = await store.getAuthB64Key();
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const accountSet = await fetchAccounts(accessUrl, yesterday, ctx.api.network, authKey);
        const fetched = Object.fromEntries(accountSet.accounts.map((a) => [a.id, a.name]));
        await store.setAccountNames(fetched);
        setSfinNames(fetched);
      } catch {
        // Names are cosmetic — leave IDs visible rather than surface an error
      }
    }
  }, [store, ctx]);

  const doSync = useCallback(async (force = false) => {
    setSyncing(true);
    setError('');
    setIntervalBlocked(false);
    try {
      const result = await runSync(ctx, store, { force });
      // A pure interval skip isn't an error — offer to force instead
      if (result.errors.length === 1 && result.errors[0] === INTERVAL_SKIP_MESSAGE) {
        setIntervalBlocked(true);
        return;
      }
      if (result.errors.length > 0) setError(result.errors.join('; '));
      setImported(result.imported);
      // runSync stamps lastSyncAt and the balances itself; mirror them
      const last = await store.getLastSyncAt();
      setLastSyncAt(last);
      loadBalances();
    } catch (e: any) {
      setError(e.message ?? 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [ctx, store, loadBalances]);

  // Heal: re-scan a wide window to recover missing transactions, then re-measure
  // drift so any residual can be plugged.
  const doHeal = useCallback(async () => {
    setHealing(true);
    setError('');
    try {
      const result = await runSync(ctx, store, { heal: true });
      if (result.errors.length > 0) setError(result.errors.join('; '));
      setImported(result.imported);
      setLastSyncAt(await store.getLastSyncAt());
      loadBalances();
    } catch (e: any) {
      setError(e.message ?? 'Reconcile failed');
    } finally {
      setHealing(false);
    }
  }, [ctx, store, loadBalances]);

  // Plug the residual: add a one-time balance-adjustment entry for an account.
  const doAdjust = useCallback(
    async (sfinId: string, wfId: string, currency: string, amount: number) => {
      setAdjusting(sfinId);
      setError('');
      try {
        await applyBalanceAdjustment(ctx, store, { sfinAccountId: sfinId, wfAccountId: wfId, currency, amount });
        loadBalances();
      } catch (e: any) {
        setError(e.message ?? 'Adjustment failed');
      } finally {
        setAdjusting(null);
      }
    },
    [ctx, store, loadBalances],
  );

  // window.confirm is silently suppressed in the addon sandbox (iframe has
  // sandbox="allow-scripts" without allow-modals), so confirmation must be
  // rendered inline instead
  const handleReset = async () => {
    scheduler.stop();
    await store.clearAll();
    onReset();
  };

  const changeInterval = async (hours: number) => {
    setScheduleHours(hours);
    await store.setSyncScheduleHours(hours);
    scheduler.stop();
    if (hours > 0) {
      scheduler.start(hours, () => store.getLastSyncAt(), () => runSync(ctx, store));
    }
  };

  const mappedEntries = Object.entries(mapping);
  const mappedCount = mappedEntries.length;
  const driftAccounts = mappedEntries.filter(([sfinId]) => balances[sfinId]?.drift != null);
  const asOf = mappedEntries
    .map(([sfinId]) => balances[sfinId]?.date)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => b - a)[0];

  return (
    <div className="sfin-page">
      <div className="sfin-head">
        <div>
          <h2 className="sfin-title">SimpleFin Sync</h2>
          <SyncStatus lastSyncAt={lastSyncAt} imported={imported} syncing={syncing} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Always-available reconcile: re-scans a wide window, re-links transfer
              pairs, and self-heals the link ledger. The "Re-scan 90 days" button
              in the drift banner only appears when an account is off-balance, so
              this keeps reconcile reachable when everything reads "in sync". */}
          <Button variant="outline" onClick={doHeal} disabled={healing || syncing}
            title="Re-scan a wide window and re-link internal transfer pairs">
            {healing ? 'Reconciling…' : '↻ Reconcile & link'}
          </Button>
          <Button onClick={() => doSync(false)} disabled={syncing}>
            {syncing ? 'Syncing…' : '↻ Sync Now'}
          </Button>
        </div>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {intervalBlocked && (
        <div className="sfin-callout" style={{ marginBottom: 16 }}>
          Last sync was under an hour ago, so Sync Now was skipped to avoid
          hammering SimpleFin.{' '}
          <Button variant="ghost" onClick={() => doSync(true)} disabled={syncing} style={{ marginLeft: 4 }}>
            Sync anyway
          </Button>
        </div>
      )}

      {driftAccounts.map(([sfinId, wfId]) => {
        const info = balances[sfinId];
        const drift = info.drift as number;
        return (
          <div className="sfin-banner-warn" key={sfinId}>
            <span aria-hidden>⚠</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <b>{sfinNames[sfinId] ?? sfinId}</b> is off by{' '}
                <b>{money(Math.abs(drift), info.currency)}</b> — SimpleFin reports{' '}
                <b>{money(info.balance ?? 0, info.currency)}</b>.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <Button variant="outline" onClick={doHeal} disabled={healing || syncing}>
                  {healing ? 'Re-scanning…' : 'Re-scan 90 days'}
                </Button>
                <Button
                  variant="ghost"
                  title="Add a one-time balance adjustment so this account matches your bank"
                  onClick={() => doAdjust(sfinId, wfId, info.currency, drift)}
                  disabled={adjusting === sfinId || healing}
                >
                  {adjusting === sfinId
                    ? 'Adjusting…'
                    : `${drift > 0 ? 'Add' : 'Subtract'} ${money(Math.abs(drift), info.currency)}`}
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      <div className="sfin-strip" style={{ marginTop: 16 }}>
        <div className="sfin-tile">
          <SectionLabel>Accounts synced</SectionLabel>
          <div className="sfin-tile-val">{mappedCount}</div>
        </div>
        <div className="sfin-tile">
          <SectionLabel>Imported last run</SectionLabel>
          <div className="sfin-tile-val">{imported ?? '—'}</div>
        </div>
        <div className="sfin-tile">
          <SectionLabel>Auto-sync</SectionLabel>
          <div className="sfin-tile-val" style={{ fontSize: 16 }}>
            {scheduleHours ? `Every ${scheduleHours}h` : 'Off'}
          </div>
        </div>
      </div>

      <Card>
        <div className="sfin-card-head">
          <SectionLabel>Accounts ({mappedCount} mapped)</SectionLabel>
          {asOf && <span className="sfin-subtle" style={{ fontSize: 11.5 }}>balances as of {formatAsOf(asOf)}</span>}
        </div>
        {mappedEntries.map(([sfinId, wfId]) => {
          const info = balances[sfinId];
          const name = sfinNames[sfinId] ?? sfinId;
          const exists = !!wfNames[wfId];
          const open = () => { if (exists) ctx.api.navigation.navigate(`/accounts/${wfId}`).catch(() => {}); };
          return (
            <div
              className={`sfin-acct${exists ? ' sfin-acct--link' : ''}`}
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
                <div style={{ minWidth: 0 }}>
                  <div className="sfin-acct-name">{name}</div>
                  <div className="sfin-acct-map">
                    {exists ? (
                      `→ ${wfNames[wfId]}`
                    ) : (
                      <span style={{ color: 'var(--destructive)' }}>account no longer exists — reset &amp; re-map</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="sfin-acct-right">
                <div className="sfin-bal">{info && info.balance != null ? money(info.balance, info.currency) : '—'}</div>
                {info && info.balance != null && (info.drift == null ? (
                  <span className="sfin-chip"><CheckIcon /> in sync</span>
                ) : (
                  <span className="sfin-chip sfin-chip--off"><AlertIcon /> off by {money(Math.abs(info.drift), info.currency)}</span>
                ))}
              </div>
            </div>
          );
        })}
      </Card>

      <Card>
        <label htmlFor="sfin-interval" className="sfin-section-label" style={{ display: 'block' }}>
          Auto-Sync interval
        </label>
        <div className="sfin-subtle" style={{ marginBottom: 8 }}>
          Syncs when this page is open and it&apos;s been this long since the last run.
        </div>
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

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 16, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoHeal}
            style={{ marginTop: 2 }}
            onChange={async (e) => {
              setAutoHeal(e.target.checked);
              await store.setAutoHeal(e.target.checked);
            }}
          />
          <span>
            <span style={{ fontWeight: 550 }}>Auto-heal</span>
            <span className="sfin-subtle">
              {' '}— re-scan ~45 days each sync to catch missing transactions and check
              balances. Balance adjustments stay manual.
            </span>
          </span>
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoAdjust}
            style={{ marginTop: 2 }}
            onChange={async (e) => {
              setAutoAdjust(e.target.checked);
              await store.setAutoAdjust(e.target.checked);
            }}
          />
          <span>
            <span style={{ fontWeight: 550 }}>Aggressively auto-heal</span>
            <span className="sfin-subtle">
              {' '}— also auto-insert balance adjustments for any residual, without asking
              (includes the re-scan). Forces balances to match your bank on every sync.
            </span>
          </span>
        </label>
      </Card>

      <Card>
        <div className="sfin-card-head">
          <SectionLabel>Docker Background Sync (Optional)</SectionLabel>
          <Button variant="ghost" onClick={() => setShowDockerSetup((s) => !s)}>
            {showDockerSetup ? 'Hide Setup' : 'Show Setup'}
          </Button>
        </div>
        <div className="sfin-subtle">
          Sync transactions automatically in the background even when Wealthfolio is closed.
        </div>
        {showDockerSetup && (
          <div style={{ marginTop: 12 }}>
            <div className="sfin-subtle" style={{ marginBottom: 8 }}>
              Add this service to your <code>docker-compose.yml</code>. You can customize the sync rate via <code>SYNC_SCHEDULE</code>:
            </div>
            <pre
              style={{
                background: 'var(--card-bg, rgba(0,0,0,0.2))',
                padding: '12px 14px',
                borderRadius: '6px',
                fontSize: '12px',
                fontFamily: 'monospace',
                overflowX: 'auto',
                border: '1px solid var(--border, rgba(255,255,255,0.1))',
                lineHeight: 1.5,
              }}
            >
              {`services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    container_name: simplefin-sync
    restart: always
    network_mode: host
    environment:
      - WEALTHFOLIO_API_URL=http://127.0.0.1:8088
      - WEALTHFOLIO_PASSWORD=your_wealthfolio_password
      - SYNC_SCHEDULE=0 */6 * * *          # Change cron schedule here (e.g. 0 */3 * * * for every 3h)
      - MIN_SYNC_INTERVAL_HOURS=1          # Minimum interval cooldown between syncs`}
            </pre>
          </div>
        )}
      </Card>

      <Card>
        <div className="sfin-card-head">
          <SectionLabel>Telegram Notifications (Optional)</SectionLabel>
          <Button variant="ghost" onClick={() => setShowTelegramInstructions((s) => !s)}>
            {showTelegramInstructions ? 'Hide Setup' : 'Setup Guide'}
          </Button>
        </div>
        <div className="sfin-subtle" style={{ marginBottom: 12 }}>
          Receive daily budget spending allowances and weekly budget summaries directly in Telegram. Handled by the background companion container.
        </div>

        {showTelegramInstructions && (
          <div
            style={{
              background: 'var(--card-bg, rgba(0,0,0,0.2))',
              padding: '12px 14px',
              borderRadius: '6px',
              marginBottom: 16,
              fontSize: '13px',
              lineHeight: 1.6,
              border: '1px solid var(--border, rgba(255,255,255,0.1))',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>📱 How to Set Up Your Telegram Bot:</div>
            <ol style={{ paddingLeft: 20, margin: 0 }}>
              <li>Open Telegram and search for <strong>@BotFather</strong>.</li>
              <li>Send <code>/newbot</code> to @BotFather and follow prompts to name your bot.</li>
              <li>Copy the HTTP API <strong>Token</strong> (e.g. <code>123456789:ABCdefGHI...</code>).</li>
              <li>Open Telegram and send a message <code>/start</code> to your new bot.</li>
              <li>Search Telegram for <strong>@userinfobot</strong> and send any message to get your numeric <strong>Chat ID</strong> (e.g. <code>987654321</code>).</li>
              <li>Paste your Bot Token and Chat ID below, then click <strong>Send Test Message</strong>!</li>
            </ol>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label className="sfin-subtle" style={{ display: 'block', marginBottom: 4 }}>Bot Token</label>
            <input
              type="password"
              className="sfin-select"
              style={{ width: '100%' }}
              placeholder="e.g. 123456789:ABCdefGHI..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </div>
          <div>
            <label className="sfin-subtle" style={{ display: 'block', marginBottom: 4 }}>Chat ID</label>
            <input
              type="text"
              className="sfin-select"
              style={{ width: '100%' }}
              placeholder="e.g. 987654321"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={notifyOnImport}
                onChange={(e) => setNotifyOnImport(e.target.checked)}
              />
              <span>Transaction Import Alerts (Instant when new transactions sync)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dailyReportEnabled}
                onChange={(e) => setDailyReportEnabled(e.target.checked)}
              />
              <span>Daily Category Allowance Report (Morning)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={weeklyReportEnabled}
                onChange={(e) => setWeeklyReportEnabled(e.target.checked)}
              />
              <span>Weekly Budget &amp; Spending Summary</span>
            </label>
          </div>

          <div style={{
            background: 'var(--card-bg, rgba(0,0,0,0.15))',
            padding: 12,
            borderRadius: 6,
            border: '1px solid var(--border, rgba(255,255,255,0.1))',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            marginTop: 4,
          }}>
            <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--muted-foreground)', letterSpacing: '0.05em' }}>
              REPORT CATEGORIES
            </div>
            {availableCategories.length === 0 ? (
              <div className="sfin-subtle" style={{ fontSize: 12 }}>
                Categories will appear here after the companion's first sync.
              </div>
            ) : (
              availableCategories.map((name) => {
                const emoji = getCategoryEmoji(name);
                const inDaily = dailyReportCategories === 'all' || dailyReportCategories.includes(name);
                const inWeekly = weeklyReportCategories === 'all' || weeklyReportCategories.includes(name);
                // Functional updater, and membership read from `prev` rather
                // than the closed-over `inDaily`/`inWeekly`: two toggles
                // batched into one React tick would otherwise both start from
                // the same stale snapshot and the first would be dropped.
                const toggle = (
                  setCurrent: React.Dispatch<React.SetStateAction<string[] | 'all'>>,
                ) => {
                  setCurrent((prev) => {
                    const base = prev === 'all' ? availableCategories : prev;
                    const wasIncluded = prev === 'all' || prev.includes(name);
                    const next = wasIncluded ? base.filter((n) => n !== name) : [...base, name];
                    // Collapse to the 'all' sentinel only when the selection
                    // genuinely covers every published category — a SET test,
                    // not a length test. `availableCategories` is the union of
                    // *this month's* spending and budgets, so it legitimately
                    // shrinks (a category with spending but no budget vanishes
                    // at month rollover) while a saved selection still holds
                    // the older, longer list. Comparing lengths then matched
                    // by coincidence: with saved ['Groceries','Dining','Fun']
                    // and a published ['Groceries','Dining'], unchecking
                    // Groceries left a 2-element array whose length equalled
                    // the published list, stored 'all', and silently put every
                    // category back into the user's reports.
                    //
                    // Names no longer published are kept in `next` rather than
                    // pruned, so a category that reappears next month comes
                    // back with the user's original intent intact.
                    const chosen = new Set(next);
                    const coversEverything = availableCategories.every((n) => chosen.has(n));
                    return coversEverything ? 'all' : next;
                  });
                };
                return (
                  <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{emoji}</span>
                    <span style={{ minWidth: 120, fontWeight: 500, fontSize: 13 }}>{name}</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        aria-label={`${name} — Daily`}
                        checked={inDaily}
                        onChange={() => toggle(setDailyReportCategories)}
                      />
                      Daily
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        aria-label={`${name} — Weekly`}
                        checked={inWeekly}
                        onChange={() => toggle(setWeeklyReportCategories)}
                      />
                      Weekly
                    </label>
                  </div>
                );
              })
            )}
          </div>

          {telegramStatus && (
            <div style={{ fontSize: '13px', color: telegramStatus.startsWith('✅') ? 'var(--success, #4caf50)' : 'var(--destructive, #f44336)' }}>
              {telegramStatus}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Button
              variant="outline"
              disabled={testingTelegram || !botToken || !chatId}
              onClick={async () => {
                setTestingTelegram(true);
                setTelegramStatus('Sending test message...');
                try {
                  const timeoutPromise = new Promise<{ ok: false; description: string }>((_, reject) =>
                    setTimeout(() => reject(new Error('Request timed out after 5 seconds')), 5000)
                  );

                  const sendPromise = sendTelegramMessage(
                    botToken,
                    chatId,
                    '🎉 *SimpleFin Sync Telegram Integration Connected!*\n\nYour Telegram bot is configured and ready to send daily category allowances and weekly budget reports.',
                    ctx.api.network,
                  );

                  const res = await Promise.race([sendPromise, timeoutPromise]);
                  if (res.ok) {
                    setTelegramStatus('✅ Test message sent successfully to Telegram!');
                  } else {
                    setTelegramStatus(`❌ Error sending message: ${res.description}`);
                  }
                } catch (err) {
                  console.error('[Telegram Debug Error]:', err);
                  setTelegramStatus(`❌ Error: ${(err as Error).message}`);
                } finally {
                  setTestingTelegram(false);
                }
              }}
            >
              {testingTelegram ? 'Sending...' : 'Send Test Message'}
            </Button>

            <Button
              variant="primary"
              disabled={!botToken || !chatId}
              onClick={async () => {
                await store.setTelegramConfig({
                  botToken,
                  chatId,
                  enabled: true,
                  notifyOnImport,
                  dailyReportEnabled,
                  weeklyReportEnabled,
                  dailyReportCategories,
                  weeklyReportCategories,
                });
                setTelegramStatus('✅ Telegram configuration saved!');
              }}
            >
              Save Telegram Settings
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="sfin-card-head">
          <SectionLabel>Transaction Rules</SectionLabel>
          <Button variant="ghost" onClick={() => setEditingRules((e) => !e)}>
            {editingRules ? 'Done' : 'Edit'}
          </Button>
        </div>
        {editingRules ? (
          <RuleEditor
            rules={rules}
            onChange={async (r) => {
              setRules(r);
              await store.setMappingRules(r);
            }}
          />
        ) : (
          <ul className="sfin-list">
            {rules.map((r, i) => (
              <li key={i}>"{r.pattern}" → {r.activityType}</li>
            ))}
            <li className="sfin-subtle">+ → DEPOSIT, - → WITHDRAWAL (defaults)</li>
          </ul>
        )}
      </Card>

      <div className="sfin-callout" style={{ marginTop: 16, marginBottom: 0 }}>
        💡 Imported bank transactions appear under <strong>Activities</strong>. To see them in the{' '}
        <strong>Spending</strong> tab with categories and budgets, enable the Spending Tracker for
        your mapped accounts: <strong>Settings → Spending Tracker</strong>.
      </div>

      <div style={{ marginTop: 24 }}>
        {confirmingReset ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="sfin-subtle">Reset all SimpleFin Sync settings? You will need to reconnect.</span>
            <Button variant="destructive" onClick={handleReset}>Yes, reset everything</Button>
            <Button variant="ghost" onClick={() => setConfirmingReset(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setConfirmingReset(true)}>Reset Setup</Button>
        )}
      </div>
    </div>
  );
}
