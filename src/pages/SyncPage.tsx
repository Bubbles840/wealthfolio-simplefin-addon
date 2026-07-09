import React, { useEffect, useState, useCallback } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync } from '../utils/sync';
import { SyncStatus } from '../components/SyncStatus';
import { DockerGuide } from '../components/DockerGuide';
import { RuleEditor } from '../components/RuleEditor';
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
  const [editingRules, setEditingRules] = useState(false);

  useEffect(() => {
    Promise.all([
      store.getLastSyncAt(),
      store.getAccountMapping(),
      store.getMappingRules(),
      store.getSyncScheduleHours(),
    ]).then(([last, m, r, h]) => {
      setLastSyncAt(last);
      setMapping(m ?? {});
      setRules(r);
      setScheduleHours(h);
    });
  }, [store]);

  const doSync = useCallback(async () => {
    setSyncing(true);
    setError('');
    try {
      const result = await runSync(ctx, store);
      if (result.errors.length > 0) setError(result.errors.join('; '));
      setImported(result.imported);
      setLastSyncAt(new Date());
    } catch (e: any) {
      setError(e.message ?? 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [ctx, store]);

  const handleReset = async () => {
    if (!confirm('Reset all SimpleFin Sync settings? You will need to reconnect.')) return;
    scheduler.stop();
    await store.clearAll();
    onReset();
  };

  const mappedCount = Object.keys(mapping).length;

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>SimpleFin Sync</h2>
        <button onClick={doSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>

      <SyncStatus lastSyncAt={lastSyncAt} imported={imported} syncing={syncing} />
      {error && <p style={{ color: 'red' }}>{error}</p>}

      <section style={{ marginTop: 20 }}>
        <strong>ACCOUNTS ({mappedCount} mapped)</strong>
        <ul style={{ margin: '8px 0', padding: '0 0 0 16px' }}>
          {Object.entries(mapping).map(([sfinId, wfId]) => (
            <li key={sfinId}>{sfinId} → {wfId}</li>
          ))}
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <strong>AUTO-SYNC</strong>{' '}
        {scheduleHours ? `Every ${scheduleHours} hours` : 'Disabled'}
      </section>

      <section style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <strong>TRANSACTION RULES</strong>
          <button type="button" onClick={() => setEditingRules((e) => !e)}>
            {editingRules ? 'Done' : 'Edit'}
          </button>
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
          <ul style={{ margin: '8px 0', padding: '0 0 0 16px', fontSize: 13 }}>
            {rules.map((r, i) => (
              <li key={i}>"{r.pattern}" → {r.activityType}</li>
            ))}
            <li style={{ opacity: 0.6 }}>+ → DEPOSIT, - → WITHDRAWAL (defaults)</li>
          </ul>
        )}
      </section>

      <DockerGuide store={store} />

      <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
        <button type="button" onClick={handleReset} style={{ color: 'red' }}>
          Reset Setup
        </button>
      </div>
    </div>
  );
}
