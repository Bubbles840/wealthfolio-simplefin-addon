import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { TabBar, TabId, resolveStoredTab } from './Tabs';

const TABS = [
  { id: 'home' as const, label: 'Home' },
  { id: 'reports' as const, label: 'Reports' },
  { id: 'settings' as const, label: 'Settings' },
];

// Stateful wrapper for tests that need actual state changes
function StatefulTabBar() {
  const [active, setActive] = useState<TabId>('home');
  return <TabBar tabs={TABS} active={active} onChange={setActive} />;
}

describe('TabBar', () => {
  it('is a real tablist: roles, selection state, panel wiring', () => {
    render(<TabBar tabs={TABS} active="home" onChange={() => {}} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[0].getAttribute('aria-controls')).toBe('sfin-panel-home');
  });

  it('clicking a tab reports the change', () => {
    const onChange = vi.fn();
    render(<TabBar tabs={TABS} active="home" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(onChange).toHaveBeenCalledWith('settings');
  });

  it('arrow keys move selection with wrap-around at both ends', async () => {
    render(<StatefulTabBar />);
    // Test right-arrow from last tab wraps to first
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true'));
    const lastTab = screen.getByRole('tab', { name: 'Settings' });
    fireEvent.keyDown(lastTab, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Home' }).getAttribute('aria-selected')).toBe('true'));

    // Test left-arrow from first tab wraps to last
    const firstTab = screen.getByRole('tab', { name: 'Home' });
    fireEvent.keyDown(firstTab, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true'));
  });

  it('only the active tab is in the tab order (roving tabindex)', () => {
    render(<TabBar tabs={TABS} active="reports" onChange={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('focus follows selection on arrow key navigation', async () => {
    render(<StatefulTabBar />);
    const overviewTab = screen.getByRole('tab', { name: 'Home' });

    // Start with Overview focused and active
    overviewTab.focus();
    expect(document.activeElement).toBe(overviewTab);

    // Arrow right to Notifications
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });
    const notificationsTab = screen.getByRole('tab', { name: 'Reports' });
    await waitFor(() => expect(document.activeElement).toBe(notificationsTab));
  });
});

describe('resolveStoredTab', () => {
  // ui_state is an unvalidated stored blob written by every version since the
  // tabs existed; 1.56 and earlier had five. It must always open a real tab.
  it.each([
    ['budget', 'home'], ['overview', 'home'], ['home', 'home'],
    ['notifications', 'settings'], ['advanced', 'settings'], ['settings', 'settings'],
    ['reports', 'reports'],
    [undefined, 'home'], [null, 'home'], ['garbage', 'home'], [42, 'home'],
  ])('maps a stored %s to %s', (stored, expected) => {
    expect(resolveStoredTab(stored)).toBe(expected);
  });
});
