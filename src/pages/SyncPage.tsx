import React, { useEffect, useState, useCallback } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync, INTERVAL_SKIP_MESSAGE } from '../utils/sync';
import { fetchAccounts } from '../utils/simplefin';
import { SyncStatus } from '../components/SyncStatus';
import { RuleEditor } from '../components/RuleEditor';
import { Button, Card, ErrorBox, SectionLabel } from '../components/ui';
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

/** Two-character badge from an account name: "Spend (4937)" → "SP". */
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
      ctx.api.accounts.getAll().catch(() => []),
    ]).then(([last, m, r, h, names, bal, wfAccounts]) => {
      setLastSyncAt(last);
      setMapping(m ?? {});
      setRules(r);
      setScheduleHours(h);
      setSfinNames(names);
      setBalances(bal);
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
        <Button onClick={() => doSync(false)} disabled={syncing}>
          {syncing ? 'Syncing…' : '↻ Sync Now'}
        </Button>
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

      {driftAccounts.map(([sfinId]) => {
        const info = balances[sfinId];
        return (
          <div className="sfin-banner-warn" key={sfinId}>
            <span aria-hidden>⚠</span>
            <div>
              <b>{sfinNames[sfinId] ?? sfinId}</b> looks out of sync — SimpleFin reports{' '}
              <b>{money(info.balance, info.currency)}</b>, off by{' '}
              <b>{money(Math.abs(info.drift as number), info.currency)}</b> from Wealthfolio. Try{' '}
              <b>Sync anyway</b>, or check for a transaction Wealthfolio missed.
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
          return (
            <div className="sfin-acct" key={sfinId}>
              <div className="sfin-acct-left">
                <div className="sfin-avatar">{initials(name)}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="sfin-acct-name">{name}</div>
                  <div className="sfin-acct-map">
                    {wfNames[wfId] ? (
                      `→ ${wfNames[wfId]}`
                    ) : (
                      <span style={{ color: 'var(--destructive)' }}>account no longer exists — reset &amp; re-map</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="sfin-acct-right">
                <div className="sfin-bal">{info ? money(info.balance, info.currency) : '—'}</div>
                {info && (info.drift == null ? (
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
