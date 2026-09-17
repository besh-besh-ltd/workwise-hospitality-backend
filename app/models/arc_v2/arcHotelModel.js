import db from '../../config/dbConn.js';

/**
 * ARC v2 — Group rate contract hotel model.
 *
 * The ONLY module that reads or writes the group-only tables:
 *   tbl_arc_hotel_mappings            hotels a group ARC covers (lead included)
 *   tbl_arc_item_hotel_qty            expected quantity per item per hotel
 *   tbl_arc_invitation_hotel          hotels each invited vendor may quote for
 *   tbl_arc_comm_evaluation_award_hotel  how an award (item × vendor) splits by hotel
 *   tbl_arc_contract_line_hotel       per-hotel ledger of a contract line
 *
 * tbl_arc.hotel_id is the LEAD hotel. A single-hotel ARC (is_group = false)
 * has no rows here, and every reader below answers for it from the lead hotel,
 * so callers can treat both kinds the same way.
 *
 * Writers take the FINAL desired state and reconcile (mirrors
 * hospitalityModel.reconcileRFQHotels), so a resumed draft can be saved any
 * number of times without duplicating or orphaning rows.
 */

const toIds = (ids) => [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

const arcHotelModel = {
  /**
   * Make the ARC's coverage exactly `hotelIds`. Returns the stored ids, ascending.
   */
  reconcileArcHotels: async (arcId, hotelIds, createdBy, txContext = null) => {
    const runner = txContext || db;
    const ids = toIds(hotelIds);
    await runner.none(
      `DELETE FROM tbl_arc_hotel_mappings
        WHERE arc_id = $1 AND hotel_id <> ALL($2::int[])`,
      [arcId, ids]
    );
    if (ids.length) {
      await runner.none(
        `INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id, created_by)
         SELECT $1, h, $3 FROM UNNEST($2::int[]) AS h
         ON CONFLICT (arc_id, hotel_id) DO NOTHING`,
        [arcId, ids, createdBy ?? null]
      );
    }
    const rows = await runner.any(
      `SELECT hotel_id FROM tbl_arc_hotel_mappings WHERE arc_id = $1 ORDER BY hotel_id`,
      [arcId]
    );
    return rows.map((r) => Number(r.hotel_id));
  },

  /**
   * Every hotel the ARC covers, ascending. A group ARC: its coverage plus the
   * lead hotel. A single-hotel ARC: its hotel only — coverage rows are ignored
   * because they only count when is_group is set.
   *
   * @param {{ id, hotel_id, is_group }} arc
   */
  arcHotelIds: async (arc, txContext = null) => {
    const lead = Number(arc.hotel_id);
    if (!arc.is_group) return [lead];
    const rows = await (txContext || db).any(
      `SELECT hotel_id FROM tbl_arc_hotel_mappings WHERE arc_id = $1`,
      [arc.id]
    );
    return toIds([lead, ...rows.map((r) => r.hotel_id)]).sort((a, b) => a - b);
  },

  /**
   * The covered hotels with the identity fields a contract, a call-off and the
   * UI need. The lead hotel comes first (is_lead = true); the rest by name.
   *
   * @param {{ id, hotel_id, is_group }} arc
   */
  listArcHotels: async (arc, txContext = null) => {
    const runner = txContext || db;
    const hotelIds = await arcHotelModel.arcHotelIds(arc, runner);
    const rows = await runner.any(
      `SELECT h.id AS hotel_id, h.name, h.city, h.state, h.gst, h.pan,
              h.full_address, h.delivery_address,
              COALESCE(h.is_head_office, false) AS is_head_office,
              (h.id = $2) AS is_lead
         FROM tbl_hospitality_company_hotels h
        WHERE h.id = ANY($1::int[])
        ORDER BY (h.id = $2) DESC, h.name, h.id`,
      [hotelIds, Number(arc.hotel_id)]
    );
    return rows.map((r) => ({ ...r, hotel_id: Number(r.hotel_id) }));
  },

  /**
   * Replace an item's per-hotel split. Returns the total, which the caller
   * stores as tbl_arc_item.indicative_qty in the same transaction.
   *
   * @param {Array<{ hotel_id: number, indicative_qty: number }>} rows
   */
  setItemHotelQtys: async (arcItemId, rows, txContext = null) => {
    const runner = txContext || db;
    await runner.none(`DELETE FROM tbl_arc_item_hotel_qty WHERE arc_item_id = $1`, [arcItemId]);
    let total = 0;
    for (const row of rows || []) {
      const qty = Number(row.indicative_qty);
      total += qty;
      await runner.none(
        `INSERT INTO tbl_arc_item_hotel_qty (arc_item_id, hotel_id, indicative_qty)
         VALUES ($1, $2, $3)`,
        [arcItemId, Number(row.hotel_id), qty]
      );
    }
    return total;
  },

  /**
   * { [arc_item_id]: [{ hotel_id, indicative_qty }] } for every item of the ARC,
   * each list ascending by hotel. Items with no split are absent.
   */
  listItemHotelQtys: async (arcId, txContext = null) => {
    const rows = await (txContext || db).any(
      `SELECT q.arc_item_id, q.hotel_id, q.indicative_qty
         FROM tbl_arc_item_hotel_qty q
         JOIN tbl_arc_item i ON i.id = q.arc_item_id
        WHERE i.arc_id = $1
        ORDER BY q.arc_item_id, q.hotel_id`,
      [arcId]
    );
    const byItem = {};
    for (const r of rows) {
      const key = String(r.arc_item_id);
      (byItem[key] ||= []).push({ hotel_id: Number(r.hotel_id), indicative_qty: Number(r.indicative_qty) });
    }
    return byItem;
  },

  /**
   * Coverage narrowed without the items being resent: drop each item's
   * quantity for hotels no longer covered and re-total indicative_qty.
   */
  pruneItemHotelQtys: async (arcId, hotelIds, txContext = null) => {
    const runner = txContext || db;
    await runner.none(
      `DELETE FROM tbl_arc_item_hotel_qty q
        USING tbl_arc_item i
        WHERE i.id = q.arc_item_id AND i.arc_id = $1 AND q.hotel_id <> ALL($2::int[])`,
      [arcId, toIds(hotelIds)]
    );
    await runner.none(
      `UPDATE tbl_arc_item i
          SET indicative_qty = t.total, updated_at = CURRENT_TIMESTAMP
         FROM (SELECT arc_item_id, SUM(indicative_qty) AS total
                 FROM tbl_arc_item_hotel_qty GROUP BY arc_item_id) t
        WHERE t.arc_item_id = i.id AND i.arc_id = $1`,
      [arcId]
    );
  },

  /**
   * Record, for each invited vendor, the covered hotels it may quote for and
   * win. Replaces the ARC's previous snapshot.
   *
   * @param {Map<number, number[]>} hotelIdsByVendor — vendor id → hotel ids
   */
  setInvitationHotels: async (arcId, hotelIdsByVendor, txContext = null) => {
    const runner = txContext || db;
    await runner.none(
      `DELETE FROM tbl_arc_invitation_hotel
        WHERE arc_invitation_id IN (SELECT id FROM tbl_arc_invitation WHERE arc_id = $1)`,
      [arcId]
    );
    for (const [vendorId, hotelIds] of hotelIdsByVendor) {
      await runner.none(
        `INSERT INTO tbl_arc_invitation_hotel (arc_invitation_id, hotel_id)
         SELECT i.id, h FROM tbl_arc_invitation i, UNNEST($3::int[]) AS h
          WHERE i.arc_id = $1 AND i.vendor_id = $2
         ON CONFLICT (arc_invitation_id, hotel_id) DO NOTHING`,
        [arcId, Number(vendorId), toIds(hotelIds)]
      );
    }
  },

  /** { [vendor_id]: hotel_id[] } — each list ascending. */
  listInvitationHotels: async (arcId, txContext = null) => {
    const rows = await (txContext || db).any(
      `SELECT i.vendor_id, ih.hotel_id
         FROM tbl_arc_invitation_hotel ih
         JOIN tbl_arc_invitation i ON i.id = ih.arc_invitation_id
        WHERE i.arc_id = $1
        ORDER BY i.vendor_id, ih.hotel_id`,
      [arcId]
    );
    const byVendor = {};
    for (const r of rows) (byVendor[String(r.vendor_id)] ||= []).push(Number(r.hotel_id));
    return byVendor;
  },

  /**
   * The hotels this vendor may quote for on this ARC. A single-hotel ARC: its
   * hotel. A group ARC: the vendor's invitation snapshot (empty if not invited).
   *
   * @param {{ id, hotel_id, is_group }} arc
   */
  vendorInvitedHotelIds: async (arc, vendorId, txContext = null) => {
    if (!arc.is_group) return [Number(arc.hotel_id)];
    const rows = await (txContext || db).any(
      `SELECT ih.hotel_id
         FROM tbl_arc_invitation_hotel ih
         JOIN tbl_arc_invitation i ON i.id = ih.arc_invitation_id
        WHERE i.arc_id = $1 AND i.vendor_id = $2
        ORDER BY ih.hotel_id`,
      [arc.id, Number(vendorId)]
    );
    return rows.map((r) => Number(r.hotel_id));
  },

  /**
   * Replace an award's per-hotel split (rows with a positive quantity only).
   *
   * @param {Array<{ hotel_id: number, allocated_qty: number }>} rows
   */
  setAwardHotels: async (awardId, rows, txContext = null) => {
    const runner = txContext || db;
    await runner.none(
      `DELETE FROM tbl_arc_comm_evaluation_award_hotel WHERE arc_comm_evaluation_award_id = $1`,
      [awardId]
    );
    for (const row of rows || []) {
      if (!(Number(row.allocated_qty) > 0)) continue;
      await runner.none(
        `INSERT INTO tbl_arc_comm_evaluation_award_hotel (arc_comm_evaluation_award_id, hotel_id, allocated_qty)
         VALUES ($1, $2, $3)`,
        [awardId, Number(row.hotel_id), Number(row.allocated_qty)]
      );
    }
  },

  /** { [award_id]: [{ hotel_id, allocated_qty }] } for a commercial evaluation. */
  listAwardHotels: async (commEvalId, txContext = null) => {
    const rows = await (txContext || db).any(
      `SELECT h.arc_comm_evaluation_award_id AS award_id, h.hotel_id, h.allocated_qty
         FROM tbl_arc_comm_evaluation_award_hotel h
         JOIN tbl_arc_comm_evaluation_award a ON a.id = h.arc_comm_evaluation_award_id
        WHERE a.arc_comm_evaluation_id = $1
        ORDER BY h.arc_comm_evaluation_award_id, h.hotel_id`,
      [commEvalId]
    );
    const byAward = {};
    for (const r of rows) {
      (byAward[String(r.award_id)] ||= []).push({ hotel_id: Number(r.hotel_id), allocated_qty: Number(r.allocated_qty) });
    }
    return byAward;
  },

  /**
   * Bring a contract line's per-hotel ledger in line with its award.
   *
   * committed_qty follows the award; consumed_qty is NEVER reset, so a
   * clarification-driven regeneration keeps what each hotel has already
   * called off. A hotel dropped from the award loses its row, unless it has
   * already consumed something — then its row stays, committed at 0, so the
   * usage history survives.
   *
   * @param {Array<{ hotel_id: number, allocated_qty: number }>} awardHotels
   */
  syncContractLineHotels: async (contractLineId, awardHotels, txContext = null) => {
    const runner = txContext || db;
    const keep = [];
    for (const row of awardHotels || []) {
      keep.push(Number(row.hotel_id));
      await runner.none(
        `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty)
         VALUES ($1, $2, $3)
         ON CONFLICT (arc_contract_line_id, hotel_id) DO UPDATE
           SET committed_qty = EXCLUDED.committed_qty, updated_at = CURRENT_TIMESTAMP`,
        [contractLineId, Number(row.hotel_id), Number(row.allocated_qty)]
      );
    }
    await runner.none(
      `DELETE FROM tbl_arc_contract_line_hotel
        WHERE arc_contract_line_id = $1 AND hotel_id <> ALL($2::int[]) AND consumed_qty = 0`,
      [contractLineId, keep]
    );
    await runner.none(
      `UPDATE tbl_arc_contract_line_hotel
          SET committed_qty = 0, updated_at = CURRENT_TIMESTAMP
        WHERE arc_contract_line_id = $1 AND hotel_id <> ALL($2::int[])`,
      [contractLineId, keep]
    );
  },

  /**
   * Drop coverage and per-hotel quantities — a group draft becoming a
   * single-hotel draft.
   */
  clearGroupRows: async (arcId, txContext = null) => {
    const runner = txContext || db;
    await runner.none(
      `DELETE FROM tbl_arc_item_hotel_qty
        WHERE arc_item_id IN (SELECT id FROM tbl_arc_item WHERE arc_id = $1)`,
      [arcId]
    );
    await runner.none(`DELETE FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [arcId]);
  },
};

export default arcHotelModel;
