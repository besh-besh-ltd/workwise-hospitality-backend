// Purchase Requisitions (PR) — database access layer.
//
// Raw, parameterised SQL only. Authorization lives in services/pr/prAccess.js
// and is applied by the controller BEFORE any of these run; nothing here trusts
// a client-supplied tenant id. Shared SQL fragments and constants come from the
// leaf module services/pr/prConstants.js (no business logic is imported here).
//
// Dates: required_by_date is a DATE. node-pg would parse it into a JS Date at
// the server's local midnight, which serialises as the PREVIOUS day in UTC for
// IST. Every read returns it as 'YYYY-MM-DD' text instead.

import db from '../../config/dbConn.js';
import {
  LIVE_PO_EXISTS, LIVE_LINK_EXISTS, LINK_IS_LIVE_SQL, LINE_PROGRESS_SQL, estimateTotalSql,
  IST_TODAY_SQL, USABLE_VARIANT_SQL, FIRST_CATEGORY_SQL, prGrantRowsSql,
  POOL_PROGRESSES, NO_REVIEWER_LABEL_SQL, NO_APPROVER_LABEL, REVIEWER_EXISTS_SQL,
  IS_ELIGIBLE_REVIEWER_SQL, REVIEWER_NAMES_SQL, HOTEL_BUYERS_SQL, IS_HOTEL_BUYER_SQL,
  POOL_AGE_DAYS_SQL, POOL_AGE_BAND_SQL, NUMERIC_TEXT_SQL, CATALOG_REQUEST_STATUSES,
} from '../../services/pr/prConstants.js';
import { readableScopeSql } from '../../services/pr/prAccess.js';
import { RFQ_STATUSES } from '../../util/constants.js';

// Line progress + PR value fragments live in prConstants; re-exported here as
// the model's public SQL surface (lists, detail, pool, KPIs).
export { LIVE_PO_EXISTS, LIVE_LINK_EXISTS, LINE_PROGRESS_SQL, estimateTotalSql };

// Every column of the PR row, with required_by_date re-selected as text. The
// later column of the same name wins in node-pg's row object (pg/lib/result.js
// parseRow assigns fields in order), so `p.*` stays the single column list.
const PR_SELECT = (a) => `${a}.*, to_char(${a}.required_by_date, 'YYYY-MM-DD') AS required_by_date`;

// Header columns a caller may write through insertPr/updateHeader.
const WRITABLE_HEADER = [
  'title', 'pr_type', 'hospitality_company_id', 'hotel_id', 'department_id', 'urgency', 'required_by_date',
  'justification', 'delivery_location', 'status', 'revision', 'estimated_total', 'submitted_at', 'approved_at',
  'approval_instance_id', 'assigned_buyer_id', 'assigned_at', 'returned_note', 'cancelled_reason',
];

/** Today's calendar date in IST, 'YYYY-MM-DD' (session-timezone independent). */
export async function istToday(t = db) {
  const row = await t.one(`SELECT to_char(${IST_TODAY_SQL}, 'YYYY-MM-DD') AS d`);
  return row.d;
}

/**
 * 'PR-<IST year>-<base36(seq)>', mirroring mrController.generateMrNumber's
 * shape. `seq` is drawn from the table's own id sequence: sequence values are
 * never handed out twice, so the number is unique without a retry loop and
 * without a lock (ids and numbers are independent; the id sequence just skips).
 */
export async function nextPrNumber(t = db) {
  const row = await t.one(
    `SELECT nextval(pg_get_serial_sequence('public.tbl_purchase_requisition', 'id')) AS seq,
            EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::int AS yyyy`);
  return `PR-${row.yyyy}-${BigInt(row.seq).toString(36).toUpperCase().padStart(5, '0')}`;
}

/** Insert a draft header. `header` must carry pr_number and raised_by. */
export async function insertPr(t, header) {
  const cols = ['pr_number', 'raised_by', ...WRITABLE_HEADER.filter((k) => header[k] !== undefined)];
  const vals = cols.map((k) => header[k]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  return t.one(
    `INSERT INTO tbl_purchase_requisition AS p (${cols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING ${PR_SELECT('p')}`,
    vals
  );
}

/** Patch whitelisted header columns; always bumps updated_at. */
export async function updateHeader(t, prId, patch) {
  const keys = WRITABLE_HEADER.filter((k) => patch[k] !== undefined);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  sets.push('updated_at = NOW()');
  return t.one(
    `UPDATE tbl_purchase_requisition p SET ${sets.join(', ')} WHERE p.id = $1 RETURNING ${PR_SELECT('p')}`,
    [prId, ...keys.map((k) => patch[k])]
  );
}

/** Ids of the PR's current lines. */
export async function lineIds(prId, t = db) {
  return t.map(`SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = $1`, [prId], (r) => Number(r.id));
}

const LINE_RECORD = `line_no int, line_kind text, product_variant_id int, free_text_name text, category_id int,
              quantity text, uom text, estimated_unit_price text, specification text, suggested_vendor_note text`;

/**
 * Make the PR's lines exactly `lines`, in that order, PRESERVING LINE IDENTITY:
 *   - a line carrying `id` is updated in place, so its clauses, attachments and
 *     review links survive (the caller must have verified the id is one of this
 *     PR's lines — see lineIds; a stray id is refused here as a programming error);
 *   - a line without `id` is inserted;
 *   - a current line absent from `lines` is deleted, cascading its clauses,
 *     line attachments and review links.
 * Lines are renumbered 1..n in the given order. Quantities and money travel as
 * strings and are cast to NUMERIC in SQL, never through a JS float.
 * @returns {Promise<{kept: number, added: number, removed: number}>}
 */
export async function replaceLines(t, prId, lines) {
  const rows = lines.map((l, i) => ({
    id: l.id ?? null,
    line_no: i + 1,
    line_kind: l.line_kind,
    product_variant_id: l.product_variant_id ?? null,
    free_text_name: l.free_text_name ?? null,
    category_id: l.category_id,
    quantity: String(l.quantity),
    uom: l.uom,
    estimated_unit_price: String(l.estimated_unit_price),
    specification: l.specification ?? null,
    suggested_vendor_note: l.suggested_vendor_note ?? null,
  }));
  const kept = rows.filter((r) => r.id != null);
  const added = rows.filter((r) => r.id == null);

  const removed = await t.result(
    `DELETE FROM tbl_purchase_requisition_line WHERE pr_id = $1 AND NOT (id = ANY($2::int[]))`,
    [prId, kept.map((r) => r.id)]);

  if (kept.length) {
    // Park the survivors on negative numbers first: UNIQUE (pr_id, line_no) is
    // checked row by row, so a reorder (1 ↔ 2) would collide mid-statement.
    await t.none(`UPDATE tbl_purchase_requisition_line SET line_no = -line_no WHERE pr_id = $1`, [prId]);
    const updated = await t.result(
      `UPDATE tbl_purchase_requisition_line l
          SET line_no = x.line_no, line_kind = x.line_kind,
              product_variant_id = x.product_variant_id, free_text_name = x.free_text_name,
              category_id = x.category_id, quantity = x.quantity::numeric, uom = x.uom,
              estimated_unit_price = x.estimated_unit_price::numeric,
              specification = x.specification, suggested_vendor_note = x.suggested_vendor_note,
              mapped_variant_id = CASE WHEN x.line_kind = 'catalog' THEN NULL ELSE l.mapped_variant_id END,
              mapped_by         = CASE WHEN x.line_kind = 'catalog' THEN NULL ELSE l.mapped_by END,
              mapped_at         = CASE WHEN x.line_kind = 'catalog' THEN NULL ELSE l.mapped_at END,
              updated_at = NOW()
         FROM jsonb_to_recordset($2::jsonb) AS x(id int, ${LINE_RECORD})
        WHERE l.pr_id = $1 AND l.id = x.id`,
      [prId, JSON.stringify(kept)]);
    if (updated.rowCount !== kept.length) {
      throw new Error(`replaceLines: ${kept.length - updated.rowCount} line id(s) do not belong to PR ${prId}`);
    }
  }

  if (added.length) {
    await t.none(
      `INSERT INTO tbl_purchase_requisition_line
         (pr_id, line_no, line_kind, product_variant_id, free_text_name, category_id,
          quantity, uom, estimated_unit_price, specification, suggested_vendor_note)
       SELECT $1, x.line_no, x.line_kind, x.product_variant_id, x.free_text_name, x.category_id,
              x.quantity::numeric, x.uom, x.estimated_unit_price::numeric, x.specification, x.suggested_vendor_note
         FROM jsonb_to_recordset($2::jsonb) AS x(${LINE_RECORD})
        ORDER BY x.line_no`,
      [prId, JSON.stringify(added)]);
  }

  return { kept: kept.length, added: added.length, removed: removed.rowCount };
}

/** Row-lock a PR for a state change. null if it does not exist. */
export async function lockPr(t, prId) {
  return t.oneOrNone(`SELECT ${PR_SELECT('p')} FROM tbl_purchase_requisition p WHERE p.id = $1 FOR UPDATE`, [prId]);
}

// ---------------------------------------------------------------------------
// Workflow writes (submit / review start / approval outcome) — prWorkflow.js
// owns the transitions; these are its statements. Every caller holds the PR
// row lock (lockPr) in the same transaction.
// ---------------------------------------------------------------------------

/** The PR's ACTIVE lines as submit re-validates and routes them, in line order. */
export async function activeLines(prId, t = db) {
  const rows = await t.any(
    `SELECT id, line_no, line_kind, product_variant_id, category_id
       FROM tbl_purchase_requisition_line
      WHERE pr_id = $1 AND status = 'active'
      ORDER BY line_no`,
    [prId]);
  return rows.map((r) => ({
    id: Number(r.id),
    line_no: Number(r.line_no),
    line_kind: r.line_kind,
    product_variant_id: r.product_variant_id == null ? null : Number(r.product_variant_id),
    category_id: Number(r.category_id),
  }));
}

/** Re-file lines under a new category: `changes` = [{id, category_id}] of this PR's lines. */
export async function setLineCategories(t, prId, changes) {
  if (!changes.length) return;
  await t.none(
    `UPDATE tbl_purchase_requisition_line l
        SET category_id = x.category_id, updated_at = NOW()
       FROM jsonb_to_recordset($2::jsonb) AS x(id int, category_id int)
      WHERE l.pr_id = $1 AND l.id = x.id`,
    [prId, JSON.stringify(changes)]);
}

/**
 * Open a new revision: revision + 1, estimated_total = the server Σ over active
 * lines (estimateTotalSql — never a client value), submitted_at = now, the
 * previous send-back note cleared, and the previous revision's approval
 * instance detached (approval_instance_id = NULL) — the new revision has no
 * chain until startApproval opens one, so an in_review PR never shows the old
 * chain and that chain's approvers stop reading the PR through it.
 */
export async function markSubmitted(t, prId) {
  return t.one(
    `UPDATE tbl_purchase_requisition p
        SET revision = p.revision + 1,
            estimated_total = ${estimateTotalSql('p')},
            submitted_at = NOW(),
            returned_note = NULL,
            approval_instance_id = NULL,
            updated_at = NOW()
      WHERE p.id = $1
     RETURNING ${PR_SELECT('p')}`,
    [prId]);
}

/** pending_approval → approved, stamped now. */
export async function markApproved(t, prId) {
  return t.one(
    `UPDATE tbl_purchase_requisition p
        SET status = 'approved', approved_at = NOW(), updated_at = NOW()
      WHERE p.id = $1
     RETURNING ${PR_SELECT('p')}`,
    [prId]);
}

/** One pending review of `revision` for a reviewing department, with its lines. Returns the review id. */
export async function insertReview(t, { prId, revision, departmentId, lineIds }) {
  const row = await t.one(
    `INSERT INTO tbl_pr_review (pr_id, revision, department_id, status)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [prId, revision, departmentId]);
  await t.none(
    `INSERT INTO tbl_pr_review_line (review_id, pr_line_id)
     SELECT $1, x FROM unnest($2::int[]) AS x`,
    [row.id, lineIds]);
  return Number(row.id);
}

/** Every still-pending review of `revision` → superseded. Returns their ids, ascending. */
export async function supersedePendingReviews(t, prId, revision) {
  const ids = await t.map(
    `UPDATE tbl_pr_review SET status = 'superseded'
      WHERE pr_id = $1 AND revision = $2 AND status = 'pending'
     RETURNING id`,
    [prId, revision], (r) => Number(r.id));
  return ids.sort((a, b) => a - b);
}

/** Each step of an approval instance with its (non-removed) approver ids, in step order. */
export async function instanceStepSummary(t, instanceId) {
  const rows = await t.any(
    `SELECT st.step_order, st.source_policy_step_order AS policy_step_order,
            COALESCE(array_agg(asa.approver_user_id ORDER BY asa.approver_user_id)
                     FILTER (WHERE asa.id IS NOT NULL AND asa.removed_at IS NULL), '{}') AS approver_ids
       FROM tbl_approval_instance_steps st
       LEFT JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = st.id
      WHERE st.approval_instance_id = $1
      GROUP BY st.id, st.step_order, st.source_policy_step_order
      ORDER BY st.step_order`,
    [instanceId]);
  return rows.map((r) => ({
    step_order: Number(r.step_order),
    policy_step_order: r.policy_step_order == null ? null : Number(r.policy_step_order),
    approver_ids: (r.approver_ids || []).map(Number),
  }));
}

/**
 * Where the PR's approval instance stands, from `userId`'s side: the instance
 * (status, scope, entity_type), its current step (status + source snapshot),
 * and whether the user is a PENDING, non-removed approver on that step. null
 * when the instance is not this PR's. prWorkflow.decisionRights turns this
 * into the engine's own decision gate.
 * Pass `lock` (inside a tx) to row-lock the instance first, so the answer
 * holds until commit (submitApprovalAction locks the same row).
 */
export async function approvalPosition(t, { prId, instanceId, userId, lock = false }) {
  if (lock) {
    const locked = await t.oneOrNone(
      `SELECT id FROM tbl_approval_instances WHERE id = $1 AND entity_type = 'PR' AND entity_id = $2 FOR UPDATE`,
      [instanceId, prId]);
    if (!locked) return null;
  }
  return t.oneOrNone(
    `SELECT ai.id AS instance_id, ai.status AS instance_status, ai.current_step,
            ai.entity_type, ai.hospitality_company_id, ai.hotel_id, ai.department_id,
            st.id AS step_id, st.status AS step_status,
            st.source_approver_type, st.source_approver_id, st.policy_step_id,
            EXISTS (SELECT 1 FROM tbl_approval_step_approvers asa
                     WHERE asa.approval_instance_step_id = st.id AND asa.approver_user_id = $3
                       AND asa.status = 'PENDING' AND asa.removed_at IS NULL) AS is_pending_approver
       FROM tbl_approval_instances ai
       LEFT JOIN tbl_approval_instance_steps st
              ON st.approval_instance_id = ai.id AND st.step_order = ai.current_step
      WHERE ai.id = $1 AND ai.entity_type = 'PR' AND ai.entity_id = $2`,
    [instanceId, prId, userId]);
}

// ---------------------------------------------------------------------------
// Technical review (spec §6) — reviewer edits, review outcome, the queue.
// prWorkflow decides who may act; every write here runs inside its
// transaction, under the PR row lock (lockPr).
// ---------------------------------------------------------------------------

/**
 * The OPEN reviews `userId` may act on right now: pending reviews of the PR's
 * current revision while it is in_review, where the user passes the eligible-
 * reviewer predicate (IS_ELIGIBLE_REVIEWER_SQL) — resolved at call time, never
 * cached. Ordered by department title. Each carries its line ids.
 * @returns {Promise<Array<{id, department_id, department_title, line_ids: number[]}>>}
 */
export async function eligibleReviews(t, prId, userId) {
  const rows = await t.any(
    `SELECT rv.id, rv.department_id, d.title AS department_title,
            COALESCE(array_agg(rl.pr_line_id ORDER BY rl.pr_line_id) FILTER (WHERE rl.pr_line_id IS NOT NULL), '{}')
              AS line_ids
       FROM tbl_purchase_requisition p
       JOIN tbl_pr_review rv ON rv.pr_id = p.id AND rv.revision = p.revision AND rv.status = 'pending'
       JOIN tbl_department d ON d.id = rv.department_id
       LEFT JOIN tbl_pr_review_line rl ON rl.review_id = rv.id
      WHERE p.id = $1 AND p.status = 'in_review'
        AND ${IS_ELIGIBLE_REVIEWER_SQL('$2', 'p', 'rv')}
      GROUP BY rv.id, rv.department_id, d.title
      ORDER BY d.title, rv.id`,
    [prId, userId]);
  return rows.map((r) => ({
    id: Number(r.id),
    department_id: Number(r.department_id),
    department_title: r.department_title,
    line_ids: (r.line_ids || []).map(Number),
  }));
}

/** One review of this PR (any revision, any status) with its department title, or null. */
export async function reviewOfPr(t, prId, reviewId) {
  return t.oneOrNone(
    `SELECT rv.id, rv.pr_id, rv.revision, rv.department_id, d.title AS department_title, rv.status
       FROM tbl_pr_review rv
       JOIN tbl_department d ON d.id = rv.department_id
      WHERE rv.id = $1 AND rv.pr_id = $2`,
    [reviewId, prId]);
}

/**
 * Close a PENDING review as completed / sent_back by `actedBy`. Returns the
 * row, or null when it was no longer pending (the caller re-checked under the
 * PR lock, so null means a bug, not a race).
 */
export async function closeReview(t, reviewId, { status, actedBy, note, selfReviewed }) {
  return t.oneOrNone(
    `UPDATE tbl_pr_review
        SET status = $2, acted_by = $3, acted_at = NOW(), note = $4, self_reviewed = $5
      WHERE id = $1 AND status = 'pending'
     RETURNING id, status, acted_by, acted_at, note, self_reviewed`,
    [reviewId, status, actedBy, note, selfReviewed]);
}

/** How many reviews of `revision` are still pending. */
export async function pendingReviewCount(t, prId, revision) {
  const row = await t.one(
    `SELECT count(*)::int AS n FROM tbl_pr_review WHERE pr_id = $1 AND revision = $2 AND status = 'pending'`,
    [prId, revision]);
  return row.n;
}

/** A line of this PR, or null. */
export async function lineOfPr(t, prId, lineId) {
  return t.oneOrNone(
    `SELECT id, line_no, specification, status FROM tbl_purchase_requisition_line WHERE id = $1 AND pr_id = $2`,
    [lineId, prId]);
}

export async function setLineSpecification(t, lineId, specification) {
  await t.none(
    `UPDATE tbl_purchase_requisition_line SET specification = $2, updated_at = NOW() WHERE id = $1`,
    [lineId, specification]);
}

const CLAUSE_COLS = 'id, pr_line_id, clause_text, clause_type, weightage, added_by, created_at';

export async function insertClause(t, { lineId, clauseText, clauseType, weightage, addedBy }) {
  return t.one(
    `INSERT INTO tbl_pr_line_clause (pr_line_id, clause_text, clause_type, weightage, added_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${CLAUSE_COLS}`,
    [lineId, clauseText, clauseType, weightage, addedBy]);
}

/** A clause of this line, or null. */
export async function clauseOfLine(t, lineId, clauseId) {
  return t.oneOrNone(`SELECT ${CLAUSE_COLS} FROM tbl_pr_line_clause WHERE id = $1 AND pr_line_id = $2`, [clauseId, lineId]);
}

export async function deleteClause(t, clauseId) {
  await t.none(`DELETE FROM tbl_pr_line_clause WHERE id = $1`, [clauseId]);
}

const ATTACHMENT_COLS = 'id, pr_id, pr_line_id, kind, file_url, file_name, uploaded_by, created_at';

export async function insertAttachment(t, { prId, lineId, kind, fileUrl, fileName, uploadedBy }) {
  return t.one(
    `INSERT INTO tbl_pr_attachment (pr_id, pr_line_id, kind, file_url, file_name, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ATTACHMENT_COLS}`,
    [prId, lineId, kind, fileUrl, fileName, uploadedBy]);
}

/** An attachment of this PR (header or line), or null. */
export async function attachmentOfPr(t, prId, attId) {
  return t.oneOrNone(`SELECT ${ATTACHMENT_COLS} FROM tbl_pr_attachment WHERE id = $1 AND pr_id = $2`, [attId, prId]);
}

export async function deleteAttachment(t, attId) {
  await t.none(`DELETE FROM tbl_pr_attachment WHERE id = $1`, [attId]);
}

/**
 * GET /pr/review-queue: every OPEN review (pending, current revision, PR
 * in_review) the user may act on right now (IS_ELIGIBLE_REVIEWER_SQL), oldest
 * submission first. Driven from the companies the user holds pr.evaluate in,
 * so other tenants' reviews are never scanned.
 */
export async function reviewQueue(userId, t = db) {
  return t.any(
    `SELECT rv.id AS review_id, p.id AS pr_id, p.pr_number, p.title, h.name AS hotel_name,
            d.title AS department_title, ru.name AS requester_name,
            (SELECT count(*)::int FROM tbl_pr_review_line rl WHERE rl.review_id = rv.id) AS line_count,
            p.submitted_at,
            GREATEST(0, floor(EXTRACT(EPOCH FROM (NOW() - p.submitted_at)) / 86400))::int AS age_days
       FROM tbl_pr_review rv
       JOIN tbl_purchase_requisition p
         ON p.id = rv.pr_id AND p.revision = rv.revision AND p.status = 'in_review'
       JOIN tbl_department d ON d.id = rv.department_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
       LEFT JOIN tbl_users ru ON ru.id = p.raised_by
      WHERE rv.status = 'pending'
        AND p.hospitality_company_id IN (SELECT g.company_id FROM (${prGrantRowsSql('$1', 'evaluate')}) g)
        AND ${IS_ELIGIBLE_REVIEWER_SQL('$1', 'p', 'rv')}
      ORDER BY p.submitted_at, rv.id`,
    [userId]);
}

export async function getPrRow(prId, t = db) {
  return t.oneOrNone(`SELECT ${PR_SELECT('p')} FROM tbl_purchase_requisition p WHERE p.id = $1`, [prId]);
}

/**
 * New draft copied from `srcId` for `raisedBy`: same header (required_by_date
 * moved up to today IST if it is in the past), every line re-numbered 1..n with
 * stored status / mapping / closure reset. Clauses and attachments are NOT
 * copied (they belong to the source's review), nor is any workflow state.
 */
export async function copyPr(t, srcId, { prNumber, raisedBy }) {
  const pr = await t.one(
    `INSERT INTO tbl_purchase_requisition AS p
       (pr_number, title, pr_type, hospitality_company_id, hotel_id, department_id, process_id, urgency,
        required_by_date, justification, delivery_location, raised_by)
     SELECT $2, s.title, s.pr_type, s.hospitality_company_id, s.hotel_id, s.department_id, s.process_id, s.urgency,
            GREATEST(s.required_by_date, ${IST_TODAY_SQL}), s.justification, s.delivery_location, $3
       FROM tbl_purchase_requisition s
      WHERE s.id = $1
     RETURNING ${PR_SELECT('p')}`,
    [srcId, prNumber, raisedBy]
  );
  await t.none(
    `INSERT INTO tbl_purchase_requisition_line
       (pr_id, line_no, line_kind, product_variant_id, free_text_name, category_id,
        quantity, uom, estimated_unit_price, specification, suggested_vendor_note)
     SELECT $2, ROW_NUMBER() OVER (ORDER BY s.line_no, s.id), s.line_kind, s.product_variant_id, s.free_text_name,
            s.category_id, s.quantity, s.uom, s.estimated_unit_price, s.specification, s.suggested_vendor_note
       FROM tbl_purchase_requisition_line s
      WHERE s.pr_id = $1`,
    [srcId, pr.id]
  );
  return pr;
}

/**
 * An RFQ's status as the label the RFQ module shows (RFQ_STATUSES,
 * app/util/constants.js): status 1 is "Draft" until published, then "Open".
 * `r` = tbl_rfq alias.
 */
const RFQ_STATUS_LABEL_SQL = (r) => `CASE
  WHEN ${r}.status = ${RFQ_STATUSES.OPEN} AND ${r}.is_published = 0 THEN 'Draft'
  WHEN ${r}.status = ${RFQ_STATUSES.OPEN} THEN 'Open'
  WHEN ${r}.status = ${RFQ_STATUSES.CLOSED} THEN 'Closed'
  WHEN ${r}.status = ${RFQ_STATUSES.PENDING_APPROVAL} THEN 'Pending approval'
  WHEN ${r}.status = ${RFQ_STATUSES.READY_TO_PUBLISH} THEN 'Ready to publish'
  WHEN ${r}.status = ${RFQ_STATUSES.WITHDRAWN} THEN 'Withdrawn'
  ELSE 'Unknown' END`;

/**
 * Everything the detail page renders.
 * @returns {Promise<{pr, lines, attachments, reviews, events, comments}|null>}
 *   pr.header_progress is the list's rule (HEADER_PROGRESS_JOIN), null unless approved;
 *   pr.now_with is the list's "who holds it" label (NOW_WITH_SQL), including
 *   the "No eligible reviewer / approver — contact your admin" states;
 *   lines[] carry clauses[], attachments[], progress and
 *   links[] = [{rfq_id, rfq_no, rfq_status_label, live, po: [{po_id, po_number, status}]}];
 *   top-level attachments[] are the PR-level ones (no line).
 *   pr.estimated_total is the live Σ for draft/returned, else the value stored at submit.
 */
export async function getDetail(prId, t = db) {
  return t.task(async (c) => {
    const pr = await c.oneOrNone(
      `SELECT ${PR_SELECT('p')},
              CASE WHEN p.status IN ('draft','returned') THEN ${estimateTotalSql('p')} ELSE p.estimated_total END
                AS estimated_total,
              h.name AS hotel_name, d.title AS department_name,
              ru.name AS raised_by_name, bu.name AS assigned_buyer_name,
              hp.header_progress,
              ${NOW_WITH_SQL('p')} AS now_with
         FROM tbl_purchase_requisition p
         ${HEADER_PROGRESS_JOIN('p')}
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
         LEFT JOIN tbl_department d ON d.id = p.department_id
         LEFT JOIN tbl_users ru ON ru.id = p.raised_by
         LEFT JOIN tbl_users bu ON bu.id = p.assigned_buyer_id
        WHERE p.id = $1`,
      [prId]
    );
    if (!pr) return null;

    const lines = await c.any(
      `SELECT l.id, l.line_no, l.line_kind, l.product_variant_id, pv.name AS variant_name, prod.name AS product_name,
              l.free_text_name, l.category_id, cat.title AS category_title,
              l.quantity, l.uom, l.estimated_unit_price,
              ROUND(l.quantity * l.estimated_unit_price, 2) AS line_value,
              l.specification, l.suggested_vendor_note,
              l.status, l.close_reason, l.closed_by, l.closed_at,
              l.mapped_variant_id, mpv.name AS mapped_variant_name, l.mapped_by, l.mapped_at,
              ${LINE_PROGRESS_SQL('l', 'p')} AS progress
         FROM tbl_purchase_requisition_line l
         JOIN tbl_purchase_requisition p ON p.id = l.pr_id
         LEFT JOIN tbl_product_variant pv ON pv.id = l.product_variant_id
         LEFT JOIN tbl_product prod ON prod.id = pv.product_id
         LEFT JOIN tbl_product_variant mpv ON mpv.id = l.mapped_variant_id
         LEFT JOIN tbl_category cat ON cat.id = l.category_id
        WHERE l.pr_id = $1
        ORDER BY l.line_no`,
      [prId]
    );

    const clauses = await c.any(
      `SELECT cl.id, cl.pr_line_id, cl.clause_text, cl.clause_type, cl.weightage, cl.added_by,
              u.name AS added_by_name, cl.created_at
         FROM tbl_pr_line_clause cl
         JOIN tbl_purchase_requisition_line l ON l.id = cl.pr_line_id
         LEFT JOIN tbl_users u ON u.id = cl.added_by
        WHERE l.pr_id = $1
        ORDER BY cl.id`,
      [prId]
    );

    const attachments = await c.any(
      `SELECT a.id, a.pr_line_id, a.kind, a.file_url, a.file_name, a.uploaded_by,
              u.name AS uploaded_by_name, a.created_at
         FROM tbl_pr_attachment a
         LEFT JOIN tbl_users u ON u.id = a.uploaded_by
        WHERE a.pr_id = $1
        ORDER BY a.id`,
      [prId]
    );

    // Each line's RFQ links, oldest first: {rfq_id, rfq_no, rfq_status_label,
    // live, po[]}. `live` is LINK_IS_LIVE_SQL — the very rule behind
    // LINE_PROGRESS_SQL; po[] lists every PO of the linked RFQ product,
    // whatever its status.
    const links = await c.any(
      `SELECT lk.pr_line_id, lk.rfq_id, r.rfq_no, ${RFQ_STATUS_LABEL_SQL('r')} AS rfq_status_label,
              ${LINK_IS_LIVE_SQL('lk', 'r')} AS live,
              COALESCE((
                SELECT json_agg(json_build_object('po_id', x.id, 'po_number', x.po_number, 'status', x.status) ORDER BY x.id)
                  FROM (SELECT DISTINCT po.id, po.po_number, po.status
                          FROM tbl_rfq_purchase_order po
                          JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
                         WHERE po.rfq_id = lk.rfq_id AND pop.rfq_product_id = lk.rfq_product_id) x
              ), '[]'::json) AS po
         FROM tbl_pr_line_rfq lk
         JOIN tbl_purchase_requisition_line l ON l.id = lk.pr_line_id
         JOIN tbl_rfq r ON r.id = lk.rfq_id
        WHERE l.pr_id = $1
        ORDER BY lk.id`,
      [prId]
    );

    // eligible_reviewers: who may act on an OPEN review (pending, current
    // revision, PR in_review) right now — the predicate every reviewer action
    // is decided by; [] for a closed review (its acted_by_name says who acted).
    const reviews = await c.any(
      `SELECT rv.id, rv.revision, rv.department_id, d.title AS department_title, rv.status,
              rv.acted_by, u.name AS acted_by_name, rv.acted_at, rv.note, rv.self_reviewed, rv.created_at,
              COALESCE((SELECT json_agg(rl.pr_line_id ORDER BY rl.pr_line_id)
                          FROM tbl_pr_review_line rl WHERE rl.review_id = rv.id), '[]'::json) AS line_ids,
              (p.status = 'in_review' AND rv.revision = p.revision AND rv.status = 'pending') AS is_open,
              CASE WHEN p.status = 'in_review' AND rv.revision = p.revision AND rv.status = 'pending'
                   THEN ${REVIEWER_NAMES_SQL('p', 'rv')} ELSE '[]'::json END AS eligible_reviewers
         FROM tbl_pr_review rv
         JOIN tbl_purchase_requisition p ON p.id = rv.pr_id
         LEFT JOIN tbl_department d ON d.id = rv.department_id
         LEFT JOIN tbl_users u ON u.id = rv.acted_by
        WHERE rv.pr_id = $1
        ORDER BY rv.revision DESC, d.title, rv.id`,
      [prId]
    );

    const events = await c.any(
      `SELECT e.id, e.pr_line_id, e.revision, e.actor_id, u.name AS actor_name, e.event_type, e.payload, e.created_at
         FROM tbl_pr_event e
         LEFT JOIN tbl_users u ON u.id = e.actor_id
        WHERE e.pr_id = $1
        ORDER BY e.id`,
      [prId]
    );

    const comments = await c.any(
      `SELECT cm.id, cm.author_id, u.name AS author_name, cm.body, cm.created_at
         FROM tbl_pr_comment cm
         LEFT JOIN tbl_users u ON u.id = cm.author_id
        WHERE cm.pr_id = $1
        ORDER BY cm.created_at, cm.id`,
      [prId]
    );

    const byLine = (rows) => {
      const m = new Map();
      for (const r of rows) {
        if (r.pr_line_id == null) continue;
        if (!m.has(r.pr_line_id)) m.set(r.pr_line_id, []);
        m.get(r.pr_line_id).push(r);
      }
      return m;
    };
    const clausesBy = byLine(clauses);
    const attachmentsBy = byLine(attachments);
    const linksBy = new Map(); // pr_line_id → its links, without the key
    for (const { pr_line_id: lineId, ...link } of links) {
      if (!linksBy.has(lineId)) linksBy.set(lineId, []);
      linksBy.get(lineId).push(link);
    }

    return {
      pr,
      lines: lines.map((l) => ({
        ...l,
        clauses: clausesBy.get(l.id) || [],
        attachments: attachmentsBy.get(l.id) || [],
        links: linksBy.get(l.id) || [],
      })),
      attachments: attachments.filter((a) => a.pr_line_id == null),
      // no_eligible_reviewer: an open review nobody may act on — the detail's
      // "No eligible reviewer — contact your admin" (same predicate as now_with).
      reviews: reviews.map(({ is_open: open, ...rv }) => ({
        ...rv, no_eligible_reviewer: open === true && rv.eligible_reviewers.length === 0,
      })),
      events: events.map((e) => ({ ...e, id: Number(e.id) })),
      comments,
    };
  });
}

// ---------------------------------------------------------------------------
// Reference lookups + pickers
// ---------------------------------------------------------------------------

/** The hotel's own company (never the client's). null for unknown/deleted hotels. */
export async function hotelCell(hotelId, t = db) {
  return t.oneOrNone(
    `SELECT h.id AS hotel_id, h.hospitality_company_id
       FROM tbl_hospitality_company_hotels h
      WHERE h.id = $1 AND COALESCE(h.is_deleted, 0) = 0`,
    [hotelId]
  );
}

export async function departmentExists(departmentId, t = db) {
  const row = await t.one(`SELECT EXISTS (SELECT 1 FROM tbl_department WHERE id = $1) AS ok`, [departmentId]);
  return row.ok === true;
}

/** Of `categoryIds`, the ones that are active and not deleted. */
export async function activeCategoryIds(categoryIds, t = db) {
  const ids = [...new Set((categoryIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Set();
  const rows = await t.any(
    `SELECT id FROM tbl_category WHERE id = ANY($1::int[]) AND status = 1 AND is_deleted = 0`, [ids]);
  return new Set(rows.map((r) => Number(r.id)));
}

/** Hotels where the user holds pr.create on at least one department (create-form picker). */
export async function formHotels(userId, t = db) {
  return t.any(
    `SELECT DISTINCT h.id, h.name, h.city, h.hospitality_company_id
       FROM (${prGrantRowsSql('$1', 'create')}) g
       JOIN tbl_hospitality_company_hotels h
         ON h.hospitality_company_id = g.company_id
        AND (g.hotel_id IS NULL OR g.hotel_id = h.id)
      WHERE COALESCE(h.is_deleted, 0) = 0
      ORDER BY h.name, h.id`,
    [userId]
  );
}

/** Departments at the hotel where the user holds pr.create (a NULL-department grant = all). */
export async function formDepartments(userId, { companyId, hotelId }, t = db) {
  return t.any(
    `WITH g AS (${prGrantRowsSql('$1', 'create')})
     SELECT d.id, d.title
       FROM tbl_department d
      WHERE EXISTS (SELECT 1 FROM g
                     WHERE g.company_id = $2
                       AND (g.hotel_id IS NULL OR g.hotel_id = $3)
                       AND (g.department_id IS NULL OR g.department_id = d.id))
      ORDER BY d.title, d.id`,
    [userId, companyId, hotelId]
  );
}

const likePattern = (q) => `%${String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** Usable catalog variants matching `q` (variant name, product name or slug), with their PR category. */
export async function searchItems({ q, limit = 25 }, t = db) {
  return t.any(
    `SELECT pv.id AS variant_id, pv.name AS variant_name, p.name AS product_name, pv.slug,
            cat.id AS category_id, cat.title AS category_title
       FROM tbl_product_variant pv
       JOIN tbl_product p ON p.id = pv.product_id
       JOIN tbl_category cat ON cat.id = ${FIRST_CATEGORY_SQL('p.id')}
      WHERE ${USABLE_VARIANT_SQL}
        AND (pv.name ILIKE $1 OR p.name ILIKE $1 OR pv.slug ILIKE $1)
      ORDER BY pv.name, pv.id
      LIMIT $2`,
    [likePattern(q), limit]
  );
}

/** Active, non-deleted categories (title match), top-level parent_id as null. */
export async function searchCategories({ q = '', limit = 50 }, t = db) {
  return t.any(
    `SELECT c.id, c.title, NULLIF(c.parent_id, 0) AS parent_id
       FROM tbl_category c
      WHERE c.status = 1 AND c.is_deleted = 0
        AND ($1 = '' OR c.title ILIKE $2)
      ORDER BY c.title, c.id
      LIMIT $3`,
    [q, likePattern(q), limit]
  );
}

// ---------------------------------------------------------------------------
// Listing, KPIs, duplicate hints (spec §4.2 derived progress, §8)
// ---------------------------------------------------------------------------
const sqlList = (arr) => arr.map((v) => `'${v}'`).join(', ');

/**
 * Header progress from the PR's line progress (spec §4.2). Lateral join that
 * exposes hp.header_progress; `p` = PR alias (must already be in FROM).
 *   not approved / no live line      → NULL
 *   nothing left to source or order  → completed (some closed) | ordered (all ordered)
 *   some ordered, others not done    → partly_ordered
 *   sourcing + pool                  → partly_in_sourcing
 *   only sourcing                    → in_sourcing
 *   only pool                        → in_queue
 * Cancelled lines are ignored; closed lines are terminal.
 */
const HEADER_PROGRESS_JOIN = (p) => `LEFT JOIN LATERAL (
  SELECT CASE
           WHEN ${p}.status <> 'approved' OR c.live = 0 THEN NULL
           WHEN c.pool + c.src = 0 THEN CASE WHEN c.closed > 0 THEN 'completed' ELSE 'ordered' END
           WHEN c.ord > 0 THEN 'partly_ordered'
           WHEN c.src > 0 AND c.pool > 0 THEN 'partly_in_sourcing'
           WHEN c.src > 0 THEN 'in_sourcing'
           ELSE 'in_queue' END AS header_progress
    FROM (SELECT count(*) FILTER (WHERE x.prog <> 'cancelled') AS live,
                 count(*) FILTER (WHERE x.prog IN (${sqlList(POOL_PROGRESSES)})) AS pool,
                 count(*) FILTER (WHERE x.prog = 'in_sourcing') AS src,
                 count(*) FILTER (WHERE x.prog = 'ordered') AS ord,
                 count(*) FILTER (WHERE x.prog = 'closed') AS closed
            FROM (SELECT ${LINE_PROGRESS_SQL('l', p)} AS prog
                    FROM tbl_purchase_requisition_line l WHERE l.pr_id = ${p}.id) x) c
) hp ON true`;

/**
 * Who holds the PR right now, as the label shown in the list. `p` = PR alias.
 * Viewer-neutral: draft/returned PRs are held by the requester, so the label is
 * their name; the FE decides when to say "You".
 */
const NOW_WITH_SQL = (p) => `CASE ${p}.status
  WHEN 'draft' THEN COALESCE((SELECT ru2.name FROM tbl_users ru2 WHERE ru2.id = ${p}.raised_by), 'Requester')
  WHEN 'returned' THEN COALESCE((SELECT ru2.name FROM tbl_users ru2 WHERE ru2.id = ${p}.raised_by), 'Requester')
  WHEN 'approved' THEN COALESCE(
    (SELECT bu.name FROM tbl_users bu WHERE bu.id = ${p}.assigned_buyer_id), 'Purchase team')
  WHEN 'in_review' THEN (
    SELECT CASE
             WHEN count(*) = 0 THEN 'Technical review'
             WHEN count(*) FILTER (WHERE NOT z.elig) > 0
               THEN ${NO_REVIEWER_LABEL_SQL("string_agg(z.title, ', ' ORDER BY z.title) FILTER (WHERE NOT z.elig)")}
             ELSE 'Technical review: ' || string_agg(z.title, ', ' ORDER BY z.title) END
      FROM (SELECT d.title, ${REVIEWER_EXISTS_SQL(p, 'rv')} AS elig
              FROM tbl_pr_review rv JOIN tbl_department d ON d.id = rv.department_id
             WHERE rv.pr_id = ${p}.id AND rv.revision = ${p}.revision AND rv.status = 'pending') z)
  WHEN 'pending_approval' THEN COALESCE((
    SELECT CASE WHEN a.n = 0 THEN '${NO_APPROVER_LABEL}'
                ELSE 'Approval step ' || a.step_order || ': ' || array_to_string(a.names[1:3], ', ')
                     || CASE WHEN a.n > 3 THEN ' +' || (a.n - 3) ELSE '' END END
      FROM (SELECT ai.current_step AS step_order, count(asa.id) AS n,
                   array_agg(u.name ORDER BY asa.id) FILTER (WHERE asa.id IS NOT NULL) AS names
              FROM tbl_approval_instances ai
              LEFT JOIN tbl_approval_instance_steps st
                     ON st.approval_instance_id = ai.id AND st.step_order = ai.current_step AND st.status = 'PENDING'
              LEFT JOIN tbl_approval_step_approvers asa
                     ON asa.approval_instance_step_id = st.id AND asa.status = 'PENDING' AND asa.removed_at IS NULL
              LEFT JOIN tbl_users u ON u.id = asa.approver_user_id
             WHERE ai.id = ${p}.approval_instance_id AND ai.entity_type = 'PR' AND ai.entity_id = ${p}.id
             GROUP BY ai.current_step) a), '${NO_APPROVER_LABEL}')
  ELSE NULL END`;

/**
 * WHERE fragment over PR alias p: readable scope (skipped for super admin, who
 * canReadPr() admits everywhere), the tab and the free-text search. $1 = user.
 */
function scopeWhere(user, { tab, q }, superAdmin) {
  const params = [user.id];
  const conds = [];
  if (tab === 'mine') conds.push('p.raised_by = $1');
  // Everything waiting on me is readable to me (requester / eligible reviewer /
  // current approver), so no extra scope predicate is needed.
  else if (tab === 'awaiting') conds.push(`p.id IN (${AWAITING_ME_IDS_SQL('$1')})`);
  else if (!superAdmin) conds.push(readableScopeSql(user.id, 'p', 1).clause);
  if (q) {
    params.push(likePattern(q));
    const n = `$${params.length}`;
    conds.push(`(p.pr_number ILIKE ${n} OR p.title ILIKE ${n} OR EXISTS (
      SELECT 1 FROM tbl_purchase_requisition_line ql
        LEFT JOIN tbl_product_variant qpv ON qpv.id = COALESCE(ql.product_variant_id, ql.mapped_variant_id)
        LEFT JOIN tbl_product qprod ON qprod.id = qpv.product_id
       WHERE ql.pr_id = p.id
         AND (ql.free_text_name ILIKE ${n} OR qpv.name ILIKE ${n} OR qprod.name ILIKE ${n})))`);
  }
  return { conds, params };
}

/**
 * Paginated PR list + facet counts. `user` = req.user (scope is derived from it).
 * filters: { tab, status, hotelId, departmentId, prType, urgency, progress, q, page, pageSize }
 * Facets are over the tab+q+scope set only, so they never change with the
 * facet filters (MrAllPage semantics).
 */
export async function list(user, filters, superAdmin = false, t = db) {
  const { tab, q, page, pageSize } = filters;
  const base = scopeWhere(user, { tab, q }, superAdmin);
  const params = [...base.params];
  const conds = [...base.conds];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  if (filters.status) conds.push(`p.status = ${bind(filters.status)}`);
  if (filters.hotelId) conds.push(`p.hotel_id = ${bind(filters.hotelId)}`);
  if (filters.departmentId) conds.push(`p.department_id = ${bind(filters.departmentId)}`);
  if (filters.prType) conds.push(`p.pr_type = ${bind(filters.prType)}`);
  if (filters.urgency) conds.push(`p.urgency = ${bind(filters.urgency)}`);
  if (filters.progress) conds.push(`hp.header_progress = ${bind(filters.progress)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const innerJoin = filters.progress ? HEADER_PROGRESS_JOIN('p') : '';

  return t.task(async (c) => {
    const total = Number((await c.one(
      `SELECT count(*) AS n FROM tbl_purchase_requisition p ${innerJoin} ${where}`, params)).n);

    const limit = bind(pageSize);
    const offset = bind((page - 1) * pageSize);
    const rows = await c.any(
      `SELECT p.id, p.pr_number, p.title, p.status, hp.header_progress,
              h.name AS hotel_name, d.title AS department_name, p.raised_by, ru.name AS raised_by_name,
              CASE WHEN p.status IN ('draft','returned') THEN ${estimateTotalSql('p')} ELSE p.estimated_total END
                AS estimated_total,
              (SELECT count(*)::int FROM tbl_purchase_requisition_line lc
                WHERE lc.pr_id = p.id AND lc.status = 'active') AS line_count,
              to_char(p.required_by_date, 'YYYY-MM-DD') AS required_by_date,
              p.urgency, p.pr_type, p.submitted_at, p.approved_at, p.created_at,
              ${NOW_WITH_SQL('p')} AS now_with
         FROM (SELECT p.* FROM tbl_purchase_requisition p ${innerJoin} ${where}
                ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}) p
         ${HEADER_PROGRESS_JOIN('p')}
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
         LEFT JOIN tbl_department d ON d.id = p.department_id
         LEFT JOIN tbl_users ru ON ru.id = p.raised_by
        ORDER BY p.created_at DESC, p.id DESC`,
      params);

    const fw = base.conds.length ? `WHERE ${base.conds.join(' AND ')}` : '';
    const facetRows = await c.any(
      `WITH s AS (SELECT p.status, p.hotel_id, p.department_id, p.pr_type, p.urgency
                    FROM tbl_purchase_requisition p ${fw})
       SELECT 'status' AS k, status::text AS v, count(*)::int AS n FROM s GROUP BY status
       UNION ALL SELECT 'hotel', hotel_id::text, count(*)::int FROM s GROUP BY hotel_id
       UNION ALL SELECT 'department', department_id::text, count(*)::int FROM s GROUP BY department_id
       UNION ALL SELECT 'pr_type', pr_type::text, count(*)::int FROM s GROUP BY pr_type
       UNION ALL SELECT 'urgency', urgency::text, count(*)::int FROM s GROUP BY urgency`,
      base.params);
    const facets = { status: {}, hotel: {}, department: {}, pr_type: {}, urgency: {} };
    for (const f of facetRows) facets[f.k][f.v] = f.n;

    const labels = { hotel: {}, department: {} };
    const hotelIds = Object.keys(facets.hotel).map(Number);
    if (hotelIds.length) {
      for (const r of await c.any(`SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`, [hotelIds])) {
        labels.hotel[r.id] = r.name;
      }
    }
    const deptIds = Object.keys(facets.department).map(Number);
    if (deptIds.length) {
      for (const r of await c.any(`SELECT id, title FROM tbl_department WHERE id = ANY($1::int[])`, [deptIds])) {
        labels.department[r.id] = r.title;
      }
    }
    return { rows, total, facets, facet_labels: labels };
  });
}

/**
 * Ids of the PRs waiting on the user — one definition for the "Awaiting me"
 * KPI and the list's tab=awaiting, so the tile and the list it opens agree:
 *   - returned PRs I raised (I must edit and resubmit);
 *   - PRs in review with a pending review of the current revision for a
 *     department where I hold pr.evaluate at the PR's hotel;
 *   - PRs whose CURRENT approval step has a PENDING, non-removed row of mine.
 * Each branch is driven from the caller's own rows (their requests, grants or
 * approver rows), so it never scans other tenants' PRs.
 * @param {string} userParam  SQL placeholder holding the user id, e.g. '$1'.
 */
export const AWAITING_ME_IDS_SQL = (userParam) => `
       SELECT p.id FROM tbl_purchase_requisition p
        WHERE p.raised_by = ${userParam} AND p.status = 'returned'
       UNION
       SELECT p.id
         FROM (${prGrantRowsSql(userParam, 'evaluate')}) g
         JOIN tbl_purchase_requisition p
           ON p.hospitality_company_id = g.company_id AND (g.hotel_id IS NULL OR g.hotel_id = p.hotel_id)
         JOIN tbl_pr_review rv ON rv.pr_id = p.id AND rv.revision = p.revision AND rv.status = 'pending'
        WHERE p.status = 'in_review' AND (g.department_id IS NULL OR g.department_id = rv.department_id)
       UNION
       SELECT p.id
         FROM tbl_approval_step_approvers asa
         JOIN tbl_approval_instance_steps st ON st.id = asa.approval_instance_step_id
         JOIN tbl_approval_instances ai
           ON ai.id = st.approval_instance_id AND st.step_order = ai.current_step
         JOIN tbl_purchase_requisition p ON p.id = ai.entity_id AND p.approval_instance_id = ai.id
        WHERE asa.approver_user_id = ${userParam} AND asa.status = 'PENDING' AND asa.removed_at IS NULL
          AND st.status = 'PENDING' AND ai.entity_type = 'PR' AND ai.status = 'PENDING'
          AND p.status = 'pending_approval'`;

/**
 * Dashboard counters for the readable set.
 *   open               drafts + in review + pending approval + returned
 *   awaiting_me        pending reviews I am eligible for + PRs whose CURRENT approval
 *                      step has a PENDING row of mine + returned PRs I raised
 *   in_purchase_queue  approved PRs with at least one line waiting for the purchase team
 *   avg_days_to_approval  mean(approved_at - submitted_at) days, 1 decimal, approved in last 90 days
 */
export async function kpis(user, superAdmin = false, t = db) {
  const scope = superAdmin ? 'TRUE' : readableScopeSql(user.id, 'p', 1).clause;
  const row = await t.one(
    `SELECT
       count(*) FILTER (WHERE p.status IN ('draft','in_review','pending_approval','returned'))::int AS open,
       count(*) FILTER (WHERE p.status = 'approved' AND EXISTS (
         SELECT 1 FROM tbl_purchase_requisition_line l
          WHERE l.pr_id = p.id AND ${LINE_PROGRESS_SQL('l', 'p')} IN (${sqlList(POOL_PROGRESSES)})))::int AS in_purchase_queue,
       ROUND(AVG(EXTRACT(EPOCH FROM (p.approved_at - p.submitted_at)) / 86400.0)
             FILTER (WHERE p.status = 'approved' AND p.approved_at >= NOW() - INTERVAL '90 days'
                       AND p.submitted_at IS NOT NULL)::numeric, 1) AS avg_days_to_approval
       FROM tbl_purchase_requisition p
      WHERE ${scope}`,
    [user.id]);
  // Same set as GET /pr?tab=awaiting (AWAITING_ME_IDS_SQL).
  const awaiting = await t.one(`SELECT count(*)::int AS n FROM (${AWAITING_ME_IDS_SQL('$1')}) w`, [user.id]);
  return {
    open: row.open,
    awaiting_me: awaiting.n,
    in_purchase_queue: row.in_purchase_queue,
    avg_days_to_approval: row.avg_days_to_approval === null ? null : Number(row.avg_days_to_approval),
  };
}

/**
 * THE duplicate-request rule, written once for the duplicate hints
 * (GET /pr/duplicates) and the pool's duplicate_count, so the count on a pool
 * row is exactly what the hint lists (minus the row's own PR):
 *   a PR   of the company, created in the last 30 days, not a draft (R11: an
 *          unsubmitted draft is private) and not rejected / cancelled, with an
 *          ACTIVE line whose effective variant is `variant`;
 *   an RFQ of the company, not closed (status 2 — the live-link rule's own
 *          test, R24: a withdrawn publish request, status 5, can go back to
 *          drafts and still holds its lines, so it is live), active in the last 30 days
 *          (R13: tbl_rfq has no created_at — "timestamp" is naive UTC and is
 *          rewritten on edit, so it is LAST ACTIVITY), containing `variant`.
 * `p` / `r` are the PR / RFQ aliases; `company` and `variant` are SQL
 * expressions (columns or $n).
 */
const DUPLICATE_PR_SQL = (p, company, variant) => `(
  ${p}.hospitality_company_id = ${company}
  AND ${p}.status NOT IN ('draft', 'rejected', 'cancelled')
  AND ${p}.created_at >= NOW() - INTERVAL '30 days'
  AND EXISTS (SELECT 1 FROM tbl_purchase_requisition_line _dup_l
               WHERE _dup_l.pr_id = ${p}.id AND _dup_l.status = 'active'
                 AND COALESCE(_dup_l.product_variant_id, _dup_l.mapped_variant_id) = ${variant}))`;
const DUPLICATE_RFQ_SQL = (r, company, variant) => `(
  ${r}.hospitality_company_id = ${company}
  AND ${r}.status <> 2
  AND (${r}."timestamp" AT TIME ZONE 'UTC') >= NOW() - INTERVAL '30 days'
  AND EXISTS (SELECT 1 FROM tbl_rfq_products _dup_rp WHERE _dup_rp.rfq_id = ${r}.id AND _dup_rp.product_variant_id = ${variant}))`;

/**
 * Open PRs and live RFQs for `variantId` in the company (DUPLICATE_PR_SQL /
 * DUPLICATE_RFQ_SQL). `readable` for PRs is the one list/point-read predicate;
 * RFQ readability is decided by the caller (it needs the rfq.read scope check).
 * Titles are only selected for readable rows — never leaked to others. RFQs
 * report last_activity_at, not a creation time.
 */
export async function duplicates(user, { companyId, variantId }, superAdmin = false, t = db) {
  const readable = superAdmin ? 'TRUE' : readableScopeSql(user.id, 'p', 3).clause;
  const prs = await t.any(
    `SELECT p.id, p.pr_number AS number, h.name AS hotel_name, d.title AS department_name, p.created_at,
            CASE WHEN ${readable} THEN p.title END AS title,
            (${readable}) AS readable
       FROM tbl_purchase_requisition p
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
       LEFT JOIN tbl_department d ON d.id = p.department_id
      WHERE ${DUPLICATE_PR_SQL('p', '$1', '$2')}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 50`,
    [companyId, variantId, user.id]);
  const rfqs = await t.any(
    `SELECT r.id, r.rfq_no AS number, r.title, (r."timestamp" AT TIME ZONE 'UTC') AS last_activity_at, r.created_by,
            r.hospitality_company_id, r.hotel_id, r.department_id, r.process_id,
            h.name AS hotel_name, d.title AS department_name
       FROM tbl_rfq r
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
       LEFT JOIN tbl_department d ON d.id = r.department_id
      WHERE ${DUPLICATE_RFQ_SQL('r', '$1', '$2')}
      ORDER BY (r."timestamp" AT TIME ZONE 'UTC') DESC, r.id DESC
      LIMIT 50`,
    [companyId, variantId]);
  return { prs, rfqs };
}

// ---------------------------------------------------------------------------
// Buyer pool (spec §9): the pool list, the hotel's buyers, line state and the
// buyer / requester line writes. prPool.js decides who may act; every write
// here runs inside its transaction, under the PR row lock (lockPr).
// ---------------------------------------------------------------------------

/** Pool rows: urgent first, then need-by date, then approval time (ties: PR, line). `b` = row alias. */
const POOL_ORDER = (b) => `CASE ${b}.urgency WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
  ${b}.required_by_date, ${b}.approved_at, ${b}.pr_id, ${b}.line_no`;

/**
 * WHERE: the PR's hotel is one the user (bound at `userParam`) holds pr.convert
 * on — hasPerm's axis rules — and that hotel is not deleted (the same hotels
 * poolHotels offers, so a company-wide grant never surfaces a deleted hotel's lines).
 */
const POOL_SCOPE_SQL = (p, userParam) => `(EXISTS (
  SELECT 1 FROM (${prGrantRowsSql(userParam, 'convert')}) _pool_g
   WHERE _pool_g.company_id = ${p}.hospitality_company_id
     AND (_pool_g.hotel_id IS NULL OR _pool_g.hotel_id = ${p}.hotel_id))
  AND EXISTS (
  SELECT 1 FROM tbl_hospitality_company_hotels _pool_h
   WHERE _pool_h.id = ${p}.hotel_id AND COALESCE(_pool_h.is_deleted, 0) = 0))`;

/** Hotels whose pool the user may work (pr.convert on any department there), by name. [] = none. */
export async function poolHotels(userId, t = db) {
  return t.map(
    `SELECT DISTINCT h.id, h.name
       FROM (${prGrantRowsSql('$1', 'convert')}) g
       JOIN tbl_hospitality_company_hotels h
         ON h.hospitality_company_id = g.company_id
        AND (g.hotel_id IS NULL OR g.hotel_id = h.id)
      WHERE COALESCE(h.is_deleted, 0) = 0
      ORDER BY h.name, h.id`,
    [userId], (r) => ({ id: Number(r.id), name: r.name }));
}

/**
 * GET /pr/pool: ACTIVE lines of APPROVED PRs whose derived progress
 * (LINE_PROGRESS_SQL — never re-derived here) is one of `progress`, at hotels
 * where the user holds pr.convert. filters:
 *   { hotelId, departmentId, categoryId, progress: string[], assigned: 'me'|'unassigned'|'any',
 *     q, page, pageSize }
 * @returns {Promise<{rows: object[], total: number}>}
 */
export async function pool(userId, filters, t = db) {
  const params = [userId];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const conds = [`p.status = 'approved'`, `l.status = 'active'`, POOL_SCOPE_SQL('p', '$1')];
  if (filters.hotelId) conds.push(`p.hotel_id = ${bind(filters.hotelId)}`);
  if (filters.departmentId) conds.push(`p.department_id = ${bind(filters.departmentId)}`);
  if (filters.categoryId) conds.push(`l.category_id = ${bind(filters.categoryId)}`);
  if (filters.assigned === 'me') conds.push('p.assigned_buyer_id = $1');
  else if (filters.assigned === 'unassigned') conds.push('p.assigned_buyer_id IS NULL');
  if (filters.q) {
    const n = bind(likePattern(filters.q));
    conds.push(`(p.pr_number ILIKE ${n} OR p.title ILIKE ${n} OR l.free_text_name ILIKE ${n} OR EXISTS (
      SELECT 1 FROM tbl_product_variant qpv LEFT JOIN tbl_product qprod ON qprod.id = qpv.product_id
       WHERE qpv.id = COALESCE(l.product_variant_id, l.mapped_variant_id)
         AND (qpv.name ILIKE ${n} OR qprod.name ILIKE ${n})))`);
  }
  const progress = bind(filters.progress?.length ? filters.progress : [...POOL_PROGRESSES]);
  const base = `
    SELECT b.* FROM (
      SELECT l.id AS line_id, l.pr_id, l.line_no, p.urgency, p.required_by_date, p.approved_at,
             ${LINE_PROGRESS_SQL('l', 'p')} AS progress
        FROM tbl_purchase_requisition p
        JOIN tbl_purchase_requisition_line l ON l.pr_id = p.id
       WHERE ${conds.join(' AND ')}) b
     WHERE b.progress = ANY(${progress}::text[])`;

  return t.task(async (c) => {
    const total = Number((await c.one(`SELECT count(*) AS n FROM (${base}) x`, params)).n);
    const limit = bind(filters.pageSize);
    const offset = bind((filters.page - 1) * filters.pageSize);
    const rows = await c.any(
      `WITH pg AS (${base} ORDER BY ${POOL_ORDER('b')} LIMIT ${limit} OFFSET ${offset})
       SELECT pg.line_id, pg.pr_id, p.pr_number, p.title AS pr_title,
              p.hotel_id, h.name AS hotel_name, p.department_id, d.title AS department_title,
              l.line_no, l.line_kind, COALESCE(ev.name, l.free_text_name) AS item_name, l.free_text_name,
              ev.id AS effective_variant_id, l.category_id, cat.title AS category_title,
              l.quantity, l.uom, l.estimated_unit_price, ROUND(l.quantity * l.estimated_unit_price, 2) AS line_value,
              to_char(p.required_by_date, 'YYYY-MM-DD') AS required_by_date, p.urgency, p.approved_at,
              ${POOL_AGE_DAYS_SQL('p')} AS age_days, ${POOL_AGE_BAND_SQL('p')} AS age_band,
              p.assigned_buyer_id, bu.name AS assigned_buyer_name, pg.progress,
              CASE WHEN ev.id IS NULL THEN 0 ELSE
                (SELECT count(*)::int FROM tbl_purchase_requisition dp
                  WHERE dp.id <> p.id AND ${DUPLICATE_PR_SQL('dp', 'p.hospitality_company_id', 'ev.id')})
                + (SELECT count(*)::int FROM tbl_rfq dr
                    WHERE ${DUPLICATE_RFQ_SQL('dr', 'p.hospitality_company_id', 'ev.id')})
              END AS duplicate_count,
              (SELECT count(*)::int FROM tbl_pr_line_clause cl WHERE cl.pr_line_id = l.id) AS clause_count,
              (SELECT count(*)::int FROM tbl_pr_attachment a WHERE a.pr_line_id = l.id) AS attachment_count,
              (SELECT cr.id FROM tbl_pr_catalog_request cr
                WHERE cr.pr_line_id = l.id AND cr.status = 'open') AS open_catalog_request_id
         FROM pg
         JOIN tbl_purchase_requisition_line l ON l.id = pg.line_id
         JOIN tbl_purchase_requisition p ON p.id = pg.pr_id
         LEFT JOIN tbl_product_variant ev ON ev.id = COALESCE(l.product_variant_id, l.mapped_variant_id)
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
         LEFT JOIN tbl_department d ON d.id = p.department_id
         LEFT JOIN tbl_category cat ON cat.id = l.category_id
         LEFT JOIN tbl_users bu ON bu.id = p.assigned_buyer_id
        ORDER BY ${POOL_ORDER('pg')}`,
      params);
    return { rows, total };
  });
}

/** The hotel's buyers (HOTEL_BUYERS_SQL): `[{id, name}]` by name. */
export async function buyersForHotel({ companyId, hotelId }, t = db) {
  return t.map(HOTEL_BUYERS_SQL('$1', '$2'), [companyId, hotelId], (r) => ({ id: Number(r.id), name: r.name }));
}

/** Is `userId` one of the hotel's buyers (IS_HOTEL_BUYER_SQL — the GET /pr/buyers predicate)? */
export async function isHotelBuyer(userId, { companyId, hotelId }, t = db) {
  const row = await t.one(`SELECT ${IS_HOTEL_BUYER_SQL('$1', '$2', '$3')} AS ok`, [userId, companyId, hotelId]);
  return row.ok === true;
}

/** Assign the PR to `buyerId`, stamped now. Returns the PR row. */
export async function setAssignedBuyer(t, prId, buyerId) {
  return t.one(
    `UPDATE tbl_purchase_requisition p
        SET assigned_buyer_id = $2, assigned_at = NOW(), updated_at = NOW()
      WHERE p.id = $1
     RETURNING ${PR_SELECT('p')}`,
    [prId, buyerId]);
}

/** A user's display name, or null. */
export async function userName(userId, t = db) {
  const row = await t.oneOrNone(`SELECT name FROM tbl_users WHERE id = $1`, [userId]);
  return row ? row.name : null;
}

// What every line action decides on: stored state, mapping, whether a live
// RFQ link exists (LIVE_LINK_EXISTS — the derived-progress rule) and the open
// catalog request, if any.
const LINE_STATE_SELECT = `
  SELECT l.id, l.pr_id, l.line_no, l.line_kind, l.status, l.free_text_name, l.category_id,
         l.product_variant_id, l.mapped_variant_id,
         ${LIVE_LINK_EXISTS('l')} AS has_live_link,
         (SELECT cr.id FROM tbl_pr_catalog_request cr
           WHERE cr.pr_line_id = l.id AND cr.status = 'open') AS open_catalog_request_id
    FROM tbl_purchase_requisition_line l`;

/** Row-lock one line of this PR (inside the PR lock) and read its state. null if not this PR's line. */
export async function lockLineState(t, prId, lineId) {
  return t.oneOrNone(`${LINE_STATE_SELECT} WHERE l.id = $1 AND l.pr_id = $2 FOR UPDATE OF l`, [lineId, prId]);
}

/** Every line's state (no lock), in line order — for capabilities. */
export async function lineStates(prId, t = db) {
  return t.any(`${LINE_STATE_SELECT} WHERE l.pr_id = $1 ORDER BY l.line_no`, [prId]);
}

/** A line's derived progress right now (LINE_PROGRESS_SQL). */
export async function lineProgress(lineId, t = db) {
  const row = await t.oneOrNone(
    `SELECT ${LINE_PROGRESS_SQL('l', 'p')} AS progress
       FROM tbl_purchase_requisition_line l JOIN tbl_purchase_requisition p ON p.id = l.pr_id
      WHERE l.id = $1`, [lineId]);
  return row ? row.progress : null;
}

/** Map a free-text line to a catalog variant (re-mapping overwrites). */
export async function setLineMapping(t, lineId, { variantId, userId }) {
  await t.none(
    `UPDATE tbl_purchase_requisition_line
        SET mapped_variant_id = $2, mapped_by = $3, mapped_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [lineId, variantId, userId]);
}

/**
 * Resolve ONE OPEN catalog request — the only writer of a request's outcome,
 * shared by the buyer paths (a mapping fulfils, an ended line rejects — R21)
 * and the platform queue (fulfil / reject).
 * The second argument locates it: { requestId } (the platform acts on a
 * request) or { lineId } (a buyer acts on a line; at most one request per line
 * is open — uq_pr_catreq_open_per_line).
 * status 'fulfilled' needs `variantId`; 'rejected' needs a non-blank `note`
 * (chk_pr_catreq_resolution). Returns the request id, or null when none was open.
 */
export async function resolveOpenCatalogRequest(t, { requestId = null, lineId = null }, {
  status, resolvedBy, note = null, variantId = null,
}) {
  if (!CATALOG_REQUEST_STATUSES.includes(status) || status === 'open') {
    throw new Error(`resolveOpenCatalogRequest: invalid status '${status}'`);
  }
  if ((requestId == null) === (lineId == null)) {
    throw new Error('resolveOpenCatalogRequest: pass exactly one of requestId / lineId');
  }
  const row = await t.oneOrNone(
    `UPDATE tbl_pr_catalog_request
        SET status = $3, resolved_by = $4, resolved_at = NOW(), resolution_note = $5, resolved_variant_id = $6
      WHERE ${requestId != null ? 'id = $1' : 'pr_line_id = $2'} AND status = 'open'
     RETURNING id`,
    [requestId, lineId, status, resolvedBy, note, variantId]);
  return row ? Number(row.id) : null;
}

// ---------------------------------------------------------------------------
// Platform catalog-request queue (admin API, Task 10)
// ---------------------------------------------------------------------------

/** Which PR / line a catalog request belongs to (no lock), or null. */
export async function catalogRequestLocator(requestId, t = db) {
  return t.oneOrNone(
    `SELECT cr.id, cr.pr_line_id, l.pr_id
       FROM tbl_pr_catalog_request cr JOIN tbl_purchase_requisition_line l ON l.id = cr.pr_line_id
      WHERE cr.id = $1`, [requestId]);
}

/** Row-lock a catalog request (after the PR and line locks) and read it. */
export async function lockCatalogRequest(t, requestId) {
  return t.oneOrNone(`SELECT * FROM tbl_pr_catalog_request WHERE id = $1 FOR UPDATE`, [requestId]);
}

/**
 * The platform queue: every company's catalog requests, newest first, with the
 * context the platform needs (company, hotel, PR, line and its status, who
 * asked, what it was resolved with). filters: { status, q, page, pageSize }.
 */
export async function listCatalogRequests({ status, q, page, pageSize }, t = db) {
  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['TRUE'];
  if (status) where.push(`cr.status = ${bind(status)}`);
  if (q) {
    const like = bind(likePattern(q));
    where.push(`(cr.requested_name ILIKE ${like} OR p.pr_number ILIKE ${like} OR hc.name ILIKE ${like}
                 OR h.name ILIKE ${like} OR u.name ILIKE ${like})`);
  }
  const from = `
      FROM tbl_pr_catalog_request cr
      JOIN tbl_purchase_requisition_line l ON l.id = cr.pr_line_id
      JOIN tbl_purchase_requisition p ON p.id = l.pr_id
      LEFT JOIN tbl_hospitality_companies hc ON hc.id = cr.hospitality_company_id
      LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
      LEFT JOIN tbl_category cat ON cat.id = cr.category_id
      LEFT JOIN tbl_users u ON u.id = cr.requested_by
      LEFT JOIN tbl_product_variant rv ON rv.id = cr.resolved_variant_id
     WHERE ${where.join(' AND ')}`;
  const total = await t.one(`SELECT count(*)::int AS n ${from}`, params);
  const limit = bind(pageSize);
  const offset = bind((page - 1) * pageSize);
  const rows = await t.any(
    `SELECT cr.id, cr.requested_name, cr.description, cat.title AS category_title,
            hc.name AS company_name, h.name AS hotel_name, p.pr_number, p.id AS pr_id, l.line_no,
            l.status AS line_status, u.name AS requested_by_name, cr.requested_at, cr.status,
            cr.resolved_variant_id, rv.name AS resolved_variant_name, cr.resolution_note, cr.resolved_at
       ${from}
      ORDER BY (cr.status = 'open') DESC, cr.requested_at DESC, cr.id DESC
      LIMIT ${limit} OFFSET ${offset}`, params);
  return {
    rows: rows.map((r) => ({
      ...r, id: Number(r.id), pr_id: Number(r.pr_id), line_no: Number(r.line_no),
      resolved_variant_id: r.resolved_variant_id == null ? null : Number(r.resolved_variant_id),
    })),
    total: total.n,
  };
}

/** Open a catalog request for a line (uq_pr_catreq_open_per_line: at most one open per line). */
export async function insertCatalogRequest(t, { companyId, lineId, requestedName, description, categoryId, requestedBy }) {
  return t.one(
    `INSERT INTO tbl_pr_catalog_request
       (hospitality_company_id, pr_line_id, requested_name, description, category_id, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'open', $6)
     RETURNING id, pr_line_id, requested_name, description, category_id, status, requested_by, requested_at`,
    [companyId, lineId, requestedName, description, categoryId, requestedBy]);
}

/** End a line: 'closed' (buyer) or 'cancelled' (requester), with the reason, who and when. */
export async function endLine(t, lineId, { status, reason, userId }) {
  await t.none(
    `UPDATE tbl_purchase_requisition_line
        SET status = $2, close_reason = $3, closed_by = $4, closed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [lineId, status, reason, userId]);
}

// ---------------------------------------------------------------------------
// Review routing (spec §6.1): the routing inputs of a saved PR, and the
// company admin's category → reviewing-department map.
// ---------------------------------------------------------------------------

/**
 * What submit would route: the PR's ACTIVE lines (with their stored, server-
 * derived category) and their live value Σ ROUND(qty × price, 2) as a
 * 2-decimal string. null when the PR does not exist.
 */
export async function routingInputs(prId, t = db) {
  return t.task(async (c) => {
    const head = await c.oneOrNone(
      `SELECT (${estimateTotalSql('p')})::text AS amount FROM tbl_purchase_requisition p WHERE p.id = $1`, [prId]);
    if (!head) return null;
    const lines = await c.any(
      `SELECT l.id, l.line_no, l.category_id
         FROM tbl_purchase_requisition_line l
        WHERE l.pr_id = $1 AND l.status = 'active'
        ORDER BY l.line_no`,
      [prId]);
    return {
      amount: head.amount,
      lines: lines.map((l) => ({ id: Number(l.id), line_no: Number(l.line_no), category_id: Number(l.category_id) })),
    };
  });
}

/** Hospitality companies the user administers: those of their own buyer company (tbl_users.company_id). */
export async function administeredCompanyIds(buyerCompanyId, t = db) {
  if (!buyerCompanyId) return [];
  return t.map(
    `SELECT id FROM tbl_hospitality_companies
      WHERE buyer_company_id = $1 AND COALESCE(is_deleted, 0) = 0
      ORDER BY id`,
    [buyerCompanyId], (r) => Number(r.id));
}

const REVIEW_ROUTE_SELECT = `
  SELECT m.id, m.hospitality_company_id, m.category_id, c.title AS category_title, pc.title AS parent_title,
         m.department_id, d.title AS department_title, m.created_by, u.name AS created_by_name, m.created_at
    FROM tbl_pr_review_category_map m
    JOIN tbl_category c ON c.id = m.category_id
    LEFT JOIN tbl_category pc ON pc.id = NULLIF(c.parent_id, 0)
    JOIN tbl_department d ON d.id = m.department_id
    LEFT JOIN tbl_users u ON u.id = m.created_by`;

/** The routing map of these companies, by category title. */
export async function listReviewRouting(companyIds, t = db) {
  return t.any(`${REVIEW_ROUTE_SELECT}
    WHERE m.hospitality_company_id = ANY($1::int[])
    ORDER BY c.title, m.id`, [companyIds]);
}

/**
 * Set the reviewing department of a category for one company (upsert on
 * (company, category): an existing row keeps its id). created_by/created_at
 * record who set the mapping as it now stands, and when.
 * @returns {Promise<object>} the row in listReviewRouting's shape, plus `created`.
 */
export async function upsertReviewRouting(t, { companyId, categoryId, departmentId, userId }) {
  const row = await t.one(
    `INSERT INTO tbl_pr_review_category_map AS m (hospitality_company_id, category_id, department_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hospitality_company_id, category_id)
     DO UPDATE SET department_id = EXCLUDED.department_id, created_by = EXCLUDED.created_by, created_at = NOW()
     RETURNING m.id, (xmax = 0) AS created`,
    [companyId, categoryId, departmentId, userId]);
  const out = await t.one(`${REVIEW_ROUTE_SELECT} WHERE m.id = $1`, [row.id]);
  return { ...out, created: row.created === true };
}

/** Delete a mapping only if it belongs to one of `companyIds`. Returns the deleted id or null. */
export async function deleteReviewRouting(t, { mapId, companyIds }) {
  const row = await t.oneOrNone(
    `DELETE FROM tbl_pr_review_category_map
      WHERE id = $1 AND hospitality_company_id = ANY($2::int[])
      RETURNING id`,
    [mapId, companyIds]);
  return row ? Number(row.id) : null;
}

// ---------------------------------------------------------------------------
// Conversion to an RFQ draft (spec §9, services/pr/prConversion.js). Lock
// order (R19 — the same as every buyer line action): the PR rows first, then
// the lines, each in id order, then the per-line advisory locks.
// ---------------------------------------------------------------------------

/**
 * {id, pr_id, company_id} of the given lines, UNLOCKED — the tenant check runs
 * on this before any row lock is taken (a foreign caller never locks another
 * tenant's rows), and it names the PR rows a conversion must lock first.
 */
export async function lineOwners(lineIds, t = db) {
  return t.map(
    `SELECT l.id, l.pr_id, p.hospitality_company_id AS company_id
       FROM tbl_purchase_requisition_line l
       JOIN tbl_purchase_requisition p ON p.id = l.pr_id
      WHERE l.id = ANY($1::int[])`,
    [lineIds], (r) => ({ id: Number(r.id), pr_id: Number(r.pr_id), company_id: Number(r.company_id) }));
}

/** Row-lock PRs in id order. Returns their rows, by id. */
export async function lockPrs(t, prIds) {
  return t.any(
    `SELECT ${PR_SELECT('p')} FROM tbl_purchase_requisition p WHERE p.id = ANY($1::int[]) ORDER BY p.id FOR UPDATE`,
    [prIds]);
}

/** Row-lock lines in id order (after their PRs). Returns {id, pr_id}, by id. */
export async function lockLines(t, lineIds) {
  return t.map(
    `SELECT l.id, l.pr_id FROM tbl_purchase_requisition_line l WHERE l.id = ANY($1::int[]) ORDER BY l.id FOR UPDATE`,
    [lineIds], (r) => ({ id: Number(r.id), pr_id: Number(r.pr_id) }));
}

/**
 * The per-line convert lock, pg_advisory_xact_lock(hashtext('pr_line_convert'),
 * line id), taken in id order — a DB-level backstop serialising two
 * conversions of one line (spec §9 concurrency). Held until the transaction ends.
 */
export async function lockLinesForConvert(t, lineIds) {
  await t.any(
    `SELECT pg_advisory_xact_lock(hashtext('pr_line_convert'), x.id)
       FROM (SELECT DISTINCT unnest($1::int[]) AS id ORDER BY 1) x`,
    [lineIds]);
}

/**
 * What conversion decides on, per line (read AFTER the locks, so it sees every
 * committed conversion): stored state, the effective variant (catalog or
 * mapped), whether a live RFQ link exists (LIVE_LINK_EXISTS — the derived-
 * progress rule) or an open catalog request, and the quantity as exact text.
 */
export async function convertLineStates(lineIds, t = db) {
  return t.any(
    `SELECT l.id, l.pr_id, l.line_no, l.line_kind, l.status, l.free_text_name, l.specification,
            l.quantity, ${NUMERIC_TEXT_SQL('l.quantity')} AS quantity_text, btrim(l.uom) AS uom,
            COALESCE(l.product_variant_id, l.mapped_variant_id) AS variant_id,
            ${LIVE_LINK_EXISTS('l')} AS has_live_link,
            EXISTS (SELECT 1 FROM tbl_pr_catalog_request cr
                     WHERE cr.pr_line_id = l.id AND cr.status = 'open') AS has_open_catalog_request
       FROM tbl_purchase_requisition_line l
      WHERE l.id = ANY($1::int[])
      ORDER BY l.id`,
    [lineIds]);
}

/**
 * The lines grouped by effective variant, in order of each group's first line:
 * {variant_id, quantity (the exact NUMERIC Σ as text, no trailing zeros), line_ids}.
 */
export async function convertGroups(lineIds, t = db) {
  const rows = await t.any(
    `SELECT COALESCE(l.product_variant_id, l.mapped_variant_id) AS variant_id,
            ${NUMERIC_TEXT_SQL('SUM(l.quantity)')} AS quantity,
            array_agg(l.id ORDER BY l.id) AS line_ids
       FROM tbl_purchase_requisition_line l
      WHERE l.id = ANY($1::int[])
      GROUP BY 1
      ORDER BY MIN(l.id)`,
    [lineIds]);
  return rows.map((r) => ({ variant_id: Number(r.variant_id), quantity: r.quantity, line_ids: r.line_ids.map(Number) }));
}

/** PR id → its department's title (the tag of a merged RFQ specification). */
export async function prDepartmentTitles(prIds, t = db) {
  const rows = await t.any(
    `SELECT p.id, d.title
       FROM tbl_purchase_requisition p
       LEFT JOIN tbl_department d ON d.id = p.department_id
      WHERE p.id = ANY($1::int[])`,
    [prIds]);
  return new Map(rows.map((r) => [Number(r.id), r.title]));
}

/**
 * Is the company one of the user's tenants — mapped to it (company or hotel
 * level) or holding any role scope in it? Outside it, a PR's lines do not exist
 * for the user (404, never 403).
 */
export async function isTenantMember(userId, companyId, t = db) {
  const row = await t.one(
    `SELECT EXISTS (SELECT 1 FROM tbl_hospitality_user_mappings WHERE user_id = $1 AND hospitality_company_id = $2)
         OR EXISTS (SELECT 1 FROM tbl_user_role_scopes WHERE user_id = $1 AND company_id = $2) AS ok`,
    [userId, companyId]);
  return row.ok === true;
}

/**
 * Is `processId` an ACTIVE approval process of the hospitality company's
 * parent buyer company — the rule saveRfqDraft applies to an RFQ's process?
 */
export async function isActiveProcessOfCompany(processId, companyId, t = db) {
  const row = await t.one(
    `SELECT EXISTS (
       SELECT 1 FROM tbl_approval_processes ap
         JOIN tbl_hospitality_companies hc ON hc.buyer_company_id = ap.company_id
        WHERE ap.id = $1 AND hc.id = $2 AND ap.is_active = true) AS ok`,
    [processId, companyId]);
  return row.ok === true;
}

export default {
  LIVE_PO_EXISTS, LIVE_LINK_EXISTS, LINE_PROGRESS_SQL, estimateTotalSql,
  istToday, nextPrNumber, insertPr, updateHeader, lineIds, replaceLines, lockPr, getPrRow, copyPr, getDetail,
  activeLines, setLineCategories, markSubmitted, markApproved, insertReview, supersedePendingReviews,
  instanceStepSummary, approvalPosition,
  eligibleReviews, reviewOfPr, closeReview, pendingReviewCount, lineOfPr, setLineSpecification,
  insertClause, clauseOfLine, deleteClause, insertAttachment, attachmentOfPr, deleteAttachment, reviewQueue,
  list, kpis, duplicates, hotelCell, departmentExists, activeCategoryIds, formHotels, formDepartments, searchItems, searchCategories,
  routingInputs, administeredCompanyIds, listReviewRouting, upsertReviewRouting, deleteReviewRouting,
  poolHotels, pool, buyersForHotel, isHotelBuyer, setAssignedBuyer, userName, lockLineState, lineStates, lineProgress,
  catalogRequestLocator, lockCatalogRequest, resolveOpenCatalogRequest, listCatalogRequests,
  setLineMapping, insertCatalogRequest, endLine,
  lineOwners, lockPrs, lockLines, lockLinesForConvert, convertLineStates, convertGroups, prDepartmentTitles,
  isTenantMember, isActiveProcessOfCompany,
};
