import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { ThemeStyles } from './ui';

/**
 * A stylesheet lint the hard way: the whole theme is one template literal,
 * and a class defined twice means the LATER block silently wins — which is
 * how the data-check card's `.sfin-check` (a column flex) took over every
 * checkbox label in the app for six releases (live, 2026-09-07).
 */
describe('ThemeStyles', () => {
  it('defines each simple class selector block only once', () => {
    // ThemeStyles injects a <style> into the document rather than rendering
    // markup, so the sheet is read back off the head.
    render(React.createElement(ThemeStyles));
    const css = Array.from(document.head.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
    expect(css.length).toBeGreaterThan(1000);
    const seen = new Map<string, number>();
    // Column-0 only: an indented block lives inside a @media query and is a
    // deliberate responsive override, not a same-specificity collision.
    for (const m of css.matchAll(/^(\.sfin-[a-z0-9-]+)\s*\{/gm)) {
      seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([sel]) => sel);
    expect(dupes).toEqual([]);
  });
});
