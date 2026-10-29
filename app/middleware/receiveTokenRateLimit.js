// Rate limit for site-rep receive tokens (spec §10.3, task C5): 60 requests per
// 10 minutes per token, per process.
//
// The house limiter (middleware/failedAttemptLimiter.js) counts only FAILED
// attempts per client address. This one counts every request that presents a
// token, so it also caps a valid link being scripted or forwarded around. It
// runs before the token is looked up, so a capped token costs no database work.
//
// Keyed by the token's sha256 (the plain token is never held in memory or
// logged), not by token + client address:
//   - a token used from many addresses still gets 60 requests in all;
//   - in production every client reaches the app from one address (see
//     app/util/trustProxy.js), so an address-keyed bucket would be one global
//     bucket that anyone could fill to lock every site rep out.
// Tokens are 32 random bytes (legacy ones are HMAC-SHA256), so there is nothing
// to brute-force; a malformed token is refused before any query and is not
// counted.
//
// One bucket per token across the new /inventory/token/* routes and the legacy
// token path of GET /po/:po_id and POST /po/markGRN (auth.authUserOrGRNToken).
//
// LIMITS: per process (a second instance keeps its own counts; a shared store
// such as Redis is the follow-up if the backend is scaled out), and at most
// `maxKeys` tokens are tracked (oldest evicted first).
//
// KNOWN GAP (accepted for now): unknown tokens are counted too, so about 10k
// distinct well-formed garbage tokens evict a real token's bucket; the holder
// of a valid link can reset their own cap for about 10k requests' cost each
// time. Follow-up: cap the buckets held for misses (hashes that match no
// token) separately, per process, so garbage can't evict a live link's count.

import { logger } from '../util/logger.js';
import {
  hashReceiveToken,
  isWellFormedReceiveToken,
  RECEIVE_TOKEN_HEADER,
} from '../helper/receiveToken.js';

export const RECEIVE_TOKEN_RATE_LIMIT = Object.freeze({ max: 60, windowMs: 10 * 60 * 1000 });

const DEFAULT_MAX_KEYS = 10_000;

/**
 * A fixed-window request counter: `max` hits per key per `windowMs`, counted
 * from the key's first hit.
 *
 * @returns {{ hit(key: string): {allowed: boolean, retryAfterS: number},
 *   reset(): void, size(): number }}
 */
export function createRequestLimiter({
  max,
  windowMs,
  maxKeys = DEFAULT_MAX_KEYS,
  now = () => Date.now(),
} = {}) {
  const hits = new Map(); // key -> { count, resetAt }; insertion order = expiry order

  const pruneExpired = (t) => {
    for (const [key, entry] of hits) {
      if (entry.resetAt > t) break;
      hits.delete(key);
    }
  };

  return {
    hit(key) {
      const t = now();
      pruneExpired(t);
      let entry = hits.get(key);
      if (!entry) {
        while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= max,
        retryAfterS: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)),
      };
    },
    reset() {
      hits.clear();
    },
    size() {
      return hits.size;
    },
  };
}

/** The process-wide receive-token limiter (60 per 10 minutes per token). */
export const receiveTokenLimiter = createRequestLimiter(RECEIVE_TOKEN_RATE_LIMIT);

export const TOO_MANY_REQUESTS = Object.freeze({
  status: 0,
  code: 'RATE_LIMITED',
  message: 'Too many requests from this link. Please wait a few minutes and try again.',
});

/**
 * Count one use of `token`. A missing or malformed token is not counted (the
 * auth refuses it without a query).
 * @returns {{allowed: boolean, retryAfterS: number}}
 */
export function admitReceiveToken(token) {
  if (!isWellFormedReceiveToken(token)) return { allowed: true, retryAfterS: 0 };
  return receiveTokenLimiter.hit(hashReceiveToken(token));
}

/** Answer 429 with Retry-After. Logs the route and client, never the token. */
export function sendTooManyRequests(req, res, retryAfterS) {
  logger.warn(
    { route: req.originalUrl?.split('?')[0], method: req.method, ip: req.ip },
    '[receive-token] rate limited'
  );
  res.set('Retry-After', String(retryAfterS));
  return res.status(429).json(TOO_MANY_REQUESTS);
}

/** Route middleware for /inventory/token/*, ahead of receiveTokenAuth (header only). */
export const receiveTokenRateLimit = (req, res, next) => {
  const verdict = admitReceiveToken(req.get(RECEIVE_TOKEN_HEADER));
  if (!verdict.allowed) return sendTooManyRequests(req, res, verdict.retryAfterS);
  return next();
};

export default receiveTokenRateLimit;
