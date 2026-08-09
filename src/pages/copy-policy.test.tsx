import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { SyncPage } from './SyncPage';
// The same props the behaviour tests use, so this proves the policy against the
// page as it actually renders rather than against a fixture tuned to pass.
import { makeProps } from './test-props';

vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
  };
});

/**
 * Pictographs and dingbats. Deliberately a range test rather than a list: the
 * point is to catch the NEXT emoji somebody pastes into a title, not the six we
 * happened to remove. It is a superset of Unicode's Emoji property — U+2715 ✕
 * and U+2192 → live in these blocks without being emoji — so anything it flags
 * gets judged as chrome-or-content rather than deleted on sight.
 */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

const TABS: Array<[string, RegExp]> = [
  ['overview', /overview/i],
  ['notifications', /notifications/i],
  ['advanced', /advanced/i],
];

/**
 * The words, as policy: plain language with no leftover "(optional)", and no
 * emoji in the addon's own chrome.
 *
 * Rendered rather than grepped, because the strings that matter are the ones a
 * user can reach. Every tab is visited: `SyncPage` unmounts the inactive panels,
 * so a single render only ever proves one third of the copy.
 *
 * SCOPE — headings, buttons, labels and status lines, not all body text. Two
 * things are legitimately emoji and would make a whole-body assertion either
 * wrong or permanently weakened:
 *
 *   • the report glyph palette (`GlyphPicker`) — a curated set the user PICKS
 *     FROM, i.e. content;
 *   • the Telegram message bodies the addon composes (`shared/telegram.ts`),
 *     which are chat messages, not UI.
 *
 * Neither is reachable from a default render today, so a body-text assertion
 * would pass — and would then have to be gutted the first time a card opened by
 * default. Scoping it to the interactive/structural copy states the actual rule
 * instead. `(optional)` has no legitimate form anywhere, so that half is checked
 * against the whole panel.
 */
describe('copy policy', () => {
  const chromeText = (): string[] => {
    const nodes = document.querySelectorAll(
      'h1, h2, h3, h4, button, label, legend, summary, '
      + '.sfin-title, .sfin-section-label, .sfin-check-name, .sfin-status, '
      + '.sfin-tile-sub, .sfin-chip, .sfin-banner-note, .sfin-callout, '
      + '.sfin-danger-card, [role="status"], '
      // Where a decorative glyph hides: every emoji this pass removed from a
      // banner sat in an `aria-hidden` span, invisible to every other selector
      // here precisely because it was marked as carrying no information.
      + '[aria-hidden]',
    );
    return Array.from(nodes)
      .map((n) => n.textContent ?? '')
      .filter((t) => t.trim() !== '');
  };

  it('renders no "(optional)" and no chrome emoji on any tab', async () => {
    render(<SyncPage {...makeProps()} />);
    await screen.findByText(/Imported last run/i);

    for (const [id, name] of TABS) {
      fireEvent.click(screen.getByRole('tab', { name }));
      // The panel really is the one we asked for — otherwise a broken tab bar
      // would let this loop assert the same tab three times.
      expect(document.querySelector(`#sfin-panel-${id}`)).toBeTruthy();

      expect(document.body.textContent ?? '').not.toMatch(/\(optional\)/i);
      for (const text of chromeText()) {
        expect(text, `chrome emoji on the ${id} tab: ${JSON.stringify(text)}`)
          .not.toMatch(EMOJI);
      }
    }
  });

  it('checks copy that only appears once a card is open', async () => {
    // The default render leaves every collapsible card collapsed, which is most
    // of the settings copy — including the two guides that carried 📦, 🔒 and
    // 📱. Open them all and re-apply the policy.
    render(<SyncPage {...makeProps()} />);
    await screen.findByText(/Imported last run/i);

    for (const [id, name] of TABS) {
      fireEvent.click(screen.getByRole('tab', { name }));
      const panel = document.querySelector(`#sfin-panel-${id}`) as HTMLElement;
      // Repeatedly, because opening a card reveals nested disclosures (the
      // Telegram and Amazon setup guides) that were not in the DOM before.
      for (let pass = 0; pass < 3; pass++) {
        panel.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
          fireEvent.click(el);
        });
      }

      expect(document.body.textContent ?? '').not.toMatch(/\(optional\)/i);
      for (const text of chromeText()) {
        expect(text, `chrome emoji on the ${id} tab: ${JSON.stringify(text)}`)
          .not.toMatch(EMOJI);
      }
    }
  });
});
