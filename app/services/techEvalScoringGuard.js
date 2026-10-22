/**
 * Who may write to an open technical evaluation, and when.
 *
 * /rfq/update-buyer-marks and /rfq/tech-evaluation-cleared-vendors used to sit
 * behind passportSignIn alone: any signed-in user — a vendor, a buyer of
 * another company — could write marks or a verdict on any clause by id.
 *
 * Both endpoints now resolve the evaluation server-side and ask this module.
 * The caller supplies only the record to locate (a clause or an evaluation
 * id) and a vendor id; the RFQ, hotel and company come from the database and
 * the caller's scope from req.user.
 *
 * Refusals are returned as { httpStatus, code, message } (never thrown) so the
 * controller answers in one place. A scope failure is the one exception: it
 * throws AuthorizationError, which sendScopeError already renders as 403.
 */
import db from '../config/dbConn.js';
import { assertCanReadParentRfq } from './authorizationService.js';
import { techRecoverableSql, eligibleUnscoredResponderSql } from '../models/techEvalStuck.js';

const refusal = (httpStatus, code, message) => ({ httpStatus, code, message });

/**
 * @param {object} p
 * @param {number} p.userId     req.user.id
 * @param {number} p.vendorId   vendor being scored / given a verdict
 * @param {number} [p.clauseId] locate the evaluation through this clause
 * @param {number} [p.techEvalId] …or directly
 * @param {'any'|'approved'} [p.verdictLock] which verdicts freeze a vendor.
 *   'any'      (default, the cleared-vendors endpoint): one verdict per vendor,
 *              whichever way it was written.
 *   'approved' (the marks endpoint): only a verdict written by an APPROVED
 *              round (approval_instance_id set). A legacy "Technically
 *              Accepted" click (approval_instance_id NULL) or the leftovers of
 *              a rejected round must not stop the evaluator correcting marks.
 * @returns {Promise<{ok:true, techEval:object, clause:object|null}|{ok:false, httpStatus:number, code:string, message:string}>}
 */
export async function checkTechEvalWritable({ userId, vendorId, clauseId = null, techEvalId = null, verdictLock = 'any' }) {
  const row = await db.oneOrNone(
    `SELECT te.id, te.rfq_id, te.tbl_rfq_product_id, te.is_complete,
            c.id AS clause_id, c.weightage, c.clause_type,
            ${techRecoverableSql({ te: 'te' })} AS recoverable,
            ${eligibleUnscoredResponderSql({ te: 'te', vendor: 'vv.vendor_id' })} AS vendor_eligible_unscored,
            EXISTS (
              SELECT 1
                FROM tbl_rfq_product_tech_evaluation_vendors_response _vr
                JOIN tbl_rfq_product_tech_evaluation_clauses _vc
                  ON _vc.id = _vr.tbl_rfq_product_tech_evaluation_clauses_id
               WHERE _vc.tbl_rfq_product_tech_evaluation_id = te.id
                 AND _vr.vendor_id = vv.vendor_id
            ) AS vendor_has_response,
            -- Sampling rows are minted by the buyer's first score, so a vendor
            -- can be a genuine participant with no response row at all. The
            -- roster getTechEvalStatusByProductId shows is tbl_rfq_product_vendors
            -- for this line (active vendor users); mirror it.
            (c.clause_type = 'sampling' AND EXISTS (
              SELECT 1
                FROM tbl_rfq_product_vendors _rpv
                JOIN tbl_rfq_products _rp ON _rp.id = te.tbl_rfq_product_id
                JOIN tbl_users _tu ON _tu.id = _rpv.user_id
               WHERE _rpv.rfq_id = te.rfq_id
                 AND _rpv.user_id = vv.vendor_id
                 AND _rpv.product_variant_id = _rp.product_variant_id
                 AND COALESCE(_rpv.variant, 0) = COALESCE(_rp.variant, 0)
                 AND _tu.status = 1
            )) AS vendor_on_roster,
            EXISTS (
              SELECT 1 FROM tbl_tech_evaluation_rounds r
               WHERE r.tbl_rfq_product_tech_evaluation_id = te.id
                 AND r.status IN ('PENDING', 'SUBMITTED')
            ) AS round_pending,
            EXISTS (
              SELECT 1 FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
               WHERE cv.tbl_rfq_product_tech_evaluation_id = te.id
                 AND cv.vendor_id = vv.vendor_id
            ) AS vendor_has_verdict,
            EXISTS (
              SELECT 1 FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
               WHERE cv.tbl_rfq_product_tech_evaluation_id = te.id
                 AND cv.vendor_id = vv.vendor_id
                 AND cv.approval_instance_id IS NOT NULL
            ) AS vendor_has_approved_verdict
       FROM (SELECT $3::int AS vendor_id) vv,
            tbl_rfq_product_tech_evaluation te
       LEFT JOIN tbl_rfq_product_tech_evaluation_clauses c
         ON c.tbl_rfq_product_tech_evaluation_id = te.id AND c.id = $2::int
      WHERE ${clauseId
        ? `te.id = (SELECT tbl_rfq_product_tech_evaluation_id
                      FROM tbl_rfq_product_tech_evaluation_clauses WHERE id = $2::int)`
        : `te.id = $1::int`}`,
    [techEvalId, clauseId, vendorId]
  );

  if (!row) {
    return {
      ok: false,
      ...refusal(404, 'TECH_EVAL_NOT_FOUND', 'Technical evaluation not found.'),
    };
  }

  // Throws AuthorizationError (403) for a caller with no rfq.read scope on
  // this RFQ's hotel/department/process — another company's buyer included.
  await assertCanReadParentRfq(userId, row.rfq_id);

  if (!(row.vendor_has_response || row.vendor_on_roster)) {
    return {
      ok: false,
      ...refusal(400, 'VENDOR_NOT_IN_EVALUATION', 'This vendor has not answered this technical evaluation.'),
    };
  }

  // A complete evaluation is locked — except the legacy shape that the submit
  // path itself reopens (blocked, nobody passed, locked as complete, a vendor
  // waiting): the buyer must be able to score THAT vendor before submitting.
  if (row.is_complete && !(row.recoverable && row.vendor_eligible_unscored)) {
    return {
      ok: false,
      ...refusal(409, 'TECH_EVAL_ALREADY_COMPLETE', 'Technical evaluation is complete and can no longer be changed.'),
    };
  }
  if (row.round_pending) {
    return {
      ok: false,
      ...refusal(409, 'TECH_EVAL_ROUND_PENDING', 'A round of this technical evaluation is awaiting approval.'),
    };
  }
  if (verdictLock === 'approved' ? row.vendor_has_approved_verdict : row.vendor_has_verdict) {
    return {
      ok: false,
      ...refusal(409, 'TECH_EVAL_VENDOR_ALREADY_DECIDED', 'This vendor already has a technical verdict on this evaluation.'),
    };
  }

  return { ok: true, techEval: row, clause: row.clause_id ? row : null };
}

export default { checkTechEvalWritable };
