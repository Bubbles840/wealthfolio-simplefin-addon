import React, { useState } from 'react';
import type { MappingRule, ActivityType } from '../../shared/types';
import { mapTransactionWithSource, mappingRuleProblem, MAPPING_RULE_PROBLEM_TEXT } from '../../shared/mapper';
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
  /** Wealthfolio account names by id, to name a rule's account. Optional: the id is shown without it. */
  accountNames?: Record<string, string>;
}

/** The limits the companion's payback rules carry (money in only, one account, from a day on):
 *  shown read-only and kept on every edit (they ride along in the rule object). */
const hasLimits = (r: MappingRule): boolean => !!r.accountId || r.onlyMoneyIn === true || !!r.since;

export function RuleEditor({ rules, onChange, accountNames = {} }: Props) {
  const [testDesc, setTestDesc] = useState('');
  const [testAccount, setTestAccount] = useState('');
  const [testIn, setTestIn] = useState(true);
  const accountName = (id: string) => accountNames[id] ?? id;
  const testAccountIds = [...new Set(rules.map((r) => r.accountId).filter((id): id is string => !!id))];
  const anyLimits = rules.some(hasLimits);

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
      // The limits are honoured: a rule for one account reads only that account, a money-in rule
      // only money in, and a rule that starts on a day reads only transactions from then on.
      const mapped = mapTransactionWithSource(
        testDesc, testIn ? 1 : -1, rules, undefined, testAccount || undefined, new Date().toISOString().slice(0, 10),
      );
      testResult = mapped.subtype ? `${mapped.type} · ${mapped.subtype}` : mapped.type;
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
        <div key={i} style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
        {(() => {
          const problem = mappingRuleProblem(rule);
          return problem && (
            <div className="sfin-log-note" role="status" style={{ marginTop: 2 }}>
              {MAPPING_RULE_PROBLEM_TEXT[problem]}
            </div>
          );
        })()}
        {hasLimits(rule) && (
          <div className="sfin-subtle" style={{ fontSize: 12, marginTop: 2 }}>
            {[
              rule.onlyMoneyIn ? 'Money in only' : null,
              rule.accountId ? `${rule.onlyMoneyIn ? 'one' : 'One'} account (${accountName(rule.accountId)})` : null,
              rule.since ? `from ${rule.since}` : null,
            ].filter(Boolean).join(' · ')}
            . Made from Telegram; kept as it is when you edit this rule.
          </div>
        )}
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
        {anyLimits && (
          <>
            <Select aria-label="Test direction" value={testIn ? 'in' : 'out'} onChange={(e) => setTestIn(e.target.value === 'in')}>
              <option value="in">money in</option>
              <option value="out">money out</option>
            </Select>
            <Select aria-label="Test account" value={testAccount} onChange={(e) => setTestAccount(e.target.value)}>
              <option value="">any other account</option>
              {testAccountIds.map((id) => <option key={id} value={id}>{accountName(id)}</option>)}
            </Select>
          </>
        )}
        {testResult && (
          <span data-testid="rule-test-result" style={{ fontWeight: 600 }}>→ {testResult}</span>
        )}
      </div>
    </div>
  );
}
