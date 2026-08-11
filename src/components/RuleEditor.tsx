import React, { useState } from 'react';
import type { MappingRule, ActivityType } from '../../shared/types';
import { mapTransaction } from '../../shared/mapper';
import { Button, Input, Select } from './ui';

const ACTIVITY_TYPES: ActivityType[] = [
  'BUY','SELL','SPLIT','DIVIDEND','INTEREST','DEPOSIT','WITHDRAWAL',
  'TRANSFER_IN','TRANSFER_OUT','FEE','TAX','CREDIT','ADJUSTMENT','UNKNOWN',
];

/** Wealthfolio reads `subtype` only on the CREDIT branch of its bucket
 *  classifier (docs/upstream-spending-buckets.md §2) — a DEPOSIT is Income
 *  unconditionally, subtype or not. Offering the field for any other
 *  activityType would offer something that silently does nothing, so the
 *  field (and its explainer copy below) only ever appears for CREDIT. */
const SUBTYPE_ELIGIBLE_TYPES = new Set<ActivityType>(['CREDIT']);

/** The three values Wealthfolio's classifier folds into the spending bucket,
 *  plus the none option. Named plainly rather than left as free text: a
 *  typo'd subtype (e.g. "Reimbursment") is accepted by Wealthfolio and
 *  silently classified as Ignored — exactly the failure this feature exists
 *  to eliminate. */
const REFUND_SUBTYPES = ['REFUND', 'REBATE', 'REIMBURSEMENT'] as const;

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

  const hasCreditRule = rules.some((r) => SUBTYPE_ELIGIBLE_TYPES.has(r.activityType));

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
          <Select
            value={rule.activityType}
            onChange={(e) => updateRule(i, { activityType: e.target.value as ActivityType, subtype: undefined })}
          >
            {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          {SUBTYPE_ELIGIBLE_TYPES.has(rule.activityType) && (
            <Select
              aria-label="Subtype"
              value={rule.subtype ?? ''}
              onChange={(e) => updateRule(i, { subtype: e.target.value || undefined })}
            >
              <option value="">No subtype</option>
              {REFUND_SUBTYPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          )}
          <Button variant="ghost" onClick={() => removeRule(i)} aria-label="Remove rule">✕</Button>
        </div>
      ))}
      {hasCreditRule && (
        <p className="sfin-subtle" style={{ fontSize: 12, margin: '0 0 8px' }}>
          Setting REFUND, REBATE, or REIMBURSEMENT on a CREDIT rule makes it reduce whatever
          category you file it under instead of counting as income — and updates transactions
          you&rsquo;ve already imported, the next time you sync.
        </p>
      )}
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
