/**
 * src/components/budget/palettes.ts
 *
 * The ten chart palettes. Charts consume colors as CSS custom properties
 * (--sfin-s0..s7) — SVG presentation attributes are CSS values, so var()
 * resolves in fill/stroke (the same trick the host's ChartStyle uses) —
 * which is what lets one palette apply globally from the grid element and
 * another override a single cell, with zero re-plumbing of chart code.
 */

export interface Palette { id: string; name: string; colors: string[] }

export const PALETTES: Palette[] = [
  { id: 'sage', name: 'Sage', colors: ['#5e9483', '#3e6f63', '#c9a86b', '#c17a63', '#7189a8', '#8aa864', '#9a7aa0', '#6b7f8f'] },
  { id: 'ocean', name: 'Ocean', colors: ['#4f83a8', '#2e5f80', '#6db3c9', '#c9a86b', '#5e9483', '#8095b0', '#4a708c', '#9db4c4'] },
  { id: 'sunset', name: 'Sunset', colors: ['#c97b5e', '#a85a42', '#d9a86b', '#8f5f80', '#c9958a', '#b07a4f', '#7c5a6e', '#d9bfa8'] },
  { id: 'forest', name: 'Forest', colors: ['#5a8a4f', '#3c6b38', '#8aa864', '#c9a86b', '#4f7a68', '#6f9c5c', '#2f5540', '#a3bd8a'] },
  { id: 'berry', name: 'Berry', colors: ['#9a5a80', '#7a3c60', '#c17a9c', '#6b5f9a', '#b08ab0', '#8a4f70', '#5f4a8c', '#c9a8c4'] },
  { id: 'slate', name: 'Slate', colors: ['#7d8a99', '#5a6673', '#9aa8b8', '#6b7f8f', '#8f9db0', '#4f5a66', '#a8b4c4', '#66737f'] },
  { id: 'autumn', name: 'Autumn', colors: ['#b0713c', '#8a4f2e', '#c9a86b', '#a85a42', '#d9b880', '#7a5638', '#c17a63', '#8f7a4f'] },
  { id: 'pastel', name: 'Pastel', colors: ['#8fbcab', '#a8c4d9', '#d9c49c', '#d9a8a0', '#b0a8d9', '#a8d0b0', '#c4a8c9', '#9cb8c4'] },
  { id: 'mono', name: 'Mono green', colors: ['#5e9483', '#4a7a6b', '#7aa896', '#386156', '#95bfb0', '#2c4d44', '#b0d4c8', '#6b9c8c'] },
  { id: 'bold', name: 'Bold', colors: ['#3d9970', '#2e6da4', '#d9822b', '#c0392b', '#7d5ba6', '#95a832', '#1f8a80', '#b0568a'] },
];

export const DEFAULT_PALETTE_ID = 'sage';

export function paletteById(id: string | undefined): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** Inline-style form: the eight custom properties for one palette. */
export function paletteVars(id: string): Record<string, string> {
  const p = paletteById(id);
  const vars: Record<string, string> = {};
  p.colors.forEach((c, i) => { vars[`--sfin-s${i}`] = c; });
  return vars;
}
