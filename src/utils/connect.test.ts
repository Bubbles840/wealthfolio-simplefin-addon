import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import { claimAccessUrl, credentialsB64, replaceConnection, replacedMessage, type ClaimedToken } from './connect';
import { SecretsStore } from './secrets';
import { beginSync } from './write-lock';
import { requireWealthfolioSecretKey } from '../../shared/__fixtures__/wealthfolio-secret-key';

function makeNetwork(requestImpl?: () => Promise<{ status: number; headers: Record<string, string>; body: string }>): NetworkAPI {
  return { request: vi.fn(requestImpl) } as unknown as NetworkAPI;
}

const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/NEW';
const NEW_URL = 'https://new:secret2@beta-bridge.simplefin.org/simplefin';

describe('claimAccessUrl', () => {
  it('reuses the access URL a token already gave in this visit', async () => {
    const network = makeNetwork(async () => ({ status: 200, headers: {}, body: NEW_URL }));
    const first = await claimAccessUrl(`  ${btoa(CLAIM_URL)}\n`, network, null);
    expect(first).toEqual({ token: btoa(CLAIM_URL), accessUrl: NEW_URL });
    expect(await claimAccessUrl(btoa(CLAIM_URL), network, first)).toBe(first);
    expect(network.request).toHaveBeenCalledTimes(1);
  });
  it('claims a different token afresh', async () => {
    const network = makeNetwork(async () => ({ status: 200, headers: {}, body: NEW_URL }));
    await claimAccessUrl(btoa('https://bridge.simplefin.org/claim/OTHER'), network, { token: btoa(CLAIM_URL), accessUrl: NEW_URL });
    expect(network.request).toHaveBeenCalledWith({ url: 'https://bridge.simplefin.org/claim/OTHER', method: 'POST' });
  });
});

describe('credentialsB64', () => {
  it("is base64 of the URL's user:pass, as Setup always computed it", () => {
    expect(credentialsB64('https://user:pass@bridge.simplefin.org/simplefin')).toBe(btoa('user:pass'));
    // Percent-encoded as the URL holds it, not decoded: unchanged behaviour.
    expect(credentialsB64('https://u:p%2Bq@bridge.simplefin.org/simplefin')).toBe(btoa('u:p%2Bq'));
  });
});

// ── replaceConnection ────────────────────────────────────────────────────
const NOW = new Date('2026-11-26T15:00:00.000Z');
const OLD_URL = 'https://old:secret1@bridge.simplefin.org/simplefin';
const seed = (): Record<string, string> => ({
  simplefin_access_url: OLD_URL,
  simplefin_auth_b64: btoa('old:secret1'),
  account_mapping: JSON.stringify({ 'ACT-1': 'wf-check', 'ACT-2': 'wf-card' }),
  account_names: JSON.stringify({ 'ACT-1': 'Checking', 'ACT-2': 'Citi Card', 'ACT-9': 'Car Loan' }),
  loan_links: JSON.stringify({ 'ACT-9': 'loan-1' }),
});
const acct = (id: string, name: string) => ({ id, name, currency: 'USD', balance: '1.00', 'balance-date': 1764000000 });
type Reply = { status: number; headers: Record<string, string>; body: string };
const accounts = (list: unknown[], errors: string[] = []): Reply =>
  ({ status: 200, headers: {}, body: JSON.stringify({ errors, accounts: list }) });
const claimOk = (url = NEW_URL): Reply => ({ status: 200, headers: {}, body: url });

function harness(
  data: Record<string, string>,
  getReplies: Array<Reply | Error>,
  postReplies: Array<Reply | Error> = [claimOk()],
) {
  const secrets = {
    get: vi.fn(async (k: string) => { requireWealthfolioSecretKey(k); return data[k] ?? null; }),
    set: vi.fn(async (k: string, v: string) => { requireWealthfolioSecretKey(k); data[k] = v; }),
    delete: vi.fn(async (k: string) => { requireWealthfolioSecretKey(k); delete data[k]; }),
  };
  const store = new SecretsStore({ api: { secrets } } as any);
  const gets: any[] = [];
  const atDownload: Array<Record<string, string | undefined>> = [];
  let g = 0;
  let p = 0;
  const request = vi.fn(async (req: any) => {
    const queue = req.method === 'POST' ? postReplies : getReplies;
    const i = req.method === 'POST' ? p++ : g++;
    if (req.method !== 'POST') {
      gets.push(req);
      atDownload.push({ ...data });
    }
    const reply = queue[Math.min(i, queue.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const network = { request } as unknown as NetworkAPI;
  const claimed = { current: null as ClaimedToken | null };
  return { store, data, secrets, network, claimed, gets, atDownload, request };
}
const TOKEN = btoa(CLAIM_URL);
const run = (h: ReturnType<typeof harness>, pasted = TOKEN) =>
  replaceConnection(pasted, h.claimed, { store: h.store, network: h.network });

describe('replaceConnection', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('tests the new token under the temporary key, then swaps the connection and keeps everything else', async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'Checking 1234')])]);
    const out = await run(h);
    expect(out.kind).toBe('replaced');
    expect(h.gets[0].auth.secretKey).toBe('simplefin_auth_b64_next');
    // Order: at the test download the working connection is still the old one.
    expect(h.atDownload[0].simplefin_access_url).toBe(OLD_URL);
    expect(h.atDownload[0].simplefin_auth_b64).toBe(btoa('old:secret1'));
    expect(h.atDownload[0].simplefin_auth_b64_next).toBe(btoa('new:secret2'));
    expect(new URL(h.gets[0].url).host).toBe('beta-bridge.simplefin.org');
    expect(h.data.simplefin_access_url).toBe(NEW_URL);
    expect(h.data.simplefin_auth_b64).toBe(btoa('new:secret2'));
    expect(h.data.simplefin_auth_b64_next).toBeUndefined();
    expect(h.data.simplefin_connection_replaced_at).toBe(NOW.toISOString());
    expect(h.data.account_mapping).toBe(seed().account_mapping);
    expect(h.data.loan_links).toBe(seed().loan_links);
    expect(JSON.parse(h.data.account_names)).toEqual({
      'ACT-1': 'Checking', 'ACT-2': 'Citi Card', 'ACT-9': 'Car Loan', 'NEW-1': 'Checking 1234',
    });
  });

  it('says every mapped account is there when the new list has them all', async () => {
    const h = harness(seed(), [accounts([acct('ACT-1', 'Checking'), acct('ACT-2', 'Citi Card'), acct('ACT-9', 'Car Loan')])]);
    const out = await run(h);
    expect(out).toMatchObject({
      kind: 'replaced',
      message: '✓ Connected through SimpleFIN Bridge. All 3 mapped accounts are in this connection. The next sync uses it.',
      missing: [],
    });
  });

  it('names the mapped accounts the new connection lacks, loans included, by their stored names', async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'Checking 1234')])]);
    const out = await run(h);
    expect(out).toMatchObject({
      kind: 'replaced',
      missing: ['ACT-1', 'ACT-2', 'ACT-9'],
      message: "✓ Connected through SimpleFIN Bridge. 3 mapped accounts aren't in this connection: Checking, Citi Card, Car Loan. If your bank lists them under new names, map them in the Accounts card above.",
    });
  });

  it('words one mapped account and none', () => {
    expect(replacedMessage('Lunch Flow', 0, [])).toBe('✓ Connected through Lunch Flow. The next sync uses it.');
    expect(replacedMessage('Lunch Flow', 1, [])).toBe('✓ Connected through Lunch Flow. Your mapped account is in this connection. The next sync uses it.');
    expect(replacedMessage('Lunch Flow', 2, ['Checking'])).toBe("✓ Connected through Lunch Flow. 1 mapped account isn't in this connection: Checking. If your bank lists it under a new name, map it in the Accounts card above.");
  });

  it('leaves the working connection untouched when the new token lists no accounts', async () => {
    const h = harness(seed(), [accounts([])]);
    const out = await run(h);
    expect(out).toEqual({
      kind: 'failed',
      message: "The token was accepted, but SimpleFIN didn't list any accounts: the account list was empty. Your current connection is unchanged. Press Connect to try again: the same token works while this page stays open.",
    });
    const { simplefin_requests: _requests, ...rest } = h.data;
    expect(rest).toEqual(seed());
    expect(_requests).toBeDefined();
  });

  it('leaves it untouched when the test download fails, and says why', async () => {
    const h = harness(seed(), [{ status: 403, headers: {}, body: 'Forbidden' }]);
    const out = await run(h);
    expect(out.kind).toBe('failed');
    expect((out as { message: string }).message).toContain("didn't list any accounts: SimpleFin /accounts failed: 403 — Forbidden. Your current connection is unchanged.");
    expect(h.data.simplefin_access_url).toBe(OLD_URL);
    expect(h.data.simplefin_auth_b64).toBe(btoa('old:secret1'));
    expect(h.data.simplefin_auth_b64_next).toBeUndefined();
  });

  it("quotes SimpleFIN's errors as the reason when they come with no accounts", async () => {
    const h = harness(seed(), [accounts([], ['Chase: sign in again'])]);
    const out = await run(h);
    expect((out as { message: string }).message).toContain("didn't list any accounts: Chase: sign in again. Your current");
  });

  it('retries with the access URL it already claimed while the page stays open', async () => {
    const h = harness(seed(), [{ status: 500, headers: {}, body: 'boom' }, accounts([acct('NEW-1', 'Checking 1234')])]);
    expect((await run(h)).kind).toBe('failed');
    expect((await run(h)).kind).toBe('replaced');
    expect(h.request.mock.calls.filter(([r]: any) => r.method === 'POST')).toHaveLength(1);
  });

  it("shows SimpleFIN's errors beside a list that has accounts, without blocking", async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'Checking 1234')], ['Chase: sign in again'])]);
    expect(await run(h)).toMatchObject({ kind: 'replaced', feedErrors: ['Chase: sign in again'], hadErrors: true });
  });

  it('asks the budget first: refused at the Setup ceiling, no token claimed', async () => {
    const data = seed();
    data.simplefin_requests = JSON.stringify(
      Array.from({ length: 24 }, (_, i) => new Date(NOW.getTime() - (60 + i) * 60_000).toISOString()),
    );
    const h = harness(data, [accounts([acct('NEW-1', 'x')])]);
    const out = await run(h);
    expect((out as { message: string }).message).toMatch(/SimpleFin's daily limit is used up/);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.data.simplefin_access_url).toBe(OLD_URL);
  });

  it('refuses while a sync holds the add-on write lock, claiming and counting nothing', async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'x')])]);
    const end = await beginSync();
    try {
      expect(await run(h)).toEqual({ kind: 'failed', message: 'A sync is running — try again when it finishes.' });
    } finally {
      end();
    }
    expect(h.request).not.toHaveBeenCalled();
    expect(h.data.simplefin_requests).toBeUndefined();
  });

  it('records one change-log entry naming the providers, never the URL', async () => {
    const h = harness(
      seed(),
      [accounts([acct('NEW-1', 'x')])],
      [claimOk('https://new:secret2@www.lunchflow.app/simplefin')],
    );
    expect((await run(h, btoa('https://www.lunchflow.app/simplefin/claim/X'))).kind).toBe('replaced');
    const entries = (await h.store.getChangeLog())!.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'connection-replaced', actor: 'you', undoable: false, summary: 'Replaced the SimpleFIN connection',
      before: { provider: 'SimpleFIN Bridge' }, after: { provider: 'Lunch Flow' },
    });
    const text = JSON.stringify(entries);
    for (const s of ['secret1', 'secret2', 'simplefin.org/simplefin']) expect(text).not.toContain(s);
  });

  it('reports a spent token as the claim says, storing nothing', async () => {
    const h = harness(seed(), [], [{ status: 403, headers: {}, body: '' }]);
    const out = await run(h);
    expect((out as { message: string }).message).toMatch(/already used/);
    expect(h.claimed.current).toBeNull();
    expect(h.data.simplefin_access_url).toBe(OLD_URL);
    expect(h.data.simplefin_auth_b64).toBe(btoa('old:secret1'));
  });

  it('refuses an access URL pasted as a token, storing nothing and echoing nothing', async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'x')])]);
    const out = await run(h, OLD_URL);
    const message = (out as { message: string }).message;
    expect(message).toMatch(/does not look like a SimpleFin setup token/);
    expect(message).not.toContain('secret1');
    expect(h.request).not.toHaveBeenCalled();
  });

  it("passes on Wealthfolio's host-approval message and claims again on retry", async () => {
    const h = harness(
      seed(),
      [accounts([acct('NEW-1', 'x')])],
      [new Error("host 'www.lunchflow.app' is not approved"), claimOk('https://new:secret2@www.lunchflow.app/simplefin')],
    );
    const token = btoa('https://www.lunchflow.app/simplefin/claim/X');
    const first = await run(h, token);
    expect((first as { message: string }).message).toMatch(/hasn't approved this add-on to connect to www.lunchflow.app/);
    expect((first as { message: string }).message).toMatch(/paste the same token again/);
    expect(h.claimed.current).toBeNull();
    expect((await run(h, token)).kind).toBe('replaced');
    expect(h.request.mock.calls.filter(([r]: any) => r.method === 'POST')).toHaveLength(2);
  });

  const untouched = (h: ReturnType<typeof harness>) => {
    const { simplefin_requests: _r, ...rest } = h.data;
    expect(rest).toEqual(seed());
  };
  const rejectSetFor = (h: ReturnType<typeof harness>, key: string) => {
    const real = h.secrets.set.getMockImplementation()!;
    h.secrets.set.mockImplementation(async (k: string, v: string) => {
      if (k === key) throw new Error('disk full');
      return real(k, v);
    });
  };

  it('rolls the access URL back when the credentials cannot be saved', async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'x')])]);
    rejectSetFor(h, 'simplefin_auth_b64');
    await expect(run(h)).rejects.toThrow('disk full');
    untouched(h);
    expect(h.claimed.current).not.toBeNull();
    expect((await h.store.getChangeLog())!.entries).toEqual([]);
  });

  it('clears the temporary key when the access URL cannot be saved', async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'x')])]);
    rejectSetFor(h, 'simplefin_access_url');
    await expect(run(h)).rejects.toThrow('disk full');
    untouched(h);
    expect(h.claimed.current).not.toBeNull();
  });

  it("doesn't blame SimpleFIN when the temporary key cannot be saved", async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'x')])]);
    rejectSetFor(h, 'simplefin_auth_b64_next');
    const out = await run(h);
    expect(out).toEqual({ kind: 'failed', message: "Couldn't save the new token's details in Wealthfolio: disk full. Your current connection is unchanged." });
    untouched(h);
    expect(h.request.mock.calls.map(([r]: any) => r.method)).toEqual(['POST']);
  });

  it('never replaces the names wholesale when they could not be read', async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'x')])]);
    vi.spyOn(h.store, 'getAccountNames').mockRejectedValue(new Error('bad json'));
    const out = await run(h);
    expect(out.kind).toBe('replaced');
    expect(h.data.account_names).toBe(seed().account_names);
  });

  it('still reports replaced when the change log cannot be written', async () => {
    const h = harness(seed(), [accounts([acct('NEW-1', 'x')])]);
    vi.spyOn(h.store, 'recordChange').mockRejectedValue(new Error('nope'));
    expect((await run(h)).kind).toBe('replaced');
    expect(h.data.simplefin_access_url).toBe(NEW_URL);
    expect(h.data.simplefin_auth_b64).toBe(btoa('new:secret2'));
  });
});
