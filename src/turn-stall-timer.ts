export interface TurnStallTimerScheduler {
  set(callback: () => void, timeoutMs: number): unknown;
  clear(handle: unknown): void;
  unref?(handle: unknown): void;
}

const DEFAULT_SCHEDULER: TurnStallTimerScheduler = {
  set: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  unref: (handle) => (handle as NodeJS.Timeout).unref?.(),
};

/**
 * A restartable no-progress timer for one Codex turn.
 *
 * The owner starts it after turn/start succeeds, calls progress for every
 * authoritative notification on the bound thread, and stops it on every
 * completion/error path.
 */
export class TurnStallTimer {
  private handle: unknown = null;
  private running = false;

  constructor(
    private readonly timeoutMs: number | null,
    private readonly onStall: () => void,
    private readonly scheduler: TurnStallTimerScheduler = DEFAULT_SCHEDULER,
  ) {
    if (
      timeoutMs !== null &&
      (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    ) {
      throw new TypeError("turn stall timeout must be a positive integer or null");
    }
  }

  start(): void {
    this.running = true;
    this.arm();
  }

  progress(): void {
    if (!this.running) return;
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.clear();
  }

  private arm(): void {
    this.clear();
    if (this.timeoutMs === null) return;
    const handle = this.scheduler.set(() => {
      if (!this.running) return;
      this.handle = null;
      this.running = false;
      this.onStall();
    }, this.timeoutMs);
    this.handle = handle;
    this.scheduler.unref?.(handle);
  }

  private clear(): void {
    if (this.handle === null) return;
    this.scheduler.clear(this.handle);
    this.handle = null;
  }
}
