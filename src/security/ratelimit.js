// Token-bucket rate limiter keyed by arbitrary strings (IP, username, tool).
export class RateLimiter {
  constructor({ windowMs = 60000, max = 100 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map();
    this._lastSweep = Date.now();
  }

  _sweep() {
    const now = Date.now();
    if (now - this._lastSweep < this.windowMs) return;
    this._lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > this.windowMs * 2) this.buckets.delete(key);
    }
  }

  // Returns { allowed, remaining, retryAfterMs }.
  take(key) {
    this._sweep();
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { windowStart: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - bucket.count),
      retryAfterMs: allowed ? 0 : this.windowMs - (now - bucket.windowStart),
    };
  }

  reset(key) {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}

export class RateLimitError extends Error {
  constructor(retryAfterMs) {
    super(`rate limit exceeded, retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.code = 'ERATELIMIT';
    this.status = 429;
    this.retryAfterMs = retryAfterMs;
  }
}
