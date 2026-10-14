import { describe, it, expect, vi } from 'vitest';
import { LINK_SYNC_RUNNING, beginLink } from './write-lock';

let finish!: () => void;
vi.mock('../../shared/sync-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/sync-core')>();
  return {
    ...actual,
    runSyncCore: vi.fn(() => new Promise((resolve) => { finish = () => resolve({ imported: 0, skipped: 0, errors: [] }); })),
  };
});

describe('runSync and the write lock', () => {
  it('holds the lock while it runs, so Link is refused, and waits for a Link in progress', async () => {
    const { runSync } = await import('./sync');
    const store = { changeLogSink: undefined, getTelegramConfig: vi.fn(async () => null) } as any;
    const sync = runSync({} as any, store, {});
    // A sync is running: Link cannot take the lock.
    expect(beginLink()).toBeNull();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish();
    await sync;
    // Free again: Link takes it, and a sync that starts now waits for it.
    const release = beginLink()!;
    expect(release).toBeTypeOf('function');
    const { runSyncCore } = await import('../../shared/sync-core');
    (runSyncCore as ReturnType<typeof vi.fn>).mockClear();
    const waiting = runSync({} as any, store, {});
    await new Promise((r) => setTimeout(r, 10));
    expect(runSyncCore).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(runSyncCore).toHaveBeenCalledTimes(1));
    finish();
    await waiting;
    expect(LINK_SYNC_RUNNING).toContain('sync is running');
  });
});
