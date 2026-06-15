import db from '../../config/dbConn.js';

/**
 * ARC v2 — Technical + Commercial evaluation model.
 *
 * Tech-eval mirrors the existing RFQ tech-eval shape — clauses + per-vendor
 * responses + computed pass/fail per (item × vendor × round).
 *
 * Commercial-eval supports multi-vendor split awards (plan §4.4). Allocations
 * are stored as absolute quantities; the invariant
 * SUM(allocated_qty)/item = tbl_arc_item.indicative_qty is enforced in the
 * controller on every save (this model layer trusts callers).
 */
const arcEvalModel = {
  // ============================================================
  // Tech evaluation
  // ============================================================

  upsertTechEval: async (arcItemId, { minimum_passing_score = 0, current_round = 1 } = {}, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_item_tech_evaluation
         (arc_item_id, minimum_passing_score, current_round)
       VALUES ($1, $2, $3)
       ON CONFLICT (arc_item_id) DO UPDATE
         SET minimum_passing_score = EXCLUDED.minimum_passing_score,
             current_round         = EXCLUDED.current_round,
             updated_at            = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcItemId, minimum_passing_score, current_round]
    );
  },

  addClause: async (techEvalId, clause, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [techEvalId, clause.clause_text, clause.weightage, clause.clause_type || null]
    );
  },

  removeClause: async (clauseId, txContext = null) => {
    return (txContext || db).none(`DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE id = $1`, [clauseId]);
  },

  listClauses: async (techEvalId, txContext = null) => {
    return (txContext || db).any(
      `SELECT * FROM tbl_arc_item_tech_evaluation_clauses
        WHERE arc_item_tech_evaluation_id = $1
        ORDER BY id`,
      [techEvalId]
    );
  },

  upsertVendorResponse: async (clauseId, vendorId, response, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, $3)
       ON CONFLICT (arc_item_tech_evaluation_clauses_id, vendor_id) DO UPDATE
         SET vendor_response = EXCLUDED.vendor_response
       RETURNING *`,
      [clauseId, vendorId, response]
    );
  },

  scoreVendorResponse: async (responseId, { buyer_id, buyer_marks, buyer_remark = null }, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_arc_item_tech_evaluation_vendors_response
         SET buyer_id        = $2,
             buyer_marks     = $3,
             buyer_remark    = $4,
             score_timestamp = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [responseId, buyer_id, buyer_marks, buyer_remark]
    );
  },

  /**
   * Compute per-vendor calculated_score for an item.
   * Returns: [{ vendor_id, calculated_score, qualifies }]
   */
  computeItemScores: async (arcItemId, round = 1, txContext = null) => {
    const runner = txContext || db;
    const te = await runner.oneOrNone(
      `SELECT * FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = $1`,
      [arcItemId]
    );
    if (!te) return [];
    return runner.any(
      `WITH totals AS (
         SELECT SUM(weightage)::numeric AS total_weight
           FROM tbl_arc_item_tech_evaluation_clauses
          WHERE arc_item_tech_evaluation_id = $1
       ),
       per_vendor AS (
         SELECT r.vendor_id,
                SUM(COALESCE(r.buyer_marks, 0))::numeric AS earned
           FROM tbl_arc_item_tech_evaluation_vendors_response r
           JOIN tbl_arc_item_tech_evaluation_clauses c
             ON c.id = r.arc_item_tech_evaluation_clauses_id
          WHERE c.arc_item_tech_evaluation_id = $1
          GROUP BY r.vendor_id
       )
       SELECT pv.vendor_id,
              CASE WHEN t.total_weight IS NULL OR t.total_weight = 0
                   THEN 0::numeric
                   ELSE ROUND((pv.earned / t.total_weight) * 100, 2)
              END AS calculated_score,
              CASE WHEN t.total_weight IS NULL OR t.total_weight = 0
                   THEN FALSE
                   ELSE (ROUND((pv.earned / t.total_weight) * 100, 2) >= $2)
              END AS qualifies
         FROM per_vendor pv
        CROSS JOIN totals t`,
      [te.id, te.minimum_passing_score]
    );
  },

  recordClearedVendors: async (techEvalId, rows, txContext = null) => {
    const runner = txContext || db;
    const inserted = [];
    for (const r of rows) {
      inserted.push(await runner.one(
        `INSERT INTO tbl_arc_item_tech_evaluation_cleared_vendors
           (arc_item_tech_evaluation_id, vendor_id, calculated_score, status,
            evaluation_round, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (arc_item_tech_evaluation_id, vendor_id, evaluation_round) DO UPDATE
           SET calculated_score = EXCLUDED.calculated_score,
               status           = EXCLUDED.status
         RETURNING *`,
        [techEvalId, r.vendor_id, r.calculated_score,
         r.qualifies ? 'qualified' : 'not_qualified',
         r.evaluation_round || 1, r.created_by || null]
      ));
    }
    return inserted;
  },

  // item_id → qualified vendor_ids (latest evaluation round). Only items
  // that HAVE technical clauses appear in the map — absent items carry no
  // technical restriction (technical was skipped for them). An item present
  // with an empty array has clauses but no qualified vendor yet.
  qualifiedVendorsByItem: async (arcId, txContext = null) => {
    const runner = txContext || db;
    const rows = await runner.any(
      `SELECT i.id AS item_id, cv.vendor_id
         FROM tbl_arc_item i
         JOIN tbl_arc_item_tech_evaluation te ON te.arc_item_id = i.id
         JOIN tbl_arc_item_tech_evaluation_clauses cl ON cl.arc_item_tech_evaluation_id = te.id
         LEFT JOIN tbl_arc_item_tech_evaluation_cleared_vendors cv
           ON cv.arc_item_tech_evaluation_id = te.id
          AND cv.evaluation_round = te.current_round
          AND cv.status = 'qualified'
        WHERE i.arc_id = $1
        GROUP BY i.id, cv.vendor_id`,
      [arcId]
    );
    const map = {};
    rows.forEach((r) => {
      const k = Number(r.item_id);
      if (!map[k]) map[k] = [];
      if (r.vendor_id != null) map[k].push(Number(r.vendor_id));
    });
    return map;
  },

  // ============================================================
  // Commercial evaluation
  // ============================================================

  upsertCommEval: async (arcId, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_comm_evaluation (arc_id, status)
       VALUES ($1, 'in_progress')
       ON CONFLICT (arc_id) DO UPDATE
         SET updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcId]
    );
  },

  getCommEval: async (arcId, txContext = null) => {
    return (txContext || db).oneOrNone(`SELECT * FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId]);
  },

  setCommEvalStatus: async (commEvalId, status, extras = {}, txContext = null) => {
    const runner = txContext || db;
    const sets = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const args = [status];
    let p = 2;
    if (extras.finalized_by !== undefined) { sets.push(`finalized_by = $${p++}`); args.push(extras.finalized_by); }
    if (extras.finalized_at !== undefined) { sets.push(`finalized_at = $${p++}`); args.push(extras.finalized_at); }
    if (extras.approval_instance_id !== undefined) { sets.push(`approval_instance_id = $${p++}`); args.push(extras.approval_instance_id); }
    args.push(commEvalId);
    return runner.oneOrNone(
      `UPDATE tbl_arc_comm_evaluation SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      args
    );
  },

  /**
   * Replace the full award proposal for an arc item.
   * Caller is responsible for the reconciliation invariant
   * (SUM(allocated_qty) = tbl_arc_item.indicative_qty).
   */
  setItemAwards: async (commEvalId, arcItemId, allocations, txContext = null) => {
    const runner = txContext || db;
    await runner.none(
      `DELETE FROM tbl_arc_comm_evaluation_award
        WHERE arc_comm_evaluation_id = $1 AND arc_item_id = $2`,
      [commEvalId, arcItemId]
    );
    const inserted = [];
    for (const a of allocations) {
      if (!a.allocated_qty || Number(a.allocated_qty) <= 0) continue;
      inserted.push(await runner.one(
        `INSERT INTO tbl_arc_comm_evaluation_award
           (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id,
            awarded_quote_line_id, allocated_qty, allocated_share_pct,
            l_rank, is_l1_default, awarded_quote_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING *`,
        [commEvalId, arcItemId, a.awarded_vendor_id,
         a.awarded_quote_line_id, a.allocated_qty, a.allocated_share_pct ?? null,
         a.l_rank ?? null, a.is_l1_default ?? false,
         JSON.stringify(a.awarded_quote_snapshot || {})]
      ));
    }
    return inserted;
  },

  listAwards: async (commEvalId, txContext = null) => {
    return (txContext || db).any(
      `SELECT cea.*, u.name AS vendor_name
         FROM tbl_arc_comm_evaluation_award cea
         LEFT JOIN tbl_users u ON u.id = cea.awarded_vendor_id
        WHERE cea.arc_comm_evaluation_id = $1
        ORDER BY cea.arc_item_id, cea.allocated_qty DESC`,
      [commEvalId]
    );
  },

  getAwardForVendorItem: async (commEvalId, arcItemId, vendorId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT * FROM tbl_arc_comm_evaluation_award
        WHERE arc_comm_evaluation_id = $1 AND arc_item_id = $2 AND awarded_vendor_id = $3`,
      [commEvalId, arcItemId, vendorId]
    );
  },

  /**
   * Apply a commercial evaluator's scoped revision to ONE field of ONE award
   * (item × vendor) in response to a vendor clarification. Price/term fields
   * live on the award snapshot (which flows straight into the regenerated
   * contract line). committed_qty additionally shifts the item's indicative_qty
   * by the same delta so the allocation→indicative reconciliation invariant
   * stays intact for finalize. Returns { old_value, new_value }.
   */
  updateAwardField: async (commEvalId, arcItemId, vendorId, field, newValue, txContext = null) => {
    const runner = txContext || db;
    const award = await runner.oneOrNone(
      `SELECT * FROM tbl_arc_comm_evaluation_award
        WHERE arc_comm_evaluation_id = $1 AND arc_item_id = $2 AND awarded_vendor_id = $3
        FOR UPDATE`,
      [commEvalId, arcItemId, vendorId]
    );
    if (!award) { const e = new Error('Award not found for this item/vendor'); e.httpStatus = 404; throw e; }
    const snap = typeof award.awarded_quote_snapshot === 'string'
      ? JSON.parse(award.awarded_quote_snapshot)
      : (award.awarded_quote_snapshot || {});

    const SNAP_KEY = {
      base_price: 'rate', gst: 'gst_pct', charges: 'charges',
      payment_terms: 'payment_terms', delivery_terms: 'delivery_terms',
    };

    let oldValue;
    if (field === 'committed_qty') {
      oldValue = Number(award.allocated_qty);
      const next = Number(newValue);
      const delta = next - oldValue;
      await runner.none(
        `UPDATE tbl_arc_comm_evaluation_award
            SET allocated_qty = $2
          WHERE id = $1`,
        [award.id, next]
      );
      // Keep SUM(allocated_qty) == indicative_qty by absorbing the delta.
      await runner.none(
        `UPDATE tbl_arc_item SET indicative_qty = indicative_qty + $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [arcItemId, delta]
      );
      return { old_value: oldValue, new_value: next };
    }

    const key = SNAP_KEY[field];
    oldValue = snap[key] ?? null;
    snap[key] = newValue;
    await runner.none(
      `UPDATE tbl_arc_comm_evaluation_award
          SET awarded_quote_snapshot = $2::jsonb
        WHERE id = $1`,
      [award.id, JSON.stringify(snap)]
    );
    return { old_value: oldValue, new_value: newValue };
  },

  appendCommEvalHistory: async (commEvalId, action, payload, changedBy, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_comm_evaluation_history
         (arc_comm_evaluation_id, action, payload, changed_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [commEvalId, action, JSON.stringify(payload || {}), changedBy]
    );
  },

  // ============================================================
  // Vendor quotes (the inputs to commercial eval)
  // ============================================================

  upsertQuote: async (arcId, vendorId, fields, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_quote
         (arc_id, vendor_id, payment_terms, gstin_used)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET payment_terms = EXCLUDED.payment_terms,
             gstin_used    = EXCLUDED.gstin_used,
             updated_at    = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcId, vendorId, fields.payment_terms || null, fields.gstin_used || null]
    );
  },

  submitQuote: async (arcQuoteId, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_arc_quote SET submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
       RETURNING *`,
      [arcQuoteId]
    );
  },

  upsertQuoteLine: async (arcQuoteId, line, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_quote_line
         (arc_quote_id, arc_item_id, rate, gst_pct, charges, lead_time_days, moq, validity_notes)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (arc_quote_id, arc_item_id) DO UPDATE
         SET rate           = EXCLUDED.rate,
             gst_pct        = EXCLUDED.gst_pct,
             charges        = EXCLUDED.charges,
             lead_time_days = EXCLUDED.lead_time_days,
             moq            = EXCLUDED.moq,
             validity_notes = EXCLUDED.validity_notes,
             updated_at     = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcQuoteId, line.arc_item_id, line.rate ?? null, line.gst_pct ?? null,
       JSON.stringify(line.charges || []),
       line.lead_time_days ?? null, line.moq ?? null, line.validity_notes ?? null]
    );
  },

  listQuoteLines: async (arcQuoteId, txContext = null) => {
    return (txContext || db).any(
      `SELECT * FROM tbl_arc_quote_line WHERE arc_quote_id = $1 ORDER BY arc_item_id`,
      [arcQuoteId]
    );
  },

  /** Returns all quote lines for a given ARC, joined with vendor + item info. */
  listAllQuotesForArc: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT q.id AS quote_id, q.vendor_id, u.name AS vendor_name, q.submitted_at,
              ql.id AS quote_line_id, ql.arc_item_id, ql.rate, ql.gst_pct, ql.charges,
              ql.lead_time_days, ql.moq
         FROM tbl_arc_quote q
         JOIN tbl_arc_quote_line ql ON ql.arc_quote_id = q.id
         LEFT JOIN tbl_users u ON u.id = q.vendor_id
        WHERE q.arc_id = $1 AND q.submitted_at IS NOT NULL AND q.withdrawn_at IS NULL
        ORDER BY ql.arc_item_id, ql.rate`,
      [arcId]
    );
  },
};

export default arcEvalModel;
