/**
 * Deferring an HTTP response out of a `db.tx()` / `db.task()` callback.
 *
 * WHY THIS EXISTS
 *
 * Writing the response from inside a pg-promise transaction callback puts the
 * bytes on the socket BEFORE pg-promise issues `COMMIT`. Two things break:
 *
 *   1. Read-after-write races. The client gets 200 and immediately re-reads the
 *      record; that read lands on a DIFFERENT pooled connection and sees the
 *      pre-commit snapshot, so it 404s (or reads the old status) on a row the
 *      same request just told it exists. This is a real production bug and also
 *      the cause of the intermittent `arc-core-2` CI failures, where the test
 *      harness's own pg-promise pool observes the pre-commit state.
 *   2. Unreportable commit failures. If `COMMIT` then fails, the user already
 *      holds a 200 with headers flushed, so the error handler's 500 can never
 *      reach them. The request reports success for work that rolled back.
 *
 * The cure is always the same shape: return data from the transaction, respond
 * after it resolves.
 *
 *     const result = await db.tx(async (t) => { ...; return data; });
 *     return ok(res, result, 'message');
 *
 * WHAT THIS MODULE ADDS
 *
 * That shape is obvious for the happy path but awkward for the early-return
 * validation guards that several controllers run inside the transaction (they
 * need `t` to read the rows they validate). Those guards used to call
 * `bad(res, 400, '...')` mid-transaction. Here they return a marker object
 * instead, and the caller converts it to the identical HTTP response after the
 * transaction settles.
 *
 * IMPORTANT — this deliberately does NOT change commit/rollback semantics.
 * A guard that returns a marker resolves the callback normally, so pg-promise
 * still COMMITs, exactly as returning `bad(...)`'s value did before. Throwing
 * instead would roll back, which is a different (and in places load-bearing)
 * behaviour; converting these guards to rollback is a separate decision, not a
 * side effect of moving the response off the transaction.
 *
 * Enforced by `scripts/check-response-in-tx.mjs`.
 */

const MARKER = '__deferredResponse';

/**
 * Marker mirroring the controllers' `bad(res, status, message, code)` helper,
 * whose body is `{ status: code, message }`.
 */
export function deferBad(httpStatus, message, code = 0) {
  return { [MARKER]: { httpStatus, body: { status: code, message } } };
}

/** Marker for an arbitrary JSON body, e.g. one carrying a `code` discriminator. */
export function deferJson(httpStatus, body) {
  return { [MARKER]: { httpStatus, body } };
}

/** True when a transaction callback resolved to one of the markers above. */
export function isDeferred(value) {
  return !!(value && typeof value === 'object' && value[MARKER]);
}

/** Emit the deferred response. Call only after the transaction has settled. */
export function sendDeferred(res, value) {
  const { httpStatus, body } = value[MARKER];
  return res.status(httpStatus).json(body);
}
