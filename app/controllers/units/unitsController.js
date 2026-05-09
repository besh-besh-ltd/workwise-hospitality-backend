import unitsModel from "../../models/unitsModel.js";
import { logger } from "../../util/logger.js";

const unitsController = {
  /**
   * GET /api/v1/units
   * Returns global defaults plus the authenticated user's own customs.
   * Shape: { status: 1, data: [{ id, name, is_default }] }
   */
  listUnits: async (req, res) => {
    try {
      const userId = req.user?.id;
      const rows = await unitsModel.listForUser(userId);
      return res.json({ status: 1, data: rows });
    } catch (err) {
      logger?.error?.("listUnits failed", err);
      return res.status(500).json({ status: 3, message: err.message || "Failed to load units" });
    }
  },

  /**
   * POST /api/v1/units  body: { name }
   * Creates a custom unit owned by the authenticated user.
   * On unique-constraint violation (PG 23505) returns 409 with the
   * existing matching row so the frontend can select it instead of
   * surfacing a duplicate-error.
   */
  addUnit: async (req, res) => {
    try {
      const userId = req.user?.id;
      const name = (req.body?.name || "").trim();
      if (!name) {
        return res.status(400).json({ status: 0, message: "Unit name is required" });
      }
      const row = await unitsModel.insertForUser(userId, name);
      return res.json({ status: 1, data: row });
    } catch (err) {
      // PG unique violation — the (LOWER(name), created_by) pair already exists
      if (err && err.code === "23505") {
        const existing = await unitsModel.findByName(req.user.id, (req.body?.name || "").trim());
        return res.status(409).json({
          status: 0,
          message: "Unit already exists",
          data: existing || null,
        });
      }
      logger?.error?.("addUnit failed", err);
      return res.status(500).json({ status: 3, message: err.message || "Failed to add unit" });
    }
  },

  /**
   * DELETE /api/v1/units/:id
   * Deletes one of the user's own custom units. Globals (created_by IS
   * NULL) are not deletable; an owner-mismatch returns 404.
   */
  deleteUnit: async (req, res) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params?.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ status: 0, message: "Invalid unit id" });
      }
      const row = await unitsModel.deleteOwn(userId, id);
      if (!row) {
        return res.status(404).json({ status: 2, message: "Custom unit not found" });
      }
      return res.json({ status: 1, message: "Custom unit removed" });
    } catch (err) {
      logger?.error?.("deleteUnit failed", err);
      return res.status(500).json({ status: 3, message: err.message || "Failed to delete unit" });
    }
  },
};

export default unitsController;
