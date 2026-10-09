// The ARC_HOTEL routing subject (Vendor Networks spec §6.4, §10.9): Group ARC per-hotel
// fulfilment.
//
// Subject = (org, 'ARC_HOTEL', contract id, hotel id). The org's principal is the contract
// vendor. Accepting an assignment makes the member entity the supplier of that hotel:
// tbl_arc_contract_line_hotel.fulfilling_vendor_id = member on every line of the contract
// for the hotel, so call-offs released from then on (callOffPoService.releaseForMr reads
// COALESCE(clh.fulfilling_vendor_id, c.vendor_id)) are issued to the member. POs already
// released keep their vendor.
//
//   onAccepted   re-validates the contract, writes fulfilling_vendor_id = assignee, and
//                (after commit) tells the ARC creator, that hotel's requisition staff and
//                the principal (CONTRACT_FULFILMENT_ASSIGNED).
//   onReleased   SUPERSEDED: nothing; the new row's onAccepted overwrites the column in
//                the same transaction. A never-accepted row (DECLINED / TIMED_OUT /
//                REVOKED from PENDING): nothing. REVOKED from ACCEPTED (admin revoke or an
//                ENTITY_* release): fulfilling_vendor_id back to NULL (the principal
//                fulfils) and the buyer side is told. Never throws on a missing contract,
//                line or hotel (placeholder subjects revoke cleanly).
//
// LOCK ORDER. Engine transition: subject lock (950601) → the org's assignment rows FOR
// UPDATE → entity FOR SHARE → [hook] tbl_arc_contract_line_hotel rows of (contract, hotel)
// FOR UPDATE ORDER BY id → UPDATE of those rows. tbl_arc_contract / tbl_arc /
// tbl_arc_contract_line are only plain-read, never locked.
// Call-off paths (callOffPoService.releaseForMr / handleCallOffRejection) lock the MR
// hotel's line_hotel rows FOR UPDATE ORDER BY id FIRST, then tbl_arc_contract_line rows.
// Both sides take line_hotel rows in ascending id order and the engine never locks
// contract lines, so they cannot deadlock; a release waiting on an accept re-reads the
// committed fulfilling_vendor_id once the lock is granted.
// Sweep reconcile (self-heal of NULL rows under an ACCEPTED assignment): line_hotel rows
// FOR UPDATE in id order, then one UPDATE; it takes no engine lock.

import db from "../../../config/dbConn.js";
import { logger } from "../../../util/logger.js";
import { registerSubject, afterCommit } from "../routingEngine.js";
import { NetworkHttpError } from "../guards.js";
import { getOrgById } from "../../../models/vendorNetworkModel.js";
import { notifyArcEvent } from "../../arcNotificationService.js";
import { ARC_EVENT_TYPES } from "../../arcEventLogService.js";
import { arcVendorContract } from "../../notificationLinks.js";
import { ASSIGNMENT_STATUS, SUBJECT_TYPE } from "../../../constants/vendorNetwork.js";

const { ACCEPTED, SUPERSEDED } = ASSIGNMENT_STATUS;
/** Contract statuses whose hotels may be routed (signing is not blocked by routing). */
export const ROUTABLE_CONTRACT_STATUSES = Object.freeze([
  "awaiting_acceptance",
  "clarification",
  "active",
  "expiring_soon",
]);
const UNROUTED_LIMIT = 500;

const refuse = (http, message, code) => ({ ok: false, http, message, code });

// --- SQL ------------------------------------------------------------------------------

/** The contract, its ARC and the hotel's ledger rows on it (count / all paused). */
function getContractForHotel(contractId, hotelId, runner) {
  return runner.oneOrNone(
    `SELECT c.id, c.status, c.vendor_id, c.arc_id, a.category_id, a.arc_number, a.title,
            COALESCE(a.is_group, false) AS is_group, h.hotel_rows, h.all_suspended
       FROM tbl_arc_contract c
       JOIN tbl_arc a ON a.id = c.arc_id
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS hotel_rows, COALESCE(bool_and(clh.is_suspended), false) AS all_suspended
           FROM tbl_arc_contract_line_hotel clh
           JOIN tbl_arc_contract_line l ON l.id = clh.arc_contract_line_id
          WHERE l.arc_contract_id = c.id AND clh.hotel_id = $2
       ) h
      WHERE c.id = $1`,
    [contractId, hotelId]
  );
}

/** Locks the (contract, hotel) ledger rows in id order; returns their ids. */
async function lockHotelRows(t, contractId, hotelId) {
  const rows = await t.any(
    `SELECT clh.id
       FROM tbl_arc_contract_line_hotel clh
       JOIN tbl_arc_contract_line l ON l.id = clh.arc_contract_line_id
      WHERE l.arc_contract_id = $1 AND clh.hotel_id = $2
      ORDER BY clh.id
        FOR UPDATE OF clh`,
    [contractId, hotelId]
  );
  return rows.map((r) => r.id);
}

/**
 * Who a buyer should deal with for vendor `vendorId`: company name, GSTIN and a contact
 * (the entity's first ACTIVE ENTITY_MEMBER person of the org by name, else the entity
 * login). The email is ALWAYS the entity login's: this goes to every buyer of the hotel,
 * and a network person's own address is never disclosed to buyers (audit L3).
 */
async function supplierCard(orgId, vendorId, runner) {
  return runner.oneOrNone(
    `SELECT u.id, COALESCE(NULLIF(TRIM(co.company_name), ''), u.name) AS entity_name, co.gstin,
            COALESCE(p.name, u.name) AS contact_name, u.email AS contact_email
       FROM tbl_users u
       LEFT JOIN tbl_company co ON co.id = u.company_id
       LEFT JOIN LATERAL (
         SELECT pu.name
           FROM tbl_vendor_org_members m
           JOIN tbl_users pu ON pu.id = m.person_user_id
          WHERE m.org_id = $1 AND m.entity_vendor_id = u.id
            AND m.role = 'ENTITY_MEMBER' AND m.status = 'ACTIVE'
          ORDER BY m.id
          LIMIT 1
       ) p ON true
      WHERE u.id = $2`,
    [orgId, vendorId]
  );
}

/** Queues CONTRACT_FULFILMENT_ASSIGNED for one hotel, sent once the transition commits. */
async function queueFulfilmentNotice(t, { arcId, orgId, principalVendorId, hotelId, fulfillingVendorId }) {
  const [card, hotel] = await Promise.all([
    supplierCard(orgId, fulfillingVendorId, t),
    t.oneOrNone(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [hotelId]),
  ]);
  const payload = {
    hotelId: Number(hotelId),
    hotelName: hotel?.name ?? null,
    vendorId: Number(principalVendorId), // EVENT_VENDOR: the contract vendor
    fulfillingVendorId: Number(fulfillingVendorId),
    entityName: card?.entity_name ?? null,
    gstin: card?.gstin ?? null,
    contactName: card?.contact_name ?? null,
    contactEmail: card?.contact_email ?? null,
  };
  payload.notifyData = {
    hotel_id: payload.hotelId,
    fulfilling_vendor_id: payload.fulfillingVendorId,
    entity_name: payload.entityName,
    gstin: payload.gstin,
    contact_name: payload.contactName,
    contact_email: payload.contactEmail,
  };
  afterCommit(t, () =>
    notifyArcEvent({ arcId: Number(arcId), eventType: ARC_EVENT_TYPES.CONTRACT_FULFILMENT_ASSIGNED, payload })
  );
}

// --- handler --------------------------------------------------------------------------

async function validateSubject({ principalVendorId, subjectId, hotelId }, t) {
  if (hotelId == null) return refuse(400, "A rate contract is routed per hotel: hotel_id is required", "HOTEL_REQUIRED");
  const c = await getContractForHotel(subjectId, hotelId, t);
  // Not found and another vendor's contract answer alike.
  if (!c || Number(c.vendor_id) !== Number(principalVendorId)) return refuse(404, "Contract not found", "NOT_FOUND");
  // v1 (spec §6.4): a single-hotel contract has no per-hotel ledger to route.
  if (!c.is_group) {
    return refuse(400, "Fulfilment routing is available for group rate contracts only", "GROUP_ARC_ONLY");
  }
  if (!ROUTABLE_CONTRACT_STATUSES.includes(c.status)) {
    return refuse(409, `This contract can no longer be routed (status ${c.status})`, "CONTRACT_NOT_ROUTABLE");
  }
  if (!c.hotel_rows) return refuse(400, "That hotel is not covered by this contract", "HOTEL_NOT_ON_CONTRACT");
  if (c.all_suspended) return refuse(409, "Ordering for that hotel is paused on this contract", "HOTEL_SUSPENDED");
  return {
    ok: true,
    hotelIds: [Number(hotelId)],
    categoryId: c.category_id != null ? Number(c.category_id) : null,
  };
}

async function onAccepted(assignment, _previous, t) {
  const org = await getOrgById(assignment.org_id, t);
  const valid = await validateSubject(
    { principalVendorId: org.principal_vendor_id, subjectId: assignment.subject_id, hotelId: assignment.hotel_id },
    t
  );
  if (!valid.ok) throw new NetworkHttpError(valid.http, valid.message, valid.code);

  const ids = await lockHotelRows(t, assignment.subject_id, assignment.hotel_id);
  await t.none(
    `UPDATE tbl_arc_contract_line_hotel
        SET fulfilling_vendor_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1::bigint[])`,
    [ids, assignment.assigned_vendor_id]
  );
  const { arc_id: arcId } = await t.one(`SELECT arc_id FROM tbl_arc_contract WHERE id = $1`, [assignment.subject_id]);
  await queueFulfilmentNotice(t, {
    arcId,
    orgId: assignment.org_id,
    principalVendorId: org.principal_vendor_id,
    hotelId: assignment.hotel_id,
    fulfillingVendorId: assignment.assigned_vendor_id,
  });
}

async function onReleased(assignment, priorStatus, t) {
  // A superseded row's hotel is rewritten by the new row's onAccepted in this transaction.
  if (assignment.status === SUPERSEDED || assignment.release_reason === "SUPERSEDED") return;
  // Never accepted: the contract was never touched.
  if (priorStatus !== ACCEPTED) return;
  if (assignment.hotel_id == null) return;
  // No "is a newer row ACCEPTED?" check: the org holds at most one ACCEPTED row per
  // subject+hotel (ix_vn_assign_org_one_accepted), and a supersede returned above, so a
  // REVOKED-from-ACCEPTED row is always the hotel's current fulfiller. The
  // fulfilling_vendor_id = assignee guard below still never clobbers another vendor.
  const ids = await lockHotelRows(t, assignment.subject_id, assignment.hotel_id);
  if (!ids.length) return; // placeholder or deleted contract: nothing to reset
  const reset = await t.result(
    `UPDATE tbl_arc_contract_line_hotel
        SET fulfilling_vendor_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1::bigint[]) AND fulfilling_vendor_id = $2`,
    [ids, assignment.assigned_vendor_id]
  );
  if (!reset.rowCount) return;

  const contract = await t.oneOrNone(`SELECT arc_id, vendor_id FROM tbl_arc_contract WHERE id = $1`, [
    assignment.subject_id,
  ]);
  if (!contract) return;
  try {
    await queueFulfilmentNotice(t, {
      arcId: contract.arc_id,
      orgId: assignment.org_id,
      principalVendorId: contract.vendor_id,
      hotelId: assignment.hotel_id,
      fulfillingVendorId: contract.vendor_id,
    });
  } catch (err) {
    // A release must go through even when the notice cannot be prepared.
    logger.warn({ err: err.message, assignmentId: assignment.id }, "arc-hotel fulfilment notice failed");
  }
}

async function describe(assignment, runner = db) {
  const r = await runner.oneOrNone(
    `SELECT a.arc_number, a.title, h.name AS hotel_name
       FROM tbl_arc_contract c
       JOIN tbl_arc a ON a.id = c.arc_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = $2
      WHERE c.id = $1`,
    [assignment.subject_id, assignment.hotel_id]
  );
  const base = r ? `Rate contract ${r.arc_number}${r.title ? ` · ${r.title}` : ""}` : `Rate contract #${assignment.subject_id}`;
  return {
    title: r?.hotel_name ? `${base} · ${r.hotel_name}` : base,
    // The member may open the contract only once it holds the ACCEPTED assignment.
    actionUrl: assignment.status === ACCEPTED ? arcVendorContract(assignment.subject_id) : null,
  };
}

/** The principal's routable contracts × covered, unpaused hotels with no live row of the org. */
async function listUnrouted(orgId, runner = db) {
  const rows = await runner.any(
    `SELECT c.id AS contract_id, c.status, a.id AS arc_id, a.arc_number, a.title, a.category_id,
            hh.hotel_id, h.name AS hotel_name
       FROM tbl_vendor_orgs o
       JOIN tbl_arc_contract c ON c.vendor_id = o.principal_vendor_id AND c.status = ANY($2::varchar[])
       JOIN tbl_arc a ON a.id = c.arc_id
       JOIN LATERAL (
         SELECT clh.hotel_id
           FROM tbl_arc_contract_line_hotel clh
           JOIN tbl_arc_contract_line l ON l.id = clh.arc_contract_line_id
          WHERE l.arc_contract_id = c.id
          GROUP BY clh.hotel_id
         HAVING NOT bool_and(clh.is_suspended)
       ) hh ON true
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = hh.hotel_id
      WHERE o.id = $1
        AND NOT EXISTS (
              SELECT 1 FROM tbl_vendor_routing_assignments x
               WHERE x.org_id = o.id AND x.subject_type = 'ARC_HOTEL' AND x.subject_id = c.id
                 AND x.hotel_id = hh.hotel_id AND x.status IN ('PENDING', 'ACCEPTED'))
      ORDER BY c.id, hh.hotel_id
      LIMIT ${UNROUTED_LIMIT}`,
    [orgId, ROUTABLE_CONTRACT_STATUSES]
  );
  return rows.map((r) => ({
    subjectId: Number(r.contract_id),
    hotelId: Number(r.hotel_id),
    hotelIds: [Number(r.hotel_id)],
    categoryId: r.category_id != null ? Number(r.category_id) : null,
    title: `Rate contract ${r.arc_number}${r.title ? ` · ${r.title}` : ""}${r.hotel_name ? ` · ${r.hotel_name}` : ""}`,
    meta: {
      contract_id: Number(r.contract_id),
      contract_status: r.status,
      arc_id: Number(r.arc_id),
      arc_number: r.arc_number,
      hotel_id: Number(r.hotel_id),
      hotel_name: r.hotel_name,
    },
  }));
}

// The (contract, hotel) ledger rows the org's ACCEPTED, still-ACTIVE assignee should
// fulfil but that hold NULL — e.g. a row a contract regeneration inserted while the
// accept was in flight. Shared by the lock step and the update step of reconcile.
const UNFULFILLED_ROWS = `
  FROM tbl_arc_contract_line_hotel clh
  JOIN tbl_arc_contract_line l ON l.id = clh.arc_contract_line_id
  JOIN tbl_arc_contract c ON c.id = l.arc_contract_id
  JOIN tbl_vendor_routing_assignments a
    ON a.subject_type = 'ARC_HOTEL' AND a.status = 'ACCEPTED'
   AND a.subject_id = l.arc_contract_id AND a.hotel_id = clh.hotel_id
  JOIN tbl_vendor_orgs o ON o.id = a.org_id AND o.principal_vendor_id = c.vendor_id
  JOIN tbl_vendor_org_entities e
    ON e.org_id = a.org_id AND e.vendor_id = a.assigned_vendor_id AND e.status = 'ACTIVE'
 WHERE clh.fulfilling_vendor_id IS NULL`;

/**
 * Sweep self-heal: gives every such NULL row its assignee. Two statements in one
 * transaction: lock the rows FOR UPDATE in id order (the lock order of the header; no
 * subject or assignment lock is taken), then ONE set-based UPDATE that re-reads the
 * assignments in a fresh snapshot, so a revoke or supersede committed while it waited
 * is honoured and a row someone else filled meanwhile is left alone.
 * @returns {Promise<number>} rows filled
 */
async function reconcile(runner = db) {
  return runner.tx(async (t) => {
    const ids = (await t.any(`SELECT clh.id ${UNFULFILLED_ROWS} ORDER BY clh.id FOR UPDATE OF clh`)).map((r) => r.id);
    if (!ids.length) return 0;
    const res = await t.result(
      `UPDATE tbl_arc_contract_line_hotel target
          SET fulfilling_vendor_id = src.assigned_vendor_id, updated_at = CURRENT_TIMESTAMP
         FROM (SELECT clh.id, a.assigned_vendor_id ${UNFULFILLED_ROWS} AND clh.id = ANY($1::bigint[])) src
        WHERE target.id = src.id AND target.fulfilling_vendor_id IS NULL`,
      [ids]
    );
    return res.rowCount;
  });
}

export const arcHotelSubjectHandler = Object.freeze({
  validateSubject,
  onAccepted,
  onReleased,
  describe,
  listUnrouted,
  reconcile,
});

registerSubject(SUBJECT_TYPE.ARC_HOTEL, arcHotelSubjectHandler);

// --- member contract access -------------------------------------------------------------

/**
 * The hotels of contract `contractId` that `vendorId` fulfils: its ACCEPTED ARC_HOTEL
 * assignments in the org whose principal is the contract vendor, while it is still an
 * ACTIVE entity of that org. Empty for anyone else (the principal included).
 */
export async function fulfilmentHotelIds(contractId, contractVendorId, vendorId, runner = db) {
  const rows = await runner.any(
    `SELECT a.hotel_id
       FROM tbl_vendor_routing_assignments a
       JOIN tbl_vendor_orgs o ON o.id = a.org_id AND o.principal_vendor_id = $2
       JOIN tbl_vendor_org_entities e
         ON e.org_id = a.org_id AND e.vendor_id = a.assigned_vendor_id AND e.status = 'ACTIVE'
      WHERE a.subject_type = 'ARC_HOTEL' AND a.subject_id = $1 AND a.assigned_vendor_id = $3
        AND a.status = 'ACCEPTED' AND a.hotel_id IS NOT NULL
      ORDER BY a.hotel_id`,
    [contractId, contractVendorId, vendorId]
  );
  return rows.map((r) => Number(r.hotel_id));
}

export default { arcHotelSubjectHandler, fulfilmentHotelIds, ROUTABLE_CONTRACT_STATUSES };
