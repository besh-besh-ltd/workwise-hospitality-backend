// /api/v1/vendor-network/* (spec §4-§5). Every route is acl([3]): after jwtUsr a
// type-11 person is already acting as a type-3 entity. Scope comes from req.user.
import { Router } from "express";
import passport from "../../middleware/passport.js";
import { acl } from "../../helper/common.js";
import { switchEntity } from "../../controllers/vendorNetwork/orgController.js";

const passportSignIn = passport.authenticate("jwtUsr", { session: false });

const VendorNetworkRoutes = Router();

VendorNetworkRoutes.post("/switch-entity", passportSignIn, acl([3]), switchEntity);

export default VendorNetworkRoutes;
