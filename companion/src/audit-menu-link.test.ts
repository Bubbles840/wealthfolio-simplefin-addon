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
