import { describe, it, expect, vi } from 'vitest';
import type { ConnectionProblem } from '../../shared/connection-problems.js';
import { ANNOUNCED_PROBLEMS_SECRET_KEY, sendConnectionProblemNotices, type ProblemNoticeDeps } from './connection-problem-notices.js';

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
      "*Fidelity\\_NetBenefits needs you to sign in again*\nFidelity\\_NetBenefits needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.",
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
});
