import db from '../../config/dbConn.js';

// Advisory-lock namespace (first key of the two-int pg_advisory_xact_lock) used
// to serialize per-ARC vendor-alias assignment. Arbitrary fixed int4, scoped to
// this concern so it can't clash with locks used elsewhere. Second key = arcId.
const ARC_ALIAS_LOCK_NS = 0x41435641; // "ACVA" — fits signed int4

// Phase 2 — back-compat normalizer for ARC quote line charges.
// Pre-Phase-2 rows stored charges as a single number (the freight value) or as
// a legacy { value, type } object. Post-Phase-2 they are canonical engine charge
// arrays. On read, any row that doesn't carry an array is normalised to one.
// Exported so controllers and the preview endpoint can share it.
export function normalizeArcCharges(rawCharges) {
  if (Array.isArray(rawCharges)) return rawCharges; // already canonical
  if (rawCharges === null || rawCharges === undefined || rawCharges === '') return [];
  const n = Number(rawCharges);
  if (Number.isFinite(n) && n > 0) {
    // Legacy: single numeric freight value stored directly.
    return [{ name: 'Freight', amount: n, amount_mode: 'absolute', tax: null }];
  }
  if (typeof rawCharges === 'object' && rawCharges !== null) {
    // Legacy: { value, type:'pct'|'absolute' } shape used by lineFreight().
    const v = Number(rawCharges.value || 0);
    if (v > 0) {
      const mode = rawCharges.type === 'pct' ? 'percentage' : 'absolute';
      return [{ name: 'Freight', amount: v, amount_mode: mode, tax: null }];
    }
  }
  return [];
}

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
        `SELECT id AS file_id, arc_item_tech_evaluation_vendors_response_id AS response_id, file_url, original_name, created_at
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
  addVendorResponseFile: async (responseId, fileUrl, originalName = null, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response_files
         (arc_item_tech_evaluation_vendors_response_id, file_url, original_name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [responseId, fileUrl, originalName || null]
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
  // Blind technical evaluation — per-ARC vendor aliases
  // ============================================================

  // Pure base-26 BIJECTIVE label: 0→"Vendor A", 1→"Vendor B", … 25→"Vendor Z",
  // 26→"Vendor AA", 27→"Vendor AB", … Never derived from the real vendor name;
  // the only input is the small non-identity alias_index.
  aliasLabel: (index) => {
    let n = Number(index);
    if (!Number.isFinite(n) || n < 0) n = 0;
    let s = '';
    n += 1; // shift to 1-based for bijective base-26
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return `Vendor ${s}`;
  },

  /**
   * Lazy, idempotent, race-safe alias assignment for an ARC. Returns
   *   Map<vendor_id(Number), { alias_index, alias_label }>
   * covering EVERY technically-participating vendor (those with a tech response
   * row OR a sealed tech envelope). Safe to call on every tech read.
   *
   * Assignment order for vendors lacking an alias: tech-envelope first-submission
   * time ASC (NULLS LAST), then vendor_id ASC as a deterministic tiebreak — NOT
   * vendor_id ascending overall, so the alias does not trivially reverse to a
   * real identity. New indices continue from MAX(alias_index)+1 so a vendor that
   * appears in a later round keeps existing letters intact (round-safe).
   */
  getOrAssignAliases: async (arcId, txContext = null) => {
    const buildMap = (rows) => {
      const map = new Map();
      for (const r of rows) {
        const idx = Number(r.alias_index);
        map.set(Number(r.vendor_id), { alias_index: idx, alias_label: arcEvalModel.aliasLabel(idx) });
      }
      return map;
    };

    // The read-compute-insert section, serialized per ARC by a transaction-
    // scoped advisory lock. WHY the lock (M1): the ON CONFLICT(arc_id,vendor_id)
    // guard below only catches a SAME-vendor double-insert — it does NOT catch
    // two DIFFERENT new vendors arriving concurrently and both computing the
    // same nextIndex, which would collide on UNIQUE(arc_id, alias_index) and
    // raise a unique-violation (transient 500). pg_advisory_xact_lock makes the
    // first assigner finish (and commit its indices) before the second reads,
    // so indices never collide. The lock auto-releases at commit.
    const run = async (t) => {
      // .one — SELECT pg_advisory_xact_lock(...) returns exactly one (void) row.
      await t.one('SELECT pg_advisory_xact_lock($1, $2)', [ARC_ALIAS_LOCK_NS, Number(arcId)]);

      // 1. Existing aliases (after acquiring the lock, so we see a prior
      //    assigner's committed rows).
      let existing = await t.any(
        `SELECT vendor_id, alias_index FROM tbl_arc_vendor_alias WHERE arc_id = $1`,
        [arcId]
      );
      const have = new Set(existing.map((r) => Number(r.vendor_id)));

      // 2. Tech-participating vendors lacking an alias: DISTINCT vendor_ids with
      //    a response row (clauses→te→item→arc) UNION those with a sealed tech
      //    envelope on tbl_arc_quote. Carry tech_submitted_at for ordering.
      const pending = await t.any(
        `WITH participants AS (
           SELECT DISTINCT r.vendor_id
             FROM tbl_arc_item_tech_evaluation_vendors_response r
             JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
             JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
             JOIN tbl_arc_item i ON i.id = te.arc_item_id
            WHERE i.arc_id = $1
           UNION
           SELECT DISTINCT q.vendor_id
             FROM tbl_arc_quote q
            WHERE q.arc_id = $1 AND q.tech_submitted_at IS NOT NULL
         )
         SELECT p.vendor_id, q.tech_submitted_at
           FROM participants p
           LEFT JOIN tbl_arc_quote q ON q.arc_id = $1 AND q.vendor_id = p.vendor_id
          ORDER BY q.tech_submitted_at ASC NULLS LAST, p.vendor_id ASC`,
        [arcId]
      );
      const toAssign = pending.filter((r) => !have.has(Number(r.vendor_id)));

      // 3/4. Assign sequential indices from the current max. The lock guarantees
      //      we're the only assigner, so the index sequence can't collide.
      if (toAssign.length > 0) {
        let nextIndex = existing.reduce((mx, r) => Math.max(mx, Number(r.alias_index) + 1), 0);
        for (const row of toAssign) {
          await t.none(
            `INSERT INTO tbl_arc_vendor_alias (arc_id, vendor_id, alias_index)
             VALUES ($1, $2, $3)
             ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
            [arcId, Number(row.vendor_id), nextIndex]
          );
          nextIndex += 1;
        }
        existing = await t.any(
          `SELECT vendor_id, alias_index FROM tbl_arc_vendor_alias WHERE arc_id = $1`,
          [arcId]
        );
      }

      return buildMap(existing);
    };

    // Advisory xact locks must run inside a transaction to be transaction-
    // scoped. When the caller already supplies a tx, reuse it; otherwise open a
    // short transaction just for the critical section.
    return txContext ? run(txContext) : db.tx(run);
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

  // Phase 1 §3 — persist T&C acceptance (idempotent: COALESCE keeps first timestamp).
  acceptTerms: async (arcId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, terms_accepted_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET terms_accepted_at = COALESCE(tbl_arc_quote.terms_accepted_at, CURRENT_TIMESTAMP),
             updated_at        = CURRENT_TIMESTAMP
       RETURNING terms_accepted_at`,
      [arcId, vendorId]
    );
  },

  // Phase 1 §B — count clauses vs answered for the seal-gate guard.
  // Extracted from getRequestDetail so the seal endpoint can reuse it.
  techEnvelopeCounts: async (arcId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `WITH arc_clauses AS (
         SELECT c.id
           FROM tbl_arc_item_tech_evaluation_clauses c
           JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
           JOIN tbl_arc_item i ON i.id = te.arc_item_id
          WHERE i.arc_id = $1
       )
       SELECT (SELECT COUNT(*)::int FROM arc_clauses) AS clauses_total,
              (SELECT COUNT(*)::int
                 FROM tbl_arc_item_tech_evaluation_vendors_response r
                WHERE r.vendor_id = $2
                  AND r.arc_item_tech_evaluation_clauses_id IN (SELECT id FROM arc_clauses)
                  AND r.vendor_response IS NOT NULL
                  AND r.vendor_response <> '') AS clauses_answered`,
      [arcId, vendorId]
    );
  },

  upsertQuote: async (arcId, vendorId, fields, txContext = null) => {
    // Phase 2 — quote_pricing JSONB (engine document totals) stored on submit.
    // If the caller provides quote_pricing, persist it; otherwise leave the
    // existing column untouched (COALESCE keeps the last stored value).
    const hasQuotePricing = fields.quote_pricing !== undefined;
    if (hasQuotePricing) {
      return (txContext || db).one(
        `INSERT INTO tbl_arc_quote
           (arc_id, vendor_id, payment_terms, gstin_used, quote_pricing)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (arc_id, vendor_id) DO UPDATE
           SET payment_terms = EXCLUDED.payment_terms,
               gstin_used    = EXCLUDED.gstin_used,
               quote_pricing = EXCLUDED.quote_pricing,
               updated_at    = CURRENT_TIMESTAMP
         RETURNING *`,
        [arcId, vendorId, fields.payment_terms || null, fields.gstin_used || null,
         JSON.stringify(fields.quote_pricing)]
      );
    }
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
      `UPDATE tbl_arc_quote SET submitted_at = CURRENT_TIMESTAMP, withdrawn_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
       RETURNING *`,
      [arcQuoteId]
    );
  },

  // Archive an immutable snapshot of ONE submission into tbl_arc_quote_version.
  // version_no = (count of existing versions for this arc_quote_id) + 1, computed
  // inside the caller's transaction so concurrent re-submits can't collide on a
  // number (the submit path already serializes per arc×vendor on the unique row).
  // `lines` is a JSON array [{arc_item_id, rate, gst_pct, charges, line_pricing}];
  // `quotePricing` is the engine document-totals object. Together they make the
  // version a COMPLETE record of what was submitted.
  archiveQuoteVersion: async ({ arcQuoteId, arcId, vendorId, quotePricing, lines }, txContext = null) => {
    const runner = txContext || db;
    const { version_no } = await runner.one(
      `SELECT COUNT(*)::int + 1 AS version_no
         FROM tbl_arc_quote_version WHERE arc_quote_id = $1`,
      [arcQuoteId]
    );
    return runner.one(
      `INSERT INTO tbl_arc_quote_version
         (arc_quote_id, arc_id, vendor_id, version_no, quote_pricing, lines, submitted_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
       RETURNING *`,
      [arcQuoteId, arcId, vendorId, version_no,
       JSON.stringify(quotePricing || {}), JSON.stringify(lines || [])]
    );
  },

  // Vendor-isolated version history for one ARC, newest-first. Returns a compact
  // shape for the "Past quotes" panel — never another vendor's rows (the WHERE
  // vendor_id filter is the isolation boundary; callers pass req.user.id).
  listQuoteVersions: async (arcId, vendorId, txContext = null) => {
    return (txContext || db).any(
      `SELECT version_no,
              submitted_at,
              quote_pricing->>'grand_total'                      AS grand_total,
              jsonb_array_length(COALESCE(lines, '[]'::jsonb))   AS line_count
         FROM tbl_arc_quote_version
        WHERE arc_id = $1 AND vendor_id = $2
        ORDER BY version_no DESC`,
      [arcId, vendorId]
    );
  },

  upsertQuoteLine: async (arcQuoteId, line, txContext = null) => {
    const runner = txContext || db;
    // Phase 2 — line_pricing JSONB (engine output per line) stored alongside charges.
    // Present on save/submit (engine-computed by controller); absent on legacy rows.
    const hasLinePricing = line.line_pricing !== undefined;
    if (hasLinePricing) {
      return runner.one(
        `INSERT INTO tbl_arc_quote_line
           (arc_quote_id, arc_item_id, rate, gst_pct, charges, lead_time_days, moq, validity_notes, line_pricing)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)
         ON CONFLICT (arc_quote_id, arc_item_id) DO UPDATE
           SET rate           = EXCLUDED.rate,
               gst_pct        = EXCLUDED.gst_pct,
               charges        = EXCLUDED.charges,
               lead_time_days = EXCLUDED.lead_time_days,
               moq            = EXCLUDED.moq,
               validity_notes = EXCLUDED.validity_notes,
               line_pricing   = EXCLUDED.line_pricing,
               updated_at     = CURRENT_TIMESTAMP
         RETURNING *`,
        [arcQuoteId, line.arc_item_id, line.rate ?? null, line.gst_pct ?? null,
         JSON.stringify(line.charges || []),
         line.lead_time_days ?? null, line.moq ?? null, line.validity_notes ?? null,
         JSON.stringify(line.line_pricing)]
      );
    }
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
              ql.lead_time_days, ql.moq,
              ql.line_pricing
         FROM tbl_arc_quote q
         JOIN tbl_arc_quote_line ql ON ql.arc_quote_id = q.id
         LEFT JOIN tbl_users u ON u.id = q.vendor_id
        WHERE q.arc_id = $1 AND q.submitted_at IS NOT NULL AND q.withdrawn_at IS NULL
        ORDER BY ql.arc_item_id, ql.rate`,
      [arcId]
    );
  },

  // ── Vendor lifecycle projection ──────────────────────────────────────────
  // Returns a vendor-safe lifecycle view. Strips all buyer-internal counts
  // (vendors_in_play, vendors_fully_scored, items_allocated, approval objects)
  // and other-vendor data. Computes default_stage from the vendor's own facts.
  projectVendorLifecycle: async (lifecycle, arcId, vendorId) => {
    const { arc, current_status } = lifecycle;

    // Gather vendor-specific facts (all vendor-scoped).
    const quote = await arcEvalModel.getQuote(arcId, vendorId);
    const hasTechClauses = await arcEvalModel.arcHasTechClauses(arcId);
    const vendorContract = await db.oneOrNone(
      `SELECT status FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, vendorId]
    );

    const windowOpen =
      arc.status === 'floated' &&
      arc.submission_end_at &&
      new Date(arc.submission_end_at) > new Date();

    // Phase 1 §3 — T&C gate derived from persisted timestamp.
    const termsAccepted = !!quote?.terms_accepted_at;

    const techSealed = !!quote?.tech_submitted_at;
    // Withdrawn wins over submitted: a vendor who submitted then withdrew should be
    // treated as withdrawn (actionable / can re-quote), NOT as "quote submitted".
    const quoteWithdrawn = !!quote?.withdrawn_at;
    const quoteSubmitted = !!quote?.submitted_at && !quote?.withdrawn_at;

    // Vendor labels for each stage key.
    const VENDOR_LABELS = {
      overview:   'Tender & terms',
      technical:  'Technical envelope',
      commercial: 'Your quote',
      awarding:   'Award & sign',
      active:     'Active contract',
    };

    const stages = lifecycle.stages.map((s) => {
      // Derive vendor_action and vendor-framed state/reason.
      let vendor_action = 'none';
      let vendorState = s.state;
      let vendorReason = s.reason;

      if (s.key === 'overview') {
        if (termsAccepted) {
          vendorState = 'complete';
          vendorReason = 'terms_accepted';
        } else if (windowOpen) {
          vendorState = 'active';
          vendorReason = 'awaiting_terms';
          vendor_action = 'accept_terms';
        } else {
          vendorReason = 'window_closed';
        }
      }

      if (s.key === 'technical') {
        if (s.state === 'skipped' || !hasTechClauses) {
          vendorState = 'skipped';
          vendorReason = 'no_tech_required';
        } else if (!termsAccepted) {
          // Phase 1 §3 — tech is locked until terms accepted.
          vendorState = 'locked';
          vendorReason = 'terms_required';
        } else if (techSealed) {
          vendorState = 'complete';
          vendorReason = 'envelope_sealed';
        } else if (windowOpen) {
          vendorState = 'active';
          vendorReason = 'awaiting_response';
          vendor_action = 'submit_tech';
        } else {
          vendorState = 'complete';
          vendorReason = 'window_closed';
        }
      }

      if (s.key === 'commercial') {
        if (!termsAccepted) {
          // Phase 1 §3 — commercial locked until terms accepted.
          vendorState = 'locked';
          vendorReason = 'terms_required';
        } else if (hasTechClauses && !techSealed) {
          vendorState = 'locked';
          vendorReason = 'tech_required';
        } else if (quoteSubmitted) {
          vendorState = 'complete';
          vendorReason = 'quote_submitted';
        } else if (quoteWithdrawn && windowOpen) {
          vendorState = 'active';
          vendorReason = 'withdrawn_reopen';
          vendor_action = 'submit_quote';
        } else if (windowOpen) {
          vendorState = 'active';
          vendorReason = 'window_open';
          vendor_action = 'submit_quote';
        } else {
          // Window closed and no quote submitted — locked/past for this vendor.
          vendorState = 'locked';
          vendorReason = 'no_quote_submitted';
        }
      }

      if (s.key === 'awarding') {
        const vc = vendorContract?.status;
        if (vc && ['generated', 'awaiting_acceptance'].includes(vc)) {
          vendorState = 'active';
          vendorReason = 'awaiting_sign';
          vendor_action = 'sign_contract';
        } else if (vc && ['active', 'expiring_soon', 'expired', 'terminated', 'declined'].includes(vc)) {
          vendorState = 'complete';
          vendorReason = vc;
        } else if (['complete', 'active'].includes(s.state) && !vendorContract) {
          // ARC moved past committee with no contract for this vendor → not awarded.
          vendorState = 'complete';
          vendorReason = 'not_awarded';
        } else {
          vendorState = 'locked';
          vendorReason = 'awaiting_decision';
        }
      }

      if (s.key === 'active') {
        const vc = vendorContract?.status;
        if (vc && ['active', 'expiring_soon'].includes(vc)) {
          vendorState = 'active';
          vendorReason = 'live';
        } else if (vc && ['expired', 'terminated', 'declined'].includes(vc)) {
          vendorState = 'ended';
          vendorReason = vc;
        } else {
          vendorState = 'locked';
          vendorReason = 'not_active';
        }
      }

      // Strip all buyer-internal fields; return only vendor-safe subset.
      return {
        key: s.key,
        label: VENDOR_LABELS[s.key] || s.label,
        state: vendorState,
        reason: vendorReason,
        vendor_action,
        // Vendor-visible window facts for overview + T&C acceptance.
        ...(s.key === 'overview'
          ? { window: s.window, terms_accepted_at: quote?.terms_accepted_at || null }
          : {}),
        // Vendor-visible tech facts (no scoring data).
        ...(s.key === 'technical' ? { tech_submitted_at: quote?.tech_submitted_at || null } : {}),
        // Vendor-visible commercial facts (no allocation data).
        ...(s.key === 'commercial'
          ? { submitted_at: quote?.submitted_at || null, withdrawn_at: quote?.withdrawn_at || null }
          : {}),
      };
    });

    // Compute vendor default_stage from the vendor's own facts.
    // Phase 1 §3 — overview-first: until terms accepted, always land on overview.
    let default_stage = 'overview';
    const contractStatus = vendorContract?.status;
    if (contractStatus && ['generated', 'awaiting_acceptance'].includes(contractStatus)) {
      default_stage = 'awarding';
    } else if (contractStatus && ['active', 'expiring_soon'].includes(contractStatus)) {
      default_stage = 'active';
    } else if (!termsAccepted) {
      default_stage = 'overview';
    } else if (hasTechClauses && !techSealed) {
      default_stage = 'technical';
    } else if (windowOpen || quoteSubmitted) {
      default_stage = 'commercial';
    }

    return {
      arc: {
        id: arc.id,
        arc_number: arc.arc_number,
        title: arc.title,
        status: current_status,
        category_title: arc.category_title,
        hotel_name: arc.hotel_name,
        hotel_code: arc.hotel_code,
        submission_start_at: arc.submission_start_at,
        submission_end_at: arc.submission_end_at,
        contract_start_at: arc.contract_start_at,
        contract_end_at: arc.contract_end_at,
      },
      current_status,
      default_stage,
      stages,
    };
  },
};

export default arcEvalModel;
