import React, { useState } from 'react';
import type { MappingRule, ActivityType } from '../../shared/types';
import { mapTransaction } from '../../shared/mapper';

const ACTIVITY_TYPES: ActivityType[] = [
  'BUY','SELL','SPLIT','DIVIDEND','INTEREST','DEPOSIT','WITHDRAWAL',
  'TRANSFER_IN','TRANSFER_OUT','FEE','TAX','CREDIT','ADJUSTMENT','UNKNOWN',
];

interface Props {
  rules: MappingRule[];
  onChange: (rules: MappingRule[]) => void;
}

export function RuleEditor({ rules, onChange }: Props) {
  const [testDesc, setTestDesc] = useState('');

  const addRule = () => {
    onChange([...rules, { pattern: '', matchType: 'contains', activityType: 'DEPOSIT' }]);
  };

  const removeRule = (i: number) => {
    onChange(rules.filter((_, idx) => idx !== i));
  };

  const updateRule = (i: number, patch: Partial<MappingRule>) => {
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  let testResult: string | null = null;
  if (testDesc) {
    try {
      testResult = mapTransaction(testDesc, 1, rules);
    } catch {
      testResult = '(invalid regex pattern)';
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12, opacity: 0.7 }}>
        Rules run top-to-bottom. First match wins. Defaults: positive → DEPOSIT, negative → WITHDRAWAL.
      </p>
      {rules.map((rule, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <select value={rule.matchType} onChange={(e) => updateRule(i, { matchType: e.target.value as 'contains' | 'regex' })}>
            <option value="contains">contains</option>
            <option value="regex">regex</option>
          </select>
          <input
            value={rule.pattern}
            onChange={(e) => updateRule(i, { pattern: e.target.value })}
            placeholder="pattern"
            style={{ flex: 1 }}
          />
          <span>→</span>
          <select value={rule.activityType} onChange={(e) => updateRule(i, { activityType: e.target.value as ActivityType })}>
            {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" onClick={() => removeRule(i)}>✕</button>
        </div>
      ))}
      <button type="button" onClick={addRule}>+ Add rule</button>

      <div style={{ marginTop: 16 }}>
        <strong>Test a description:</strong>
        <input
          value={testDesc}
          onChange={(e) => setTestDesc(e.target.value)}
          placeholder="e.g. AAPL DIVIDEND PAYMENT"
          style={{ marginLeft: 8, width: 280 }}
        />
        {testResult && (
          <span style={{ marginLeft: 8, fontWeight: 'bold' }}>→ {testResult}</span>
        )}
      </div>
    </div>
  );
}
