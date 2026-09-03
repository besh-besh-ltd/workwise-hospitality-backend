import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient per-request context.
 *
 * This backend threads the acting user explicitly through every layer —
 * `performed_by`, `changedBy`, `userId` — and that is fine for code that was
 * handed it. It does not work for code that cannot be handed anything: a
 * Postgres trigger writing an audit row has no idea which person caused the
 * UPDATE, which is why `audit_log_temp.changed_by` has always read 'postgres'.
 *
 * AsyncLocalStorage gives that code the actor without changing 342 call sites.
 * Read it; never depend on it being present. Anything outside an HTTP request
 * — a cron tick, a script, a test calling a model directly — gets null, and
 * every consumer here is written to cope with that rather than throw.
 */
export const requestContextStorage = new AsyncLocalStorage();

export const runWithRequestContext = (ctx, fn) => requestContextStorage.run(ctx, fn);

export const getRequestContext = () => requestContextStorage.getStore() ?? null;

/**
 * The acting user's id, or null when there is not one.
 *
 * Resolved from the live `req` on every call rather than snapshotted when the
 * context opened. The context has to be mounted before the router — that is
 * the only single place covering every route — but authentication is
 * per-route and runs afterwards, so at open time `req.user` does not exist
 * yet. Anything that captured the actor eagerly would record nobody for every
 * authenticated request in the application.
 */
export const getActorUserId = () => {
  const ctx = getRequestContext();
  if (!ctx) return null;
  if (ctx.actorUserId !== undefined && ctx.actorUserId !== null) return ctx.actorUserId;
  const id = ctx.req?.user?.id;
  // -1 is auth.js's marker for a token-authenticated site representative. It
  // is not a row in tbl_users and must never be written anywhere as one.
  return typeof id === 'number' && id > 0 ? id : null;
};

export const getRequestId = () => getRequestContext()?.requestId ?? null;

export const updateRequestContext = (patch) => {
  const ctx = getRequestContext();
  if (ctx) Object.assign(ctx, patch);
};
