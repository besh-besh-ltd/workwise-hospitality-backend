// Vendor Networks HQ dashboard reads (spec §8). Every function is scoped by an org id
// the controller took from req.user.network, and answers in a bounded number of queries.
//
// "PO entities" of an org: every ACTIVE, SUSPENDED or REMOVED entity row of the org
// (the principal is one), so a removed entity keeps its PO history on the dashboard.

import db from "../config/dbConn.js";
import { effectiveSupplierExpr } from "../services/vendorNetwork/fulfilmentSql.js";

const PO_ENTITY_STATUSES = ["ACTIVE", "SUSPENDED", "REMOVED"];
// Statuses after which a PO needs no further action.
const CLOSED_PO_STATUSES = ["draft", "rejected", "rejected_by_vendor", "cancelled", "completed"];

const poEntityIds = `SELECT vendor_id FROM tbl_vendor_org_entities WHERE org_id = $1 AND status = ANY($2::text[])`;

/** True when `vendorId` is a PO entity of the org (any of ACTIVE, SUSPENDED, REMOVED). */
export async function isPoEntity(orgId, vendorId, runner = db) {
  const row = await runner.oneOrNone(
    `SELECT 1 AS ok FROM tbl_vendor_org_entities WHERE org_id = $1 AND vendor_id = $2 AND status = ANY($3::text[]) LIMIT 1`,
    [orgId, vendorId, PO_ENTITY_STATUSES]
  );
  return !!row;
}

/** Live (PENDING / ACCEPTED) assignment count per assignee, as a Map. */
export async function liveAssignmentCounts(orgId, runner = db) {
  const rows = await runner.any(
    `SELECT assigned_vendor_id, COUNT(*)::int AS n
       FROM tbl_vendor_routing_assignments
      WHERE org_id = $1 AND status IN ('PENDING', 'ACCEPTED')
      GROUP BY assigned_vendor_id`,
    [orgId]
  );
  return new Map(rows.map((r) => [Number(r.assigned_vendor_id), r.n]));
}

/** Open (not closed) PO count per entity vendor, as a Map. */
export async function openPoCounts(orgId, runner = db) {
  const rows = await runner.any(
    `SELECT po.finalized_vendor_id, COUNT(*)::int AS n
       FROM tbl_rfq_purchase_order po
      WHERE po.finalized_vendor_id IN (${poEntityIds}) AND po.status::text <> ALL($3::text[])
      GROUP BY po.finalized_vendor_id`,
    [orgId, PO_ENTITY_STATUSES, CLOSED_PO_STATUSES]
  );
  return new Map(rows.map((r) => [Number(r.finalized_vendor_id), r.n]));
}

/** { pending, declined_7d, timed_out_7d } of the org's routing assignments, one query. */
export function routingCounts(orgId, since, runner = db) {
  return runner.one(
    `SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'DECLINED' AND COALESCE(acted_at, created_at) >= $2)::int AS declined_7d,
            COUNT(*) FILTER (WHERE status = 'TIMED_OUT' AND COALESCE(acted_at, created_at) >= $2)::int AS timed_out_7d
       FROM tbl_vendor_routing_assignments
      WHERE org_id = $1`,
    [orgId, since]
  );
}

/** PO count per status across the org's PO entities. */
export async function poCountsByStatus(orgId, runner = db) {
  const rows = await runner.any(
    `SELECT po.status::text AS status, COUNT(*)::int AS n
       FROM tbl_rfq_purchase_order po
      WHERE po.finalized_vendor_id IN (${poEntityIds})
      GROUP BY po.status`,
    [orgId, PO_ENTITY_STATUSES]
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** One page of the org's POs (newest first), optionally of one entity / one status. */
export async function listPos(orgId, { entityVendorId = null, status = null, limit, offset }, runner = db) {
  const where = `po.finalized_vendor_id IN (${poEntityIds})
        AND ($3::int IS NULL OR po.finalized_vendor_id = $3)
        AND ($4::text IS NULL OR po.status::text = $4)`;
  const params = [orgId, PO_ENTITY_STATUSES, entityVendorId, status];
  const [{ n }, rows] = await Promise.all([
    runner.one(`SELECT COUNT(*)::int AS n FROM tbl_rfq_purchase_order po WHERE ${where}`, params),
    runner.any(
      `SELECT po.id, po.po_number, po.status::text AS status, po.total_value AS amount, po.created_at,
              po.is_call_off, po.finalized_vendor_id AS entity_vendor_id, u.name AS entity_name,
              COALESCE(h.name, ah.name) AS hotel_name
         FROM tbl_rfq_purchase_order po
         JOIN tbl_users u ON u.id = po.finalized_vendor_id
         LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = rfq.hotel_id
         LEFT JOIN tbl_arc_contract acon ON acon.id = po.arc_contract_id
         LEFT JOIN tbl_arc arc ON arc.id = acon.arc_id
         LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
         LEFT JOIN tbl_hospitality_company_hotels ah ON ah.id = COALESCE(mr.hotel_id, arc.hotel_id)
        WHERE ${where}
        ORDER BY po.created_at DESC, po.id DESC
        LIMIT $5 OFFSET $6`,
      [...params, limit, offset]
    ),
  ]);
  return { total: n, rows };
}

/** One page of the principal's ARC contracts (newest first). */
export async function listPrincipalContracts(principalVendorId, { limit, offset }, runner = db) {
  const [{ n }, rows] = await Promise.all([
    runner.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_contract WHERE vendor_id = $1`, [principalVendorId]),
    runner.any(
      `SELECT c.id, c.status, c.arc_id, a.arc_number, a.title, a.is_group
         FROM tbl_arc_contract c
         JOIN tbl_arc a ON a.id = c.arc_id
        WHERE c.vendor_id = $1
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $2 OFFSET $3`,
      [principalVendorId, limit, offset]
    ),
  ]);
  return { total: n, rows };
}

/**
 * Per (contract, hotel) fulfilment of the given contracts. The supplier is
 * effectiveSupplierExpr (the one definition call-off release and the MR picker use), so
 * the dashboard cannot disagree with routing. assignment_status is the org's live
 * ARC_HOTEL assignment for that hotel, else its latest one, else null.
 */
export function listContractHotelFulfilment(orgId, contractIds, runner = db) {
  if (!contractIds.length) return Promise.resolve([]);
  return runner.any(
    `SELECT x.contract_id, x.hotel_id, h.name AS hotel_name,
            x.supplier_id AS fulfilling_vendor_id, su.name AS fulfilling_name,
            asg.status AS assignment_status
       FROM (
         SELECT DISTINCT ON (c.id, clh.hotel_id)
                c.id AS contract_id, clh.hotel_id,
                ${effectiveSupplierExpr("clh.fulfilling_vendor_id", "c.vendor_id")} AS supplier_id
           FROM tbl_arc_contract c
           JOIN tbl_arc_contract_line l ON l.arc_contract_id = c.id
           JOIN tbl_arc_contract_line_hotel clh ON clh.arc_contract_line_id = l.id
          WHERE c.id = ANY($2::bigint[])
          ORDER BY c.id, clh.hotel_id, clh.id
       ) x
       JOIN tbl_hospitality_company_hotels h ON h.id = x.hotel_id
       JOIN tbl_users su ON su.id = x.supplier_id
       LEFT JOIN LATERAL (
         SELECT status FROM tbl_vendor_routing_assignments a
          WHERE a.org_id = $1 AND a.subject_type = 'ARC_HOTEL'
            AND a.subject_id = x.contract_id AND a.hotel_id = x.hotel_id
          ORDER BY (a.status IN ('PENDING', 'ACCEPTED')) DESC, a.id DESC
          LIMIT 1
       ) asg ON true
      ORDER BY x.contract_id, x.hotel_id`,
    [orgId, contractIds]
  );
}

export default {
  isPoEntity,
  liveAssignmentCounts,
  openPoCounts,
  routingCounts,
  poCountsByStatus,
  listPos,
  listPrincipalContracts,
  listContractHotelFulfilment,
};
