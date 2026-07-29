import db from '../../config/dbConn.js';

/**
 * ARC v2 — Vendor contract clarification model.
 *
 * A clarification is a vendor's pre-signature dispute on ONE field of an
 * awarded line. Raising clarifications rolls the ARC back to the commercial
 * stage; the commercial evaluator resolves each one (revise / uphold) and
 * re-finalises, which re-runs committee awarding and regenerates the contract.
 *
 * Keyed on arc_item_id (stable across regeneration), never the contract line.
 */
const arcContractClarificationModel = {
  // Disputable fields and where each one lives on the award snapshot.
  FIELDS: ['base_price', 'gst', 'charges', 'committed_qty', 'payment_terms', 'delivery_terms'],

  nextRound: async (arcContractId, txContext = null) => {
    const row = await (txContext || db).one(
      `SELECT COALESCE(MAX(round), 0) + 1 AS next
         FROM tbl_arc_contract_clarification WHERE arc_contract_id = $1`,
      [arcContractId]
    );
    return Number(row.next);
  },

  createMany: async (arcId, arcContractId, vendorId, items, raisedBy, round, txContext = null) => {
    const runner = txContext || db;
    const out = [];
    for (const it of items) {
      out.push(await runner.one(
        `INSERT INTO tbl_arc_contract_clarification
           (arc_id, arc_contract_id, arc_item_id, vendor_id, field, round,
            vendor_comment, old_value, status, raised_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'open', $9)
         RETURNING *`,
        [arcId, arcContractId, it.arc_item_id, vendorId, it.field, round,
         it.vendor_comment, JSON.stringify(it.old_value ?? null), raisedBy]
      ));
    }
    return out;
  },

  getById: async (id, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT * FROM tbl_arc_contract_clarification WHERE id = $1`, [id]
    );
  },

  countOpenForArc: async (arcId, txContext = null) => {
    const row = await (txContext || db).one(
      `SELECT COUNT(*)::int AS c
         FROM tbl_arc_contract_clarification
        WHERE arc_id = $1 AND status = 'open'`,
      [arcId]
    );
    return row.c;
  },

  // Open clarifications for the buyer's commercial view — enriched with item +
  // vendor names so the CE knows exactly what to edit.
  listOpenForArc: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT cc.*, pv.name AS variant_name, ai.uom, u.name AS vendor_name
         FROM tbl_arc_contract_clarification cc
         LEFT JOIN tbl_arc_item ai ON ai.id = cc.arc_item_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
         LEFT JOIN tbl_users u ON u.id = cc.vendor_id
        WHERE cc.arc_id = $1 AND cc.status = 'open'
        ORDER BY cc.arc_item_id, cc.id`,
      [arcId]
    );
  },

  // Every clarification on the ARC (all statuses) — the buyer's commercial
  // matrix overlays revised values on the awarded cell and shows provenance
  // (who revised, why) in a tooltip.
  listForArc: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT cc.*, pv.name AS variant_name, ai.uom,
              u.name AS vendor_name, ru.name AS resolved_by_name
         FROM tbl_arc_contract_clarification cc
         LEFT JOIN tbl_arc_item ai ON ai.id = cc.arc_item_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
         LEFT JOIN tbl_users u  ON u.id  = cc.vendor_id
         LEFT JOIN tbl_users ru ON ru.id = cc.resolved_by
        WHERE cc.arc_id = $1
        ORDER BY cc.arc_item_id, cc.id`,
      [arcId]
    );
  },

  // Every clarification on a contract (all statuses) — the vendor's accept page
  // shows open disputes AND resolved ones (revised/upheld) on re-review.
  listForContract: async (arcContractId, txContext = null) => {
    return (txContext || db).any(
      `SELECT cc.*, pv.name AS variant_name, ai.uom
         FROM tbl_arc_contract_clarification cc
         LEFT JOIN tbl_arc_item ai ON ai.id = cc.arc_item_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
        WHERE cc.arc_contract_id = $1
        ORDER BY cc.round DESC, cc.id`,
      [arcContractId]
    );
  },

  resolve: async (id, { status, buyer_response, old_value, new_value, resolved_by }, txContext = null) => {
    return (txContext || db).oneOrNone(
      `UPDATE tbl_arc_contract_clarification
          SET status        = $2,
              buyer_response = $3,
              old_value      = COALESCE($4::jsonb, old_value),
              new_value      = $5::jsonb,
              resolved_by    = $6,
              resolved_at    = CURRENT_TIMESTAMP,
              updated_at     = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [id, status, buyer_response ?? null,
       old_value === undefined ? null : JSON.stringify(old_value),
       JSON.stringify(new_value ?? null), resolved_by]
    );
  },
};

export default arcContractClarificationModel;
