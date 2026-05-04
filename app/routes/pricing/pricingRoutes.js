import { Router } from "express";
import passport from "../../middleware/passport.js";
import pricingController from "../../controllers/pricing/pricingController.js";

const passportSignIn = passport.authenticate("jwtUsr", { session: false });

const pricingRoutes = Router();

// Live-preview: returns server-computed totals for a draft set of line items.
// Both buyer and vendor user types may call it (PO-edit and send-quote both
// hit this same endpoint). Authentication required to prevent unauthenticated
// scraping of the calculation engine.
pricingRoutes.post("/preview", passportSignIn, pricingController.previewTotals);

export default pricingRoutes;
