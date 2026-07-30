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
  background: var(--card);
  color: var(--card-foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-top: 16px;
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
  border-radius: calc(var(--radius) - 2px);
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
.sfin-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.sfin-tile {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 11px 14px;
}
.sfin-tile .sfin-section-label { margin-bottom: 3px; }
.sfin-tile-val {
  font-size: 20px; font-weight: 650; letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.sfin-card-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-bottom: 2px;
}
.sfin-acct {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 12px 0; border-top: 1px solid var(--border);
}
.sfin-acct--link {
  cursor: pointer; margin: 0 -10px; padding-left: 10px; padding-right: 10px;
  border-radius: 10px; transition: background 0.12s;
}
.sfin-acct--link:hover { background: var(--muted); }
.sfin-acct--link:focus-visible { outline: 2px solid var(--ring, var(--primary)); outline-offset: -2px; }
.sfin-acct-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
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
.sfin-chip svg { width: 11px; height: 11px; }
.sfin-banner-warn {
  display: flex; gap: 10px; align-items: flex-start;
  background: color-mix(in srgb, var(--destructive) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--destructive) 32%, transparent);
  border-radius: calc(var(--radius) - 2px);
  padding: 12px 14px; font-size: 13px; line-height: 1.5; margin-top: 16px;
}
.sfin-banner-warn b { color: var(--foreground); font-weight: 600; }

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
.sfin-cat-name {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  font-size: 13px; font-weight: 500;
}
.sfin-cat-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
`;

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
