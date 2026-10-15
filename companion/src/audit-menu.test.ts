import { describe, it, expect, vi } from 'vitest';
import { explainBalances, type BalanceReport } from '../../shared/audit-balance.js';
import { explainHeadline, HEADLINE_AGREE, HEADLINE_READ_NOTES, type HeadlineExplanation } from '../../shared/audit-headline.js';
import { healthIssues, HEALTH_NONE, HEALTH_READ_NOTES, type HealthReport } from '../../shared/audit-health.js';
import type { AuditLedgerRow } from '../../shared/audit-ledger.js';
import { ASK_CALLBACK_PREFIX } from '../../shared/ask-flow.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown, RECATEGORIZE_ENTRY_CALLBACK, WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
import { CHANGES_CALLBACK_PREFIX } from './changes-menu.js';
import { FINDINGS_CALLBACK_PREFIX } from './findings-menu.js';
import { SUBSCRIPTIONS_CALLBACK_PREFIX } from './subscriptions-menu.js';
import {
  accountHandle, auditData, auditStatusKeyboard, createAuditMenu, parseAuditData, renderAuditAccount, renderAuditBalances,
  renderAuditHeadline, renderAuditHealth, renderAuditIssue, renderAuditMenu, renderAuditReason,
  AUDIT_ACCOUNT_GONE, AUDIT_REASON_GONE, reasonHandle, AUDIT_CALLBACK_PREFIX, AUDIT_ISSUE_GONE, AUDIT_UNREACHABLE, type AuditMenuDeps, type AuditView, type MenuScreen,
} from './audit-menu.js';

const NOW = new Date(2026, 9, 13, 12, 0);
const NAME = "Joe's *Visa*_[1]";
const BANK = 'SQ *COFFEE_CLUB [2]';
const VISA = '0f8fad5b-d9cb-469f-a165-708677289501';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const LEDGER = {
  accounts: [{ id: VISA, name: 'Visa', type: 'CREDIT_CARD', archived: false }, { id: 'wf-chk', name: 'Checking', type: 'CASH', archived: false }],
  rows: [
    row({ id: 'v1', accountId: VISA, absCents: 50000, date: '2026-09-01' }),
    row({ id: 'v2', accountId: VISA, absCents: 1910, notes: `${BANK} · TRN-7 · pending` }),
    row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, notes: `${BANK} · TRN-1` }),
    row({ id: 'dep', accountId: VISA, rawType: 'CREDIT', type: 'CREDIT', absCents: 60000, date: '2026-10-05', notes: 'PAYMENT · TRN-2' }),
  ],
};
const balances = (): BalanceReport & { reached: boolean } => ({
  ...explainBalances({
    mapping: { 'sfin-v': VISA, 'sfin-c': 'wf-chk' },
    balances: { 'sfin-v': { balance: 100, date: Date.parse('2026-10-13T12:00:00Z') / 1000 }, 'sfin-c': { balance: 1, date: null } },
    names: { 'sfin-v': NAME, 'sfin-c': 'PNC Checking' },
    valuations: { 'wf-chk': 100 },
    ledger: LEDGER,
  }),
  reached: true,
});
const headline = (): HeadlineExplanation => explainHeadline({
  month: '2026-10', timezone: 'America/New_York', reportCents: 130000, wealthfolioCents: 120000, excludedCategoryIds: [],
  // On an account Wealthfolio reads that the add-on does not map.
  reportAccountIds: ['wf-other'],
  rows: Array.from({ length: 23 }, (_, i) => ({
    id: `h${i}`, date: '2026-10-04T12:00:00+00:00', accountId: 'wf-chk', groupId: '', accountName: NAME, accountType: 'CASH', type: 'WITHDRAWAL', subtype: '',
    absCents: 100, notes: `${BANK} · TRN-${i}`, filings: [], splits: [],
  })),
});
const health = (): HealthReport & { reached: boolean } => ({ ...healthIssues({ ledger: LEDGER, mapping: { 'sfin-v': VISA, 'sfin-c': 'wf-chk' } }), reached: true });

function deps(over: Partial<AuditMenuDeps> = {}): AuditMenuDeps {
  return {
    balances: vi.fn(async () => balances()),
    headline: vi.fn(async () => headline()),
    health: vi.fn(async () => health()),
    now: () => NOW,
    log: vi.fn(),
    ...over,
  };
}
const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });

describe('the cz:au: encoding', () => {
  it('parses back every view it writes, and nothing else', () => {
    const views: AuditView[] = [
      { kind: 'menu' }, { kind: 'balances' }, { kind: 'account', handle: 'abcdef01', fresh: false }, { kind: 'account', handle: 'abcdef01', fresh: true },
      { kind: 'headline' }, { kind: 'reason', handle: '0badc0de' }, { kind: 'health' }, { kind: 'issue', handle: '12345678' },
    ];
    for (const v of views) expect(parseAuditData(auditData(v))).toEqual(v);
    for (const bad of ['cz:au:', 'cz:au:z', 'cz:au:a123', 'cz:au:aZZZZZZZZ', 'cz:wy:m', 'cz:7:1']) expect(parseAuditData(bad)).toBeNull();
  });

  it('is the only prefix starting cz:au', () => {
    // amazon-labels.ts (cz:al:, cz:alc:) and transfer-learning.ts (cz:tl…) keep theirs private.
    const others = [ASK_CALLBACK_PREFIX, WHY_CALLBACK_PREFIX, CHANGES_CALLBACK_PREFIX, SUBSCRIPTIONS_CALLBACK_PREFIX, FINDINGS_CALLBACK_PREFIX,
      CATEGORIZE_ENTRY_CALLBACK, RECATEGORIZE_ENTRY_CALLBACK, 'cz:al:', 'cz:alc:', 'cz:tl:', 'cz:tlc:', 'cz:tlk:', 'cz:tlu:'];
    expect(AUDIT_CALLBACK_PREFIX).toBe('cz:au:');
    expect(others.filter((p) => p.startsWith('cz:au'))).toEqual([]);
  });

  it('keeps every button within 64 bytes — the longest is 15', () => {
    const h = headline();
    const hr = health();
    const screens = [
      renderAuditMenu(hr), renderAuditBalances(balances()), renderAuditAccount(balances().accounts[0], [], false),
      renderAuditHeadline(h), renderAuditReason(h.reasons![0]), renderAuditHealth(hr), renderAuditIssue(hr.issues![0]),
      { text: '', keyboard: auditStatusKeyboard([{ name: NAME, drift: 5, wfAccountId: VISA }])! },
    ];
    const data = screens.flatMap(allData);
    expect(data.every((d) => bytes(d) <= 64)).toBe(true);
    expect(Math.max(...data.map(bytes))).toBe(15);
  });
});

describe('/audit', () => {
  it('replies with the menu: balances, the month, and Health with its count', async () => {
    const send = vi.fn(async () => {});
    await createAuditMenu(deps()).reply(send);
    const [text, keyboard] = send.mock.calls[0] as unknown as [string, MenuScreen['keyboard']];
    expect(text.startsWith('🔎 *Audit*\n')).toBe(true);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Balances', 'Spent vs Wealthfolio', 'Health (1)']);
  });

  it('says so when it cannot reach Wealthfolio', async () => {
    const send = vi.fn(async () => {});
    await createAuditMenu(deps({ health: vi.fn(async () => ({ ...health(), reached: false })) })).reply(send);
    expect(send).toHaveBeenCalledWith(AUDIT_UNREACHABLE);
    const u = ui();
    await createAuditMenu(deps({ balances: vi.fn(async () => ({ ...balances(), reached: false })) })).onCallback({ data: auditData({ kind: 'balances' }) }, u);
    expect(u.answer).toHaveBeenCalledWith(AUDIT_UNREACHABLE);
    expect(u.edit).not.toHaveBeenCalled();
  });

  it('escapes a bank name full of Markdown characters and keeps it out of every entity', async () => {
    const list = renderAuditBalances(balances());
    expect(labels(list)[0]).toBe(`${NAME} · off by $19.10`);
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: allData(list)[0] }, u);
    const [text] = u.edit.mock.calls[0] as unknown as [string];
    const lines = text.split('\n');
    expect(lines[0]).toBe('🔎 *Balance*');
    expect(lines[1]).toBe(escapeMarkdown(NAME));
    expect(text).toContain(`• ${escapeMarkdown("$19.10 in 1 pending transaction the bank hasn't posted")}`);
    // The only entities are the fixed heading's.
    expect(text.replace('*Balance*', '').match(/(?<!\\)[*_]/g)).toBeNull();
    const reason = renderAuditReason(headline().reasons![0]);
    expect(reason.text).toContain(escapeMarkdown(`Oct 4 · ${BANK} · $1.00 · ${NAME}`));
  });

  it('opens an account in place with Back, and as a new message without one from /status', async () => {
    const inPlace = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'account', handle: accountHandle(VISA), fresh: false }) }, inPlace);
    expect(inPlace.send).not.toHaveBeenCalled();
    expect((inPlace.edit.mock.calls[0] as unknown as [string, MenuScreen['keyboard']])[1].inline_keyboard).toEqual([[{ text: '⬅️ Back', callback_data: 'cz:au:b' }]]);
    const fresh = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'account', handle: accountHandle(VISA), fresh: true }) }, fresh);
    expect(fresh.edit).not.toHaveBeenCalled();
    expect(fresh.send).toHaveBeenCalledTimes(1);
    expect((fresh.send.mock.calls[0] as unknown[]).length).toBe(1);
  });

  it('answers a tap from an older message: every tap re-reads, nothing is remembered', async () => {
    const buttons = allData(renderAuditBalances(balances()));
    const later = deps();
    const u = ui();
    await createAuditMenu(later).onCallback({ data: buttons[0] }, u);
    expect(later.balances).toHaveBeenCalledTimes(1);
    expect(u.edit).toHaveBeenCalledTimes(1);
  });

  it('says an account is no longer mapped, and Health has changed, instead of guessing', async () => {
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'account', handle: 'deadbeef', fresh: true }) }, u);
    expect(u.answer).toHaveBeenCalledWith(AUDIT_ACCOUNT_GONE);
    const v = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'issue', handle: 'deadbeef' }) }, v);
    expect(v.answer).toHaveBeenCalledWith(AUDIT_ISSUE_GONE);
  });

  it('shows a failed read as its note, never as "nothing to flag"', async () => {
    const notChecked = { ...healthIssues({ mapping: {}, failed: ['ledger'] }), reached: true };
    const screen = renderAuditHealth(notChecked);
    expect(screen.text).toContain(`⚠️ ${escapeMarkdown(HEALTH_READ_NOTES.ledger)}`);
    expect(screen.text).not.toContain(escapeMarkdown(HEALTH_NONE));
    expect(labels(renderAuditMenu(notChecked))).toContain('Health');
    expect(renderAuditHealth({ issues: [], notes: [] }).text).toContain(escapeMarkdown(HEALTH_NONE));
  });

  it('lists the month’s reasons with buttons, each opening its rows with Back', async () => {
    const h = headline();
    const screen = renderAuditHeadline(h);
    expect(screen.text).toContain(escapeMarkdown("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00."));
    expect(labels(screen)).toEqual(["On accounts the add-on doesn't sync (23)", '⬅️ Back']);
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: allData(screen)[0] }, u);
    const [text, kb] = u.edit.mock.calls[0] as unknown as [string, MenuScreen['keyboard']];
    expect(text).toContain('…and 3 more');
    expect(kb.inline_keyboard).toEqual([[{ text: '⬅️ Back', callback_data: 'cz:au:h' }]]);
    expect(renderAuditHeadline({ ...h, wealthfolioCents: 130000 }).text).toContain(escapeMarkdown(HEADLINE_AGREE));
  });

  it('opens a Health issue with its likely other half and Back', async () => {
    const screen = renderAuditHealth(health());
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: allData(screen)[0] }, u);
    const [text, kb] = u.edit.mock.calls[0] as unknown as [string, MenuScreen['keyboard']];
    expect(text).toContain(escapeMarkdown('Likely the other half: PAYMENT · $600.00 · Visa · Oct 5'));
    expect(kb.inline_keyboard).toEqual([[{ text: '⬅️ Back', callback_data: 'cz:au:i' }]]);
  });

  it('logs and answers when a read throws', async () => {
    const d = deps({ headline: vi.fn(async () => { throw new Error('boom'); }) });
    const u = ui();
    await createAuditMenu(d).onCallback({ data: 'cz:au:h' }, u);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(u.answer).toHaveBeenCalledWith('Could not do that — check the companion logs.');
  });
});

describe('failed reads are not "gone", and hostile text is escaped everywhere', () => {
  const only = (text: string, heading: string) => text.replace(heading, '').match(/(?<!\\)[*_`[]/g);
  const hostileLedger = {
    accounts: [{ id: VISA, name: NAME, type: 'CREDIT_CARD', archived: false }, { id: 'wf-chk', name: `Chk ${NAME}`, type: 'CASH', archived: false }],
    rows: [
      row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, notes: `${BANK} · TRN-1` }),
      row({ id: 'dep', accountId: VISA, rawType: 'CREDIT', type: 'CREDIT', absCents: 60000, date: '2026-10-05', notes: `${BANK} \`x\` · TRN-2` }),
    ],
  };
  const hostile = () => ({ ...healthIssues({ ledger: hostileLedger, mapping: { 'sfin-v': VISA, 'sfin-c': 'wf-chk' } }), reached: true });

  it('escapes the Health list and an issue with a counterpart, entities only in the heading', () => {
    const list = renderAuditHealth(hostile());
    const issue = hostile().issues!.find((i) => i.kind === 'incomplete-leg' && i.counterpart)!;
    const screen = renderAuditIssue(issue);
    expect(screen.text).toContain(escapeMarkdown(NAME));
    expect(list.text).toContain(escapeMarkdown(BANK));
    expect(only(list.text, '*Health*')).toBeNull();
    expect(only(screen.text, '*Health*')).toBeNull();
  });

  it('answers a failed ledger read with its note on a reason or issue tap, never "gone"', async () => {
    const unread = deps({
      headline: vi.fn(async () => explainHeadline({ month: '2026-10', reportCents: 1, wealthfolioCents: 2, failed: ['ledger'] })),
      health: vi.fn(async () => ({ ...healthIssues({ mapping: {}, failed: ['ledger'] }), reached: true })),
    });
    const u = ui();
    await createAuditMenu(unread).onCallback({ data: auditData({ kind: 'reason', handle: reasonHandle({ kind: 'first-midnight' }) }) }, u);
    expect(u.answer).not.toHaveBeenCalledWith(AUDIT_REASON_GONE);
    expect((u.edit.mock.calls[0] as unknown as [string])[0]).toContain(escapeMarkdown(HEADLINE_READ_NOTES.ledger));
    const v = ui();
    await createAuditMenu(unread).onCallback({ data: auditData({ kind: 'issue', handle: '15f88b89' }) }, v);
    expect(v.answer).not.toHaveBeenCalledWith(AUDIT_ISSUE_GONE);
    expect((v.edit.mock.calls[0] as unknown as [string])[0]).toContain(escapeMarkdown(HEALTH_READ_NOTES.ledger));
  });

  it('says a reason is gone only when the ledger was readable and it vanished', async () => {
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'reason', handle: reasonHandle({ kind: 'future-dated' }) }) }, u);
    expect(u.answer).toHaveBeenCalledWith(AUDIT_REASON_GONE);
    expect(u.edit).not.toHaveBeenCalled();
  });

  it('answers unreachable on the menu and account taps', async () => {
    const down = deps({
      health: vi.fn(async () => ({ ...health(), reached: false })),
      balances: vi.fn(async () => ({ ...balances(), reached: false })),
    });
    for (const data of ['cz:au:m', auditData({ kind: 'account', handle: accountHandle(VISA), fresh: false }), auditData({ kind: 'account', handle: accountHandle(VISA), fresh: true })]) {
      const u = ui();
      await createAuditMenu(down).onCallback({ data }, u);
      expect(u.answer).toHaveBeenCalledWith(AUDIT_UNREACHABLE);
      expect(u.edit).not.toHaveBeenCalled();
      expect(u.send).not.toHaveBeenCalled();
    }
  });

  it('re-reads on every tap: the second screen shows the data that changed in between', async () => {
    let renamed = false;
    const d = deps({
      balances: vi.fn(async () => {
        const r = balances();
        return renamed ? { ...r, accounts: r.accounts.map((a) => ({ ...a, name: 'Renamed' })) } : r;
      }),
    });
    const menu = createAuditMenu(d);
    const first = ui();
    await menu.onCallback({ data: 'cz:au:b' }, first);
    renamed = true;
    const second = ui();
    await menu.onCallback({ data: 'cz:au:b' }, second);
    expect(d.balances).toHaveBeenCalledTimes(2);
    expect((first.edit.mock.calls[0] as unknown as [string])[0]).not.toContain('Renamed');
    expect((second.edit.mock.calls[0] as unknown as [string, MenuScreen['keyboard']])[1].inline_keyboard[0][0].text).toContain('Renamed');
  });

  it('keeps every screen under 4,096 characters with 20 rows of very long descriptions', () => {
    const long = 'X'.repeat(500);
    const h = explainHeadline({
      month: '2026-10', timezone: 'America/New_York', reportCents: 130000, wealthfolioCents: 120000, excludedCategoryIds: [], reportAccountIds: ['wf-other'],
      rows: Array.from({ length: 30 }, (_, i) => ({
        id: `h${i}`, date: '2026-10-04T12:00:00+00:00', accountId: 'wf-chk', groupId: '', accountName: 'A', accountType: 'CASH', type: 'WITHDRAWAL', subtype: '',
        absCents: 100, notes: `${long} · TRN-${i}`, filings: [], splits: [],
      })),
    });
    const reason = renderAuditReason(h.reasons![0]);
    expect(reason.text.split('\n').length).toBeGreaterThan(20);
    expect(reason.text.length).toBeLessThan(4096);
    const legs = Array.from({ length: 24 }, (_, i) => row({ id: `o${i}`, rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 1000 + i, notes: `${long} · TRN-${i}` }));
    const report = { ...healthIssues({ ledger: { accounts: LEDGER.accounts, rows: legs }, mapping: { 'sfin-c': 'wf-chk' } }), reached: true };
    expect(report.issues!.length).toBeGreaterThanOrEqual(20);
    expect(renderAuditHealth(report).text.length).toBeLessThan(4096);
    expect(renderAuditIssue(report.issues![0]).text.length).toBeLessThan(4096);
  });
});

describe('auditStatusKeyboard', () => {
  it('puts a 🔎 under each account /status shows off, with its raw name', () => {
    const kb = auditStatusKeyboard([
      { name: NAME, drift: 13, wfAccountId: VISA },
      { name: 'Save', drift: null, wfAccountId: 'wf-save' },
      { name: 'Unmapped', drift: 4 },
    ])!;
    expect(kb.inline_keyboard).toEqual([[{ text: `🔎 ${NAME}`, callback_data: `cz:au:s${accountHandle(VISA)}` }]]);
    expect(auditStatusKeyboard([{ name: 'Save', drift: null, wfAccountId: 'wf-save' }])).toBeNull();
  });
});
