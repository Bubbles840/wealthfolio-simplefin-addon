/**
 * src/components/ChangeLogCard.tsx
 *
 * The change log in the app (Settings → Sync): every write the sync, the
 * companion and you made, the same entries `/changes` shows — the words come
 * from the entries' own summaries and shared/change-view.ts.
 *
 * Filters: account, kind group, 7 / 30 / 90 days, search. Rows by day: time,
 * summary, account, amount; a row opens to why, before → after, and who. One
 * sync run's imports are one row that opens to its transactions. Bookkeeping
 * shows only under Background.
 *
 * R2: an opened row offers Undo or Redo — no confirmation; the result is said
 * under it, and after a sync decision "Takes effect on the next sync." beside
 * Sync now. A category or rule entry says to undo it from Telegram (the add-on
 * cannot reach categories). An undone row is muted, "Undone by you <date>".
 * "Your overrides" at the bottom lists what Undo told the sync not to do, each
 * with Remove.
 *
 * Bank text is rendered as React text, never as markup. No emoji in app copy
 * (src/pages/copy-policy.test.tsx).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from './ui';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import { undoAvailability, UNDO_TAKES_EFFECT, UNDO_UNREACHABLE, type UndoOp } from '../../shared/change-undo';
import type { UndoOutcome } from '../../shared/change-undo-run';
import { overrideRows, type LoadedSyncOverrides, type OverrideRow } from '../../shared/sync-overrides';
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
export const OVERRIDES_TITLE = 'Your overrides';
export const OVERRIDES_EMPTY = 'None. The sync decides everything.';
export const OVERRIDES_UNREADABLE = "Your sync overrides can't be read, so they can't be changed here.";
export const OVERRIDES_READ_FAILED = 'Could not read your overrides — reload the page to try again.';
export const OVERRIDE_REMOVED = 'Removed. The next sync decides again.';
const DAY_CHOICES = [7, 30, 90] as const;
type Days = (typeof DAY_CHOICES)[number];
type GroupFilter = 'all' | ChangeGroup;

export interface ChangeLogCardProps {
  /** `store.getChangeLog` — null when the read failed. */
  load: () => Promise<ChangeLogRead | null>;
  now?: () => Date;
  /** R2: undo or redo one entry (`undoFromApp`). Absent: read-only. */
  undo?: (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => Promise<UndoOutcome>;
  /** The companion's published version: null when none runs. */
  companionVersion?: string | null;
  /** Sync now, the Sync page's own run; resolves the sentence to show. */
  onSyncNow?: () => Promise<string>;
  /** "Your overrides": `store.readSyncOverrides` (null when the read failed). */
  loadOverrides?: () => Promise<LoadedSyncOverrides | null>;
  removeOverride?: (row: OverrideRow) => Promise<void>;
}

/** What the card can do with a row, from the card's props. */
interface RowActions {
  undo?: ChangeLogCardProps['undo'];
  companionVersion: string | null;
  entries: ChangeLogItem[];
  onSyncNow?: () => Promise<string>;
  /** After an undo: re-read the log and the overrides. */
  changed: () => void;
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

/** The Undo/Redo line under an opened row (R2). */
function UndoControls({ entry, actions }: { entry: ChangeLogItem; actions: RowActions }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UndoOutcome | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  if (!actions.undo) return null;
  const available = undoAvailability(entry, { host: 'addon', companionVersion: actions.companionVersion });
  if (available.kind === 'none' && !result) return null;
  const run = async (op: UndoOp) => {
    setBusy(true);
    setSynced(null);
    try {
      setResult(await actions.undo!(entry, actions.entries, op));
    } catch {
      setResult({ ok: false, message: UNDO_UNREACHABLE });
    } finally {
      setBusy(false);
      actions.changed();
    }
  };
  const syncNow = async () => {
    if (!actions.onSyncNow) return;
    setBusy(true);
    try {
      setSynced(await actions.onSyncNow());
    } catch (e: any) {
      setSynced(`The sync failed: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false);
      actions.changed();
    }
  };
  return (
    <div className="sfin-log-undo">
      {available.kind === 'ready' && (
        <Button variant="ghost" disabled={busy} onClick={() => run(available.op)}>
          {available.op === 'undo' ? 'Undo' : 'Redo'}
        </Button>
      )}
      {available.kind === 'update-companion' && (
        <>
          <Button variant="ghost" disabled>Undo</Button>
          <span className="sfin-subtle">{available.text}</span>
        </>
      )}
      {available.kind === 'telegram' && <span className="sfin-subtle">{available.text}</span>}
      {result && <div className={result.ok ? 'sfin-log-result' : 'sfin-log-result sfin-log-result--refused'}>{result.message}</div>}
      {result?.ok && result.needsSync && (
        <div className="sfin-log-result">
          {UNDO_TAKES_EFFECT}{' '}
          {actions.onSyncNow && <Button variant="ghost" disabled={busy} onClick={syncNow}>Sync now</Button>}
        </div>
      )}
      {synced && <div className="sfin-subtle">{synced}</div>}
    </div>
  );
}

function EntryDetail({ entry, actions }: { entry: ChangeLogItem; actions: RowActions }) {
  const beforeAfter = changeBeforeAfter(entry);
  return (
    <div className="sfin-log-detail">
      {entry.why && <div>Why: {entry.why}</div>}
      {beforeAfter && <div>Before → after: {beforeAfter}</div>}
      <div className="sfin-subtle">{changeSourceText(entry)} · {shortDateTime(entry.at)}</div>
      {entry.undone && <div className="sfin-subtle">Undone by you {shortDateTime(entry.undone.at)}</div>}
      <UndoControls entry={entry} actions={actions} />
    </div>
  );
}

function Row({ row, actions }: { row: ChangeRow; actions: RowActions }) {
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
        <span className="sfin-log-summary">
          {changeRowSummary(row)}
          {entry?.undone && <span className="sfin-log-undone"> · Undone by you {changeDay(changeLocalDay(entry.undone.at))}</span>}
        </span>
        <span className="sfin-log-account">{entry ? changeAccountText(entry) : ''}</span>
        <span className="sfin-log-amount">{entry ? changeAmountText(entry) : ''}</span>
      </button>
      {open && entry && <EntryDetail entry={entry} actions={actions} />}
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

/** "Your overrides": what Undo told the sync not to do, each with Remove. */
function OverridesList({ load, remove, version }: {
  load: () => Promise<LoadedSyncOverrides | null>;
  remove?: (row: OverrideRow) => Promise<void>;
  version: number;
}) {
  const [doc, setDoc] = useState<LoadedSyncOverrides | null | 'loading'>('loading');
  const [note, setNote] = useState<string | null>(null);
  const [mine, setMine] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => { if (live) setDoc(d); }).catch(() => { if (live) setDoc(null); });
    return () => { live = false; };
  }, [load, version, mine]);
  if (doc === 'loading') return null;
  const rows = doc ? overrideRows(doc.overrides) : [];
  const onRemove = async (row: OverrideRow) => {
    try {
      await remove!(row);
      setNote(OVERRIDE_REMOVED);
    } catch (e: any) {
      setNote(String(e?.message ?? e));
    }
    setMine((n) => n + 1);
  };
  return (
    <div className="sfin-log-overrides">
      <div className="sfin-log-overrides-title">{OVERRIDES_TITLE}</div>
      {doc === null ? (
        <div className="sfin-subtle">{OVERRIDES_READ_FAILED}</div>
      ) : doc.unreadable ? (
        <div className="sfin-log-note">{OVERRIDES_UNREADABLE}</div>
      ) : rows.length === 0 ? (
        <div className="sfin-subtle">{OVERRIDES_EMPTY}</div>
      ) : (
        rows.map((r) => (
          <div key={`${r.scope}:${r.key}:${r.flag}`} className="sfin-log-override">
            <span className="sfin-log-summary">{r.text}</span>
            {remove && <Button variant="ghost" onClick={() => onRemove(r)}>Remove</Button>}
          </div>
        ))
      )}
      {note && <div className="sfin-subtle">{note}</div>}
    </div>
  );
}

export function ChangeLogCard({
  load, now = () => new Date(), undo, companionVersion = null, onSyncNow, loadOverrides, removeOverride,
}: ChangeLogCardProps) {
  const [read, setRead] = useState<ChangeLogRead | null | 'loading'>('loading');
  const [account, setAccount] = useState('');
  const [group, setGroup] = useState<GroupFilter>('all');
  const [days, setDays] = useState<Days>(30);
  const [query, setQuery] = useState('');
  // Bumped after an undo, a redo or a sync: the log and the overrides re-read.
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    load().then((r) => { if (live) setRead(r); }).catch(() => { if (live) setRead(null); });
    return () => { live = false; };
  }, [load, version]);

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
  const actions: RowActions = { undo, companionVersion, entries, onSyncNow, changed };

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
              <Row key={row.kind === 'entry' ? row.entry.id : `run:${row.run}`} row={row} actions={actions} />
            ))}
          </div>
        ))
      )}
      {hiddenBackground > 0 && (
        <div className="sfin-subtle sfin-log-hidden">
          {hiddenBackground} background {hiddenBackground === 1 ? 'change' : 'changes'} not shown — Background lists {hiddenBackground === 1 ? 'it' : 'them'}.
        </div>
      )}
      {loadOverrides && <OverridesList load={loadOverrides} remove={removeOverride} version={version} />}
    </div>
  );
}
