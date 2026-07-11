import React, { useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { AccountMapping, MappingRule, SimplefinAccount } from '../../shared/types';
import { claimToken, fetchAccounts } from '../utils/simplefin';
import { AccountMapper } from '../components/AccountMapper';
import { RuleEditor } from '../components/RuleEditor';
import { Button, Card, ErrorBox, Input, Select } from '../components/ui';
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
      const accessUrl = await claimToken(token.trim(), ctx.api.network);
      await store.setAccessUrl(accessUrl);

      // Pre-compute base64(user:pass) and store as a secret so the brokered
      // network request can reference it via auth.secretKey (SDK only supports
      // Bearer auth injection; we rely on SimpleFin accepting the b64 value).
      const parsedUrl = new URL(accessUrl);
      const credString = `${parsedUrl.username}:${parsedUrl.password}`;
      const b64 = btoa(
        encodeURIComponent(credString).replace(/%([0-9A-F]{2})/gi, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        ),
      );
      await store.setAuthB64(b64);
      const authKey = await store.getAuthB64Key();

      // Fetch only recent data — we just need the account list, not all history
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const accountSet = await fetchAccounts(accessUrl, yesterday, ctx.api.network, authKey);
      if (accountSet.errors.length > 0) {
        setError(`SimpleFin: ${accountSet.errors.join('; ')}`);
      }
      setSfAccounts(accountSet.accounts);
      await store.setAccountNames(
        Object.fromEntries(accountSet.accounts.map((a) => [a.id, a.name])),
      );
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
    <div className="sfin-page">
      <h2 className="sfin-title">SimpleFin Sync Setup</h2>

      {error && <ErrorBox>{error}</ErrorBox>}

      {step === 1 && (
        <Card>
          <div className="sfin-step">Step 1 of 4</div>
          <h3 style={{ margin: '0 0 8px' }}>Connect SimpleFin</h3>
          <p className="sfin-subtle" style={{ marginTop: 0 }}>
            Paste your SimpleFin setup token below. Get it from your bank's SimpleFin Bridge page.
          </p>
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste setup token here"
            style={{ width: '100%', marginBottom: 12 }}
          />
          <Button onClick={handleConnect} disabled={!token || loading}>
            {loading ? 'Connecting…' : 'Connect'}
          </Button>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <div className="sfin-step">Step 2 of 4</div>
          <h3 style={{ margin: '0 0 8px' }}>Map Accounts</h3>
          <AccountMapper
            ctx={ctx}
            simplefinAccounts={sfAccounts}
            initialMapping={mapping}
            onSave={handleSaveMapping}
          />
        </Card>
      )}

      {step === 3 && (
        <Card>
          <div className="sfin-step">Step 3 of 4</div>
          <h3 style={{ margin: '0 0 8px' }}>Transaction Rules</h3>
          <RuleEditor rules={rules} onChange={setRules} />
          <Button onClick={handleSaveRules} style={{ marginTop: 16 }}>
            Save Rules &amp; Continue
          </Button>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <div className="sfin-step">Step 4 of 4</div>
          <h3 style={{ margin: '0 0 8px' }}>Schedule</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(e) => setAutoSync(e.target.checked)}
            />
            Enable auto-sync
          </label>
          {autoSync && (
            <div style={{ marginTop: 12 }}>
              <label>Sync every:</label>
              <Select
                value={scheduleHours}
                onChange={(e) => setScheduleHours(Number(e.target.value))}
                style={{ marginLeft: 8 }}
              >
                <option value={4}>4 hours</option>
                <option value={6}>6 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
              </Select>
              <p className="sfin-subtle" style={{ fontSize: 12 }}>
                SimpleFin Bridge refreshes from your bank every few hours — syncing more than 4×/day returns no new data.
              </p>
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <Button onClick={handleFinish}>Finish Setup</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
