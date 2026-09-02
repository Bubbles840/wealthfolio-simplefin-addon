import React, { useState } from 'react';
import { Button, SectionLabel } from '../components/ui';
import { ReportView, reportTitle } from '../components/budget/ReportView';
import { monthlySpendTotals, sliceCubeMonths, type ReportCube } from '../../shared/report-cube';
import { runwayTrendData, savingsRateData } from '../components/budget/report-data';
import {
  cycleSize, moveCard, pinHero, POOL_ONLY_REPORT_IDS, resolveBudgetLayout, setSpan, SIZE_LABELS,
  STANDARD_REPORT_IDS, toggleHidden, type BudgetLayout,
} from '../../shared/budget-layout';
import { newCustomReportId, type CustomReport } from '../../shared/report-eval';
import { ReportBuilder } from '../components/budget/ReportBuilder';
import type { SecretsStore } from '../utils/secrets';

/**
 * The Budget tab: the addon's first and default view. Everything rendered
 * here is a pure function of the companion-published report cube — see the
 * 2026-08-30 spec. The tab owns only presentation state (which report is
 * full-screen, the shared range, customize mode); the arrangement and the
 * custom-report collection live in SyncPage, because TabPanel unmounts
 * inactive tabs and state held here would reset on every tab trip — the
 * defect class the Telegram draft hoisting fixed.
 *
 * Customize mode is BUTTONS, not drag: pin (two heroes, oldest bumps), move
 * up/down on the grid the user actually sees, hide into a recoverable row.
 * Buttons work identically on a phone and a keyboard, which drag does not.
 * While customizing, cards stop opening — every tap is an arrangement tap.
 */
export interface BudgetTabProps {
  cube: ReportCube | null;
  customReports: CustomReport[];
  layout: BudgetLayout | null;
  onLayoutChange: (next: BudgetLayout) => void;
  onCustomReportsChange: (next: CustomReport[]) => void;
  store: SecretsStore;
}

/** Two days: one missed nightly publish is routine, two is worth a strip. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

const money0 = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);

type Range = number | 'all' | 'pool';
const RANGES: Array<{ label: string; value: Range }> = [
  { label: '6 months', value: 6 },
  { label: '12 months', value: 12 },
  { label: '24 months', value: 24 },
  { label: 'All', value: 'all' },
];

export function BudgetTab({ cube, customReports, layout, onLayoutChange, onCustomReportsChange }: BudgetTabProps) {
  const [fullId, setFullId] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(12);
  const [customizing, setCustomizing] = useState(false);
  /** Live spans while a corner drag is in flight, by report id. */
  const [dragSpans, setDragSpans] = useState<Record<string, { c: number; r: number }>>({});
  /** Non-null while the builder is open; `existing` null means a new report. */
  const [builder, setBuilder] = useState<{ existing: CustomReport | null } | null>(null);

  if (!cube) {
    return (
      <div className="sfin-banner-warn">
        <div className="sfin-banner-body">
          <div>
            <b>Reports need the companion.</b> The Budget tab renders data the
            companion publishes on each sync — once a sync with v1.29.0+ has
            run, the reports appear here on their own.
          </div>
        </div>
      </div>
    );
  }

  const availableIds = [
    ...STANDARD_REPORT_IDS.filter((id) => !POOL_ONLY_REPORT_IDS.has(id) || cube.pool !== null),
    ...customReports.map((r) => `custom:${r.id}`),
  ];
  const resolved = resolveBudgetLayout(layout, availableIds, cube.pool !== null);
  const stale = Date.now() - Date.parse(cube.asOf) > STALE_MS;
  const viewCube = sliceCubeMonths(cube, range);

  /** The baseline the mutation helpers work on: the stored layout when one
   *  exists, else the resolved snapshot the user is LOOKING at — so the first
   *  ever customization edits exactly what is on screen. */
  const storedLayout: BudgetLayout = layout ?? {
    heroes: resolved.heroes, order: resolved.grid, hidden: resolved.hidden, wide: resolved.wide,
  };

  if (builder) {
    return (
      <ReportBuilder
        cube={cube}
        existing={builder.existing}
        onSave={(def) => {
          const next = customReports.some((r) => r.id === def.id)
            ? customReports.map((r) => (r.id === def.id ? def : r))
            : [...customReports, def];
          onCustomReportsChange(next);
          setBuilder(null);
        }}
        onCancel={() => setBuilder(null)}
      />
    );
  }

  const staleStrip = stale && (
    <div className="sfin-banner-warn">
      <div className="sfin-banner-body">
        Data as of {cube.asOf.slice(0, 10)} — the companion hasn&apos;t published since.
        Charts below render that last snapshot.
      </div>
    </div>
  );

  if (fullId !== null) {
    return (
      <div data-full-report={fullId}>
        {staleStrip}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Button variant="ghost" aria-label="Back to all reports" onClick={() => setFullId(null)}>
            ← All reports
          </Button>
          <SectionLabel>{reportTitle(fullId, customReports)}</SectionLabel>
        </div>
        <div className="sfin-range-chips">
          {[...RANGES, ...(cube.pool ? [{ label: 'Pool', value: 'pool' as Range }] : [])].map((r) => (
            <Button
              key={r.label}
              variant={range === r.value ? undefined : 'ghost'}
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </Button>
          ))}
        </div>
        <ReportView id={fullId} cube={viewCube} customReports={customReports} hero />
      </div>
    );
  }

  const spendCents = monthlySpendTotals(cube).at(-1) ?? 0;
  const runway = runwayTrendData(cube).map((r) => r.months).filter((v): v is number => typeof v === 'number').at(-1) ?? null;
  const rate = savingsRateData(cube).map((r) => r.rate).filter((v): v is number => typeof v === 'number').at(-1) ?? null;

  const controls = (id: string, inGrid: boolean) => {
    const title = reportTitle(id, customReports);
    const custom = id.startsWith('custom:')
      ? customReports.find((r) => `custom:${r.id}` === id) ?? null
      : null;
    return (
      <div className="sfin-card-tools">
        {custom && (
          <>
            <Button variant="ghost" aria-label={`Edit ${title}`} onClick={() => setBuilder({ existing: custom })}>
              Edit
            </Button>
            <Button
              variant="ghost"
              aria-label={`Duplicate ${title}`}
              onClick={() => onCustomReportsChange([
                ...customReports,
                { ...custom, id: newCustomReportId(), name: `${custom.name} copy` },
              ])}
            >
              Duplicate
            </Button>
            <Button
              variant="ghost"
              aria-label={`Delete ${title}`}
              onClick={() => onCustomReportsChange(customReports.filter((r) => r.id !== custom.id))}
            >
              Delete
            </Button>
          </>
        )}
        <Button variant="ghost" aria-label={`Pin ${title}`} onClick={() => onLayoutChange(pinHero(storedLayout, availableIds, id))}>
          📌 Pin
        </Button>
        {inGrid && (
          <>
            <Button variant="ghost" aria-label={`Move ${title} up`} onClick={() => onLayoutChange(moveCard(storedLayout, availableIds, id, -1))}>
              ↑
            </Button>
            <Button variant="ghost" aria-label={`Move ${title} down`} onClick={() => onLayoutChange(moveCard(storedLayout, availableIds, id, 1))}>
              ↓
            </Button>
            <Button
              variant="ghost"
              aria-label={`Resize ${title} (now ${SIZE_LABELS[resolved.sizeOf(id)]})`}
              title={`Cycle size — now ${SIZE_LABELS[resolved.sizeOf(id)]}`}
              onClick={() => onLayoutChange(cycleSize(storedLayout, id))}
            >
              ⤢ {SIZE_LABELS[resolved.sizeOf(id)]}
            </Button>
          </>
        )}
        <Button variant="ghost" aria-label={`Hide ${title}`} onClick={() => onLayoutChange(toggleHidden(storedLayout, availableIds, id))}>
          Hide
        </Button>
      </div>
    );
  };

  /** A whole card is its own open-button — the tap target a phone needs, with
   *  the accessible name a screen reader needs. In customize mode the card is
   *  inert and its controls row does the talking instead. */
  const cellClass = (id: string, hero: boolean) =>
    `sfin-cell${hero ? '' : ` sfin-cell--${resolved.sizeOf(id)}`}`;

  const spanFor = (id: string) => dragSpans[id] ?? resolved.spanOf(id);
  const cellStyle = (id: string, hero: boolean): React.CSSProperties => {
    if (hero) return {};
    const { c, r } = spanFor(id);
    return { gridColumn: `span ${c}`, gridRow: `span ${r}` };
  };

  /** Grid units for the corner drag, from the cell being dragged; jsdom (and
   *  a not-yet-laid-out cell) measure 0, so real defaults keep the math sane. */
  const GAP = 14;
  const ROW_UNIT = 158 + GAP;
  const startDrag = (id: string) => (down: React.PointerEvent) => {
    down.preventDefault();
    down.stopPropagation();
    const cell = (down.currentTarget as HTMLElement).closest('.sfin-cell') as HTMLElement | null;
    const { c: c0, r: r0 } = spanFor(id);
    const colUnit = cell && cell.offsetWidth > 0 ? cell.offsetWidth / c0 + GAP : 330;
    const startX = down.clientX;
    const startY = down.clientY;
    const spanAt = (e: PointerEvent | MouseEvent) => ({
      c: c0 + Math.round((e.clientX - startX) / colUnit),
      r: r0 + Math.round((e.clientY - startY) / ROW_UNIT),
    });
    const move = (e: PointerEvent) => {
      const { c, r } = spanAt(e);
      setDragSpans((prev) => ({
        ...prev,
        [id]: { c: Math.min(3, Math.max(1, c)), r: Math.min(4, Math.max(1, r)) },
      }));
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const { c, r } = spanAt(e);
      setDragSpans((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (c !== c0 || r !== r0) onLayoutChange(setSpan(storedLayout, id, c, r));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const card = (id: string, hero: boolean) => customizing ? (
    <div key={id} className={`${cellClass(id, hero)} sfin-cell--editing`} style={cellStyle(id, hero)}>
      <ReportView id={id} cube={viewCube} customReports={customReports} hero={hero} density={spanFor(id).r} />
      {controls(id, !hero)}
      {!hero && (
        <div
          className="sfin-resize-handle"
          role="button"
          tabIndex={0}
          aria-label={`Drag to resize ${reportTitle(id, customReports)}`}
          title="Drag: right to widen, down to grow"
          onPointerDown={startDrag(id)}
        />
      )}
    </div>
  ) : (
    <div
      key={id}
      className={cellClass(id, hero)}
      style={cellStyle(id, hero)}
      role="button"
      tabIndex={0}
      aria-label={`Open ${reportTitle(id, customReports)}`}
      onClick={() => setFullId(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFullId(id); }
      }}
    >
      <ReportView id={id} cube={viewCube} customReports={customReports} hero={hero} density={spanFor(id).r} />
    </div>
  );

  return (
    <>
      {staleStrip}

      <div className="sfin-budget-toolbar">
        <Button variant="ghost" onClick={() => setCustomizing((c) => !c)}>
          {customizing ? 'Done customizing' : 'Customize'}
        </Button>
      </div>

      <div className="sfin-budget-heroes">
        {resolved.heroes.map((id) => card(id, true))}
      </div>

      <div className="sfin-strip" style={{ marginTop: 12 }}>
        <div className="sfin-tile sfin-tile--blue">
          <SectionLabel>Spent this month</SectionLabel>
          <div className="sfin-tile-val">{money0(spendCents)}</div>
        </div>
        {runway !== null && (
          <div className="sfin-tile sfin-tile--green">
            <SectionLabel>Cash runway</SectionLabel>
            <div className="sfin-tile-val">{runway}mo</div>
          </div>
        )}
        {rate !== null && (
          <div className="sfin-tile sfin-tile--purple">
            <SectionLabel>Savings rate</SectionLabel>
            <div className="sfin-tile-val">{Math.round(rate * 100)}%</div>
          </div>
        )}
      </div>

      <div className="sfin-budget-grid">
        {resolved.grid.map((id) => card(id, false))}
        {!customizing && (
          <button
            type="button"
            className="sfin-new-report-card"
            aria-label="New report"
            onClick={() => setBuilder({ existing: null })}
          >
            + New report
          </button>
        )}
      </div>

      {customizing && resolved.hidden.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SectionLabel>Hidden</SectionLabel>
          <div className="sfin-banner-actions" style={{ flexWrap: 'wrap' }}>
            {resolved.hidden.map((id) => (
              <Button
                key={id}
                variant="ghost"
                aria-label={`Unhide ${reportTitle(id, customReports)}`}
                onClick={() => onLayoutChange(toggleHidden(storedLayout, availableIds, id))}
              >
                {reportTitle(id, customReports)} — unhide
              </Button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
