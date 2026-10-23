import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

  describe('the year', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('a match from another year shows its year; this year’s does not', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2027, 0, 15, 12, 0));
      const lastYear = mount(vi.fn(async () => found(1)));
      lastYear.ask('kroger');
      expect(await screen.findByText('Oct 4, 2026')).toBeInTheDocument();
      lastYear.unmount();
      vi.setSystemTime(new Date(2026, 9, 13, 12, 0));
      mount(vi.fn(async () => found(1))).ask('kroger');
      expect(await screen.findByText('Oct 4')).toBeInTheDocument();
    });
  });

  it('each match’s button controls its own story region, with an id unique on the page', async () => {
    const search = vi.fn(async () => found(2));
    const renderStory = (t: { activityId: string }) => <div>story of {t.activityId}</div>;
    render(<><WhyCard search={search} renderStory={renderStory} /><WhyCard search={search} renderStory={renderStory} /></>);
    for (const box of screen.getAllByRole('searchbox')) fireEvent.change(box, { target: { value: 'kroger' } });
    for (const find of screen.getAllByRole('button', { name: 'Find' })) fireEvent.click(find);
    const opens = await screen.findAllByRole('button', { name: /KROGER #1/ });
    expect(opens).toHaveLength(2);
    for (const open of opens) fireEvent.click(open);
    const ids = opens.map((b) => b.getAttribute('aria-controls'));
    expect(new Set(ids).size).toBe(2);
    for (const [i, id] of ids.entries()) {
      const region = document.getElementById(id!);
      expect(region).not.toBeNull();
      expect(region!.textContent).toBe('story of act-1');
      fireEvent.click(opens[i]);
      expect(opens[i].hasAttribute('aria-controls')).toBe(false);
    }
  });

  it('says Searching…, nothing matches, too many and unreachable in a status region', async () => {
    let resolve!: (o: AppSearchOutcome) => void;
    const outcomes: Array<() => Promise<AppSearchOutcome>> = [
      () => new Promise<AppSearchOutcome>((r) => { resolve = r; }),
      async () => found(40, true),
      async () => ({ kind: 'unreachable' }),
    ];
    const { ask, container } = mount(vi.fn(() => outcomes.shift()!()));
    const status = () => container.querySelector('[role="status"]') as HTMLElement;
    expect(status()).not.toBeNull();
    ask('zzz');
    expect(status().textContent).toBe('Searching…');
    await act(async () => resolve(found(0)));
    expect(status().textContent).toBe(WHY_CARD_NO_MATCH);
    ask('kroger');
    await screen.findByText('KROGER #0');
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText(TX_SEARCH_TOO_MANY).closest('[role="status"]')).not.toBeNull();
    ask('kroger');
    expect((await screen.findByText(TX_STORY_UNREACHABLE)).closest('[role="status"]')).toBe(status());
  });

  it('does nothing for an empty search', () => {
    const search = vi.fn(async () => found(1));
    const { ask } = mount(search);
    ask('   ');
    expect(search).not.toHaveBeenCalled();
  });

  it('renders no <form>, which the sandboxed add-on frame would block', () => {
    const { container } = mount(vi.fn(async () => found(1)));
    expect(container.querySelector('form')).toBeNull();
  });

  it('searches on Enter, without clicking Find', async () => {
    const search = vi.fn(async () => found(1));
    mount(search);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a transaction' }), { target: { value: 'kroger' } });
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Find a transaction' }), { key: 'Enter' });
    expect(await screen.findByText('KROGER #0')).toBeInTheDocument();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest search when an older one resolves last', async () => {
    const resolvers: Array<(o: AppSearchOutcome) => void> = [];
    const search = vi.fn(() => new Promise<AppSearchOutcome>((resolve) => { resolvers.push(resolve); }));
    const { ask } = mount(search);
    ask('first');
    ask('second');
    await act(async () => resolvers[1]({ kind: 'ok', result: { rows: [{ ...rows(1)[0], description: 'SECOND HIT' }], truncated: false } }));
    await act(async () => resolvers[0]({ kind: 'ok', result: { rows: [{ ...rows(1)[0], description: 'FIRST HIT' }], truncated: false } }));
    expect(screen.getByText('SECOND HIT')).toBeInTheDocument();
    expect(screen.queryByText('FIRST HIT')).toBeNull();
  });

  it('a search resolving after unmount throws nothing', async () => {
    let resolve!: (o: AppSearchOutcome) => void;
    const search = vi.fn(() => new Promise<AppSearchOutcome>((r) => { resolve = r; }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ask, unmount } = mount(search);
    ask('kroger');
    unmount();
    await act(async () => resolve(found(1)));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
