import React from 'react';
import { CollapsibleCard, Disclosure } from './ui';
import { CategoryIcon } from './CategoryIcon';
import { GlyphPicker } from './GlyphPicker';
import { getCategoryEmoji } from '../../shared/telegram';
import { NOTIF_CARD } from '../tabs/NotificationsTab';
import type { TelegramCfgDraft, CfgPatch } from '../tabs/NotificationsTab';
import type { CategoryCatalogEntry } from '../utils/secrets';

/** Bucket for categories no budget group claims. Wealthfolio allows that state,
 *  so the selector has to show them somewhere rather than dropping them. */
const UNGROUPED = 'Ungrouped';

/** The three per-report selections, as draft keys. */
type CatKey = 'dailyReportCategories' | 'weeklyReportCategories' | 'monthlyReportCategories';

interface Props {
  cfg: TelegramCfgDraft;
  onChange: (patch: CfgPatch) => void;
  /** For the two settings that are their OWN stored values and have always been
   *  written the moment they change — glyph style and subcategory display. They
   *  never reach the save bar; see `changeNow` in NotificationsTab. */
  onChangeNow: (patch: Partial<TelegramCfgDraft>) => void;
  categories: CategoryCatalogEntry[];
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

/**
 * What the reports say: which categories they cover, whether they carry emoji,
 * and whether subcategories roll up or break out.
 *
 * PARENTS ONLY, GROUPED. Wealthfolio budgets at the parent level — its own
 * Spending Tracker has no subcategory amount field — and the reports aggregate
 * children into their parent, so a per-child checkbox controlled nothing a report
 * could act on while making this list 52 rows long. Children still travel in the
 * catalog: the companion needs them for the `breakdown` report mode, which is
 * where subcategory detail belongs.
 *
 * Groups come from `budget_groups`, so a group the user adds or reorders in
 * Wealthfolio shows up here with no change on our side. Unassigned categories
 * land in a trailing bucket rather than vanishing.
 */
export function ReportContent({
  cfg, onChange, onChangeNow, categories, isOpen, toggleCard,
}: Props) {
  const categoryRows = categories
    .filter((c) => !c.parent)
    .sort((a, b) => a.name.localeCompare(b.name));
  const childCount = categories.length - categoryRows.length;

  const categoryGroups = (() => {
    const order = new Map<string, number>();
    const icons = new Map<string, string | null>();
    for (const entry of categoryRows) {
      const g = entry.group ?? UNGROUPED;
      if (!order.has(g)) {
        order.set(g, entry.group ? (entry.groupSort ?? 9998) : 9999);
        icons.set(g, entry.group ? (entry.groupIcon ?? null) : null);
      }
    }
    return [...order.keys()]
      .sort((a, b) => (order.get(a)! - order.get(b)!) || a.localeCompare(b))
      .map((name) => ({
        name,
        icon: icons.get(name) ?? null,
        rows: categoryRows.filter((r) => (r.group ?? UNGROUPED) === name),
      }));
  })();
  // Only what the selector offers, so the 'all' sentinel stays reachable.
  const availableCategories = categoryRows.map((r) => r.name);

  // Count only names the companion still publishes: a saved selection can hold
  // categories that vanished at month rollover, and counting those would report
  // more checked boxes than the matrix actually shows.
  const catCount = (sel: string[] | 'all') =>
    sel === 'all' ? 'all' : String(sel.filter((n) => availableCategories.includes(n)).length);
  const categoriesSummary =
    `Daily ${catCount(cfg.dailyReportCategories)} · Weekly ${catCount(cfg.weeklyReportCategories)}`
    + ` · Monthly ${catCount(cfg.monthlyReportCategories)}`;
  const contentSummary = [
    categoriesSummary,
    cfg.glyphMode === 'glyphs' ? 'emoji icons' : 'no icons',
    cfg.subcategoryDisplay === 'breakdown' ? 'subcategories broken down' : null,
  ].filter((s): s is string => typeof s === 'string').join(' · ');

  /**
   * Add or remove one category from one report's selection.
   *
   * A FUNCTIONAL patch, with membership read from `prev` rather than from a
   * closed-over value: two toggles batched into one React tick would otherwise
   * both start from the same stale snapshot and the first would be dropped.
   */
  const toggle = (key: CatKey, name: string) => {
    onChange((prev) => {
      const current = prev[key];
      const base = current === 'all' ? availableCategories : current;
      const wasIncluded = current === 'all' || current.includes(name);
      const next = wasIncluded ? base.filter((n) => n !== name) : [...base, name];
      // Collapse to the 'all' sentinel only when the selection genuinely covers
      // every published category — a SET test, not a length test.
      // `availableCategories` is the union of *this month's* spending and
      // budgets, so it legitimately shrinks (a category with spending but no
      // budget vanishes at month rollover) while a saved selection still holds
      // the older, longer list. Comparing lengths then matched by coincidence:
      // with saved ['Groceries','Dining','Fun'] and a published
      // ['Groceries','Dining'], unchecking Groceries left a 2-element array
      // whose length equalled the published list, stored 'all', and silently put
      // every category back into the user's reports.
      //
      // Names no longer published are kept in `next` rather than pruned, so a
      // category that reappears next month comes back with the user's original
      // intent intact.
      const chosen = new Set(next);
      const coversEverything = availableCategories.every((n) => chosen.has(n));
      const value: string[] | 'all' = coversEverything ? 'all' : next;
      // Cast because a computed key from a union widens to an index signature,
      // which `Partial<TelegramCfgDraft>` will not accept.
      return { [key]: value } as Partial<TelegramCfgDraft>;
    });
  };

  return (
    <CollapsibleCard
      id={NOTIF_CARD.content}
      title="Report content"
      summary={contentSummary}
      open={isOpen(NOTIF_CARD.content)}
      onToggle={() => toggleCard(NOTIF_CARD.content)}
    >
      {/* A matrix rather than a "Daily"/"Weekly" word beside every checkbox: the
          column heading says it once, the boxes line up, and each row loses
          ~10px of height. The per-checkbox aria-label still carries both the
          category and the report, so the accessible name never depends on
          reading the column heading.

          Still behind its own nested disclosure, because one row per category
          is by far the tallest thing on this tab. */}
      <div className="sfin-disc-inset">
        <Disclosure
          id={NOTIF_CARD.categories}
          variant="inline"
          title="Report categories"
          summary={categoriesSummary}
          open={isOpen(NOTIF_CARD.categories)}
          onToggle={() => toggleCard(NOTIF_CARD.categories)}
        >
          <div className="sfin-subtle sfin-cats-hint">
            Every budgetable category is listed — Wealthfolio budgets at this level,
            so subcategories aren't selected individually. Reports still only print
            the ones with a budget or spending this month.
            {childCount > 0 && (
              <> Set <em>Subcategories</em> to <em>Break down</em> to see the {childCount}{' '}
              subcategories inside these in your reports.</>
            )}
          </div>

          {availableCategories.length === 0 && (
            <div className="sfin-subtle sfin-cats-hint">
              Categories will appear here after the companion's first sync.
            </div>
          )}

          {categoryGroups.map((group) => (
            <Disclosure
              key={group.name}
              id={`cat-group-${group.name}`}
              variant="inline"
              title={group.name}
              summary={`${group.rows.length} ${group.rows.length === 1 ? 'category' : 'categories'}`}
              open={isOpen(`cat-group-${group.name}`)}
              onToggle={() => toggleCard(`cat-group-${group.name}`)}
            >
              <div className="sfin-cats">
                {/* Spacer holding grid column 1 so the captions sit above the
                    checkbox columns rather than sliding left one cell. */}
                <div aria-hidden />
                <div className="sfin-cats-col sfin-cats-head">Daily</div>
                <div className="sfin-cats-col sfin-cats-head">Weekly</div>
                <div className="sfin-cats-col sfin-cats-head">Monthly</div>

                {group.rows.map((entry) => {
                  const name = entry.name;
                  const inSel = (sel: string[] | 'all') => sel === 'all' || sel.includes(name);
                  return (
                    <React.Fragment key={name}>
                      <div className="sfin-cat-name">
                        <CategoryIcon name={entry.icon} color={entry.color} size={15} />
                        <span className="sfin-cat-label">{name}</span>
                        {/* A palette, not a text field: the input this replaces
                            required knowing how to type an emoji on your
                            platform. Only shown in glyphs mode, where an
                            override does something — and where its placeholder
                            no longer reads as a missing amount. */}
                        {cfg.glyphMode === 'glyphs' && (
                          <GlyphPicker
                            label={`${name} — report emoji`}
                            value={cfg.glyphOverrides[name] ?? ''}
                            fallback={getCategoryEmoji(name)}
                            onChange={(glyph) => {
                              const next = { ...cfg.glyphOverrides };
                              if (glyph) next[name] = glyph; else delete next[name];
                              onChangeNow({ glyphOverrides: next });
                            }}
                          />
                        )}
                      </div>
                      <input
                        type="checkbox"
                        aria-label={`${name} — Daily`}
                        checked={inSel(cfg.dailyReportCategories)}
                        onChange={() => toggle('dailyReportCategories', name)}
                      />
                      <input
                        type="checkbox"
                        aria-label={`${name} — Weekly`}
                        checked={inSel(cfg.weeklyReportCategories)}
                        onChange={() => toggle('weeklyReportCategories', name)}
                      />
                      <input
                        type="checkbox"
                        aria-label={`${name} — Monthly`}
                        checked={inSel(cfg.monthlyReportCategories)}
                        onChange={() => toggle('monthlyReportCategories', name)}
                      />
                    </React.Fragment>
                  );
                })}
              </div>
            </Disclosure>
          ))}
        </Disclosure>
      </div>

      <div className="sfin-divider" />

      <div className="sfin-field-row">
        <label htmlFor="sfin-glyph-mode">Telegram report icons</label>
        <select
          id="sfin-glyph-mode"
          value={cfg.glyphMode}
          onChange={(e) => onChangeNow({ glyphMode: e.target.value as 'clean' | 'glyphs' })}
        >
          {/* Telegram renders neither colour nor Wealthfolio's own icons, so a
              report can only be plain or carry an emoji. */}
          <option value="clean">Clean — no icons</option>
          <option value="glyphs">Emoji per category</option>
        </select>
      </div>

      <div className="sfin-field-row">
        <label htmlFor="sfin-subcat-mode">Subcategories</label>
        <select
          id="sfin-subcat-mode"
          value={cfg.subcategoryDisplay}
          onChange={(e) => onChangeNow({
            subcategoryDisplay: e.target.value as 'rollup' | 'breakdown',
          })}
        >
          <option value="rollup">Roll up into the parent</option>
          <option value="breakdown">Break down under the parent</option>
        </select>
      </div>
    </CollapsibleCard>
  );
}
