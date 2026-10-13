/**
 * src/components/ChangeLogCard.tsx
 *
 * The change log in the app (Settings → Sync), read-only in R1: every write
 * the sync, the companion and you made, the same entries `/changes` shows —
 * the words come from the entries' own summaries and shared/change-view.ts.
 *
 * Filters: account, kind group, 7 / 30 / 90 days, search. Rows by day: time,
 * summary, account, amount; a row opens to why, before → after, and who. One
 * sync run's imports are one row that opens to its transactions. Bookkeeping
 * shows only under Background.
 *
 * Bank text is rendered as React text, never as markup. No emoji in app copy
 * (src/pages/copy-policy.test.tsx).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from './ui';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import { changeDay } from '../../shared/change-entries';
import { shortDateTime } from '../../shared/telegram';
import {
  CHANGE_GROUP_LABELS, CHANGE_GROUPS, changeAccountNames, changeAccountText, changeAmountText, changeBeforeAfter,
  changeClock, changeGroupOf, changeLocalDay, changeLogNotes, changeRowAt, changeRows, changeRowSummary,
  changeSourceText, changesWithin, isBackground, matchesChangeSearch, type ChangeGroup, type ChangeRow,
} from '../../shared/change-view';

export const CHANGE_LOG_READ_FAILED = 'Could not read the change log — reload the page to try again.';
export const CHANGE_LOG_EMPTY = 'Nothing recorded yet. Changes show here after the next sync.';
export const CHANGE_LOG_NO_MATCH = 'Nothing matches these filters.';
const DAY_CHOICES = [7, 30, 90] as const;
type Days = (typeof DAY_CHOICES)[number];
type GroupFilter = 'all' | ChangeGroup;

export interface ChangeLogCardProps {
  /** `store.getChangeLog` — null when the read failed. */
  load: () => Promise<ChangeLogRead | null>;
  now?: () => Date;
}

/** The entries the filters let through, newest first. */
export function filterChanges(
  entries: readonly ChangeLogItem[],
  f: { account: string; group: GroupFilter; days: number; query: string },
  now: Date,
): ChangeLogItem[] {
  return changesWithin(entries, now, f.days).filter((e) => {
    // Bookkeeping is never searched (as /changes does): words match real changes only.
    if (f.query.trim() && isBackground(e)) return false;
    if (f.group === 'all' ? isBackground(e) : changeGroupOf(e.kind) !== f.group) return false;
    if (f.account && !changeAccountNames(e).includes(f.account)) return false;
    return matchesChangeSearch(e, f.query);
  });
}

function EntryDetail({ entry }: { entry: ChangeLogItem }) {
  const beforeAfter = changeBeforeAfter(entry);
  return (
    <div className="sfin-log-detail">
      {entry.why && <div>Why: {entry.why}</div>}
      {beforeAfter && <div>Before → after: {beforeAfter}</div>}
      <div className="sfin-subtle">{changeSourceText(entry)} · {shortDateTime(entry.at)}</div>
      {entry.undone && <div className="sfin-subtle">Undone {shortDateTime(entry.undone.at)}</div>}
    </div>
  );
}

function Row({ row }: { row: ChangeRow }) {
  const [open, setOpen] = useState(false);
  const entry = row.kind === 'entry' ? row.entry : null;
  return (
    <div className="sfin-log-item">
      <button
        type="button"
        className={`sfin-log-row${entry?.undone ? ' sfin-log-row--undone' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sfin-log-time">{changeClock(changeRowAt(row))}</span>
        <span className="sfin-log-summary">{changeRowSummary(row)}{entry?.undone ? ' (undone)' : ''}</span>
        <span className="sfin-log-account">{entry ? changeAccountText(entry) : ''}</span>
        <span className="sfin-log-amount">{entry ? changeAmountText(entry) : ''}</span>
      </button>
      {open && entry && <EntryDetail entry={entry} />}
      {open && row.kind === 'run' && (
        <div className="sfin-log-detail">
          {row.entries.map((e) => (
            <div key={e.id} className="sfin-log-run-line">
              <span className="sfin-log-time">{changeClock(e.at)}</span>
              <span className="sfin-log-summary">{e.summary}</span>
              <span className="sfin-log-account">{changeAccountText(e)}</span>
              <span className="sfin-log-amount">{changeAmountText(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChangeLogCard({ load, now = () => new Date() }: ChangeLogCardProps) {
  const [read, setRead] = useState<ChangeLogRead | null | 'loading'>('loading');
  const [account, setAccount] = useState('');
  const [group, setGroup] = useState<GroupFilter>('all');
  const [days, setDays] = useState<Days>(30);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    load().then((r) => { if (live) setRead(r); }).catch(() => { if (live) setRead(null); });
    return () => { live = false; };
  }, [load]);

  const at = now();
  const entries = read && read !== 'loading' ? read.entries : [];
  const accounts = useMemo(
    () => [...new Set(entries.flatMap((e) => changeAccountNames(e)))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const shown = filterChanges(entries, { account, group, days, query }, at);
  const hiddenBackground = group === 'all'
    ? filterChanges(entries, { account, group: 'background', days, query }, at).length
    : 0;
  const rows = changeRows(shown);

  if (read === 'loading') return <div className="sfin-subtle">Loading…</div>;
  if (read === null) return <div className="sfin-log-note">{CHANGE_LOG_READ_FAILED}</div>;

  const byDay: Array<{ day: string; rows: ChangeRow[] }> = [];
  for (const row of rows) {
    const day = changeLocalDay(changeRowAt(row));
    const last = byDay[byDay.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else byDay.push({ day, rows: [row] });
  }

  return (
    <div className="sfin-log">
      {changeLogNotes(read).map((n, i) => <div key={`${i}:${n}`} className="sfin-log-note">{n}</div>)}
      <div className="sfin-log-filters">
        <Select aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        <div className="sfin-range-chips" role="group" aria-label="Kind">
          {(['all', ...CHANGE_GROUPS] as GroupFilter[]).map((g) => (
            <Button key={g} variant="ghost" aria-pressed={group === g} onClick={() => setGroup(g)}>
              {g === 'all' ? 'All' : CHANGE_GROUP_LABELS[g]}
            </Button>
          ))}
        </div>
        <div className="sfin-range-chips" role="group" aria-label="Period">
          {DAY_CHOICES.map((d) => (
            <Button key={d} variant="ghost" aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</Button>
          ))}
        </div>
        <div className="sfin-log-search">
          <Input
            type="search"
            aria-label="Search changes"
            placeholder="Search descriptions, accounts, categories"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {entries.length === 0 ? (
        <div className="sfin-subtle">{CHANGE_LOG_EMPTY}</div>
      ) : rows.length === 0 ? (
        <div className="sfin-subtle">{CHANGE_LOG_NO_MATCH}</div>
      ) : (
        byDay.map(({ day, rows: dayRows }) => (
          <div key={day} className="sfin-log-group">
            <div className="sfin-log-day">{changeDay(day)}</div>
            {dayRows.map((row) => (
              <Row key={row.kind === 'entry' ? row.entry.id : `run:${row.run}`} row={row} />
            ))}
          </div>
        ))
      )}
      {hiddenBackground > 0 && (
        <div className="sfin-subtle sfin-log-hidden">
          {hiddenBackground} background {hiddenBackground === 1 ? 'change' : 'changes'} not shown — Background lists {hiddenBackground === 1 ? 'it' : 'them'}.
        </div>
      )}
    </div>
  );
}
