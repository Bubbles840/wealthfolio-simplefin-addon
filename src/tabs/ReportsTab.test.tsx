import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ReportsTab, ReportText } from './ReportsTab';
import type { ReportKind, ReportStore } from '../../shared/reports-archive';

const store = (data: Partial<Record<ReportKind, ReportStore>>) => ({
  getReports: vi.fn(async (kind: ReportKind) => data[kind] ?? { live: null, archive: [] }),
});
const edition = (kind: ReportKind, period: string, text: string) => ({
  kind, period, title: `Title ${period}`, generatedAt: '2026-09-23T13:05:00.000Z', text,
});

describe('ReportsTab', () => {
  it('shows the live daily report on top and past editions below', async () => {
    const s = store({
      daily: {
        live: edition('daily', '2026-09-23', '*Groceries* $42.10 left'),
        archive: [edition('daily', '2026-09-22', 'Yesterday text'), edition('daily', '2026-09-21', 'Older text')],
      },
    });
    render(<ReportsTab store={s} />);
    expect(await screen.findByText('Groceries')).toBeTruthy();
    expect(screen.getByText('Title 2026-09-22')).toBeTruthy();
    expect(screen.getByText('Title 2026-09-21')).toBeTruthy();
    expect(s.getReports).toHaveBeenCalledWith('daily');
  });

  it('switches to the weekly report', async () => {
    const s = store({ weekly: { live: edition('weekly', '2026-09-21', 'Week text'), archive: [] } });
    render(<ReportsTab store={s} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Weekly' }));
    expect(await screen.findByText('Week text')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Weekly' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens on the report a notification link asked for', async () => {
    const s = store({ monthly: { live: null, archive: [edition('monthly', '2026-08', 'August wrap-up')] } });
    render(<ReportsTab store={s} initialReport="monthly" />);
    expect(await screen.findByText('Title 2026-08')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Monthly' }).getAttribute('aria-selected')).toBe('true');
  });

  it('explains an empty report instead of showing nothing', async () => {
    render(<ReportsTab store={store({})} />);
    await waitFor(() => expect(screen.getByText(/No daily reports yet/)).toBeTruthy());
  });
});

describe('ReportText', () => {
  it("renders Telegram's markdown: bold, italic, code and links, line by line", () => {
    const { container } = render(<ReportText text={'*Bold* and _it_ and `x`\n[Open](https://example.com) now'} />);
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('em')?.textContent).toBe('it');
    expect(container.querySelector('code')?.textContent).toBe('x');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelectorAll('.sfin-report-line')).toHaveLength(2);
  });

  it('leaves a lone asterisk as text', () => {
    const { container } = render(<ReportText text={'5 * 3 = 15'} />);
    expect(container.textContent).toBe('5 * 3 = 15');
    expect(container.querySelector('strong')).toBeNull();
  });
});
