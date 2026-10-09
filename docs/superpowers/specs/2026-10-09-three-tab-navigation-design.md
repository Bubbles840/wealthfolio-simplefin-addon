# Three-tab navigation — design

Part 2a of the minimalism pass (2026-10-09). Parts 2b (settings diet) and 2c
(Budget defaults and the customize menu) get their own designs.

## Goal

Five tabs become three. Today the addon has Budget, Reports, Overview,
Notifications and Advanced. Overview's useful parts are status (what needs you,
the accounts) that belongs next to the budget. The rest of Overview, and all of
Notifications and Advanced, is configuration you visit rarely. The new tabs:

- **Home**: what needs you, then the budget.
- **Reports**: unchanged.
- **Settings**: everything configurable, on one page.

Success means a daily visit is one tab, configuration is one scrollable page,
and nothing that exists today is lost or harder than two taps to reach.

## Home

From top to bottom:

1. **Attention banners**, only when one applies. They move unchanged from
   Overview: unmapped accounts, removed duplicates, balance differences. Their
   wording is part of 2b.
2. **Setup checklist**, until it is dismissed. It moves here from Overview,
   which was the third tab. Its "Set up →" links now open the right Settings
   card, not just the tab.
3. **Status strip**: one divided strip, styled like today's Overview tiles.
   - **Needs a category**: the count. Tapping it opens the uncategorized list
     under the strip, exactly as on Overview today.
   - **Accounts**: the count, plus "1 off by $36.10" when an account's balance
     differs from the bank. Tapping it opens Settings → Accounts.
   - **Semester pool**: what's left and the verdict ("lasts past Dec 12" /
     "out by Nov 20"). Tapping it opens the pool's full Budget view, which
     already has the editor. Shown only while a pool is set.
4. **The Budget tab's content, unchanged:** range chips, Customize, and the
   card grid.

**Dropped from Overview:**
- The "Imported last run" tile. The page header already says "4 transactions
  imported".
- The "Accounts synced" tile, which is replaced by the Accounts tile above.

Home keeps the wide page width Budget has today. Reports and Settings stay
narrow.

## Settings

One page. Plain group headings (not collapsible), with today's collapsible cards
under them, each showing its one-line summary when closed:

| Group | Cards (existing ids kept) | From |
|---|---|---|
| Accounts | Accounts (`accounts`) | Overview's balance list **merged with** Advanced's mapping card |
| Budget | Semester pool (new id `pool`) | Overview's pool card |
| Notifications | Telegram (`telegram`), Reports (`telegram-reports`), Report content (`telegram-content`) | Notifications tab |
| Sync | Auto-sync (`auto-sync`), Background sync (`docker`) | Advanced |
| Categorizing | Amazon (`amazon`), Transaction rules (`rules`), then the Spending Tracker note | Advanced |
| Reset | The reset card | Advanced |

**Merged Accounts card:**
- **Summary line:** "4 accounts · 1 off by $36.10".
- **Body:** the account list from Overview (balances, status chips, click to
  open the account), then an "Edit mapping" button. The button opens the
  mapping editor that is in Advanced today; it is fetched on open, as now.

**Semester pool** moves from Overview to Settings. Its 40-word explanation no
longer shows to every visitor of the daily view. When collapsed, the summary
reads "Not set" or "$16,000 until Dec 12".

The Notifications tab's sticky Save bar keeps working. It already only appears
when its cards have unsaved changes.

**Different from the chat sketch:** the sketch had one collapsible row per
group. Notifications is three cards, and nesting collapsibles inside a
collapsible would add a layer, so groups are headings instead.

## Navigation and migration

- `TabId` becomes `'home' | 'reports' | 'settings'`.
- A stored `ui_state.activeTab` is migrated on read:

  | Stored value | Opens |
  |---|---|
  | `budget`, `overview` | `home` |
  | `notifications`, `advanced` | `settings` |
  | anything else | `home` (was Overview) |

- The notification deep link to a report is unchanged.
- `navigate(tab, cardId)` gains callers:

  | Link | Goes to |
  |---|---|
  | Unmapped-accounts banner | `settings` + `accounts` (it went to Advanced) |
  | Checklist "Background sync" | `settings` + `docker` |
  | Checklist "Telegram" | `settings` + `telegram` |
  | Checklist "Amazon" | `settings` + `amazon` |
  | Accounts tile | `settings` + `accounts` |
  | Removed-duplicates redirect | `home` (it went to Overview) |

- Opening a card from a link also scrolls it into view.
- Card open/closed state keeps its stored ids, so cards someone left open stay
  open.

## Components

- `src/tabs/HomeTab.tsx` (new): attention banners, checklist, status strip,
  then `<BudgetTab>`. The banners and the uncategorized list are lifted out of
  `OverviewTab.tsx` into `src/components/AttentionBanners.tsx` and the existing
  `UncategorizedList`.
- `src/tabs/SettingsTab.tsx` (new): the groups above. It composes
  `NotificationsTab`'s three cards and Advanced's cards. The Accounts card body
  is a new `AccountsCard.tsx` combining the list and the mapper.
- `OverviewTab.tsx` and `AdvancedTab.tsx` are removed once their pieces live
  elsewhere. `NotificationsTab.tsx` stays as the component rendering its three
  cards, now inside Settings.
- `SyncPage.tsx`: three tabs, the migration, and `navigate` with scroll-into-view.

## Error handling

- An unrecognised stored tab opens Home. This is the existing hydration guard,
  pointed at the new default.
- An unreadable pool or uncategorized status hides that tile. It never shows a
  zero, the same rule Overview uses today.
- A link naming a card that doesn't exist opens the tab with nothing expanded.

## Testing

- **Unit:**
  - the `activeTab` migration table;
  - each `navigate` caller lands on the right tab with the right card open;
  - the Accounts tile summary ("1 off by $36.10" only when a difference exists);
  - the pool tile appears only while a pool is set.
- **Page:** the existing tests that render `SyncPage` on Overview, Notifications
  or Advanced (14 fixtures) move to Home and Settings and keep their
  assertions. The copy-policy test renders the new tabs.
- **Visual:** capture Home and Settings with sample data and screenshot both in
  light and dark, as was done for the restyle.

## Out of scope

- Removing settings, shortening banner copy (2b).
- Budget's default card set and the customize ⋯ menu (2c).
- The setup wizard and README (part 4).
