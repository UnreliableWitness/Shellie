/**
 * How much of something happened in the last while (window resizes, terminal output), kept per second so that
 * counting costs nothing in a burst. Read when the window hangs, to tell what led up to it.
 */
export class RecentCount {
  private readonly seconds = new Map<number, number>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  add(n = 1): void {
    const second = Math.floor(this.now() / 1000);
    if (!this.seconds.has(second)) this.prune();
    this.seconds.set(second, (this.seconds.get(second) ?? 0) + n);
  }

  total(): number {
    this.prune();
    let sum = 0;
    for (const n of this.seconds.values()) sum += n;
    return sum;
  }

  /** Seconds held, for the tests. */
  get size(): number {
    return this.seconds.size;
  }

  private prune(): void {
    const oldest = Math.floor((this.now() - this.windowMs) / 1000);
    for (const second of this.seconds.keys())
      if (second <= oldest) this.seconds.delete(second);
  }
}
