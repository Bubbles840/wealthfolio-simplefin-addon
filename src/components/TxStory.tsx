/**
 * src/components/TxStory.tsx
 *
 * One transaction's story in the app (shared/tx-story.ts): the title and the
 * account, the few lines that answer "why", then What happened — each line a
 * button that opens, in place, the Change log card's own entry detail with its
 * Undo, Redo and Sync now (`EntryDetail`, exported from ChangeLogCard.tsx, not
 * a copy). Otherwise a story changes nothing — except "Remove for good…"
 * (2c R2), on a row from the bank feed: the first click explains, Remove
 * acts, one action at a time, and the result is said in a status line; and
 * "It's a payback…" (1.62, W11) on a money-in row filed nowhere, where the
 * host and the companion allow it (PaybackAction.tsx).
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
import type { AppPaybackOutcome } from '../../shared/payback-app-file';
import {
  TX_STORY_GONE_APP, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory,
} from '../../shared/tx-story';
import {
  REMOVE_ACTION, REMOVE_BUTTON, REMOVE_CANCEL, REMOVE_CONFIRM, REMOVE_UNREACHABLE, type RemoveOutcome,
} from '../../shared/tx-remove';
import { EntryDetail, syncNowSentence, type RowActions } from './ChangeLogCard';
import { MessageLines, PaybackAction, type AppPaybackActions } from './PaybackAction';
import { Button } from './ui';
import { appPaybacksOffered, paybackFromApp, readPaybackCategories } from '../utils/app-payback';
import { removeFromApp } from '../utils/audit-fix';
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
  /** 2c R2: "Remove for good…" (`removeFromApp`). Absent: never offered. */
  remove?: (activityId: string, fingerprint: string) => Promise<RemoveOutcome>;
  /** W11: "It's a payback…" (`paybackFromApp`). Absent — a Wealthfolio before
   *  3.9, no companion, or one older than 1.62.0 — it is never offered. */
  payback?: AppPaybackActions;
}

/** The add-on's own Undo, Sync now, Remove for good and "It's a payback…" —
 *  Undo and Sync now are the ones Settings → Change log uses. `onPaidBack`:
 *  a payback was filed (the needs-a-category list drops its row at once). */
export function useTxStoryActions(
  ctx: AddonContext, store: SecretsStore, companionVersion: string | null, onPaidBack?: (activityId: string, message: string) => void,
): TxStoryActions {
  const undo = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const onSyncNow = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true })), [ctx, store]);
  const remove = useCallback((activityId: string, fingerprint: string) => removeFromApp(ctx, store, activityId, fingerprint), [ctx, store]);
  // W11: offered only on a 3.9+ host with a companion of 1.62.0 or newer.
  const [paybacks, setPaybacks] = useState(false);
  useEffect(() => {
    let live = true;
    setPaybacks(false);
    appPaybacksOffered(ctx, companionVersion).then((yes) => { if (live) setPaybacks(yes); }, () => {});
    return () => { live = false; };
  }, [ctx, companionVersion]);
  const payback = useMemo<AppPaybackActions | undefined>(() => (paybacks
    ? {
      categories: () => readPaybackCategories(ctx),
      file: async (activityId, categoryId, shown) => {
        const out = await paybackFromApp(ctx, store, { activityId, categoryId, ...(shown ? { shown } : {}) });
        if (out.kind === 'filed') onPaidBack?.(activityId, out.message);
        return out;
      },
    }
    : undefined), [paybacks, ctx, store, onPaidBack]);
  return useMemo(
    () => ({ undo, companionVersion, onSyncNow, remove, ...(payback ? { payback } : {}) }),
    [undo, companionVersion, onSyncNow, remove, payback],
  );
}

/** "Remove for good…": the first click explains, Remove acts. A refusal reads the story again. */
function RemoveForGood({ activityId, fingerprint, remove, onRefused, result, onResult }: {
  activityId: string;
  fingerprint: string;
  remove: NonNullable<TxStoryActions['remove']>;
  onRefused: () => void;
  /** The last outcome lives in the story view, so it survives a re-read that stops offering Remove. */
  result: RemoveOutcome | null;
  onResult: (r: RemoveOutcome | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const removeBtn = useRef<HTMLButtonElement>(null);
  const openBtn = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'remove' | 'open' | null>(null);
  useEffect(() => {
    if (focusAfter.current === 'remove') removeBtn.current?.focus();
    else if (focusAfter.current === 'open') openBtn.current?.focus();
    focusAfter.current = null;
  }, [confirming]);
  // One action per click, even before the re-render that disables the buttons.
  const running = useRef(false);
  // No state updates once the story is gone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const act = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    let out: RemoveOutcome;
    try {
      out = await remove(activityId, fingerprint);
    } catch {
      out = { ok: false, message: REMOVE_UNREACHABLE };
    }
    running.current = false;
    if (!mounted.current) return;
    onResult(out);
    setBusy(false);
    setConfirming(false);
    if (!out.ok) onRefused();
  };
  return (
    <div>
      {confirming && <div>{REMOVE_CONFIRM}</div>}
      {!result?.ok && (
        <div className="sfin-audit-fix">
          {confirming ? (
            <>
              <Button ref={removeBtn} variant="ghost" disabled={busy} aria-busy={busy} onClick={act}>{REMOVE_BUTTON}</Button>
              <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={() => { focusAfter.current = 'open'; setConfirming(false); }}>{REMOVE_CANCEL}</Button>
            </>
          ) : (
            <Button ref={openBtn} variant="ghost" onClick={() => { onResult(null); focusAfter.current = 'remove'; setConfirming(true); }}>{REMOVE_ACTION}</Button>
          )}
        </div>
      )}
    </div>
  );
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

export function TxStoryView({ story, entries, actions, onChanged, removal, payback }: {
  story: TxStory;
  /** The change log as read: a line's entry, and what Undo is decided against. */
  entries: ChangeLogItem[];
  actions: TxStoryActions;
  /** After an Undo or a Sync now: read the story again. */
  onChanged: () => void;
  /** 2c R2: the row as shown, when the story offers "Remove for good…". */
  removal?: { activityId: string; fingerprint: string };
  /** W11: the row as shown, when it qualifies for "It's a payback…". */
  payback?: { activityId: string; fingerprint: string };
}) {
  const rowActions: RowActions = {
    undo: actions.undo, companionVersion: actions.companionVersion, entries, onSyncNow: actions.onSyncNow, changed: onChanged,
  };
  const byId = new Map(entries.map((e) => [e.id, e]));
  const [removed, setRemoved] = useState<RemoveOutcome | null>(null);
  const [paidBack, setPaidBack] = useState<AppPaybackOutcome | null>(null);
  return (
    <div className="sfin-why-story">
      <div className="sfin-why-title">{story.title}</div>
      {story.accountLine && <div className="sfin-subtle">{story.accountLine}</div>}
      {story.answer.length > 0 && (
        <ul className="sfin-why-answer">
          {story.answer.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}
        </ul>
      )}
      {actions.remove && (
        <div className="sfin-why-remove">
          {/* Mounted from the first render, so what lands in it is announced; it stays
              when a re-read stops offering Remove, so a refusal is never lost. */}
          <div role="status" className="sfin-subtle">{removed?.message ?? ''}</div>
          {removal && (
            <RemoveForGood
              activityId={removal.activityId} fingerprint={removal.fingerprint} remove={actions.remove} onRefused={onChanged}
              result={removed} onResult={setRemoved}
            />
          )}
        </div>
      )}
      {actions.payback && (
        <div>
          {/* Mounted from the first render, and kept when a re-read stops offering it. */}
          <div role="status" className="sfin-subtle"><MessageLines message={paidBack?.message} /></div>
          {payback && (
            <PaybackAction
              activityId={payback.activityId} shown={payback.fingerprint} actions={actions.payback}
              onOutcome={(out) => { setPaidBack(out); onChanged(); }}
            />
          )}
        </div>
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
        <TxStoryView story={shown.story} entries={shown.entries} actions={actions} onChanged={changed} removal={shown.removal} payback={shown.payback} />
      )}
    </>
  );
}
