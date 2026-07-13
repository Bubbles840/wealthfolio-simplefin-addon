import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, SCHEDULER_POLL_MS } from './scheduler';

const HOUR = 60 * 60 * 1000;

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires immediately on start when already past due', async () => {
    const onDue = vi.fn();
    const last = new Date(Date.now() - 5 * HOUR);
    const s = new Scheduler();
    s.start(4, async () => last, onDue);
    await vi.advanceTimersByTimeAsync(0); // flush the immediate check
    expect(onDue).toHaveBeenCalledOnce();
  });

  it('does not fire on start when not yet due', async () => {
    const onDue = vi.fn();
    const last = new Date(Date.now() - 1 * HOUR);
    const s = new Scheduler();
    s.start(4, async () => last, onDue);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDue).not.toHaveBeenCalled();
  });

  it('fires once the wall-clock interval elapses (no long timer needed)', async () => {
    const onDue = vi.fn();
    const last = new Date(); // just synced
    const s = new Scheduler();
    s.start(4, async () => last, onDue);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(onDue).toHaveBeenCalled();
  });

  it('catches up a window missed while asleep within one poll', async () => {
    // lastSync is 10h old with a 4h interval: the machine was off across
    // several windows. The poller must sync on its very next tick.
    const onDue = vi.fn();
    const last = new Date(Date.now() - 10 * HOUR);
    const s = new Scheduler();
    s.start(4, async () => last, onDue);
    await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_MS);
    expect(onDue).toHaveBeenCalled();
  });

  it('clamps intervals below 1 hour to 1 hour', async () => {
    const onDue = vi.fn();
    const last = new Date();
    const s = new Scheduler();
    s.start(0.1, async () => last, onDue); // 6 minutes requested
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(onDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000); // now past 1 hour
    expect(onDue).toHaveBeenCalled();
  });

  it('stop() prevents further checks', async () => {
    const onDue = vi.fn();
    const last = new Date(Date.now() - 10 * HOUR);
    const s = new Scheduler();
    s.start(4, async () => last, onDue);
    await vi.advanceTimersByTimeAsync(0);
    onDue.mockClear();
    s.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(onDue).not.toHaveBeenCalled();
  });

  it('does not overlap checks while a slow lastSync read is pending', async () => {
    const onDue = vi.fn();
    let resolve!: (d: Date | null) => void;
    const getLastSync = vi.fn(() => new Promise<Date | null>((r) => { resolve = r; }));
    const s = new Scheduler();
    s.start(4, getLastSync, onDue);
    // The immediate check starts and blocks on the pending read; further
    // polls must not launch overlapping reads.
    await vi.advanceTimersByTimeAsync(3 * SCHEDULER_POLL_MS);
    expect(getLastSync).toHaveBeenCalledOnce();
    resolve(new Date(Date.now() - 10 * HOUR));
    await vi.advanceTimersByTimeAsync(0);
    expect(onDue).toHaveBeenCalledOnce();
  });

  it('isRunning() reflects state', () => {
    const s = new Scheduler();
    expect(s.isRunning()).toBe(false);
    s.start(4, async () => null, vi.fn());
    expect(s.isRunning()).toBe(true);
    s.stop();
    expect(s.isRunning()).toBe(false);
  });
});
