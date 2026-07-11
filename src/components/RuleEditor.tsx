import React, { useState } from 'react';
import type { MappingRule, ActivityType } from '../../shared/types';
import { mapTransaction } from '../../shared/mapper';
import { Button, Input, Select } from './ui';

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
      <p className="sfin-subtle" style={{ fontSize: 12, marginTop: 0 }}>
        Rules run top-to-bottom. First match wins. Defaults: positive → DEPOSIT, negative → WITHDRAWAL.
      </p>
      {rules.map((rule, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <Select value={rule.matchType} onChange={(e) => updateRule(i, { matchType: e.target.value as 'contains' | 'regex' })}>
            <option value="contains">contains</option>
            <option value="regex">regex</option>
          </Select>
          <Input
            value={rule.pattern}
            onChange={(e) => updateRule(i, { pattern: e.target.value })}
            placeholder="pattern"
            style={{ flex: 1 }}
          />
          <span className="sfin-subtle">→</span>
          <Select value={rule.activityType} onChange={(e) => updateRule(i, { activityType: e.target.value as ActivityType })}>
            {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          <Button variant="ghost" onClick={() => removeRule(i)} aria-label="Remove rule">✕</Button>
        </div>
      ))}
      <Button variant="outline" onClick={addRule}>+ Add rule</Button>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Test a description:</strong>
        <Input
          value={testDesc}
          onChange={(e) => setTestDesc(e.target.value)}
          placeholder="e.g. AAPL DIVIDEND PAYMENT"
          style={{ width: 280 }}
        />
        {testResult && (
          <span style={{ fontWeight: 600 }}>→ {testResult}</span>
        )}
      </div>
    </div>
  );
}
