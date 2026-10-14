/**
 * src/components/TxStory.tsx
 *
 * One transaction's story in the app (shared/tx-story.ts): the title and the
 * account, the few lines that answer "why", then What happened — each line a
 * button that opens, in place, the Change log card's own entry detail with its
 * Undo, Redo and Sync now (`EntryDetail`, exported from ChangeLogCard.tsx, not
 * a copy). Read-only otherwise: any change goes through that Undo.
 *
 * `TxStoryPanel` loads a story and reads it again after an Undo; a re-read that
 * fails keeps the story on screen and says so. Bank text renders as React
 * text. No emoji in app copy (src/pages/copy-policy.test.tsx).
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { ChangeLogItem } from '../../shared/change-log';
import type { UndoOp } from '../../shared/change-undo';
import type { UndoOutcome } from '../../shared/change-undo-run';
import {
  TX_STORY_GONE_APP, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory,
} from '../../shared/tx-story';
import { EntryDetail, syncNowSentence, type RowActions } from './ChangeLogCard';
import { undoFromApp } from '../utils/change-undo';
import { runSync } from '../utils/sync';
import type { SecretsStore } from '../utils/secrets';
import type { AppStoryOutcome, AppStoryTarget } from '../utils/tx-story';

export const TX_STORY_LOADING = 'Loading…';
export const TX_STORY_REREAD_FAILED = "Couldn't refresh this story — reload the page to try again.";

/** What a story's history lines can do: the Change log card's Undo, Redo and
 *  Sync now. Without `undo` the lines open read-only. */
export interface TxStoryActions {
  undo?: (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => Promise<UndoOutcome>;
  /** The companion's published version: the gate and the Telegram pointer. */
  companionVersion: string | null;
  onSyncNow?: () => Promise<string>;
}

/** The add-on's own Undo and Sync now — the same ones Settings → Change log uses. */
export function useTxStoryActions(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): TxStoryActions {
  const undo = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const onSyncNow = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true })), [ctx, store]);
  return useMemo(() => ({ undo, companionVersion, onSyncNow }), [undo, companionVersion, onSyncNow]);
}

/** One line of What happened: opens its entry's detail in place. */
function HistoryLine({ line, entry, actions }: { line: string; entry: ChangeLogItem | undefined; actions: RowActions }) {
  const [open, setOpen] = useState(false);
  // Unique on the page, even with the same story open in two lists.
  const detailId = useId();
  if (!entry) return <div className="sfin-why-line">{line}</div>;
  return (
    <div className="sfin-why-line">
      <button
        type="button"
        className={`sfin-why-line-btn${entry.undone ? ' sfin-log-row--undone' : ''}`}
        aria-expanded={open}
        // Only while the detail exists: pointing at nothing is worse than no aria-controls.
        {...(open ? { 'aria-controls': detailId } : {})}
        onClick={() => setOpen((o) => !o)}
      >
        {line}
      </button>
      {open && <div id={detailId}><EntryDetail entry={entry} actions={actions} /></div>}
    </div>
  );
}

export function TxStoryView({ story, entries, actions, onChanged }: {
  story: TxStory;
  /** The change log as read: a line's entry, and what Undo is decided against. */
  entries: ChangeLogItem[];
  actions: TxStoryActions;
  /** After an Undo or a Sync now: read the story again. */
  onChanged: () => void;
}) {
  const rowActions: RowActions = {
    undo: actions.undo, companionVersion: actions.companionVersion, entries, onSyncNow: actions.onSyncNow, changed: onChanged,
  };
  const byId = new Map(entries.map((e) => [e.id, e]));
  return (
    <div className="sfin-why-story">
      <div className="sfin-why-title">{story.title}</div>
      {story.accountLine && <div className="sfin-subtle">{story.accountLine}</div>}
      {story.answer.length > 0 && (
        <ul className="sfin-why-answer">
          {story.answer.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}
        </ul>
      )}
      {story.history && (
        <div className="sfin-why-history">
          <div className="sfin-why-heading">{TX_STORY_WHAT_HAPPENED}</div>
          {/* A log read in part can't say nothing happened: its note says why the list may be short. */}
          {story.history.length === 0
            ? !story.historyPartial && <div className="sfin-subtle">{TX_STORY_NO_HISTORY}</div>
            : story.history.map((h) => <HistoryLine key={h.entryId} line={h.line} entry={byId.get(h.entryId)} actions={rowActions} />)}
        </div>
      )}
      {story.notes.map((n) => <div key={n} className="sfin-log-note">{n}</div>)}
    </div>
  );
}

/** A story, loaded for its target and read again after every Undo. */
export function TxStoryPanel({ target, load, actions }: {
  target: AppStoryTarget;
  /** Stable (useCallback): a new function every render would reload forever. */
  load: (target: AppStoryTarget) => Promise<AppStoryOutcome>;
  actions: TxStoryActions;
}) {
  const [shown, setShown] = useState<AppStoryOutcome | 'loading'>('loading');
  const [staleNote, setStaleNote] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const hasStory = useRef(false);
  const { activityId, categoryName, filer } = target;

  // A different transaction starts clean: the old story, and its stale note,
  // must never sit under the new target's "gone" or "unreachable".
  useEffect(() => {
    hasStory.current = false;
    setShown('loading');
    setStaleNote(null);
  }, [activityId]);

  useEffect(() => {
    let live = true;
    const settle = (out: AppStoryOutcome) => {
      if (!live) return;
      if (out.kind === 'ok') {
        hasStory.current = true;
        setShown(out);
        setStaleNote(null);
      } else if (hasStory.current) {
        // A re-read after an Undo: keep what is on screen and say why it may
        // be out of date (an Undo of an import removes the row itself).
        setStaleNote(out.kind === 'gone' ? TX_STORY_GONE_APP : TX_STORY_REREAD_FAILED);
      } else {
        setShown(out);
      }
    };
    load({ activityId, ...(categoryName ? { categoryName } : {}), ...(filer ? { filer } : {}) })
      .then(settle, () => settle({ kind: 'unreachable' }));
    return () => { live = false; };
  }, [load, activityId, categoryName, filer, version]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const note = shown === 'loading' ? null
    : shown.kind === 'unreachable' ? TX_STORY_UNREACHABLE
      : shown.kind === 'gone' ? TX_STORY_GONE_APP
        : staleNote;
  return (
    <>
      {/* Mounted from the first render, so what lands in it is announced: a
          status region inserted already filled is read unreliably. */}
      <div role="status">
        {shown === 'loading' && <div className="sfin-subtle">{TX_STORY_LOADING}</div>}
        {note && <div className="sfin-log-note">{note}</div>}
      </div>
      {shown !== 'loading' && shown.kind === 'ok' && (
        <TxStoryView story={shown.story} entries={shown.entries} actions={actions} onChanged={changed} />
      )}
    </>
  );
}
