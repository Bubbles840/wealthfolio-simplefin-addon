/**
 * src/components/PaybackAction.tsx
 *
 * "It's a payback…" (1.62.0, W11), under a money-in row of the
 * needs-a-category list and on its story. The first click reads the spending
 * categories and shows the picker under Telegram's line ("Pick the spending it
 * pays you back for."); File it acts, one action per click, busy while it runs;
 * Cancel closes. The parent says what happened: the list in its status line
 * (a filed row leaves the list at once, as a dismissed one does), the story in
 * its own. This component says only what is its own — the categories could not
 * be read — and, with `inlineStatus` (the list, whose row stays), a refusal.
 * No emoji in app copy (src/pages/copy-policy.test.tsx).
 */
import React, { useEffect, useRef, useState } from 'react';
import type { PaybackCategory } from '../../shared/payback-app';
import type { AppPaybackOutcome } from '../../shared/payback-app-file';
import {
  PAYBACK_APP_ACTION, PAYBACK_APP_CANCEL, PAYBACK_APP_CATEGORIES_FAILED, PAYBACK_APP_CATEGORY_LABEL, PAYBACK_APP_CHOOSE, PAYBACK_APP_FILE,
  PAYBACK_APP_LOADING, PAYBACK_APP_NO_CATEGORIES, PAYBACK_PICK, PAYBACK_UNREACHABLE,
} from '../../shared/payback-copy';
import { Button, Select } from './ui';

/** "It's a payback…" as the app's components call it. */
export interface AppPaybackActions {
  /** The categories to pick from (`readPaybackCategories`). Rejects when they cannot be read. */
  categories(): Promise<PaybackCategory[]>;
  /** Files it (`paybackFromApp`); `shown` is the story's fingerprint of the row. */
  file(activityId: string, categoryId: string, shown?: string): Promise<AppPaybackOutcome>;
}

/** A message's lines, each its own block: the runner joins them with "\n". */
export function MessageLines({ message }: { message: string | null | undefined }) {
  return <>{(message ?? '').split('\n').filter(Boolean).map((line, i) => <div key={`${i}:${line}`}>{line}</div>)}</>;
}

export function PaybackAction({ activityId, shown, label, actions, onOutcome, inlineStatus = false }: {
  activityId: string;
  /** The row as the story showed it (`removalFingerprint`); the list has none. */
  shown?: string;
  /** The row in words, for the button's accessible name; absent: its text. */
  label?: string;
  actions: AppPaybackActions;
  onOutcome?: (out: AppPaybackOutcome) => void;
  /** Say a refusal here, under the row (the list). */
  inlineStatus?: boolean;
}) {
  const [stage, setStage] = useState<'closed' | 'loading' | 'picking'>('closed');
  const [categories, setCategories] = useState<PaybackCategory[]>([]);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // One action per click, even before the re-render that disables the buttons.
  const running = useRef(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once the next render has put it there (as TxStory's Remove for good).
  const focusAfter = useRef<'select' | 'action' | null>(null);
  // No state updates once the row or story is gone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (focusAfter.current === 'select') selectRef.current?.focus();
    else if (focusAfter.current === 'action') actionRef.current?.focus();
    focusAfter.current = null;
  });

  const open = async () => {
    setNote(null);
    setStage('loading');
    try {
      const list = await actions.categories();
      if (!mounted.current) return;
      setCategories(list);
      setChosen('');
      if (list.length === 0) {
        focusAfter.current = 'action';
        setStage('closed');
        setNote(PAYBACK_APP_NO_CATEGORIES);
        return;
      }
      focusAfter.current = 'select';
      setStage('picking');
    } catch {
      if (!mounted.current) return;
      setStage('closed');
      setNote(PAYBACK_APP_CATEGORIES_FAILED);
    }
  };

  const file = async () => {
    if (running.current || !chosen) return;
    running.current = true;
    setBusy(true);
    let out: AppPaybackOutcome;
    try {
      out = await actions.file(activityId, chosen, shown);
    } catch {
      out = { kind: 'refused', message: PAYBACK_UNREACHABLE };
    }
    running.current = false;
    if (!mounted.current) return;
    setBusy(false);
    focusAfter.current = 'action';
    setStage('closed');
    if (inlineStatus && out.kind !== 'filed') setNote(out.message);
    onOutcome?.(out);
  };

  return (
    <div className="sfin-why-remove">
      {/* Mounted from the first render, so what lands in it is announced. */}
      <div role="status" className="sfin-subtle"><MessageLines message={note} /></div>
      {stage === 'picking' ? (
        <>
          <div>{PAYBACK_PICK}</div>
          <div className="sfin-audit-fix">
            <Select ref={selectRef} aria-label={PAYBACK_APP_CATEGORY_LABEL} value={chosen} disabled={busy} onChange={(e) => setChosen(e.target.value)}>
              <option value="">{PAYBACK_APP_CHOOSE}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
            </Select>
            <Button variant="ghost" disabled={busy || !chosen} aria-busy={busy} onClick={file}>{PAYBACK_APP_FILE}</Button>
            <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={() => { focusAfter.current = 'action'; setStage('closed'); }}>{PAYBACK_APP_CANCEL}</Button>
          </div>
        </>
      ) : (
        <div className="sfin-audit-fix">
          <Button
            ref={actionRef}
            variant="ghost"
            disabled={stage === 'loading'}
            aria-busy={stage === 'loading'}
            onClick={open}
            {...(label && stage !== 'loading' ? { 'aria-label': `${PAYBACK_APP_ACTION} ${label}` } : {})}
          >
            {stage === 'loading' ? PAYBACK_APP_LOADING : PAYBACK_APP_ACTION}
          </Button>
        </div>
      )}
    </div>
  );
}
