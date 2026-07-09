import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from './scheduler';

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls onTick after the interval', () => {
    const onTick = vi.fn();
    const s = new Scheduler();
    s.start(4, onTick); // 4 hours
    vi.advanceTimersByTime(4 * 60 * 60 * 1000);
    expect(onTick).toHaveBeenCalledOnce();
  });

  it('does not call onTick before the interval', () => {
    const onTick = vi.fn();
    const s = new Scheduler();
    s.start(6, onTick);
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('calls onTick multiple times', () => {
    const onTick = vi.fn();
    const s = new Scheduler();
    s.start(4, onTick);
    vi.advanceTimersByTime(12 * 60 * 60 * 1000);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it('stop() prevents further ticks', () => {
    const onTick = vi.fn();
    const s = new Scheduler();
    s.start(4, onTick);
    vi.advanceTimersByTime(4 * 60 * 60 * 1000);
    s.stop();
    vi.advanceTimersByTime(4 * 60 * 60 * 1000);
    expect(onTick).toHaveBeenCalledOnce();
  });

  it('clamps intervals below 1 hour to 1 hour', () => {
    const onTick = vi.fn();
    const s = new Scheduler();
    s.start(0.1, onTick); // 6 minutes — should be clamped to 1 hour
    vi.advanceTimersByTime(30 * 60 * 1000); // 30 min — should NOT have fired
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(31 * 60 * 1000); // now past 1 hour
    expect(onTick).toHaveBeenCalledOnce();
  });

  it('isRunning() reflects state', () => {
    const s = new Scheduler();
    expect(s.isRunning()).toBe(false);
    s.start(4, vi.fn());
    expect(s.isRunning()).toBe(true);
    s.stop();
    expect(s.isRunning()).toBe(false);
  });
});
