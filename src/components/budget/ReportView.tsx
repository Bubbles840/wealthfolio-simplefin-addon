import React from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@wealthfolio/ui/chart';
import { SectionLabel } from '../ui';
import { monthlySpendTotals, type ReportCube } from '../../../shared/report-cube';
import { evaluateCustomReport, type CustomReport, type EvaluatedReport } from '../../../shared/report-eval';
import {
  budgetVsActualData, cashFlowData, categoryDonutData, categoryTrendData, cumulativeFlowData,
  feesInterestData, merchantTable, momDeltaData, netWorthData, poolBurndownData, poolPaceData,
  runwayTrendData, savingsRateData, seasonalityGrid, spendCalendarData, uncatTrendData,
  dataCheckResult, subscriptionSummary, budgetVsActualAvgData,
  headlineStatValues, DEFAULT_HEADLINE_IDS, MAX_HEADLINE_STATS,
} from './report-data';

/**
 * One report, rendered by id — the single dispatch point the hero row, the
 * grid, and the full-screen view share, so a report can never look different
 * depending on where it appears.
 *
 * Charts are the HOST-PROVIDED recharts through the host's ChartContainer
 * (native Wealthfolio look, ~zero bundle cost); everything non-chart — the
 * merchant table, the seasonality heatmap, the empty states — is plain DOM.
 * All data comes from report-data.ts / the custom evaluator, both pinned by
 * their own tests; this file only decides SHAPE.
 *
 * Empty states per the spec: absence explains itself. An all-null net worth
 * says it is accruing, an all-zero fees history says "nothing — as it should
 * be", and a custom report naming a category the cube no longer has wears a
 * warning chip instead of crashing.
 */
export const REPORT_TITLES: Record<string, string> = {
  'pool-burndown': 'Pool burn-down',
  'cash-flow': 'Cash flow',
  'category-trends': 'Category trends',
  'net-worth': 'Net worth',
  'savings-rate': 'Savings rate',
  'merchants': 'Merchants',
  'budget-vs-actual': 'Budget vs actual',
  'seasonality': 'Seasonality',
  'fees-interest': 'Fees & interest',
  'runway-trend': 'Cash runway',
  'headline-stats': 'Headline numbers',
  'category-donut': 'Where it went',
  'mom-delta': 'This month vs last',
  'spend-calendar': 'Spending calendar',
  'pool-pace': 'Pool pace',
  'cumulative-flow': 'Money in vs out',
  'uncat-trend': 'Uncategorized trend',
  'data-check': 'Data check',
  'subscriptions': 'Subscriptions',
};

export function reportTitle(id: string, customReports: CustomReport[]): string {
  if (id.startsWith('custom:')) {
    return customReports.find((r) => `custom:${r.id}` === id)?.name ?? 'Custom report';
  }
  return REPORT_TITLES[id] ?? id;
}

const fmt0 = (dollars: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(dollars);
/** Exact cents, for the cards where "off by 37¢" IS the content. */
const fmt2 = (dollars: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(dollars);

/** A stable small palette cycled for multi-series charts; recharts wants
 *  explicit strokes and the host theme handles contrast. */
// Colors resolve through CSS custom properties so a palette can be applied
// globally (grid element) or per cell, with charts none the wiser. Defaults
// (the sage register matched to Wealthfolio's dashboard) live in ThemeStyles;
// the catalog is src/components/budget/palettes.ts.
const color = (i: number) => `var(--sfin-s${i % 8})`;

function Frame({ children }: { children: React.ReactElement }) {
  return (
    <ChartContainer config={{}} className="sfin-chart" style={{ width: '100%' }}>
      {children}
    </ChartContainer>
  );
}

function CashFlow({ cube }: { cube: ReportCube }) {
  return (
    <Frame>
      <BarChart data={cashFlowData(cube)}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={44} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="income" fill={color(0)} />
        <Bar dataKey="spending" fill={color(3)} />
        <Line dataKey="net" stroke={color(7)} dot={false} />
      </BarChart>
    </Frame>
  );
}

function CategoryTrends({ cube, categories }: { cube: ReportCube; categories?: string[] }) {
  const picked = categories ?? cube.categories;
  return (
    <Frame>
      <BarChart data={categoryTrendData(cube, picked)}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={44} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {picked.map((c, i) => (
          <Bar key={c} dataKey={c} stackId="spend" fill={color(i)} />
        ))}
      </BarChart>
    </Frame>
  );
}

function NetWorth({ cube }: { cube: ReportCube }) {
  if (cube.netWorth.every((v) => v === null)) {
    return (
      <div className="sfin-subtle">
        No valuation history yet — this chart accrues as the companion snapshots
        your accounts each month.
      </div>
    );
  }
  return (
    <Frame>
      <LineChart data={netWorthData(cube)}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={56} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line dataKey="netWorth" stroke={color(0)} connectNulls={false} dot={false} />
      </LineChart>
    </Frame>
  );
}

function SavingsRate({ cube }: { cube: ReportCube }) {
  return (
    <Frame>
      <LineChart data={savingsRateData(cube)}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={44} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line dataKey="rate" stroke={color(4)} connectNulls={false} dot />
      </LineChart>
    </Frame>
  );
}

function Merchants({ cube, full, density }: { cube: ReportCube; full: boolean; density: number }) {
  const rows = merchantTable(cube, Math.min(3, cube.months.length));
  if (rows.length === 0) return <div className="sfin-subtle">No merchant activity in the window.</div>;
  // The grid card is a PREVIEW budgeted by the card's own height: the full
  // list once made this card the tallest thing on the page (live,
  // 2026-09-02), and a compact card must trim itself rather than clip.
  const cap = density <= 1 ? 3 : density >= 3 ? 12 : 6;
  const shown = full ? rows : rows.slice(0, cap);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="sfin-merchant-table">
        <thead>
          <tr><th style={{ textAlign: 'left' }}>Merchant</th><th>Total</th><th>Charges</th><th>Trend</th></tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td style={{ textAlign: 'right' }}>{fmt0(r.total)}</td>
              <td style={{ textAlign: 'right' }}>{r.count}</td>
              <td style={{ textAlign: 'right' }}>
                {r.trend === null ? '—' : r.trend > 0.05 ? `↑ ${Math.round(r.trend * 100)}%` : r.trend < -0.05 ? `↓ ${Math.round(-r.trend * 100)}%` : '→'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!full && rows.length > shown.length && (
        <div className="sfin-subtle" style={{ marginTop: 6 }}>
          + {rows.length - shown.length} more — open the card for the full list
        </div>
      )}
    </div>
  );
}

function BudgetVsActual({ cube, full, density }: { cube: ReportCube; full: boolean; density: number }) {
  const rows = budgetVsActualAvgData(cube);
  if (rows.length === 0) return <div className="sfin-subtle">No budgets or spending this month.</div>;
  // Compress instead of hiding: every category renders, and the row scale
  // shrinks until the list fits the card ("it's cutting off Housing" — the
  // answer is smaller rows, not fewer). density ≈ coarse height units of
  // ~120px; row heights per tier ≈ 34 / 26 / 19px.
  const shown = rows;
  const capacityPx = Math.max(1, density) * 120;
  const scale = full || rows.length * 34 <= capacityPx ? 'normal'
    : rows.length * 26 <= capacityPx ? 'compact'
      : 'tiny';
  return (
    <div data-bva-list data-bva-scale={scale}>
      {cube.months.length > 1 && (
        <div className="sfin-subtle" style={{ marginBottom: 6 }}>
          monthly average across {cube.months.length} months
        </div>
      )}
      {shown.map((r) => {
        // Each bar scales to ITS OWN row: against the global max, a $174
        // overspend of a $100 budget rendered as a sliver next to Housing's
        // $1,550 (live, 2026-09-02). Over budget = full bar, warning color,
        // with a tick where the budget sat.
        const denom = Math.max(r.budget, r.actual, 0.01);
        const over = r.actual > r.budget;
        return (
          <div key={r.category} data-bva={r.category} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{r.category}</span>
              <span className="sfin-subtle">{fmt0(r.actual)} of {fmt0(r.budget)}</span>
            </div>
            <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'color-mix(in srgb, currentColor 12%, transparent)', overflow: 'hidden' }}>
              <div
                data-bva-fill
                style={{ position: 'absolute', insetBlock: 0, left: 0, width: `${Math.min(100, (r.actual / denom) * 100)}%`, borderRadius: 4, background: over ? color(3) : color(1) }}
              />
              {over && r.budget > 0 && (
                <div
                  data-bva-budget-tick
                  title={`budget: ${fmt0(r.budget)}`}
                  style={{ position: 'absolute', insetBlock: 0, left: `${(r.budget / denom) * 100}%`, width: 2, background: 'var(--background)' }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HeadlineStats({ cube, full = false, picks, onPicksChange }: {
  cube: ReportCube;
  full?: boolean;
  picks?: string[];
  onPicksChange?: (ids: string[]) => void;
}) {
  const catalog = headlineStatValues(cube);
  const byId = new Map(catalog.map((stat) => [stat.id, stat]));
  const chosen = (picks && picks.length > 0 ? picks : DEFAULT_HEADLINE_IDS)
    .map((id) => byId.get(id))
    .filter((stat): stat is NonNullable<typeof stat> => stat !== undefined)
    .slice(0, MAX_HEADLINE_STATS);
  const accents = ['blue', 'green', 'purple', 'blue', 'green'];
  return (
    <>
      <div className="sfin-headline">
        {chosen.map((stat, i) => (
          <div key={stat.id} className={`sfin-tile sfin-tile--${accents[i % accents.length]}`}>
            <SectionLabel>{stat.label}</SectionLabel>
            <div className="sfin-tile-val">{stat.value}</div>
          </div>
        ))}
      </div>
      {full && onPicksChange && (
        <div className="sfin-headline-picker">
          <div className="sfin-subtle">Choose up to five numbers:</div>
          {catalog.map((stat) => {
            const active = chosen.some((c) => c.id === stat.id);
            return (
              <button
                key={stat.id}
                type="button"
                className={`sfin-pick${active ? ' sfin-pick--on' : ''}`}
                aria-pressed={active}
                aria-label={`${active ? 'Hide' : 'Show'} ${stat.label}`}
                onClick={() => {
                  const current = chosen.map((c) => c.id);
                  if (active) {
                    // Never below one — an empty headline card is a bug, not
                    // a preference.
                    if (current.length <= 1) return;
                    onPicksChange(current.filter((id) => id !== stat.id));
                  } else {
                    if (current.length >= MAX_HEADLINE_STATS) return;
                    onPicksChange([...current, stat.id]);
                  }
                }}
              >
                {stat.label} · {stat.value}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

function DataCheck({ cube }: { cube: ReportCube }) {
  const res = dataCheckResult(cube);
  if (!res) {
    return (
      <div className="sfin-subtle">
        The companion hasn't published a check yet — it arrives with the first sync after updating.
      </div>
    );
  }
  if (res.status === 'match') {
    return (
      <div className="sfin-check sfin-check--ok">
        <div className="sfin-check-verdict">✓ The Budget tab matches the ledger</div>
        <div className="sfin-subtle">
          {res.month}: spending recounted through an independent path came out the same.
          Income here counts deposits and interest only — internal transfers are never income.
        </div>
      </div>
    );
  }
  return (
    <div className="sfin-check sfin-check--diverges">
      <div className="sfin-check-verdict">Measures disagree for {res.month}</div>
      {res.rows.filter((r) => r.deltaCents !== 0).map((r) => (
        <div key={r.label} className="sfin-check-row">
          <span>{r.label}</span>
          <span className="sfin-check-nums">
            {fmt2(r.cubeCents / 100)} here · {fmt2(r.ledgerCents / 100)} in the ledger
            {' '}({r.deltaCents > 0 ? '+' : '−'}{fmt2(Math.abs(r.deltaCents) / 100)})
          </span>
        </div>
      ))}
      <div className="sfin-subtle">
        A ledger-side surplus usually means spending on accounts this addon doesn't sync.
      </div>
    </div>
  );
}

function Subscriptions({ cube, full = false, hidden = [], confirmed = [], onHide, onConfirm, onUnhide, onRestore }: {
  cube: ReportCube;
  full?: boolean;
  hidden?: string[];
  confirmed?: string[];
  onHide?: (name: string) => void;
  onConfirm?: (name: string) => void;
  onUnhide?: (name: string) => void;
  onRestore?: () => void;
}) {
  const res = subscriptionSummary(cube);
  if (!res) {
    return (
      <div className="sfin-subtle">
        The companion looks for recurring charges after the next sync.
      </div>
    );
  }
  // Dismissals filter HERE, not in the cube: the companion keeps publishing
  // the full detection, so a restore takes effect without waiting for a sync.
  const hiddenSet = new Set(hidden);
  const visible = res.subs.filter((sub) => !hiddenSet.has(sub.name));
  const hiddenCount = res.subs.length - visible.length;
  // "Watch this one": a confirmed name the detector has no verdict on yet —
  // one charge so far, or an accidental cancel of something brand new. Priced
  // from its latest-month charges until the detector takes over.
  const detectedNames = new Set(res.subs.map((sub) => sub.name));
  // The last few months of merchants, newest first: on the 2nd of a month the
  // "current month" is two days deep, and a mid-August charge must still be
  // watchable and priceable (the live Anthropic miss).
  const recentMerchants: Array<{ name: string; cents: number; count: number }> = [];
  const seenMerchant = new Set<string>();
  for (const monthList of cube.merchants.slice(-3).reverse()) {
    for (const m of monthList) {
      if (seenMerchant.has(m.name)) continue;
      seenMerchant.add(m.name);
      recentMerchants.push(m);
    }
  }
  const watched = confirmed
    .filter((name) => !detectedNames.has(name) && !hiddenSet.has(name))
    .map((name) => {
      const m = recentMerchants.find((entry) => entry.name === name);
      return { name, perChargeCents: m && m.count > 0 ? Math.round(m.cents / m.count) : null };
    });

  if (visible.length === 0 && hiddenCount === 0 && watched.length === 0 && !full) {
    // The OPEN view keeps going: an empty roster is exactly when "watch a
    // merchant" is the thing the user came for.
    return <div className="sfin-subtle">No monthly subscriptions detected — recurring monthly charges would show here.</div>;
  }
  // The roster is what the user (or the stable-price rule) has SAID is a
  // subscription; every other monthly cadence — rent, a utility, a maybe —
  // is a question below, not a line item. A missing kind is an older
  // companion's row: a subscription, per the old detector's only meaning.
  const confirmedSet = new Set(confirmed);
  const sure = visible.filter((sub) => (sub.kind ?? 'subscription') === 'subscription' || confirmedSet.has(sub.name));
  const maybes = visible.filter((sub) => !sure.includes(sub));
  const totalCents = sure.reduce((sum, sub) => sum + sub.monthlyCents, 0)
    + watched.reduce((sum, w) => sum + (w.perChargeCents ?? 0), 0);
  const rosterCount = sure.length + watched.length;
  const [celebrate, setCelebrate] = React.useState<{ name: string; cents: number } | null>(null);
  const dismiss = (name: string, cents: number) => {
    setCelebrate({ name, cents });
    onHide?.(name);
  };
  const row = (sub: (typeof visible)[number]) => (
    <div key={sub.name} className="sfin-subs-row">
      <span className="sfin-subs-name">{sub.name}</span>
      <span className="sfin-subs-price">
        {sub.creep ? (
          <span className="sfin-subs-creep">{fmt2(sub.lastCents / 100)} ▲ was {fmt2(sub.monthlyCents / 100)}</span>
        ) : sub.kind === 'bill' && sub.prevCents !== undefined && sub.prevCents !== sub.lastCents ? (
          <>{fmt2(sub.prevCents / 100)} → {fmt2(sub.lastCents / 100)}/mo</>
        ) : (
          <>{fmt2(sub.monthlyCents / 100)}/mo</>
        )}
      </span>
      {onHide && (
        <button
          type="button"
          className="sfin-subs-dismiss"
          aria-label={`Dismiss ${sub.name}`}
          title="Not a subscription / cancelled"
          onClick={() => dismiss(sub.name, sub.monthlyCents)}
        >
          ✕
        </button>
      )}
    </div>
  );
  return (
    <div className="sfin-subs">
      {sure.map(row)}
      {watched.map((w) => (
        <div key={w.name} className="sfin-subs-row">
          <span className="sfin-subs-name">{w.name}</span>
          <span className="sfin-subs-price">
            {w.perChargeCents !== null ? <>{fmt2(w.perChargeCents / 100)}/mo · watching</> : <>watching</>}
          </span>
          {onHide && (
            <button
              type="button"
              className="sfin-subs-dismiss"
              aria-label={`Dismiss ${w.name}`}
              title="Stop watching"
              onClick={() => dismiss(w.name, w.perChargeCents ?? 0)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {celebrate && (
        <div className="sfin-subs-celebrate" role="status">
          🎉 {celebrate.name} cancelled — that&apos;s {fmt2(celebrate.cents / 100)}/mo back in your pocket.
        </div>
      )}
      <div className="sfin-subs-total">{fmt2(totalCents / 100)}/mo across {rosterCount}</div>
      {maybes.length > 0 && (
        <>
          <div className="sfin-subs-maybe-head">Is this a subscription?</div>
          {maybes.map((sub) => (
            <div key={sub.name} className="sfin-subs-row">
              <span className="sfin-subs-name">{sub.name}</span>
              <span className="sfin-subs-price">
                {sub.prevCents !== undefined && sub.prevCents !== sub.lastCents
                  ? <>{fmt2(sub.prevCents / 100)} → {fmt2(sub.lastCents / 100)}/mo</>
                  : <>{fmt2(sub.lastCents / 100)}/mo</>}
              </span>
              {onConfirm && (
                <button
                  type="button"
                  className="sfin-subs-answer"
                  aria-label={`Yes, ${sub.name} is a subscription`}
                  title="Count it as a subscription"
                  onClick={() => onConfirm(sub.name)}
                >
                  ✓
                </button>
              )}
              {onHide && (
                <button
                  type="button"
                  className="sfin-subs-answer"
                  aria-label={`No, ignore ${sub.name}`}
                  title="Never show this here"
                  onClick={() => onHide(sub.name)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </>
      )}
      {!full && hiddenCount > 0 && onRestore && (
        <button type="button" className="sfin-subs-restore" onClick={onRestore}>
          {hiddenCount} dismissed — restore
        </button>
      )}
      {full && (
        <>
          {hidden.length > 0 && (
            <>
              <div className="sfin-subs-maybe-head">Dismissed</div>
              {hidden.map((name) => (
                <div key={name} className="sfin-subs-row sfin-subs-row--muted">
                  <span className="sfin-subs-name">{name}</span>
                  {onUnhide && (
                    <button
                      type="button"
                      className="sfin-subs-answer"
                      aria-label={`Restore ${name}`}
                      onClick={() => onUnhide(name)}
                    >
                      ↩ Restore
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          {onConfirm && (() => {
            const known = new Set([...res.subs.map((sub) => sub.name), ...confirmed, ...hidden]);
            const watchable = recentMerchants.filter((m) => !known.has(m.name)).slice(0, 12);
            if (watchable.length === 0) return null;
            return (
              <>
                <div className="sfin-subs-maybe-head">Watch a merchant</div>
                <div className="sfin-subtle">
                  One charge so far, or something you know recurs — watching counts it here from now on.
                </div>
                {watchable.map((m) => (
                  <div key={m.name} className="sfin-subs-row sfin-subs-row--muted">
                    <span className="sfin-subs-name">{m.name}</span>
                    <span className="sfin-subs-price">{fmt2(m.cents / Math.max(1, m.count) / 100)}</span>
                    <button
                      type="button"
                      className="sfin-subs-answer"
                      aria-label={`Watch ${m.name}`}
                      title="Treat as a subscription"
                      onClick={() => onConfirm(m.name)}
                    >
                      + Watch
                    </button>
                  </div>
                ))}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}

function CategoryDonut({ cube }: { cube: ReportCube }) {
  const slices = categoryDonutData(cube).map((s, i) => ({ ...s, fill: color(i) }));
  if (slices.length === 0) return <div className="sfin-subtle">Nothing spent in the latest month.</div>;
  return (
    <Frame>
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent />} />
        <Pie data={slices} dataKey="value" nameKey="name" innerRadius="55%">
          {slices.map((s) => <Cell key={s.name} fill={s.fill} />)}
        </Pie>
      </PieChart>
    </Frame>
  );
}

function MomDelta({ cube }: { cube: ReportCube }) {
  const data = momDeltaData(cube);
  if (data.length === 0) return <div className="sfin-subtle">Not enough months to compare yet.</div>;
  return (
    <Frame>
      <BarChart data={data} layout="vertical">
        <CartesianGrid horizontal={false} />
        <XAxis type="number" />
        <YAxis type="category" dataKey="category" width={96} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="delta">
          {data.map((d) => <Cell key={d.category} fill={d.delta > 0 ? color(3) : color(0)} />)}
        </Bar>
      </BarChart>
    </Frame>
  );
}

function SpendCalendar({ cube }: { cube: ReportCube }) {
  const days = spendCalendarData(cube);
  if (days.length === 0) return <div className="sfin-subtle">The calendar follows the pool window.</div>;
  const max = Math.max(...days.map((d) => d.cents), 1);
  return (
    <div className="sfin-cal">
      {days.map((d) => {
        const pct = d.cents > 0 ? Math.max(14, Math.round((d.cents / max) * 85)) : 5;
        return (
          <div key={d.date} className="sfin-cal-day" title={`${d.date}: ${fmt0(d.cents / 100)}`}>
            <div
              data-cal
              className="sfin-cal-cell"
              title={`${d.date}: ${fmt0(d.cents / 100)}`}
              style={{ background: `color-mix(in srgb, ${color(0)} ${pct}%, transparent)` }}
            />
            <span className="sfin-cal-label">{d.date.slice(8)}</span>
          </div>
        );
      })}
    </div>
  );
}

function PoolPace({ cube }: { cube: ReportCube }) {
  const p = poolPaceData(cube);
  if (!p) return <div className="sfin-subtle">The gauge follows the pool.</div>;
  return (
    <div className={`sfin-pace sfin-pace--${p.status}`}>
      <div className="sfin-pace-row">
        <span className="sfin-subtle">You spend</span>
        <span className="sfin-pace-val">{fmt0(p.actualWeekly)}</span>
        <span className="sfin-subtle">/wk</span>
      </div>
      <div className="sfin-pace-row">
        <span className="sfin-subtle">Sustainable</span>
        <span className="sfin-pace-val">{fmt0(p.sustainableWeekly)}</span>
        <span className="sfin-subtle">/wk</span>
      </div>
      <div className="sfin-pace-dot" aria-hidden />
    </div>
  );
}

function CumulativeFlow({ cube }: { cube: ReportCube }) {
  return (
    <Frame>
      <AreaChart data={cumulativeFlowData(cube)}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={52} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area dataKey="income" stroke={color(0)} fill={color(0)} fillOpacity={0.22} />
        <Area dataKey="spending" stroke={color(3)} fill={color(3)} fillOpacity={0.22} />
      </AreaChart>
    </Frame>
  );
}

function UncatTrend({ cube }: { cube: ReportCube }) {
  return (
    <Frame>
      <LineChart data={uncatTrendData(cube)}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={44} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line dataKey="uncategorized" stroke={color(2)} dot={false} />
      </LineChart>
    </Frame>
  );
}

function Seasonality({ cube }: { cube: ReportCube }) {
  const grid = seasonalityGrid(cube);
  const max = Math.max(...grid.cells.flat(), 1);
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `minmax(90px, auto) repeat(${grid.months.length}, minmax(28px, 1fr))`, gap: 2, alignItems: 'center' }}>
        <span />
        {grid.months.map((m) => <span key={m} className="sfin-subtle" style={{ fontSize: 10, textAlign: 'center' }}>{m.slice(2)}</span>)}
        {grid.categories.map((c, ci) => (
          <React.Fragment key={c}>
            <span className="sfin-subtle" style={{ fontSize: 11 }}>{c}</span>
            {grid.months.map((m, mi) => {
              const v = Math.max(0, grid.cells[ci][mi]);
              // A floor tint keeps quiet cells VISIBLE as cells — an all-faint
              // grid read as an empty card on the live instance (2026-09-02).
              const pct = v > 0 ? Math.max(14, Math.round((v / max) * 85)) : 5;
              return (
                <div
                  key={m}
                  data-heat
                  className="sfin-heat-cell"
                  title={`${c} · ${m}: ${fmt0(grid.cells[ci][mi] / 100)}`}
                  style={{ background: `color-mix(in srgb, ${color(3)} ${pct}%, transparent)` }}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function FeesInterest({ cube }: { cube: ReportCube }) {
  if (cube.feesInterest.every((v) => v === 0)) {
    return <div className="sfin-subtle">Fees and interest: nothing — as it should be.</div>;
  }
  return (
    <Frame>
      <BarChart data={feesInterestData(cube)}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={44} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="fees" fill={color(3)} />
      </BarChart>
    </Frame>
  );
}

function RunwayTrend({ cube }: { cube: ReportCube }) {
  const data = runwayTrendData(cube);
  if (data.every((r) => r.months === null)) {
    return (
      <div className="sfin-subtle">
        No balance history yet — runway accrues as the companion snapshots your
        liquid position each month.
      </div>
    );
  }
  return (
    <Frame>
      <LineChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={40} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line dataKey="months" stroke={color(5)} connectNulls={false} dot={false} />
      </LineChart>
    </Frame>
  );
}

function PoolBurndown({ cube }: { cube: ReportCube }) {
  const data = poolBurndownData(cube);
  if (data.length === 0) return null;
  return (
    <>
      <Frame>
        <LineChart data={data}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="date" />
          <YAxis width={52} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Line dataKey="ideal" stroke={color(2)} strokeOpacity={0.55} strokeDasharray="5 5" strokeWidth={1.25} dot={false} />
          <Line dataKey="actual" stroke={color(0)} strokeWidth={2.75} connectNulls={false} dot={false} />
        </LineChart>
      </Frame>
      {/* Legibility over legend furniture: the two lines were both thin sage
          and overlapped near the ideal — now actual is unmistakably the bold
          solid one, and this one-liner says which is which. */}
      <div className="sfin-pool-legend">
        <span className="sfin-pool-legend-actual">— actual</span>
        <span className="sfin-pool-legend-ideal">- - ideal pace</span>
      </div>
    </>
  );
}

function CustomChartBody({ evaluated, def }: { evaluated: EvaluatedReport; def: CustomReport }) {
  if (def.chart === 'table') {
    return (
      <div style={{ overflowX: 'auto' }}>
        <table className="sfin-custom-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Month</th>
              {evaluated.series.map((s) => <th key={s.label} style={{ textAlign: 'right' }}>{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {evaluated.months.map((m, mi) => (
              <tr key={m}>
                <td>{m}</td>
                {evaluated.series.map((s) => (
                  <td key={s.label} style={{ textAlign: 'right' }}>{fmt0(s.values[mi] / 100)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (def.chart === 'donut') {
    const slices = evaluated.series.map((s, i) => ({
      name: s.label,
      value: Math.max(0, s.values.reduce((a, b) => a + b, 0)) / 100,
      fill: color(i),
    }));
    return (
      <Frame>
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent />} />
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius="55%">
            {slices.map((s) => <Cell key={s.name} fill={s.fill} />)}
          </Pie>
        </PieChart>
      </Frame>
    );
  }
  const rows = evaluated.months.map((m, mi) => {
    const row: Record<string, string | number> = { month: m };
    for (const s of evaluated.series) row[s.label] = s.values[mi] / 100;
    return row;
  });
  const series = evaluated.series.map((s) => s.label);
  if (def.chart === 'area') {
    return (
      <Frame>
        <AreaChart data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="month" />
          <YAxis width={44} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.map((s, i) => <Area key={s} dataKey={s} stroke={color(i)} fill={color(i)} fillOpacity={0.25} />)}
        </AreaChart>
      </Frame>
    );
  }
  if (def.chart === 'bars' || def.chart === 'stacked') {
    return (
      <Frame>
        <BarChart data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="month" />
          <YAxis width={44} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.map((s, i) => (
            <Bar key={s} dataKey={s} fill={color(i)} {...(def.chart === 'stacked' ? { stackId: 'all' } : {})} />
          ))}
        </BarChart>
      </Frame>
    );
  }
  return (
    <Frame>
      <LineChart data={rows}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={44} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {series.map((s, i) => <Line key={s} dataKey={s} stroke={color(i)} connectNulls={false} dot={false} />)}
      </LineChart>
    </Frame>
  );
}

function CustomView({ cube, def }: { cube: ReportCube; def: CustomReport }) {
  const evaluated = evaluateCustomReport(cube, def);
  const unknown = Array.from(new Set(evaluated.series.flatMap((s) => s.unknownCategories)));
  return (
    <>
      {unknown.map((name) => (
        <span key={name} className="sfin-chip-warn sfin-subtle" style={{ display: 'inline-block', marginBottom: 6 }}>
          unknown category: {name}
        </span>
      ))}
      <CustomChartBody evaluated={evaluated} def={def} />
    </>
  );
}

export function ReportView({
  id, cube, customReports, hero = false, categories, density = 2,
  hiddenSubscriptions, confirmedSubscriptions, onHideSubscription, onConfirmSubscription,
  onUnhideSubscription, onRestoreSubscriptions, headlinePicks, onHeadlinePicksChange,
}: {
  id: string;
  cube: ReportCube;
  customReports: CustomReport[];
  hero?: boolean;
  /** Category-trends only: narrow to these categories (full-screen chips). */
  categories?: string[];
  /** The card's row span (1–4): list-reports budget their rows to it so a
   *  compact card trims itself instead of clipping. */
  density?: number;
  /** Subscriptions-card answers; the card is read-only without handlers. */
  hiddenSubscriptions?: string[];
  confirmedSubscriptions?: string[];
  onHideSubscription?: (name: string) => void;
  onConfirmSubscription?: (name: string) => void;
  onUnhideSubscription?: (name: string) => void;
  onRestoreSubscriptions?: () => void;
  /** Headline card: which stats to show (1–5 catalog ids) and the editor. */
  headlinePicks?: string[];
  onHeadlinePicksChange?: (ids: string[]) => void;
}) {
  let body: React.ReactNode;
  if (id.startsWith('custom:')) {
    const def = customReports.find((r) => `custom:${r.id}` === id);
    body = def ? <CustomView cube={cube} def={def} /> : <div className="sfin-subtle">This report was deleted.</div>;
  } else {
    switch (id) {
      case 'pool-burndown': body = <PoolBurndown cube={cube} />; break;
      case 'cash-flow': body = <CashFlow cube={cube} />; break;
      case 'category-trends': body = <CategoryTrends cube={cube} categories={categories} />; break;
      case 'net-worth': body = <NetWorth cube={cube} />; break;
      case 'savings-rate': body = <SavingsRate cube={cube} />; break;
      case 'merchants': body = <Merchants cube={cube} full={hero} density={density} />; break;
      case 'budget-vs-actual': body = <BudgetVsActual cube={cube} full={hero} density={density} />; break;
      case 'seasonality': body = <Seasonality cube={cube} />; break;
      case 'fees-interest': body = <FeesInterest cube={cube} />; break;
      case 'runway-trend': body = <RunwayTrend cube={cube} />; break;
      case 'headline-stats':
        body = <HeadlineStats cube={cube} full={hero} picks={headlinePicks} onPicksChange={onHeadlinePicksChange} />;
        break;
      case 'category-donut': body = <CategoryDonut cube={cube} />; break;
      case 'mom-delta': body = <MomDelta cube={cube} />; break;
      case 'spend-calendar': body = <SpendCalendar cube={cube} />; break;
      case 'pool-pace': body = <PoolPace cube={cube} />; break;
      case 'cumulative-flow': body = <CumulativeFlow cube={cube} />; break;
      case 'uncat-trend': body = <UncatTrend cube={cube} />; break;
      case 'data-check': body = <DataCheck cube={cube} />; break;
      case 'subscriptions':
        body = (
          <Subscriptions
            cube={cube}
            full={hero}
            hidden={hiddenSubscriptions}
            confirmed={confirmedSubscriptions}
            onHide={onHideSubscription}
            onConfirm={onConfirmSubscription}
            onUnhide={onUnhideSubscription}
            onRestore={onRestoreSubscriptions}
          />
        );
        break;
      default: body = null;
    }
  }
  return (
    <div className="sfin-card sfin-report-card" data-report-id={id} data-hero={hero || undefined}>
      <div className="sfin-card-head">
        <SectionLabel>{reportTitle(id, customReports)}</SectionLabel>
      </div>
      <div className={`sfin-report-body${hero ? ' sfin-report-body--hero' : ''}`}>
        {body}
      </div>
    </div>
  );
}
