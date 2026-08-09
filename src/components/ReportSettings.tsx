import React from 'react';
import { CollapsibleCard, SectionLabel } from './ui';
import { DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS } from '../../shared/sync-core';
import {
  NOTIF_CARD,
  DEFAULT_WEEKLY_TOP_SPEND_COUNT,
  SUGGESTED_LARGE_TX_THRESHOLD,
  thresholdToSave,
} from '../tabs/NotificationsTab';
import type { TelegramCfgDraft, CfgPatch } from '../tabs/NotificationsTab';

interface Props {
  cfg: TelegramCfgDraft;
  onChange: (patch: CfgPatch) => void;
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

/**
 * Which reports get sent, and the amounts that trigger an alert.
 *
 * The two halves share a card because they answer one question — "what do I want
 * told about?" — and because the alert amounts are meaningless without the
 * reports they ride in. What they are NOT is the same question as which
 * categories those reports cover, which is why that matrix is now its own card.
 */
export function ReportSettings({ cfg, onChange, isOpen, toggleCard }: Props) {
  const activeReports = [
    cfg.dailyReportEnabled && 'daily',
    cfg.weeklyReportEnabled && 'weekly',
    cfg.monthlyReportEnabled && 'monthly',
  ].filter((r): r is string => typeof r === 'string');

  // Only the non-default alert states earn a slot: large-tx alerts are off
  // unless asked for, drift alerts are on unless refused, so these two segments
  // are exactly the settings you would forget you had changed.
  const summary = [
    activeReports.length > 0 ? `${activeReports.join(', ')} reports` : 'no reports',
    cfg.largeTxAlerts
      ? `$${thresholdToSave(true, cfg.largeTxAmount, SUGGESTED_LARGE_TX_THRESHOLD)}+ alerts`
      : null,
    cfg.driftAlertsOn ? null : 'balance alerts off',
  ]
    .filter((s): s is string => typeof s === 'string')
    .join(' · ');

  return (
    <CollapsibleCard
      id={NOTIF_CARD.reports}
      title="Reports"
      summary={summary}
      open={isOpen(NOTIF_CARD.reports)}
      onToggle={() => toggleCard(NOTIF_CARD.reports)}
    >
      <div className="sfin-stack">
        <div className="sfin-checks">
          <label className="sfin-check">
            <input
              type="checkbox"
              checked={cfg.notifyOnImport}
              onChange={(e) => onChange({ notifyOnImport: e.target.checked })}
            />
            <span>Transaction import alerts (instant when new transactions sync)</span>
          </label>
          <label className="sfin-check">
            <input
              type="checkbox"
              checked={cfg.dailyReportEnabled}
              onChange={(e) => onChange({ dailyReportEnabled: e.target.checked })}
            />
            <span>Daily category allowance report (morning)</span>
          </label>
          <label className="sfin-check">
            <input
              type="checkbox"
              checked={cfg.weeklyReportEnabled}
              onChange={(e) => onChange({ weeklyReportEnabled: e.target.checked })}
            />
            <span>Weekly budget &amp; spending summary</span>
          </label>
          <label className="sfin-check">
            <input
              type="checkbox"
              checked={cfg.monthlyReportEnabled}
              onChange={(e) => onChange({ monthlyReportEnabled: e.target.checked })}
            />
            <span>Monthly wrap-up (on the 1st, for the month just ended)</span>
          </label>
        </div>

        <div className="sfin-divider" />
        <SectionLabel>Alerts &amp; amounts</SectionLabel>

        <div className="sfin-nums">
          <div className="sfin-thresh">
            {/* Its own checkbox, matching the two rows below. `0` still means
                "hide the section" to every reader, so this control and typing 0
                are two spellings of one stored value — but three sibling rows
                where only one lacked the neighbours' control read as broken,
                whatever the logic underneath said. */}
            <label className="sfin-check">
              <input
                type="checkbox"
                checked={cfg.topSpendsOn}
                onChange={(e) => onChange({ topSpendsOn: e.target.checked })}
              />
              <span className="sfin-check-name">Biggest spends in the weekly report</span>
            </label>
            <div className="sfin-thresh-amt">
              <input
                id="sfin-top-spend"
                type="number"
                min={0}
                step={1}
                className="sfin-select sfin-num"
                // Its own accessible name, for the same reason the two threshold
                // fields have one: the visible row label now belongs to the
                // checkbox beside it.
                aria-label="How many biggest spends to list"
                value={cfg.topSpendCount}
                disabled={!cfg.topSpendsOn}
                onChange={(e) => onChange({ topSpendCount: e.target.value })}
              />
            </div>
          </div>
          <div className="sfin-num-hint sfin-subtle">
            How many individual charges the Saturday report lists. Untick to
            leave the section out — as does a count of 0; blank means the
            default of {DEFAULT_WEEKLY_TOP_SPEND_COUNT}.
          </div>

          <div className="sfin-thresh">
            <label className="sfin-check">
              <input
                type="checkbox"
                checked={cfg.largeTxAlerts}
                onChange={(e) => onChange({ largeTxAlerts: e.target.checked })}
              />
              <span className="sfin-check-name">Large transaction alerts</span>
            </label>
            <div className="sfin-thresh-amt">
              <span className="sfin-subtle" aria-hidden>over $</span>
              <input
                type="number"
                min={1}
                step={1}
                className="sfin-select sfin-num"
                // A distinct aria-label: both threshold fields would otherwise
                // share the visible "over $" and be indistinguishable by name.
                aria-label="Large transaction alert threshold in dollars"
                value={cfg.largeTxAmount}
                disabled={!cfg.largeTxAlerts}
                onChange={(e) => onChange({ largeTxAmount: e.target.value })}
              />
            </div>
          </div>
          <div className="sfin-num-hint sfin-subtle">
            Announces a single newly-imported spend over this amount. Off until
            you turn it on.
          </div>

          <div className="sfin-thresh">
            <label className="sfin-check">
              <input
                type="checkbox"
                checked={cfg.driftAlertsOn}
                onChange={(e) => onChange({ driftAlertsOn: e.target.checked })}
              />
              <span className="sfin-check-name" title="Called a balance-drift alert in the logs and in the Telegram message itself">Balance difference alerts</span>
            </label>
            <div className="sfin-thresh-amt">
              <span className="sfin-subtle" aria-hidden>over $</span>
              <input
                type="number"
                min={1}
                step={1}
                className="sfin-select sfin-num"
                aria-label="Balance difference alert threshold in dollars"
                value={cfg.driftAmount}
                disabled={!cfg.driftAlertsOn}
                onChange={(e) => onChange({ driftAmount: e.target.value })}
              />
            </div>
          </div>
          <div className="sfin-num-hint sfin-subtle">
            Announces an account whose bank balance and Wealthfolio valuation
            differ by more than this. On at ${DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS}{' '}
            unless you untick it — clearing the amount alone will not turn it off.
          </div>
        </div>
      </div>
    </CollapsibleCard>
  );
}
