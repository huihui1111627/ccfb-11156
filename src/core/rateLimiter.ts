import { sleep } from './time.js';

/**
 * Sliding-window rate limiter.
 *
 * Guarantees that no more than `requestsPerSecond` request starts fall inside
 * any 1-second window. A naive "space requests by 1000/rps" limiter can still
 * put rps+1 starts into a wall-clock second when requests straddle a second
 * boundary, which a strict server-side fixed-window counter reports as a 429.
 */
export class RateLimiter {
  private readonly starts: number[] = [];

  constructor(private readonly requestsPerSecond: number) {
    if (!(requestsPerSecond > 0)) throw new Error('requestsPerSecond must be > 0');
  }

  async acquire(): Promise<void> {
    const windowMs = 1000;
    for (;;) {
      const now = Date.now();
      // Drop starts that have aged out of the window.
      while (this.starts.length && now - this.starts[0]! >= windowMs) this.starts.shift();
      if (this.starts.length < this.requestsPerSecond) {
        this.starts.push(now);
        return;
      }
      // Wait until the oldest start leaves the window.
      const waitMs = windowMs - (now - this.starts[0]!) + 1;
      await sleep(waitMs);
    }
  }
}

export class RateLimiterRegistry {
  private readonly limiters = new Map<string, { limiter: RateLimiter; rps: number }>();

  constructor(private readonly rpsFor: (destinationId: string) => number) {}

  get(destinationId: string): RateLimiter {
    const rps = this.rpsFor(destinationId);
    const existing = this.limiters.get(destinationId);
    // Re-create when the configured rate changed so config edits apply live.
    if (existing && existing.rps === rps) return existing.limiter;
    const limiter = new RateLimiter(rps);
    this.limiters.set(destinationId, { limiter, rps });
    return limiter;
  }
}

export async function backoff(attempt: number, baseMs: number): Promise<void> {
  const delay = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 2000);
  if (delay > 0) await sleep(delay);
}
