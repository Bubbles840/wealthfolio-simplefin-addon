import React, { useRef, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { AccountMapping, SimplefinAccount } from '../../shared/types';
import { claimToken, fetchAccounts } from '../utils/simplefin';
import { AccountMapper } from '../components/AccountMapper';
import { Button, Card, ErrorBox, Input } from '../components/ui';
import type { SecretsStore } from '../utils/secrets';
import { accountCreatedChange } from '../../shared/change-entries';
import { directCallLine } from '../../shared/simplefin-budget';
import { BudgetPreview } from '../tabs/BudgetTab';

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
  /** The token claimed in this visit and the access URL it gave. */
  const claimed = useRef<{ token: string; accessUrl: string } | null>(null);
  const [sfAccounts, setSfAccounts] = useState<SimplefinAccount[]>([]);
  const [mapping, setMapping] = useState<AccountMapping>({});
  /** Step 1's "See what it looks like": the sample-data preview (project 4). */
  const [preview, setPreview] = useState(false);
  const previewToggle = useRef<HTMLButtonElement>(null);

  // Step 1: Claim token
  const handleConnect = async () => {
    setError('');
    setLoading(true);
    try {
      // Asked BEFORE the one-time token is claimed, so a refusal costs nothing:
      // the token stays unspent and the person can simply try again later.
      const refused = await directCallLine(store, 'setup');
      if (refused) { setError(refused); return; }
      // A token can be claimed once: a retry after a failed download reuses
      // the access URL this token already gave, and only a new token is claimed.
      const pasted = token.trim();
      const accessUrl = claimed.current?.token === pasted
        ? claimed.current.accessUrl
        : await claimToken(pasted, ctx.api.network);
      claimed.current = { token: pasted, accessUrl };
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
              Paste your SimpleFin setup token below. Get it from SimpleFin Bridge, or from Lunch Flow by adding an Actual Budget destination there, which gives a SimpleFIN setup token.
            </p>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste setup token here"
            />
            <Button onClick={handleConnect} disabled={!token || loading}>
              {loading ? 'Connecting…' : 'Connect'}
            </Button>
            <Button variant="ghost" ref={previewToggle} aria-expanded={preview} onClick={() => setPreview((p) => !p)}>
              See what it looks like
            </Button>
          </div>
        </Card>
      )}

      {/* The Budget board over made-up data, read-only, under its banner — the
          same preview as the empty Budget board's. It writes nothing. */}
      {step === 1 && preview && (
        <div className="sfin-setup-preview">
          <BudgetPreview store={store} onExit={() => { setPreview(false); previewToggle.current?.focus(); }} />
        </div>
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
              onAccountCreated={(created) => { void store.recordChange?.(accountCreatedChange(created)); }}
            />
          </div>
        </Card>
      )}

    </div>
  );
}
