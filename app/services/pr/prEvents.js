// Purchase Requisitions — the append-only audit trail (tbl_pr_event).
//
// Every PR mutation records exactly one event (or one per touched line) in the
// SAME transaction as the change, so the timeline can never disagree with the
// data. `t` is mandatory: an event written outside the mutation's transaction
// could survive a rolled-back change.

export const PR_EVENT_TYPES = Object.freeze([
  'created', 'updated', 'submitted',
  'review_created', 'review_completed', 'self_reviewed', 'review_sent_back', 'review_superseded',
  'spec_edited', 'clause_added', 'clause_removed', 'attachment_added', 'attachment_removed',
  'approval_started', 'approval_sent_back', 'approved', 'rejected',
  'withdrawn', 'cancelled', 'copied_from',
  'assigned', 'line_mapped', 'catalog_requested', 'catalog_fulfilled', 'catalog_rejected',
  'line_closed', 'line_cancelled', 'converted', 'comment_added',
]);
const KNOWN = new Set(PR_EVENT_TYPES);

/**
 * @param {object} t  pg-promise transaction (the mutation's own)
 * @returns {Promise<{id: string, created_at: Date}>}
 */
export async function record(t, { prId, lineId = null, revision = 0, actorId = null, type, payload = {} }) {
  if (!t || typeof t.one !== 'function') throw new Error('prEvents.record: a transaction is required');
  if (!KNOWN.has(type)) throw new Error(`prEvents.record: unknown event type '${type}'`);
  if (!prId) throw new Error('prEvents.record: prId is required');
  return t.one(
    `INSERT INTO tbl_pr_event (pr_id, pr_line_id, revision, actor_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, created_at`,
    [prId, lineId, revision ?? 0, actorId, type, JSON.stringify(payload ?? {})]
  );
}

export default { record, PR_EVENT_TYPES };
