import { MIN_SYNC_INTERVAL_MS } from './sync';

export class Scheduler {
  private handle: ReturnType<typeof setInterval> | null = null;

  start(intervalHours: number, onTick: () => void): void {
    this.stop();
    const ms = Math.max(intervalHours * 60 * 60 * 1000, MIN_SYNC_INTERVAL_MS);
    this.handle = setInterval(onTick, ms);
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  isRunning(): boolean {
    return this.handle !== null;
  }
}
