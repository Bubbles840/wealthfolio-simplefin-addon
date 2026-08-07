import React, { useEffect, useRef, useState } from 'react';

/**
 * A curated palette rather than an emoji keyboard.
 *
 * The control this replaces was a text input, which assumed the user knows how to
 * type an emoji on their platform — most people don't, and on a desktop it means
 * hunting through a system picker. A short, relevant list is both easier and
 * better: these are budget-category glyphs, so ~60 well-chosen options cover the
 * need where thousands would bury it.
 *
 * Deliberately not an emoji-picker dependency: the addon runs inside a sandboxed
 * iframe under a strict CSP, and a curated array costs nothing to ship or audit.
 */
const PALETTE: Array<{ label: string; glyphs: string[] }> = [
  { label: 'Home & bills', glyphs: ['🏠', '🏡', '🔑', '💡', '🔌', '💧', '🔥', '📄', '📬', '🛠️', '🧹', '📶', '📱', '💻', '📺'] },
  { label: 'Food', glyphs: ['🍽️', '🛒', '🥕', '🍎', '🍞', '☕', '🍕', '🍔', '🌮', '🍣', '🍺', '🍷', '🧊', '🥡', '🍩'] },
  { label: 'Getting around', glyphs: ['🚗', '⛽', '🅿️', '🔧', '🚌', '🚆', '✈️', '🚲', '🛴', '🚕', '🛣️', '🅾️'] },
  { label: 'Health & care', glyphs: ['🏥', '💊', '🩺', '🦷', '💪', '🧘', '✂️', '🧼', '🧴', '👓'] },
  { label: 'Fun & things', glyphs: ['🎬', '🎮', '🎧', '🎟️', '🎨', '📚', '🏈', '🎳', '🎁', '🛍️', '👕', '👟', '💄', '🐾'] },
  { label: 'Money', glyphs: ['💰', '💳', '🏦', '📈', '📉', '🧾', '💵', '🪙', '🎓', '❤️', '⭐', '📌', '🏷️'] },
];

interface Props {
  /** Current override, or '' when the category uses its default. */
  value: string;
  /** The glyph shown when there is no override — offered as "Default". */
  fallback: string;
  label: string;
  onChange: (glyph: string) => void;
}

const POP_WIDTH = 232;
const POP_MAX_HEIGHT = 240;

export function GlyphPicker({ value, fallback, label, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  /**
   * Positioned in VIEWPORT coordinates, not relative to the button.
   *
   * The panel is rendered inside two containers that set `overflow: hidden` for
   * their rounded corners — `.sfin-disc-inset` and `.sfin-card--collapsible` — and
   * an absolutely-positioned child of those is clipped away entirely. That is
   * exactly what happened: the button toggled, the panel rendered, and nothing
   * was visible. `position: fixed` escapes ancestor clipping (no ancestor
   * establishes a containing block via transform/filter), so the coordinates come
   * from the button's own rect instead.
   *
   * Flips above the button when there is not room below, and clamps to the right
   * edge, so a category near the bottom of a long list is still usable.
   */
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const top = below >= POP_MAX_HEIGHT + 8
      ? r.bottom + 4
      : Math.max(8, r.top - POP_MAX_HEIGHT - 4);
    const left = Math.min(r.left, Math.max(8, window.innerWidth - POP_WIDTH - 8));
    setPos({ top, left });
  };

  // Close on outside click and on Escape. Without this the panel survives a click
  // elsewhere in the card, and several open at once reads as a broken layout.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Fixed coordinates go stale the moment anything scrolls, and a panel floating
    // away from its button is worse than one that closed.
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  const pick = (glyph: string) => {
    onChange(glyph);
    setOpen(false);
  };

  return (
    <span ref={wrap} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title="Choose the emoji for this category in Telegram reports"
        ref={btn}
        onClick={() => {
          if (!open) place();
          setOpen((o) => !o);
        }}
        className="sfin-glyph-btn"
      >
        {value || fallback}
      </button>
      {open && (
        <div
          className="sfin-glyph-pop"
          role="dialog"
          aria-label={label}
          style={pos ? { top: pos.top, left: pos.left } : undefined}
        >
          <button type="button" className="sfin-glyph-clear" onClick={() => pick('')}>
            Default ({fallback})
          </button>
          {PALETTE.map((group) => (
            <div key={group.label}>
              <div className="sfin-glyph-group">{group.label}</div>
              <div className="sfin-glyph-grid">
                {group.glyphs.map((g) => (
                  <button
                    type="button"
                    key={g}
                    aria-label={g}
                    onClick={() => pick(g)}
                    className={g === value ? 'sfin-glyph-cell sfin-glyph-cell--on' : 'sfin-glyph-cell'}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
