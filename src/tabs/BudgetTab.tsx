import React, { useEffect, useRef, useState } from 'react';
import { Button, SectionLabel } from '../components/ui';
import { ReportView, reportTitle } from '../components/budget/ReportView';
import { sliceCubeMonths, type ReportCube } from '../../shared/report-cube';
import {
  cycleSize, moveCard, pinHero, POOL_ONLY_REPORT_IDS, resolveBudgetLayout, setSpan,
  SIZE_LABELS, STANDARD_REPORT_IDS, toggleHidden, type BudgetLayout,
} from '../../shared/budget-layout';
import { newCustomReportId, type CustomReport } from '../../shared/report-eval';
import { dropTarget } from './drop-target';
import { ReportBuilder } from '../components/budget/ReportBuilder';
import type { SecretsStore } from '../utils/secrets';

/**
 * The Budget tab: the addon's first and default view, ONE grid since v1.33.0.
 * The old hero row and the fixed stat strip are gone — the big charts are
 * ordinary cards defaulting to 2×2 at the front, the headline numbers are a
 * card of their own, and every card moves, hides, and resizes the same way.
 * That uniformity is the answer to "the top two don't have the corner thing".
 *
 * Two drags in customize mode, both on POINTER CAPTURE (window-level
 * listeners proved fragile inside the sandboxed iframe — v1.32.0's resize
 * "just didn't work" live):
 *  - the corner handle resizes, snapping to the grid rhythm;
 *  - anywhere else on the card picks it up to MOVE, dropping before whatever
 *    card the pointer is over.
 * The buttons remain for phones and keyboards.
 *
 * One range control drives every report at once, on the dashboard itself.
 */
export interface BudgetTabProps {
  cube: ReportCube | null;
  customReports: CustomReport[];
  layout: BudgetLayout | null;
  onLayoutChange: (next: BudgetLayout) => void;
  /** Clears the stored layout entirely — absent on older pages, and the Reset
   *  button simply doesn't render without it. */
  onLayoutReset?: () => void;
  onCustomReportsChange: (next: CustomReport[]) => void;
  store: SecretsStore;
  /** Subscription-card answers, owned by the page like layout is. */
  hiddenSubscriptions?: string[];
  onHiddenSubscriptionsChange?: (next: string[]) => void;
  confirmedSubscriptions?: string[];
  onConfirmedSubscriptionsChange?: (next: string[]) => void;
}

/** Two days: one missed nightly publish is routine, two is worth a strip. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

type Range = number | 'all' | 'pool';
const RANGES: Array<{ label: string; value: Range }> = [
  { label: 'Month', value: 1 },
  { label: '3 months', value: 3 },
  { label: '6 months', value: 6 },
  { label: '12 months', value: 12 },
  { label: 'All', value: 'all' },
];

/** Grid rhythm shared with the stylesheet; the fallbacks cover a cell that
 *  measures 0 (jsdom, or a not-yet-laid-out card). FINE units since v1.35:
 *  12 columns × 29px rows, so a resize drag snaps every ~40px — near-custom
 *  sizes that still reflow as a grid on other screens. */
const GAP = 14;
const ROW_UNIT = 29 + GAP;
const FALLBACK_COL_UNIT = 110;
const MAX_C = 12;
const MAX_R = 16;

export function BudgetTab({
  cube, customReports, layout, onLayoutChange, onLayoutReset, onCustomReportsChange, store,
  hiddenSubscriptions = [], onHiddenSubscriptionsChange,
  confirmedSubscriptions = [], onConfirmedSubscriptionsChange,
}: BudgetTabProps) {
  const [fullId, setFullId] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(12);
  const [customizing, setCustomizing] = useState(false);
  const [builder, setBuilder] = useState<{ existing: CustomReport | null } | null>(null);
  /** Live spans while a corner drag is in flight, by report id. */
  const [dragSpans, setDragSpans] = useState<Record<string, { c: number; r: number }>>({});
  /** Live ordering while a move drag is in flight. */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  /** The floating copy of the picked-up card: measured at pointer-down, then
   *  translated with every move. The grid cell itself becomes the dashed
   *  SLOT — reordering live, it IS the "this is where it lands" indicator. */
  const [ghost, setGhost] = useState<{ id: string; dx: number; dy: number; w: number; h: number } | null>(null);
  /** Ghost position rides a REF and a direct style write, never state: a
   *  re-render of ~20 charts per pointer event is exactly the lag that was
   *  reported live. React re-renders only when the ORDER changes. */
  const ghostPointer = useRef<{ x: number; y: number } | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const resizeState = useRef<{ id: string; startX: number; startY: number; c0: number; r0: number; colUnit: number } | null>(null);
  const moveState = useRef<{ id: string } | null>(null);
  /** Two-tap reset: one mistap must not destroy an arranged board. */
  const [confirmReset, setConfirmReset] = useState(false);
  /** The just-hidden card, so Hide always leaves a way back on screen. */
  const [hiddenToast, setHiddenToast] = useState<string | null>(null);
  /** Pool editing, on the burn-down's own full screen: amount + end date as
   *  typed; parsed on save. Null = not editing. */
  const [poolEdit, setPoolEdit] = useState<{ amount: string; end: string } | null>(null);
  const [poolSaved, setPoolSaved] = useState(false);

  /** FLIP refs: previous on-screen rect per card, so any render that moves a
   *  card (live reorder under a drag, a resize reflowing neighbors) plays a
   *  short glide from where it was — the difference between "cards you can
   *  watch make room" and "cards that teleport". Web Animations API,
   *  optional-called: jsdom (no rects, no animate) degrades to nothing. */
  const cellEls = useRef(new Map<string, HTMLElement>());
  const prevRects = useRef(new Map<string, { left: number; top: number; width: number; height: number }>());
  useEffect(() => {
    for (const [id, el] of cellEls.current) {
      const next = el.getBoundingClientRect();
      const prev = prevRects.current.get(id);
      if (prev && (prev.left !== next.left || prev.top !== next.top)) {
        el.animate?.(
          [{ transform: `translate(${prev.left - next.left}px, ${prev.top - next.top}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 180, easing: 'cubic-bezier(.2, .7, .3, 1)' },
        );
      }
      // Width/height ride along for the drag hit-testing, which reads THIS
      // cache instead of measuring on every pointer move.
      prevRects.current.set(id, { left: next.left, top: next.top, width: next.width, height: next.height });
    }
  });
  const cellRef = (id: string) => (el: HTMLElement | null) => {
    if (el) cellEls.current.set(id, el);
    else { cellEls.current.delete(id); prevRects.current.delete(id); }
  };

  // The undo toast outlives one glance, not the session.
  useEffect(() => {
    if (hiddenToast === null) return undefined;
    const t = setTimeout(() => setHiddenToast(null), 8000);
    return () => clearTimeout(t);
  }, [hiddenToast]);

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
  const gridIds = dragOrder ?? resolved.grid;

  // Order deliberately EMPTY when nothing is stored: a full snapshot here
  // would mark every card "explicitly placed" and defeat pin's front-set
  // semantics. Mutations that need a snapshot (move, drag-drop) take their
  // own from the resolved grid.
  const storedLayout: BudgetLayout = layout ?? {
    heroes: resolved.heroes, order: [], hidden: resolved.hidden,
  };

  const subsProps = {
    hiddenSubscriptions,
    confirmedSubscriptions,
    onHideSubscription: onHiddenSubscriptionsChange
      ? (name: string) => onHiddenSubscriptionsChange([...hiddenSubscriptions.filter((n) => n !== name), name])
      : undefined,
    onConfirmSubscription: onConfirmedSubscriptionsChange
      ? (name: string) => onConfirmedSubscriptionsChange([...confirmedSubscriptions.filter((n) => n !== name), name])
      : undefined,
    onUnhideSubscription: onHiddenSubscriptionsChange
      ? (name: string) => onHiddenSubscriptionsChange(hiddenSubscriptions.filter((n) => n !== name))
      : undefined,
    onRestoreSubscriptions: onHiddenSubscriptionsChange
      ? () => onHiddenSubscriptionsChange([])
      : undefined,
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

  const rangeChips = (
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
        {rangeChips}
        <ReportView id={fullId} cube={viewCube} customReports={customReports} hero density={4} {...subsProps} />
        {fullId === 'pool-burndown' && cube.pool && (
          <div className="sfin-pool-edit">
            {poolEdit === null ? (
              <>
                <Button variant="ghost" onClick={() => {
                  setPoolSaved(false);
                  setPoolEdit({
                    amount: String(cube.pool!.config.amountCents / 100),
                    end: cube.pool!.config.endDate,
                  });
                }}>
                  Edit pool
                </Button>
                {poolSaved && (
                  <span className="sfin-subtle">Saved — the burn-down redraws on the next sync.</span>
                )}
              </>
            ) : (
              <>
                <label className="sfin-subtle">
                  Pool amount{' '}
                  <input
                    aria-label="Pool amount"
                    className="sfin-input"
                    inputMode="decimal"
                    value={poolEdit.amount}
                    onChange={(e) => setPoolEdit({ ...poolEdit, amount: e.target.value })}
                  />
                </label>
                <label className="sfin-subtle">
                  Must last until{' '}
                  <input
                    aria-label="Pool end date"
                    className="sfin-input"
                    type="date"
                    value={poolEdit.end}
                    onChange={(e) => setPoolEdit({ ...poolEdit, end: e.target.value })}
                  />
                </label>
                <Button
                  aria-label="Save pool"
                  onClick={() => {
                    const dollars = Number(poolEdit.amount);
                    if (!Number.isFinite(dollars) || dollars <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(poolEdit.end)) return;
                    // The START date is kept: editing the total or the horizon
                    // is a top-up, not a new semester.
                    store.setSemesterPool?.({
                      amountCents: Math.round(dollars * 100),
                      startDate: cube.pool!.config.startDate,
                      endDate: poolEdit.end,
                    })?.catch(() => {});
                    setPoolEdit(null);
                    setPoolSaved(true);
                  }}
                >
                  Save pool
                </Button>
                <Button variant="ghost" onClick={() => setPoolEdit(null)}>Cancel</Button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  const spanFor = (id: string) => dragSpans[id] ?? resolved.spanOf(id);
  /** Spans ride CSS custom properties, never inline grid-column — the phone
   *  media query has to be able to collapse everything to one column, and an
   *  inline style would outrank it. */
  const cellStyle = (id: string): React.CSSProperties => {
    const { c, r } = spanFor(id);
    return { ['--sfin-c' as never]: String(c), ['--sfin-r' as never]: String(r) };
  };

  const startResize = (id: string) => (down: React.PointerEvent) => {
    down.preventDefault();
    down.stopPropagation();
    try { (down.currentTarget as Element).setPointerCapture?.(down.pointerId); } catch { /* jsdom */ }
    const cell = (down.currentTarget as HTMLElement).closest('.sfin-cell') as HTMLElement | null;
    setResizingId(id);
    const { c: c0, r: r0 } = spanFor(id);
    resizeState.current = {
      id, startX: down.clientX, startY: down.clientY, c0, r0,
      colUnit: cell && cell.offsetWidth > 0 ? cell.offsetWidth / c0 + GAP : FALLBACK_COL_UNIT,
    };
  };
  type ResizeState = NonNullable<typeof resizeState.current>;
  const spanFrom = (st: ResizeState, e: React.PointerEvent) => ({
    c: Math.min(MAX_C, Math.max(1, st.c0 + Math.round((e.clientX - st.startX) / st.colUnit))),
    r: Math.min(MAX_R, Math.max(1, st.r0 + Math.round((e.clientY - st.startY) / ROW_UNIT))),
  });
  const onResizeMove = (e: React.PointerEvent) => {
    const st = resizeState.current;
    if (!st) return;
    setDragSpans((prev) => ({ ...prev, [st.id]: spanFrom(st, e) }));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    const st = resizeState.current;
    if (!st) return;
    // Read the drop position from the CAPTURED state, then clear it — the
    // first build cleared first and read second, which threw mid-drop and
    // silently dropped the resize.
    const { c, r } = spanFrom(st, e);
    resizeState.current = null;
    setResizingId(null);
    setDragSpans((prev) => {
      const next = { ...prev };
      delete next[st.id];
      return next;
    });
    if (c !== st.c0 || r !== st.r0) onLayoutChange(setSpan(storedLayout, st.id, c, r));
  };

  const startMove = (id: string) => (down: React.PointerEvent) => {
    // Buttons and the resize handle own their own taps.
    if ((down.target as HTMLElement).closest('button, .sfin-resize-handle')) return;
    down.preventDefault();
    try { (down.currentTarget as Element).setPointerCapture?.(down.pointerId); } catch { /* jsdom */ }
    moveState.current = { id };
    setDraggingId(id);
    setDragOrder(gridIds);
    // Measure BEFORE the slot styling lands; jsdom measures 0, so the ghost
    // falls back to a readable card.
    const rect = (down.currentTarget as HTMLElement).getBoundingClientRect();
    setGhost({
      id,
      dx: rect.width > 0 ? down.clientX - rect.left : 40,
      dy: rect.height > 0 ? down.clientY - rect.top : 24,
      w: rect.width || 320,
      h: rect.height || 180,
    });
    ghostPointer.current = { x: down.clientX, y: down.clientY };
  };
  const onMoveOver = (e: React.PointerEvent) => {
    const st = moveState.current;
    if (!st) return;
    ghostPointer.current = { x: e.clientX, y: e.clientY };
    if (ghostRef.current && ghost) {
      ghostRef.current.style.transform =
        `translate(${e.clientX - ghost.dx}px, ${e.clientY - ghost.dy}px) scale(1.02) rotate(.4deg)`;
    }
    // Geometry over the FLIP cache — the whole cell is a target, no reads per
    // move. jsdom's zero rects fall back to elementFromPoint (before-only).
    const cached = Array.from(prevRects.current, ([id, r]) => ({ id, ...r }));
    const hit = dropTarget(cached, e.clientX, e.clientY, st.id);
    let over: string | null = hit?.id ?? null;
    let after = hit?.after ?? false;
    if (!over) {
      over = document.elementFromPoint?.(e.clientX, e.clientY)
        ?.closest('[data-report-id]')?.getAttribute('data-report-id') ?? null;
      after = false;
    }
    if (!over || over === st.id) return;
    setDragOrder((prev) => {
      const current = prev ?? gridIds;
      const base = current.filter((g) => g !== st.id);
      let at = base.indexOf(over!);
      if (at === -1) return prev;
      if (after) at += 1;
      base.splice(at, 0, st.id);
      // Identical order = no state churn = no re-render mid-drag.
      return base.join('\u0000') === current.join('\u0000') ? prev : base;
    });
  };
  const onMoveUp = () => {
    const st = moveState.current;
    if (!st) return;
    moveState.current = null;
    setDraggingId(null);
    setGhost(null);
    ghostPointer.current = null;
    const finalOrder = dragOrder;
    setDragOrder(null);
    if (finalOrder && finalOrder.join(' ') !== resolved.grid.join(' ')) {
      onLayoutChange({ ...storedLayout, order: finalOrder });
    }
  };

  const controls = (id: string) => {
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
        <Button
          variant="ghost"
          aria-label={`Hide ${title}`}
          onClick={() => {
            onLayoutChange(toggleHidden(storedLayout, availableIds, id));
            setHiddenToast(id);
          }}
        >
          Hide
        </Button>
      </div>
    );
  };

  const card = (id: string) => customizing ? (
    <div
      key={id}
      ref={cellRef(id)}
      className={`sfin-cell sfin-cell--${resolved.sizeOf(id)} sfin-cell--editing${draggingId === id ? ' sfin-cell--dragging' : ''}${resizingId === id ? ' sfin-cell--resizing' : ''}`}
      style={cellStyle(id)}
      onPointerDown={startMove(id)}
      onPointerMove={onMoveOver}
      onPointerUp={onMoveUp}
    >
      <ReportView id={id} cube={viewCube} customReports={customReports} density={Math.max(1, Math.round(spanFor(id).r / 4))} {...subsProps} />
      {controls(id)}
      <div
        className="sfin-resize-handle"
        role="button"
        tabIndex={0}
        aria-label={`Drag to resize ${reportTitle(id, customReports)}`}
        title="Drag: right to widen, down to grow"
        onPointerDown={startResize(id)}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
      />
    </div>
  ) : (
    <div
      key={id}
      ref={cellRef(id)}
      className={`sfin-cell sfin-cell--${resolved.sizeOf(id)}`}
      style={cellStyle(id)}
      role="button"
      tabIndex={0}
      aria-label={`Open ${reportTitle(id, customReports)}`}
      // A card can carry its own buttons now (the subscription answers);
      // those taps must not ALSO drill in.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        setFullId(id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFullId(id); }
      }}
    >
      <ReportView id={id} cube={viewCube} customReports={customReports} density={Math.max(1, Math.round(spanFor(id).r / 4))} {...subsProps} />
    </div>
  );

  return (
    <>
      {staleStrip}

      <div className="sfin-budget-toolbar">
        {rangeChips}
        <div className="sfin-toolbar-actions">
          {customizing && layout !== null && onLayoutReset && (
            <Button
              variant="ghost"
              onClick={() => {
                if (!confirmReset) { setConfirmReset(true); return; }
                setConfirmReset(false);
                onLayoutReset();
              }}
            >
              {confirmReset ? 'Really reset?' : 'Reset layout'}
            </Button>
          )}
          <Button variant="ghost" onClick={() => { setCustomizing((c) => !c); setConfirmReset(false); }}>
            {customizing ? 'Done customizing' : 'Customize'}
          </Button>
        </div>
      </div>

      {hiddenToast !== null && (
        <div className="sfin-toast" role="status">
          <span>Hidden {reportTitle(hiddenToast, customReports)}</span>
          <Button
            variant="ghost"
            aria-label="Undo hide"
            onClick={() => {
              onLayoutChange(toggleHidden(storedLayout, availableIds, hiddenToast));
              setHiddenToast(null);
            }}
          >
            Undo
          </Button>
        </div>
      )}

      {ghost && (
        <div
          ref={ghostRef}
          className="sfin-drag-ghost"
          style={{
            left: 0,
            top: 0,
            width: ghost.w,
            height: ghost.h,
            transform: `translate(${(ghostPointer.current?.x ?? 0) - ghost.dx}px, ${(ghostPointer.current?.y ?? 0) - ghost.dy}px) scale(1.02) rotate(.4deg)`,
          }}
        >
          <ReportView
            id={ghost.id}
            cube={viewCube}
            customReports={customReports}
            density={Math.max(1, Math.round(spanFor(ghost.id).r / 4))}
            {...subsProps}
          />
        </div>
      )}

      <div className="sfin-budget-grid">
        {gridIds.map((id) => card(id))}
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
