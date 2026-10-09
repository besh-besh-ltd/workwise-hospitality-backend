// Express 'trust proxy' (https://expressjs.com/en/guide/behind-proxies.html).
//
// Until Task 23 the app never set it, so `req.ip` was always the socket address: behind
// the production reverse proxy that is the proxy itself, the same for every client. The
// emailed-link limiter keys on `req.ip`, so it is now set from TRUST_PROXY_HOPS:
//   - unset / blank / invalid -> 1: trust ONE hop. `req.ip` is the address the proxy
//     appended to X-Forwarded-For (the real client); anything the client put to its left
//     is ignored. Correct for one nginx / load balancer in front of the backend.
//   - 0 -> false: no proxy; `req.ip` is the socket address and X-Forwarded-For is ignored.
//     Use this when the backend is reached directly.
//   - N -> trust N hops (a CDN in front of a load balancer, etc.).
// It also changes req.protocol / req.hostname / req.secure; nothing in the app reads them.
// The only other req.ip reader is requestContext (the activity trail's `ip`), which now
// records the client's address instead of the proxy's.

/** The 'trust proxy' value for TRUST_PROXY_HOPS. */
export function trustProxySetting(raw = process.env.TRUST_PROXY_HOPS) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 1;
  return n === 0 ? false : n;
}

export default { trustProxySetting };
