/**
 * `approval:changed` — push instead of poll for the pending-approval badge.
 *
 * ── CONTRACT (frontend) ─────────────────────────────────────────────────────
 *   event   : 'approval:changed'
 *   room    : `user:<id>` — the room every authenticated socket is put in by
 *             app/util/socket.js (handshake token) / `addNewUser`
 *   payload : { entity_type, entity_id }   — NO counts, NO names. A signal
 *             only: refetch GET /api/v1/general/hospitality/approval/pending/counts
 *             (and any open approval view for that entity). Duplicates and
 *             out-of-order frames are harmless by construction.
 *   when    : after COMMIT of any write that can change somebody's pending
 *             set — an approval instance / step / approver row created,
 *             actioned (approve / reject), skipped, auto-approved, cancelled,
 *             or an approver reassigned / added / removed mid-flight
 *             (delegation applies at resolution, i.e. at instance creation).
 *   to whom : every user holding an approver row on the instance, ANY status
 *             (REMOVED tombstones included — losing a row changes your set),
 *             plus any extra ids the caller names (e.g. a replaced approver).
 *
 * ── GUARANTEES (backend) ────────────────────────────────────────────────────
 *   - Never emitted inside a transaction. Given a pg-promise tx/task context,
 *     emission waits until the OUTERMOST transaction has finished and fires
 *     only if it committed (a rolled-back write emits nothing). Given `db` or
 *     nothing, the write has already autocommitted and emission is scheduled
 *     on the next tick.
 *   - Never breaks the write: fire-and-forget, every failure is logged and
 *     swallowed, the recipient lookup runs on the pool AFTER commit, never on
 *     the caller's connection.
 */
import db from '../config/dbConn.js';
import { emitToUser } from '../util/socket.js';
import { logger } from '../util/logger.js';

export const APPROVAL_CHANGED_EVENT = 'approval:changed';

const POLL_START_MS = 2;
const POLL_MAX_MS = 200;
const GIVE_UP_MS = 15 * 60 * 1000;

/** The context whose COMMIT makes this write durable, or null if none. */
const committingContext = (dbContext) => {
  let ctx = dbContext && dbContext.ctx;
  let committing = null;
  while (ctx) {
    if (ctx.isTX && ctx.txLevel === 0) committing = ctx;
    ctx = ctx.parent;
  }
  return committing;
};

/** Resolves true once `ctx` committed, false if it rolled back / timed out. */
const afterFinish = (ctx) => new Promise((resolve) => {
  const started = Date.now();
  let wait = POLL_START_MS;
  const check = () => {
    if (ctx.finish) return resolve(ctx.success === true);
    if (Date.now() - started > GIVE_UP_MS) return resolve(false);
    wait = Math.min(wait * 2, POLL_MAX_MS);
    setTimeout(check, wait);
  };
  setTimeout(check, 0);
});

const toIds = (v) => [...new Set((Array.isArray(v) ? v : [v])
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0))];

/**
 * Who to tell, per instance. Looked up after commit on the pool.
 * @returns {Promise<Array<{entity_type, entity_id, user_ids:number[]}>>}
 */
async function resolveTargets({ instanceIds, stepIds, entityType, entityId }) {
  const ids = toIds(instanceIds || []);
  const steps = toIds(stepIds || []);
  const byEntity = entityType && entityId != null;
  if (!ids.length && !steps.length && !byEntity) return [];
  return db.any(
    `SELECT ai.entity_type, ai.entity_id,
            COALESCE(array_agg(DISTINCT asa.approver_user_id)
                     FILTER (WHERE asa.approver_user_id IS NOT NULL), '{}') AS user_ids
       FROM tbl_approval_instances ai
       LEFT JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
       LEFT JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id
      WHERE ai.id = ANY($1::int[])
         OR ai.id IN (SELECT approval_instance_id FROM tbl_approval_instance_steps WHERE id = ANY($4::int[]))
         OR ($2::text IS NOT NULL AND ai.entity_type = $2 AND ai.entity_id = $3::int)
      GROUP BY ai.entity_type, ai.entity_id`,
    [ids, byEntity ? String(entityType) : null, byEntity ? Number(entityId) : null, steps]
  );
}

/**
 * Tell everyone whose pending set an approval write may have changed.
 *
 * @param {object} target
 * @param {number|number[]} [target.instanceIds] approval instance id(s)
 * @param {number|number[]} [target.stepIds] approval instance step id(s)
 * @param {string} [target.entityType]  with entityId: every instance of it
 * @param {number} [target.entityId]
 * @param {number[]} [target.extraUserIds] also notify these (e.g. an approver
 *   replaced by a reassignment), once per resolved entity
 * @param {object} [dbContext] the pg-promise tx/task the write ran on, or db
 * @returns {Promise<void>} resolves when emitted; callers do NOT await it
 */
// Per-transaction de-duplication: several writers inside one transaction
// (e.g. propagation removing an approver, re-evaluating the step and advancing
// the instance) each announce the same instance; it is emitted once.
const scheduledByTx = new WeakMap();
const targetKeys = (target) => [
  ...toIds(target?.instanceIds || []).map((id) => `i:${id}`),
  ...toIds(target?.stepIds || []).map((id) => `s:${id}`),
  ...(target?.entityType && target?.entityId != null ? [`e:${target.entityType}:${Number(target.entityId)}`] : []),
];

export function notifyApprovalChanged(target, dbContext = null) {
  const ctxForDedupe = committingContext(dbContext);
  if (ctxForDedupe && !(target?.extraUserIds?.length)) {
    const keys = targetKeys(target);
    if (!scheduledByTx.has(ctxForDedupe)) scheduledByTx.set(ctxForDedupe, new Set());
    const seen = scheduledByTx.get(ctxForDedupe);
    if (keys.length && keys.every((k) => seen.has(k))) return Promise.resolve();
    keys.forEach((k) => seen.add(k));
  }
  const run = async () => {
    try {
      const ctx = ctxForDedupe;
      if (ctx) {
        const committed = await afterFinish(ctx);
        if (!committed) return;
      } else {
        await new Promise((r) => setImmediate(r));
      }
      const targets = await resolveTargets(target || {});
      const extra = toIds(target?.extraUserIds || []);
      for (const t of targets) {
        const payload = { entity_type: t.entity_type, entity_id: Number(t.entity_id) };
        for (const uid of new Set([...toIds(t.user_ids || []), ...extra])) {
          emitToUser(uid, APPROVAL_CHANGED_EVENT, payload);
        }
      }
    } catch (err) {
      logger.warn({ err: err?.message, target }, 'approval:changed emit failed');
    }
  };
  return run();
}

export default { notifyApprovalChanged, APPROVAL_CHANGED_EVENT };
