import db from '../../config/dbConn.js';
import { windowClosed } from '../../helper/arcTime.js';

// Advisory-lock namespace (first key of the two-int pg_advisory_xact_lock) used
// to serialize per-ARC vendor-alias assignment. Arbitrary fixed int4, scoped to
// this concern so it can't clash with locks used elsewhere. Second key = arcId.
const ARC_ALIAS_LOCK_NS = 0x41435641; // "ACVA" — fits signed int4

// Sr 54 — fixed technical-evaluation shortlist size (user-confirmed: fixed 5,
// not a per-ARC configurable column).
const TECH_SHORTLIST_SIZE = 5;

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

  // Bulk delete — lets a caller replace an item's whole clause set in one shot
  // (delete-then-reinsert) instead of diffing row-by-row. Used by setupTechEval
  // so a second call for the same arc_item (e.g. GROUP D Save-draft → resume →
  // edit clauses → Save-draft again) REPLACES the clause set rather than
  // accumulating duplicate rows alongside the stale ones.
  clearClauses: async (techEvalId, txContext = null) => {
    return (txContext || db).none(
      `DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE arc_item_tech_evaluation_id = $1`,
      [techEvalId]
    );
  },

  // GROUP D P2 review fix — teardown for an item whose tech-eval was toggled
  // OFF (or retracted) on a later save. Without this, `updateDraft`'s item
  // reconciliation only ever adds/replaces tech-eval config (via setupTechEval
  // called from persistTechEval on the FE); an item that HAD tech-eval
  // configured and is later saved as not requiring it kept its stale
  // tbl_arc_item_tech_evaluation row — still forcing vendors to seal a
  // technical envelope / be tech-scored for that item. clearClauses first
  // (explicit, mirrors the setupTechEval idempotency fix) then the row itself;
  // arc_item_tech_evaluation_clauses is ON DELETE CASCADE from this row anyway,
  // so this is belt-and-suspenders, not load-bearing. No-op if no row exists.
  deleteTechEvalForItem: async (arcItemId, txContext = null) => {
    const runner = txContext || db;
    const te = await runner.oneOrNone(
      `SELECT id FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = $1`,
      [arcItemId]
    );
    if (!te) return null;
    await arcEvalModel.clearClauses(te.id, txContext);
    await runner.none(`DELETE FROM tbl_arc_item_tech_evaluation WHERE id = $1`, [te.id]);
    return te.id;
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

  // Does THIS ARC require a technical envelope at all? (any item has a clause
  // OR the ARC-wide "universal" configurator has a clause). With universal
  // clauses an ARC can require technical even with zero item clauses, so this
  // predicate is item OR universal — every caller (submission-close routing,
  // vendor tech_envelope summary/hard-gate, lifecycle) inherits the change.
  arcHasTechClauses: async (arcId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT 1
         FROM tbl_arc_item i
         JOIN tbl_arc_item_tech_evaluation te ON te.arc_item_id = i.id
         JOIN tbl_arc_item_tech_evaluation_clauses c ON c.arc_item_tech_evaluation_id = te.id
        WHERE i.arc_id = $1
        UNION ALL
        SELECT 1
         FROM tbl_arc_universal_tech_evaluation ute
         JOIN tbl_arc_universal_tech_evaluation_clauses uc ON uc.arc_universal_tech_evaluation_id = ute.id
        WHERE ute.arc_id = $1
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
    // Universal (ARC-wide) knockout — §5.5 belt-and-braces: a vendor who failed
    // the universal clauses is dropped from EVERY clause-bearing item's list
    // here, so the five callers reading this map inherit the knockout. NOTE this
    // alone is NOT sufficient (it omits clause-less items, which never appear in
    // this map) — the explicit per-caller universal exclusion (§5.1–5.4) covers
    // those; both layers are kept.
    const universallyFailed = await arcEvalModel.universallyFailedVendorIds(arcId, runner);
    const map = {};
    rows.forEach((r) => {
      const k = Number(r.item_id);
      if (!map[k]) map[k] = [];
      if (r.vendor_id != null && !universallyFailed.has(Number(r.vendor_id))) map[k].push(Number(r.vendor_id));
    });
    return map;
  },

  // ============================================================
  // Universal (ARC-wide) technical evaluation — parallel to the per-item family
  // above, keyed on arc_id (ONE owner row per ARC). Purely additive: item
  // clauses are untouched. A vendor who FAILS the universal clauses is knocked
  // out of the ENTIRE ARC (see universallyFailedVendorIds — the knockout set).
  // Scoring + mandatory-gate logic are identical to the item family; approval
  // rides the SAME ARC_TECH instance (no separate entity/stage).
  // ============================================================

  // Copy of upsertTechEval, keyed on arc_id.
  upsertUniversalTechEval: async (arcId, { minimum_passing_score = 0, current_round = 1 } = {}, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_universal_tech_evaluation
         (arc_id, minimum_passing_score, current_round)
       VALUES ($1, $2, $3)
       ON CONFLICT (arc_id) DO UPDATE
         SET minimum_passing_score = EXCLUDED.minimum_passing_score,
             current_round         = EXCLUDED.current_round,
             updated_at            = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcId, minimum_passing_score, current_round]
    );
  },

  // Copy of addClause, over universal clauses.
  addUniversalClause: async (univEvalId, clause, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_universal_tech_evaluation_clauses
         (arc_universal_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [univEvalId, clause.clause_text, clause.weightage, clause.clause_type || null,
       clause.is_mandatory === true]
    );
  },

  // Copy of clearClauses — replace-semantics for the universal clause set.
  clearUniversalClauses: async (univEvalId, txContext = null) => {
    return (txContext || db).none(
      `DELETE FROM tbl_arc_universal_tech_evaluation_clauses WHERE arc_universal_tech_evaluation_id = $1`,
      [univEvalId]
    );
  },

  // Copy of deleteTechEvalForItem — teardown when universal is toggled OFF;
  // resolves the owner by arc_id. No-op if no owner exists.
  deleteUniversalTechEval: async (arcId, txContext = null) => {
    const runner = txContext || db;
    const te = await runner.oneOrNone(
      `SELECT id FROM tbl_arc_universal_tech_evaluation WHERE arc_id = $1`,
      [arcId]
    );
    if (!te) return null;
    await arcEvalModel.clearUniversalClauses(te.id, txContext);
    await runner.none(`DELETE FROM tbl_arc_universal_tech_evaluation WHERE id = $1`, [te.id]);
    return te.id;
  },

  // Copy of listClauses, over universal clauses.
  listUniversalClauses: async (univEvalId, txContext = null) => {
    return (txContext || db).any(
      `SELECT * FROM tbl_arc_universal_tech_evaluation_clauses
        WHERE arc_universal_tech_evaluation_id = $1
        ORDER BY id`,
      [univEvalId]
    );
  },

  // Copy of saveVendorTechResponse — vendor writes ONLY vendor_response.
  saveUniversalVendorResponse: async (clauseId, vendorId, vendorResponse, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_universal_tech_evaluation_vendors_response
         (arc_universal_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, $3)
       ON CONFLICT (arc_universal_tech_evaluation_clauses_id, vendor_id) DO UPDATE
         SET vendor_response = EXCLUDED.vendor_response
       RETURNING *`,
      [clauseId, vendorId, vendorResponse ?? null]
    );
  },

  // Copy of ensureVendorResponseRow — ensure a response row so evidence can attach.
  ensureUniversalVendorResponseRow: async (clauseId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_universal_tech_evaluation_vendors_response
         (arc_universal_tech_evaluation_clauses_id, vendor_id)
       VALUES ($1, $2)
       ON CONFLICT (arc_universal_tech_evaluation_clauses_id, vendor_id) DO UPDATE
         SET arc_universal_tech_evaluation_clauses_id = EXCLUDED.arc_universal_tech_evaluation_clauses_id
       RETURNING *`,
      [clauseId, vendorId]
    );
  },

  // Copy of clauseIdsBelongToArc — JOIN universal clauses→owner WHERE owner.arc_id=$1.
  // Callers use it to reject cross-ARC clause ids before writing anything.
  universalClauseIdsBelongToArc: async (arcId, clauseIds, txContext = null) => {
    if (!Array.isArray(clauseIds) || clauseIds.length === 0) return [];
    const rows = await (txContext || db).any(
      `SELECT c.id
         FROM tbl_arc_universal_tech_evaluation_clauses c
         JOIN tbl_arc_universal_tech_evaluation te ON te.id = c.arc_universal_tech_evaluation_id
        WHERE te.arc_id = $1 AND c.id IN ($2:csv)`,
      [arcId, clauseIds.map(Number)]
    );
    return rows.map((r) => Number(r.id));
  },

  // Copy of scoreVendorResponse, over the universal response table.
  scoreUniversalVendorResponse: async (responseId, { buyer_id, buyer_marks, buyer_remark = null, mandatory_passed = undefined }, txContext = null) => {
    if (mandatory_passed === undefined) {
      return (txContext || db).one(
        `UPDATE tbl_arc_universal_tech_evaluation_vendors_response
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
      `UPDATE tbl_arc_universal_tech_evaluation_vendors_response
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

  // Copy of getVendorTechEnvelope — the vendor's own universal draft responses +
  // evidence files. NO item join (universal is ARC-level); clauses carry the
  // owner's minimum_passing_score. NEVER returns buyer_marks / other vendors' rows.
  getVendorUniversalEnvelope: async (arcId, vendorId, txContext = null) => {
    const runner = txContext || db;
    const clauses = await runner.any(
      `SELECT te.minimum_passing_score,
              c.id AS clause_id, c.clause_text, c.clause_type, c.weightage, c.is_mandatory,
              r.id AS response_id, r.vendor_response
         FROM tbl_arc_universal_tech_evaluation te
         JOIN tbl_arc_universal_tech_evaluation_clauses c ON c.arc_universal_tech_evaluation_id = te.id
         LEFT JOIN tbl_arc_universal_tech_evaluation_vendors_response r
                ON r.arc_universal_tech_evaluation_clauses_id = c.id AND r.vendor_id = $2
        WHERE te.arc_id = $1
        ORDER BY c.id`,
      [arcId, vendorId]
    );
    const responseIds = clauses.map((c) => c.response_id).filter((x) => x != null);
    let filesByResponse = {};
    if (responseIds.length > 0) {
      const files = await runner.any(
        `SELECT id AS file_id, arc_universal_tech_evaluation_vendors_response_id AS response_id, file_url, original_name, created_at
           FROM tbl_arc_universal_tech_evaluation_vendors_response_files
          WHERE arc_universal_tech_evaluation_vendors_response_id IN ($1:csv)
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

  // Copy of addVendorResponseFile, over universal response files.
  addUniversalResponseFile: async (responseId, fileUrl, originalName = null, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_universal_tech_evaluation_vendors_response_files
         (arc_universal_tech_evaluation_vendors_response_id, file_url, original_name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [responseId, fileUrl, originalName || null]
    );
  },

  // Copy of listVendorResponseFiles, over universal response files.
  listUniversalResponseFiles: async (responseId, txContext = null) => {
    return (txContext || db).any(
      `SELECT id AS file_id, file_url, created_at
         FROM tbl_arc_universal_tech_evaluation_vendors_response_files
        WHERE arc_universal_tech_evaluation_vendors_response_id = $1
        ORDER BY id`,
      [responseId]
    );
  },

  // Resolve the ARC id that owns a universal response row (join clause→owner).
  // Analog of arcLifecycleModel.getArcIdForResponse for the universal tables —
  // used by the permission middleware + scoreUniversalResponse controller to
  // scope the /universal-tech-eval/score route (no :arcId in the path).
  arcIdForUniversalResponse: async (responseId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT te.arc_id
         FROM tbl_arc_universal_tech_evaluation_vendors_response r
         JOIN tbl_arc_universal_tech_evaluation_clauses c ON c.id = r.arc_universal_tech_evaluation_clauses_id
         JOIN tbl_arc_universal_tech_evaluation te ON te.id = c.arc_universal_tech_evaluation_id
        WHERE r.id = $1`,
      [responseId]
    );
    return row ? Number(row.arc_id) : null;
  },

  // Copy of getResponseFileWithScope — returns file_url, response_id, vendor_id,
  // arc_id so the controller can verify ownership (vendor) or ARC tech permission.
  getUniversalResponseFileWithScope: async (fileId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT f.id AS file_id, f.file_url, f.arc_universal_tech_evaluation_vendors_response_id AS response_id,
              r.vendor_id, te.arc_id
         FROM tbl_arc_universal_tech_evaluation_vendors_response_files f
         JOIN tbl_arc_universal_tech_evaluation_vendors_response r ON r.id = f.arc_universal_tech_evaluation_vendors_response_id
         JOIN tbl_arc_universal_tech_evaluation_clauses c ON c.id = r.arc_universal_tech_evaluation_clauses_id
         JOIN tbl_arc_universal_tech_evaluation te ON te.id = c.arc_universal_tech_evaluation_id
        WHERE f.id = $1`,
      [fileId]
    );
  },

  // Copy of deleteVendorResponseFile — delete ONLY if it's this vendor's file.
  deleteUniversalResponseFile: async (fileId, vendorId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `DELETE FROM tbl_arc_universal_tech_evaluation_vendors_response_files f
         USING tbl_arc_universal_tech_evaluation_vendors_response r
        WHERE f.id = $1
          AND r.id = f.arc_universal_tech_evaluation_vendors_response_id
          AND r.vendor_id = $2
        RETURNING f.id, f.file_url`,
      [fileId, vendorId]
    );
  },

  // Copy of arcHasTechClauses (universal branch only) — does THIS ARC have any
  // universal clauses? Used by the seal counts + submit fold.
  arcHasUniversalTechClauses: async (arcId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT 1
         FROM tbl_arc_universal_tech_evaluation te
         JOIN tbl_arc_universal_tech_evaluation_clauses c ON c.arc_universal_tech_evaluation_id = te.id
        WHERE te.arc_id = $1
        LIMIT 1`,
      [arcId]
    );
    return !!row;
  },

  // Copy of computeItemScores — per-vendor weighted score for the ARC-wide
  // universal clause set. Anchored on the universal owner row for arcId. Same
  // weighted total ÷ SUM(weightage) × 100 ≥ minimum_passing_score, same
  // mandatory hard-gate. Returns [{ vendor_id, calculated_score, qualifies, mandatory_failed }].
  computeUniversalScores: async (arcId, round = 1, txContext = null) => {
    const runner = txContext || db;
    const te = await runner.oneOrNone(
      `SELECT * FROM tbl_arc_universal_tech_evaluation WHERE arc_id = $1`,
      [arcId]
    );
    if (!te) return [];
    return runner.any(
      `WITH totals AS (
         SELECT SUM(weightage)::numeric AS total_weight
           FROM tbl_arc_universal_tech_evaluation_clauses
          WHERE arc_universal_tech_evaluation_id = $1
       ),
       per_vendor AS (
         SELECT r.vendor_id,
                SUM(COALESCE(r.buyer_marks, 0))::numeric AS earned
           FROM tbl_arc_universal_tech_evaluation_vendors_response r
           JOIN tbl_arc_universal_tech_evaluation_clauses c
             ON c.id = r.arc_universal_tech_evaluation_clauses_id
          WHERE c.arc_universal_tech_evaluation_id = $1
          GROUP BY r.vendor_id
       ),
       -- Mandatory gate — clause-driven (a vendor fails if ANY mandatory
       -- universal clause lacks a PASSING response from them), same as
       -- computeItemScores.
       mandatory_fail AS (
         SELECT pv.vendor_id
           FROM per_vendor pv
          WHERE EXISTS (
            SELECT 1
              FROM tbl_arc_universal_tech_evaluation_clauses c
             WHERE c.arc_universal_tech_evaluation_id = $1
               AND c.is_mandatory = TRUE
               AND NOT EXISTS (
                 SELECT 1
                   FROM tbl_arc_universal_tech_evaluation_vendors_response r
                  WHERE r.arc_universal_tech_evaluation_clauses_id = c.id
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

  // Copy of recordClearedVendors — persist the universal pass/fail verdict per
  // vendor per round. ON CONFLICT (univEvalId, vendor_id, round).
  recordUniversalClearedVendors: async (univEvalId, rows, txContext = null) => {
    const runner = txContext || db;
    const inserted = [];
    for (const r of rows) {
      const rejectMessage = r.qualifies
        ? null
        : (r.mandatory_failed ? 'Failed mandatory clause(s)' : null);
      inserted.push(await runner.one(
        `INSERT INTO tbl_arc_universal_tech_evaluation_cleared_vendors
           (arc_universal_tech_evaluation_id, vendor_id, calculated_score, status,
            evaluation_round, created_by, reject_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (arc_universal_tech_evaluation_id, vendor_id, evaluation_round) DO UPDATE
           SET calculated_score = EXCLUDED.calculated_score,
               status           = EXCLUDED.status,
               reject_message   = EXCLUDED.reject_message
         RETURNING *`,
        [univEvalId, r.vendor_id, r.calculated_score,
         r.qualifies ? 'qualified' : 'not_qualified',
         r.evaluation_round || 1, r.created_by || null, rejectMessage]
      ));
    }
    return inserted;
  },

  // Copy of techEnvelopeCounts, over the universal tables — clauses vs answered
  // for the (combined) seal-gate guard.
  universalEnvelopeCounts: async (arcId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `WITH arc_clauses AS (
         SELECT c.id
           FROM tbl_arc_universal_tech_evaluation_clauses c
           JOIN tbl_arc_universal_tech_evaluation te ON te.id = c.arc_universal_tech_evaluation_id
          WHERE te.arc_id = $1
       )
       SELECT (SELECT COUNT(*)::int FROM arc_clauses) AS clauses_total,
              (SELECT COUNT(*)::int
                 FROM tbl_arc_universal_tech_evaluation_vendors_response r
                WHERE r.vendor_id = $2
                  AND r.arc_universal_tech_evaluation_clauses_id IN (SELECT id FROM arc_clauses)
                  AND r.vendor_response IS NOT NULL
                  AND r.vendor_response <> '') AS clauses_answered`,
      [arcId, vendorId]
    );
  },

  // THE KNOCKOUT SET. Vendors whose PERSISTED universal cleared row (written by
  // recordUniversalClearedVendors at submit / amend-approve) at the owner's
  // current_round is 'not_qualified'. One universal eval per ARC ⇒ one row per
  // vendor per round, so this is a simple status filter. Returns an empty Set
  // when no universal owner/clauses exist (no rows) — the primary regression
  // guarantee: a zero-universal ARC behaves exactly as before at every caller.
  universallyFailedVendorIds: async (arcId, txContext = null) => {
    const rows = await (txContext || db).any(
      `SELECT cv.vendor_id
         FROM tbl_arc_universal_tech_evaluation_cleared_vendors cv
         JOIN tbl_arc_universal_tech_evaluation te ON te.id = cv.arc_universal_tech_evaluation_id
        WHERE te.arc_id = $1
          AND cv.evaluation_round = te.current_round
          AND cv.status = 'not_qualified'`,
      [arcId]
    );
    return new Set(rows.map((r) => Number(r.vendor_id)));
  },

  // ============================================================
  // Sr 54 — commercial-ranked technical-evaluation shortlist
  // ============================================================
  //
  // Blind-preserving (OQ1=A): the SYSTEM ranks sealed commercial quotes; the
  // tech evaluator is exposed ONLY to shortlist membership (in_eval vendor
  // aliases) + aggregate counts — never prices, basket totals, rank numbers,
  // or intra-shortlist order. Whole-ARC granularity (OQ2=A): one rank per
  // vendor across their entire basket. Fixed size = 5 (not configurable).

  // Server port of the FE landed-cost preference (CommercialStage.js's
  // engineLanded/landedRate, ~L79-121): engine `line_pricing.total` when
  // present (Phase-2 rows, written on every quote save/submit), else legacy
  // rate + raw charges — the SAME `Number(charges)` coercion the FE fallback
  // carries for pre-Phase-2 rows (documented, rare; not "fixed" here so the
  // shortlist and the eventual L1 award keep agreeing on the same math).
  // `includeCharges` mirrors the FE's default-ON toggle.
  landedUnitPrice: (line, includeCharges = true) => {
    if (!line || line.rate == null) return null;
    const lp = line.line_pricing;
    if (lp && lp.total != null) {
      return includeCharges
        ? Number(lp.total)
        : Number(lp.base || 0) + Number(lp.base_tax || 0);
    }
    const rate = Number(line.rate);
    if (!Number.isFinite(rate)) return null;
    if (!includeCharges) return rate;
    const charges = Number(line.charges);
    return rate + (Number.isFinite(charges) ? charges : 0);
  },

  // Whole-ARC commercial basket total per vendor: SUM(landed-unit-price ×
  // item.indicative_qty) across every sealed quote line the vendor submitted
  // — same definition as the FE's vendorTotal (CommercialStage.js:310-322) so
  // the shortlist and the eventual L1 award agree. Only vendors with a
  // submitted, non-withdrawn commercial quote appear — a vendor who sealed a
  // technical envelope but never submitted a commercial quote is unrankable
  // (OQ5) and is simply absent from the returned list.
  computeVendorBasketTotals: async (arcId, txContext = null) => {
    const rows = await (txContext || db).any(
      `SELECT q.vendor_id, q.submitted_at,
              ql.rate, ql.charges, ql.line_pricing, i.indicative_qty
         FROM tbl_arc_quote q
         JOIN tbl_arc_quote_line ql ON ql.arc_quote_id = q.id
         JOIN tbl_arc_item i ON i.id = ql.arc_item_id
        WHERE q.arc_id = $1 AND q.submitted_at IS NOT NULL AND q.withdrawn_at IS NULL`,
      [arcId]
    );
    const byVendor = new Map();
    for (const r of rows) {
      const vid = Number(r.vendor_id);
      if (!byVendor.has(vid)) {
        byVendor.set(vid, { vendor_id: vid, submitted_at: r.submitted_at, basket_total: 0 });
      }
      const unit = arcEvalModel.landedUnitPrice(r, true);
      if (unit != null) {
        byVendor.get(vid).basket_total += unit * Number(r.indicative_qty || 0);
      }
    }
    return [...byVendor.values()];
  },

  // Rank responding (rankable) vendors ascending by whole-ARC basket total and
  // split top-N ('in_eval') vs the rest ('on_hold'). Deterministic tiebreak at
  // the N/N+1 boundary: earlier commercial submitted_at, then vendor_id (OQ5).
  // ≤ size participants → everyone 'in_eval', none 'on_hold' — CRITICAL
  // backward-compat: existing low-vendor ARCs/tests are unaffected.
  //
  // Idempotent + promotion-safe: re-running (lazy backstop, repeated calls)
  // never demotes a vendor already 'in_eval'/'promoted' back to 'on_hold' —
  // the ON CONFLICT clause keeps the stored status once it's active, only
  // refreshing rank/basket_total (both system-only, never surfaced to the
  // evaluator).
  computeAndStoreShortlist: async (arcId, { size = TECH_SHORTLIST_SIZE } = {}, txContext = null) => {
    const runner = txContext || db;
    const totals = await arcEvalModel.computeVendorBasketTotals(arcId, runner);
    totals.sort((a, b) => {
      if (a.basket_total !== b.basket_total) return a.basket_total - b.basket_total;
      const at = a.submitted_at ? new Date(a.submitted_at).getTime() : Infinity;
      const bt = b.submitted_at ? new Date(b.submitted_at).getTime() : Infinity;
      if (at !== bt) return at - bt;
      return a.vendor_id - b.vendor_id;
    });
    for (let i = 0; i < totals.length; i++) {
      const v = totals[i];
      const rank = i + 1;
      const status = rank <= size ? 'in_eval' : 'on_hold';
      await runner.none(
        `INSERT INTO tbl_arc_tech_shortlist (arc_id, vendor_id, commercial_rank, basket_total, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (arc_id, vendor_id) DO UPDATE
           SET commercial_rank = EXCLUDED.commercial_rank,
               basket_total    = EXCLUDED.basket_total,
               updated_at      = CURRENT_TIMESTAMP,
               status = CASE WHEN tbl_arc_tech_shortlist.status IN ('in_eval', 'promoted')
                              THEN tbl_arc_tech_shortlist.status
                              ELSE EXCLUDED.status END`,
        [arcId, v.vendor_id, rank, v.basket_total, status]
      );
    }
    return arcEvalModel.getShortlist(arcId, runner);
  },

  // Compute-if-missing backstop for callers that can't guarantee the
  // submission-close hook already ran (manual-entry ARCs, the lifecycle lazy
  // flip path). A no-op re-read once rows exist for the ARC.
  ensureShortlist: async (arcId, opts = {}, txContext = null) => {
    const runner = txContext || db;
    const existing = await runner.any(`SELECT 1 FROM tbl_arc_tech_shortlist WHERE arc_id = $1 LIMIT 1`, [arcId]);
    if (existing.length > 0) return arcEvalModel.getShortlist(arcId, runner);
    return arcEvalModel.computeAndStoreShortlist(arcId, opts, runner);
  },

  getShortlist: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT * FROM tbl_arc_tech_shortlist WHERE arc_id = $1 ORDER BY commercial_rank ASC`,
      [arcId]
    );
  },

  // Membership + counts ONLY — never rank/basket_total (blind-preserving,
  // OQ1=A). "in evaluation" = status IN ('in_eval','promoted').
  shortlistCounts: (rows) => {
    const on_hold = rows.filter((r) => r.status === 'on_hold').length;
    const in_evaluation = rows.length - on_hold;
    return { total_participating: rows.length, in_evaluation, on_hold };
  },

  shortlistVendorIds: (rows) => new Set(
    rows.filter((r) => r.status !== 'on_hold').map((r) => Number(r.vendor_id))
  ),

  // Vendors whose PERSISTED per-item cleared-vendor rows (the record written
  // by recordClearedVendors at submit / amend-approve — NOT the live/
  // provisional computeItemScores a still-scoring evaluator sees) show
  // 'not_qualified' on every item they were judged for, and 'qualified' on
  // none — i.e. failed technical evaluation outright for the ARC.
  arcLevelDisqualifiedVendorIds: async (arcId, txContext = null) => {
    const rows = await (txContext || db).any(
      `WITH cv AS (
         SELECT cv.vendor_id, cv.status
           FROM tbl_arc_item_tech_evaluation_cleared_vendors cv
           JOIN tbl_arc_item_tech_evaluation te ON te.id = cv.arc_item_tech_evaluation_id
           JOIN tbl_arc_item i ON i.id = te.arc_item_id
          WHERE i.arc_id = $1 AND cv.evaluation_round = te.current_round
       )
       SELECT vendor_id
         FROM cv
        GROUP BY vendor_id
       HAVING COUNT(*) FILTER (WHERE status = 'qualified') = 0
          AND COUNT(*) FILTER (WHERE status = 'not_qualified') > 0`,
      [arcId]
    );
    return new Set(rows.map((r) => Number(r.vendor_id)));
  },

  // Take the lowest-rank 'on_hold' vendor and mark it 'promoted' (now
  // scorable). Returns null when no held vendor remains.
  promoteNextHeld: async (arcId, { userId = null } = {}, txContext = null) => {
    const runner = txContext || db;
    const held = await runner.oneOrNone(
      `SELECT * FROM tbl_arc_tech_shortlist
        WHERE arc_id = $1 AND status = 'on_hold'
        ORDER BY commercial_rank ASC
        LIMIT 1
        FOR UPDATE`,
      [arcId]
    );
    if (!held) return null;
    return runner.one(
      `UPDATE tbl_arc_tech_shortlist
          SET status = 'promoted', promoted_at = CURRENT_TIMESTAMP, promoted_by = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *`,
      [held.id, userId]
    );
  },

  // Automatic promotion (Sr 54, OQ4=Automatic): reconciles the number of
  // 'promoted' vendors against the number of currently in-eval vendors
  // ('in_eval' or already 'promoted') that have ended up ARC-level
  // not-qualified. Idempotent / recompute-safe — calling it again with no new
  // failures promotes nobody a second time; a second distinct failure (or a
  // promoted vendor who also later fails) opens exactly one more seat.
  // MUST be called inside the same tx that just persisted cleared-vendor rows
  // (submitTechEval; decideTechEval's amend-then-approve path).
  reconcileShortlistPromotions: async (arcId, { userId = null } = {}, txContext = null) => {
    const runner = txContext || db;
    // §5.6 / OQ4 — the disqualified set is item-level ARC failures UNION the
    // universal (ARC-wide) knockout set (both at their current round). A
    // universally-failed in_eval vendor opens a seat so the next held vendor is
    // promoted, exactly as an item-level ARC failure does. Both sets are fresh
    // because item + universal cleared rows are written in the same submit tx.
    const itemDisqualified = await arcEvalModel.arcLevelDisqualifiedVendorIds(arcId, runner);
    const universallyFailed = await arcEvalModel.universallyFailedVendorIds(arcId, runner);
    const disqualified = new Set([...itemDisqualified, ...universallyFailed]);
    if (disqualified.size === 0) return [];
    const shortlist = await arcEvalModel.getShortlist(arcId, runner);
    const activeDisqualifiedCount = shortlist.filter(
      (r) => r.status !== 'on_hold' && disqualified.has(Number(r.vendor_id))
    ).length;
    const alreadyPromoted = shortlist.filter((r) => r.status === 'promoted').length;
    const needed = activeDisqualifiedCount - alreadyPromoted;
    const promotions = [];
    for (let i = 0; i < needed; i++) {
      const promoted = await arcEvalModel.promoteNextHeld(arcId, { userId }, runner);
      if (!promoted) break; // ran out of held vendors
      promotions.push(promoted);
    }
    return promotions;
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
  // Sr 36 — stored wall-clock must be IST (naive column), matching every other
  // ARC window timestamp (submission_start_at, etc.), NOT the DB session's raw
  // CURRENT_TIMESTAMP (UTC on prod) — otherwise the vendor sees an acceptance
  // time ~5.5h off. `updated_at` stays on CURRENT_TIMESTAMP (not read as IST).
  acceptTerms: async (arcId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, terms_accepted_at)
       VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Kolkata'))
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET terms_accepted_at = COALESCE(tbl_arc_quote.terms_accepted_at, (NOW() AT TIME ZONE 'Asia/Kolkata')),
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
    // Header convenience column (MRP quoting) — quote-wide method, mirrored
    // from the per-line pricing_method for reload + reporting. Defaults to
    // 'TRADITIONAL' when the caller doesn't pass it.
    const pricingMethod = fields.pricing_method === 'MRP' ? 'MRP' : 'TRADITIONAL';
    if (hasQuotePricing) {
      return (txContext || db).one(
        `INSERT INTO tbl_arc_quote
           (arc_id, vendor_id, payment_terms, gstin_used, quote_pricing, pricing_method)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (arc_id, vendor_id) DO UPDATE
           SET payment_terms = EXCLUDED.payment_terms,
               gstin_used    = EXCLUDED.gstin_used,
               quote_pricing = EXCLUDED.quote_pricing,
               pricing_method = EXCLUDED.pricing_method,
               updated_at    = CURRENT_TIMESTAMP
         RETURNING *`,
        [arcId, vendorId, fields.payment_terms || null, fields.gstin_used || null,
         JSON.stringify(fields.quote_pricing), pricingMethod]
      );
    }
    return (txContext || db).one(
      `INSERT INTO tbl_arc_quote
         (arc_id, vendor_id, payment_terms, gstin_used, pricing_method)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET payment_terms = EXCLUDED.payment_terms,
             gstin_used    = EXCLUDED.gstin_used,
             pricing_method = EXCLUDED.pricing_method,
             updated_at    = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcId, vendorId, fields.payment_terms || null, fields.gstin_used || null, pricingMethod]
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
    // MRP quoting — per-line method + raw audit inputs. Coerce blanks to null
    // so the numeric(15,2) columns never receive an empty string; default
    // pricing_method to 'TRADITIONAL' when absent.
    const pricingMethod = line.pricing_method === 'MRP' ? 'MRP' : 'TRADITIONAL';
    const numOrNull = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
    const enteredMrp = numOrNull(line.entered_mrp);
    const mrpDiscount = numOrNull(line.mrp_discount);
    const mrpDiscountMode = line.mrp_discount_mode || null;
    // Phase 2 — line_pricing JSONB (engine output per line) stored alongside charges.
    // Present on save/submit (engine-computed by controller); absent on legacy rows.
    const hasLinePricing = line.line_pricing !== undefined;
    if (hasLinePricing) {
      return runner.one(
        `INSERT INTO tbl_arc_quote_line
           (arc_quote_id, arc_item_id, rate, gst_pct, charges, lead_time_days, moq, validity_notes, line_pricing,
            pricing_method, entered_mrp, mrp_discount, mrp_discount_mode)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
         ON CONFLICT (arc_quote_id, arc_item_id) DO UPDATE
           SET rate               = EXCLUDED.rate,
               gst_pct            = EXCLUDED.gst_pct,
               charges            = EXCLUDED.charges,
               lead_time_days     = EXCLUDED.lead_time_days,
               moq                = EXCLUDED.moq,
               validity_notes     = EXCLUDED.validity_notes,
               line_pricing       = EXCLUDED.line_pricing,
               pricing_method     = EXCLUDED.pricing_method,
               entered_mrp        = EXCLUDED.entered_mrp,
               mrp_discount       = EXCLUDED.mrp_discount,
               mrp_discount_mode  = EXCLUDED.mrp_discount_mode,
               updated_at         = CURRENT_TIMESTAMP
         RETURNING *`,
        [arcQuoteId, line.arc_item_id, line.rate ?? null, line.gst_pct ?? null,
         JSON.stringify(line.charges || []),
         line.lead_time_days ?? null, line.moq ?? null, line.validity_notes ?? null,
         JSON.stringify(line.line_pricing),
         pricingMethod, enteredMrp, mrpDiscount, mrpDiscountMode]
      );
    }
    return runner.one(
      `INSERT INTO tbl_arc_quote_line
         (arc_quote_id, arc_item_id, rate, gst_pct, charges, lead_time_days, moq, validity_notes,
          pricing_method, entered_mrp, mrp_discount, mrp_discount_mode)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (arc_quote_id, arc_item_id) DO UPDATE
         SET rate               = EXCLUDED.rate,
             gst_pct            = EXCLUDED.gst_pct,
             charges            = EXCLUDED.charges,
             lead_time_days     = EXCLUDED.lead_time_days,
             moq                = EXCLUDED.moq,
             validity_notes     = EXCLUDED.validity_notes,
             pricing_method     = EXCLUDED.pricing_method,
             entered_mrp        = EXCLUDED.entered_mrp,
             mrp_discount       = EXCLUDED.mrp_discount,
             mrp_discount_mode  = EXCLUDED.mrp_discount_mode,
             updated_at         = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcQuoteId, line.arc_item_id, line.rate ?? null, line.gst_pct ?? null,
       JSON.stringify(line.charges || []),
       line.lead_time_days ?? null, line.moq ?? null, line.validity_notes ?? null,
       pricingMethod, enteredMrp, mrpDiscount, mrpDiscountMode]
    );
  },

  listQuoteLines: async (arcQuoteId, txContext = null) => {
    return (txContext || db).any(
      `SELECT * FROM tbl_arc_quote_line WHERE arc_quote_id = $1 ORDER BY arc_item_id`,
      [arcQuoteId]
    );
  },

  /** Returns all quote lines for a given ARC, joined with vendor + item info.
   *  Includes rate_source + negotiated_round_id so the commercial matrix can
   *  tag NEGOTIATED rates (DECISION-1). ORDER BY ql.rate is unchanged so
   *  L-rank reflects the (possibly negotiated) live rate automatically.
   *  Also LEFT JOINs the latest round_quote previous_price so the matrix can
   *  show "was ₹X → now ₹Y" provenance on NEGOTIATED lines.
   */
  listAllQuotesForArc: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT q.id AS quote_id, q.vendor_id, u.name AS vendor_name, q.submitted_at,
              ql.id AS quote_line_id, ql.arc_item_id, ql.rate, ql.gst_pct, ql.charges,
              ql.lead_time_days, ql.moq,
              ql.line_pricing,
              ql.rate_source,
              ql.negotiated_round_id,
              prev.previous_price AS pre_negotiation_rate
         FROM tbl_arc_quote q
         JOIN tbl_arc_quote_line ql ON ql.arc_quote_id = q.id
         LEFT JOIN tbl_users u ON u.id = q.vendor_id
         -- Latest round-quote row for this line to surface before/after rates
         LEFT JOIN LATERAL (
           SELECT nrq.previous_price
             FROM tbl_negotiation_round_quotes nrq
            WHERE nrq.negotiation_round_id = ql.negotiated_round_id
              AND nrq.vendor_id = q.vendor_id
              AND nrq.arc_item_id = ql.arc_item_id
            ORDER BY nrq.id DESC
            LIMIT 1
         ) prev ON ql.rate_source = 'NEGOTIATED'
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
      !windowClosed(arc);

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
