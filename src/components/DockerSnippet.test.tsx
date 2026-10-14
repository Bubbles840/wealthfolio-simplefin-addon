import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { browserTimezone, DockerSnippet } from './DockerSnippet';
import { composeSnippet } from '../../shared/compose-snippet';

const EMOJI = /\p{Extended_Pictographic}/u;
const shown = () => document.querySelector('pre')!.textContent;

describe('DockerSnippet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('renders the shared snippet with the timezone filled in, and never a password', () => {
    render(<DockerSnippet timezone="Europe/Berlin" />);
    expect(shown()).toBe(composeSnippet({ timezone: 'Europe/Berlin' }));
    expect(shown()).toContain('      - TZ=Europe/Berlin\n');
    expect(shown()).not.toMatch(/WEALTHFOLIO_PASSWORD=/);
    expect(document.body.textContent).not.toMatch(EMOJI);
  });

  it('says where the snippet goes: the same compose file as Wealthfolio, merged', () => {
    render(<DockerSnippet timezone="Europe/Berlin" />);
    const note = document.querySelector('.sfin-docker-intro')!;
    expect(note.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'Add this to the same docker-compose.yml as Wealthfolio — merge its services: and secrets: into the ones already there.',
    );
  });

  it("fills in this browser's own timezone by default", () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: 'Asia/Tokyo' };
    });
    expect(browserTimezone()).toBe('Asia/Tokyo');
    render(<DockerSnippet />);
    expect(shown()).toContain('      - TZ=Asia/Tokyo\n');
  });

  it('keeps the default zone, with its comment, when the browser has none', () => {
    render(<DockerSnippet timezone={null} />);
    expect(shown()).toBe(composeSnippet());
  });

  it('copies the snippet, and says so when the sandbox refuses the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<DockerSnippet timezone="Europe/Berlin" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Copied\./)).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(composeSnippet({ timezone: 'Europe/Berlin' }));
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Couldn.t copy here/)).toBeTruthy());
  });
});
