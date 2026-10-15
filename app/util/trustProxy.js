// Express 'trust proxy' (https://expressjs.com/en/guide/behind-proxies.html).
//
// `req.ip` keys the emailed-link limiter and is the activity trail's `ip`, so it must be an
// address the client cannot choose. Set from TRUST_PROXY_HOPS:
//   - unset / blank / invalid -> false: trust no proxy. `req.ip` is the socket address and
//     X-Forwarded-For is ignored. This is the default because of how production is reached
//     (measured from request traces, 2026-10-15): every request arrives from the Docker
//     bridge gateway, and the reverse proxy does NOT add X-Forwarded-For; it passes on
//     whatever the client sent. Trusting a hop there would let any client pick its own
//     address (a fresh limiter bucket per request, a forged ip in the activity trail).
//     The cost is that all clients share one limiter bucket, which is the safe direction.
//   - N >= 1 -> trust N hops. Set 1 only once the proxy appends the client address
//     (nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for) and the
//     backend port is reachable through the proxy alone.
// It also changes req.protocol / req.hostname / req.secure; nothing in the app reads them.

/** The 'trust proxy' value for TRUST_PROXY_HOPS. */
export function trustProxySetting(raw = process.env.TRUST_PROXY_HOPS) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return false;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return false;
  return n;
}

export default { trustProxySetting };
