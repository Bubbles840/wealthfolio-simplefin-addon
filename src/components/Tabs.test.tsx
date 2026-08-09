import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { TabBar, TabId } from './Tabs';

const TABS = [
  { id: 'overview' as const, label: 'Overview' },
  { id: 'notifications' as const, label: 'Notifications' },
  { id: 'advanced' as const, label: 'Advanced' },
];

// Stateful wrapper for tests that need actual state changes
function StatefulTabBar() {
  const [active, setActive] = useState<TabId>('overview');
  return <TabBar tabs={TABS} active={active} onChange={setActive} />;
}

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

  it('arrow keys move selection with wrap-around at both ends', async () => {
    render(<StatefulTabBar />);
    // Test right-arrow from last tab wraps to first
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Advanced' }).getAttribute('aria-selected')).toBe('true'));
    const lastTab = screen.getByRole('tab', { name: 'Advanced' });
    fireEvent.keyDown(lastTab, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true'));

    // Test left-arrow from first tab wraps to last
    const firstTab = screen.getByRole('tab', { name: 'Overview' });
    fireEvent.keyDown(firstTab, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Advanced' }).getAttribute('aria-selected')).toBe('true'));
  });

  it('only the active tab is in the tab order (roving tabindex)', () => {
    render(<TabBar tabs={TABS} active="notifications" onChange={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('focus follows selection on arrow key navigation', async () => {
    render(<StatefulTabBar />);
    const overviewTab = screen.getByRole('tab', { name: 'Overview' });

    // Start with Overview focused and active
    overviewTab.focus();
    expect(document.activeElement).toBe(overviewTab);

    // Arrow right to Notifications
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });
    const notificationsTab = screen.getByRole('tab', { name: 'Notifications' });
    await waitFor(() => expect(document.activeElement).toBe(notificationsTab));
  });
});
