# Three-Tab Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the addon's five tabs with Home, Reports and Settings, without losing anything that exists today.

**Architecture:** Two renames carry most of the change:

- **`OverviewTab` → `HomeTab`.** It keeps its banners, checklist and stat strip. The page renders `BudgetTab` under it in the same panel.
- **`AdvancedTab` → `SettingsTab`.** It gains plain group headings, hosts `NotificationsTab`'s three cards and `PoolCard`, and its Accounts card merges in Overview's balance list.

The account list is extracted into one presentational component used by Settings. A pure `resolveStoredTab` migrates stored tab ids.

**Tech Stack:** React 18 + TypeScript, Vitest + Testing Library (jsdom), the addon's single stylesheet in `src/components/ui.tsx`.

**Spec:** `docs/superpowers/specs/2026-10-09-three-tab-navigation-design.md`

## Global Constraints

- **Tab ids:** exactly `'home' | 'reports' | 'settings'`.
- **Stored-tab migration:**
  - `budget` and `overview` → `home`
  - `notifications` and `advanced` → `settings`
  - `reports` → `reports`
  - anything else → `home`
- **Card ids** keep their stored values: `accounts`, `auto-sync`, `docker`, `amazon`, `amazon-guide`, `rules`, `telegram`, `telegram-reports`, `telegram-content`, `telegram-guide`, `report-categories`, `uncategorized-list`. New: `pool`.
- **Stylesheet:** the duplicate-selector guard (`src/components/theme-styles.test.ts`) must keep passing. Each column-0 `.sfin-x {` block appears once.
- **Sizing:** new CSS uses the existing tokens (`--sfin-sz-*`, `--sfin-rad*`, `--sfin-line`, `--sfin-lift`) and no literal px font sizes.
- **Store methods** added after 1.0 stay optional-called (`store.getX?.()`), as everywhere in `SyncPage`.
- **No commits** unless Nick asks; the repo holds uncommitted 1.57 work. Each task ends with a checkpoint instead.
- **Test commands:** `npx vitest run <path>` from the repo root (addon suite). `npx tsc --noEmit -p .` for types.

## Review Focus

1. **A user with no SimpleFin balances yet** (fresh setup, no sync): Home must render the strip without an Accounts "off by" clause, and the Settings Accounts card must say "No accounts mapped yet." rather than an empty list. *Test in Tasks 1 and 3.*
2. **A stored `ui_state.activeTab` of `"overview"` from 1.56**: the first load after upgrading must land on Home, not a blank panel. *Test in Task 3.*
3. **The unmapped-accounts banner's "Map it" button**: it must land on Settings with the Accounts card open AND the mapping editor reachable (an "Edit mapping" button visible), because that is the whole point of the banner. *Test in Task 4.*
4. **Unsaved Telegram edits survive switching between Home and Settings**: the draft is page-owned and must survive the Notifications cards moving into Settings. *Test in Task 2.*
5. **The pool tile with no pool set**: absent, not "$0". An ended pool still shows "left when the pool ended". *Test in Task 3.*

---

## File map

| File | Change |
|---|---|
| `src/components/AccountList.tsx` | **Create.** The balance list lifted out of `OverviewTab` (rows, chips, open-in-Wealthfolio), plus `accountsSummary()` |
| `src/components/AccountList.test.tsx` | **Create** |
| `src/components/Tabs.tsx` | `TabId` becomes three ids; add `resolveStoredTab()` |
| `src/components/Tabs.test.tsx` | Migration table tests |
| `src/components/ui.tsx` | `CollapsibleCard` root gets `data-card-id`; CSS for `.sfin-settings-group` |
| `src/tabs/AdvancedTab.tsx` → `src/tabs/SettingsTab.tsx` | Rename (`git mv`). Group headings, AccountList inside Accounts, NotificationsTab, PoolCard card |
| `src/tabs/AdvancedTab.test.tsx` → `src/tabs/SettingsTab.test.tsx` | Rename, update |
| `src/tabs/OverviewTab.tsx` → `src/tabs/HomeTab.tsx` | Rename. Drop PoolCard and the account list; new Accounts tile; clickable pool tile |
| `src/tabs/OverviewTab.test.tsx` → `src/tabs/HomeTab.test.tsx` | Rename, update |
| `src/tabs/BudgetTab.tsx` | Optional `openRequest` prop to open a card full-screen from outside |
| `src/components/SetupChecklist.tsx` | Rows carry a card id; `onNavigate(tab, cardId)` |
| `src/pages/SyncPage.tsx` | Three tabs, migration on hydrate, Home panel = HomeTab + BudgetTab, Settings panel, navigate scrolls the card into view |
| `src/utils/secrets.ts` | `UiState.activeTab` type widened to old ∪ new ids |
| `src/pages/SyncPage.test.tsx`, `src/pages/copy-policy.test.tsx`, `src/components/SetupChecklist.test.tsx`, `src/tabs/NotificationsTab.test.tsx` | Fixture and query updates |
| `CHANGELOG.md`, `README.md` | Describe the new layout |

---

### Task 1: Extract the account list

**Files:**
- Create: `src/components/AccountList.tsx`
- Create: `src/components/AccountList.test.tsx`
- Modify: `src/tabs/OverviewTab.tsx` (the `<div className="sfin-accts">…</div>` block and the `money`, `initials`, `formatAsOf` helpers it uses)

**Interfaces:**
- Produces:
  - `export function AccountList(props: AccountListProps): JSX.Element`
  - `export function accountsSummary(mapping: AccountMapping, balances: Record<string, AccountBalanceInfo>): string`
  - `AccountListProps = { mapping: AccountMapping; balances: Record<string, AccountBalanceInfo>; sfinNames: Record<string, string>; wfNames: Record<string, string>; onOpenAccount: (wfAccountId: string) => void; framed?: boolean }`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/AccountList.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AccountList, accountsSummary } from './AccountList';

const mapping = { s1: 'wf-a', s2: 'wf-b' };
const balances = {
  s1: { balance: 1842.17, currency: 'USD', date: 1760000000, drift: null, measured: true },
  s2: { balance: -94.93, currency: 'USD', date: 1760000000, drift: 36.1 },
} as any;
const sfinNames = { s1: 'Capital One Spend', s2: 'Citi Double Cash' };
const wfNames = { 'wf-a': 'Spend', 'wf-b': 'Citi' };

describe('AccountList', () => {
  it('lists each mapped account with its balance and state', () => {
    render(<AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={() => {}} />);
    expect(screen.getByText('Capital One Spend')).toBeInTheDocument();
    expect(screen.getByText('$1,842.17')).toBeInTheDocument();
    expect(screen.getByText(/in sync/)).toBeInTheDocument();
    expect(screen.getByText(/off by \$36\.10/)).toBeInTheDocument();
  });

  it('opens the Wealthfolio account when a row is clicked', () => {
    const onOpenAccount = vi.fn();
    render(<AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={onOpenAccount} />);
    fireEvent.click(screen.getByText('Citi Double Cash'));
    expect(onOpenAccount).toHaveBeenCalledWith('wf-b');
  });

  it('says so when nothing is mapped yet, instead of an empty frame', () => {
    render(<AccountList mapping={{}} balances={{}} sfinNames={{}} wfNames={{}} onOpenAccount={() => {}} />);
    expect(screen.getByText('No accounts mapped yet.')).toBeInTheDocument();
  });
});

describe('accountsSummary', () => {
  it('names the count, and the difference only when there is one', () => {
    expect(accountsSummary(mapping, balances)).toBe('2 accounts · 1 off by $36.10');
    expect(accountsSummary({ s1: 'wf-a' }, balances)).toBe('1 account');
    expect(accountsSummary({}, {})).toBe('No accounts mapped');
  });

  it('counts several differing accounts without naming an amount', () => {
    const both = { ...balances, s1: { ...balances.s1, drift: 5 } };
    expect(accountsSummary(mapping, both)).toBe('2 accounts · 2 off');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/AccountList.test.tsx`
Expected: FAIL, "Failed to resolve import ./AccountList".

- [ ] **Step 3: Create the component** by moving the `sfin-accts` block out of `OverviewTab.tsx` verbatim (rows, the three-state chip with its comments, the keyboard handler). Then make three changes:
  1. The click calls `onOpenAccount(wfId)` instead of `ctx.api.navigation.navigate`.
  2. It renders the empty state when `mapping` is empty.
  3. `framed` (default `true`) controls whether the outer `sfin-accts` frame and its "Accounts" head are drawn. Settings renders it unframed inside its card.

```tsx
// src/components/AccountList.tsx
import React from 'react';
import { SectionLabel, CheckIcon, AlertIcon } from './ui';
import type { AccountBalanceInfo } from '../utils/secrets';
import type { AccountMapping } from '../../shared/types';

// money / initials / formatAsOf: MOVED here from OverviewTab.tsx unchanged
// (OverviewTab no longer uses them after this task).

export interface AccountListProps {
  mapping: AccountMapping;
  balances: Record<string, AccountBalanceInfo>;
  sfinNames: Record<string, string>;
  wfNames: Record<string, string>;
  onOpenAccount: (wfAccountId: string) => void;
  /** The list's own frame and "Accounts" head. Off inside a card that
   *  already has a title. */
  framed?: boolean;
}

/** "2 accounts · 1 off by $36.10" — the collapsed Accounts card's summary and
 *  the Home tile's subline, so the two can never disagree. */
export function accountsSummary(mapping: AccountMapping, balances: Record<string, AccountBalanceInfo>): string {
  const ids = Object.keys(mapping).filter((id) => !!mapping[id]);
  if (ids.length === 0) return 'No accounts mapped';
  const head = `${ids.length} account${ids.length === 1 ? '' : 's'}`;
  const off = ids.filter((id) => balances[id]?.drift != null);
  if (off.length === 0) return head;
  if (off.length === 1) {
    const b = balances[off[0]]!;
    return `${head} · 1 off by ${money(Math.abs(b.drift as number), b.currency)}`;
  }
  return `${head} · ${off.length} off`;
}

export function AccountList({ mapping, balances, sfinNames, wfNames, onOpenAccount, framed = true }: AccountListProps) {
  const entries = Object.entries(mapping).filter(([, wfId]) => !!wfId);
  const asOf = entries
    .map(([sfinId]) => balances[sfinId]?.date)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => b - a)[0];
  const rows = entries.length === 0
    ? <div className="sfin-subtle">No accounts mapped yet.</div>
    : entries.map(([sfinId, wfId]) => {
        /* the row JSX moved from OverviewTab, with
           `const open = () => { if (exists) onOpenAccount(wfId); };` */
      });
  if (!framed) {
    return (
      <div className="sfin-accts--bare">
        {asOf && <div className="sfin-subtle sfin-accts-asof">balances as of {formatAsOf(asOf)}</div>}
        {rows}
      </div>
    );
  }
  return (
    <div className="sfin-accts">
      <div className="sfin-card-head">
        <SectionLabel>Accounts</SectionLabel>
        {asOf && <span className="sfin-subtle sfin-accts-asof">balances as of {formatAsOf(asOf)}</span>}
      </div>
      {rows}
    </div>
  );
}
```

  Add one CSS rule in `src/components/ui.tsx`, after `.sfin-accts-asof`. Inside a card, rows keep their dividers, and the first row's top border is dropped under the as-of line:

```css
.sfin-accts--bare > .sfin-accts-asof { margin-bottom: 4px; }
```

  In `OverviewTab.tsx`, replace the moved block with:

```tsx
<AccountList
  mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames}
  onOpenAccount={(wfId) => { ctx.api.navigation.navigate(`/accounts/${wfId}`).catch(() => {}); }}
/>
```

- [ ] **Step 4: Run the new tests and the Overview tests**

Run: `npx vitest run src/components/AccountList.test.tsx src/tabs/OverviewTab.test.tsx src/components/theme-styles.test.ts`
Expected: PASS. Overview still renders the same rows through the extracted component.

- [ ] **Step 5: Checkpoint.** `npx tsc --noEmit -p .` passes.

---

### Task 2: Settings tab (from Advanced), with Notifications and the pool inside

**Files:**
- Rename: `git mv src/tabs/AdvancedTab.tsx src/tabs/SettingsTab.tsx` and `git mv src/tabs/AdvancedTab.test.tsx src/tabs/SettingsTab.test.tsx`
- Modify: `src/tabs/SettingsTab.tsx`, `src/components/ui.tsx`, `src/pages/SyncPage.tsx`, `src/tabs/OverviewTab.tsx` (import path of `CARD`)
- Test: `src/tabs/SettingsTab.test.tsx`, `src/tabs/NotificationsTab.test.tsx`

**Interfaces:**
- Consumes: `AccountList`, `accountsSummary` (Task 1); `NotificationsTab` (unchanged props); `PoolCard` (unchanged).
- Produces:
  - `export const CARD` gains `pool: 'pool'`.
  - `export function SettingsTab(props)` with the old `AdvancedTab` props plus `balances`, `sfinNames`, `wfNames`, `telegramDraft: TelegramDraftState`, `poolSummary: string`.
  - `CollapsibleCard`'s root div gets `data-card-id={id}`.

- [ ] **Step 1: Write the failing tests** in `src/tabs/SettingsTab.test.tsx`. Keep the existing tests, renaming `AdvancedTab` → `SettingsTab` in imports and render calls. Then add:

```tsx
it('groups the cards under plain headings, in the order of the spec', async () => {
  render(<SyncPage {...settingsProps()} />);
  const headings = await screen.findAllByRole('heading', { level: 3 });
  expect(headings.map((h) => h.textContent)).toEqual(
    ['Accounts', 'Budget', 'Notifications', 'Sync', 'Categorizing', 'Reset'],
  );
});

it('shows the balances when Accounts opens, and fetches SimpleFin only for Edit mapping', async () => {
  const props = settingsProps();
  render(<SyncPage {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Accounts/ }));
  expect(await screen.findByText('Capital One Spend')).toBeInTheDocument();
  expect(fetchAccounts).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit mapping' }));
  await waitFor(() => expect(fetchAccounts).toHaveBeenCalledOnce());
});

it('summarises Accounts with the count and any difference', async () => {
  render(<SyncPage {...settingsProps()} />);
  expect(await screen.findByText('2 accounts · 1 off by $36.10')).toBeInTheDocument();
});

it('keeps an unsaved Telegram edit across a trip to another tab', async () => {
  const props = settingsProps();
  render(<SyncPage {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Telegram/ }));
  fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: 'typed-token' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Reports' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
  expect(screen.getByLabelText(/bot token/i)).toHaveValue('typed-token');
});
```

  `settingsProps()` is `makeProps()` from `src/pages/test-props.ts` with:
  - `getUiState` → `{ activeTab: 'settings' }`;
  - two mapped accounts named "Capital One Spend" and "Citi Double Cash", the Citi one with `drift: 36.1`.

  `fetchAccounts` is `vi.mock('../utils/simplefin', …)` as the existing Advanced tests already do. Copy that mock block if the file has it, else add `vi.mock('../utils/simplefin', async (orig) => ({ ...(await orig<any>()), fetchAccounts: vi.fn(async () => ({ accounts: [], errors: [] })) }))`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tabs/SettingsTab.test.tsx`
Expected: FAIL. No Settings tab or headings yet, and `SettingsTab` is not exported.

- [ ] **Step 3: Implement.**
  1. **`ui.tsx`:**
     - `CollapsibleCard` becomes `<div className="sfin-card sfin-card--collapsible" data-card-id={props.id}>`.
     - Add the group heading style after `.sfin-advanced-callout`:
       ```css
       .sfin-settings-group { font-size: var(--sfin-sz-sm); font-weight: 600; color: var(--muted-foreground); margin: 22px 0 8px; }
       .sfin-settings-group:first-child { margin-top: 4px; }
       ```
  2. **`SettingsTab.tsx`:**
     - Rename the component to `SettingsTab` and add `pool: 'pool'` to `CARD`.
     - Add the new props: `balances`, `sfinNames`, `wfNames`, `telegramDraft`, `poolSummary`.
     - Render the cards in this order:
       ```tsx
       <h3 className="sfin-settings-group">Accounts</h3>
       {/* Accounts CollapsibleCard */}
       <h3 className="sfin-settings-group">Budget</h3>
       <CollapsibleCard id={CARD.pool} title="Semester pool" summary={poolSummary}
         open={isOpen(CARD.pool)} onToggle={() => toggleCard(CARD.pool)}>
         <PoolCard store={store} bare />
       </CollapsibleCard>
       <h3 className="sfin-settings-group">Notifications</h3>
       <NotificationsTab ctx={ctx} draft={telegramDraft} categories={categories} isOpen={isOpen} toggleCard={toggleCard} />
       <h3 className="sfin-settings-group">Sync</h3>
       {/* Auto-sync card, Background sync (Docker) card */}
       <h3 className="sfin-settings-group">Categorizing</h3>
       {/* AmazonCard, Transaction rules card, the Spending Tracker callout */}
       <h3 className="sfin-settings-group">Reset</h3>
       {/* the danger card */}
       ```
     - **Accounts card:**
       - `summary={accountsSummary(mapping, balances)}`.
       - `onToggle` only toggles; delete the `if (opening …) void loadAccounts()` line.
       - The body starts with `<AccountList framed={false} mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={(id) => { ctx.api.navigation.navigate(\`/accounts/${id}\`).catch(() => {}); }} />` and a `sfin-divider`, then the existing mapping section.
       - In that section, the `sfAccounts === null` branch's button text "Load accounts" becomes "Edit mapping".
  3. **`PoolCard`** gains `bare?: boolean`. When true it renders its contents without the outer `sfin-card` div and without the "Semester pool" `SectionLabel`, because the collapsible card supplies both.
  4. **`SyncPage.tsx`:**
     - Import `SettingsTab` and `CARD` from `'../tabs/SettingsTab'`.
     - `TABS` becomes budget, reports, overview, settings. Notifications and advanced are deleted; Home arrives in Task 3.
     - Replace the notifications and advanced `TabPanel`s with one `settings` panel rendering `<SettingsTab … balances={balances} sfinNames={sfinNames} wfNames={wfNames} telegramDraft={telegramDraft} poolSummary={poolSummary(poolStatus)} />`.
     - Add next to `isKnownTab`:
       ```ts
       function poolSummary(s: Awaited<ReturnType<SecretsStore['getPoolStatus']>>): string {
         if (!s || s.phase === 'gone') return 'Not set';
         const usd = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(c / 100);
         return `${usd(s.spentCents + s.remainingCents)} until ${s.endDate}`;
       }
       ```
     - `TabId` in `Tabs.tsx` temporarily becomes `'budget' | 'reports' | 'overview' | 'settings'`.
  5. **`OverviewTab.tsx`:** its `CARD as ADVANCED_CARD` import becomes `import { CARD as SETTINGS_CARD } from './SettingsTab'` (update every `ADVANCED_CARD.` use to `SETTINGS_CARD.`), and the banner CTA's `onNavigate('advanced', …)` becomes `onNavigate('settings', …)`.
  6. **`SetupChecklist.tsx`:** the `tab` values `'advanced'` / `'notifications'` become `'settings'` (card ids follow in Task 5).
  7. **`NotificationsTab.test.tsx`:** where tests navigate by clicking the "Notifications" tab, click "Settings" instead. Fixtures with `activeTab: 'notifications'` become `'settings'`.

- [ ] **Step 4: Run the affected suites**

Run: `npx vitest run src/tabs src/components src/pages`
Expected: PASS. Fix any remaining `'advanced'` / `'notifications'` tab references the run reports; the type error from `tsc` lists them all.

- [ ] **Step 5: Checkpoint.** `npx tsc --noEmit -p .` passes.

---

### Task 3: Home tab, three tabs, stored-tab migration

**Files:**
- Rename: `git mv src/tabs/OverviewTab.tsx src/tabs/HomeTab.tsx`, `git mv src/tabs/OverviewTab.test.tsx src/tabs/HomeTab.test.tsx`
- Modify: `src/components/Tabs.tsx`, `src/components/Tabs.test.tsx`, `src/utils/secrets.ts`, `src/pages/SyncPage.tsx`, `src/tabs/BudgetTab.tsx`, `src/pages/SyncPage.test.tsx`, `src/pages/copy-policy.test.tsx`

**Interfaces:**
- Consumes: `AccountList`, `accountsSummary` (Task 1); `SettingsTab` + `CARD` (Task 2).
- Produces:
  - `export type TabId = 'home' | 'reports' | 'settings'`.
  - `export function resolveStoredTab(raw: unknown): TabId`.
  - `HomeTab` props: Overview's props minus `imported`, plus `onOpenPool: () => void`.
  - `BudgetTab` gains `openRequest?: { id: string; seq: number }`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/Tabs.test.tsx — add
import { resolveStoredTab } from './Tabs';

describe('resolveStoredTab', () => {
  it.each([
    ['budget', 'home'], ['overview', 'home'], ['home', 'home'],
    ['notifications', 'settings'], ['advanced', 'settings'], ['settings', 'settings'],
    ['reports', 'reports'],
    [undefined, 'home'], [null, 'home'], ['garbage', 'home'], [42, 'home'],
  ])('maps a stored %s to %s', (stored, expected) => {
    expect(resolveStoredTab(stored)).toBe(expected);
  });
});
```

```tsx
// src/tabs/HomeTab.test.tsx — add
it('lands a 1.56 user whose last tab was Overview on Home', async () => {
  const props = makeProps();
  props.store.getUiState = vi.fn(async () => ({ activeTab: 'overview' }));
  render(<SyncPage {...props} />);
  expect(await screen.findByRole('tab', { name: 'Home', selected: true })).toBeInTheDocument();
  expect(screen.getByText('Needs a category')).toBeInTheDocument();
});

it('shows Accounts as a count with any difference, and opens Settings → Accounts', async () => {
  const props = makeProps(); // sfin-2 carries drift 15.22 in the shared fixture
  render(<SyncPage {...props} />);
  const tile = await screen.findByRole('button', { name: /accounts/i });
  expect(tile).toHaveTextContent('2');
  expect(tile).toHaveTextContent('1 off by $15.22');
  fireEvent.click(tile);
  expect(await screen.findByRole('tab', { name: 'Settings', selected: true })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Accounts/, expanded: true })).toBeInTheDocument();
});

it('leaves out the pool tile when no pool is set, and keeps the ended wording', async () => {
  const none = makeProps();
  render(<SyncPage {...none} />);
  await screen.findByText('Needs a category');
  expect(screen.queryByText('Semester pool')).toBeNull();
  cleanup();

  const ended = makeProps();
  ended.store.getPoolStatus = vi.fn(async () => ({
    phase: 'ended', startDate: '2026-08-25', endDate: '2026-12-12',
    spentCents: 1_500_000, remainingCents: 100_000, daysElapsed: 110, daysLeft: 0,
    sustainableWeeklyCents: 0, actualWeeklyCents: 0, projectedRunOutDate: null, runsOutBeforeEnd: false,
  }));
  render(<SyncPage {...ended} />);
  expect(await screen.findByText('left when the pool ended')).toBeInTheDocument();
});

it('says all is as expected on the Accounts tile when no balance differs', async () => {
  const props = makeProps();
  props.store.getAccountBalances = vi.fn(async () => ({
    'sfin-1': { balance: 1234.56, currency: 'USD', date: 1700000000, drift: null },
    'sfin-2': { balance: -420.1, currency: 'USD', date: 1700000000, drift: null },
  }));
  render(<SyncPage {...props} />);
  const tile = await screen.findByRole('button', { name: /accounts/i });
  expect(tile).toHaveTextContent('all as expected');
  expect(tile).not.toHaveTextContent('off by');
});

it('drops the Imported last run tile — the header already says it', async () => {
  render(<SyncPage {...makeProps()} />);
  await screen.findByText('Needs a category');
  expect(screen.queryByText('Imported last run')).toBeNull();
});

it('renders the budget under the strip, on the same tab', async () => {
  render(<SyncPage {...makeProps()} />);
  await screen.findByText('Needs a category');
  expect(screen.getByRole('tabpanel')).toHaveTextContent(/Customize|companion/i);
});
```

  In `makeProps` for HomeTab tests, `getUncategorizedStatus` must return a status so the strip has "Needs a category". The existing Overview tests already do this, so reuse their fixture.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/Tabs.test.tsx src/tabs/HomeTab.test.tsx`
Expected: FAIL. `resolveStoredTab` is not exported, and there is no Home tab.

- [ ] **Step 3: Implement.**
  1. **`Tabs.tsx`:**
     ```ts
     export type TabId = 'home' | 'reports' | 'settings';

     /** A stored `ui_state.activeTab` from any version, as one of today's tabs.
      *  1.56 and earlier had five; an unknown value lands on Home, never on a
      *  blank page. */
     export function resolveStoredTab(raw: unknown): TabId {
       switch (raw) {
         case 'reports': return 'reports';
         case 'settings': case 'notifications': case 'advanced': return 'settings';
         default: return 'home';
       }
     }
     ```
  2. **`secrets.ts`:** `UiState.activeTab?: string` (it is migrated on read, so the type documents storage, not the current set).
  3. **`HomeTab.tsx`** (renamed from Overview; export `HomeTab`, keep `OVERVIEW_CARD` exported as `HOME_CARD` with the same `uncategorized: 'uncategorized-list'` value):
     - Delete the `<PoolCard store={store} />` line and the `<AccountList …/>` from Task 1. Both now live in Settings.
     - Replace the "Accounts synced" and "Imported last run" tiles with one button tile:
       ```tsx
       <button
         type="button"
         className="sfin-tile sfin-tile--toggle"
         aria-label={`Accounts: ${accountsSummary(mapping, balances)}`}
         onClick={() => onNavigate('settings', SETTINGS_CARD.accounts)}
       >
         <SectionLabel>Accounts</SectionLabel>
         <div className="sfin-tile-val">{Object.values(mapping).filter(Boolean).length}</div>
         <div className="sfin-tile-sub">
           {driftAccounts.length === 0 ? 'all as expected'
             : accountsSummary(mapping, balances).split(' · ')[1]}
         </div>
       </button>
       ```
     - The pool tile becomes `<button type="button" className="sfin-tile sfin-tile--toggle" onClick={onOpenPool} …>` with the same inner content. The aria-label is `Semester pool: ${remaining} left`.
     - Remove the `imported` prop. The header shows it.
  4. **`BudgetTab.tsx`:** add the prop and an effect next to `fullId`:
     ```ts
     openRequest?: { id: string; seq: number };
     // …
     useEffect(() => {
       if (openRequest) setFullId(openRequest.id);
     }, [openRequest?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
     ```
  5. **`SyncPage.tsx`:**
     - `TABS = [{ id: 'home', label: 'Home' }, { id: 'reports', label: 'Reports' }, { id: 'settings', label: 'Settings' }]`.
     - Initial state: `useState<TabId>(link ? 'reports' : 'home')`.
     - Hydrate: `if (!hasUserActed.current.tab) setActiveTab(resolveStoredTab(ui.activeTab));` replaces the `isKnownTab` check. Delete `isKnownTab`.
     - Wide page when `activeTab === 'home'`.
     - `refreshDerivedSignals` runs when `activeTab === 'home'`.
     - `reportPruned` calls `navigate('home')`.
     - Add `const [budgetOpen, setBudgetOpen] = useState<{ id: string; seq: number } | undefined>();`.
     - The Home panel renders `<HomeTab … onOpenPool={() => setBudgetOpen((p) => ({ id: 'pool-burndown', seq: (p?.seq ?? 0) + 1 }))} />` and then `<BudgetTab … openRequest={budgetOpen} />`, both inside the one `TabPanel tab="home"`.
     - Delete the budget and overview panels.
  6. **Tests:**
     - `SyncPage.test.tsx`: `findByText('Accounts synced')` becomes `findByText('Needs a category')`, with a status fixture, or `findByRole('tab', { name: 'Home' })`.
     - `copy-policy.test.tsx`: expectations that read "Imported last run" or "balances as of" on Overview now read them where they live. "balances as of" is in Settings → Accounts when opened. The "Imported last run" expectation is deleted.
     - Fixtures with `activeTab: 'overview'` / `'budget'` keep working through the migration. Leave them, except where a test asserts on the stored value written back. There, expect `'home'`.

- [ ] **Step 4: Run the full addon suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Checkpoint.** `npx tsc --noEmit -p .` passes.

---

### Task 4: Links open the right card, and scroll to it

**Files:**
- Modify: `src/components/SetupChecklist.tsx`, `src/components/SetupChecklist.test.tsx`, `src/pages/SyncPage.tsx`, `src/tabs/HomeTab.tsx`
- Test: `src/components/SetupChecklist.test.tsx`, `src/tabs/HomeTab.test.tsx`

**Interfaces:**
- Consumes: `CARD` from `SettingsTab` (Task 2); `navigate(tab, cardId)` in `SyncPage`.
- Produces:
  - `SetupChecklist`'s `onNavigate: (tab: TabId, cardId?: string) => void`.
  - The checklist's `Row` gains `card: string`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/SetupChecklist.test.tsx — add
it('sends each "Set up" to its own Settings card', () => {
  const onNavigate = vi.fn();
  render(<SetupChecklist companionVersion={null} telegramConfigured={false} amazonConfigured={false}
    dismissed={false} onDismiss={() => {}} onNavigate={onNavigate} />);
  const links = screen.getAllByRole('button', { name: /set up/i });
  links.forEach((l) => fireEvent.click(l));
  expect(onNavigate.mock.calls).toEqual([
    ['settings', 'docker'], ['settings', 'telegram'], ['settings', 'amazon'],
  ]);
});
```

```tsx
// src/tabs/HomeTab.test.tsx — add
it('lands the "map it" banner on Settings → Accounts with the mapper one tap away', async () => {
  const props = makeProps();
  props.store.getUnmappedAccounts = vi.fn(async () => [{ sfinAccountId: 'sfin-9', accountName: 'Robinhood Gold' }]);
  render(<SyncPage {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /map it|map account/i }));
  expect(await screen.findByRole('tab', { name: 'Settings', selected: true })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Accounts/, expanded: true })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit mapping' })).toBeInTheDocument();
});

it('scrolls the opened card into view', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const props = makeProps();
  props.store.getUnmappedAccounts = vi.fn(async () => [{ sfinAccountId: 'sfin-9', accountName: 'Robinhood Gold' }]);
  render(<SyncPage {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /map it|map account/i }));
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
});
```

  The banner button's exact accessible name is whatever `HomeTab`'s unmapped banner renders today. Read it from the source and use it verbatim in both tests.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/SetupChecklist.test.tsx src/tabs/HomeTab.test.tsx`
Expected: FAIL. The checklist calls `onNavigate('settings')` with no card, and nothing scrolls.

- [ ] **Step 3: Implement.**
  1. **`SetupChecklist.tsx`:**
     - Rows get `card: 'docker'`, `'telegram'`, `'amazon'`.
     - The link calls `onNavigate('settings', r.card)`.
     - The prop type becomes `(tab: TabId, cardId?: string) => void`.
     - Keys use `r.card`.
  2. **`SyncPage.tsx` `navigate`:** after `setOpenCards(...)`, scroll the card once the panel has rendered:
     ```ts
     if (openCardId) {
       // After the tab's panel mounts: the card does not exist until then.
       window.setTimeout(() => {
         document.querySelector(`[data-card-id="${openCardId}"]`)
           ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
       }, 0);
     }
     ```
  3. **`HomeTab.tsx`:** the unmapped banner's CTA passes `SETTINGS_CARD.accounts`. It already passes the accounts card id; confirm it uses the `'settings'` tab from Task 2.

- [ ] **Step 4: Run the addon suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Checkpoint.** `npx tsc --noEmit -p .` passes.

---

### Task 5: Look at it, then document it

**Files:**
- Modify: `CHANGELOG.md` (the `[Unreleased]` section), `README.md` (any "Overview", "Advanced" or "Notifications tab" wording)

- [ ] **Step 1: Visual check.**
  1. Capture Home and Settings with the temporary capture test used for the restyle:
     - render `SyncPage` with the sample data;
     - write `document.body.innerHTML` to the scratchpad;
     - delete the test afterwards.
  2. Screenshot both in light and dark with headless Chrome. Wrap the markup with Wealthfolio's theme variables on `html` and the stylesheet from `ui.tsx`, as in the restyle check.
  3. Look for: the strip's three tiles, the budget under it, Settings' six headings in order, the Accounts card summary, the pool card. Fix anything visibly wrong once, then move on.

- [ ] **Step 2: Docs.**
  1. **`CHANGELOG.md` `[Unreleased]` → Changed:**

     > **Three tabs instead of five: Home, Reports and Settings.** Home is what needs you (banners, setup, a status strip) above the budget. Settings is everything else on one page, grouped: Accounts, Budget, Notifications, Sync, Categorizing, Reset.
     >
     > - Your last-opened tab carries over.
     > - "Set up →" and "Map it" now open the right card and scroll to it.
     > - The "Imported last run" tile is gone; the header already says it.

  2. **`README.md`:** replace tab names in the setup and Telegram sections:
     - "Notifications tab" → "Settings → Notifications"
     - "Advanced" → "Settings"
     - "Overview" → "Home"

- [ ] **Step 3: Final verification.**

Run: `npx tsc --noEmit -p . && npx vitest run && (cd companion && npx vitest run) && npm run build`
Expected: all pass, and the build completes.
