// The RFQ routing subject (Vendor Networks spec §6.3, §10.8) and the quote gate.
//
// Routing an RFQ invite: the org's principal is the invited vendor (tbl_rfq_product_vendors
// rows with routed_from_vendor_id NULL). Routing it to a member entity copies those rows
// to the member with routed_from_vendor_id = principal, so the member can view the RFQ and
// decide. Each org routes for itself: two orgs on one RFQ each have their own rows.
//
// Quoting (assertOrgMayQuote, called by rfqController before any quote write):
//   a) a non-principal org entity quotes only while it holds the org's ACCEPTED assignment
//      → else 403 ROUTING_REQUIRED
//   b) the principal is blocked while a member holds ACCEPTED → 409 ROUTED_TO_MEMBER
//   c) one quote per org: another entity of the org holds a non-regret quote
//      → 409 ORG_ALREADY_QUOTED
//   d) a vendor in no org: no-op (and, on the JWT path, no query: quoteGateApplies)
//
// LOCK ORDER. Every check above and every hook that reads or changes "who may quote"
// takes the transaction advisory lock RFQ_ORG_QUOTE_LOCK_NS(<orgId>:<rfqId>) and reads
// after it, so a quote and a routing transition of the same org+RFQ serialise:
//   engine transition: subject lock (950601) → assignment rows FOR UPDATE → entity FOR
//                      SHARE → [hook] org-quote lock (950603) → tbl_rfq_product_vendors
//                      INSERT/DELETE (tbl_rfq / tbl_quotes only read, never locked)
//   quote path:        org-quote lock (950603) FIRST in its transaction → plain reads of
//                      assignments → tbl_quotes / tbl_quote_items writes
// The quote path never takes an engine lock (950601, assignment or entity rows) and never
// writes tbl_rfq_product_vendors, and the engine hooks never lock tbl_quotes or tbl_rfq,
// so the one lock both sides take is always taken before anything the other side holds.

import db from "../../../config/dbConn.js";
import { registerSubject } from "../routingEngine.js";
import { NetworkHttpError } from "../guards.js";
import { getOrgByEntity } from "../../../models/vendorNetworkModel.js";
import { RFQ_ORG_QUOTE_LOCK_NS } from "../../../models/vendorRoutingModel.js";
import {
  ASSIGNMENT_STATUS,
  SUBJECT_TYPE,
  RFQ_DUE_CAP_HOURS_BEFORE_BID_END,
} from "../../../constants/vendorNetwork.js";

const { ACCEPTED, REVOKED, SUPERSEDED } = ASSIGNMENT_STATUS;
const VENDOR_RFQ_URL = "/dashboard/vendor/inquiries-details";
const UNROUTED_LIMIT = 500;

// --- SQL ------------------------------------------------------------------------------

// tbl_rfq.bid_end_date is naive IST wall-clock TEXT ('' on some legacy rows).
const BID_END_TS = (r) => `CAST(NULLIF(TRIM(${r}.bid_end_date), '') AS timestamp)`;
const IST_NOW = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')`;
/** Published and still open for bids (IST compare). */
const OPEN_RFQ = (r) => `${r}.status = 1 AND ${r}.is_published = 1 AND ${BID_END_TS(r)} > ${IST_NOW}`;
/** The RFQ's one product category, or NULL when its products span several or have none. */
const RFQ_CATEGORY = (r) => `(
  SELECT CASE WHEN COUNT(DISTINCT pc.category_id) = 1 AND bool_and(pc.category_id IS NOT NULL)
              THEN MIN(pc.category_id) END
    FROM tbl_rfq_products rp
    JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
    LEFT JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
   WHERE rp.rfq_id = ${r}.id)`;
/** A non-regret quote on RFQ `${rfq}` by a live entity of org `${org}` other than `${except}`. */
const ORG_QUOTED = (rfq, org, except = "NULL") => `EXISTS (
  SELECT 1 FROM tbl_quotes q
    JOIN tbl_vendor_org_entities qe
      ON qe.vendor_id = q.created_by AND qe.org_id = ${org} AND qe.status <> 'REMOVED'
   WHERE q.rfq_id = ${rfq} AND COALESCE(q.is_regret, 0) <> 1
     AND q.created_by IS DISTINCT FROM ${except})`;

function lockOrgQuote(t, orgId, rfqId) {
  return t.one(`SELECT pg_advisory_xact_lock($1::int, hashtext($2)) AS locked`, [
    RFQ_ORG_QUOTE_LOCK_NS,
    `${orgId}:${rfqId}`,
  ]);
}

/** The org's ACCEPTED assignee for the RFQ (or null) and whether another org entity quoted. */
function getOrgQuoteState(orgId, rfqId, vendorId, t) {
  return t.one(
    `SELECT (SELECT a.assigned_vendor_id FROM tbl_vendor_routing_assignments a
              WHERE a.org_id = $1 AND a.subject_type = 'RFQ' AND a.subject_id = $2
                AND COALESCE(a.hotel_id, 0) = 0 AND a.status = 'ACCEPTED'
              LIMIT 1) AS accepted_vendor_id,
            ${ORG_QUOTED("$2", "$1", "$3::int")} AS sibling_quoted`,
    [orgId, rfqId, vendorId]
  );
}

/** The assignee's own quote on the RFQ: { has_quote, has_live_quote }. */
function getAssigneeQuote(rfqId, vendorId, t) {
  return t.one(
    `SELECT COUNT(*) > 0 AS has_quote,
            COALESCE(bool_or(COALESCE(is_regret, 0) <> 1), false) AS has_live_quote
       FROM tbl_quotes WHERE rfq_id = $1 AND created_by = $2`,
    [rfqId, vendorId]
  );
}

// --- handler --------------------------------------------------------------------------

const refuse = (http, message, code) => ({ ok: false, http, message, code });

async function validateSubject({ orgId, principalVendorId, subjectId, hotelId }, t) {
  if (hotelId != null) return refuse(400, "An RFQ is routed as a whole, without a hotel", "HOTEL_NOT_ALLOWED");
  const row = await t.oneOrNone(
    `SELECT r.id, r.hotel_id,
            (r.status = 1 AND r.is_published = 1) AS published,
            COALESCE(${BID_END_TS("r")} > ${IST_NOW}, false) AS open,
            (${BID_END_TS("r")} AT TIME ZONE 'Asia/Kolkata') - make_interval(hours => $4) AS due_cap,
            EXISTS (SELECT 1 FROM tbl_rfq_product_vendors p WHERE p.rfq_id = r.id AND p.user_id = $2) AS principal_mapped,
            ${ORG_QUOTED("r.id", "$3")} AS org_quoted,
            ${RFQ_CATEGORY("r")} AS category_id
       FROM tbl_rfq r
      WHERE r.id = $1`,
    [subjectId, principalVendorId, orgId, RFQ_DUE_CAP_HOURS_BEFORE_BID_END]
  );
  // Not found and not invited answer alike: no probing of other buyers' RFQs.
  if (!row || !row.principal_mapped) return refuse(404, "RFQ not found", "NOT_FOUND");
  if (!row.published || !row.open) return refuse(409, "This RFQ is no longer open for quotes", "RFQ_NOT_OPEN");
  if (row.org_quoted) return refuse(409, "Your network has already quoted on this RFQ", "ORG_ALREADY_QUOTED");
  return {
    ok: true,
    dueCap: row.due_cap,
    hotelIds: row.hotel_id != null ? [Number(row.hotel_id)] : [],
    categoryId: row.category_id != null ? Number(row.category_id) : null,
  };
}

/** The member gets copies of the principal's invite rows (rows it already has are kept). */
async function onPending(assignment, t) {
  await t.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, variant, sheet_id, user_id, routed_from_vendor_id)
     SELECT p.rfq_id, p.product_variant_id, p.variant, p.sheet_id, $3, o.principal_vendor_id
       FROM tbl_vendor_orgs o
       JOIN tbl_rfq_product_vendors p ON p.user_id = o.principal_vendor_id AND p.rfq_id = $2
      WHERE o.id = $1
        AND NOT EXISTS (
              SELECT 1 FROM tbl_rfq_product_vendors x
               WHERE x.rfq_id = p.rfq_id AND x.user_id = $3
                 AND x.product_variant_id = p.product_variant_id
                 AND x.variant IS NOT DISTINCT FROM p.variant)`,
    [assignment.org_id, assignment.subject_id, assignment.assigned_vendor_id]
  );
}

/**
 * The member accepts: refused while another entity of the org holds a non-regret quote
 * (the work is done; accepting would only freeze that quote behind ROUTED_TO_MEMBER).
 */
async function onAccepted(assignment, _previous, t) {
  await lockOrgQuote(t, assignment.org_id, assignment.subject_id);
  const { sibling_quoted } = await getOrgQuoteState(
    assignment.org_id,
    assignment.subject_id,
    assignment.assigned_vendor_id,
    t
  );
  if (sibling_quoted) {
    throw new NetworkHttpError(409, "Your network has already quoted on this RFQ", "ORG_ALREADY_QUOTED");
  }
}

/**
 * The assignment ended. An admin revoke or a supersede is refused while the member holds a
 * non-regret quote (it must regret first); an ENTITY_* release never is (the entity already
 * lost network access). A member with no quote at all loses its routed rows; one with a
 * quote keeps them, so the buyer still sees who quoted.
 */
async function onReleased(assignment, _priorStatus, t) {
  await lockOrgQuote(t, assignment.org_id, assignment.subject_id);
  const quote = await getAssigneeQuote(assignment.subject_id, assignment.assigned_vendor_id, t);
  const entityRelease = String(assignment.release_reason ?? "").startsWith("ENTITY_");
  if (quote.has_live_quote && !entityRelease && [REVOKED, SUPERSEDED].includes(assignment.status)) {
    throw new NetworkHttpError(
      409,
      "The entity has already submitted a quote on this RFQ; it must regret the quote first",
      "QUOTE_SUBMITTED"
    );
  }
  if (quote.has_quote) return;
  await t.none(
    `DELETE FROM tbl_rfq_product_vendors
      WHERE rfq_id = $1 AND user_id = $2 AND routed_from_vendor_id IS NOT NULL`,
    [assignment.subject_id, assignment.assigned_vendor_id]
  );
}

const titleOf = (r) => `RFQ #${r.rfq_no}${r.title ? ` · ${r.title}` : ""}`;

async function describe(assignment, runner = db) {
  const r = await runner.oneOrNone(`SELECT rfq_no, title FROM tbl_rfq WHERE id = $1`, [assignment.subject_id]);
  return {
    title: r ? titleOf(r) : `RFQ #${assignment.subject_id}`,
    actionUrl: `${VENDOR_RFQ_URL}?id=${assignment.subject_id}`,
  };
}

/** Open RFQs the org's principal is invited to, with no live assignment and no org quote yet. */
async function listUnrouted(orgId, runner = db) {
  const rows = await runner.any(
    `SELECT r.id, r.rfq_no, r.title, r.hotel_id, r.bid_end_date, h.name AS hotel_name,
            ${RFQ_CATEGORY("r")} AS category_id
       FROM tbl_vendor_orgs o
       JOIN LATERAL (SELECT DISTINCT p.rfq_id FROM tbl_rfq_product_vendors p
                      WHERE p.user_id = o.principal_vendor_id) m ON true
       JOIN tbl_rfq r ON r.id = m.rfq_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
      WHERE o.id = $1
        AND ${OPEN_RFQ("r")}
        AND NOT EXISTS (
              SELECT 1 FROM tbl_vendor_routing_assignments a
               WHERE a.org_id = o.id AND a.subject_type = 'RFQ' AND a.subject_id = r.id
                 AND a.status IN ('PENDING', 'ACCEPTED'))
        AND NOT ${ORG_QUOTED("r.id", "o.id")}
      ORDER BY ${BID_END_TS("r")}, r.id
      LIMIT ${UNROUTED_LIMIT}`,
    [orgId]
  );
  return rows.map((r) => ({
    subjectId: r.id,
    hotelId: null,
    hotelIds: r.hotel_id != null ? [Number(r.hotel_id)] : [],
    categoryId: r.category_id != null ? Number(r.category_id) : null,
    title: titleOf(r),
    meta: { rfq_no: r.rfq_no, bid_end_date: r.bid_end_date, hotel_id: r.hotel_id, hotel_name: r.hotel_name },
  }));
}

export const rfqSubjectHandler = Object.freeze({
  validateSubject,
  onPending,
  onAccepted,
  onReleased,
  describe,
  listUnrouted,
});

registerSubject(SUBJECT_TYPE.RFQ, rfqSubjectHandler);

// --- quote gate -------------------------------------------------------------------------

/**
 * Whether a quote request must run assertOrgMayQuote. jwtUsr resolved the acting entity's
 * network on THIS request, so a JWT vendor with no `network` is in no org and costs no
 * query; an emailed-link token vendor (is_verified === false, network never resolved)
 * pays one indexed lookup.
 */
export function quoteGateApplies(req) {
  if (req?.user?.network) return true;
  return req?.is_verified === false;
}

/**
 * Throws NetworkHttpError when `vendorId` may not create or change a quote on `rfqId`
 * (see the header). Run it inside the quote's own transaction `t`, before its first
 * write: it takes the org-quote lock so the check and the write are atomic against
 * routing transitions and sibling quotes. A vendor in no org returns after one query.
 */
export async function assertOrgMayQuote(rfqId, vendorId, t = db) {
  const self = await getOrgByEntity(vendorId, t);
  if (!self) return;
  const orgId = self.org_id;
  await lockOrgQuote(t, orgId, rfqId);
  const state = await getOrgQuoteState(orgId, rfqId, vendorId, t);
  const accepted = state.accepted_vendor_id == null ? null : Number(state.accepted_vendor_id);
  const isPrincipal = Number(self.principal_vendor_id) === Number(vendorId);

  if (!isPrincipal && accepted !== Number(vendorId)) {
    throw new NetworkHttpError(
      403,
      "Your network admin has not routed this RFQ to you, or you have not accepted it yet",
      "ROUTING_REQUIRED"
    );
  }
  if (isPrincipal && accepted != null) {
    throw new NetworkHttpError(409, "This RFQ is routed to a member of your network, who quotes for it", "ROUTED_TO_MEMBER");
  }
  if (state.sibling_quoted) {
    throw new NetworkHttpError(409, "Your network has already quoted on this RFQ", "ORG_ALREADY_QUOTED");
  }
}

export default { rfqSubjectHandler, quoteGateApplies, assertOrgMayQuote };
