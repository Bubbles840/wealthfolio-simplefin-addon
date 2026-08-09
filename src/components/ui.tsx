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
`;

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
