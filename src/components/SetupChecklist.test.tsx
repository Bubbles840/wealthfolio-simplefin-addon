import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { SetupChecklist } from './SetupChecklist';

const base = {
  companionVersion: null as string | null,
  telegramConfigured: false,
  amazonConfigured: false,
  dismissed: false,
  onDismiss: vi.fn(),
  onNavigate: vi.fn(),
};

describe('SetupChecklist', () => {
  it('shows incomplete rows with Set up links, complete rows without', () => {
    render(<SetupChecklist {...base} companionVersion="1.9.0" />);
    // Completed row names its evidence and loses its link.
    expect(screen.getByText(/companion v1\.9\.0 connected/i)).toBeTruthy();
    const links = screen.getAllByRole('button', { name: /set up/i });
    expect(links).toHaveLength(2); // telegram + amazon remain
  });

  it('sends each "Set up" to its own Settings card, not just the tab', () => {
    // Landing on a page of collapsed cards with the right one shut was the old
    // behaviour; the link now names the card to open.
    const onNavigate = vi.fn();
    render(<SetupChecklist {...base} onNavigate={onNavigate} />);
    const links = screen.getAllByRole('button', { name: /set up/i });
    links.forEach((l) => fireEvent.click(l));
    expect(onNavigate.mock.calls).toEqual([
      ['settings', 'docker'], ['settings', 'telegram'], ['settings', 'amazon'],
    ]);
  });

  it('disappears when dismissed, and when everything is complete', () => {
    const { container, rerender } = render(<SetupChecklist {...base} dismissed />);
    expect(container.textContent).toBe('');
    rerender(
      <SetupChecklist {...base} companionVersion="1.9.0" telegramConfigured amazonConfigured />,
    );
    expect(container.textContent).toBe('');
  });

  it('dismiss button reports up rather than hiding locally', () => {
    const onDismiss = vi.fn();
    render(<SetupChecklist {...base} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
