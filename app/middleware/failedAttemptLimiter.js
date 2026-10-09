// A small in-memory, per-client-IP limiter on FAILED attempts (no dependency: the app
// has no rate limiter, and express-rate-limit is not installed).
//
// Used by POST /users/verify-vendor-token: after `max` invalid tokens from one client
// within `windowMs`, every further attempt from it (valid or not) is answered 429 until
// the window that started with its first failure ends. Only failures are counted, so
// vendors opening their own links are never slowed down, even when many share one
// office or proxy address; a brute-force run is nothing but failures.
//
// LIMITS (by design, documented in the Task 23 report):
//   - Per process. Each Node process (container, PM2 worker) keeps its own counts, so
//     the effective ceiling is `max` x the number of processes. A shared store (Redis)
//     is the follow-up if the backend is ever scaled out.
//   - The client is the right-most X-Forwarded-For hop (the address our own reverse
//     proxy saw) when the header is present, else the socket address. Behind exactly
//     one proxy that is the real client. Without a proxy the header is caller-chosen,
//     so rotating it evades the limit; the token itself (~60 random bits,
//     helper/emailLinkToken.js) is the real defence, this is depth.

const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const PRUNE_ABOVE = 10_000; // entries before expired ones are swept

/** The client address used as the limiter key. */
export function clientKey(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || req.ip || "unknown";
}

/**
 * @returns {{ isBlocked(req): boolean, recordFailure(req): void, reset(): void }}
 */
export function createFailedAttemptLimiter({
  max = DEFAULT_MAX_FAILURES,
  windowMs = DEFAULT_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  const failures = new Map(); // key -> { count, resetAt }

  const live = (key) => {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= now()) {
      failures.delete(key);
      return null;
    }
    return entry ?? null;
  };

  const prune = () => {
    if (failures.size <= PRUNE_ABOVE) return;
    const t = now();
    for (const [key, entry] of failures) if (entry.resetAt <= t) failures.delete(key);
  };

  return {
    isBlocked(req) {
      const entry = live(clientKey(req));
      return !!entry && entry.count >= max;
    },
    recordFailure(req) {
      const key = clientKey(req);
      const entry = live(key);
      if (entry) entry.count += 1;
      else {
        prune();
        failures.set(key, { count: 1, resetAt: now() + windowMs });
      }
    },
    reset() {
      failures.clear();
    },
  };
}

/** The verify-vendor-token limiter: 20 failures per 10 minutes per client, per process. */
export const verifyVendorTokenLimiter = createFailedAttemptLimiter();

export const TOO_MANY_ATTEMPTS = {
  status: 0,
  message: "Too many invalid link attempts. Please try again in a few minutes.",
};

export default { clientKey, createFailedAttemptLimiter, verifyVendorTokenLimiter, TOO_MANY_ATTEMPTS };
