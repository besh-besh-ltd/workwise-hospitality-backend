// Vendor Networks HQ dashboard (spec §8), admin only. The org is always
// req.user.network.org_id; `entity_vendor_id` is only a filter that must belong to it
// (a foreign one answers 404, revealing nothing).
//
//   GET /dashboard/summary     entities with seat / live assignments / open POs, routing
//                              queue counts, PO counts by status
//   GET /dashboard/pos         ?entity_vendor_id=&status=&page=&page_size=
//   GET /dashboard/contracts   ?page=&page_size=  the principal's contracts + per-hotel fulfilment

import db from "../../config/dbConn.js";
import Config from "../../config/app.config.js";
import { logger } from "../../util/logger.js";
import { requireOrgAdmin, NetworkHttpError, sendIfNetworkError } from "../../services/vendorNetwork/guards.js";
import { registeredSubjects } from "../../services/vendorNetwork/routingEngine.js";
import { getOrgById, listEntitiesWithSeats } from "../../models/vendorNetworkModel.js";
import { seatFeeInr } from "../../constants/vendorNetwork.js";
import dashboardModel from "../../models/vendorNetworkDashboardModel.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const RECENT_DAYS = 7;

/** A positive int4 from a digit string or number, else null. */
function parseId(value) {
  const n = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/** page >= 1; page_size clamped to 1..100 (never an error). */
function pagination(query) {
  const page = parseId(query?.page) ?? 1;
  const asked = parseId(query?.page_size) ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(asked, MAX_PAGE_SIZE);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function handleError(res, error, label) {
  if (sendIfNetworkError(res, error)) return res;
  logger.error({ err: error.message }, `vendor-network ${label} failed`);
  return res.status(400).json({ status: 3, message: Config.errorText.value });
}

/** Unrouted subjects of every registered type; one failing type does not hide the rest. */
async function countUnrouted(orgId) {
  let total = 0;
  for (const [subjectType, handler] of registeredSubjects()) {
    if (!handler.listUnrouted) continue;
    try {
      total += ((await handler.listUnrouted(orgId, db)) ?? []).length;
    } catch (err) {
      logger.warn({ err: err.message, orgId, subjectType }, "vendor-dashboard listUnrouted failed");
    }
  }
  return total;
}

/** GET /dashboard/summary */
export async function dashboardSummary(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const orgId = req.user.network.org_id;
    const since = new Date(Date.now() - RECENT_DAYS * 24 * 3600 * 1000);

    const [entities, live, open, assignments, byStatus, unrouted] = await Promise.all([
      listEntitiesWithSeats(orgId),
      dashboardModel.liveAssignmentCounts(orgId),
      dashboardModel.openPoCounts(orgId),
      dashboardModel.routingCounts(orgId, since),
      dashboardModel.poCountsByStatus(orgId),
      countUnrouted(orgId),
    ]);

    return res.status(200).json({
      status: 1,
      message: "Network dashboard",
      data: {
        entities: entities.map((e) => ({
          vendor_id: Number(e.vendor_id),
          name: e.name,
          relationship: e.relationship,
          status: e.status,
          seat: e.seat_status
            ? { status: e.seat_status, end_date: e.seat_end_date, valid_until: e.seat_valid_until }
            : null,
          live_assignments: live.get(Number(e.vendor_id)) ?? 0,
          open_pos: open.get(Number(e.vendor_id)) ?? 0,
        })),
        routing: {
          unrouted,
          pending: assignments.pending,
          declined_7d: assignments.declined_7d,
          timed_out_7d: assignments.timed_out_7d,
        },
        pos: { by_status: byStatus },
        seat_fee_inr: seatFeeInr(),
      },
    });
  } catch (error) {
    return handleError(res, error, "dashboardSummary");
  }
}

/** GET /dashboard/pos */
export async function dashboardPos(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const orgId = req.user.network.org_id;
    const { page, pageSize, limit, offset } = pagination(req.query);

    let entityVendorId = null;
    if (req.query?.entity_vendor_id != null && req.query.entity_vendor_id !== "") {
      entityVendorId = parseId(req.query.entity_vendor_id);
      if (!entityVendorId) throw new NetworkHttpError(400, "Invalid entity_vendor_id");
      if (!(await dashboardModel.isPoEntity(orgId, entityVendorId))) {
        throw new NetworkHttpError(404, "Entity not found");
      }
    }
    const status = typeof req.query?.status === "string" && req.query.status.trim() ? req.query.status.trim() : null;
    // Only statuses the vendor's own PO pages show; anything else (draft, pending_approval,
    // rejected, cancelled, junk) is a 400, never an empty-but-valid answer. Blank = all.
    const rawStatus = req.query?.status;
    const malformed = rawStatus !== undefined && typeof rawStatus !== "string";
    if (malformed || (status !== null && !dashboardModel.isVendorVisiblePoStatus(status))) {
      throw new NetworkHttpError(400, "Unknown or unavailable PO status");
    }

    const { total, rows } = await dashboardModel.listPos(orgId, { entityVendorId, status, limit, offset });
    return res.status(200).json({
      status: 1,
      message: "Network purchase orders",
      data: {
        items: rows.map((r) => ({
          id: Number(r.id),
          po_number: r.po_number,
          entity_vendor_id: Number(r.entity_vendor_id),
          entity_name: r.entity_name,
          hotel_name: r.hotel_name ?? null,
          status: r.status,
          amount: Number(r.amount),
          created_at: r.created_at,
          is_call_off: !!r.is_call_off,
        })),
        page,
        page_size: pageSize,
        total,
      },
    });
  } catch (error) {
    return handleError(res, error, "dashboardPos");
  }
}

/** GET /dashboard/contracts */
export async function dashboardContracts(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const orgId = req.user.network.org_id;
    const { page, pageSize, limit, offset } = pagination(req.query);
    const { principal_vendor_id: principalVendorId } = await getOrgById(orgId);

    const { total, rows } = await dashboardModel.listPrincipalContracts(principalVendorId, { limit, offset });
    const fulfilment = await dashboardModel.listContractHotelFulfilment(
      orgId,
      rows.map((r) => Number(r.id))
    );
    const byContract = new Map();
    for (const f of fulfilment) {
      const list = byContract.get(Number(f.contract_id)) ?? [];
      list.push({
        hotel_id: Number(f.hotel_id),
        hotel_name: f.hotel_name,
        fulfilling_vendor_id: Number(f.fulfilling_vendor_id),
        fulfilling_name: f.fulfilling_name,
        assignment_status: f.assignment_status ?? null,
      });
      byContract.set(Number(f.contract_id), list);
    }
    return res.status(200).json({
      status: 1,
      message: "Network contracts",
      data: {
        items: rows.map((c) => ({
          contract_id: Number(c.id),
          arc_id: Number(c.arc_id),
          arc_number: c.arc_number,
          title: c.title,
          status: c.status,
          is_group: !!c.is_group,
          hotels: byContract.get(Number(c.id)) ?? [],
        })),
        page,
        page_size: pageSize,
        total,
      },
    });
  } catch (error) {
    return handleError(res, error, "dashboardContracts");
  }
}

export default { dashboardSummary, dashboardPos, dashboardContracts };
