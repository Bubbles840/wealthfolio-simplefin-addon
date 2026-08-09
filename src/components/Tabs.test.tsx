import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { TabBar } from './Tabs';

const TABS = [
  { id: 'overview' as const, label: 'Overview' },
  { id: 'notifications' as const, label: 'Notifications' },
  { id: 'advanced' as const, label: 'Advanced' },
];

describe('TabBar', () => {
  it('is a real tablist: roles, selection state, panel wiring', () => {
    render(<TabBar tabs={TABS} active="overview" onChange={() => {}} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[0].getAttribute('aria-controls')).toBe('sfin-panel-overview');
  });

  it('clicking a tab reports the change', () => {
    const onChange = vi.fn();
    render(<TabBar tabs={TABS} active="overview" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(onChange).toHaveBeenCalledWith('advanced');
  });

  it('arrow keys move selection with wrap-around', () => {
    const onChange = vi.fn();
    render(<TabBar tabs={TABS} active="overview" onChange={onChange} />);
    const first = screen.getByRole('tab', { name: 'Overview' });
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('notifications');
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('advanced'); // wraps
  });

  it('only the active tab is in the tab order (roving tabindex)', () => {
    render(<TabBar tabs={TABS} active="notifications" onChange={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });
});
