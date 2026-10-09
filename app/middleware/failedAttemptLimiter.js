// A small in-memory, per-client-IP limiter on FAILED attempts (no dependency: the app
// has no rate limiter, and express-rate-limit is not installed).
//
// Used by the emailed-link token exchanges (POST /users/verify-vendor-token and the
// `?token=` path of noLogin.vendorTokenOrJwt): after `max` invalid tokens from one client
// within `windowMs`, every further attempt from it (valid or not) is answered 429 until
// the window that started with its first failure ends. Only failures are counted, so
// vendors opening their own links are never slowed down; a brute-force run is nothing
// but failures.
//
// The client is `req.ip`, i.e. Express's answer under the app's 'trust proxy' setting
// (app/util/trustProxy.js, env TRUST_PROXY_HOPS, default 1 hop). Behind one reverse proxy
// that is the address the proxy saw; a client-supplied X-Forwarded-For prefix is ignored.
//
// LIMITS (documented in the Task 23 report and the runbook):
//   - Per process: each Node process keeps its own counts (a shared store such as Redis is
//     the follow-up if the backend is scaled out).
//   - Bounded memory: at most `maxKeys` clients are tracked. Entries are kept in
//     insertion order, which is also expiry order (every window is the same length), so
//     expired entries are pruned from the head in amortised O(1), and when the cap is
//     reached the oldest entry is evicted.

const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_KEYS = 10_000;

/** The client address used as the limiter key (see the header on 'trust proxy'). */
export function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * @returns {{ isBlocked(req): boolean, recordFailure(req): void, reset(): void, size(): number }}
 */
export function createFailedAttemptLimiter({
  max = DEFAULT_MAX_FAILURES,
  windowMs = DEFAULT_WINDOW_MS,
  maxKeys = DEFAULT_MAX_KEYS,
  now = () => Date.now(),
} = {}) {
  const failures = new Map(); // key -> { count, resetAt }, insertion order = expiry order

  /** Drops expired entries from the head; stops at the first live one. */
  const pruneExpired = () => {
    const t = now();
    for (const [key, entry] of failures) {
      if (entry.resetAt > t) break;
      failures.delete(key);
    }
  };

  const live = (key) => {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= now()) {
      failures.delete(key);
      return null;
    }
    return entry ?? null;
  };

  return {
    isBlocked(req) {
      const entry = live(clientKey(req));
      return !!entry && entry.count >= max;
    },
    recordFailure(req) {
      pruneExpired();
      const key = clientKey(req);
      const entry = live(key);
      if (entry) {
        entry.count += 1;
        return;
      }
      while (failures.size >= maxKeys) {
        failures.delete(failures.keys().next().value); // evict the oldest
      }
      failures.set(key, { count: 1, resetAt: now() + windowMs });
    },
    reset() {
      failures.clear();
    },
    size() {
      return failures.size;
    },
  };
}

/** The emailed-link token limiter: 20 failures per 10 minutes per client, per process. */
export const verifyVendorTokenLimiter = createFailedAttemptLimiter();

export const TOO_MANY_ATTEMPTS = {
  status: 0,
  message: "Too many invalid link attempts. Please try again in a few minutes.",
};

export default { clientKey, createFailedAttemptLimiter, verifyVendorTokenLimiter, TOO_MANY_ATTEMPTS };
