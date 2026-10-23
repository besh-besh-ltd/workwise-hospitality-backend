// "Who can initiate this draft, and what kind of draft is it?" — the data the
// RFQ lifecycle, the PO detail and the approve-quotes response share.
//
// One implementation of each question so the three surfaces cannot disagree:
//   - getRfqPoCoverage      per PO: how many of the RFQ's products it carries,
//                           how many sit on other live POs, how many nobody has
//   - classifyInitiateKind  complete | split | partial
//   - getPoApprovalInitiators  who actually pressed Initiate (latest instance)
//   - resolveRfqScopeTuple  the RFQ's company x hotel x department x process
//   - buildDraftedPos       the approve-quotes "here is your drafted PO" list
//
// Whether a user may initiate is NEVER decided here: it is
// purchaseOrderModel.canInitiateOnTuple, the same predicate the write gate uses.

import db from "../../config/dbConn.js";
import { canInitiateOnTuple } from "../purchaseOrderModel.js";

// A PO in one of these states no longer holds its products: they are free to be
// awarded again, so they do not count as "covered by another PO".
const DEAD_PO_STATUSES = ["rejected", "cancelled", "rejected_by_vendor"];

/**
 * Per PO of one RFQ, in one statement.
 *
 * @returns {Promise<Map<number, {rfq_product_count:number, po_product_count:number,
 *   products_on_other_pos:number, products_unawarded:number}>>}
 */
export async function getRfqPoCoverage(rfqId, dbCtx = db) {
  const rows = await dbCtx.any(
    `WITH rp AS (
       SELECT id FROM tbl_rfq_products WHERE rfq_id = $1
     ),
     pp AS (
       SELECT po.id AS po_id, po.status::text AS status, pop.rfq_product_id
         FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
         JOIN rp ON rp.id = pop.rfq_product_id
        WHERE po.rfq_id = $1
     )
     SELECT po.id AS po_id,
            (SELECT count(*) FROM rp)::int AS rfq_product_count,
            (SELECT count(DISTINCT p.rfq_product_id) FROM pp p
              WHERE p.po_id = po.id)::int AS po_product_count,
            -- products NOT on this PO that ride on another live PO
            (SELECT count(DISTINCT o.rfq_product_id) FROM pp o
              WHERE o.po_id <> po.id
                AND o.status <> ALL($2::text[])
                AND NOT EXISTS (SELECT 1 FROM pp m
                                 WHERE m.po_id = po.id AND m.rfq_product_id = o.rfq_product_id)
            )::int AS products_on_other_pos
       FROM tbl_rfq_purchase_order po
      WHERE po.rfq_id = $1`,
    [rfqId, DEAD_PO_STATUSES]
  );
  const out = new Map();
  for (const r of rows) {
    const unawarded = Math.max(0, r.rfq_product_count - r.po_product_count - r.products_on_other_pos);
    out.set(Number(r.po_id), {
      rfq_product_count: r.rfq_product_count,
      po_product_count: r.po_product_count,
      products_on_other_pos: r.products_on_other_pos,
      products_unawarded: unawarded,
    });
  }
  return out;
}

/**
 * complete: this PO carries every RFQ product.
 * split:    not complete, but every other product is on another live PO.
 * partial:  otherwise (something is still unawarded).
 * Meaningful for drafts only — callers pass null for anything else.
 */
export function classifyInitiateKind(cov) {
  if (!cov || !(cov.rfq_product_count > 0)) return null;
  if (cov.po_product_count === cov.rfq_product_count) return "complete";
  if (cov.products_unawarded === 0) return "split";
  return "partial";
}

/**
 * The person who actually initiated each PO: the LATEST approval instance
 * (any status), so a PO that was sent back and re-initiated names whoever did
 * it last. A PO never initiated has no entry.
 *
 * @returns {Promise<Map<number, {id:number, name:string|null, at:Date}>>}
 */
export async function getPoApprovalInitiators(poIds, dbCtx = db) {
  const ids = (poIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const out = new Map();
  if (!ids.length) return out;
  const rows = await dbCtx.any(
    `SELECT DISTINCT ON (ai.entity_id)
            ai.entity_id AS po_id, ai.initiated_by AS user_id, u.name, ai.created_at
       FROM tbl_approval_instances ai
       LEFT JOIN tbl_users u ON u.id = ai.initiated_by
      WHERE ai.entity_type = 'PO' AND ai.entity_id = ANY($1::int[])
      ORDER BY ai.entity_id, ai.id DESC`,
    [ids]
  );
  for (const r of rows) {
    // Same null semantics as the lifecycle: no initiator on the instance means null.
    if (r.user_id == null) continue;
    out.set(Number(r.po_id), { id: Number(r.user_id), name: r.name || null, at: r.created_at });
  }
  return out;
}

/** Same tuple resolvePoTenancy derives for an RFQ-backed PO. null if no RFQ. */
export async function resolveRfqScopeTuple(rfqId, dbCtx = db) {
  const id = Number(rfqId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return dbCtx.oneOrNone(
    `SELECT COALESCE(r.hospitality_company_id, hh.hospitality_company_id) AS hospitality_company_id,
            r.hotel_id, r.department_id, r.process_id
       FROM tbl_rfq r
       LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = r.hotel_id
      WHERE r.id = $1`,
    [id]
  );
}

/**
 * can_initiate for the RFQ's tuple. Every PO on an RFQ shares it. `rfqRow`
 * (optional, a tbl_rfq row the caller already holds) saves the tuple read when
 * it carries a company; otherwise the company is re-derived from the hotel.
 */
export async function canInitiateOnRfq(user, rfqId, dbCtx = db, rfqRow = null) {
  if (!user) return false;
  const tuple = rfqRow?.hospitality_company_id
    ? {
        hospitality_company_id: rfqRow.hospitality_company_id,
        hotel_id: rfqRow.hotel_id,
        department_id: rfqRow.department_id,
        process_id: rfqRow.process_id,
      }
    : await resolveRfqScopeTuple(rfqId, dbCtx);
  if (!tuple) return false;
  return canInitiateOnTuple(user, tuple, dbCtx);
}

/**
 * The approve-quotes "drafted PO" list: [{id, po_number, initiate_kind,
 * can_initiate}], in id order. `[]` when nothing was drafted.
 */
export async function buildDraftedPos(user, rfqId, poIds, dbCtx = db) {
  const ids = [...new Set((poIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return [];
  const [pos, coverage, canInitiate] = await Promise.all([
    dbCtx.any(
      `SELECT id, po_number, status::text AS status FROM tbl_rfq_purchase_order
        WHERE id = ANY($1::int[]) ORDER BY id`,
      [ids]
    ),
    getRfqPoCoverage(rfqId, dbCtx),
    canInitiateOnRfq(user, rfqId, dbCtx),
  ]);
  return pos.map((p) => ({
    id: Number(p.id),
    po_number: p.po_number,
    initiate_kind: p.status === "draft" ? classifyInitiateKind(coverage.get(Number(p.id))) : null,
    can_initiate: canInitiate,
  }));
}
