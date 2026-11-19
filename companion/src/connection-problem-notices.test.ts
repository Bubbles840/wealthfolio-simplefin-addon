import { describe, it, expect, vi } from 'vitest';
import type { ConnectionProblem } from '../../shared/connection-problems.js';
import { ANNOUNCED_PROBLEMS_SECRET_KEY, problemsForNotices, sendConnectionProblemNotices, type ProblemNoticeDeps } from './connection-problem-notices.js';

const AT = '2026-11-18T15:00:00.000Z';
const fidelity: ConnectionProblem = {
  key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity_NetBenefits', sfinAccountIds: ['a1'],
  message: 'Fidelity_NetBenefits: Authentication required', firstSeenAt: AT, lastSeenAt: AT,
};

function make(over: Partial<ProblemNoticeDeps> = {}, stored?: unknown) {
  const secrets = new Map<string, string>(stored === undefined ? [] : [[ANNOUNCED_PROBLEMS_SECRET_KEY, JSON.stringify(stored)]]);
  const sent: string[] = [];
  const send = vi.fn(async (text: string) => { sent.push(text); return { ok: true }; });
  const deps: ProblemNoticeDeps = {
    getSecret: vi.fn(async (k: string) => secrets.get(k) ?? null),
    setSecret: vi.fn(async (k: string, v: string) => { secrets.set(k, v); }),
    telegram: vi.fn(async () => ({ send })),
    log: vi.fn(),
    ...over,
  };
  const ledger = () => JSON.parse(secrets.get(ANNOUNCED_PROBLEMS_SECRET_KEY) ?? '[]');
  return { deps, sent, send, ledger };
}

describe('sendConnectionProblemNotices (#81)', () => {
  it('announces a newly shown problem once, Markdown-escaped, and records it', async () => {
    const { deps, sent, ledger } = make();
    await sendConnectionProblemNotices(deps, [fidelity]);
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(sent).toEqual([
      "*SimpleFin connection problem*\nFidelity\\_NetBenefits needs you to sign in again\nFidelity\\_NetBenefits needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.",
    ]);
    expect(ledger()).toEqual([fidelity]);
  });

  it('says when an announced problem clears, and forgets it', async () => {
    const { deps, sent, ledger } = make({}, [fidelity]);
    await sendConnectionProblemNotices(deps, []);
    expect(sent).toEqual(['Fidelity\\_NetBenefits is updating again.']);
    expect(ledger()).toEqual([]);
  });

  it('retries next sync when Telegram did not confirm the send', async () => {
    const send = vi.fn(async () => ({ ok: false, description: 'Bad Request' }));
    const { deps, ledger } = make({ telegram: vi.fn(async () => ({ send })) });
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger()).toEqual([]);
  });

  it('with Telegram off sends nothing and records nothing new, but still forgets what cleared', async () => {
    const other = { ...fidelity, key: 'act.failed:a2' };
    const { deps, ledger } = make({ telegram: vi.fn(async () => null) }, [other]);
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(ledger()).toEqual([]);
  });

  it('keeps a cleared problem in the ledger when the cleared notice was not confirmed', async () => {
    const send = vi.fn(async () => ({ ok: false, description: 'Bad Request' }));
    const { deps, ledger } = make({ telegram: vi.fn(async () => ({ send })) }, [fidelity]);
    await sendConnectionProblemNotices(deps, []);
    expect(ledger()).toEqual([fidelity]);
  });

  it('reads and writes nothing for a run that read no record', async () => {
    const { deps } = make({}, [fidelity]);
    await sendConnectionProblemNotices(deps, undefined);
    expect(deps.getSecret).not.toHaveBeenCalled();
    expect(deps.setSecret).not.toHaveBeenCalled();
    expect(deps.telegram).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { deps } = make({ getSecret: vi.fn(async () => { throw new Error('down'); }) });
    await expect(sendConnectionProblemNotices(deps, [fidelity])).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalled();
  });

  it('keeps untrusted names outside every bold or italic entity', async () => {
    const starry = { ...fidelity, key: 'con.auth:C2', connectionName: 'Odd*Bank_One' };
    const { deps, sent } = make();
    await sendConnectionProblemNotices(deps, [fidelity, starry]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Odd\\*Bank\\_One');
    const withoutEscapes = sent[0].replace(/\\./g, '');
    expect(withoutEscapes.match(/\*[^*]*\*/g)).toEqual(['*SimpleFin connection problem*']);
    expect(withoutEscapes).not.toMatch(/_/);
  });

  it('splits many problems into messages under 4096 chars and records only confirmed batches', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...fidelity, key: `con.auth:C${i}`, code: 'act.failed', kind: 'other' as const, connectionName: `Bank${i}`, message: 'x'.repeat(190) }));
    const ok = make();
    await sendConnectionProblemNotices(ok.deps, many);
    expect(ok.sent.length).toBeGreaterThanOrEqual(2);
    for (const m of ok.sent) expect(m.length).toBeLessThan(4096);
    expect(ok.ledger()).toHaveLength(20);

    let n = 0;
    const send = vi.fn(async () => (++n === 1 ? { ok: true } : { ok: false, description: 'boom' }));
    const bad = make({ telegram: vi.fn(async () => ({ send })) });
    await sendConnectionProblemNotices(bad.deps, many);
    const firstBatch = bad.ledger();
    expect(firstBatch.length).toBeGreaterThan(0);
    expect(firstBatch.length).toBeLessThan(20);
    expect(firstBatch.map((p: ConnectionProblem) => p.key)).toEqual(many.slice(0, firstBatch.length).map((p) => p.key));
  });

  it('announces a problem again when it returns after a confirmed clear', async () => {
    const { deps, sent } = make();
    await sendConnectionProblemNotices(deps, [fidelity]);
    await sendConnectionProblemNotices(deps, []);
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toBe('Fidelity\\_NetBenefits is updating again.');
  });

  it('sends both fresh and cleared in one run and records the right ledger', async () => {
    const other = { ...fidelity, key: 'act.failed:a2', connectionName: 'Chase' };
    const { deps, sent, ledger } = make({}, [other]);
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe('Chase is updating again.');
    expect(ledger()).toEqual([fidelity]);
  });

  it('logs once when Telegram is not configured and there is something to send', async () => {
    const { deps } = make({ telegram: vi.fn(async () => null) });
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(deps.log).toHaveBeenCalledWith('Telegram not configured, so no connection-problem notice was sent.');
  });
});

describe('problemsForNotices: runs that did not download (#81)', () => {
  const NOW = new Date('2026-11-18T15:00:00.000Z');
  const recordAt = (ageMs: number) => JSON.stringify({
    checkedAt: new Date(NOW.getTime() - ageMs).toISOString(), problems: [fidelity],
  });
  const HOUR = 3_600_000;
  const tooSoon = (read: () => Promise<string | null>) =>
    problemsForNotices({ downloaded: false, connectionProblems: undefined }, read, NOW);

  it('a too-soon run with a fresh record sends the notice once', async () => {
    const { deps, sent } = make();
    const shown = await tooSoon(async () => recordAt(2 * HOUR));
    await sendConnectionProblemNotices(deps, shown);
    await sendConnectionProblemNotices(deps, await tooSoon(async () => recordAt(3 * HOUR)));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('needs you to sign in again');
  });

  it('a too-soon run with a stale record sends nothing and clears nothing', async () => {
    const { deps, sent, ledger } = make({}, [fidelity]);
    const shown = await tooSoon(async () => recordAt(48 * HOUR + 1));
    expect(shown).toBeUndefined();
    await sendConnectionProblemNotices(deps, shown);
    expect(sent).toEqual([]);
    expect(ledger()).toEqual([fidelity]);
  });

  it('a failed or unparseable read reads no record', async () => {
    expect(await tooSoon(async () => { throw new Error('401'); })).toBeUndefined();
    expect(await tooSoon(async () => '{nope')).toBeUndefined();
    expect(await tooSoon(async () => null)).toBeUndefined();
  });

  it('a downloaded run with connectionProblems absent sends nothing and reads nothing', async () => {
    const read = vi.fn(async () => recordAt(HOUR));
    const shown = await problemsForNotices({ downloaded: true, connectionProblems: undefined }, read, NOW);
    expect(shown).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    const { deps, sent } = make();
    await sendConnectionProblemNotices(deps, shown);
    expect(sent).toEqual([]);
  });
});
