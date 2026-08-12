import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RuleEditor } from './RuleEditor';
import type { MappingRule } from '../../shared/types';

/**
 * Unit-level coverage for the rule editor's subtype control. Integration
 * assertions (the control reachable through the real Advanced tab, wired to
 * `store.setMappingRules`) live in `src/tabs/AdvancedTab.test.tsx` — this file
 * proves the component's own contract in isolation: what renders for which
 * `activityType`, and what `onChange` receives.
 */

const EMOJI = /\p{Extended_Pictographic}/u;

describe('RuleEditor subtype control', () => {
  it('offers a subtype select for a CREDIT rule and round-trips a chosen value back through onChange', () => {
    const rules: MappingRule[] = [
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT' },
    ];
    const onChange = vi.fn();
    render(<RuleEditor rules={rules} onChange={onChange} />);

    const subtypeSelect = screen.getByLabelText(/subtype/i) as HTMLSelectElement;
    // A select, not a free-text field — a typo'd subtype silently does
    // nothing, which is the exact failure mode this feature exists to fix.
    expect(subtypeSelect.tagName).toBe('SELECT');
    const optionValues = Array.from(subtypeSelect.options).map((o) => o.value);
    expect(optionValues).toEqual(['', 'REFUND', 'REBATE', 'REIMBURSEMENT']);

    fireEvent.change(subtypeSelect, { target: { value: 'REIMBURSEMENT' } });
    expect(onChange).toHaveBeenCalledWith([
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    ]);
  });

  it('has no subtype control for a non-CREDIT activityType', () => {
    const rules: MappingRule[] = [
      { pattern: 'PAYROLL', matchType: 'contains', activityType: 'DEPOSIT' },
    ];
    render(<RuleEditor rules={rules} onChange={vi.fn()} />);
    expect(screen.queryByLabelText(/subtype/i)).not.toBeInTheDocument();
  });

  it('renders and saves an existing subtype-less CREDIT rule completely unchanged until the user acts', () => {
    const rules: MappingRule[] = [
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT' },
    ];
    const onChange = vi.fn();
    render(<RuleEditor rules={rules} onChange={onChange} />);

    const subtypeSelect = screen.getByLabelText(/subtype/i) as HTMLSelectElement;
    // No subtype stored yet, so the control reads the none/empty option.
    expect(subtypeSelect.value).toBe('');

    // Touching an unrelated field (the pattern) must not invent a subtype key.
    fireEvent.change(screen.getByPlaceholderText('pattern'), { target: { value: 'VENMO PAYBACK' } });
    expect(onChange).toHaveBeenCalledWith([
      { pattern: 'VENMO PAYBACK', matchType: 'contains', activityType: 'CREDIT' },
    ]);
  });

  it('drops the subtype (does not send an empty string) when the user picks the none option', () => {
    const rules: MappingRule[] = [
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    ];
    const onChange = vi.fn();
    render(<RuleEditor rules={rules} onChange={onChange} />);

    const subtypeSelect = screen.getByLabelText(/subtype/i) as HTMLSelectElement;
    fireEvent.change(subtypeSelect, { target: { value: '' } });
    const [[updated]] = onChange.mock.calls;
    expect(updated[0].subtype).toBeUndefined();
  });

  it('switching a rule from CREDIT to a non-eligible type removes the subtype control', () => {
    const rules: MappingRule[] = [
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    ];
    const { rerender } = render(<RuleEditor rules={rules} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/subtype/i)).toBeInTheDocument();

    // Re-render as the parent would after onChange updated the rule's type.
    rerender(<RuleEditor rules={[{ ...rules[0], activityType: 'DEPOSIT' }]} onChange={vi.fn()} />);
    expect(screen.queryByLabelText(/subtype/i)).not.toBeInTheDocument();
  });

  it('explains, in one line, that a reimbursement subtype both reduces the filed category and applies to already-imported rows on the next sync — with no emoji', () => {
    const rules: MappingRule[] = [
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT' },
    ];
    render(<RuleEditor rules={rules} onChange={vi.fn()} />);

    const copy = screen.getByText(/reduce/i, { selector: 'p' });
    expect(copy.textContent).not.toMatch(EMOJI);
    // Both halves: what it does to the category...
    expect(copy.textContent).toMatch(/reduce/i);
    expect(copy.textContent).toMatch(/instead of counting as income/i);
    // ...and that it reaches history, not just future imports.
    expect(copy.textContent).toMatch(/already imported/i);
    expect(copy.textContent).toMatch(/next.*sync/i);
  });

  it('clears a stored subtype when the rule\'s activityType is changed away from CREDIT, rather than leaving it as invisible dead data', () => {
    const rules: MappingRule[] = [
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    ];
    const onChange = vi.fn();
    render(<RuleEditor rules={rules} onChange={onChange} />);

    const activityTypeSelect = screen.getByDisplayValue('CREDIT') as HTMLSelectElement;
    fireEvent.change(activityTypeSelect, { target: { value: 'DEPOSIT' } });
    expect(onChange).toHaveBeenCalledWith([
      { pattern: 'VENMO', matchType: 'contains', activityType: 'DEPOSIT', subtype: undefined },
    ]);
  });

  it('shows no reimbursement copy when no rule is a CREDIT rule', () => {
    const rules: MappingRule[] = [
      { pattern: 'PAYROLL', matchType: 'contains', activityType: 'DEPOSIT' },
    ];
    render(<RuleEditor rules={rules} onChange={vi.fn()} />);
    expect(screen.queryByText(/instead of counting as income/i)).not.toBeInTheDocument();
  });
});
