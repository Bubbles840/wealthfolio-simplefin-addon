import React from 'react';
import { CheckIcon } from './ui';
import type { TabId } from './Tabs';

interface Row {
  done: boolean;
  label: string;
  doneLabel: string;
  tab: TabId;
}

/**
 * First-run guidance without a wizard: three optional features, each row
 * self-completing from a real signal (companion secret, saved telegram config,
 * saved amazon config) rather than from "did the user click through a step".
 * Never blocks anything; gone once complete or dismissed.
 */
export function SetupChecklist({
  companionVersion, telegramConfigured, amazonConfigured, dismissed, onDismiss, onNavigate,
}: {
  companionVersion: string | null;
  telegramConfigured: boolean;
  amazonConfigured: boolean;
  dismissed: boolean;
  onDismiss: () => void;
  onNavigate: (tab: TabId) => void;
}) {
  const rows: Row[] = [
    {
      done: !!companionVersion,
      label: 'Background sync — keep syncing when Wealthfolio is closed',
      doneLabel: `Background sync — companion v${companionVersion} connected`,
      tab: 'advanced',
    },
    {
      done: telegramConfigured,
      label: 'Telegram reports — get a daily digest',
      doneLabel: 'Telegram reports — connected',
      tab: 'notifications',
    },
    {
      done: amazonConfigured,
      label: 'Amazon categorization — label Amazon charges automatically',
      doneLabel: 'Amazon categorization — on',
      tab: 'advanced',
    },
  ];
  if (dismissed || rows.every((r) => r.done)) return null;

  return (
    <div className="sfin-card sfin-checklist">
      <div className="sfin-checklist-head">
        <b>Finish setting up</b>
        <button type="button" className="sfin-checklist-x" aria-label="Dismiss setup checklist" onClick={onDismiss}>
          ×
        </button>
      </div>
      {rows.map((r) => (
        <div className="sfin-checklist-row" key={r.tab + r.label}>
          <span className={r.done ? 'sfin-checklist-dot sfin-checklist-dot--done' : 'sfin-checklist-dot'} aria-hidden>
            {r.done ? <CheckIcon /> : null}
          </span>
          <span className="sfin-checklist-label">{r.done ? r.doneLabel : r.label}</span>
          {!r.done && (
            <button type="button" className="sfin-checklist-link" onClick={() => onNavigate(r.tab)}>
              Set up →
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
