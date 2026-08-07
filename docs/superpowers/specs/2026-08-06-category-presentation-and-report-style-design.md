# Category presentation, report styling, and two deploy-visibility fixes

Date: 2026-08-06. Approved by Nick in conversation. Ships as 1.7.0.

Amazon purchase itemization is explicitly OUT of scope here — it gets its own
spec next, starting with a mailbox-content probe rather than code.

## Why

Four problems, all surfaced by live use:

1. **Categories with neither a budget nor spending are invisible.** The addon's
   selection list comes from a companion-written secret computed as
   `unionCategoryNames(spentMap, budgetMap)`, so "Personal Care" cannot be
   selected until money moves through it. Nick wants to see all 52 and choose;
   the *report* should keep showing only budgeted-or-spent ones.
2. **The reports' emoji don't fit.** `☀️`, `💰`, `🏷️`, `🔔` and a keyword-matched
   per-category emoji are hardcoded across four builders.
3. **Subcategories are invisible.** The spending query collapses children into
   parents via `COALESCE(parent.name, tc.name)`, so a Transportation envelope
   never shows where the money went.
4. **A deployed build is unidentifiable, and a stale tab looks like an outage.**
   `companion/package.json` has read `1.0.1` since the start, which cost a
   diagnostic detour on 2026-08-06; and the Sync page renders once, so a tab left
   open showed a day-old sync time and a resolved error banner, prompting a false
   alarm.

## Findings that constrain the design

- Wealthfolio stores per-category `icon` and `color` on `taxonomy_categories`.
  Icons are **lucide-react PascalCase export names** (`FileText`, `Gamepad2`,
  `GraduationCap`) and `lucide-react` is already a dependency — so the addon can
  resolve them dynamically with no mapping table.
- **Telegram cannot render them.** Messages are Unicode-only; custom emoji is
  Premium-gated. So Wealthfolio's icons apply to the addon UI ONLY, and the
  reports need a Unicode answer instead.
- The addon has no taxonomy API of any kind. Everything it knows about
  categories must arrive through a companion-written secret.

## 1. Version visibility

`shared/version.ts` exports the release version as a constant, bumped by the
release flow alongside `manifest.json`/`package.json`. Both halves import it, so
they can never disagree. The companion logs it in its startup banner and writes
it to a `companion_version` secret; the Sync page displays it beside the addon's
own version. `companion/package.json` stays where it is — it is the container's
dependency manifest, not a product version, and conflating the two is what
caused the confusion.

## 2. Live Sync page

The page re-reads sync state (last-synced, balances, errors) on `window` focus
and on a 60-second interval while mounted, cancelled on unmount. No polling of
SimpleFin — this reads only local secrets, so it is cheap. Fixes the
stale-render class of false alarm.

## 3. Category catalog

The companion replaces the `available_report_categories` string array with a
catalog written to `report_category_catalog`:

```ts
interface CategoryCatalogEntry {
  name: string;           // rolled-up display name
  parent: string | null;  // parent display name, null for top level
  icon: string | null;    // lucide PascalCase, straight from Wealthfolio
  color: string | null;   // hex, straight from Wealthfolio
  hasBudget: boolean;     // a budget target exists this month
  hasSpend: boolean;      // money moved this month
}
```

Sourced from `taxonomy_categories` joined to budgets and month spend, so new
categories created in Wealthfolio's own UI appear on the next sync with no
action from us. The addon reads the catalog when present and falls back to the
old string array, so a companion that has not been rebuilt yet keeps working.

The selection matrix renders **every** entry, grouped under its parent, with its
icon and color. Reports keep today's `hasBudget || hasSpend` filter — the two
concerns are now independent, which is the whole point.

## 4. Icons in the addon

A `CategoryIcon` component resolves `icon` against `lucide-react`'s exports and
renders a neutral fallback for a missing or unrecognised name (Wealthfolio may
add icons we do not know). Colour comes from the same row. Purely presentational
— no report path touches it.

## 5. Report glyphs: clean default, per-category override

One **glyph resolver** replaces every hardcoded literal, so style is a single
decision instead of four builders' worth of scattered emoji:

```ts
interface GlyphStyle {
  mode: 'clean' | 'glyphs';
  overrides: Record<string, string>;   // category name -> glyph
}
```

- `clean` (default): no decorative glyphs. Category lines are plain text with
  bold figures. Emoji survive ONLY where they carry meaning — `🚨` over budget,
  `⏳` waiting on the feed, because those encode state rather than decoration.
- `glyphs`: a restrained default per category, replacing `getCategoryEmoji`'s
  keyword matching.
- `overrides` applies in either mode, edited per category in the addon.

Stored in a `report_glyph_style` secret. `getCategoryEmoji` is retained but
becomes the `glyphs`-mode default source rather than an unconditional one.

## 6. Subcategory display toggle

A `subcategory_display` setting: `rollup` (today's behavior, unchanged and the
default) or `breakdown`. In `breakdown` the parent keeps its budget line and its
children are listed beneath it, spend-only unless a child carries its own
budget:

```
Transportation   *$120 left*
   Gas & Fuel      $71
   Parking         $34
```

This requires the data layer to stop collapsing: `getNativeWealthfolioSpending`
gains a sibling that returns `(parent, child, amount)` rows, leaving the
rollup-vs-breakdown decision to the formatter. The existing rolled-up reader
stays as-is so the default path is untouched.

## Testing

TDD throughout. The report rewrite is the risk — four builders, ~40 existing
tests — so both styles get pinned rather than assertions replaced wholesale:
every existing test keeps asserting `glyphs`-mode output, and new tests assert
`clean`. Catalog tests cover a category with neither budget nor spend appearing
in the catalog but NOT in the report. Subcategory tests cover both modes,
including a child with its own budget.

## Out of scope

- Creating categories from the addon (auto-detection covers the need; writing to
  Wealthfolio's taxonomy tables is not justified for it).
- Any Amazon work.
- Colour in Telegram — impossible, same reason as icons.
