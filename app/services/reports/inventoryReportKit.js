// ============================================================================
// inventoryReportKit.js
// ----------------------------------------------------------------------------
// What the inventory and receiving reports (families 7 and 8) share: the
// caller's hotel scope, IST period bounds, document-number joins, labels and
// cell helpers.
//
// ── Scope ───────────────────────────────────────────────────────────────────
// Inventory permissions sit on the company + hotel axes (spec §6.1), not on
// the PO scope predicate the procurement reports use. A report therefore runs
// over the hotels where the caller holds `inventory.read` (`grn.read` for the
// receiving family), from their own role scopes. The report's
// `reports.<key>` key is entitlement only, as in the rest of the module.
// Whatever the request names (the hotel facet, a super admin's company hint)
// only narrows that list; a hotel outside it yields no rows, never an error,
// which is the module's convention for a foreign facet.
//
// ── Rules every report here follows ─────────────────────────────────────────
//   - Value columns sum movement `value`. Only the quantity reconciles with
//     tbl_inv_balance (a reversal at receipt cost can leave a value residue),
//     so nothing here cross-checks value against the balance table.
//   - Days are IST calendar days. A period { from, to } is [from, to): `to`
//     is exclusive, as resolvePeriod() hands it over.
//   - Rows with no hotel (unallocated delivery rows) belong to no hotel and
//     never appear.
// ============================================================================

import db from "../../config/dbConn.js";
import { hotelIdsWithPermission } from "../inventory/scope.js";

export const INVENTORY_FAMILY = "Inventory";
export const RECEIVING_FAMILY = "Receiving & Deliveries";
export const INVENTORY_REPORT_FAMILIES = Object.freeze([INVENTORY_FAMILY, RECEIVING_FAMILY]);

export const IST_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;

/** The instant an IST calendar day starts, for a bound parameter `$n` ('YYYY-MM-DD'). */
export const istDayStart = (param) => `(${param}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;

/** A timestamptz column as its IST calendar day, 'YYYY-MM-DD'. */
export const istDay = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;

/**
 * Hotel ids this report may read for the caller, ascending.
 *
 * @param {{userId:number, hospitalityCompanyIds:number[]|null, hotelIds:number[]}} scope  deriveScope()
 * @param {'inventory'|'grn'} resource
 * @returns {Promise<number[]>}
 */
export async function reportHotels(scope, resource, conn = db) {
  const user = await conn.oneOrNone(`SELECT id, user_type FROM tbl_users WHERE id = $1`, [scope?.userId]);
  if (!user) return [];
  let hotels = await hotelIdsWithPermission(
    conn,
    { id: Number(user.id), user_type: user.user_type == null ? null : Number(user.user_type) },
    resource,
    "read"
  );
  if (!hotels.length) return [];

  // Mapped companies (or a super admin's hinted one) narrow; null means all.
  if (Array.isArray(scope.hospitalityCompanyIds)) {
    const rows = await conn.any(
      `SELECT id FROM tbl_hospitality_company_hotels
        WHERE id = ANY($1::int[]) AND hospitality_company_id = ANY($2::int[])`,
      [hotels, scope.hospitalityCompanyIds]
    );
    const allowed = new Set(rows.map((r) => Number(r.id)));
    hotels = hotels.filter((h) => allowed.has(h));
  }

  // The hotel facet (x-hotel-ids header or the payload's hotel_ids) narrows.
  if (Array.isArray(scope.hotelIds) && scope.hotelIds.length) {
    const facet = new Set(scope.hotelIds.map(Number));
    hotels = hotels.filter((h) => facet.has(h));
  }
  return hotels;
}

/**
 * Document numbers for ledger rows. Expects the movement as `m`; yields
 * `doc_number`. Each join also matches the company, so a source id that
 * belongs to another tenant's document can never lend its number.
 */
export const DOC_JOINS = `
    LEFT JOIN tbl_grn g
      ON m.source_type = 'GRN' AND g.id = m.source_id AND g.hospitality_company_id = m.hospitality_company_id
    LEFT JOIN tbl_rtv r
      ON m.source_type = 'RTV' AND r.id = m.source_id AND r.hospitality_company_id = m.hospitality_company_id
    LEFT JOIN tbl_inv_out o
      ON m.source_type = 'OUT' AND o.id = m.source_id AND o.hospitality_company_id = m.hospitality_company_id
    LEFT JOIN tbl_inv_adjustment a
      ON m.source_type = 'ADJ' AND a.id = m.source_id AND a.hospitality_company_id = m.hospitality_company_id
    LEFT JOIN tbl_inv_count c
      ON m.source_type = 'CNT' AND c.id = m.source_id AND c.hospitality_company_id = m.hospitality_company_id`;

export const DOC_NUMBER = `CASE m.source_type
           WHEN 'GRN' THEN g.grn_number
           WHEN 'RTV' THEN r.rtv_number
           WHEN 'OUT' THEN o.out_number
           WHEN 'ADJ' THEN a.adjustment_number
           WHEN 'CNT' THEN c.count_number
         END`;

/**
 * A stock item's catalogue category: its first mapped variant's leaf
 * category (LEAF_CATEGORY_JOIN needs `pv`). Expects the item as `i`; yields
 * `cat.title`, NULL for an item with no mapped variant.
 */
export const ITEM_VARIANT_JOIN = `
    LEFT JOIN LATERAL (
      SELECT iv.product_variant_id FROM tbl_inv_item_variant iv
       WHERE iv.inv_item_id = i.id ORDER BY iv.id LIMIT 1
    ) first_variant ON true
    LEFT JOIN tbl_product_variant pv ON pv.id = first_variant.product_variant_id`;

/** A vendor's display name, as reportsModel resolves it. Expects `v` and `vc`. */
export const VENDOR_NAME = `COALESCE(NULLIF(TRIM(vc.company_name), ''), NULLIF(TRIM(v.organization_name), ''), v.name)`;

export const MOVEMENT_LABELS = Object.freeze({
  GRN_IN: "Receipt (GRN)",
  GRN_REVERSAL: "GRN reversal",
  RTV_OUT: "Return to vendor",
  MARK_OUT: "Mark out",
  RETURN_IN: "Return to stock",
  ADJUST_IN: "Adjustment in",
  ADJUST_OUT: "Adjustment out",
  COUNT_IN: "Count gain",
  COUNT_OUT: "Count loss",
  OPENING: "Opening stock",
});

export const ADJUSTMENT_REASON_LABELS = Object.freeze({
  WASTAGE: "Wastage",
  BREAKAGE: "Breakage",
  EXPIRY: "Expiry",
  THEFT_LOSS: "Theft / loss",
  CORRECTION: "Correction",
  FOUND: "Found",
  OPENING: "Opening stock",
});

export const REJECTION_REASON_LABELS = Object.freeze({
  damaged: "Damaged",
  quality: "Quality",
  wrong_item: "Wrong item",
  short_shelf_life: "Short shelf life",
  temperature: "Temperature",
  excess: "Excess",
  other: "Other",
});

/** Stock quantities: up to four decimals, as stored. */
export const QTY_FMT = "#,##0.00##;[Red]\\-#,##0.00##;0";

/** null stays null; anything else becomes a JS number. */
export const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Four decimals, as numeric(18,4) stores them: sums of JS numbers drift. */
export const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** 'YYYY-MM-DD' → a Date ExcelJS writes as that calendar day (null-safe). */
export const xlDay = (day) => (day ? new Date(`${day}T00:00:00Z`) : null);

/** The last IST day a [from, to) period covers, 'YYYY-MM-DD'. */
export function lastDayOf(period) {
  const d = new Date(`${period.to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** "01-Apr-2026 to 31-Mar-2027" for a sheet's parameter block. */
export function periodLabel(period) {
  const fmt = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${String(d.getUTCDate()).padStart(2, "0")}-${mon[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  };
  return `${fmt(period.from)} to ${fmt(lastDayOf(period))}`;
}

/** Hotel names for a parameter line. */
export function hotelsLabel(names) {
  if (!names || !names.length) return "None in your scope";
  return names.join(", ");
}

/** The names of the given hotel ids, in name order. */
export async function hotelNames(hotelIds, conn = db) {
  if (!hotelIds.length) return [];
  const rows = await conn.any(
    `SELECT name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[]) ORDER BY name, id`,
    [hotelIds]
  );
  return rows.map((r) => r.name);
}

/** Preview columns from sheet columns: header, key, type, align. */
export const previewColumns = (columns) => columns.map(({ header, key, type, align }) => ({ header, key, type, align }));

export default {
  INVENTORY_FAMILY,
  RECEIVING_FAMILY,
  INVENTORY_REPORT_FAMILIES,
  reportHotels,
  hotelNames,
};
