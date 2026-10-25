import passport from 'passport';
import Config from '../config/app.config.js';
import { logError } from '../helper/common.js';
import { logger } from '../util/logger.js';
import adminModel from '../models/adminModel.js';
import { decryptClaim } from '../helper/claimCrypto.js';

import JWT from 'jsonwebtoken';
import db from '../config/dbConn.js';
import { findLiveReceiveToken, tokenRequestUser, RECEIVE_TOKEN_HEADER } from '../helper/receiveToken.js';
import { receiveTokenAuth } from './receiveTokenAuth.js';
import { admitReceiveToken, sendTooManyRequests } from './receiveTokenRateLimit.js';

/**
 * RBAC permission middleware
 * @param {string|string[]} permKey - Single permission key (e.g., 'tender.create') or array of permissions
 * @param {boolean} needEvery - If true, user needs ALL permissions (AND logic). Default false (OR logic).
 *
 * Usage examples:
 *   can('tender.create')                           // Single permission
 *   can(['rfq.create', 'tender.create'])           // Multiple, OR logic (default)
 *   can(['rfq.create', 'tender.create'], true)     // Multiple, AND logic
 *
 * Headers:
 *   x-hotel-id: 123           // Single hotel
 *   x-hotel-ids: 1,2,3        // Multiple hotels (OR logic)
 */
export const can = (permKey, needEvery = false) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          status: false,
          message: "Unauthorized"
        });
      }

      const userId = req.user.id;
      const companyId = req.headers["x-company-id"]
        || req.headers["x-hospitality-company"]
        || req.user.company_id;

      // Multi-hotel support: parse from header or query
      // Priority: x-hotel-ids (multiple) > x-hotel-id / x-hospitality-hotel (single) > query.hotel_id
      let hotelIds = [];
      if (req.headers["x-hotel-ids"]) {
        hotelIds = req.headers["x-hotel-ids"]
          .split(",")
          .map(id => parseInt(id.trim(), 10))
          .filter(id => !isNaN(id) && id > 0);
      } else if (req.headers["x-hotel-id"] || req.headers["x-hospitality-hotel"]) {
        const id = parseInt(req.headers["x-hotel-id"] || req.headers["x-hospitality-hotel"], 10);
        if (!isNaN(id) && id > 0) hotelIds = [id];
      } else if (req.query.hotel_id) {
        const id = parseInt(req.query.hotel_id, 10);
        if (!isNaN(id) && id > 0) hotelIds = [id];
      }

      // Parse department_id from header or query
      let departmentId = null;
      if (req.headers["x-department-id"]) {
        const id = parseInt(req.headers["x-department-id"], 10);
        if (!isNaN(id) && id > 0) departmentId = id;
      } else if (req.query.department_id) {
        const id = parseInt(req.query.department_id, 10);
        if (!isNaN(id) && id > 0) departmentId = id;
      }

      // Multi-permission support: normalize to array
      const permKeys = Array.isArray(permKey) ? permKey : [permKey];

      // Validate permission key formats
      for (const key of permKeys) {
        const [resource, action] = key.split(".");
        if (!resource || !action) {
          throw new Error(`Invalid permission key format: ${key}`);
        }
      }

      // All resources are department-scoped — always apply department filter when provided
      const effectiveDeptId = departmentId;

      let hasPermission;

      if (needEvery && permKeys.length > 1) {
        // AND logic: user must have ALL permissions
        // Count distinct matching permissions, must equal total required
        hasPermission = await db.oneOrNone(
          `
          SELECT 1
          FROM tbl_user_role_scopes urs
          JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
          JOIN tbl_permissions p ON p.id = rp.permission_id
          WHERE urs.user_id = $1
            AND urs.company_id = $2
            AND (
              urs.hotel_id IS NULL
              ${hotelIds.length > 0 ? 'OR urs.hotel_id = ANY($3::int[])' : ''}
            )
            AND (p.resource || '.' || p.action) = ANY($4::text[])
            AND (
              $6::int IS NULL
              OR urs.department_id = $6
              OR urs.department_id IS NULL
            )
          GROUP BY urs.user_id
          HAVING COUNT(DISTINCT (p.resource || '.' || p.action)) = $5
          `,
          [userId, companyId, hotelIds.length > 0 ? hotelIds : null, permKeys, permKeys.length, effectiveDeptId]
        );
      } else {
        // OR logic: user needs ANY one of the permissions
        hasPermission = await db.oneOrNone(
          `
          SELECT 1
          FROM tbl_user_role_scopes urs
          JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
          JOIN tbl_permissions p ON p.id = rp.permission_id
          WHERE urs.user_id = $1
            AND urs.company_id = $2
            AND (
              urs.hotel_id IS NULL
              ${hotelIds.length > 0 ? 'OR urs.hotel_id = ANY($3::int[])' : ''}
            )
            AND (p.resource || '.' || p.action) = ANY($4::text[])
            AND (
              $5::int IS NULL
              OR urs.department_id = $5
              OR urs.department_id IS NULL
            )
          LIMIT 1
          `,
          [userId, companyId, hotelIds.length > 0 ? hotelIds : null, permKeys, effectiveDeptId]
        );
      }

      if (!hasPermission) {
        return res.status(403).json({
          status: false,
          message: "You do not have permission to perform this action"
        });
      }

      // Attach context to request for downstream use
      req.permissionContext = { hotelIds, permKeys, needEvery, departmentId: effectiveDeptId };

      return next();
    } catch (err) {
      logError("RBAC can() error", err);
      return res.status(500).json({
        status: false,
        message: "Authorization check failed"
      });
    }
  };
};

const auth = {
  customer_auth: async (req, res, next) => {
    try {
      let error = 0;
      let user = [];
      if (req.headers.authorization) {
        const TokenArray = req.headers.authorization.split(' ');
        if (TokenArray[0] == 'Bearer') {
          let token = TokenArray[1];
          JWT.verify(token, Config.jwt.secret, async (err, payload) => {
            if (err) {
              error++;
            } else {
              if (!payload.user) {
                error++;
              }
              if (!payload.sub) {
                error++;
              }
              if (!payload.ag) {
                error++;
              }
              if (!payload.exp) {
                error++;
              } else {
                let current_time = Math.round(new Date().getTime() / 1000);
                if (current_time > payload.exp) {
                  error++;
                }
              }
              user = await adminModel.getUserById(decryptClaim(payload.sub));
            }

            if (user.length > 0 && error == 0) {
              req.user = user[0];
              next();
            } else {
              res.status(401).send('Unauthorized').end();
            }
          });
        } else {
          res.status(401).send('Unauthorized').end();
        }
      } else {
        next();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  /**
   * JWT user, else the GRN site-rep token (legacy GET /po/:po_id and
   * POST /po/markGRN). The token is accepted from the X-Receive-Token header or,
   * for links already in inboxes, the `token` query parameter; either way it is
   * bound to the request's po_id, compared by its sha256 hash, and must be
   * unrevoked and unexpired (helper/receiveToken.js). Refusal stays 403 so the
   * legacy GRN page behaves as before. The token is never logged.
   */
  authUserOrGRNToken: (req, res, next) => {
    passport.authenticate(
      "jwtUsr",
      { session: false },
      async (err, user) => {
        if (err) {
          return next(err);
        }

        // If normal user auth works, proceed as usual
        if (user) {
          req.user = user;
          return next();
        }

        // Fallback to the site-rep token.
        const token = req.get(RECEIVE_TOKEN_HEADER) || (typeof req.query?.token === 'string' ? req.query.token : null);
        const po_id = req.params?.po_id ?? req.body?.po_id ?? null;

        if (!token || !po_id) {
          return res.status(403).json({
            status: 0,
            message: "Unauthorized: missing authentication or token.",
          });
        }

        // Same per-token budget as /inventory/token/* (60 per 10 minutes).
        const rate = admitReceiveToken(token);
        if (!rate.allowed) return sendTooManyRequests(req, res, rate.retryAfterS);

        try {
          const tok = await findLiveReceiveToken(token, { poId: po_id });
          if (!tok) {
            logger.info({ route: req.originalUrl?.split('?')[0], method: req.method }, '[grn-token] refused');
            return res.status(403).json({
              status: 0,
              message: "Forbidden: invalid or expired GRN token.",
            });
          }

          // The GRN site representative, bound to exactly this PO.
          req.user = tokenRequestUser(tok);
          req.receiveToken = { tokenId: tok.id, poId: tok.poId, hotelId: tok.hotelId };
          logger.info(
            { tokenId: tok.id, poId: tok.poId, route: req.originalUrl?.split('?')[0], method: req.method },
            '[grn-token] used'
          );
          return next();
        } catch (dbErr) {
          logError("Error validating GRN token", dbErr);
          return next(dbErr);
        }
      }
    )(req, res, next);
  },
  receiveTokenAuth,
};
export { receiveTokenAuth };
export default auth;
