/**
 * shared/svg-charts.ts
 *
 * Hand-rolled SVG chart primitives — the ONE rendering core behind both
 * mobile surfaces (v1.44.0): the Telegram mini app inlines these SVGs into a
 * server-rendered page, and the /reports image fallback rasterizes the very
 * same strings to PNG. No canvas, no chart library, no native dependency —
 * strings in, strings out, testable like any other pure module.
 *
 * Deliberately small vocabulary: lines (with gaps), grouped bars (negative
 * values allowed), a donut. Dark-theme styling is baked in to match the
 * Budget tab's register.
 */

// DejaVu leads because that is the font the companion image actually ships
// for resvg; browsers fall through to their own sans.
const FONT = 'font-family="DejaVu Sans, system-ui, sans-serif"';
const AXIS = '#8a9490';
const GRID = 'rgba(138, 148, 144, 0.18)';
const BG = '#1c1f1e';

export interface ChartSeries {
  name: string;
  color: string;
  /** One entry per label; null = unknowable, rendered as a gap. */
  values: Array<number | null>;
  dashed?: boolean;
}

interface Frame {
  width: number;
  height: number;
  pad: { l: number; r: number; t: number; b: number };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtTick = (v: number) => {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${v < 0 ? '-' : ''}${Math.round(abs / 100) / 10}k`;
  return String(Math.round(v));
};

function bounds(series: ChartSeries[]): { min: number; max: number } {
  let min = 0;
  let max = 1;
  for (const s of series) {
    for (const v of s.values) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (max === min) max = min + 1;
  return { min, max };
}

function open(frame: Frame): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${frame.width} ${frame.height}" width="${frame.width}" height="${frame.height}">`
    + `<rect x="0" y="0" width="${frame.width}" height="${frame.height}" fill="${BG}" rx="12"/>`;
}

function yScale(frame: Frame, min: number, max: number) {
  const innerH = frame.height - frame.pad.t - frame.pad.b;
  return (v: number) => frame.pad.t + innerH * (1 - (v - min) / (max - min));
}

function gridAndTicks(frame: Frame, min: number, max: number): string {
  const y = yScale(frame, min, max);
  let out = '';
  for (let i = 0; i <= 3; i += 1) {
    const v = min + ((max - min) * i) / 3;
    const yy = y(v);
    out += `<line x1="${frame.pad.l}" y1="${yy}" x2="${frame.width - frame.pad.r}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    out += `<text x="${frame.pad.l - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${AXIS}" ${FONT}>${fmtTick(v)}</text>`;
  }
  return out;
}

/** Bottom labels, thinned so long month runs stay legible. */
function xLabels(frame: Frame, labels: string[], xAt: (i: number) => number): string {
  const step = Math.max(1, Math.ceil(labels.length / 6));
  let out = '';
  labels.forEach((label, i) => {
    if (i % step !== 0 && i !== labels.length - 1) return;
    out += `<text x="${xAt(i)}" y="${frame.height - 8}" text-anchor="middle" font-size="11" fill="${AXIS}" ${FONT}>${esc(label)}</text>`;
  });
  return out;
}

/** Colored chip + name per series, along the top: photos have no hover. */
function legendRow(frame: Frame, series: ChartSeries[], always = false): string {
  if (series.length < 2 && !always) return '';
  let x = frame.pad.l;
  let out = '';
  for (const s of series) {
    out += `<rect x="${x}" y="6" width="9" height="9" rx="2" fill="${s.color}"/>`
      + `<text x="${x + 13}" y="14" font-size="11" fill="#cdd5d1" ${FONT}>${esc(s.name)}</text>`;
    x += 22 + s.name.length * 6.2;
  }
  return out;
}

const fmtLast = (v: number) => {
  const abs = Math.abs(v);
  const body = abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : String(Math.round(abs * 10) / 10);
  return `${v < 0 ? '-' : ''}${body}`;
};

export function svgLineChart(opts: {
  width: number; height: number; labels: string[]; series: ChartSeries[];
  /** 'always' shows the legend even for one series — custom reports carry
   *  their label here, standard cards carry it in the card title. */
  legend?: 'auto' | 'always';
}): string {
  const frame: Frame = { width: opts.width, height: opts.height, pad: { l: 46, r: 58, t: 24, b: 26 } };
  const { min, max } = bounds(opts.series);
  const y = yScale(frame, min, max);
  const innerW = frame.width - frame.pad.l - frame.pad.r;
  const xAt = (i: number) => frame.pad.l + (opts.labels.length <= 1 ? innerW / 2 : (innerW * i) / (opts.labels.length - 1));

  let body = gridAndTicks(frame, min, max) + legendRow(frame, opts.series, opts.legend === 'always');
  for (const s of opts.series) {
    // Split on nulls: runs of ≥2 points become polylines, lone points circles.
    const runs: Array<Array<[number, number]>> = [[]];
    s.values.forEach((v, i) => {
      if (v === null) {
        if (runs[runs.length - 1].length > 0) runs.push([]);
      } else {
        runs[runs.length - 1].push([xAt(i), y(v)]);
      }
    });
    for (const run of runs) {
      if (run.length === 0) continue;
      if (run.length === 1) {
        body += `<circle cx="${run[0][0]}" cy="${run[0][1]}" r="3" fill="${s.color}"/>`;
      } else {
        const points = run.map(([px, py]) => `${Math.round(px * 10) / 10},${Math.round(py * 10) / 10}`).join(' ');
        // ONE stroke-width per element: resvg rejects duplicate attributes
        // outright, where browsers quietly take the last one.
        body += `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="${s.dashed ? 1.5 : 2.5}"`
          + (s.dashed ? ' stroke-dasharray="6 5"' : '') + '/>';
      }
    }
  }
  // The newest value, printed at each line's end — a photo has no tooltip.
  for (const s of opts.series) {
    if (s.dashed) continue;
    for (let i = s.values.length - 1; i >= 0; i -= 1) {
      const v = s.values[i];
      if (v === null) continue;
      body += `<text x="${xAt(i) + 5}" y="${y(v) + 4}" font-size="11" font-weight="600" fill="${s.color}" ${FONT}>${fmtLast(v)}</text>`;
      break;
    }
  }
  body += xLabels(frame, opts.labels, xAt);
  return open(frame) + body + '</svg>';
}

export function svgBarChart(opts: {
  width: number; height: number; labels: string[]; series: ChartSeries[];
  legend?: 'auto' | 'always';
}): string {
  const frame: Frame = { width: opts.width, height: opts.height, pad: { l: 46, r: 12, t: 24, b: 26 } };
  const { min, max } = bounds(opts.series);
  const y = yScale(frame, min, max);
  const innerW = frame.width - frame.pad.l - frame.pad.r;
  const groupW = innerW / Math.max(1, opts.labels.length);
  const barW = Math.max(2, (groupW * 0.7) / Math.max(1, opts.series.length));

  let body = gridAndTicks(frame, min, max) + legendRow(frame, opts.series, opts.legend === 'always');
  const zero = y(Math.max(0, min));
  opts.labels.forEach((_, i) => {
    opts.series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || v === undefined) return;
      const x = frame.pad.l + groupW * i + groupW * 0.15 + barW * si;
      const top = Math.min(y(v), zero);
      const h = Math.max(1, Math.abs(y(v) - zero));
      // data-bar carries a value: bare attributes are HTML leniency, and
      // resvg parses strict XML.
      body += `<rect data-bar="1" x="${Math.round(x * 10) / 10}" y="${Math.round(top * 10) / 10}" width="${Math.round(barW * 10) / 10}" height="${Math.round(h * 10) / 10}" fill="${s.color}" rx="2"/>`;
    });
  });
  body += xLabels(frame, opts.labels, (i) => frame.pad.l + groupW * i + groupW / 2);
  return open(frame) + body + '</svg>';
}

export function svgDonut(opts: {
  width: number; height: number;
  slices: Array<{ name: string; value: number; color: string }>;
}): string {
  const frame: Frame = { width: opts.width, height: opts.height, pad: { l: 0, r: 0, t: 0, b: 0 } };
  const total = opts.slices.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  const cx = frame.height / 2;
  const cy = frame.height / 2;
  const rOut = frame.height / 2 - 14;
  const rIn = rOut * 0.62;

  // Ring + legend measured as ONE group and centered — the ring alone hugged
  // the left edge on wide canvases (live, 2026-09-03).
  const legendW = Math.min(200, 24 + Math.max(0, ...opts.slices.slice(0, 8).map((sl) => sl.name.length)) * 7);
  const groupW = frame.height + 8 + legendW;
  const dx = Math.max(0, (frame.width - groupW) / 2);

  let angle = -Math.PI / 2;
  let body = '';
  for (const slice of opts.slices) {
    const frac = Math.max(0, slice.value) / total;
    // Full-circle arcs degenerate; cap just under 1 turn.
    const sweep = Math.min(frac, 0.9999) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (r: number, a: number) => `${Math.round((cx + r * Math.cos(a)) * 10) / 10} ${Math.round((cy + r * Math.sin(a)) * 10) / 10}`;
    body += `<path d="M ${p(rOut, a0)} A ${rOut} ${rOut} 0 ${large} 1 ${p(rOut, a1)} L ${p(rIn, a1)} A ${rIn} ${rIn} 0 ${large} 0 ${p(rIn, a0)} Z" fill="${slice.color}"/>`;
  }
  // Legend to the right of the ring.
  const lx = frame.height + 8;
  opts.slices.slice(0, 8).forEach((slice, i) => {
    const ly = 22 + i * 22;
    body += `<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${slice.color}"/>`
      + `<text x="${lx + 16}" y="${ly}" font-size="12" fill="#cdd5d1" ${FONT}>${esc(slice.name)}</text>`;
  });
  return open(frame) + `<g transform="translate(${Math.round(dx * 10) / 10} 0)">` + body + '</g></svg>';
}
