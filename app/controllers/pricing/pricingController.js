import { logError } from "../../helper/common.js";
import pricingEngine, { deriveMrpLine } from "../../services/pricingEngine.js";

const pricingController = {
  // Stateless live-preview endpoint. Takes a draft list of items + global
  // charges, returns engine-computed totals. No DB writes, no quote/PO state
  // accessed. Used by the frontend to drive the live grand-total display in
  // send-quote and PO-edit while the user is still editing.
  previewTotals: async (req, res, next) => {
    try {
      const { items, global_charges } = req.body || {};

      if (!Array.isArray(items)) {
        return res
          .status(400)
          .json({
            status: 0,
            message: "items must be an array of line objects",
          })
          .end();
      }

      // MRP support is additive and opt-in per item: an item may carry
      // pricing_method/entered_mrp/mrp_discount/mrp_discount_mode. When
      // pricing_method === 'MRP', resolve to the canonical exclusive shape
      // (derived base into unit_price) BEFORE the engine runs. Items without
      // pricing_method (PO edit, Traditional lines) pass through untouched.
      const resolved = items.map((it) => {
        if (it && it.pricing_method === "MRP") {
          const { base } = deriveMrpLine({
            mrp: it.entered_mrp,
            discount: it.mrp_discount,
            discount_mode: it.mrp_discount_mode,
            gst_pct: it.tax,
          });
          // GST on an MRP item is always a percentage extracted from within the
          // price; force tax_mode so the preview total matches what the write
          // paths (createQuote/submitQuote) will persist — a preview must never
          // show a different number than the authoritative recompute. other_charges
          // stay as-is (they legitimately add on top of the derived base).
          return { ...it, unit_price: base, tax_mode: "percentage" };
        }
        return it;
      });

      const totals = pricingEngine.calculateDocumentTotals(
        resolved,
        Array.isArray(global_charges) ? global_charges : []
      );

      return res
        .status(200)
        .json({ status: 1, message: "OK", data: totals })
        .end();
    } catch (err) {
      logError("pricingController.previewTotals", err);
      return res
        .status(500)
        .json({ status: 3, message: "Failed to compute totals" })
        .end();
    }
  },
};

export default pricingController;
