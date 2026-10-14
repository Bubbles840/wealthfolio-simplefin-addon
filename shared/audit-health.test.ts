import { describe, it, expect } from 'vitest';
import {
  healthCount, healthIssueLines, healthIssues, healthIssueTitle, HEALTH_NONE, HEALTH_READ_NOTES, MATCH_DAYS,
  type HealthFacts, type HealthIssue,
} from './audit-health';
import type { AuditAccount, AuditLedgerRow } from './audit-ledger';
import { accountTxKey } from './transfers';

const acct = (id: string, name: string, archived = false, active = true): AuditAccount => ({ id, name, type: 'CASH', archived, active });
let seq = 0;
const row = (over: Partial<AuditLedgerRow> = {}): AuditLedgerRow => {
  seq += 1;
  return {
    id: `act-${seq}`, accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT',
    status: 'POSTED', absCents: 60000, group: '', assetId: '', external: false, phantomCash: false, notes: `TRANSFER TO ALLY · TRN-${seq}`,
    ...over,
  };
};
const ACCOUNTS = [
  acct('wf-chk', 'PNC Checking'), acct('wf-ally', 'Ally Savings'), acct('wf-cap', 'Capital One'),
  acct('wf-old', 'Old Bank', true), acct('wf-off', 'Closed Card', false, false),
];
const facts = (rows: AuditLedgerRow[], over: Partial<HealthFacts> = {}): HealthFacts => ({
  ledger: { accounts: ACCOUNTS, rows },
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-ally': 'wf-ally', 'sfin-cap': 'wf-cap' },
  ...over,
});
const legs = (issues: HealthIssue[] | null) =>
  (issues ?? []).flatMap((i) => (i.kind === 'incomplete-leg' ? [i] : []));

describe('healthIssues: incomplete transfer legs', () => {
  it('offers the one row that matches both ways, carrying both rows’ ids, accounts, tx keys, amounts and dates', () => {
    const out = row({ id: 'out', notes: 'TRANSFER TO ALLY · TRN-1' });
    const dep = row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-06', notes: 'FROM PNC · TRN-2' });
    const [issue] = legs(healthIssues(facts([out, dep])).issues);
    expect(issue).toMatchObject({ key: 'leg:out', problem: null, owner: 'you', match: 'one' });
    expect(issue.leg).toEqual({
      activityId: 'out', accountId: 'wf-chk', accountName: 'PNC Checking', txKey: accountTxKey('sfin-chk', 'TRN-1'),
      date: '2026-10-04', absCents: 60000, type: 'TRANSFER_OUT', currency: 'USD', description: 'TRANSFER TO ALLY',
    });
    expect(issue.counterpart).toEqual({
      activityId: 'dep', accountId: 'wf-ally', accountName: 'Ally Savings', txKey: accountTxKey('sfin-ally', 'TRN-2'),
      date: '2026-10-06', absCents: 60000, type: 'DEPOSIT', currency: 'USD', description: 'FROM PNC',
    });
    expect(healthIssueTitle(issue)).toBe('TRANSFER TO ALLY · $600.00 · PNC Checking · Oct 4');
    expect(healthIssueLines(issue)).toEqual(['Not linked to its other half.', 'Likely the other half: FROM PNC · $600.00 · Ally Savings · Oct 6']);
  });

  it('does not offer a counterpart that two rows could be', () => {
    const out = row({ id: 'out' });
    const a = row({ accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const b = row({ accountId: 'wf-cap', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', date: '2026-10-05', notes: 'FROM PNC · TRN-77' });
    const issues = legs(healthIssues(facts([out, a, b])).issues);
    const mine = issues.find((i) => i.leg.activityId === 'out')!;
    expect(mine.match).toBe('many');
    expect(mine.counterpart).toBeNull();
    expect(healthIssueLines(mine)[1]).toBe('It could pair with more than one row — link the right two in Wealthfolio.');
  });

  it('never offers a transfer row that is already in a group as the other half', () => {
    const out = row({ id: 'out' });
    const grouped = row({ id: 'grp', accountId: 'wf-ally', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', date: '2026-10-05', group: 'broken', notes: 'FROM PNC · TRN-8' });
    const mine = legs(healthIssues(facts([out, grouped])).issues).find((i) => i.leg.activityId === 'out')!;
    expect(mine).toMatchObject({ match: 'none', counterpart: null });
  });

  it('never offers a pending row as the other half — the sync never pairs one', () => {
    const out = row({ id: 'out' });
    const pending = row({ id: 'pend', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05', notes: 'FROM PNC · TRN-9 · pending' });
    const [mine] = legs(healthIssues(facts([out, pending])).issues);
    expect(mine).toMatchObject({ match: 'none', counterpart: null });
    // …and a pending candidate beside a posted one leaves the posted one unique.
    const posted = row({ id: 'post', accountId: 'wf-cap', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05', notes: 'FROM PNC · TRN-10' });
    const [both] = legs(healthIssues(facts([out, pending, posted])).issues);
    expect(both).toMatchObject({ match: 'one', counterpart: expect.objectContaining({ activityId: 'post' }) });
  });

  it('does not offer a row two legs both want', () => {
    const one = row({ id: 'one', date: '2026-10-04' });
    const two = row({ id: 'two', accountId: 'wf-cap', date: '2026-10-05' });
    const dep = row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const issues = legs(healthIssues(facts([one, two, dep])).issues);
    expect(issues.map((i) => [i.leg.activityId, i.match])).toEqual([['one', 'many'], ['two', 'many']]);
  });

  it('lists a pair of two unlinked legs once, from the leg the money left', () => {
    const out = row({ id: 'out' });
    const inn = row({ id: 'in', accountId: 'wf-ally', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', date: '2026-10-05', notes: 'FROM PNC · TRN-9' });
    const issues = legs(healthIssues(facts([inn, out])).issues);
    expect(issues).toHaveLength(1);
    expect(issues[0].leg.activityId).toBe('out');
    expect(issues[0].counterpart!.activityId).toBe('in');
  });

  it('finds nothing past MATCH_DAYS, in another currency, in the same account or moving the same way', () => {
    expect(MATCH_DAYS).toBe(5);
    const out = row({ id: 'out' });
    const late = row({ accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-10' });
    const cad = row({ accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', currency: 'CAD' });
    const same = row({ accountId: 'wf-chk', rawType: 'DEPOSIT', type: 'DEPOSIT' });
    const outflow = row({ accountId: 'wf-cap', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL' });
    const [issue] = legs(healthIssues(facts([out, late, cad, same, outflow])).issues);
    expect(issue.match).toBe('none');
    expect(healthIssueLines(issue)[1]).toBe('No likely other half within 5 days — if it has one, link the two in Wealthfolio.');
  });

  it('skips a valid pair, an external leg and a row that is not posted', () => {
    const issues = healthIssues(facts([
      row({ group: 'g1' }), row({ accountId: 'wf-ally', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', group: 'g1' }),
      row({ external: true }),
      row({ status: 'PENDING' }),
    ])).issues;
    expect(issues).toEqual([]);
  });

  it('says why Wealthfolio refuses a group', () => {
    const issues = legs(healthIssues(facts([
      row({ id: 'a1', group: 'three' }), row({ id: 'a2', group: 'three', type: 'TRANSFER_IN', accountId: 'wf-ally' }), row({ id: 'a3', group: 'three', accountId: 'wf-cap' }),
      row({ id: 'b1', group: 'same' }), row({ id: 'b2', group: 'same', accountId: 'wf-ally' }),
      row({ id: 'c1', group: 'one' }), row({ id: 'c2', group: 'one', type: 'TRANSFER_IN' }),
      row({ id: 'd1', group: 'sec', assetId: 'AAPL' }), row({ id: 'd2', group: 'sec', type: 'TRANSFER_IN', accountId: 'wf-ally' }),
    ])).issues);
    const said = (id: string) => healthIssueLines(issues.find((i) => i.leg.activityId === id)!)[0];
    expect(said('a1')).toBe("Linked, but Wealthfolio won't accept the pair: its group has 3 transfer rows.");
    expect(said('b1')).toBe("Linked, but Wealthfolio won't accept the pair: both rows move money the same way.");
    expect(said('c1')).toBe("Linked, but Wealthfolio won't accept the pair: both rows are in one account.");
    expect(said('d1')).toBe("Linked, but Wealthfolio won't accept the pair: the rows carry different assets or quantities.");
  });

  it('flags the add-on’s own rows without matching them, and never offers an opening balance', () => {
    const placeholder = row({ id: 'ph', notes: '↔️ In-transit transfer · ZELLE · TRN-3' });
    const opening = row({ id: 'open', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', notes: 'Starting balance · ACT-1' });
    const mine = row({ id: 'mine', accountId: 'wf-cap', date: '2026-10-04' });
    const issues = legs(healthIssues(facts([placeholder, opening, mine])).issues);
    const byId = Object.fromEntries(issues.map((i) => [i.leg.activityId, i]));
    expect(byId.ph).toMatchObject({ owner: 'add-on', match: 'skipped', counterpart: null });
    expect(healthIssueLines(byId.ph)[1]).toBe("One of the add-on's own rows — the sync marks these so Health skips them.");
    expect(byId.mine.match).toBe('none');
  });

  it('looks only at active accounts that are not archived, as Health does, and never offers an archived row', () => {
    const archived = row({ id: 'arch', accountId: 'wf-old' });
    const inactive = row({ id: 'off', accountId: 'wf-off' });
    const mine = row({ id: 'mine', accountId: 'wf-cap' });
    const archivedDeposit = row({ id: 'old-dep', accountId: 'wf-old', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const issues = legs(healthIssues(facts([archived, inactive, mine, archivedDeposit])).issues);
    expect(issues.map((i) => [i.leg.activityId, i.match])).toEqual([['mine', 'none']]);
  });

  it('flags a leg of a valid pair that is marked external, which Health calls a conflicting marker', () => {
    const issues = legs(healthIssues(facts([
      row({ id: 'out', group: 'g1', external: true }),
      row({ id: 'in', accountId: 'wf-ally', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', group: 'g1' }),
    ])).issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'leg:out', problem: { kind: 'marked-external' }, match: 'skipped', counterpart: null });
    expect(healthIssueLines(issues[0])).toEqual([
      'Linked, but marked as money moving in or out of Wealthfolio, which contradicts the pair.',
      'Unlink the two and link them again in Wealthfolio — linking clears the mark.',
    ]);
  });

  it('treats a card’s TRANSFER_OUT (Wealthfolio 3.10) as a leg like any other, and never flags one marked external', () => {
    const cardOut = row({ id: 'card-out', accountId: 'wf-card', date: '2026-10-04' });
    const dep = row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const external = row({ id: 'ext', accountId: 'wf-card', external: true, date: '2026-10-20' });
    const withCard = { ...facts([]), ledger: { accounts: [...ACCOUNTS, { id: 'wf-card', name: 'Citi', type: 'CREDIT_CARD', archived: false }], rows: [cardOut, dep, external] } };
    const issues = legs(healthIssues(withCard).issues);
    expect(issues.map((i) => [i.leg.activityId, i.match, i.counterpart?.activityId])).toEqual([['card-out', 'one', 'dep']]);
  });

  it('keeps bank text raw', () => {
    const [issue] = legs(healthIssues(facts([row({ notes: 'SQ *COFFEE_CLUB [2] · TRN-4' })])).issues);
    expect(issue.leg.description).toBe('SQ *COFFEE_CLUB [2]');
  });
});

describe('healthIssues: starting balances and $CASH', () => {
  it('flags a starting balance dated on or after the account’s earliest row', () => {
    const issues = healthIssues(facts([
      row({ id: 'sb', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 120400, date: '2026-08-02', notes: 'Starting balance · ACT-1' }),
      row({ accountId: 'wf-ally', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', date: '2026-07-28', notes: 'COFFEE · TRN-5' }),
      row({ accountId: 'wf-cap', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-07-01', notes: 'Starting balance · ACT-2' }),
      row({ accountId: 'wf-cap', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', date: '2026-07-02', notes: 'TEA · TRN-6' }),
    ])).issues!;
    expect(issues).toEqual([{
      kind: 'late-start', key: 'late-start:sb', activityId: 'sb', accountId: 'wf-ally', accountName: 'Ally Savings',
      date: '2026-08-02', earliest: '2026-07-28', cents: 120400,
    }]);
    expect(healthIssueTitle(issues[0])).toBe("Ally Savings's starting balance is dated Aug 2, after its earliest transaction (Jul 28)");
    expect(healthIssueLines(issues[0])).toEqual(['A deep scan moves it to the day before your earliest transaction.']);
  });

  it('counts rows pointing at the phantom $CASH security, by account', () => {
    const issues = healthIssues(facts([
      row({ rawType: 'DEPOSIT', type: 'DEPOSIT', phantomCash: true }),
      row({ rawType: 'DEPOSIT', type: 'DEPOSIT', phantomCash: true }),
      row({ accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', phantomCash: true }),
    ])).issues!;
    expect(issues).toEqual([{ kind: 'phantom-cash', key: 'phantom-cash', rows: 3, accounts: [{ name: 'Ally Savings', rows: 1 }, { name: 'PNC Checking', rows: 2 }] }]);
    expect(healthIssueTitle(issues[0])).toBe('3 rows point at a $CASH asset (Ally Savings: 1, PNC Checking: 2)');
    expect(healthIssueLines(issues[0])).toEqual(['Older Wealthfolio versions filed these under a $CASH asset. Clean-up needs the server tool fix-transfers.mjs.']);
  });

  it('has nothing to report on a clean ledger', () => {
    const r = healthIssues(facts([row({ rawType: 'WITHDRAWAL', type: 'WITHDRAWAL' })]));
    expect(r.issues).toEqual([]);
    expect(healthCount(r)).toBe(0);
    // Never "Wealthfolio's Health page has nothing": 3.10's checks more than this port.
    expect(HEALTH_NONE).toBe('Nothing the add-on checks for: no incomplete transfers, late starting balances or $CASH rows.');
  });
});

describe('healthIssues: failed reads', () => {
  it('says Health was not checked without the database — never "nothing to flag"', () => {
    const r = healthIssues({ mapping: {}, failed: ['ledger'] });
    expect(r.issues).toBeNull();
    expect(healthCount(r)).toBeNull();
    expect(r.notes).toEqual([HEALTH_READ_NOTES.ledger]);
  });

  it('still checks without the mapping, with no bank ids on the rows', () => {
    const r = healthIssues(facts([row()], { mapping: undefined, failed: ['mapping'] }));
    expect(legs(r.issues)[0].leg.txKey).toBeNull();
    expect(r.notes).toEqual([HEALTH_READ_NOTES.mapping]);
  });
});

const inn = (over: Partial<AuditLedgerRow> = {}) => row({ rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', accountId: 'wf-ally', notes: 'FROM PNC · TRN-in', ...over });

describe('healthIssues: pairs Wealthfolio 3.10 accepts, and hidden claimants', () => {
  it('accepts a same-account cash FX conversion (different currencies)', () => {
    const r = healthIssues(facts([row({ group: 'fx', currency: 'USD' }), inn({ group: 'fx', accountId: 'wf-chk', currency: 'EUR' })]));
    expect(r.issues).toEqual([]);
  });
  it('still refuses a same-account pair in one currency', () => {
    const r = legs(healthIssues(facts([row({ id: 'x1', group: 'g' }), inn({ id: 'x2', group: 'g', accountId: 'wf-chk' })])).issues);
    expect(r[0].problem).toEqual({ kind: 'one-account' });
  });
  it('accepts security legs of the same asset and equal quantity, or with a quantity unread', () => {
    const same = healthIssues(facts([row({ group: 's', assetId: 'AAPL', quantity: 3 }), inn({ group: 's', assetId: 'AAPL', quantity: -3 })]));
    const unread = healthIssues(facts([row({ group: 'u', assetId: 'AAPL' }), inn({ group: 'u', assetId: 'AAPL' })]));
    expect(same.issues).toEqual([]);
    expect(unread.issues).toEqual([]);
  });
  it('holds quantities equal within Wealthfolio’s own tolerance, 0.000001', () => {
    const near = healthIssues(facts([row({ group: 'n', assetId: 'AAPL', quantity: 3 }), inn({ group: 'n', assetId: 'AAPL', quantity: -3.0000005 })]));
    expect(near.issues).toEqual([]);
    const far = legs(healthIssues(facts([row({ id: 'f1', group: 'f', assetId: 'AAPL', quantity: 3 }), inn({ id: 'f2', group: 'f', assetId: 'AAPL', quantity: 3.000002 })])).issues);
    expect(far[0].problem).toEqual({ kind: 'security' });
  });
  it('refuses security legs of different assets or quantities', () => {
    const diffAsset = legs(healthIssues(facts([row({ id: 'p1', group: 'a', assetId: 'AAPL' }), inn({ id: 'p2', group: 'a', assetId: 'MSFT' })])).issues);
    const diffQty = legs(healthIssues(facts([row({ id: 'q1', group: 'b', assetId: 'AAPL', quantity: 3 }), inn({ id: 'q2', group: 'b', assetId: 'AAPL', quantity: 4 })])).issues);
    expect(diffAsset[0].problem).toEqual({ kind: 'security' });
    expect(diffQty[0].problem).toEqual({ kind: 'security' });
  });
  it('counts a leg whose partner is in an archived account as validly paired', () => {
    const r = healthIssues(facts([row({ group: 'g' }), inn({ group: 'g', accountId: 'wf-old' })]));
    expect(r.issues).toEqual([]);
  });
  it('ignores archived-partner and inactive-account legs as claimants, so a visible leg keeps its counterpart', () => {
    const out = row({ id: 'out' });
    const dep = row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const hidden = row({ id: 'hid', accountId: 'wf-off', date: '2026-10-05' });
    const paired = row({ id: 'pr', accountId: 'wf-cap', group: 'g', date: '2026-10-05' });
    const partner = inn({ id: 'pp', accountId: 'wf-old', group: 'g' });
    const [issue] = legs(healthIssues(facts([out, dep, hidden, paired, partner])).issues);
    expect(issue).toMatchObject({ match: 'one' });
    expect(issue.counterpart!.activityId).toBe('dep');
  });
});

describe('healthIssues: edges', () => {
  it('matches at exactly 5 days and not at 6', () => {
    const dep = (date: string) => row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date });
    expect(legs(healthIssues(facts([row({ id: 'out' }), dep('2026-10-09')])).issues)[0].match).toBe('one');
    expect(legs(healthIssues(facts([row({ id: 'out' }), dep('2026-10-10')])).issues)[0].match).toBe('none');
  });
  it('does not let a placeholder make a user leg “many”', () => {
    const dep = row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const ph = row({ id: 'ph', accountId: 'wf-cap', notes: '↔️ In-transit transfer · ZELLE · TRN-3' });
    const issues = legs(healthIssues(facts([row({ id: 'out' }), dep, ph])).issues);
    expect(issues.find((i) => i.leg.activityId === 'out')).toMatchObject({ match: 'one' });
  });
  it('lists a mutual pair once, from the OUT, when the IN is dated first', () => {
    const issues = legs(healthIssues(facts([
      row({ id: 'out', date: '2026-10-06' }), inn({ id: 'in', date: '2026-10-04' }),
    ])).issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'leg:out', match: 'one' });
    expect(issues[0].counterpart!.activityId).toBe('in');
  });
  it('gives a tx key only to mapped accounts when the mapping is partial', () => {
    const [issue] = legs(healthIssues(facts([
      row({ id: 'out' }), row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', notes: 'IN · TRN-9' }),
    ], { mapping: { 'sfin-chk': 'wf-chk' } })).issues);
    expect(issue.leg.txKey).not.toBeNull();
    expect(issue.counterpart!.txKey).toBeNull();
  });
  it('notes the ledger read even when failed does not list it', () => {
    expect(healthIssues({}).notes).toEqual([HEALTH_READ_NOTES.ledger]);
  });
  it('words a late start on the earliest row’s day without “after”, and otherwise keeps “after”', () => {
    const mk = (d: string) => healthIssues(facts([
      row({ id: 'sb', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: d, notes: 'Starting balance · ACT-1' }),
      row({ accountId: 'wf-ally', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', date: '2026-07-28', notes: 'COFFEE · TRN-5' }),
    ])).issues![0];
    expect(healthIssueTitle(mk('2026-07-28'))).toBe("Ally Savings's starting balance is dated Jul 28, the same day as its earliest transaction");
    expect(healthIssueTitle(mk('2026-08-02'))).toContain('after its earliest transaction (Jul 28)');
  });
  it('tells an add-on leg of a pair marked external that the sync handles it', () => {
    const issues = legs(healthIssues(facts([
      row({ id: 'ph', group: 'g', external: true, notes: '↔️ In-transit transfer · ZELLE · TRN-3' }), inn({ group: 'g' }),
    ])).issues);
    expect(issues[0]).toMatchObject({ owner: 'add-on', match: 'skipped' });
    expect(healthIssueLines(issues[0])[1]).toBe("One of the add-on's own rows — the sync handles its marks itself.");
  });
});
