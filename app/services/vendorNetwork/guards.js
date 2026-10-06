// Controller-level gates for Vendor Networks (spec §5, §10.5).
//
// Routes are role-gated with acl([3]); these decide on req.user.network, which
// jwtUsr resolved from the database on this very request. Each returns null when
// the caller may proceed, otherwise an { http, body } for the controller to send:
//
//   const denied = requireOrgAdmin(req);
//   if (denied) return res.status(denied.http).json(denied.body);

import { NETWORK_ROLE } from "../../constants/vendorNetwork.js";

const deny = (message) => ({ http: 403, body: { status: 0, message } });

/** The caller acts inside a vendor network. */
export function requireNetwork(req) {
  return req.user?.network ? null : deny("Vendor network access required");
}

/** The caller is an ORG_ADMIN of the network it is acting in. */
export function requireOrgAdmin(req) {
  return req.user?.network?.role === NETWORK_ROLE.ORG_ADMIN ? null : deny("Network admin access required");
}

export default { requireNetwork, requireOrgAdmin };
