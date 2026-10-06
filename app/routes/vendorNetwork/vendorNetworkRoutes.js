// /api/v1/vendor-network/* (spec §4-§5). Every route is acl([3]): after jwtUsr a
// type-11 person is already acting as a type-3 entity. Scope comes from req.user;
// admin-only handlers check requireOrgAdmin themselves.
import { Router } from "express";
import passport from "../../middleware/passport.js";
import { acl } from "../../helper/common.js";
import {
  switchEntity,
  createOrg,
  getOrg,
  updateOrg,
  paySeats,
  verifySeatsPayment,
} from "../../controllers/vendorNetwork/orgController.js";
import {
  suggestions,
  createLinkInvite,
  incomingLinkInvites,
  acceptLinkInvite,
  declineLinkInvite,
  cancelLinkInvite,
  createEntity,
  updateEntity,
  deleteEntity,
  leaveNetwork,
} from "../../controllers/vendorNetwork/entityController.js";

const passportSignIn = passport.authenticate("jwtUsr", { session: false });
const vendor = [passportSignIn, acl([3])];

const VendorNetworkRoutes = Router();

VendorNetworkRoutes.post("/switch-entity", ...vendor, switchEntity);

// Org (§5)
VendorNetworkRoutes.post("/org", ...vendor, createOrg);
VendorNetworkRoutes.get("/org", ...vendor, getOrg);
VendorNetworkRoutes.patch("/org", ...vendor, updateOrg);

// Entities: static paths before /entities/:vendorId
VendorNetworkRoutes.get("/entities/suggestions", ...vendor, suggestions);
VendorNetworkRoutes.post("/entities/link-invites", ...vendor, createLinkInvite);
VendorNetworkRoutes.delete("/entities/link-invites/:id", ...vendor, cancelLinkInvite);
VendorNetworkRoutes.post("/entities/self/leave", ...vendor, leaveNetwork);
VendorNetworkRoutes.post("/entities", ...vendor, createEntity);
VendorNetworkRoutes.patch("/entities/:vendorId", ...vendor, updateEntity);
VendorNetworkRoutes.delete("/entities/:vendorId", ...vendor, deleteEntity);

// Link invites, answered by the target entity
VendorNetworkRoutes.get("/link-invites/incoming", ...vendor, incomingLinkInvites);
VendorNetworkRoutes.post("/link-invites/:id/accept", ...vendor, acceptLinkInvite);
VendorNetworkRoutes.post("/link-invites/:id/decline", ...vendor, declineLinkInvite);

// Seats (§5.1)
VendorNetworkRoutes.post("/seats/pay", ...vendor, paySeats);
VendorNetworkRoutes.post("/seats/verify-payment", ...vendor, verifySeatsPayment);

export default VendorNetworkRoutes;
