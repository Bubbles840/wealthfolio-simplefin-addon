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
.sfin-list { margin: 8px 0 0; padding: 0; list-style: none; }
.sfin-list li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.sfin-list li:last-child { border-bottom: none; }
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
  gap: 16px; margin-bottom: 20px;
}
.sfin-live { color: var(--primary); }
.sfin-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.sfin-tile {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px 16px;
}
.sfin-tile-val {
  font-size: 22px; font-weight: 650; letter-spacing: -0.02em; margin-top: 5px;
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

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="sfin-error">{children}</div>;
}
