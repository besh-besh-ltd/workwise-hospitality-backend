import { logError } from "../../helper/common.js";
import pricingEngine from "../../services/pricingEngine.js";

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

      const totals = pricingEngine.calculateDocumentTotals(
        items,
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
