// Tech-eval scoring factory. Seeds the chain of rows that
// `getVendorScoresForTechEval` joins through, so a vendor is "fully evaluated"
// (every clause scored) and either PASSES or FAILS by total weighted marks.
//
// The "fully evaluated" predicate the production query uses is
// `score_timestamp != timestamp` (SET on score update by the buyer-marks
// endpoint). Our INSERTs use `score_timestamp = NOW() + INTERVAL '1 second'`
// to make the two timestamps distinct.

import { db } from "../setup/db.js";

/**
 * Insert a vendor on `tbl_rfq_product_vendors` for the given (rfq, product
 * variant). Required for the score query's RPV join to populate vendor info.
 */
export async function attachVendorToRfqProduct({ rfq_id, product_variant_id, variant = 0, vendor_id }) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, $4)`,
    [rfq_id, product_variant_id, vendor_id, variant]
  );
}

/**
 * Insert a tech-eval row + N clauses with the given weightages.
 * Returns { eval_id, clause_ids: [...] }.
 */
export async function seedTechEvalWithClauses({ rfq_id, rfq_product_id, weightages, minimum_passing_score = 50 }) {
  const evalRow = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation
       (rfq_id, tbl_rfq_product_id, minimum_passing_score)
     VALUES ($1, $2, $3) RETURNING id`,
    [rfq_id, rfq_product_id, minimum_passing_score]
  );
  const clauseIds = [];
  for (const w of weightages) {
    const c = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
         (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, $2, $3, 'clause') RETURNING id`,
      [evalRow.id, `Clause weighing ${w}`, w]
    );
    clauseIds.push(c.id);
  }
  return { eval_id: evalRow.id, clause_ids: clauseIds };
}

/**
 * Insert a vendor response per clause. `marksByClause` is a map from
 * clauseId → buyer_marks. The score_timestamp is set distinct from `timestamp`
 * so the production query treats this vendor as "fully evaluated".
 *
 * Returns the array of inserted response ids.
 */
export async function recordVendorScores({ vendor_id, marksByClause, buyer_id }) {
  const ids = [];
  for (const [clauseIdStr, marks] of Object.entries(marksByClause)) {
    const r = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
         (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response,
          buyer_id, buyer_marks, score_timestamp, "timestamp")
       VALUES ($1, $2, 'OK', $3, $4, NOW() + INTERVAL '1 second', NOW())
       RETURNING id`,
      [parseInt(clauseIdStr, 10), vendor_id, buyer_id, marks]
    );
    ids.push(r.id);
  }
  return ids;
}

/**
 * One-shot helper: full chain — attaches vendor, seeds tech-eval+clauses (or
 * uses provided eval), records scored responses. Returns { eval_id,
 * clause_ids, response_ids }.
 *
 * Pass `existingEval` to add a vendor to a tech-eval that already exists.
 */
export async function setupScoredVendor({
  rfq_id, rfq_product_id, product_variant_id, variant = 0, vendor_id, buyer_id,
  weightages, marksPerClause, minimum_passing_score = 50, existingEval = null,
}) {
  await attachVendorToRfqProduct({ rfq_id, product_variant_id, variant, vendor_id });
  const evalShape = existingEval || await seedTechEvalWithClauses({
    rfq_id, rfq_product_id, weightages, minimum_passing_score,
  });
  // marksPerClause is a number applied uniformly OR an array matching weightages.
  const marksArr = Array.isArray(marksPerClause)
    ? marksPerClause
    : evalShape.clause_ids.map(() => marksPerClause);
  const marksByClause = Object.fromEntries(
    evalShape.clause_ids.map((id, i) => [id, marksArr[i]])
  );
  const response_ids = await recordVendorScores({ vendor_id, marksByClause, buyer_id });
  return { ...evalShape, response_ids };
}
