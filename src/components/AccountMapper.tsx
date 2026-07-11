import React, { useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { SimplefinAccount, AccountMapping } from '../../shared/types';
import { Button, ErrorBox, Select } from './ui';

interface Props {
  ctx: AddonContext;
  simplefinAccounts: SimplefinAccount[];
  initialMapping: AccountMapping;
  onSave: (mapping: AccountMapping) => void;
}

const CREATE_NEW_VALUE = '__create_new__';

const ACCOUNT_TYPE_OPTIONS = [
  { type: 'CASH', label: 'Bank / Cash' },
  { type: 'CREDIT_CARD', label: 'Credit Card' },
  { type: 'SECURITIES', label: 'Investment' },
] as const;

type CreatableAccountType = (typeof ACCOUNT_TYPE_OPTIONS)[number]['type'];

export function AccountMapper({ ctx, simplefinAccounts, initialMapping, onSave }: Props) {
  const [wfAccounts, setWfAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [mapping, setMapping] = useState<AccountMapping>(initialMapping);
  const [loadError, setLoadError] = useState('');
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});
  const [pendingTypeChoice, setPendingTypeChoice] = useState<string | null>(null);

  useEffect(() => {
    ctx.api.accounts.getAll()
      .then(setWfAccounts)
      .catch((e: any) => setLoadError(e.message ?? 'Failed to load accounts'));
  }, [ctx]);

  const handleSelect = (sfin: SimplefinAccount, value: string) => {
    if (value === CREATE_NEW_VALUE) {
      // Don't create yet — ask what kind of account this is first
      setPendingTypeChoice(sfin.id);
      return;
    }
    setPendingTypeChoice(null);
    setMapping((prev) => ({ ...prev, [sfin.id]: value }));
  };

  const handleCreateAccount = async (sfin: SimplefinAccount, accountType: CreatableAccountType) => {
    setPendingTypeChoice(null);
    setCreateErrors((prev) => ({ ...prev, [sfin.id]: '' }));
    setCreatingId(sfin.id);
    try {
      const created = await ctx.api.accounts.create({
        name: sfin.name,
        accountType,
        currency: sfin.currency,
        isDefault: false,
        isActive: true,
        trackingMode: 'TRANSACTIONS',
      });
      setWfAccounts((prev) => [...prev, { id: created.id, name: created.name }]);
      setMapping((prev) => ({ ...prev, [sfin.id]: created.id }));
    } catch (e: any) {
      setCreateErrors((prev) => ({
        ...prev,
        [sfin.id]: e.message ?? 'Failed to create account',
      }));
    } finally {
      setCreatingId(null);
    }
  };

  const handleAutoMatch = () => {
    const auto: AccountMapping = { ...mapping };
    for (const sfin of simplefinAccounts) {
      const match = wfAccounts.find(
        (wf) => wf.name.toLowerCase() === sfin.name.toLowerCase(),
      );
      if (match) auto[sfin.id] = match.id;
    }
    setMapping(auto);
  };

  return (
    <div>
      {loadError && <ErrorBox>{loadError}</ErrorBox>}
      <div style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
        <div className="sfin-section-label" style={{ flex: 1, marginBottom: 0 }}>SimpleFin Account</div>
        <div className="sfin-section-label" style={{ flex: 1, marginBottom: 0 }}>Wealthfolio Account</div>
      </div>
      {simplefinAccounts.map((sfin) => (
        <div key={sfin.id} className="sfin-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>{sfin.name}</div>
            <div className="sfin-subtle" style={{ fontSize: 12 }}>{sfin.currency} • balance: {sfin.balance}</div>
          </div>
          <div style={{ flex: 1 }}>
            <Select
              value={mapping[sfin.id] ?? ''}
              onChange={(e) => handleSelect(sfin, e.target.value)}
              disabled={creatingId === sfin.id}
              style={{ width: '100%' }}
            >
              <option value="">— Select account —</option>
              {wfAccounts.map((wf) => (
                <option key={wf.id} value={wf.id}>{wf.name}</option>
              ))}
              <option value={CREATE_NEW_VALUE}>+ Create new account</option>
            </Select>
            {pendingTypeChoice === sfin.id && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="sfin-subtle" style={{ fontSize: 12 }}>What kind of account?</span>
                {ACCOUNT_TYPE_OPTIONS.map((opt) => (
                  <Button key={opt.type} variant="outline" style={{ padding: '3px 8px', fontSize: 12 }}
                    onClick={() => handleCreateAccount(sfin, opt.type)}>
                    {opt.label}
                  </Button>
                ))}
                <Button variant="ghost" style={{ padding: '3px 8px', fontSize: 12 }}
                  onClick={() => setPendingTypeChoice(null)}>
                  Cancel
                </Button>
              </div>
            )}
            {creatingId === sfin.id && (
              <div className="sfin-subtle" style={{ fontSize: 12, marginTop: 4 }}>Creating account…</div>
            )}
            {createErrors[sfin.id] && (
              <div style={{ fontSize: 12, marginTop: 4, color: 'var(--destructive)' }}>{createErrors[sfin.id]}</div>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button variant="outline" onClick={handleAutoMatch}>Auto-match by name</Button>
        <Button
          onClick={() => {
            const cleanMapping = Object.fromEntries(
              Object.entries(mapping).filter(([, v]) => !!v)
            );
            onSave(cleanMapping);
          }}
          disabled={Object.values(mapping).filter(Boolean).length === 0}
        >
          Save Mapping
        </Button>
      </div>
    </div>
  );
}
