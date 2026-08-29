import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';

/**
 * Company administration as a capability, not a user type.
 *
 * `acl([7])` compares the single scalar `tbl_users.user_type`, which makes
 * admin and buyer mutually exclusive. Two things follow, and both block
 * handing the module to clients:
 *
 *   - Promoting a buyer would silently revoke their transactional access.
 *     There are 33 numeric `user_type` branches across the RFQ and PO read
 *     paths; one carries the comment "[Modified to include user_type 2, 3, 8,
 *     9, 10]" and does not list 7.
 *   - Admins have no tenant scope at all. Visibility is decided well below the
 *     route by `resolveHospitalityCompanyScope` (hospitality mappings) and
 *     `buildScopeExistsClause` (role scopes, 17 call sites), and every
 *     production admin holds zero of each — so they pass the gate and then see
 *     nothing.
 *
 * Holding the capability as a permission makes an administrator an ordinary
 * buyer who also holds `company.admin`: scoped like a buyer, listed like a
 * buyer, promotable without moving `user_type`.
 *
 * Read from the user's granted scopes and nothing else. Deliberately not
 * `can()`, which resolves permissions through the x-company-id / x-hotel-id
 * headers this codebase's own security work found untrustworthy — a gate that
 * can be influenced by a header is not a gate.
 */

const LEGACY_ADMIN_USER_TYPE = 7;

export const isCompanyAdmin = async (user) => {
  if (!user) return false;

  // Accepted deliberately, so landing the capability changes no existing
  // account's behaviour. Migrating the legacy accounts is a separate step,
  // after which this branch can go.
  if (Number(user.user_type) === LEGACY_ADMIN_USER_TYPE) return true;

  const userId = Number(user.id);
  if (!Number.isFinite(userId) || userId <= 0) return false;

  try {
    const row = await db.oneOrNone(
      `SELECT 1
         FROM tbl_user_role_scopes urs
         JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
         JOIN tbl_permissions p ON p.id = rp.permission_id
        WHERE urs.user_id = $1
          AND p.resource = 'company'
          AND p.action = 'admin'
        LIMIT 1`,
      [userId]
    );
    return Boolean(row);
  } catch (err) {
    // Fail closed. An administration gate that opens when its own check errors
    // is worse than one that is briefly unavailable.
    //
    // Not covered by a test: the query is parameterised and Postgres compares
    // even an out-of-range id without raising, so there is no way to reach
    // this from outside without breaking the database under the test. Mocking
    // the connection would assert the mock, not the behaviour.
    logger.error({ err: err.message, userId }, 'Could not resolve company admin capability');
    return false;
  }
};

/**
 * The same question, asked of a request, and asked at most once per request.
 *
 * Several handlers need it more than twice — a guard, then a branch that
 * widens a query's scope — and each call is a round trip. Memoised on `req`
 * for the same reason `resolveApprovalCompanyScope` is: within one request the
 * answer cannot change, and the alternative is three identical queries.
 */
export const requestIsCompanyAdmin = async (req) => {
  if (!req) return false;
  if (req.__isCompanyAdmin === undefined) {
    req.__isCompanyAdmin = await isCompanyAdmin(req.user);
  }
  return req.__isCompanyAdmin;
};

/**
 * Route guard. Replaces `acl([7])` on the company administration routes.
 */
export const requireCompanyAdmin = async (req, res, next) => {
  if (await requestIsCompanyAdmin(req)) return next();
  return res.status(403).json({ status: 0, message: 'Insufficient permissions' });
};

export default requireCompanyAdmin;
