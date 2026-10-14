import React from 'react';
import { SectionLabel } from './ui';
import {
  FORECAST_BILLS_LABEL, FORECAST_NO_BILLS, FORECAST_TITLE, forecastAccountLine, forecastAssumption, forecastBillLine,
  forecastCashLine, forecastHeadline, forecastMissingLine, forecastTileSub, forecastTileValue, type ForecastView,
} from '../../shared/cash-forecast';

/**
 * Home's "Next 30 days" (project 5 R1, spec A): the companion's cash forecast,
 * "if nothing comes in". With a forecast the tile is a disclosure that opens
 * what it counted in place, under the strip (no new route); without one it
 * says why — update the companion, the next sync, could not read it, or the
 * reason the companion gave — and with nothing published and no companion it
 * is not there at all. Every line is shared/cash-forecast.ts's; bank text is
 * rendered as text.
 */
export function ForecastTile({ view, open, panelId, onToggle }: {
  view: ForecastView;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  if (view.state === 'hidden') return null;
  if (view.state !== 'ok') {
    return (
      <div className="sfin-tile">
        <SectionLabel>{FORECAST_TITLE}</SectionLabel>
        <div className="sfin-tile-val">—</div>
        <div className="sfin-tile-sub">{view.line}</div>
      </div>
    );
  }
  const f = view.forecast;
  return (
    <button
      type="button"
      className="sfin-tile sfin-tile--toggle"
      aria-expanded={open}
      // Only points at the panel while the panel exists.
      {...(open ? { 'aria-controls': panelId } : {})}
      aria-label={`${FORECAST_TITLE}: ${forecastHeadline(f)}${view.stale ? `. ${view.status}` : ''}`}
      onClick={onToggle}
    >
      <div className="sfin-tile-head">
        <SectionLabel>{FORECAST_TITLE}</SectionLabel>
        <span className="sfin-chevron" data-open={open} aria-hidden>▼</span>
      </div>
      <div className={`sfin-tile-val${f.shortDate ? ' sfin-forecast-short' : ''}`}>{forecastTileValue(f)}</div>
      <div className="sfin-tile-sub">{forecastTileSub(f)}</div>
      {view.stale && <div className="sfin-tile-sub sfin-forecast-stale">{view.status}</div>}
    </button>
  );
}

/** What the forecast counted: the cash (and any account left out), the bills
 *  on their dates, the assumption, and when it was made. */
export function ForecastDetail({ view, id }: { view: Extract<ForecastView, { state: 'ok' }>; id: string }) {
  const f = view.forecast;
  return (
    <section id={id} className="sfin-card sfin-forecast" aria-label={FORECAST_TITLE}>
      <div className="sfin-forecast-head">{forecastHeadline(f)}</div>
      <div>{forecastCashLine(f)}</div>
      <ul className="sfin-forecast-list">
        {f.accounts.map((a, i) => <li key={`a${i}`}>{forecastAccountLine(a, f)}</li>)}
        {(f.missing ?? []).map((name, i) => <li key={`m${i}`} className="sfin-forecast-missing">{forecastMissingLine(name)}</li>)}
      </ul>
      <SectionLabel>{FORECAST_BILLS_LABEL}</SectionLabel>
      {f.bills.length === 0
        ? <div className="sfin-subtle">{FORECAST_NO_BILLS}</div>
        : (
          <ul className="sfin-forecast-list">
            {f.bills.map((b, i) => <li key={`b${i}`}>{forecastBillLine(b)}</li>)}
          </ul>
        )}
      <p className="sfin-forecast-assume">{forecastAssumption(f)}</p>
      <div className={`sfin-forecast-status${view.stale ? ' sfin-forecast-status--stale' : ''}`} role="status">{view.status}</div>
    </section>
  );
}
