import { describe, it, expect, vi } from 'vitest';
import { healthIssues, type HealthReport } from '../../shared/audit-health.js';
import type { AuditLedgerRow } from '../../shared/audit-ledger.js';
import { linkablePairs, pairHandle, pairsHandle, LINK_CHANGED, type LinkPair, type LinkRun } from '../../shared/audit-link.js';
import { escapeMarkdown } from '../../shared/telegram.js';
import {
  auditData, createAuditMenu, parseAuditData, renderAuditHealth, renderAuditIssue, type AuditMenuDeps, type MenuScreen,
} from './audit-menu.js';

const BANK = 'SQ *COFFEE_CLUB [2]';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);
const button = (s: MenuScreen, text: string) => s.keyboard.inline_keyboard.flat().find((b) => b.text === text)!.callback_data;

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const ACCOUNTS = [{ id: 'wf-chk', name: 'PNC Checking', type: 'CASH', archived: false }, { id: 'wf-ally', name: 'Ally', type: 'CASH', archived: false }];
const MAPPING = { 'sfin-chk': 'wf-chk', 'sfin-ally': 'wf-ally' };
/** Two transfers out of checking, each with one likely other half in Ally, and one with none. */
function ledgerRows(outADate = '2026-10-04'): AuditLedgerRow[] {
  return [
    row({ id: 'outA', absCents: 60000, date: outADate, notes: `${BANK} · TRN-1` }),
    row({ id: 'inA', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 60000, date: '2026-10-05', notes: 'FROM PNC · TRN-2' }),
    row({ id: 'outB', absCents: 2500, date: '2026-10-06', notes: 'ZELLE TO SAVINGS · TRN-3' }),
    row({ id: 'inB', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 2500, date: '2026-10-06', notes: 'ZELLE FROM PNC · TRN-4' }),
    row({ id: 'lone', absCents: 777, date: '2026-10-07', notes: 'TO SOMEWHERE · TRN-5' }),
  ];
}
const report = (outADate?: string): HealthReport & { reached: boolean } => ({
  ...healthIssues({ ledger: { accounts: ACCOUNTS, rows: ledgerRows(outADate) }, mapping: MAPPING }), reached: true,
});

function deps(over: Partial<AuditMenuDeps> = {}): AuditMenuDeps & { link: ReturnType<typeof vi.fn> } {
  const link = vi.fn(async (pairs: LinkPair[]): Promise<LinkRun> => ({
    total: pairs.length, linked: pairs.length, changed: 0, failed: 0, done: pairs.map((p) => p.key),
    message: pairs.length === 1 ? 'Linked.' : `Linked all ${pairs.length}.`,
  }));
  return {
    balances: vi.fn(),
    headline: vi.fn(),
    health: vi.fn(async () => report()),
    link,
    now: () => new Date(2026, 9, 14, 12, 0),
    log: vi.fn(),
    ...over,
  } as AuditMenuDeps & { link: ReturnType<typeof vi.fn> };
}
const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });
const edited = (u: ReturnType<typeof ui>) => u.edit.mock.calls.at(-1) as unknown as [string, MenuScreen['keyboard']];

describe('Link on the Health list', () => {
  it('shows each leg’s likely other half under it, a Link per pair and Link all, and Back last', () => {
    const screen = renderAuditHealth(report(), { link: true });
    expect(screen.text).toContain(`1. ${escapeMarkdown(`${BANK} · $600.00 · PNC Checking · Oct 4`)}`);
    expect(screen.text).toContain(`   ${escapeMarkdown('Likely the other half: FROM PNC · $600.00 · Ally · Oct 5')}`);
    expect(labels(screen)).toEqual(['1', '2', '3', 'Link 1', 'Link 2', 'Link all 2', '⬅️ Back']);
    const pairs = linkablePairs(report().issues);
    expect(allData(screen).slice(3, 6)).toEqual([
      auditData({ kind: 'link', handle: pairHandle(pairs[0]) }), auditData({ kind: 'link', handle: pairHandle(pairs[1]) }),
      auditData({ kind: 'link-all', handle: pairsHandle(pairs) }),
    ]);
  });

  it('keeps every button within 64 bytes — the longest is 23', () => {
    const r = report();
    const data = [...allData(renderAuditHealth(r, { link: true })), ...allData(renderAuditIssue(r.issues![0], { link: true }))];
    expect(data.every((d) => bytes(d) <= 64)).toBe(true);
    expect(Math.max(...data.map(bytes))).toBe(23);
    for (const d of data) expect(auditData(parseAuditData(d)!)).toBe(d);
  });

  it('offers no Link without a linker, and none on a leg with no single other half', () => {
    expect(labels(renderAuditHealth(report()))).toEqual(['1', '2', '3', '⬅️ Back']);
    const r = report();
    expect(labels(renderAuditIssue(r.issues![2], { link: true }))).toEqual(['⬅️ Back']);
    expect(labels(renderAuditIssue(r.issues![0], { link: true }))).toEqual(['Link', '⬅️ Back']);
  });

  it('a Link tap re-reads Health, links that one pair, and shows the list again with the result', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    await menu.onCallback({ data: button({ text: '', keyboard: edited(u)[1] }, 'Link 1') }, u);
    expect(d.link).toHaveBeenCalledWith([linkablePairs(report().issues)[0]]);
    expect(d.health).toHaveBeenCalledTimes(3);
    const [text] = edited(u);
    expect(text.startsWith('🔎 *Health*\nLinked.\n1. ')).toBe(true);
  });

  it('links nothing when a leg changed between the list and the tap', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const tap = button({ text: '', keyboard: edited(u)[1] }, 'Link 1');
    d.health = vi.fn(async () => report('2026-10-03'));
    await menu.onCallback({ data: tap }, u);
    expect(d.link).not.toHaveBeenCalled();
    expect(edited(u)[0]).toContain(`🔎 *Health*\n${escapeMarkdown(LINK_CHANGED)}\n`);
  });

  it('Link all links every pair the list showed — and nothing when the list has changed since', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const all = button({ text: '', keyboard: edited(u)[1] }, 'Link all 2');
    await menu.onCallback({ data: all }, u);
    expect(d.link).toHaveBeenCalledWith(linkablePairs(report().issues));
    expect(edited(u)[0].startsWith('🔎 *Health*\nLinked all 2.\n')).toBe(true);
    const later = deps({ health: vi.fn(async () => report('2026-10-03')) });
    const v = ui();
    await createAuditMenu(later).onCallback({ data: all }, v);
    expect(later.link).not.toHaveBeenCalled();
    expect(edited(v)[0]).toContain(escapeMarkdown(LINK_CHANGED));
  });

  it('answers a Link tap quietly when the menu cannot link', async () => {
    const d = deps({ link: undefined });
    const u = ui();
    await createAuditMenu(d).onCallback({ data: `cz:au:l${'0'.repeat(16)}` }, u);
    expect(u.answer).toHaveBeenCalledWith();
    expect(u.edit).not.toHaveBeenCalled();
  });
});

describe('Link keeps raw bank and Wealthfolio text escaped and outside entities', () => {
  const NOTE = 'SQ *COFFEE_CLUB_[9] `x`';
  const WHY = 'Wealthfolio refused the link (bad_account_id)';
  const noteReport = (): HealthReport & { reached: boolean } => ({
    ...healthIssues({
      ledger: { accounts: ACCOUNTS, rows: [row({ id: 'outA', absCents: 60000, notes: `${NOTE} · TRN-1` }), ledgerRows()[1]] },
      mapping: MAPPING,
    }),
    reached: true,
  });

  it('escapes the leg and its counterpart on the list, and a result with _ and * stays escaped and outside *…*', async () => {
    const lost = 'SQ *COFFEE_CLUB · $600.00 · PNC_Checking · Oct 4';
    const d = deps({
      health: vi.fn(async () => noteReport()),
      link: vi.fn(async (pairs: LinkPair[]): Promise<LinkRun> => ({
        total: 1, linked: 0, changed: 0, failed: 1, done: [], lost: [lost], maybeLost: [], message: `${WHY}, and the row couldn't be put back. Deleted and not restored: ${lost}.`,
      })),
    });
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const first = edited(u)[0];
    expect(first).toContain(escapeMarkdown(NOTE));
    await menu.onCallback({ data: button({ text: '', keyboard: edited(u)[1] }, 'Link 1') }, u);
    const text = edited(u)[0];
    const [head, result] = text.split('\n');
    expect(head).toBe('🔎 *Health*');
    expect(result).toBe(escapeMarkdown(`${WHY}, and the row couldn't be put back. Deleted and not restored: ${lost}.`));
    expect(result).toContain('bad\\_account\\_id');
    expect(result).toContain('SQ \\*COFFEE\\_CLUB');
    // Outside every entity: removing the escaped characters leaves no live _ or * in any line but the title.
    for (const line of text.split('\n').slice(1)) expect(line.replace(/\\[_*`[]/g, '')).not.toMatch(/[_*`[]/);
    expect(edited(u)[1].inline_keyboard.flat().every((b) => bytes(b.callback_data) <= 64)).toBe(true);
  });
});

describe('Link list size, outcome toast and failed re-reads', () => {
  const LONG = 'X'.repeat(60);
  const manyReport = (n: number): HealthReport & { reached: boolean } => {
    const rows: AuditLedgerRow[] = [];
    for (let i = 0; i < n; i++) {
      const cents = 10000 + i * 137;
      rows.push(row({ id: `o${i}`, absCents: cents, date: '2026-10-04', notes: `${LONG}_${i} · TRN-O${i}` }));
      rows.push(row({ id: `i${i}`, accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: cents, date: '2026-10-05', notes: `${LONG}*${i} · TRN-I${i}` }));
    }
    return { ...healthIssues({ ledger: { accounts: ACCOUNTS, rows }, mapping: MAPPING }), reached: true };
  };

  it('keeps 20 long pairs within Telegram’s limit, every Link button’s pair on screen, the result intact on top', () => {
    const r = manyReport(20);
    expect(linkablePairs(r.issues).length).toBe(20);
    const result = `Linked 2 of 20 — ${'_'.repeat(2000)}`;
    for (const opts of [{ link: true }, { link: true, result }]) {
      const screen = renderAuditHealth(r, opts);
      expect(screen.text.length).toBeLessThanOrEqual(4000);
      const linkButtons = labels(screen).filter((l) => /^Link \d+$/.test(l));
      expect(linkButtons.length).toBeGreaterThan(0);
      expect(linkButtons.length).toBeLessThan(20);
      expect(screen.text.match(/Likely the other half/g)!.length).toBe(linkButtons.length);
      expect(screen.text).toMatch(/…and \d+ more/);
      expect(labels(screen)).toContain(`Link all ${linkButtons.length}`);
      expect(screen.text.split('\n')[0]).toBe('🔎 *Health*');
    }
    const intact = renderAuditHealth(r, { link: true, result: 'Linked 2 of 20 — 1 had changed since.' });
    expect(intact.text.split('\n')[1]).toBe(escapeMarkdown('Linked 2 of 20 — 1 had changed since.'));
    const clipped = renderAuditHealth(r, { link: true, result }).text.split('\n')[1];
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(1501);
  });

  it('Link all on a clipped list links exactly the shown pairs', async () => {
    const r = manyReport(20);
    const d = deps({ health: vi.fn(async () => r) });
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const kb = edited(u)[1];
    const n = kb.inline_keyboard.flat().filter((b) => /^Link \d+$/.test(b.text)).length;
    await menu.onCallback({ data: button({ text: '', keyboard: kb }, `Link all ${n}`) }, u);
    expect(d.link).toHaveBeenCalledWith(linkablePairs(r.issues).slice(0, n));
  });

  it('puts the short outcome in the answer toast, so it is seen even if the edit fails', async () => {
    const d = deps({
      link: vi.fn(async (pairs: LinkPair[]): Promise<LinkRun> => ({
        total: 3, linked: 2, changed: 0, failed: 1, done: [], lost: [], maybeLost: [], message: `Linked 2 of 3 — 1 couldn't be linked.${' z'.repeat(300)}`,
      })),
    });
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const tap = button({ text: '', keyboard: edited(u)[1] }, 'Link 1');
    u.edit.mockRejectedValueOnce(new Error('400'));
    await menu.onCallback({ data: tap }, u);
    const toast = u.answer.mock.calls.map((c) => (c as unknown as [string?])[0]).find((t) => t && t.startsWith('Linked 2 of 3'))!;
    expect(toast.length).toBeLessThanOrEqual(200);
    const short = deps();
    const v = ui();
    await createAuditMenu(short).onCallback({ data: 'cz:au:i' }, v);
    await createAuditMenu(short).onCallback({ data: button({ text: '', keyboard: edited(v)[1] }, 'Link 1') }, v);
    expect(v.answer.mock.calls.map((c) => (c as unknown as [string?])[0])).toContain('Linked.');
    // A refusal says so in the toast too.
    const gone = deps({ health: vi.fn(async () => report('2026-10-03')) });
    const w = ui();
    await createAuditMenu(gone).onCallback({ data: `cz:au:l${'0'.repeat(16)}` }, w);
    expect(w.answer.mock.calls.map((c) => (c as unknown as [string?])[0])).toContain(LINK_CHANGED);
  });

  it('reports a failed Health re-read after a successful link, with the result and the escaped cause', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const tap = button({ text: '', keyboard: edited(u)[1] }, 'Link 1');
    d.health = vi.fn().mockResolvedValueOnce(report()).mockRejectedValueOnce(new Error('read_timed_out'));
    await menu.onCallback({ data: tap }, u);
    expect(d.link).toHaveBeenCalledTimes(1);
    const [text, kb] = edited(u);
    expect(text).toBe(`🔎 *Health*\nLinked.\n${escapeMarkdown("Couldn't re-read Health (read_timed_out).")}`);
    expect(text).toContain('read\\_timed\\_out');
    expect(kb.inline_keyboard.flat().map((b) => b.text)).toEqual(['⬅️ Back']);
  });

  it('a third leg makes the match ambiguous: no Link is offered, and an old tap says it changed', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const tap = button({ text: '', keyboard: edited(u)[1] }, 'Link 1');
    const third = row({ id: 'inA2', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 60000, date: '2026-10-05', notes: 'ALSO 600 · TRN-9' });
    const ambiguous = { ...healthIssues({ ledger: { accounts: ACCOUNTS, rows: [...ledgerRows(), third] }, mapping: MAPPING }), reached: true };
    expect(labels(renderAuditHealth(ambiguous, { link: true }))).not.toContain('Link 1');
    d.health = vi.fn(async () => ambiguous);
    await menu.onCallback({ data: tap }, u);
    expect(d.link).not.toHaveBeenCalled();
    expect(edited(u)[0]).toContain(escapeMarkdown(LINK_CHANGED));
  });

  it('a pair that is already linked says it changed and writes nothing', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const tap = button({ text: '', keyboard: edited(u)[1] }, 'Link 1');
    const linked = ledgerRows().map((r) => (r.id === 'outA' || r.id === 'inA' ? { ...r, group: 'g-1' } : r));
    d.health = vi.fn(async () => ({ ...healthIssues({ ledger: { accounts: ACCOUNTS, rows: linked }, mapping: MAPPING }), reached: true }));
    await menu.onCallback({ data: tap }, u);
    expect(d.link).not.toHaveBeenCalled();
    expect(edited(u)[0]).toContain(escapeMarkdown(LINK_CHANGED));
  });

  it('Link all with 1 of 3 shown pairs changed links nothing', async () => {
    const three = (outCDate: string): HealthReport & { reached: boolean } => {
      const rows = [
        ...ledgerRows(),
        row({ id: 'outC', absCents: 9100, date: outCDate, notes: 'TO BROKERAGE · TRN-7' }),
        row({ id: 'inC', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 9100, date: '2026-10-08', notes: 'FROM PNC 2 · TRN-8' }),
      ];
      return { ...healthIssues({ ledger: { accounts: ACCOUNTS, rows }, mapping: MAPPING }), reached: true };
    };
    const d = deps({ health: vi.fn(async () => three('2026-10-07')) });
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const all = button({ text: '', keyboard: edited(u)[1] }, 'Link all 3');
    d.health = vi.fn(async () => three('2026-10-03'));
    await menu.onCallback({ data: all }, u);
    expect(d.link).not.toHaveBeenCalled();
    expect(edited(u)[0]).toContain(escapeMarkdown(LINK_CHANGED));
  });
});
