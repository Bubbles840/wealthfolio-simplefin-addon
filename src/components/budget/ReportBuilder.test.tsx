import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ReportBuilder } from './ReportBuilder';
import { CUBE } from '../../../shared/report-cube.test';
import type { CustomReport } from '../../../shared/report-eval';

vi.mock('recharts', () => {
  const stub = (name: string) => (p: any) =>
    React.createElement(
      'div',
      { 'data-recharts': name, 'data-points': p?.data ? JSON.stringify(p.data) : undefined },
      p?.children ?? null,
    );
  return {
    Area: stub('Area'), AreaChart: stub('AreaChart'), Bar: stub('Bar'), BarChart: stub('BarChart'),
    CartesianGrid: stub('CartesianGrid'), Cell: stub('Cell'), Line: stub('Line'),
    LineChart: stub('LineChart'), Pie: stub('Pie'), PieChart: stub('PieChart'),
    XAxis: stub('XAxis'), YAxis: stub('YAxis'),
  };
});
vi.mock('@wealthfolio/ui/chart', () => ({
  ChartContainer: (p: any) => React.createElement('div', null, p.children),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartStyle: () => null,
}));

const setup = (existing: CustomReport | null = null) => {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(<ReportBuilder cube={CUBE} existing={existing} onSave={onSave} onCancel={onCancel} />);
  return { onSave, onCancel };
};

const addTerm = (value: string) =>
  fireEvent.change(screen.getByLabelText(/add to series 1/i), { target: { value } });

describe('ReportBuilder', () => {
  it('builds series from category chips and saves a well-formed definition', () => {
    const { onSave } = setup();
    fireEvent.change(screen.getByLabelText(/report name/i), { target: { value: 'Food' } });
    fireEvent.change(screen.getByLabelText(/series 1 label/i), { target: { value: 'Food' } });
    addTerm('category:Dining');
    addTerm('category:Groceries');
    fireEvent.click(screen.getByRole('button', { name: /save report/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const def: CustomReport = onSave.mock.calls[0][0];
    expect(def.id).toMatch(/^cr-/);
    expect(def.name).toBe('Food');
    expect(def.accounts).toBeNull();
    expect(def.series).toEqual([{
      label: 'Food',
      terms: [
        { sign: 1, source: 'category', category: 'Dining' },
        { sign: 1, source: 'category', category: 'Groceries' },
      ],
    }]);
  });

  it('updates the live preview on every tap', () => {
    setup();
    addTerm('category:Dining');
    // Jul Dining = $30 in the preview table.
    expect(screen.getByText('$30')).toBeInTheDocument();
    addTerm('category:Groceries');
    expect(screen.getByText('$60')).toBeInTheDocument();
  });

  it('toggles a term to subtract by tapping its chip', () => {
    const { onSave } = setup();
    fireEvent.change(screen.getByLabelText(/report name/i), { target: { value: 'X' } });
    addTerm('income');
    addTerm('category:Dining');
    fireEvent.click(screen.getByRole('button', { name: /^\+ Dining$/ }));
    expect(screen.getByRole('button', { name: /^− Dining$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save report/i }));
    const def: CustomReport = onSave.mock.calls[0][0];
    expect(def.series[0].terms).toEqual([
      { sign: 1, source: 'income' },
      { sign: -1, source: 'category', category: 'Dining' },
    ]);
  });

  it('carries chart, range, and account filters into the definition', () => {
    const { onSave } = setup();
    fireEvent.change(screen.getByLabelText(/report name/i), { target: { value: 'X' } });
    addTerm('spending');
    fireEvent.change(screen.getByLabelText(/chart type/i), { target: { value: 'table' } });
    fireEvent.change(screen.getByLabelText(/date range/i), { target: { value: '6' } });
    fireEvent.click(screen.getByLabelText(/^Card$/)); // uncheck the card account
    fireEvent.click(screen.getByRole('button', { name: /save report/i }));
    const def: CustomReport = onSave.mock.calls[0][0];
    expect(def.chart).toBe('table');
    expect(def.range).toEqual({ kind: 'months', n: 6 });
    expect(def.accounts).toEqual(['sfin-1']);
  });

  it('prefills from an existing report and preserves its id on save', () => {
    const existing: CustomReport = {
      id: 'cr-9', name: 'Old name', chart: 'line', range: { kind: 'all' }, accounts: null,
      series: [{ label: 'S', terms: [{ sign: 1, source: 'spending' }] }],
    };
    const { onSave } = setup(existing);
    const name = screen.getByLabelText(/report name/i) as HTMLInputElement;
    expect(name.value).toBe('Old name');
    fireEvent.change(name, { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: /save report/i }));
    const def: CustomReport = onSave.mock.calls[0][0];
    expect(def.id).toBe('cr-9');
    expect(def.name).toBe('New name');
  });

  it('refuses to save with no name or no terms, and cancel calls back', () => {
    const { onSave, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /save report/i }));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
