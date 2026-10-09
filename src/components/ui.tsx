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
:root {
  /* The whole visual system (v1.57, "Soft"): one type scale, three radii, one
     surface lift, three tones. On :root rather than .sfin-page so floating
     overlays (the drag ghost, the emoji picker) resolve them too. Prefixed,
     because the sandbox mirrors the host's own custom properties. */
  --sfin-sz-2xs: 10px; --sfin-sz-xs: 11px; --sfin-sz-sm: 12px; --sfin-sz-base: 13px;
  --sfin-sz-md: 15px; --sfin-sz-lg: 18px; --sfin-sz-xl: 20px;
  --sfin-rad: 14px; --sfin-rad-sm: 8px; --sfin-rad-xs: 5px;
  --sfin-line: color-mix(in srgb, var(--border) 70%, transparent);
  --sfin-lift: 0 1px 2px color-mix(in srgb, #000 6%, transparent), 0 4px 14px color-mix(in srgb, #000 4%, transparent);
  /* Tones from Wealthfolio's own theme: amber means "check this", red is kept
     for real errors, green for confirmed-good. */
  --sfin-ok: var(--success, #5e9483);
  --sfin-warn: var(--warning, #b7791f);
  --sfin-bad: var(--destructive);
}
.sfin-page {
  /* Palette custom properties: sage defaults; pickers override per grid/cell. */
  --sfin-s0: #5e9483; --sfin-s1: #3e6f63; --sfin-s2: #c9a86b; --sfin-s3: #c17a63;
  --sfin-s4: #7189a8; --sfin-s5: #8aa864; --sfin-s6: #9a7aa0; --sfin-s7: #6b7f8f;
  max-width: 680px;
  margin: 0 auto;
  padding: 24px;
  color: var(--foreground);
  font-size: var(--sfin-sz-base);
}
.sfin-title {
  font-size: var(--sfin-sz-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}
.sfin-subtle { color: var(--muted-foreground); font-size: var(--sfin-sz-base); }
.sfin-card {
  background: var(--card, var(--background));
  border: 1px solid var(--sfin-line);
  border-radius: var(--sfin-rad); padding: 14px 16px; margin-bottom: 10px;
  box-shadow: var(--sfin-lift);
}
.sfin-section-label {
  display: block;
  font-size: var(--sfin-sz-sm);
  font-weight: 500;
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
  font-size: var(--sfin-sz-base);
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
  font-size: var(--sfin-sz-base);
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}
.sfin-input:focus, .sfin-select:focus { border-color: var(--ring, var(--primary)); }
.sfin-input::placeholder { color: var(--muted-foreground); }
.sfin-error {
  background: color-mix(in srgb, var(--sfin-bad) 8%, var(--card, var(--background)));
  color: var(--sfin-bad);
  border: 1px solid color-mix(in srgb, var(--sfin-bad) 30%, transparent);
  border-radius: var(--sfin-rad);
  padding: 10px 12px;
  font-size: var(--sfin-sz-base);
  margin: 12px 0;
}
.sfin-callout {
  background: color-mix(in srgb, var(--muted) 45%, transparent);
  color: var(--foreground);
  border: 1px solid var(--sfin-line);
  border-radius: var(--sfin-rad);
  padding: 10px 12px;
  font-size: var(--sfin-sz-base);
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
  font-size: var(--sfin-sz-sm);
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
  font-size: var(--sfin-sz-sm);
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
.sfin-foot { margin-top: 20px; font-size: var(--sfin-sz-xs); }
.sfin-foot-warn { margin-left: 6px; opacity: 0.9; }
.sfin-live { color: var(--primary); }
/* Columns come from the tiles that are actually rendered, never from a fixed
   count. Home shows one to three tiles — "Needs a category" only exists once
   the companion has published one — and a repeat(3, 1fr) template left the
   two-tile case filling 2/3 of the width beside a phantom empty column. Column
   auto-flow with no template gives one equal column per child, so it fits
   either case (and any future tile) without a modifier class or inline style. */
.sfin-strip {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 0; margin: 16px 0 10px; overflow: hidden;
  background: var(--card, var(--background));
  border: 1px solid var(--sfin-line); border-radius: var(--sfin-rad);
  box-shadow: var(--sfin-lift);
}
/* Inside the strip a tile is a section divided by a hairline, not a card of
   its own. The Budget headline card styles its tiles separately below. */
.sfin-tile {
  flex: 1; padding: 12px 16px; background: transparent;
  border: 0; border-left: 1px solid var(--sfin-line); border-radius: 0;
}
.sfin-strip > .sfin-tile:first-child { border-left: 0; }
.sfin-tile .sfin-section-label { margin-bottom: 3px; }
.sfin-tile-val {
  font-size: var(--sfin-sz-xl); font-weight: 600; letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.sfin-tile-sub { font-size: var(--sfin-sz-2xs); color: var(--muted-foreground); margin-top: 2px; }
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
  width: 28px; height: 28px; flex: none; border-radius: 50%;
  background: var(--muted); color: var(--muted-foreground);
  display: grid; place-items: center;
  font-weight: 600; font-size: var(--sfin-sz-2xs); text-transform: uppercase;
}
.sfin-acct-name {
  font-weight: 500; font-size: var(--sfin-sz-base);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sfin-acct-map { color: var(--muted-foreground); font-size: var(--sfin-sz-sm); }
.sfin-acct-right { text-align: right; flex: none; }
.sfin-bal {
  font-size: var(--sfin-sz-md); font-weight: 600; letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.sfin-chip {
  display: inline-flex; align-items: center; gap: 5px; margin-top: 5px;
  font-size: var(--sfin-sz-xs); font-weight: 500; padding: 2px 8px; border-radius: 999px;
  background: color-mix(in srgb, var(--primary) 15%, transparent); color: var(--primary);
}
.sfin-chip--warn {
  background: color-mix(in srgb, var(--destructive) 12%, transparent); color: var(--destructive);
}
.sfin-chip--off {
  background: color-mix(in srgb, var(--destructive) 14%, transparent);
  color: var(--destructive);
}
/* Deliberately NEITHER green nor red: "not checked" is an absence of information,
   and colouring it either way would state something. Plain muted text, no
   pill, so it reads as quieter than both siblings rather than as a third alarm. */
.sfin-chip--muted {
  background: transparent; padding: 0;
  color: var(--muted-foreground);
}
.sfin-chip svg { width: 11px; height: 11px; }
/* Tabs: a segmented control — the selected tab is a raised pill on a muted
   track. Sub-tabs and the Budget range chips use the same shape, so "which
   one is selected" looks the same everywhere. */
.sfin-tabbar {
  display: flex; width: fit-content; max-width: 100%; overflow-x: auto;
  gap: 2px; padding: 3px; margin: 14px 0 16px;
  border-radius: 999px; background: var(--muted);
}
.sfin-tab {
  border: none; background: transparent; color: var(--muted-foreground);
  font-size: var(--sfin-sz-base); font-weight: 500; padding: 6px 14px; border-radius: 999px;
  cursor: pointer; white-space: nowrap;
}
.sfin-tab:hover { color: var(--foreground); }
.sfin-tab--active {
  background: var(--card, var(--background)); color: var(--foreground);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 10%, transparent);
}
.sfin-subtabs {
  display: flex; width: fit-content; gap: 2px; padding: 3px; margin: 0 0 12px;
  border-radius: 999px; background: var(--muted);
}
.sfin-subtab {
  border: none; background: transparent; color: var(--muted-foreground);
  font-size: var(--sfin-sz-sm); font-weight: 500; padding: 4px 12px; border-radius: 999px; cursor: pointer;
}
.sfin-subtab--active {
  background: var(--card, var(--background)); color: var(--foreground);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 10%, transparent);
}
.sfin-report-live { margin-bottom: 16px; }
.sfin-report-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.sfin-report-past { margin-top: 8px; }
.sfin-report-past > summary { cursor: pointer; font-weight: 500; }
.sfin-report-text { font-size: var(--sfin-sz-base); line-height: 1.5; }
.sfin-report-gap { height: 8px; }
.sfin-budget-empty {
  border: 1px dashed var(--sfin-line); border-radius: var(--sfin-rad);
  padding: 28px 20px; text-align: center; color: hsl(var(--muted-foreground));
  display: flex; flex-direction: column; align-items: center; gap: 12px;
}
.sfin-budget-empty p { margin: 0; max-width: 46ch; font-size: var(--sfin-sz-md); }
.sfin-banner-warn {
  display: flex; gap: 10px; align-items: flex-start;
  background: color-mix(in srgb, var(--sfin-warn) 8%, var(--card, var(--background)));
  border: 1px solid color-mix(in srgb, var(--sfin-warn) 30%, transparent);
  border-radius: var(--sfin-rad);
  padding: 12px 14px; font-size: var(--sfin-sz-base); line-height: 1.5; margin-top: 16px;
}
.sfin-banner-warn b { color: var(--foreground); font-weight: 600; }
/* The calm sibling: a drift the sync expects to resolve itself (the bank's
   balance ahead of its own feed). Deliberately NOT destructive-tinted — red is
   what goaded users into plugging feed lag. */
.sfin-banner-wait {
  display: flex; gap: 10px; align-items: flex-start;
  background: color-mix(in srgb, var(--muted) 45%, transparent);
  border: 1px solid var(--sfin-line);
  border-radius: var(--sfin-rad);
  padding: 12px 14px; font-size: var(--sfin-sz-base); line-height: 1.5; margin-top: 16px;
}
.sfin-banner-wait b { color: var(--foreground); font-weight: 600; }
/* Shared innards of both banners, previously repeated as inline styles on every
   one of them. Same values, so the banners look exactly as they did. */
.sfin-banner-body { flex: 1; min-width: 0; }
.sfin-banner-note { margin-top: 4px; opacity: 0.85; }
.sfin-why { margin-top: 4px; }
.sfin-why > summary {
  display: inline; cursor: pointer; list-style: none;
  font-size: var(--sfin-sz-sm); color: var(--muted-foreground);
  text-decoration: underline; text-underline-offset: 3px;
}
.sfin-why > summary::-webkit-details-marker { display: none; }
.sfin-why-body { margin-top: 4px; font-size: var(--sfin-sz-sm); color: var(--muted-foreground); }
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
/* Stacked label/input rows directly in a card (the pool card): spaced apart,
   and kept off the description above them. */
.sfin-card > .sfin-field-row { margin-top: 10px; }
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
.sfin-check-name { font-weight: 500; }
.sfin-divider { border-top: 1px solid var(--border); margin: 14px 0 12px; }
/* Name + Daily + Weekly + Monthly. */
.sfin-cats {
  display: grid; grid-template-columns: 1fr auto auto auto;
  align-items: center; row-gap: 5px; column-gap: 12px;
  font-size: var(--sfin-sz-base); line-height: 1.55;
}
.sfin-cats-col {
  width: 46px; text-align: center;
  font-size: var(--sfin-sz-2xs); font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted-foreground);
}
.sfin-cats input[type='checkbox'] { justify-self: center; margin: 0; }
/* Heading row: one shared pad so the column captions and the section label sit
   on the same baseline and the first category row isn't jammed under them. */
.sfin-cats-head { margin-bottom: 0; padding-bottom: 4px; }
.sfin-cats-hint { font-size: var(--sfin-sz-sm); margin-bottom: 8px; }
.sfin-cat-name {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  font-size: var(--sfin-sz-base); font-weight: 500;
}
/* The category itself, distinguished from the emoji override beside it. */
.sfin-cat-label { font-weight: 600; }
.sfin-cat-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ── Emoji picker: a curated palette, because the input it replaces assumed the
      user knows how to type an emoji on their platform. ───────────────────── */
.sfin-glyph-btn {
  width: 26px; height: 22px; padding: 0; font-size: var(--sfin-sz-base); line-height: 1;
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
  font-size: var(--sfin-sz-2xs); font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted-foreground); margin: 6px 0 3px;
}
.sfin-glyph-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; }
.sfin-glyph-cell {
  height: 24px; padding: 0; font-size: var(--sfin-sz-md); line-height: 1; cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: var(--sfin-rad-xs);
}
.sfin-glyph-cell:hover { background: var(--muted); }
.sfin-glyph-cell--on { border-color: var(--primary); background: var(--muted); }
.sfin-glyph-clear {
  width: 100%; padding: 4px 6px; font-size: var(--sfin-sz-xs); cursor: pointer;
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
.sfin-disclosure:hover { background: color-mix(in srgb, var(--muted) 50%, transparent); }
.sfin-disclosure:focus-visible { outline: 2px solid var(--ring, var(--primary)); outline-offset: -2px; }
.sfin-disclosure--card { padding: 13px 16px; }
.sfin-disclosure--inline { padding: 9px 11px; }
.sfin-disclosure-text { min-width: 0; }
.sfin-disclosure-text .sfin-section-label { margin-bottom: 0; }
/* The summary line: what makes collapsing safe rather than hiding state. */
.sfin-disclosure-sum {
  display: block; margin-top: 3px; font-size: var(--sfin-sz-sm); line-height: 1.4;
  color: var(--muted-foreground);
}
.sfin-chevron {
  flex: none; font-size: var(--sfin-sz-2xs); line-height: 1; color: var(--muted-foreground);
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
  background: color-mix(in srgb, var(--muted) 45%, transparent); color: var(--foreground);
  border: 1px solid var(--sfin-line);
  border-radius: var(--sfin-rad-sm);
  overflow: hidden; font-size: var(--sfin-sz-base); line-height: 1.55;
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
.sfin-num-hint { font-size: var(--sfin-sz-sm); margin: 1px 0 12px 22px; line-height: 1.45; }
.sfin-nums .sfin-num-hint:last-child { margin-bottom: 0; }
.sfin-status { font-size: var(--sfin-sz-sm); }
.sfin-status--ok { color: var(--success, var(--primary)); }
.sfin-status--err { color: var(--destructive); }
.sfin-status--busy { color: var(--muted-foreground); }

/* ── Dashboard treatment additions: floating account rows, sticky save bar,
      destructive-boundary card. New selectors — consumed by later tasks. ──── */
/* The accounts are ONE list inside Settings → Accounts, each account a row
   divided by a hairline (they used to be a stack of separately shadowed
   cards). The row still carries .sfin-card, so these declarations come later
   in the sheet and win at equal specificity. */
.sfin-acct-card {
  display: flex; justify-content: space-between; align-items: center; gap: 16px;
  border: 0; border-top: 1px solid var(--sfin-line); border-radius: 0;
  box-shadow: none; background: transparent; margin: 0; padding: 11px 0;
}
.sfin-accts-asof { font-size: var(--sfin-sz-xs); }
/* The "balances as of" line above the rows. */
.sfin-accts--bare > .sfin-accts-asof { margin-bottom: 4px; }
/* Only a row whose Wealthfolio account still exists is clickable, so only that
   row advertises it. */
.sfin-acct-card--link { cursor: pointer; transition: background 0.12s; }
.sfin-acct-card--link:hover .sfin-acct-name { text-decoration: underline; text-underline-offset: 3px; }
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
.sfin-applies-now { font-size: var(--sfin-sz-sm); margin-top: 6px; }
/* Sticky save bar (Settings → Notifications). */
.sfin-savebar {
  position: sticky; bottom: 8px; display: flex; justify-content: space-between;
  align-items: center; gap: 12px; padding: 10px 16px; border-radius: 999px;
  background: var(--card, var(--background));
  border: 1px solid var(--border, color-mix(in srgb, var(--muted-foreground) 30%, transparent));
  box-shadow: 0 4px 16px color-mix(in srgb, #000 16%, transparent);
}
/* The message half of the bar: "You have unsaved changes", plus the reason Save
   is unavailable when it is. Stacked, because the second line explains the
   first. It is also the live region, and stays mounted (empty) when the bar is
   not showing — a role="status" only announces changes made after it exists. */
.sfin-savebar-msg { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
/* Destructive-boundary card for Reset. */
.sfin-danger-card {
  border: 1px solid color-mix(in srgb, var(--destructive) 40%, transparent);
  border-radius: var(--sfin-rad); padding: 14px 16px; margin-top: 18px;
}
.sfin-danger-note { margin-top: 4px; }
.sfin-danger-actions { margin-top: 10px; display: flex; gap: 8px; }

/* Settings (was the Advanced tab): spacing that used to be an inline style prop on SyncPage,
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
/* Settings: plain group headings over the collapsible cards. Not collapsible
   themselves: they only say which cards belong together. */
.sfin-settings-group {
  font-size: var(--sfin-sz-sm); font-weight: 600; color: var(--muted-foreground);
  margin: 22px 0 8px;
}
.sfin-settings-group:first-child { margin-top: 4px; }

/* ── "Finish setting up" checklist: first-run guidance without a wizard ─── */
.sfin-checklist-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.sfin-checklist-x { border: none; background: transparent; color: var(--muted-foreground); font-size: var(--sfin-sz-md); cursor: pointer; }
.sfin-checklist-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
.sfin-checklist-dot {
  width: 16px; height: 16px; border-radius: 50%; flex: none;
  border: 1.5px solid var(--muted-foreground); display: inline-flex;
  align-items: center; justify-content: center;
}
.sfin-checklist-dot--done { border-color: var(--sfin-ok); color: var(--sfin-ok); }
.sfin-checklist-dot svg { width: 10px; height: 10px; }
.sfin-checklist-label { flex: 1; font-size: var(--sfin-sz-base); }
.sfin-checklist-link { border: none; background: transparent; color: var(--foreground); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; font-size: var(--sfin-sz-sm); }

/* ── "Needs a category" list: the transactions behind the Home tile ──── */
.sfin-uncat-row {
  display: flex; align-items: center; gap: 10px; padding: 5px 0;
  border-top: 1px solid color-mix(in srgb, var(--muted-foreground) 14%, transparent);
}
.sfin-uncat-row:first-of-type { border-top: none; }
.sfin-uncat-when { flex: none; font-size: var(--sfin-sz-xs); color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.sfin-uncat-what { flex: 1; min-width: 0; font-size: var(--sfin-sz-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfin-uncat-amt { flex: none; font-size: var(--sfin-sz-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
.sfin-amt--in { color: var(--sfin-ok); }
.sfin-amt--out { color: var(--sfin-bad); }

/* ── Budget (on Home) ─────────────────────────────────────────────────────────── */
.sfin-page--wide { max-width: 1280px; }
.sfin-budget-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.sfin-budget-toolbar .sfin-range-chips { margin: 0; }
.sfin-budget-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-auto-rows: 29px; gap: 14px; margin-top: 14px; }
.sfin-cell { min-width: 0; }
.sfin-cell[role="button"] { cursor: pointer; outline: none; border-radius: var(--sfin-rad); }
/* Spans ride CSS custom properties set per cell (--sfin-c/--sfin-r), so the
   phone rules below can flatten EVERYTHING to one column — an inline
   grid-column would outrank them and break small screens. */
/* v1.41: explicit 2-D placement — no dense backfill, so a drop cannot
   repack unrelated cards. Coordinates come from shared/grid-engine.ts. */
.sfin-budget-grid > .sfin-cell {
  grid-column: calc(var(--sfin-x, 0) + 1) / span var(--sfin-c, 1);
  grid-row: calc(var(--sfin-y, 0) + 1) / span var(--sfin-r, 2);
}
@media (max-width: 720px) {
  .sfin-budget-grid { grid-template-columns: 1fr; }
  /* Full width, auto-stacked in reading order (DOM order is sorted by the
     board's y,x), height kept from --sfin-r: a "super thin" desktop card is
     a normal full-width card on a phone. */
  .sfin-budget-grid > .sfin-cell { grid-column: 1; grid-row: auto / span var(--sfin-r, 2); }
  .sfin-page { padding: 14px; }
}
.sfin-budget-grid .sfin-cell, .sfin-drag-ghost { position: relative; overflow: hidden; }
.sfin-budget-grid .sfin-report-body .sfin-chart, .sfin-drag-ghost .sfin-report-body .sfin-chart { min-height: 0; }
.sfin-budget-grid .sfin-report-card, .sfin-drag-ghost .sfin-report-card { overflow: hidden; }
.sfin-cell--editing .sfin-report-card { border-style: dashed; }
.sfin-card-tools {
  position: absolute; top: 6px; right: 6px; z-index: 2;
  display: flex; gap: 2px; flex-wrap: wrap; justify-content: flex-end;
  padding: 2px; border-radius: var(--sfin-rad-sm);
  background: color-mix(in srgb, currentColor 8%, transparent);
  backdrop-filter: blur(6px);
  font-size: var(--sfin-sz-xs);
}
.sfin-card-tools button { padding: 2px 9px; font-size: var(--sfin-sz-sm); }
/* The ⋯ menu a card opens in customize mode (1.57). */
.sfin-card-menu {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 4; min-width: 170px;
  display: flex; flex-direction: column; padding: 4px;
  background: var(--card, var(--background)); color: var(--foreground);
  border: 1px solid var(--sfin-line); border-radius: var(--sfin-rad-sm);
  box-shadow: 0 6px 20px color-mix(in srgb, #000 16%, transparent);
}
.sfin-card-tools .sfin-card-menu button {
  justify-content: flex-start; width: 100%; padding: 6px 10px;
  border-radius: var(--sfin-rad-xs); color: var(--foreground);
}
/* "+ Add report": the hidden reports, and the way into the builder. */
.sfin-add-report { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.sfin-add-report-list { display: flex; flex-wrap: wrap; gap: 6px; }
.sfin-report-card {
  position: relative;
  height: 100%; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box;
  transition: border-color .15s ease;
}
.sfin-cell[role="button"]:hover .sfin-report-card,
.sfin-cell[role="button"]:focus-visible .sfin-report-card {
  border-color: color-mix(in srgb, var(--foreground) 22%, transparent);
}
.sfin-report-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sfin-report-body .sfin-chart { flex: 1; min-height: 170px; }
.sfin-report-body--hero .sfin-chart { min-height: 260px; }
.sfin-range-chips {
  display: flex; width: fit-content; max-width: 100%; flex-wrap: wrap;
  gap: 2px; padding: 3px; margin: 10px 0; border-radius: 999px; background: var(--muted);
}
.sfin-range-chips .sfin-btn {
  background: transparent; color: var(--muted-foreground); border-color: transparent;
  padding: 4px 11px; font-size: var(--sfin-sz-sm);
}
.sfin-range-chips .sfin-btn[aria-pressed='true'] {
  background: var(--card, var(--background)); color: var(--foreground);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 10%, transparent);
}
.sfin-new-report-card {
  grid-column: 1 / span 4; grid-row: auto / span 4;
  border: 1.5px dashed color-mix(in srgb, currentColor 25%, transparent);
  background: transparent; border-radius: var(--sfin-rad); min-height: 110px;
  display: flex; align-items: center; justify-content: center;
  font: inherit; font-size: var(--sfin-sz-base); color: inherit; opacity: .7; cursor: pointer;
  transition: opacity .15s ease, border-color .15s ease;
}
.sfin-new-report-card:hover { opacity: 1; border-color: color-mix(in srgb, currentColor 45%, transparent); }
.sfin-merchant-table, .sfin-custom-table { width: 100%; border-collapse: collapse; font-size: var(--sfin-sz-sm); }
.sfin-merchant-table th, .sfin-custom-table th {
  text-align: right; font-size: var(--sfin-sz-2xs); text-transform: uppercase; letter-spacing: .06em;
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
.sfin-heat-cell { height: 26px; border-radius: var(--sfin-rad-xs); }
/* ── Auto-density: content conforms to the box it is given ──────────────────
   Each grid cell is a size container; short cells shrink their type and fade
   out at the bottom edge, so nothing ever looks torn off mid-row. The
   list-reports also budget their ROW COUNT from the card's span (see
   ReportView's density prop) — this is the typographic half. */
.sfin-budget-grid .sfin-cell, .sfin-drag-ghost { container-type: size; }
.sfin-budget-grid .sfin-report-body, .sfin-drag-ghost .sfin-report-body {
  overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 88%, transparent);
  mask-image: linear-gradient(#000 88%, transparent);
}
@container (max-height: 200px) {
  .sfin-report-card { font-size: var(--sfin-sz-sm); padding: 10px 12px; }
  .sfin-report-card .sfin-section-label { font-size: var(--sfin-sz-2xs); margin-bottom: 4px; }
  .sfin-report-card .sfin-merchant-table,
  .sfin-report-card .sfin-custom-table { font-size: var(--sfin-sz-xs); }
  .sfin-report-card .sfin-heat-cell { height: 16px; }
}
@container (max-height: 360px) {
  .sfin-report-card { font-size: var(--sfin-sz-sm); }
}
/* The corner drag handle, customize mode only. */
.sfin-resize-handle {
  position: absolute; right: 3px; bottom: 3px; z-index: 3;
  width: 22px; height: 22px; border-radius: var(--sfin-rad-xs);
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
.sfin-cal-cell { width: 26px; height: 26px; border-radius: var(--sfin-rad-xs); }
.sfin-cal-label { font-size: var(--sfin-sz-2xs); color: var(--muted-foreground); }
/* Pool pace gauge. */
.sfin-pace { position: relative; display: flex; flex-direction: column; gap: 6px; padding-right: 26px; }
.sfin-pace-row { display: flex; align-items: baseline; gap: 6px; }
.sfin-pace-val { font-size: var(--sfin-sz-xl); font-weight: 600; font-variant-numeric: tabular-nums; }
.sfin-pace-dot { position: absolute; top: 2px; right: 2px; width: 12px; height: 12px; border-radius: 50%; }
.sfin-pace--green .sfin-pace-dot { background: var(--sfin-ok); }
.sfin-pace--amber .sfin-pace-dot { background: var(--sfin-warn); }
.sfin-pace--red .sfin-pace-dot { background: var(--sfin-bad); }
/* The headline-numbers card: the old fixed strip, now a card like the rest. */
.sfin-headline { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 10px; align-items: stretch; height: 100%; }
.sfin-headline .sfin-tile {
  display: flex; flex-direction: column; justify-content: center;
  border: 1px solid var(--sfin-line); border-radius: var(--sfin-rad-sm);
  background: color-mix(in srgb, var(--muted) 30%, transparent);
}
@container (max-width: 460px) { .sfin-headline { grid-auto-flow: row; } }
/* Toolbar right side: reset + customize. */
.sfin-toolbar-actions { display: flex; gap: 6px; align-items: center; }
/* The hide-undo toast: present, quiet, gone in a few seconds. */
.sfin-toast { display: flex; align-items: center; gap: 8px; margin: 6px 0 10px; padding: 6px 12px; border-radius: var(--sfin-rad-sm); background: var(--card); border: 1px solid var(--sfin-line); box-shadow: var(--sfin-lift); font-size: var(--sfin-sz-base); }
/* Pool editing on the burn-down's full screen. */
.sfin-pool-edit { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.sfin-pool-edit .sfin-input { max-width: 130px; }
/* Data-check card. Its own prefix: this block once reused .sfin-check,
   the checkbox-row label class, and — defined later in the sheet — turned
   every checkbox label in the app into a column (v1.34–v1.47). */
.sfin-datacheck { display: flex; flex-direction: column; gap: 8px; font-size: var(--sfin-sz-base); }
.sfin-datacheck-verdict { font-weight: 600; }
.sfin-datacheck--ok .sfin-datacheck-verdict { color: var(--sfin-ok); }
.sfin-datacheck--diverges .sfin-datacheck-verdict { color: var(--sfin-warn); }
.sfin-datacheck-row { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.sfin-datacheck-nums { color: var(--muted-foreground); }
/* Drill-down (category → its transactions). */
.sfin-linkish { border: none; background: transparent; padding: 0; color: inherit; font: inherit; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.sfin-linkish:hover { color: var(--sfin-s0, #5e9483); }
.sfin-drill-head { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--sfin-sz-base); color: var(--muted-foreground); margin-bottom: 6px; }
.sfin-drill-total { font-weight: 600; color: var(--foreground); font-variant-numeric: tabular-nums; }
.sfin-drill-date { white-space: nowrap; color: var(--muted-foreground); }
.sfin-refund { color: var(--sfin-ok); }
/* Subscriptions card. */
.sfin-subs { display: flex; flex-direction: column; gap: 6px; font-size: var(--sfin-sz-base); }
.sfin-subs-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfin-subs-price { white-space: nowrap; font-variant-numeric: tabular-nums; }
.sfin-subs-creep { color: var(--sfin-warn); font-weight: 600; }
.sfin-subs-total { margin-top: 4px; padding-top: 6px; border-top: 1px solid var(--border); font-weight: 600; }
.sfin-subs-maybe-head { margin-top: 6px; font-size: var(--sfin-sz-xs); letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); }
.sfin-subs-maybe-head ~ .sfin-subs-row { opacity: .75; }
.sfin-subs-row--muted { opacity: .75; }
.sfin-subs-answer { border: none; background: transparent; color: var(--foreground); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; font-size: var(--sfin-sz-sm); white-space: nowrap; }
/* Rows as strict columns: name | price | actions — flex space-between let the
   price drift toward the middle whenever a row had a different button count. */
.sfin-subs-row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(3.5em, auto); align-items: center; gap: 10px; padding: 3px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.sfin-subs-row .sfin-subs-price { text-align: right; }
.sfin-subs-row > button { justify-self: end; }
.sfin-subs-row > button + button { margin-left: 6px; }
.sfin-subs-row:has(> button + button) { grid-template-columns: minmax(0, 1fr) auto auto auto; }
/* Overlaid top-right INSIDE the card: below the chart it sat in the body's
   overflow/fade cage and got clipped (live, 2026-09-02). The burn-down's
   top-right corner is empty by construction — the line starts high-left. */
.sfin-pool-legend { position: absolute; top: 10px; right: 14px; display: flex; gap: 14px; font-size: var(--sfin-sz-xs); color: var(--muted-foreground); }
.sfin-pool-legend-actual { color: var(--sfin-s0, #5e9483); font-weight: 600; }
/* Palette custom properties: sage defaults; pickers override per grid/cell. */
.sfin-swatches { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.sfin-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.sfin-swatch--on { border-color: var(--foreground); }
/* Headline picker + BvA scale tiers + subscription polish. */
.sfin-headline-picker { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; align-items: center; }
.sfin-pick { border: 1px solid var(--border); background: transparent; color: var(--muted-foreground); border-radius: 999px; padding: 4px 10px; font-size: var(--sfin-sz-sm); cursor: pointer; }
.sfin-pick--on { background: var(--muted); color: var(--foreground); border-color: color-mix(in srgb, var(--foreground) 35%, transparent); }
[data-bva-scale='compact'] [data-bva] { margin-bottom: 4px !important; font-size: var(--sfin-sz-sm); }
[data-bva-scale='compact'] [data-bva] > div:last-child { height: 6px !important; }
[data-bva-scale='tiny'] [data-bva] { margin-bottom: 2px !important; font-size: var(--sfin-sz-2xs); }
[data-bva-scale='tiny'] [data-bva] > div:last-child { height: 4px !important; }
.sfin-subs-row:hover { background: color-mix(in srgb, var(--sfin-s0) 6%, transparent); }
.sfin-subs-dismiss { border: none; background: transparent; color: var(--muted-foreground); cursor: pointer; border-radius: var(--sfin-rad-xs); }
.sfin-subs-dismiss:hover { color: var(--sfin-bad); background: color-mix(in srgb, var(--sfin-bad) 10%, transparent); }
.sfin-subs-celebrate { margin-top: 6px; padding: 8px 12px; border-radius: var(--sfin-rad-sm); font-size: var(--sfin-sz-base); background: color-mix(in srgb, var(--sfin-ok) 10%, transparent); border: 1px solid color-mix(in srgb, var(--sfin-ok) 35%, transparent); animation: sfin-pop .35s cubic-bezier(.2, 1.4, .4, 1); }
@keyframes sfin-pop { from { transform: scale(.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.sfin-range-pin { position: absolute; bottom: 6px; right: 10px; font-size: var(--sfin-sz-2xs); color: var(--muted-foreground); background: color-mix(in srgb, var(--card) 80%, transparent); border-radius: var(--sfin-rad-xs); padding: 1px 6px; }
/* Drag feedback: the picked-up card lifts and fades while every other card
   GLIDES to make room (the FLIP effect in BudgetTab animates their rects). */
.sfin-cell--editing { cursor: grab; touch-action: none; }
/* The picked-up card's grid cell is the SLOT: a dashed landing zone that
   reorders live under the cursor, while the card itself floats as the ghost. */
.sfin-cell--dragging { z-index: 1; }
.sfin-cell--dragging .sfin-report-card {
  opacity: 0;
}
.sfin-cell--dragging::after {
  content: ''; position: absolute; inset: 0; border-radius: var(--sfin-rad);
  border: 2px dashed color-mix(in srgb, var(--foreground) 30%, transparent);
  background: color-mix(in srgb, var(--muted) 50%, transparent);
}
.sfin-drag-ghost {
  position: fixed; z-index: 60; pointer-events: none;
  opacity: .92; will-change: transform;
  border-radius: var(--sfin-rad);
  filter: drop-shadow(0 18px 36px rgba(0, 0, 0, .35));
}
.sfin-drag-ghost .sfin-report-card { height: 100%; }
.sfin-cell--resizing .sfin-report-card {
  outline: 1.5px dashed color-mix(in srgb, var(--foreground) 35%, transparent);
  outline-offset: -1.5px; opacity: .82;
  transition: opacity .12s ease;
}
/* The new-report button spans a readable width on the fine grid. */
@media (max-width: 720px) { .sfin-new-report-card { grid-column: 1; } }
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

/**
 * The rest of an explanation, one tap away (1.57). A banner says what is
 * happening and what to do in one sentence; the reasoning behind it lives
 * here, kept rather than cut, for whoever wants it. A native <details>, so it
 * needs no state and works with the keyboard as it is.
 */
export function Why({ children }: { children: React.ReactNode }) {
  return (
    <details className="sfin-why">
      <summary>Why?</summary>
      <div className="sfin-why-body">{children}</div>
    </details>
  );
}

/** A `Card` whose entire header is the disclosure control. */
export function CollapsibleCard(props: Omit<DisclosureProps, 'variant'>) {
  return (
    // `data-card-id`: what a link that opens this card scrolls to.
    <div className="sfin-card sfin-card--collapsible" data-card-id={props.id}>
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
