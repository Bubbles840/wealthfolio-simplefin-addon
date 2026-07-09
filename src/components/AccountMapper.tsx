import React, { useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { SimplefinAccount, AccountMapping } from '../../shared/types';

interface Props {
  ctx: AddonContext;
  simplefinAccounts: SimplefinAccount[];
  initialMapping: AccountMapping;
  onSave: (mapping: AccountMapping) => void;
}

export function AccountMapper({ ctx, simplefinAccounts, initialMapping, onSave }: Props) {
  const [wfAccounts, setWfAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [mapping, setMapping] = useState<AccountMapping>(initialMapping);

  useEffect(() => {
    ctx.api.accounts.getAll().then(setWfAccounts);
  }, [ctx]);

  const handleSelect = (sfinId: string, wfId: string) => {
    setMapping((prev) => ({ ...prev, [sfinId]: wfId }));
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
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <strong style={{ flex: 1 }}>SimpleFin Account</strong>
        <strong style={{ flex: 1 }}>Wealthfolio Account</strong>
      </div>
      {simplefinAccounts.map((sfin) => (
        <div key={sfin.id} style={{ display: 'flex', gap: 16, marginBottom: 8, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div>{sfin.name}</div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>{sfin.currency} • balance: {sfin.balance}</div>
          </div>
          <div style={{ flex: 1 }}>
            <select
              value={mapping[sfin.id] ?? ''}
              onChange={(e) => handleSelect(sfin.id, e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">— Select account —</option>
              {wfAccounts.map((wf) => (
                <option key={wf.id} value={wf.id}>{wf.name}</option>
              ))}
            </select>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button type="button" onClick={handleAutoMatch}>Auto-match by name</button>
        <button
          type="button"
          onClick={() => {
            const cleanMapping = Object.fromEntries(
              Object.entries(mapping).filter(([, v]) => !!v)
            );
            onSave(cleanMapping);
          }}
          disabled={Object.keys(mapping).length === 0}
        >
          Save Mapping
        </button>
      </div>
    </div>
  );
}
