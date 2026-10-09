import React, { useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { AccountMapping, SimplefinAccount } from '../../shared/types';
import { claimToken, fetchAccounts } from '../utils/simplefin';
import { AccountMapper } from '../components/AccountMapper';
import { Button, Card, ErrorBox, Input } from '../components/ui';
import type { SecretsStore } from '../utils/secrets';

/** Two steps since 1.57: connect, then map. Rules start empty and the schedule
 *  starts at every 6 hours; both are in Settings for anyone who wants them. */
type Step = 1 | 2;

/** The schedule a finished setup starts with. Was OFF unless ticked on a
 *  fourth step, which left new installs syncing only when Sync now was pressed. */
const DEFAULT_SYNC_HOURS = 6;

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

  // Step 2: save the mapping, and finish.
  const handleSaveMapping = async (m: AccountMapping) => {
    try {
      await store.setAccountMapping(m);
      setMapping(m);
      await store.setSyncScheduleHours(DEFAULT_SYNC_HOURS);
      onComplete();
    } catch (e: any) {
      setError(e.message ?? 'Failed to save account mapping');
    }
  };

  return (
    <div className="sfin-page">
      <h2 className="sfin-title">SimpleFin Sync setup</h2>

      {error && <ErrorBox>{error}</ErrorBox>}

      {step === 1 && (
        <Card>
          <div className="sfin-setup-step">
            <div className="sfin-step">Step 1 of 2</div>
            <h3>Connect SimpleFin</h3>
            <p className="sfin-subtle">
              Paste your SimpleFin setup token below. Get it from your bank's SimpleFin Bridge page.
            </p>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste setup token here"
            />
            <Button onClick={handleConnect} disabled={!token || loading}>
              {loading ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <div className="sfin-setup-step">
            <div className="sfin-step">Step 2 of 2</div>
            <h3>Map accounts</h3>
            <p className="sfin-subtle">
              Pick the Wealthfolio account each bank account writes into. Saving finishes
              setup and syncs every 6 hours; change that in Settings → Sync.
            </p>
            <AccountMapper
              ctx={ctx}
              simplefinAccounts={sfAccounts}
              initialMapping={mapping}
              onSave={handleSaveMapping}
            />
          </div>
        </Card>
      )}

    </div>
  );
}
