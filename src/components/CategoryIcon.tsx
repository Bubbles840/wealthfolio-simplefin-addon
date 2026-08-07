import React from 'react';
import * as Lucide from 'lucide-react';

interface Props {
  /** lucide-react export name as Wealthfolio stores it (`Fuel`, `Gamepad2`,
   *  `GraduationCap`). Null or unknown renders the fallback. */
  name: string | null;
  /** Hex from Wealthfolio's own category row. */
  color?: string | null;
  size?: number;
}

/**
 * Renders a category's icon using Wealthfolio's own choice.
 *
 * `taxonomy_categories.icon` holds lucide-react EXPORT names, and lucide-react is
 * already a dependency — so resolving `Lucide[name]` needs no mapping table of
 * ours to drift out of date, and a category Wealthfolio gives a new icon to just
 * renders. That is why this looks up dynamically instead of switching over a
 * known list.
 *
 * Unknown or missing names fall back to a neutral tag rather than rendering
 * nothing, so a row never silently loses its leading glyph and shift its
 * alignment. `Lucide` also exports non-component helpers, so the lookup checks it
 * actually got something renderable before trusting it.
 */
export function CategoryIcon({ name, color, size = 14 }: Props) {
  const candidate = name ? (Lucide as unknown as Record<string, unknown>)[name] : undefined;
  const Resolved = (typeof candidate === 'function' || typeof candidate === 'object')
    && candidate !== null
    ? (candidate as React.ComponentType<{ size?: number; color?: string; 'aria-hidden'?: boolean }>)
    : Lucide.Tag;
  return (
    <Resolved
      size={size}
      color={color ?? 'currentColor'}
      // Decorative: the category name sits beside it in text, so a screen reader
      // announcing the icon would only repeat itself.
      aria-hidden
    />
  );
}
