import db from '../../config/dbConn.js';
import { logger } from '../../util/logger.js';
import { buildArcScopeClause } from '../../helper/arc_v2/arcScope.js';
import { notSupersededByCancellation } from '../subscriptionEligibility.js';

/**
 * ARC v2 — Core model
 *
 * Database access layer for tbl_arc and its directly-owned tables:
 * tbl_arc_item, tbl_arc_invitation, tbl_arc_item_history_snapshot.
 * Tech-eval and comm-eval models live in arcEvaluationModel.js; contract
 * model in arcContractModel.js; MR model under app/models/mr/.
 *
 * Pattern follows the existing codebase: pg-promise via `db`, every function
 * accepts an optional txContext so it composes into transactions.
 */
const arcModel = {
  // ============================================================
  // ARC root
  // ============================================================

  /**
   * Create a draft ARC. Most fields are nullable so the wizard can save
   * partially-complete state; arcController.publish() enforces full-fill
   * before flipping status to 'floated'.
   */
  createDraft: async (data, txContext = null) => {
    const runner = txContext || db;
    const {
      arc_number,
      title,
      description = null,
      category_id,
      sub_category_ids = [],
      hospitality_company_id,
      hotel_id,
      department_id,
      process_id,
      submission_start_at = null,
      submission_end_at = null,
      contract_start_at = null,
      contract_end_at = null,
      technical_response_required = false,
      sample_required = false,
      eligibility_type = 'open',
      escalation_clause_json = {},
      payment_terms_expected = null,
      delivery_expected = null,
      penalty_clause = null,
      type = 'product',
      created_by,
    } = data;
    return runner.one(
      `INSERT INTO tbl_arc
         (arc_number, title, description, category_id, sub_category_ids,
          hospitality_company_id, hotel_id, department_id, process_id,
          status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          technical_response_required, sample_required, eligibility_type,
          escalation_clause_json, payment_terms_expected, delivery_expected, penalty_clause,
          type, created_by)
       VALUES
         ($1, $2, $3, $4, $5::jsonb,
          $6, $7, $8, $9,
          'draft',
          $10, $11, $12, $13,
          $14, $15, $16,
          $17::jsonb, $18, $19, $20,
          $21, $22)
       RETURNING *`,
      [
        arc_number, title, description, category_id, JSON.stringify(sub_category_ids),
        hospitality_company_id, hotel_id, department_id, process_id,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at,
        technical_response_required, sample_required, eligibility_type,
        JSON.stringify(escalation_clause_json || {}), payment_terms_expected, delivery_expected, penalty_clause,
        type ?? 'product', created_by,
      ]
    );
  },

  updateDraft: async (id, patch, txContext = null) => {
    const runner = txContext || db;
    // Only allow these fields to be patched on draft.
    const allowed = [
      'title','description','category_id','sub_category_ids','department_id','process_id',
      'submission_start_at','submission_end_at','contract_start_at','contract_end_at',
      'technical_response_required','sample_required','eligibility_type',
      'escalation_clause_json','payment_terms_expected','delivery_expected','penalty_clause',
      'type',
    ];
    const setParts = [];
    const values = [];
    let p = 1;
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const v = patch[key];
        if (key === 'sub_category_ids' || key === 'escalation_clause_json') {
          setParts.push(`${key} = $${p++}::jsonb`);
          values.push(JSON.stringify(v ?? (key === 'sub_category_ids' ? [] : {})));
        } else {
          setParts.push(`${key} = $${p++}`);
          values.push(v);
        }
      }
    }
    if (setParts.length === 0) {
      return runner.oneOrNone(`SELECT * FROM tbl_arc WHERE id = $1`, [id]);
    }
    setParts.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    return runner.one(
      `UPDATE tbl_arc SET ${setParts.join(', ')}
        WHERE id = $${p} AND status IN ('draft','publish_rejected')
       RETURNING *`,
      values
    );
  },

  setStatus: async (id, status, extras = {}, txContext = null) => {
    const runner = txContext || db;
    const cols = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const args = [status];
    let p = 2;
    if (extras.closed_reason !== undefined) { cols.push(`closed_reason = $${p++}`); args.push(extras.closed_reason); }
    args.push(id);
    return runner.oneOrNone(
      `UPDATE tbl_arc SET ${cols.join(', ')} WHERE id = $${p} RETURNING *`,
      args
    );
  },

  /**
   * Sr 40 — buyer "Extend submission deadline". Persists the new
   * submission_end_at VERBATIM (no Date() round-trip): the column is
   * `timestamp without time zone` storing IST wall-clock, same convention as
   * createDraft/updateDraft (see arcTime.js). When `reopen` is true (the ARC
   * had already flipped to 'submission_closed') also flips status back to
   * 'floated' in the same UPDATE so submitQuote's `status === 'floated'` +
   * open-window guard both pass again for the vendor.
   */
  extendSubmissionWindow: async (id, submissionEndAt, { reopen = false } = {}, txContext = null) => {
    const runner = txContext || db;
    const cols = ['submission_end_at = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const args = [submissionEndAt];
    let p = 2;
    if (reopen) {
      cols.push(`status = $${p++}`);
      args.push('floated');
    }
    args.push(id);
    return runner.one(
      `UPDATE tbl_arc SET ${cols.join(', ')} WHERE id = $${p} RETURNING *`,
      args
    );
  },

  getById: async (id, txContext = null) => {
    return (txContext || db).oneOrNone(`SELECT * FROM tbl_arc WHERE id = $1`, [id]);
  },

  getByNumber: async (arcNumber, txContext = null) => {
    return (txContext || db).oneOrNone(`SELECT * FROM tbl_arc WHERE arc_number = $1`, [arcNumber]);
  },

  /**
   * Mint the next per-FY ARC contract serial: `ARC-<fy>-<0001>`.
   *
   * Race-safe via a single atomic `INSERT … ON CONFLICT … DO UPDATE …
   * RETURNING` upsert against tbl_arc_number_seq — no MAX+1 (never copy the
   * RFQ rfqModel.getLastRfQNumber pattern, which is race-prone), no explicit
   * locking. A new FY inserts a fresh counter row starting at 1, so the
   * sequence resets automatically per FY.
   *
   * MUST be called with the SAME tx that will insert the tbl_arc row (pass
   * `t` from the caller's `db.tx`), so a rollback never leaves the counter
   * bumped while the ARC itself was not created — a skipped serial number on
   * rollback is an acceptable gap, a duplicated one is not. UNIQUE(arc_number)
   * on tbl_arc remains the last-line-of-defence.
   *
   * @param {string} fy - Indian FY label, e.g. "2026-27" (see helper/financialYear.js)
   * @param {*} [txContext] - tx runner; falls back to the plain `db` if omitted
   */
  nextArcNumber: async (fy, txContext = null) => {
    const runner = txContext || db;
    const { last_seq } = await runner.one(
      `INSERT INTO tbl_arc_number_seq (fy, last_seq) VALUES ($1, 1)
       ON CONFLICT (fy) DO UPDATE SET last_seq = tbl_arc_number_seq.last_seq + 1
       RETURNING last_seq`,
      [fy]
    );
    return `ARC-${fy}-${String(last_seq).padStart(4, '0')}`;
  },

  /**
   * List ARCs with optional status-group filter, scoped by hospitality_company
   * + the caller's RBAC scope matrix + (optional hotel_ids / department_ids).
   *
   * `scope_user_id` is MANDATORY for correctness on every buyer-facing caller:
   *   number → rows are filtered by that user's tbl_user_role_scopes matrix
   *   null   → NO scope filter (super admin only)
   * The company-id list alone is not a scope: resolveHospitalityCompanyScope
   * expands a single hotel-level mapping into a whole-company read, which is
   * exactly how every business unit's contracts leaked to every other BU.
   * Client-supplied hotel_ids / department_ids remain a NARROWING facet — they
   * are ANDed with the matrix and can never widen it.
   *
   * statusGroup values map to the lifecycle buckets surfaced by the sidebar
   * (plan §6.4): drafts, ongoing, approved, active, ended, all.
   */
  list: async ({
    hospitality_company_ids = null, // number[] (scope) | null (all, super admin)
    scope_user_id = null,           // number (RBAC matrix) | null (super admin)
    hotel_ids = null,
    department_ids = null,
    statusGroup = 'all',
    page = 1,
    limit = 20,
  }, txContext = null) => {
    const runner = txContext || db;
    // tbl_hospitality_company_hotels (joined as `h` below) also has a
    // `hospitality_company_id` column; alias every filter column to `a.`
    // so Postgres doesn't error with "column reference is ambiguous".
    const conditions = [];
    const args = [];
    let p = 1;
    // null = no company filter (super admin); an array (incl. empty) scopes to
    // exactly those companies — empty array deliberately matches nothing.
    if (hospitality_company_ids !== null) {
      conditions.push(`a.hospitality_company_id = ANY($${p++}::int[])`);
      args.push(Array.isArray(hospitality_company_ids) ? hospitality_company_ids : []);
    }
    // 4-axis RBAC matrix (company × hotel × department × process).
    const scope = buildArcScopeClause(scope_user_id, {
      company: 'a.hospitality_company_id',
      hotel: 'a.hotel_id',
      department: 'a.department_id',
      process: 'a.process_id',
    }, p);
    if (scope.paramsConsumed > 0) {
      conditions.push(scope.clause);
      args.push(...scope.params);
      p += scope.paramsConsumed;
    }
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) {
      conditions.push(`a.hotel_id = ANY($${p++}::int[])`);
      args.push(hotel_ids);
    }
    if (Array.isArray(department_ids) && department_ids.length > 0) {
      conditions.push(`a.department_id = ANY($${p++}::int[])`);
      args.push(department_ids);
    }
    const statusSets = STATUS_GROUPS[statusGroup] || null;
    if (statusSets) {
      conditions.push(`a.status = ANY($${p++}::varchar[])`);
      args.push(statusSets);
    }
    args.push(limit);
    args.push((page - 1) * limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows, count] = await Promise.all([
      runner.any(
        `SELECT a.id, a.arc_number, a.title, a.status, a.category_id, a.hotel_id,
                a.department_id, a.submission_start_at, a.submission_end_at,
                a.contract_start_at, a.contract_end_at, a.created_at, a.updated_at,
                a.created_by, u.name AS created_by_name,
                cat.title AS category_title,
                h.name AS hotel_name, h.city AS hotel_city,
                d.title AS department_title,
                COALESCE(item_agg.item_count, 0)::int AS item_count,
                COALESCE(item_agg.item_names, '[]'::json) AS item_names,
                COALESCE(item_agg.product_variant_ids, '[]'::json) AS product_variant_ids,
                COALESCE(inv_agg.invited_count, 0)::int AS invited_count,
                COALESCE(inv_agg.submitted_count, 0)::int AS submitted_count,
                COALESCE(award_agg.awarded_vendor_names, '[]'::json) AS awarded_vendor_names,
                COALESCE(award_agg.awarded_vendor_ids, '[]'::json) AS awarded_vendor_ids,
                COALESCE(award_agg.awarded_vendors, '[]'::json) AS awarded_vendors,
                COALESCE(line_agg.total_committed_value, 0)::numeric AS committed_value,
                COALESCE(line_agg.total_consumed_value, 0)::numeric AS consumed_value,
                COALESCE(co_agg.call_off_count, 0)::int AS call_off_count,
                COALESCE(amend_agg.requested_amendments, 0)::int AS requested_amendments,
                COALESCE(amend_agg.active_amendments, 0)::int AS active_amendments,
                -- DECISION-3: derived chip — true when a non-terminal ARC round is live
                EXISTS(
                  SELECT 1 FROM tbl_negotiation_rounds nr
                   WHERE nr.source_type = 'ARC' AND nr.source_id = a.id
                     AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
                     AND nr.end_date > NOW()
                ) AS negotiation_in_progress
           FROM tbl_arc a
           LEFT JOIN tbl_users u ON u.id = a.created_by
           LEFT JOIN tbl_category cat ON cat.id = a.category_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_department d ON d.id = a.department_id
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS item_count,
                    json_agg(pv.name ORDER BY ai.id) FILTER (WHERE pv.name IS NOT NULL) AS item_names,
                    json_agg(ai.product_variant_id ORDER BY ai.id) AS product_variant_ids
               FROM tbl_arc_item ai
               LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
              WHERE ai.arc_id = a.id
           ) item_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS invited_count,
                    COUNT(*) FILTER (WHERE status = 'submitted') AS submitted_count
               FROM tbl_arc_invitation
              WHERE arc_id = a.id
           ) inv_agg ON TRUE
           LEFT JOIN LATERAL (
             -- Dedupe to one row per awarded vendor first, so names / ids /
             -- {name,company} objects stay index-aligned (the listing pairs
             -- them in the vendor hover tooltip). Company name prefers
             -- tbl_company.company_name, falling back to the user's
             -- organization_name.
             SELECT json_agg(v.name ORDER BY v.name)       AS awarded_vendor_names,
                    json_agg(v.vendor_id ORDER BY v.name)  AS awarded_vendor_ids,
                    json_agg(jsonb_build_object(
                      'id', v.vendor_id, 'name', v.name, 'company', v.company
                    ) ORDER BY v.name)                     AS awarded_vendors
               FROM (
                 SELECT DISTINCT c.vendor_id,
                        uvend.name AS name,
                        COALESCE(tc.company_name, uvend.organization_name) AS company
                   FROM tbl_arc_contract c
                   LEFT JOIN tbl_users uvend ON uvend.id = c.vendor_id
                   LEFT JOIN tbl_company tc ON tc.id = uvend.company_id
                  WHERE c.arc_id = a.id
               ) v
           ) award_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT SUM(cl.unit_rate * cl.committed_qty) AS total_committed_value,
                    SUM(cl.unit_rate * cl.consumed_qty) AS total_consumed_value
               FROM tbl_arc_contract_line cl
               JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id
              WHERE c.arc_id = a.id
           ) line_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS call_off_count
               FROM tbl_arc_callof_po cp
               JOIN tbl_arc_contract c ON c.id = cp.arc_contract_id
              WHERE c.arc_id = a.id
           ) co_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) FILTER (WHERE am.status = 'requested')           AS requested_amendments,
                    COUNT(*) FILTER (WHERE am.status IN ('approved','live'))  AS active_amendments
               FROM tbl_arc_amendment am
               JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
              WHERE c.arc_id = a.id
           ) amend_agg ON TRUE
           ${where}
          ORDER BY a.created_at DESC
          LIMIT $${p} OFFSET $${p + 1}`,
        args
      ),
      runner.one(`SELECT COUNT(*)::int AS c FROM tbl_arc a ${where}`, args.slice(0, args.length - 2)),
    ]);
    return { data: rows, total: count.c, page, limit };
  },

  /**
   * Of the given ARC ids, which ones currently have an action waiting on
   * `userId` — i.e. the user is a PENDING approver at the CURRENT step of a
   * PENDING approval instance tied to the ARC. Covers the three ARC-linked
   * approval entities: ARC_TECH + ARC_COMMITTEE (entity_id = arc_id) and
   * ARC_AMENDMENT (entity_id = amendment_id → arc_contract → arc).
   *
   * Mirrors arcLifecycleModel.loadInstance's "can_user_approve" check (user-
   * level approvers only), so the listing's "Pending for me" tab stays
   * consistent with the per-ARC approver gating elsewhere.
   *
   * Returns: number[] of arc ids (subset of the input).
   */
  getPendingForUserArcIds: async (arcIds, userId, txContext = null) => {
    if (!Array.isArray(arcIds) || arcIds.length === 0 || !userId) return [];
    const rows = await (txContext || db).any(
      `SELECT DISTINCT arc_id FROM (
         SELECT ai.entity_id AS arc_id
           FROM tbl_approval_instances ai
           JOIN tbl_approval_instance_steps s
             ON s.approval_instance_id = ai.id AND s.step_order = ai.current_step
           JOIN tbl_approval_step_approvers sa
             ON sa.approval_instance_step_id = s.id
          WHERE ai.entity_type IN ('ARC_TECH','ARC_COMMITTEE','ARC_PUBLISH')
            AND ai.status = 'PENDING'
            AND ai.entity_id = ANY($1::int[])
            AND sa.approver_user_id = $2
            AND sa.status = 'PENDING'
         UNION
         SELECT c.arc_id
           FROM tbl_approval_instances ai
           JOIN tbl_arc_amendment am ON am.approval_instance_id = ai.id
           JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
           JOIN tbl_approval_instance_steps s
             ON s.approval_instance_id = ai.id AND s.step_order = ai.current_step
           JOIN tbl_approval_step_approvers sa
             ON sa.approval_instance_step_id = s.id
          WHERE ai.entity_type = 'ARC_AMENDMENT'
            AND ai.status = 'PENDING'
            AND c.arc_id = ANY($1::int[])
            AND sa.approver_user_id = $2
            AND sa.status = 'PENDING'
       ) t`,
      [arcIds.map(Number), Number(userId)]
    );
    return rows.map((r) => Number(r.arc_id));
  },

  /**
   * Dashboard KPI counts per status-group — feeds the sidebar live badges.
   *
   * Counts are a leak surface in their own right: an exact count for a hotel
   * the caller cannot open still discloses that hotel's activity. Same
   * `scope_user_id` contract as list().
   */
  dashboardCounts: async ({
    hospitality_company_ids = null,
    scope_user_id = null,
    hotel_ids = null,
    department_ids = null,
  }, txContext = null) => {
    const runner = txContext || db;
    const conditions = [];
    const args = [];
    let p = 1;
    if (hospitality_company_ids !== null) {
      conditions.push(`a.hospitality_company_id = ANY($${p++}::int[])`);
      args.push(Array.isArray(hospitality_company_ids) ? hospitality_company_ids : []);
    }
    const scope = buildArcScopeClause(scope_user_id, {
      company: 'a.hospitality_company_id',
      hotel: 'a.hotel_id',
      department: 'a.department_id',
      process: 'a.process_id',
    }, p);
    if (scope.paramsConsumed > 0) {
      conditions.push(scope.clause);
      args.push(...scope.params);
      p += scope.paramsConsumed;
    }
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) {
      conditions.push(`a.hotel_id = ANY($${p++}::int[])`);
      args.push(hotel_ids);
    }
    if (Array.isArray(department_ids) && department_ids.length > 0) {
      conditions.push(`a.department_id = ANY($${p++}::int[])`);
      args.push(department_ids);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await runner.any(
      `SELECT a.status, COUNT(*)::int AS c FROM tbl_arc a ${where} GROUP BY a.status`,
      args
    );
    const counts = { drafts: 0, ongoing: 0, approved: 0, active: 0, ended: 0, all: 0 };
    for (const r of rows) {
      counts.all += r.c;
      for (const [grp, statuses] of Object.entries(STATUS_GROUPS)) {
        if (grp === 'all') continue;
        if (statuses.includes(r.status)) counts[grp] += r.c;
      }
    }
    return counts;
  },

  // ============================================================
  // ARC items
  // ============================================================

  addItem: async (arcId, data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_item
         (arc_id, product_variant_id, spec_text, target_price,
          indicative_qty, uom, spec_attachment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [arcId, data.product_variant_id, data.spec_text || null, data.target_price ?? null,
       data.indicative_qty, data.uom || null, data.spec_attachment_id ?? null]
    );
  },

  updateItem: async (itemId, patch, txContext = null) => {
    const runner = txContext || db;
    const allowed = ['spec_text','target_price','indicative_qty','uom','spec_attachment_id'];
    const setParts = []; const values = []; let p = 1;
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        setParts.push(`${key} = $${p++}`);
        values.push(patch[key]);
      }
    }
    if (setParts.length === 0) {
      return runner.oneOrNone(`SELECT * FROM tbl_arc_item WHERE id = $1`, [itemId]);
    }
    setParts.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(itemId);
    return runner.one(
      `UPDATE tbl_arc_item SET ${setParts.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
  },

  removeItem: async (itemId, txContext = null) => {
    return (txContext || db).none(`DELETE FROM tbl_arc_item WHERE id = $1`, [itemId]);
  },

  listItems: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT ai.*, pv.name AS variant_name, pv.slug AS variant_slug
         FROM tbl_arc_item ai
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
        WHERE ai.arc_id = $1
        ORDER BY ai.id`,
      [arcId]
    );
  },

  /**
   * Per-item tech-eval CONFIG for every item of an ARC, keyed by arc_item_id —
   * powers the create-wizard's Tech step on draft resume (one round-trip instead
   * of N per-item GETs). Returns ONLY the buyer-authored configuration
   * (minimum_passing_score + clauses); it deliberately excludes vendor
   * responses/scores/aliases (those belong to the blind-eval read path, not to
   * rehydrating a draft's setup). Items with no tech-eval row are simply absent
   * from the map — the FE defaults those to "tech ON, no clauses yet".
   */
  listTechEvalForArc: async (arcId, txContext = null) => {
    const rows = await (txContext || db).any(
      `SELECT te.arc_item_id,
              te.minimum_passing_score,
              c.id            AS clause_id,
              c.clause_text,
              c.weightage,
              c.clause_type,
              c.is_mandatory
         FROM tbl_arc_item_tech_evaluation te
         JOIN tbl_arc_item ai ON ai.id = te.arc_item_id
         LEFT JOIN tbl_arc_item_tech_evaluation_clauses c
                ON c.arc_item_tech_evaluation_id = te.id
        WHERE ai.arc_id = $1
        ORDER BY te.arc_item_id, c.id`,
      [arcId]
    );
    // Fold the flat (item × clause) rows into { [arc_item_id]: { minimum_passing_score, clauses[] } }.
    const byItem = {};
    for (const r of rows) {
      const key = String(r.arc_item_id);
      if (!byItem[key]) {
        byItem[key] = { minimum_passing_score: r.minimum_passing_score, clauses: [] };
      }
      if (r.clause_id != null) {
        byItem[key].clauses.push({
          id: r.clause_id,
          clause_text: r.clause_text,
          weightage: r.weightage,
          clause_type: r.clause_type,
          is_mandatory: r.is_mandatory,
        });
      }
    }
    return byItem;
  },

  // ============================================================
  // Invitations
  // ============================================================

  setInvitations: async (arcId, vendorIds, txContext = null) => {
    const runner = txContext || db;
    if (!Array.isArray(vendorIds) || vendorIds.length === 0) {
      await runner.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
      return [];
    }
    // Idempotent upsert; remove vendors no longer in the list.
    await runner.none(
      `DELETE FROM tbl_arc_invitation
        WHERE arc_id = $1 AND vendor_id <> ALL($2::int[])`,
      [arcId, vendorIds]
    );
    for (const vid of vendorIds) {
      await runner.none(
        `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
         VALUES ($1, $2, 'invited')
         ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
        [arcId, vid]
      );
    }
    return runner.any(`SELECT * FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
  },

  recordVendorResponse: async (arcId, vendorId, status, txContext = null) => {
    return (txContext || db).oneOrNone(
      `UPDATE tbl_arc_invitation
          SET status = $3, responded_at = CASE WHEN $3 IN ('submitted','declined') THEN CURRENT_TIMESTAMP ELSE responded_at END
        WHERE arc_id = $1 AND vendor_id = $2
       RETURNING *`,
      [arcId, vendorId, status]
    );
  },

  listInvitations: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT i.*, u.name AS vendor_name,
              u.organization_name AS vendor_company,
              u.email AS vendor_email, u.mobile AS vendor_mobile
         FROM tbl_arc_invitation i
         LEFT JOIN tbl_users u ON u.id = i.vendor_id
        WHERE i.arc_id = $1
        ORDER BY i.invited_at`,
      [arcId]
    );
  },

  // ============================================================
  // History snapshot (past-3y consumption frozen at float time)
  // ============================================================

  upsertHistorySnapshot: async (arcItemId, snapshots, txContext = null) => {
    const runner = txContext || db;
    for (const s of snapshots) {
      await runner.none(
        `INSERT INTO tbl_arc_item_history_snapshot
           (arc_item_id, year_offset, consumed_qty, last_rate, last_vendor_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (arc_item_id, year_offset) DO UPDATE
           SET consumed_qty   = EXCLUDED.consumed_qty,
               last_rate      = EXCLUDED.last_rate,
               last_vendor_id = EXCLUDED.last_vendor_id`,
        [arcItemId, s.year_offset, s.consumed_qty ?? 0, s.last_rate ?? null, s.last_vendor_id ?? null]
      );
    }
  },

  getHistorySnapshot: async (arcItemId, txContext = null) => {
    return (txContext || db).any(
      `SELECT * FROM tbl_arc_item_history_snapshot
        WHERE arc_item_id = $1
        ORDER BY year_offset`,
      [arcItemId]
    );
  },

  // ============================================================
  // Category → Department resolution (powers the wizard picker)
  // ============================================================

  /**
   * Intersection of (departments mapped to the category) ∩ (departments the
   * user is scoped to via tbl_user_role_scopes for this company AND, when the
   * wizard has already picked a business unit, for THAT hotel).
   *
   * The hotel axis matters: a user scoped proc@A1 + eng@A2 was previously
   * offered {proc, eng} for either hotel, so the picker could hand them a
   * (A1, eng) cell they have no grant for — a scope widening at creation time
   * and an enumeration of another BU's departments. hotel_id is optional so
   * the company-wide picker still works before a BU is chosen.
   */
  getDepartmentsForCategoryAndUser: async ({ category_id, user_id, hospitality_company_id, hotel_id = null }, txContext = null) => {
    return (txContext || db).any(
      `SELECT DISTINCT d.id, d.title
         FROM tbl_category_department cd
         JOIN tbl_department d ON d.id = cd.department_id
        WHERE cd.category_id = $1
          AND EXISTS (
            SELECT 1 FROM tbl_user_role_scopes urs
             WHERE urs.user_id = $2
               AND urs.company_id = $3
               AND ($4::int IS NULL OR urs.hotel_id IS NULL OR urs.hotel_id = $4)
               AND (urs.department_id = d.id OR urs.department_id IS NULL)
          )
        ORDER BY d.title`,
      [category_id, user_id, hospitality_company_id, hotel_id]
    );
  },

  // All departments the user is mapped to in a given hotel — derived from their
  // role scopes, NOT the category→department mapping. A hotel/company-wide scope
  // (department_id IS NULL) grants every department; otherwise just the
  // specifically-scoped ones. Mirrors rbacModel.getDepartmentsForUserScope but
  // permission-agnostic (ARC create is role-gated via acl(), not a fine-grained
  // permission), so the picker shows the user's full department access.
  getDepartmentsForUserInHotel: async ({ user_id, hotel_id }, txContext = null) => {
    return (txContext || db).any(
      `WITH hotel_company AS (
         SELECT hospitality_company_id
           FROM tbl_hospitality_company_hotels
          WHERE id = $2 AND COALESCE(is_deleted, 0) = 0
          LIMIT 1
       ),
       user_scopes AS (
         SELECT DISTINCT urs.department_id
           FROM tbl_user_role_scopes urs
          WHERE urs.user_id = $1
            AND urs.company_id = (SELECT hospitality_company_id FROM hotel_company)
            AND (urs.hotel_id IS NULL OR urs.hotel_id = $2)
       )
       SELECT d.id, d.title
         FROM tbl_department d
        WHERE EXISTS (SELECT 1 FROM user_scopes WHERE department_id IS NULL)
           OR d.id IN (SELECT department_id FROM user_scopes WHERE department_id IS NOT NULL)
        ORDER BY d.title`,
      [user_id, hotel_id]
    );
  },

  // ============================================================
  // Vendor eligibility for ARC (category-based — mirrors RFQ's variant-based
  // helper but joins through tbl_product_categories at category granularity).
  // ============================================================

  getEligibleVendorsForCategory: async ({ category_id, hotel_id }, txContext = null) => {
    return (txContext || db).any(
      `SELECT DISTINCT u.id, u.name, u.email
         FROM tbl_users u
         JOIN tbl_vendor_hotel_category_subscription vhcs
           ON vhcs.vendor_id = u.id
        WHERE u.user_type = 3
          AND u.status = 1
          AND vhcs.status IN ('active','expired')
          AND ${notSupersededByCancellation('vhcs')}
          AND (
            (vhcs.item_type = 'hotel'    AND vhcs.item_id = $2)
            OR
            (vhcs.item_type = 'category' AND vhcs.item_id = $1)
          )
        ORDER BY u.name`,
      [category_id, hotel_id]
    );
  },
};

const STATUS_GROUPS = {
  drafts:   ['draft','pending_publish_approval','publish_rejected'],
  ongoing:  ['floated','submission_closed',
             'tech_eval_in_progress','tech_eval_approved','tech_eval_rejected',
             'comm_eval_in_progress','comm_eval_finalized',
             'committee_review','committee_sent_back'],
  approved: ['committee_approved','contract_generated','awaiting_vendor_acceptance'],
  active:   ['contract_active','expiring_soon'],
  ended:    ['expired','terminated','closed_no_award','committee_rejected'],
};

export default arcModel;
export { STATUS_GROUPS };
