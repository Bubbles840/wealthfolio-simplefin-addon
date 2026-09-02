import React from 'react';

/**
 * Minimal UI kit styled with Wealthfolio's own design tokens.
 *
 * The addon sandbox mirrors every CSS variable from the host document
 * (--background, --card, --primary, --muted, --border, --radius, ...), so
 * using them here makes the addon follow the active theme — light or dark,
 * including user theme changes — with zero addon-side theme logic.
 */

const STYLE_ID = 'sfin-ui-styles';

const css = `
.sfin-page {
  max-width: 680px;
  margin: 0 auto;
  padding: 24px;
  color: var(--foreground);
  font-size: 14px;
}
.sfin-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
}
.sfin-subtle { color: var(--muted-foreground); font-size: 13px; }
.sfin-card {
  background: var(--card, var(--background));
  border: 1px solid var(--border, color-mix(in srgb, var(--muted-foreground) 22%, transparent));
  border-radius: 14px; padding: 14px 16px; margin-bottom: 10px;
  box-shadow: 0 2px 8px color-mix(in srgb, #000 24%, transparent);
}
.sfin-section-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted-foreground);
  margin-bottom: 8px;
}
.sfin-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  border: 1px solid transparent;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
  background: var(--primary);
  color: var(--primary-foreground);
}
.sfin-btn:hover:not(:disabled) { opacity: 0.85; }
.sfin-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sfin-btn--outline {
  background: transparent;
  color: var(--foreground);
  border-color: var(--border);
}
.sfin-btn--outline:hover:not(:disabled) { background: var(--muted); opacity: 1; }
.sfin-btn--ghost {
  background: transparent;
  color: var(--muted-foreground);
}
.sfin-btn--ghost:hover:not(:disabled) { background: var(--muted); color: var(--foreground); opacity: 1; }
.sfin-btn--destructive {
  background: transparent;
  color: var(--destructive);
  border-color: var(--destructive);
}
.sfin-btn--destructive:hover:not(:disabled) { background: var(--destructive); color: var(--destructive-foreground); opacity: 1; }
.sfin-input, .sfin-select {
  background: var(--background);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}
.sfin-input:focus, .sfin-select:focus { border-color: var(--ring, var(--primary)); }
.sfin-input::placeholder { color: var(--muted-foreground); }
.sfin-error {
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
  color: var(--destructive);
  border: 1px solid color-mix(in srgb, var(--destructive) 35%, transparent);
  border-radius: calc(var(--radius) - 2px);
  padding: 10px 12px;
  font-size: 13px;
  margin: 12px 0;
}
.sfin-callout {
  background: var(--muted);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  padding: 10px 12px;
  font-size: 13px;
  margin-bottom: 16px;
  line-height: 1.5;
}
.sfin-callout a { color: inherit; font-weight: 600; }
.sfin-pre {
  background: var(--muted);
  color: var(--foreground);
  border: 1px solid var(--border);
  padding: 12px;
  border-radius: calc(var(--radius) - 2px);
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
}
.sfin-row {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.sfin-row:last-of-type { border-bottom: none; }
.sfin-step {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 4px;
}

/* ── Redesign: header, stat tiles, account rows, chips, drift banner ────── */
.sfin-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; margin-bottom: 16px;
}
/* Deep scan + Sync now. Never shrinks, so the pair keeps its width and the
   title beside it is what gives way on a narrow window. */
.sfin-head-actions { display: flex; gap: 8px; flex: none; }
/* "Sync anyway", which sits inline at the end of the interval-skip sentence. */
.sfin-callout-action { margin-left: 4px; }
/* The addon/companion version line, below the tab panel. */
.sfin-foot { margin-top: 20px; font-size: 11px; }
.sfin-foot-warn { margin-left: 6px; opacity: 0.9; }
.sfin-live { color: var(--primary); }
/* Columns come from the tiles that are actually rendered, never from a fixed
   count. Overview shows two tiles or three — "Needs a category" only exists once
   the companion has published one — and a repeat(3, 1fr) template left the
   two-tile case filling 2/3 of the width beside a phantom empty column. Column
   auto-flow with no template gives one equal column per child, so it fits
   either case (and any future tile) without a modifier class or inline style. */
.sfin-strip {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 10px; margin-top: 16px;
}
.sfin-tile {
  flex: 1; border-radius: 14px; padding: 12px 14px;
  background: var(--card, var(--background));
  border: 1px solid var(--border, color-mix(in srgb, var(--muted-foreground) 22%, transparent));
  border-left-width: 3px;
  box-shadow: 0 2px 8px color-mix(in srgb, #000 24%, transparent);
}
.sfin-tile .sfin-section-label { margin-bottom: 3px; }
.sfin-tile-val {
  font-size: 21px; font-weight: 700; letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.sfin-tile-sub { font-size: 10px; color: var(--muted-foreground); margin-top: 2px; }
.sfin-tile--green  { border-left-color: #4ade80; }
.sfin-tile--blue   { border-left-color: #60a5fa; }
.sfin-tile--purple { border-left-color: #a78bfa; }
/* The "Needs a category" tile doubles as a disclosure trigger once there is a
   list to show. Background, border and left-accent colour keep coming from
   .sfin-tile/.sfin-tile--purple above — this rule only resets the parts of
   a native <button> that would otherwise fight them (appearance, centered
   text, the pointer). */
.sfin-tile--toggle {
  appearance: none;
  -webkit-appearance: none;
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.sfin-tile--toggle:hover { background: var(--muted); }
.sfin-tile--toggle:focus-visible { outline: 2px solid var(--ring, var(--primary)); outline-offset: -2px; }
/* Label + chevron on one line, header-style. */
.sfin-tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sfin-tile-head .sfin-section-label { margin-bottom: 0; }
/* The panel under the tile. Padding used to come from
   .sfin-disclosure-body--inline, gone now that the tile is the trigger and
   this component is the panel alone. */
.sfin-uncat-panel { margin-top: 8px; padding: 8px 11px 10px; }
.sfin-card-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-bottom: 2px;
}
.sfin-acct-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
/* Lets the name ellipsis rather than push the balance off the row. */
.sfin-acct-ident { min-width: 0; }
.sfin-acct-gone { color: var(--destructive); }
.sfin-avatar {
  width: 34px; height: 34px; flex: none; border-radius: 9px;
  background: color-mix(in srgb, var(--primary) 16%, transparent);
  color: var(--primary); display: grid; place-items: center;
  font-weight: 700; font-size: 12px; text-transform: uppercase;
}
.sfin-acct-name {
  font-weight: 550; font-size: 13.5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sfin-acct-map { color: var(--muted-foreground); font-size: 12px; }
.sfin-acct-right { text-align: right; flex: none; }
.sfin-bal {
  font-size: 16px; font-weight: 640; letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.sfin-chip {
  display: inline-flex; align-items: center; gap: 5px; margin-top: 5px;
  font-size: 11px; font-weight: 550; padding: 2px 8px; border-radius: 999px;
  background: color-mix(in srgb, var(--primary) 15%, transparent); color: var(--primary);
}
.sfin-chip--off {
  background: color-mix(in srgb, var(--destructive) 14%, transparent);
  color: var(--destructive);
}
/* Deliberately NEITHER green nor red: "not checked" is an absence of information,
   and colouring it either way would state something. Muted foreground on a faint
   neutral, so it reads as quieter than both siblings rather than as a third alarm. */
.sfin-chip--muted {
  background: color-mix(in srgb, var(--muted-foreground) 12%, transparent);
  color: var(--muted-foreground);
}
.sfin-chip svg { width: 11px; height: 11px; }
/* Tab pills — active is a filled pill, inactive stay quiet (treatment C). */
.sfin-tabbar { display: flex; gap: 6px; margin: 14px 0 16px; }
.sfin-tab {
  border: none; background: transparent; color: var(--muted-foreground);
  font-size: 13px; font-weight: 550; padding: 6px 16px; border-radius: 999px;
  cursor: pointer;
}
.sfin-tab:hover { background: color-mix(in srgb, var(--muted-foreground) 10%, transparent); }
.sfin-tab--active {
  background: var(--primary); color: var(--primary-foreground);
  font-weight: 600;
}
.sfin-banner-warn {
  display: flex; gap: 10px; align-items: flex-start;
  background: color-mix(in srgb, var(--destructive) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--destructive) 32%, transparent);
  border-radius: calc(var(--radius) - 2px);
  padding: 12px 14px; font-size: 13px; line-height: 1.5; margin-top: 16px;
}
.sfin-banner-warn b { color: var(--foreground); font-weight: 600; }
/* The calm sibling: a drift the sync expects to resolve itself (the bank's
   balance ahead of its own feed). Deliberately NOT destructive-tinted — red is
   what goaded users into plugging feed lag. */
.sfin-banner-wait {
  display: flex; gap: 10px; align-items: flex-start;
  background: color-mix(in srgb, var(--muted-foreground) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--muted-foreground) 25%, transparent);
  border-radius: calc(var(--radius) - 2px);
  padding: 12px 14px; font-size: 13px; line-height: 1.5; margin-top: 16px;
}
.sfin-banner-wait b { color: var(--foreground); font-weight: 600; }
/* Shared innards of both banners, previously repeated as inline styles on every
   one of them. Same values, so the banners look exactly as they did. */
.sfin-banner-body { flex: 1; min-width: 0; }
.sfin-banner-note { margin-top: 4px; opacity: 0.85; }
.sfin-banner-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.sfin-banner-list { margin: 8px 0 0; padding-left: 18px; }

/* ── Settings primitives: label/control rows, field grids, checkbox lists,
      inset panels, the report-category matrix. All themed off the host's own
      tokens — a hardcoded colour here would survive a theme switch and stop
      matching everything around it. ───────────────────────────────────────── */
.sfin-field-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
}
.sfin-field-row .sfin-section-label { margin-bottom: 0; }
/* Two inputs side by side on a normal window, stacked before they get too
   narrow to read the placeholder in. */
.sfin-fields {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px 12px;
}
.sfin-fields label { display: block; margin-bottom: 3px; }
.sfin-fields input { width: 100%; }
.sfin-checks { display: flex; flex-direction: column; gap: 8px; }
.sfin-check {
  display: flex; align-items: flex-start; gap: 8px;
  cursor: pointer; line-height: 1.45;
}
.sfin-check input { flex: none; margin: 2px 0 0; }
.sfin-check-name { font-weight: 550; }
.sfin-divider { border-top: 1px solid var(--border); margin: 14px 0 12px; }
/* Name + Daily + Weekly + Monthly. */
.sfin-cats {
  display: grid; grid-template-columns: 1fr auto auto auto;
  align-items: center; row-gap: 5px; column-gap: 12px;
  font-size: 13px; line-height: 1.55;
}
.sfin-cats-col {
  width: 46px; text-align: center;
  font-size: 10.5px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted-foreground);
}
.sfin-cats input[type='checkbox'] { justify-self: center; margin: 0; }
/* Heading row: one shared pad so the column captions and the section label sit
   on the same baseline and the first category row isn't jammed under them. */
.sfin-cats-head { margin-bottom: 0; padding-bottom: 4px; }
.sfin-cats-hint { font-size: 12px; margin-bottom: 8px; }
.sfin-cat-name {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  font-size: 13px; font-weight: 500;
}
/* The category itself, distinguished from the emoji override beside it. */
.sfin-cat-label { font-weight: 600; }
.sfin-cat-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ── Emoji picker: a curated palette, because the input it replaces assumed the
      user knows how to type an emoji on their platform. ───────────────────── */
.sfin-glyph-btn {
  width: 26px; height: 22px; padding: 0; font-size: 14px; line-height: 1;
  background: var(--muted); color: inherit; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--muted-foreground) 28%, transparent);
  border-radius: calc(var(--radius) - 4px);
}
.sfin-glyph-btn:hover { border-color: var(--primary); }
/* FIXED, not absolute: two ancestors (.sfin-disc-inset, .sfin-card--collapsible)
   set overflow:hidden for their rounded corners, which clipped an absolutely-
   positioned panel out of existence. The component supplies top/left from the
   button's viewport rect. */
.sfin-glyph-pop {
  position: fixed; z-index: 60;
  width: 232px; max-height: 240px; overflow-y: auto; padding: 8px;
  background: var(--popover, var(--background)); color: var(--foreground);
  border: 1px solid color-mix(in srgb, var(--muted-foreground) 30%, transparent);
  border-radius: var(--radius); box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
}
.sfin-glyph-group {
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted-foreground); margin: 6px 0 3px;
}
.sfin-glyph-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; }
.sfin-glyph-cell {
  height: 24px; padding: 0; font-size: 15px; line-height: 1; cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: 4px;
}
.sfin-glyph-cell:hover { background: var(--muted); }
.sfin-glyph-cell--on { border-color: var(--primary); background: var(--muted); }
.sfin-glyph-clear {
  width: 100%; padding: 4px 6px; font-size: 11.5px; cursor: pointer;
  background: transparent; color: var(--muted-foreground);
  border: 1px solid color-mix(in srgb, var(--muted-foreground) 24%, transparent);
  border-radius: calc(var(--radius) - 4px);
}
.sfin-glyph-clear:hover { color: var(--foreground); border-color: var(--primary); }
/* ── Disclosure: the ONE collapse pattern on the page ─────────────────────
      A single <button> spanning the whole header row, so the click target is
      the row (not a 10px chevron) and aria-expanded lives on the element
      that actually takes focus — keyboard operation comes free from the
      native button. Two flavours, same shape: "card" for a top-level
      collapsible card, "inline" for one nested inside a card's body.
      The chevron rotates, but it is aria-hidden and never the only signal:
      the header's summary line carries the state as text. */
.sfin-card--collapsible { padding: 0; overflow: hidden; }
.sfin-disclosure {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  width: 100%; box-sizing: border-box;
  background: transparent; border: 0; border-radius: 0;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
}
.sfin-disclosure:hover { background: var(--muted); }
.sfin-disclosure:focus-visible { outline: 2px solid var(--ring, var(--primary)); outline-offset: -2px; }
.sfin-disclosure--card { padding: 13px 16px; }
.sfin-disclosure--inline { padding: 9px 11px; }
.sfin-disclosure-text { min-width: 0; }
.sfin-disclosure-text .sfin-section-label { margin-bottom: 0; }
/* The summary line: what makes collapsing safe rather than hiding state. */
.sfin-disclosure-sum {
  display: block; margin-top: 3px; font-size: 12.5px; line-height: 1.4;
  color: var(--muted-foreground);
}
.sfin-chevron {
  flex: none; font-size: 10px; line-height: 1; color: var(--muted-foreground);
  transition: transform 0.15s;
}
.sfin-chevron[data-open='true'] { transform: rotate(180deg); }
.sfin-disclosure-body--card { padding: 2px 16px 16px; }
.sfin-disclosure-body--inline { padding: 0 11px 10px; }
.sfin-disclosure-body ol { margin: 0; padding-left: 18px; }
.sfin-disclosure-body ol li + li { margin-top: 2px; }
/* Quiet container for a nested (inline) disclosure: the read-once setup guide,
   the category matrix. Same tokens as .sfin-callout, but the padding lives on
   the disclosure so the clickable header reaches the panel's edges. */
.sfin-disc-inset {
  background: var(--muted); color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  overflow: hidden; font-size: 13px; line-height: 1.55;
}
/* ── Numeric settings: a label on the left, an amount on the right ─────────
      The two dollar thresholds pair a checkbox with the amount, because absent
      means OFF for one and ON-at-$100 for the other — so an empty field cannot
      express "off" for both and the checkbox has to. A disabled amount is
      exposed to assistive tech as disabled, so the on/off state never rests on
      the greying alone. */
.sfin-nums { display: flex; flex-direction: column; }
.sfin-thresh {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap; min-height: 30px;
}
.sfin-thresh .sfin-check { align-items: center; }
.sfin-thresh label { cursor: pointer; min-width: 0; }
.sfin-thresh-amt { display: flex; align-items: center; gap: 6px; flex: none; }
.sfin-num {
  width: 88px; text-align: right; font-variant-numeric: tabular-nums;
}
.sfin-num:disabled { opacity: 0.5; cursor: not-allowed; }
/* Indented to line up under the checkbox's label, and given the bottom margin
   that separates one setting from the next. */
.sfin-num-hint { font-size: 12px; margin: 1px 0 12px 22px; line-height: 1.45; }
.sfin-nums .sfin-num-hint:last-child { margin-bottom: 0; }
.sfin-status { font-size: 12.5px; }
.sfin-status--ok { color: var(--success, var(--primary)); }
.sfin-status--err { color: var(--destructive); }
.sfin-status--busy { color: var(--muted-foreground); }

/* ── Dashboard treatment additions: floating account rows, sticky save bar,
      destructive-boundary card. New selectors — consumed by later tasks. ──── */
/* One account per row, floating. Stacked rather than a grid: each row spans the
   width, so a balance and its chip sit under nothing but their own account. */
.sfin-acct-card { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.sfin-accts { margin-top: 16px; }
.sfin-accts .sfin-card-head { margin-bottom: 8px; }
.sfin-accts-asof { font-size: 11.5px; }
/* Only a row whose Wealthfolio account still exists is clickable, so only that
   row advertises it. */
.sfin-acct-card--link { cursor: pointer; transition: background 0.12s; }
.sfin-acct-card--link:hover { background: var(--muted); }
.sfin-acct-card--link:focus-visible { outline: 2px solid var(--ring, var(--primary)); outline-offset: -2px; }
/* Notifications-tab card bodies: a vertical rhythm and the row a lone action
   button sits in. Both were inline styles on the mega-card this replaced. */
.sfin-stack { display: flex; flex-direction: column; gap: 12px; }
.sfin-stack-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
/* Spacing under the things that introduce a card: the one-line description and
   the read-once setup guide. */
.sfin-notif-intro { margin-bottom: 12px; }
/* Marks the controls that are stored on change, in a card whose other controls
   wait for the save bar. */
.sfin-applies-now { font-size: 12px; margin-top: 6px; }
/* Sticky save bar (Notifications tab). */
.sfin-savebar {
  position: sticky; bottom: 8px; display: flex; justify-content: space-between;
  align-items: center; gap: 12px; padding: 10px 16px; border-radius: 999px;
  background: var(--card, var(--background));
  border: 1px solid var(--border, color-mix(in srgb, var(--muted-foreground) 30%, transparent));
  box-shadow: 0 4px 16px color-mix(in srgb, #000 35%, transparent);
}
/* The message half of the bar: "You have unsaved changes", plus the reason Save
   is unavailable when it is. Stacked, because the second line explains the
   first. It is also the live region, and stays mounted (empty) when the bar is
   not showing — a role="status" only announces changes made after it exists. */
.sfin-savebar-msg { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
/* Destructive-boundary card for Reset. */
.sfin-danger-card {
  border: 1px solid color-mix(in srgb, var(--destructive) 40%, transparent);
  border-radius: 14px; padding: 14px 16px; margin-top: 18px;
}
.sfin-danger-note { margin-top: 4px; }
.sfin-danger-actions { margin-top: 10px; display: flex; gap: 8px; }

/* Advanced tab: spacing that used to be an inline style prop on SyncPage,
   carried over on the move to AdvancedTab (no layout style props outside
   this file). */
.sfin-autosync-hint { margin-top: 6px; }
.sfin-autosync-checks { margin-top: 14px; }
.sfin-docker-intro { margin-bottom: 6px; }
.sfin-docker-pre { margin: 0; }
/* The line under the compose snippet explaining what the database mount buys. */
.sfin-docker-note { margin-top: 8px; }
/* Last thing in the tab before the danger card, which supplies its own
   margin-top — so this callout's bottom margin is zeroed to avoid doubling up. */
.sfin-advanced-callout { margin-top: 16px; margin-bottom: 0; }

/* ── "Finish setting up" checklist: first-run guidance without a wizard ─── */
.sfin-checklist { border-left: 3px solid #60a5fa; }
.sfin-checklist-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.sfin-checklist-x { border: none; background: transparent; color: var(--muted-foreground); font-size: 16px; cursor: pointer; }
.sfin-checklist-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
.sfin-checklist-dot {
  width: 16px; height: 16px; border-radius: 50%; flex: none;
  border: 1.5px solid var(--muted-foreground); display: inline-flex;
  align-items: center; justify-content: center;
}
.sfin-checklist-dot--done { border-color: #4ade80; color: #4ade80; }
.sfin-checklist-dot svg { width: 10px; height: 10px; }
.sfin-checklist-label { flex: 1; font-size: 13px; }
.sfin-checklist-link { border: none; background: transparent; color: #60a5fa; cursor: pointer; font-size: 12px; }

/* ── "Needs a category" list: the transactions behind the Overview tile ──── */
.sfin-uncat-row {
  display: flex; align-items: center; gap: 10px; padding: 5px 0;
  border-top: 1px solid color-mix(in srgb, var(--muted-foreground) 14%, transparent);
}
.sfin-uncat-row:first-of-type { border-top: none; }
.sfin-uncat-when { flex: none; font-size: 11px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.sfin-uncat-what { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfin-uncat-amt { flex: none; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sfin-amt--in { color: #16a34a; }
.sfin-amt--out { color: #dc2626; }

/* ── Budget tab ─────────────────────────────────────────────────────────── */
.sfin-page--wide { max-width: 1280px; }
/* Wealthfolio's own ambience: a faint sage wash bleeding in from the top-left
   and bottom-right, behind every tab of the addon. ON THE BODY, not a
   z-index:-1 layer — the sandbox body paints an opaque --background, and
   anything stacked beneath it is invisible by construction (v1.31.0 shipped
   exactly that and the gradient never showed). Fixed attachment so it spans
   the viewport, layered over the theme background so light mode keeps its
   own ground. */
body {
  background:
    radial-gradient(1000px 520px at 8% -6%, rgba(94, 148, 131, .22), transparent 60%),
    radial-gradient(1200px 680px at 106% 110%, rgba(94, 148, 131, .14), transparent 58%),
    var(--background);
  background-attachment: fixed, fixed, scroll;
}
.sfin-budget-toolbar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-bottom: 10px; }
.sfin-budget-heroes { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.sfin-budget-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; margin-top: 14px; }
.sfin-cell { min-width: 0; }
.sfin-cell[role="button"] { cursor: pointer; outline: none; border-radius: 12px; }
.sfin-cell--wide { grid-column: span 2; }
/* The size cycle: fixed row rhythm so every shape lines up flush. */
.sfin-budget-grid { grid-auto-rows: 158px; grid-auto-flow: dense; }
.sfin-cell--c { grid-row: span 1; }
.sfin-cell--m { grid-row: span 2; }
.sfin-cell--w { grid-column: span 2; grid-row: span 2; }
.sfin-cell--t { grid-row: span 3; }
.sfin-cell--b { grid-column: span 2; grid-row: span 3; }
@media (max-width: 720px) {
  .sfin-cell--wide, .sfin-cell--w, .sfin-cell--b { grid-column: span 1; }
}
.sfin-budget-grid .sfin-cell { position: relative; overflow: hidden; }
.sfin-budget-grid .sfin-report-body .sfin-chart { min-height: 0; }
.sfin-budget-grid .sfin-report-card { overflow: hidden; }
.sfin-cell--editing .sfin-report-card { border-style: dashed; }
.sfin-card-tools {
  position: absolute; top: 6px; right: 6px; z-index: 2;
  display: flex; gap: 2px; flex-wrap: wrap; justify-content: flex-end;
  padding: 2px; border-radius: 9px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  backdrop-filter: blur(6px);
  font-size: 11px;
}
.sfin-card-tools button { padding: 2px 7px; font-size: 11px; }
.sfin-report-card {
  height: 100%; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box;
  transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
}
.sfin-cell[role="button"]:hover .sfin-report-card,
.sfin-cell[role="button"]:focus-visible .sfin-report-card {
  border-color: color-mix(in srgb, currentColor 30%, transparent);
  transform: translateY(-1px);
  box-shadow: 0 8px 22px rgba(0, 0, 0, .16);
}
.sfin-report-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sfin-report-body .sfin-chart { flex: 1; min-height: 170px; }
.sfin-report-body--hero .sfin-chart { min-height: 260px; }
.sfin-range-chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
.sfin-new-report-card {
  border: 1.5px dashed color-mix(in srgb, currentColor 25%, transparent);
  background: transparent; border-radius: 12px; min-height: 110px;
  display: flex; align-items: center; justify-content: center;
  font: inherit; font-size: 14px; color: inherit; opacity: .7; cursor: pointer;
  transition: opacity .15s ease, border-color .15s ease;
}
.sfin-new-report-card:hover { opacity: 1; border-color: color-mix(in srgb, currentColor 45%, transparent); }
.sfin-merchant-table, .sfin-custom-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.sfin-merchant-table th, .sfin-custom-table th {
  text-align: right; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
  opacity: .6; padding: 4px 8px; font-weight: 600;
}
.sfin-merchant-table th:first-child, .sfin-merchant-table td:first-child,
.sfin-custom-table th:first-child, .sfin-custom-table td:first-child {
  text-align: left; padding-left: 0; max-width: 240px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sfin-merchant-table td, .sfin-custom-table td {
  padding: 5px 8px; text-align: right; font-variant-numeric: tabular-nums;
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.sfin-heat-cell { height: 26px; border-radius: 4px; }
/* ── Auto-density: content conforms to the box it is given ──────────────────
   Each grid cell is a size container; short cells shrink their type and fade
   out at the bottom edge, so nothing ever looks torn off mid-row. The
   list-reports also budget their ROW COUNT from the card's span (see
   ReportView's density prop) — this is the typographic half. */
.sfin-budget-grid .sfin-cell { container-type: size; }
.sfin-budget-grid .sfin-report-body {
  overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 88%, transparent);
  mask-image: linear-gradient(#000 88%, transparent);
}
@container (max-height: 200px) {
  .sfin-report-card { font-size: 12px; padding: 10px 12px; }
  .sfin-report-card .sfin-section-label { font-size: 9.5px; margin-bottom: 4px; }
  .sfin-report-card .sfin-merchant-table,
  .sfin-report-card .sfin-custom-table { font-size: 11px; }
  .sfin-report-card .sfin-heat-cell { height: 16px; }
}
@container (max-height: 360px) {
  .sfin-report-card { font-size: 12.5px; }
}
/* The corner drag handle, customize mode only. */
.sfin-resize-handle {
  position: absolute; right: 3px; bottom: 3px; z-index: 3;
  width: 22px; height: 22px; border-radius: 6px;
  cursor: nwse-resize; touch-action: none;
  background:
    linear-gradient(135deg, transparent 46%, color-mix(in srgb, currentColor 45%, transparent) 48%, transparent 52%,
      transparent 62%, color-mix(in srgb, currentColor 45%, transparent) 64%, transparent 68%);
}
.sfin-resize-handle:hover, .sfin-resize-handle:focus-visible {
  background-color: color-mix(in srgb, currentColor 12%, transparent);
  outline: none;
}
/* Spending calendar. */
.sfin-cal { display: flex; flex-wrap: wrap; gap: 4px; }
.sfin-cal-day { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.sfin-cal-cell { width: 26px; height: 26px; border-radius: 5px; }
.sfin-cal-label { font-size: 9px; color: var(--muted-foreground); }
/* Pool pace gauge. */
.sfin-pace { position: relative; display: flex; flex-direction: column; gap: 6px; padding-right: 26px; }
.sfin-pace-row { display: flex; align-items: baseline; gap: 6px; }
.sfin-pace-val { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sfin-pace-dot { position: absolute; top: 2px; right: 2px; width: 12px; height: 12px; border-radius: 50%; }
.sfin-pace--green .sfin-pace-dot { background: #4ade80; box-shadow: 0 0 10px rgba(74, 222, 128, .5); }
.sfin-pace--amber .sfin-pace-dot { background: #fbbf24; box-shadow: 0 0 10px rgba(251, 191, 36, .5); }
.sfin-pace--red .sfin-pace-dot { background: #f87171; box-shadow: 0 0 10px rgba(248, 113, 113, .5); }
.sfin-uncat-undo { display: flex; align-items: center; gap: 8px; padding: 4px 0 8px; }
/* Same rules as .sfin-uncat-undo — a distinct class because the cap notice and
   "Categorize in Wealthfolio" button are an unrelated footer, not the undo
   banner, even though they happen to want identical layout. */
.sfin-uncat-foot { display: flex; align-items: center; gap: 8px; padding: 4px 0 8px; }

/* ── Setup wizard: spacing that used to be inline style props on every step
      of the first-run flow (SetupPage), now sourced from the one stylesheet
      instead of scattered style props. */
.sfin-setup-step h3 { margin: 0 0 8px; }
/* The one-line instruction directly under a step heading. */
.sfin-setup-step h3 + .sfin-subtle { margin-top: 0; }
.sfin-setup-step .sfin-input { width: 100%; margin-bottom: 12px; }
.sfin-setup-save-btn { margin-top: 16px; }
.sfin-setup-autosync { display: flex; align-items: center; gap: 8px; }
.sfin-setup-schedule { margin-top: 12px; }
.sfin-setup-schedule .sfin-select { margin-left: 8px; }
.sfin-setup-schedule .sfin-subtle { font-size: 12px; }
.sfin-setup-finish { margin-top: 16px; }
`;

/**
 * A status line's message and its tone, carried as DATA.
 *
 * The tone used to be inferred by sniffing a ✅/❌ prefix off the message text,
 * which quietly made those emoji load-bearing: dropping them from the copy would
 * have painted every error the neutral "busy" grey instead of destructive red —
 * a regression no emoji-grep test could see. The tone now travels with the
 * message, so the words and the colour are independent.
 */
export type StatusTone = 'ok' | 'error' | 'busy';
export interface StatusMessage {
  text: string;
  tone: StatusTone;
}

/** Tone → the class that colours it. Lives beside the CSS that defines them.
 *  `busy` is the in-flight tone: a send that has not finished is not a failure,
 *  so it is never painted destructive-red. */
export function statusToneClass(tone: StatusTone): string {
  if (tone === 'ok') return 'sfin-status--ok';
  if (tone === 'error') return 'sfin-status--err';
  return 'sfin-status--busy';
}

export const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 13l4 4L19 7" />
  </svg>
);
export const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8v5M12 16h.01" />
  </svg>
);

/** Injects the stylesheet once. Render at the addon root. */
export function ThemeStyles() {
  if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }
  return null;
}

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'destructive';

export function Button({
  variant = 'primary',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const variantClass = variant === 'primary' ? '' : ` sfin-btn--${variant}`;
  return <button type="button" className={`sfin-btn${variantClass}${className ? ` ${className}` : ''}`} {...props} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className="sfin-input" {...props} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="sfin-select" {...props} />;
}

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="sfin-card" style={style}>{children}</div>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="sfin-section-label">{children}</div>;
}

interface DisclosureProps {
  /** Unique on the page — used to id the panel for `aria-controls`. */
  id: string;
  title: React.ReactNode;
  /** State-bearing line under the title, shown open OR closed. This is the
   *  point of the pattern: a collapsed card still says what it is set to, so
   *  collapsing hides chrome rather than hiding state. */
  summary?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  variant?: 'card' | 'inline';
}

/**
 * The page's single collapse primitive.
 *
 * Deliberately a real <button> wrapping the entire header row: that gives the
 * whole row as a click target, focus and Enter/Space for free, and puts
 * `aria-expanded` on the focused element rather than on a decorative span.
 * The panel is unmounted when closed (not just hidden), so nothing inside a
 * collapsed card is tabbable or reachable by assistive tech — which also
 * means a test touching a collapsed control has to open the card first.
 */
export function Disclosure({
  id, title, summary, open, onToggle, children, variant = 'card',
}: DisclosureProps) {
  const panelId = `${id}-panel`;
  return (
    <>
      <button
        type="button"
        className={`sfin-disclosure sfin-disclosure--${variant}`}
        aria-expanded={open}
        // Only while the panel exists: aria-controls pointing at nothing is
        // worse than no aria-controls at all.
        {...(open ? { 'aria-controls': panelId } : {})}
        onClick={onToggle}
      >
        <span className="sfin-disclosure-text">
          <span className="sfin-section-label">{title}</span>
          {summary != null && <span className="sfin-disclosure-sum">{summary}</span>}
        </span>
        <span className="sfin-chevron" data-open={open} aria-hidden>▼</span>
      </button>
      {open && (
        <div id={panelId} className={`sfin-disclosure-body sfin-disclosure-body--${variant}`}>
          {children}
        </div>
      )}
    </>
  );
}

/** A `Card` whose entire header is the disclosure control. */
export function CollapsibleCard(props: Omit<DisclosureProps, 'variant'>) {
  return (
    <div className="sfin-card sfin-card--collapsible">
      <Disclosure {...props} variant="card" />
    </div>
  );
}

/**
 * The page's error surface.
 *
 * `detail` exists so a classified message can be kind WITHOUT discarding the
 * underlying text. A raw broker rejection ("error sending request for url
 * (https://…?start-date=…)") is the wrong headline — it exposes an internal URL
 * and gives the reader nothing to do — but it is exactly what a diagnosis needs,
 * so it goes in a collapsed, copyable line under the message instead of being
 * thrown away. Also mirrored onto `title`, so hovering the box surfaces it
 * without a click.
 *
 * Native `<details>` rather than the page's `Disclosure`: this needs no state,
 * no id, and nothing to persist, and an error box that required a `useState` to
 * render would be a worse trade than the browser's own default styling.
 */
export function ErrorBox({ children, detail }: { children: React.ReactNode; detail?: string }) {
  return (
    <div className="sfin-error" {...(detail ? { title: detail } : {})}>
      {children}
      {detail && (
        <details style={{ marginTop: 6 }}>
          <summary className="sfin-subtle" style={{ cursor: 'pointer' }}>Technical details</summary>
          <div className="sfin-subtle" style={{ marginTop: 4, wordBreak: 'break-all' }}>{detail}</div>
        </details>
      )}
    </div>
  );
}
