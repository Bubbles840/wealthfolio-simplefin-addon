import React, { useEffect, useState, useCallback } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync, INTERVAL_SKIP_MESSAGE } from '../utils/sync';
import { fetchAccounts } from '../utils/simplefin';
import { SyncStatus } from '../components/SyncStatus';
import { RuleEditor } from '../components/RuleEditor';
import { Button, Card, ErrorBox, SectionLabel } from '../components/ui';
import type { SecretsStore } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { AccountMapping, MappingRule } from '../../shared/types';

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  onReset: () => void;
  scheduler: Scheduler;
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
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    Promise.all([
      store.getLastSyncAt(),
      store.getAccountMapping(),
      store.getMappingRules(),
      store.getSyncScheduleHours(),
      store.getAccountNames(),
      ctx.api.accounts.getAll().catch(() => []),
    ]).then(([last, m, r, h, names, wfAccounts]) => {
      setLastSyncAt(last);
      setMapping(m ?? {});
      setRules(r);
      setScheduleHours(h);
      setSfinNames(names);
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
      // runSync stamps lastSyncAt itself; mirror it for the header
      const last = await store.getLastSyncAt();
      setLastSyncAt(last);
    } catch (e: any) {
      setError(e.message ?? 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [ctx, store]);

  // window.confirm is silently suppressed in the addon sandbox (iframe has
  // sandbox="allow-scripts" without allow-modals), so confirmation must be
  // rendered inline instead
  const handleReset = async () => {
    scheduler.stop();
    await store.clearAll();
    onReset();
  };

  const mappedCount = Object.keys(mapping).length;

  return (
    <div className="sfin-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 className="sfin-title">SimpleFin Sync</h2>
          <SyncStatus lastSyncAt={lastSyncAt} imported={imported} syncing={syncing} />
        </div>
        <Button onClick={() => doSync(false)} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Now'}
        </Button>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {intervalBlocked && (
        <div className="sfin-callout" style={{ marginTop: 16, marginBottom: 0 }}>
          Last sync was under an hour ago, so Sync Now was skipped to avoid
          hammering SimpleFin.{' '}
          <Button
            variant="ghost"
            onClick={() => doSync(true)}
            disabled={syncing}
            style={{ marginLeft: 4 }}
          >
            Sync anyway
          </Button>
        </div>
      )}

      <div className="sfin-callout" style={{ marginTop: 16, marginBottom: 0 }}>
        💡 Imported bank transactions appear under <strong>Activities</strong>. To see them in the{' '}
        <strong>Spending</strong> tab with categories and budgets, enable the Spending Tracker for
        your mapped accounts: <strong>Settings → Spending Tracker</strong>.
      </div>

      <Card>
        <SectionLabel>Accounts ({mappedCount} mapped)</SectionLabel>
        <ul className="sfin-list">
          {Object.entries(mapping).map(([sfinId, wfId]) => (
            <li key={sfinId}>
              {sfinNames[sfinId] ?? sfinId}
              <span className="sfin-subtle"> → </span>
              {wfNames[wfId] ?? (
                <span style={{ color: 'var(--destructive)' }}>
                  account no longer exists — reset and re-map
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <SectionLabel>Auto-Sync</SectionLabel>
        {scheduleHours ? `Every ${scheduleHours} hours` : 'Off'}
      </Card>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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


      <div style={{ marginTop: 24 }}>
        {confirmingReset ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="sfin-subtle">
              Reset all SimpleFin Sync settings? You will need to reconnect.
            </span>
            <Button variant="destructive" onClick={handleReset}>
              Yes, reset everything
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingReset(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setConfirmingReset(true)}>
            Reset Setup
          </Button>
        )}
      </div>
    </div>
  );
}
