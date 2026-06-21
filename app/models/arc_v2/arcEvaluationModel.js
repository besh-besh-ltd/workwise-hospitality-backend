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
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [techEvalId, clause.clause_text, clause.weightage, clause.clause_type || null,
       clause.is_mandatory === true]
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

  // NOTE: the buyer-records-vendor-response path was REMOVED (RESOLVED DECISION
  // 2 — two-envelope flow). Vendors now self-author their responses via
  // `saveVendorTechResponse`; the buyer ONLY scores via `scoreVendorResponse`.

  // mandatory_passed: pass an explicit boolean / null to set the per-clause
  // mandatory verdict; omit (undefined) to leave the existing value untouched.
  scoreVendorResponse: async (responseId, { buyer_id, buyer_marks, buyer_remark = null, mandatory_passed = undefined }, txContext = null) => {
    if (mandatory_passed === undefined) {
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
    }
    return (txContext || db).one(
      `UPDATE tbl_arc_item_tech_evaluation_vendors_response
         SET buyer_id         = $2,
             buyer_marks      = $3,
             buyer_remark     = $4,
             mandatory_passed = $5,
             score_timestamp  = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [responseId, buyer_id, buyer_marks, buyer_remark, mandatory_passed]
    );
  },

  // ── Vendor-authored technical envelope (two-envelope flow) ──────────────
  // Vendor writes ONLY vendor_response (idempotent upsert keyed by the table's
  // UNIQUE(clause_id, vendor_id)). Never touches buyer_marks / mandatory_passed.
  saveVendorTechResponse: async (clauseId, vendorId, vendorResponse, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, $3)
       ON CONFLICT (arc_item_tech_evaluation_clauses_id, vendor_id) DO UPDATE
         SET vendor_response = EXCLUDED.vendor_response
       RETURNING *`,
      [clauseId, vendorId, vendorResponse ?? null]
    );
  },

  // Ensure a response row exists for (clause, vendor) so evidence files can
  // attach to it. Returns the row; does NOT clobber an existing vendor_response.
  ensureVendorResponseRow: async (clauseId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id)
       VALUES ($1, $2)
       ON CONFLICT (arc_item_tech_evaluation_clauses_id, vendor_id) DO UPDATE
         SET arc_item_tech_evaluation_clauses_id = EXCLUDED.arc_item_tech_evaluation_clauses_id
       RETURNING *`,
      [clauseId, vendorId]
    );
  },

  // Subset of `clauseIds` that genuinely belong to the given ARC. Callers use
  // it to reject cross-ARC clause ids before writing anything.
  clauseIdsBelongToArc: async (arcId, clauseIds, txContext = null) => {
    if (!Array.isArray(clauseIds) || clauseIds.length === 0) return [];
    const rows = await (txContext || db).any(
      `SELECT c.id
         FROM tbl_arc_item_tech_evaluation_clauses c
         JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
         JOIN tbl_arc_item i ON i.id = te.arc_item_id
        WHERE i.arc_id = $1 AND c.id IN ($2:csv)`,
      [arcId, clauseIds.map(Number)]
    );
    return rows.map((r) => Number(r.id));
  },

  // The vendor's own draft responses + evidence files for one ARC, grouped per
  // item × clause. NEVER returns buyer_marks / mandatory_passed / other vendors'
  // rows — vendor isolation is enforced by the WHERE r.vendor_id filter.
  getVendorTechEnvelope: async (arcId, vendorId, txContext = null) => {
    const runner = txContext || db;
    const clauses = await runner.any(
      `SELECT i.id AS arc_item_id, te.minimum_passing_score,
              c.id AS clause_id, c.clause_text, c.clause_type, c.weightage, c.is_mandatory,
              r.id AS response_id, r.vendor_response
         FROM tbl_arc_item i
         JOIN tbl_arc_item_tech_evaluation te ON te.arc_item_id = i.id
         JOIN tbl_arc_item_tech_evaluation_clauses c ON c.arc_item_tech_evaluation_id = te.id
         LEFT JOIN tbl_arc_item_tech_evaluation_vendors_response r
                ON r.arc_item_tech_evaluation_clauses_id = c.id AND r.vendor_id = $2
        WHERE i.arc_id = $1
        ORDER BY i.id, c.id`,
      [arcId, vendorId]
    );
    const responseIds = clauses.map((c) => c.response_id).filter((x) => x != null);
    let filesByResponse = {};
    if (responseIds.length > 0) {
      const files = await runner.any(
        `SELECT id AS file_id, arc_item_tech_evaluation_vendors_response_id AS response_id, file_url, created_at
           FROM tbl_arc_item_tech_evaluation_vendors_response_files
          WHERE arc_item_tech_evaluation_vendors_response_id IN ($1:csv)
          ORDER BY id`,
        [responseIds]
      );
      filesByResponse = files.reduce((acc, f) => {
        const k = Number(f.response_id);
        (acc[k] = acc[k] || []).push(f);
        return acc;
      }, {});
    }
    return { clauses, filesByResponse };
  },

  // ── Vendor evidence files (multiple per clause allowed) ─────────────────
  addVendorResponseFile: async (responseId, fileUrl, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response_files
         (arc_item_tech_evaluation_vendors_response_id, file_url)
       VALUES ($1, $2)
       RETURNING *`,
      [responseId, fileUrl]
    );
  },

  listVendorResponseFiles: async (responseId, txContext = null) => {
    return (txContext || db).any(
      `SELECT id AS file_id, file_url, created_at
         FROM tbl_arc_item_tech_evaluation_vendors_response_files
        WHERE arc_item_tech_evaluation_vendors_response_id = $1
        ORDER BY id`,
      [responseId]
    );
  },

  // Ownership-checked fetch of a single evidence file: returns the file with
  // its owning vendor_id + arc_id so the controller can verify the caller owns
  // it (vendor) or holds the ARC tech permission (evaluator) before serving.
  getResponseFileWithScope: async (fileId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT f.id AS file_id, f.file_url, f.arc_item_tech_evaluation_vendors_response_id AS response_id,
              r.vendor_id, i.arc_id
         FROM tbl_arc_item_tech_evaluation_vendors_response_files f
         JOIN tbl_arc_item_tech_evaluation_vendors_response r ON r.id = f.arc_item_tech_evaluation_vendors_response_id
         JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
         JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
         JOIN tbl_arc_item i ON i.id = te.arc_item_id
        WHERE f.id = $1`,
      [fileId]
    );
  },

  // Delete an evidence file ONLY if it belongs to (response of) this vendor.
  // Returns the deleted row or null when it isn't the vendor's file.
  deleteVendorResponseFile: async (fileId, vendorId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `DELETE FROM tbl_arc_item_tech_evaluation_vendors_response_files f
         USING tbl_arc_item_tech_evaluation_vendors_response r
        WHERE f.id = $1
          AND r.id = f.arc_item_tech_evaluation_vendors_response_id
          AND r.vendor_id = $2
        RETURNING f.id, f.file_url`,
      [fileId, vendorId]
    );
  },

  // ── Technical-envelope seal (rides tbl_arc_quote, one row per arc×vendor) ──
  getQuote: async (arcId, vendorId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT * FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, vendorId]
    );
  },

  // Seal the technical envelope. Idempotent: only stamps if not already sealed.
  sealTechEnvelope: async (arcId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, tech_submitted_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET tech_submitted_at = COALESCE(tbl_arc_quote.tech_submitted_at, CURRENT_TIMESTAMP),
             updated_at        = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcId, vendorId]
    );
  },

  // Does THIS ARC require a technical envelope at all? (any item has a clause)
  arcHasTechClauses: async (arcId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT 1
         FROM tbl_arc_item i
         JOIN tbl_arc_item_tech_evaluation te ON te.arc_item_id = i.id
         JOIN tbl_arc_item_tech_evaluation_clauses c ON c.arc_item_tech_evaluation_id = te.id
        WHERE i.arc_id = $1
        LIMIT 1`,
      [arcId]
    );
    return !!row;
  },

  /**
   * Compute per-vendor calculated_score for an item.
   * Returns: [{ vendor_id, calculated_score, qualifies, mandatory_failed }]
   *
   * Mandatory gate (RESOLVED DECISION 3): a mandatory clause counts toward the
   * weighted total AND acts as a hard gate. A vendor with a passing weighted
   * score is STILL not_qualified if ANY mandatory clause for the item is failed
   * (mandatory_passed = FALSE) OR not-yet-judged (mandatory_passed IS NULL).
   * `mandatory_failed` is surfaced so the UI / cleared_vendors can explain why a
   * vendor with a passing weighted score is not_qualified.
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
       ),
       -- Vendors who fail the mandatory gate. CLAUSE-DRIVEN (not response-
       -- driven): a vendor fails if ANY mandatory clause for the item lacks a
       -- PASSING response from them — which covers a FALSE verdict, a NULL
       -- (not-yet-judged) verdict, AND no response row at all (a vendor who
       -- skipped the mandatory clause but accrued marks elsewhere must NOT slip
       -- through on a diluted weighted score). Anchored to per_vendor so only
       -- vendors actually in play are considered.
       mandatory_fail AS (
         SELECT pv.vendor_id
           FROM per_vendor pv
          WHERE EXISTS (
            SELECT 1
              FROM tbl_arc_item_tech_evaluation_clauses c
             WHERE c.arc_item_tech_evaluation_id = $1
               AND c.is_mandatory = TRUE
               AND NOT EXISTS (
                 SELECT 1
                   FROM tbl_arc_item_tech_evaluation_vendors_response r
                  WHERE r.arc_item_tech_evaluation_clauses_id = c.id
                    AND r.vendor_id = pv.vendor_id
                    AND r.mandatory_passed = TRUE
               )
          )
       )
       SELECT pv.vendor_id,
              CASE WHEN t.total_weight IS NULL OR t.total_weight = 0
                   THEN 0::numeric
                   ELSE ROUND((pv.earned / t.total_weight) * 100, 2)
              END AS calculated_score,
              (pv.vendor_id IN (SELECT vendor_id FROM mandatory_fail)) AS mandatory_failed,
              CASE WHEN t.total_weight IS NULL OR t.total_weight = 0
                   THEN FALSE
                   WHEN pv.vendor_id IN (SELECT vendor_id FROM mandatory_fail)
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
      // Explain a non-qualification that's driven by the mandatory gate rather
      // than a low weighted score (audit trail + UI hint).
      const rejectMessage = r.qualifies
        ? null
        : (r.mandatory_failed ? 'Failed mandatory clause(s)' : null);
      inserted.push(await runner.one(
        `INSERT INTO tbl_arc_item_tech_evaluation_cleared_vendors
           (arc_item_tech_evaluation_id, vendor_id, calculated_score, status,
            evaluation_round, created_by, reject_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (arc_item_tech_evaluation_id, vendor_id, evaluation_round) DO UPDATE
           SET calculated_score = EXCLUDED.calculated_score,
               status           = EXCLUDED.status,
               reject_message   = EXCLUDED.reject_message
         RETURNING *`,
        [techEvalId, r.vendor_id, r.calculated_score,
         r.qualifies ? 'qualified' : 'not_qualified',
         r.evaluation_round || 1, r.created_by || null, rejectMessage]
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
