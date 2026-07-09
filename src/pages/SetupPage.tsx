import React, { useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { AccountMapping, MappingRule, SimplefinAccount } from '../../shared/types';
import { claimToken, fetchAccounts } from '../utils/simplefin';
import { AccountMapper } from '../components/AccountMapper';
import { RuleEditor } from '../components/RuleEditor';
import type { SecretsStore } from '../utils/secrets';

type Step = 1 | 2 | 3 | 4;

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  onComplete: () => void;
}

export function SetupPage({ ctx, store, onComplete }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sfAccounts, setSfAccounts] = useState<SimplefinAccount[]>([]);
  const [mapping, setMapping] = useState<AccountMapping>({});
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [scheduleHours, setScheduleHours] = useState<number>(6);
  const [autoSync, setAutoSync] = useState(false);

  // Step 1: Claim token
  const handleConnect = async () => {
    setError('');
    setLoading(true);
    try {
      const accessUrl = await claimToken(token.trim());
      await store.setAccessUrl(accessUrl);
      // Fetch only recent data — we just need the account list, not all history
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const accountSet = await fetchAccounts(accessUrl, yesterday);
      if (accountSet.errors.length > 0) {
        setError(`SimpleFin: ${accountSet.errors.join('; ')}`);
      }
      setSfAccounts(accountSet.accounts);
      setToken(''); // clear only after successful fetch (token is one-time-use; fetch errors are retryable with stored URL)
      setStep(2);
    } catch (e: any) {
      setError(e.message ?? 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Save mapping
  const handleSaveMapping = async (m: AccountMapping) => {
    try {
      await store.setAccountMapping(m);
      setMapping(m);
      setStep(3);
    } catch (e: any) {
      setError(e.message ?? 'Failed to save account mapping');
    }
  };

  // Step 3: Save rules
  const handleSaveRules = async () => {
    try {
      await store.setMappingRules(rules);
      setStep(4);
    } catch (e: any) {
      setError(e.message ?? 'Failed to save rules');
    }
  };

  // Step 4: Save schedule
  const handleFinish = async () => {
    try {
      await store.setSyncScheduleHours(autoSync ? scheduleHours : 0);
      onComplete();
    } catch (e: any) {
      setError(e.message ?? 'Failed to save schedule');
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <h2>SimpleFin Sync Setup</h2>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {step === 1 && (
        <div>
          <h3>Step 1 of 4 — Connect SimpleFin</h3>
          <p>Paste your SimpleFin setup token below. Get it from your bank's SimpleFin Bridge page.</p>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste setup token here"
            style={{ width: '100%', marginBottom: 8 }}
          />
          <button onClick={handleConnect} disabled={!token || loading}>
            {loading ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <h3>Step 2 of 4 — Map Accounts</h3>
          <AccountMapper
            ctx={ctx}
            simplefinAccounts={sfAccounts}
            initialMapping={mapping}
            onSave={handleSaveMapping}
          />
        </div>
      )}

      {step === 3 && (
        <div>
          <h3>Step 3 of 4 — Transaction Rules</h3>
          <RuleEditor rules={rules} onChange={setRules} />
          <button onClick={handleSaveRules} style={{ marginTop: 16 }}>
            Save Rules &amp; Continue
          </button>
        </div>
      )}

      {step === 4 && (
        <div>
          <h3>Step 4 of 4 — Schedule</h3>
          <label>
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(e) => setAutoSync(e.target.checked)}
            />{' '}
            Enable auto-sync
          </label>
          {autoSync && (
            <div style={{ marginTop: 12 }}>
              <label>Sync every:</label>
              <select
                value={scheduleHours}
                onChange={(e) => setScheduleHours(Number(e.target.value))}
                style={{ marginLeft: 8 }}
              >
                <option value={4}>4 hours</option>
                <option value={6}>6 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
              </select>
              <p style={{ fontSize: 12, opacity: 0.7 }}>
                SimpleFin Bridge refreshes from your bank every few hours — syncing more than 4×/day returns no new data.
              </p>
            </div>
          )}
          <button onClick={handleFinish} style={{ marginTop: 16 }}>
            Finish Setup
          </button>
        </div>
      )}
    </div>
  );
}
