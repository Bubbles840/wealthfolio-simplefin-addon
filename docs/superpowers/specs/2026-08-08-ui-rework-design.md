# SimpleFin Sync UI rework — tabs, dashboard styling, plain language

Date: 2026-08-08. Decisions made with Nick against live mockups (structure,
visual treatment, first-run, wording — each chosen from a rendered comparison;
the corrected Overview was approved as the final reference). Everything stays in
this one addon.

## Why

The addon accreted feature by feature and reads that way: one 1,474-line page
mixing the daily glance (balances, drift) with once-ever setup (Docker YAML, bot
tokens, IMAP passwords) across seven stacked collapsible cards; a ~460-line
Telegram mega-card holding six unrelated concerns; three different
capitalizations of "(optional)" in titles; emoji in some chrome and not other;
inline styles fighting a stylesheet. Functionality is right — the shape isn't.

## Structure: three tabs

A persistent header (title, sync status, `Deep scan` + `Sync now` buttons and
the error surface) above a tab row. The active tab persists across visits.

**Overview — the daily glance.** In order:

1. Drift/feed-lag banners — rendered only when present, as today. Drift is
   per-account and event-driven; it is NEVER a permanent dashboard tile.
2. Setup checklist card (see below), until completed or dismissed.
3. Stat tiles: `ACCOUNTS <n>` · `IMPORTED LAST RUN <n>` (a transaction count,
   never a dollar amount) · `NEEDS A CATEGORY <n>` (companion-published; the
   tile is absent when no count is available — see "Uncategorized count").
4. Accounts — stacked, one full-width card per account: name left; balance
   right with the status chip (`in sync` / `not checked` / `off by $X`)
   beneath it. Not a grid.

**Notifications — everything Telegram sends.** Three cards, replacing the
mega-card:

1. *Telegram connection* — bot token, chat id, Send test.
2. *Reports* — daily/weekly/monthly/import-notice toggles; large-transaction
   and balance-alert thresholds.
3. *Report content* — category matrix (grouped by budget group, as today),
   emoji style + glyph overrides, subcategory display.

One **dirty-state save bar** for the tab (“You have unsaved changes · Save”)
replaces the mega-card's bottom Save button. It appears when any card's state
differs from stored config, writes the same single `telegram_config` secret,
and disappears on save. Send-test remains usable without saving (it reads the
field values directly, as today).

**Advanced — set up once, rarely touched.** Stacked cards, each with a status
line in its header: Auto-sync (schedule, auto-heal, auto-adjust), Background
sync (Docker compose snippet, companion version/last-run when known), Amazon
categorization (the existing `AmazonCard` content), Transaction rules (the
existing editor). Below them, visually separated with destructive styling, a
**Reset connection** card (moves the reset flow out of hiding): plain-language
description, confirm-before-reset, imported data stays.

Advanced cards keep their existing save semantics (auto-sync applies on change,
Amazon has its own save) — the dirty-state save bar is a Notifications-tab
pattern only, because that tab is the one whose settings all write a single
shared secret.

The bottom "Spending Tracker" callout moves into the Advanced/Docker area where
it is relevant, out of the daily path.

## Setup checklist (first-run guidance)

The two-step SetupPage flow (claim token → map accounts) is unchanged, restyled.
After it, Overview shows a `Finish setting up` card with three rows, each
deep-linking to the right tab:

- **Background sync** — auto-completes when the `companion_version` secret
  exists.
- **Telegram reports** — auto-completes when bot token + chat id are saved.
- **Amazon categorization** — auto-completes when the mailbox config is saved.

Dismissible (✕); dismissal is stored and permanent until reset. The card never
blocks anything, and completing all three removes it without dismissal.

## Uncategorized count (the one companion change)

The addon cannot count uncategorized transactions itself — the SDK exposes no
category/taxonomy data (verified previously; same wall as the rules API). The
companion already computes exactly this for the import-notice sweep, so during
each sync it additionally publishes a secret:

- Key: `uncategorized_status`
- Value: `{ "count": <n>, "asOf": <ISO timestamp> }`
- Count: uncategorized spending activities in the last 90 days, using the same
  exclusions as the existing sweep (machine-created rows — starting balances,
  balance adjustments, in-transit placeholders — excluded).

The Overview tile renders only when this secret exists; its tooltip shows
`asOf`. Users without the companion never see the tile. This is the only
behavioral change outside the addon, and it is additive.

## Visual system (treatment "Dashboard-y")

- **Where CSS lives:** everything in the single `ThemeStyles` block in
  `ui.tsx`. The rework REMOVES scattered `style={{…}}` layout styling from
  page/tab components; new components carry no layout inline styles.
- **Tokens:** colors derive from host CSS variables (`--primary`,
  `--destructive`, `--muted-foreground`, backgrounds) so light/dark themes keep
  working. The three tile accents are fixed hues (green/blue/purple) mixed
  against the host background via `color-mix`.
- **Shapes:** stat tiles with 20px/700 numerals and a 3px colored left border;
  accounts and section cards with 14px radius and a soft shadow; pill buttons;
  the active tab is a filled pill, inactive tabs are quiet text pills.
- **Icons:** no emoji anywhere in UI chrome (titles, buttons, banners). Inline
  SVG or lucide-react (already a dependency) only. User-chosen report emoji
  (the glyph picker) are content, not chrome — unchanged.
- **Accessibility:** the tab row is a real `role="tablist"` with arrow-key
  navigation and `aria-selected`; the save bar announces via `role="status"`;
  chips keep text labels (color is never the only signal — existing rule).

## Copy (plain-first)

Lead with everyday words; keep the precise technical term in tooltips and help
disclosures. Terminology table applied to all user-visible text:

| Today | Becomes | Technical term kept in |
| --- | --- | --- |
| Reconcile & link | Deep scan | button tooltip |
| drift / "is ahead of its feed" | off by $X / bank is ahead of its own feed | banner detail text |
| starting-balance baseline | opening balance | baseline-fix confirm dialog |
| heal / heal window | re-scan / re-scan window | tooltips |
| Sync Now / Auto-Sync | Sync now / Auto-sync | — |

Title policy: sentence case everywhere; drop every "(optional)" suffix —
optionality is conveyed by the checklist and by "Not set up" status lines.

**Frozen strings — data, not copy.** These are load-bearing contracts and MUST
NOT change: stored comment markers (`Starting balance · `,
`Balance adjustment · `, the in-transit prefix, ` · pending`), secret keys, log
tags (`duplicate-refused`, `duplicate-prune`), and the Amazon comment format
(`· Amazon: <label> ·`). Only display copy changes.

## Code reorganization

`SyncPage.tsx` (1,474 lines) becomes a thin shell: header, error surface, tab
row, active-tab render. New files, each with one purpose, target ≤ ~400 lines:

```
src/pages/SyncPage.tsx            → shell only
src/tabs/OverviewTab.tsx          → banners, checklist, tiles, accounts
src/tabs/NotificationsTab.tsx     → owns telegram config state + save bar
src/tabs/AdvancedTab.tsx          → auto-sync, docker, amazon, rules, reset
src/components/SetupChecklist.tsx
src/components/TelegramConnect.tsx
src/components/ReportSettings.tsx
src/components/ReportContent.tsx  → matrix + glyphs + subcategories
src/components/Tabs.tsx           → accessible tab primitive
```

`SyncPage.test.tsx` (1,053 lines) splits the same way — tests move with their
features, none deleted or weakened. `AmazonCard`, `RuleEditor`,
`AccountMapper`, `GlyphPicker` are reused as-is inside their new homes.

New UI state secret `ui_state`: `{ "activeTab": string,
"checklistDismissed": boolean }` — separate from `open_cards` (which stays for
the disclosure states inside tabs).

## Non-goals

- No sync/reconcile/drift behavior changes. No companion changes beyond the
  additive `uncategorized_status` publish. No secret schema changes beyond the
  two new keys. No store-listing redesign (screenshots refresh at release).
- SetupPage flow unchanged (visual pass only).

## Testing

- Every existing test passes throughout (694 addon+shared+companion at time of writing), relocated but not weakened.
- New: tab switching + persistence; checklist auto-completion from each signal
  and dismissal; save-bar appears on dirt, saves once, disappears; the
  needs-a-category tile absent without the secret and present with it;
  accounts render stacked with correct chips; no "(optional)" or chrome emoji
  in rendered titles (smoke test on the terminology policy).
- Companion: one test for the `uncategorized_status` publish.

## Ship

v1.10.0. The addon works fully against a v1.9.0 companion (the tile just stays
hidden); the companion rebuild is only needed for the needs-a-category tile.
Release = both store files' six version fields + fresh screenshots, per the
release-process notes.
