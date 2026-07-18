import { MIN_SYNC_INTERVAL_MS } from './sync';

/**
 * How often the scheduler wakes to check whether a sync is due. This is a
 * short poll on purpose: a single long setInterval (e.g. 6 hours) is
 * suspended or heavily throttled by the browser/Electron when the machine
 * sleeps or the tab is backgrounded, and a suspended timer does NOT catch up
 * the firing it missed — so a scheduled window that elapsed while the app was
 * asleep would be silently skipped. A 60-second timer survives sleep/throttle
 * and fires promptly on wake, and because "due?" is decided against the
 * persisted wall-clock lastSyncAt, a missed window is caught within one poll.
 */
export const SCHEDULER_POLL_MS = 5 * 60 * 1000; // wall-clock check every 5 minutes

export class Scheduler {
  private handle: ReturnType<typeof setInterval> | null = null;
  private intervalMs = 0;
  private getLastSync: (() => Promise<Date | null>) | null = null;
  private onDue: (() => void) | null = null;
  private checking = false;

  /**
   * Begin polling. Every SCHEDULER_POLL_MS the scheduler reads lastSyncAt and,
   * if at least `intervalHours` (clamped to the 1-hour minimum) has elapsed
   * since it, calls `onDue`. The check also runs immediately, so a due sync
   * happens right away on app startup rather than after the first poll.
   *
   * `onDue` should be idempotent under rapid re-entry: runSync is single-flight
   * and interval-guarded, so calling it again before lastSyncAt updates is a
   * cheap no-op.
   */
  start(
    intervalHours: number,
    getLastSync: () => Promise<Date | null>,
    onDue: () => void,
  ): void {
    this.stop();
    this.intervalMs = Math.max(intervalHours * 60 * 60 * 1000, MIN_SYNC_INTERVAL_MS);
    this.getLastSync = getLastSync;
    this.onDue = onDue;
    this.handle = setInterval(() => void this.check(), SCHEDULER_POLL_MS);
    void this.check();
  }

  private async check(): Promise<void> {
    if (this.checking || !this.getLastSync || !this.onDue) return;
    this.checking = true;
    try {
      const last = await this.getLastSync();
      if (!last || Date.now() - last.getTime() >= this.intervalMs) {
        this.onDue();
      }
    } catch {
      // Reading lastSyncAt failed (secrets hiccup) — try again next poll
    } finally {
      this.checking = false;
    }
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
    this.getLastSync = null;
    this.onDue = null;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }
}
