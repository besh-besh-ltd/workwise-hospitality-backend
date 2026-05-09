import express from "express";
import passport from "passport";
import unitsController from "../../controllers/units/unitsController.js";
import { validateBody, validateParam } from "../../validations/paramValidation/userValidation.js";
import { unitsSchemas } from "../../validations/paramValidation/unitsValidation.js";

const passportSignIn = passport.authenticate("jwtUsr", { session: false });

const router = express.Router();

// Defaults + this user's customs.
router.get("/", passportSignIn, unitsController.listUnits);

// Add a custom unit owned by the authenticated user.
router.post("/", passportSignIn, validateBody(unitsSchemas.create), unitsController.addUnit);

// Delete one of the user's own custom units. Owner-check enforced server-side.
router.delete("/:id", passportSignIn, validateParam(unitsSchemas.id), unitsController.deleteUnit);

export default router;
