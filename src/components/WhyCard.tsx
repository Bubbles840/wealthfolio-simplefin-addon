/**
 * src/components/WhyCard.tsx
 *
 * Home's "Why is this here?": find any transaction — a few words, an amount,
 * or both (shared/tx-search.ts) — and open its story in place
 * (src/components/TxStory.tsx). Matches are newest first, 8 at a time, More
 * for the next 8, at most 40. No emoji in app copy.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { changeDayYear, changeMoney } from '../../shared/change-entries';
import { isEmptyTxQuery, parseTxQuery, TX_SEARCH_PAGE_SIZE, TX_SEARCH_TOO_MANY, type TxQuery } from '../../shared/tx-search';
import { TX_STORY_UNREACHABLE } from '../../shared/tx-story';
import { Button, Input, SectionLabel } from './ui';
import type { AppSearchOutcome, AppStoryTarget } from '../utils/tx-story';

export const WHY_CARD_TITLE = 'Why is this here?';
export const WHY_CARD_PLACEHOLDER = 'A few words or an amount';
export const WHY_CARD_SEARCHING = 'Searching…';
export const WHY_CARD_NO_MATCH = 'Nothing matches. If it was removed, search the Change log in Settings.';

export function WhyCard({ search, renderStory, now = () => new Date() }: {
  search: (query: TxQuery) => Promise<AppSearchOutcome>;
  /** A match's story, opened under it. */
  renderStory: (target: AppStoryTarget) => React.ReactNode;
  /** The clock a match's year is judged against. */
  now?: () => Date;
}) {
  // Each match's story region gets an id unique on the page, for aria-controls.
  const regionId = useId();
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'searching' | AppSearchOutcome>('idle');
  const [shownCount, setShownCount] = useState(TX_SEARCH_PAGE_SIZE);
  const [openId, setOpenId] = useState<string | null>(null);
  // Only the newest search may land: an older one resolving late must not
  // replace its results.
  const latest = useRef(0);
  // Unmounting counts as a newer search: a late result must not land.
  useEffect(() => () => { latest.current += 1; }, []);

  const find = async () => {
    const query = parseTxQuery(text);
    if (isEmptyTxQuery(query)) return;
    const mine = ++latest.current;
    setState('searching');
    setOpenId(null);
    setShownCount(TX_SEARCH_PAGE_SIZE);
    let out: AppSearchOutcome;
    try {
      out = await search(query);
    } catch {
      out = { kind: 'unreachable' };
    }
    if (mine === latest.current) setState(out);
  };

  const result = typeof state === 'object' && state.kind === 'ok' ? state.result : null;
  return (
    <div className="sfin-card sfin-why-card">
      <SectionLabel>{WHY_CARD_TITLE}</SectionLabel>
      {/* Not a <form>: the add-on's frame is sandboxed without allow-forms, so
          a submit (Find or Enter) is blocked before any handler runs. */}
      <div className="sfin-why-form" role="search">
        <Input
          type="search"
          aria-label="Find a transaction"
          placeholder={WHY_CARD_PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void find(); }}
        />
        <Button variant="outline" onClick={() => void find()}>Find</Button>
      </div>
      {/* Mounted always, so what lands in it is announced: a status region
          inserted already filled is read unreliably. */}
      <div role="status">
        {state === 'searching' && <div className="sfin-subtle">{WHY_CARD_SEARCHING}</div>}
        {typeof state === 'object' && state.kind === 'unreachable' && <div className="sfin-log-note">{TX_STORY_UNREACHABLE}</div>}
        {result && result.rows.length === 0 && <div className="sfin-subtle">{WHY_CARD_NO_MATCH}</div>}
      </div>
      {result && result.rows.length > 0 && (
        <div className="sfin-why-results">
          {result.rows.slice(0, shownCount).map((r) => (
            <div key={r.activityId} className="sfin-why-result">
              <button
                type="button"
                className="sfin-why-open"
                aria-expanded={openId === r.activityId}
                // Only while the region exists: pointing at nothing is worse than no aria-controls.
                {...(openId === r.activityId ? { 'aria-controls': `${regionId}-${r.activityId}` } : {})}
                onClick={() => setOpenId((id) => (id === r.activityId ? null : r.activityId))}
              >
                <span className="sfin-why-when">{changeDayYear(r.date, now())}</span>
                <span className="sfin-why-what">
                  {r.description || 'A transaction'}
                  <span className="sfin-subtle"> · {r.accountName}</span>
                </span>
                <span className="sfin-why-amt">{changeMoney(r.amountCents)}</span>
              </button>
              {openId === r.activityId && (
                <div className="sfin-why-inline" id={`${regionId}-${r.activityId}`}>{renderStory({ activityId: r.activityId })}</div>
              )}
            </div>
          ))}
          {shownCount < result.rows.length && (
            <Button variant="ghost" onClick={() => setShownCount((n) => n + TX_SEARCH_PAGE_SIZE)}>More</Button>
          )}
          <div role="status">
            {result.truncated && shownCount >= result.rows.length && <div className="sfin-subtle">{TX_SEARCH_TOO_MANY}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
