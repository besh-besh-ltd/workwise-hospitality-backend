// /api/v1/vendor-network/* (spec §4-§5). Every route but the two public
// /member-invites ones is acl([3]): after jwtUsr a
// type-11 person is already acting as a type-3 entity. Scope comes from req.user;
// admin-only handlers check requireOrgAdmin themselves.
import { Router } from "express";
import passport from "../../middleware/passport.js";
import { acl } from "../../helper/common.js";
// Register the RFQ and ARC_HOTEL routing subjects with the engine (module side effects).
import "../../services/vendorNetwork/subjects/rfqSubject.js";
import "../../services/vendorNetwork/subjects/arcHotelSubject.js";
import {
  switchEntity,
  createOrg,
  getOrg,
  updateOrg,
  paySeats,
  verifySeatsPayment,
} from "../../controllers/vendorNetwork/orgController.js";
import {
  dashboardSummary,
  dashboardPos,
  dashboardContracts,
} from "../../controllers/vendorNetwork/dashboardController.js";
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
import {
  listOrgMembers,
  inviteMember,
  updateMember,
  resendMemberInvite,
  previewMemberInvite,
  retiredPreviewMemberInvite,
  acceptMemberInvite,
} from "../../controllers/vendorNetwork/memberController.js";
import {
  getCoverage,
  putCoverage,
  lookupStates,
  lookupCities,
  lookupHotels,
} from "../../controllers/vendorNetwork/coverageController.js";
import {
  routingQueue,
  assignSubject,
  revokeAssignment,
  assignedToMe,
  respondToAssignment,
} from "../../controllers/vendorNetwork/routingController.js";

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

// People (§5): admin-managed type-11 logins
VendorNetworkRoutes.get("/members", ...vendor, listOrgMembers);
VendorNetworkRoutes.post("/members", ...vendor, inviteMember);
VendorNetworkRoutes.patch("/members/:id", ...vendor, updateMember);
VendorNetworkRoutes.post("/members/:id/resend", ...vendor, resendMemberInvite);

// Member invite accept page: PUBLIC (no session yet). The 256-bit emailed token is the credential.
VendorNetworkRoutes.post("/member-invites/accept", acceptMemberInvite);
VendorNetworkRoutes.post("/member-invites/preview", previewMemberInvite);
// Retired (token in the path reaches access logs): always 410, the token is never read.
VendorNetworkRoutes.get("/member-invites/:token", retiredPreviewMemberInvite);

// Coverage rules (§6.1): static lookup paths before /coverage/:vendorId
VendorNetworkRoutes.get("/coverage/lookup/states", ...vendor, lookupStates);
VendorNetworkRoutes.get("/coverage/lookup/cities", ...vendor, lookupCities);
VendorNetworkRoutes.get("/coverage/lookup/hotels", ...vendor, lookupHotels);
VendorNetworkRoutes.get("/coverage/:vendorId", ...vendor, getCoverage);
VendorNetworkRoutes.put("/coverage/:vendorId", ...vendor, putCoverage);

// Routing (§6.2): static paths before /routing/:id
VendorNetworkRoutes.get("/routing/queue", ...vendor, routingQueue);
VendorNetworkRoutes.get("/routing/assigned-to-me", ...vendor, assignedToMe);
VendorNetworkRoutes.post("/routing/assign", ...vendor, assignSubject);
VendorNetworkRoutes.post("/routing/:id/revoke", ...vendor, revokeAssignment);
VendorNetworkRoutes.post("/routing/:id/respond", ...vendor, respondToAssignment);

// HQ dashboard (§8), admin only
VendorNetworkRoutes.get("/dashboard/summary", ...vendor, dashboardSummary);
VendorNetworkRoutes.get("/dashboard/pos", ...vendor, dashboardPos);
VendorNetworkRoutes.get("/dashboard/contracts", ...vendor, dashboardContracts);

// Seats (§5.1)
VendorNetworkRoutes.post("/seats/pay", ...vendor, paySeats);
VendorNetworkRoutes.post("/seats/verify-payment", ...vendor, verifySeatsPayment);

export default VendorNetworkRoutes;
