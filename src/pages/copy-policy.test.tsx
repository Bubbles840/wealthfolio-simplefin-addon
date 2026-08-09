import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { SyncPage } from './SyncPage';
// The same props the behaviour tests use, so this proves the policy against the
// page as it actually renders rather than against a fixture tuned to pass.
import { makeProps } from './test-props';
import { SetupPage } from './SetupPage';
import { BASELINE_FIX_MIN_DRIFT_AGE_MS } from '../../shared/sync-core';

vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
  };
});

/**
 * Unicode's own definition of "is this a pictograph", rather than a hand-rolled
 * set of block ranges. The property test is both wider and tighter than the
 * ranges it replaces, and it had to be:
 *
 *   • WIDER — the ranges missed `⏳` (U+23F3, Miscellaneous Technical), which
 *     sits below a `\u{1F300}` floor. That is the very first glyph this pass was
 *     asked to remove, and it went unpoliced: injecting `⏳` at the same DOM
 *     position where `⚠` correctly failed used to PASS.
 *   • TIGHTER — the Dingbats range dragged in `✕` (U+2715) and `✓` (U+2713),
 *     which are typographic marks, not emoji. `\p{Extended_Pictographic}`
 *     excludes them, along with `▼` (U+25BC) and `→` (U+2192), so there is no
 *     longer a legitimate glyph that this rule has to look away from.
 *
 * A property test rather than a list, still, because the point is to catch the
 * NEXT emoji somebody pastes into a title — not the eight we happened to remove.
 */
const EMOJI = /\p{Extended_Pictographic}/u;

const TABS: Array<[string, RegExp]> = [
  ['overview', /overview/i],
  ['notifications', /notifications/i],
  ['advanced', /advanced/i],
];

/**
 * One string per tab that can only be on screen AFTER that tab's own store reads
 * have resolved.
 *
 * Without these the loop judged a half-mounted panel: a tab mounts, fires its
 * `useEffect` loads, and renders its defaults in the same tick — so every
 * summary computed from stored settings went unchecked. `advanced` is the
 * clearest case: `AmazonCard` shows "Loading…" until its two reads land.
 */
const LOADED_UNCONFIGURED: Record<string, RegExp> = {
  overview: /balances as of/i,
  // Nothing on this tab changes at load when no Telegram config is stored — the
  // loaded draft equals the empty one — so there is no anchor to await here.
  // `flushLoads` covers it instead, and the configured case below awaits a real
  // post-load string.
  notifications: /^$/,
  advanced: /Amazon charges stay uncategorized/,
};

const LOADED_CONFIGURED: Record<string, RegExp> = {
  overview: /balances as of/i,
  // "Connected" is the connection card's summary once a stored token and chat id
  // have landed; before the read resolves it reads "Not connected".
  notifications: /^Connected$/,
  advanced: /Amazon charges stay uncategorized/,
};

/** Let a freshly-mounted tab's `useEffect` reads settle. Used where the fixture
 *  produces no observable post-load change, so awaiting a string is impossible
 *  but the reads still have to have RUN before their copy is judged. */
async function flushLoads() {
  await act(async () => { await Promise.resolve(); });
}

/**
 * A configured install carrying a FRESH drift episode.
 *
 * Two things the default props cannot reach:
 *
 *   • the feed-lag banner (`.sfin-banner-wait`) — the banner `⏳` lived in. It
 *     renders only while `driftSince` is younger than
 *     `BASELINE_FIX_MIN_DRIFT_AGE_MS`, and `makeProps` supplies no `driftSince`
 *     at all, so `waitingOnFeed` was permanently false and that whole banner —
 *     both of its differently-worded halves — was never rendered by this test.
 *   • the copy a configured install shows, since most card summaries are
 *     computed from stored settings.
 *
 * Glyph mode stays `clean`: in `glyphs` mode the category rows render the
 * `GlyphPicker` palette, which is user-selectable CONTENT and would trip the
 * emoji rule for the right reason. See the scope note on the describe block.
 */
function configuredWithFreshDrift() {
  const props = makeProps();
  // Two days old: comfortably inside the 10-day window, and not so close to
  // `Date.now()` that clock granularity could matter.
  const driftSince = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  expect(Date.now() - Date.parse(driftSince)).toBeLessThan(BASELINE_FIX_MIN_DRIFT_AGE_MS);

  props.store.getAccountBalances = vi.fn(async () => ({
    // POSITIVE drift — "the bank is ahead of its own transaction feed".
    'sfin-1': {
      balance: 1234.56, currency: 'USD', date: 1700000000, drift: 42.5, driftSince,
    },
    // NEGATIVE — the opposite branch, which says feed lag cannot explain it.
    // Different copy, so both halves of the banner get policed.
    'sfin-2': {
      balance: -420.1, currency: 'USD', date: 1700000000, drift: -15.22, driftSince,
    },
  })) as any;

  props.store.getTelegramConfig = vi.fn(async () => ({
    botToken: 'tok',
    chatId: '42',
    enabled: true,
    notifyOnImport: true,
    dailyReportEnabled: true,
    weeklyReportEnabled: true,
    monthlyReportEnabled: true,
    dailyReportCategories: 'all',
    weeklyReportCategories: 'all',
    monthlyReportCategories: 'all',
    largeTransactionThreshold: 500,
    driftAlertThreshold: 100,
    weeklyTopSpendCount: 5,
  })) as any;

  // Amazon deliberately left unconfigured: its "Not set up — …" summary is the
  // post-load anchor for the Advanced tab in BOTH fixtures.
  return props;
}

/**
 * The words, as policy: plain language with no leftover "(optional)", and no
 * emoji in the addon's own chrome.
 *
 * Rendered rather than grepped, because the strings that matter are the ones a
 * user can reach. Every tab is visited: `SyncPage` unmounts the inactive panels,
 * so a single render only ever proves one third of the copy.
 *
 * SCOPE — headings, buttons, labels, summaries, status lines, banners and
 * callouts, not all body text. Two things in this app are legitimately emoji and
 * are CONTENT, not chrome:
 *
 *   • the report glyph palette (`GlyphPicker`) — a curated set the user PICKS
 *     FROM, and rendered as `<button>`s, so a whole-body rule and a
 *     buttons-included rule would both flag it;
 *   • the Telegram message bodies the addon composes (`shared/telegram.ts`),
 *     which are chat messages.
 *
 * Neither is reachable from these renders (glyph mode is `clean`), so a
 * body-text assertion would pass today — and would then have to be gutted the
 * first time the palette opened by default. Naming the scope states the actual
 * rule instead of a stricter-looking one that cannot survive.
 *
 * `(optional)` has no legitimate form anywhere, so that half is checked against
 * the whole panel.
 */
/**
 * Minimal props to mount `SetupPage`, borrowed from `SetupPage.test.tsx`'s
 * shape — nothing here is exercised by a bare render; the wizard's first
 * render (step 1) calls none of these, they just need to exist to satisfy
 * the component's props.
 */
const makeSetupProps = () => ({
  ctx: {
    api: {
      secrets: { get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn() },
      accounts: { getAll: vi.fn(async () => []) },
    },
  } as any,
  store: {
    getAccessUrl: vi.fn(async () => null),
    setAccessUrl: vi.fn(async () => {}),
    setAuthB64: vi.fn(async () => {}),
    getAuthB64Key: vi.fn(async () => 'simplefin_auth_b64'),
    setAccountNames: vi.fn(async () => {}),
    getAccountNames: vi.fn(async () => ({})),
    getAccountMapping: vi.fn(async () => null),
    setAccountMapping: vi.fn(async () => {}),
    getMappingRules: vi.fn(async () => []),
    setMappingRules: vi.fn(async () => {}),
    getSyncScheduleHours: vi.fn(async () => null),
    setSyncScheduleHours: vi.fn(async () => {}),
  } as any,
  onComplete: vi.fn(),
});

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

  const assertClean = (id: string) => {
    expect(document.body.textContent ?? '').not.toMatch(/\(optional\)/i);
    for (const text of chromeText()) {
      expect(text, `chrome emoji on the ${id} tab: ${JSON.stringify(text)}`)
        .not.toMatch(EMOJI);
    }
  };

  /** Visit every tab, wait for its data, and apply the policy. */
  const walkTabs = async (
    loaded: Record<string, RegExp>,
    openEverything: boolean,
  ) => {
    for (const [id, name] of TABS) {
      fireEvent.click(screen.getByRole('tab', { name }));
      // The panel really is the one we asked for — otherwise a broken tab bar
      // would let this loop assert the same tab three times.
      expect(document.querySelector(`#sfin-panel-${id}`)).toBeTruthy();

      const anchor = loaded[id];
      if (anchor.source === '^$') await flushLoads();
      else await screen.findByText(anchor);

      if (openEverything) {
        const panel = document.querySelector(`#sfin-panel-${id}`) as HTMLElement;
        // Repeatedly, because opening a card reveals nested disclosures (the
        // Telegram and Amazon setup guides) that were not in the DOM before.
        for (let pass = 0; pass < 3; pass++) {
          panel.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
            fireEvent.click(el);
          });
          // Newly-revealed content can load too, and an assertion in the same
          // tick as the click would judge the pre-load render.
          await flushLoads();
        }
      }

      assertClean(id);
    }
  };

  it('renders no "(optional)" and no chrome emoji on any tab', async () => {
    render(<SyncPage {...makeProps()} />);
    await screen.findByText(/Imported last run/i);
    // This fixture's drift carries no `driftSince`, so it is the OFF-BALANCE
    // banner (the one that held ⚠) which renders here.
    expect(document.querySelector('.sfin-banner-warn')).toBeTruthy();

    await walkTabs(LOADED_UNCONFIGURED, false);
  });

  it('checks the feed-lag banner and the copy a configured install shows', async () => {
    render(<SyncPage {...configuredWithFreshDrift()} />);
    await screen.findByText(/Imported last run/i);

    // The banner ⏳ lived in, which no other case in this file can reach. Asserted
    // rather than assumed: if a future change to `waitingOnFeed` stopped it
    // rendering, the policy below would silently stop covering it.
    const waitBanners = document.querySelectorAll('.sfin-banner-wait');
    expect(waitBanners).toHaveLength(2);
    // Both halves, which are worded differently.
    const allWaitText = Array.from(waitBanners).map((b) => b.textContent ?? '').join(' ');
    expect(allWaitText).toMatch(/ahead of its own\s+transaction feed/);
    expect(allWaitText).toMatch(/Feed lag cannot cause this direction/);

    await walkTabs(LOADED_CONFIGURED, false);
  });

  it('checks copy that only appears once a card is open', async () => {
    // The default render leaves every collapsible card collapsed, which is most
    // of the settings copy — including the two guides that carried 📦, 🔒 and
    // 📱. Open them all and re-apply the policy. Driven off the configured
    // fixture so the summaries being opened are the loaded ones.
    render(<SyncPage {...configuredWithFreshDrift()} />);
    await screen.findByText(/Imported last run/i);

    await walkTabs(LOADED_CONFIGURED, true);
  });

  /**
   * SetupPage renders ONLY while setup is incomplete, so none of the SyncPage
   * cases above — which all mount `SyncPage`, the post-setup screen — can ever
   * reach it. Without this case the first-run wizard, the very first screen a
   * new user sees, would be the one unpoliced surface in the addon.
   *
   * `assertClean` and `EMOJI` are reused as-is: both operate on whatever is in
   * the DOM and know nothing about tabs, so no fork of the SyncPage machinery
   * (`walkTabs`, load anchors, disclosure-opening) is needed here — a plain
   * render is enough to reach step 1's heading, intro line, and button.
   */
  it('renders no "(optional)" and no chrome emoji on the setup wizard', () => {
    render(<SetupPage {...makeSetupProps()} />);
    assertClean('setup');
  });
});
