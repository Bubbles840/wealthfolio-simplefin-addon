import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { parseTxQuery, TX_SEARCH_TOO_MANY, type TxSearchRow } from '../../shared/tx-search';
import { TX_STORY_UNREACHABLE } from '../../shared/tx-story';
import type { AppSearchOutcome } from '../utils/tx-story';
import { WhyCard, WHY_CARD_NO_MATCH } from './WhyCard';

const EMOJI = /\p{Extended_Pictographic}/u;
const rows = (n: number): TxSearchRow[] => Array.from({ length: n }, (_, i) => ({
  activityId: `act-${i}`, date: '2026-10-04', description: `KROGER #${i}`, amountCents: -5420, accountName: 'PNC Checking',
}));
const found = (n: number, truncated = false): AppSearchOutcome => ({ kind: 'ok', result: { rows: rows(n), truncated } });

function mount(search: (q: ReturnType<typeof parseTxQuery>) => Promise<AppSearchOutcome>) {
  const renderStory = vi.fn((t: { activityId: string }) => <div>story of {t.activityId}</div>);
  const utils = render(<WhyCard search={search} renderStory={renderStory} />);
  const ask = (text: string) => {
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a transaction' }), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  };
  return { ...utils, renderStory, ask };
}

describe('WhyCard', () => {
  it('searches what was typed and lists matches, 8 at a time, then More', async () => {
    const search = vi.fn(async () => found(12));
    const { ask, container } = mount(search);
    expect(screen.getByText('Why is this here?')).toBeInTheDocument();
    ask('Kroger 54');
    expect(await screen.findByText('KROGER #0')).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith(parseTxQuery('Kroger 54'));
    expect(container.querySelectorAll('.sfin-why-result')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(container.querySelectorAll('.sfin-why-result')).toHaveLength(12);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('opens a match’s story in place, and closes it again', async () => {
    const { ask, renderStory } = mount(vi.fn(async () => found(2)));
    ask('kroger');
    const row = await screen.findByRole('button', { name: /KROGER #1/ });
    fireEvent.click(row);
    expect(screen.getByText('story of act-1')).toBeInTheDocument();
    expect(renderStory).toHaveBeenCalledWith({ activityId: 'act-1' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(row);
    expect(screen.queryByText('story of act-1')).toBeNull();
  });

  it('says when nothing matches, when there were too many, and when Wealthfolio cannot be reached', async () => {
    const outcomes: AppSearchOutcome[] = [found(0), found(40, true), { kind: 'unreachable' }];
    const { ask } = mount(vi.fn(async () => outcomes.shift()!));
    ask('zzz');
    expect(await screen.findByText(WHY_CARD_NO_MATCH)).toBeInTheDocument();
    ask('kroger');
    await screen.findByText('KROGER #0');
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText(TX_SEARCH_TOO_MANY)).toBeInTheDocument();
    ask('kroger');
    expect(await screen.findByText(TX_STORY_UNREACHABLE)).toBeInTheDocument();
  });

  it('does nothing for an empty search', () => {
    const search = vi.fn(async () => found(1));
    const { ask } = mount(search);
    ask('   ');
    expect(search).not.toHaveBeenCalled();
  });
});
