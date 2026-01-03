import passport from 'passport';
import Config from '../config/app.config.js';
import { logError } from '../helper/common.js';
import adminModel from '../models/adminModel.js';
import Cryptr from 'cryptr';
const cryptr = new Cryptr(Config.cryptR.secret);

import JWT from 'jsonwebtoken';
import db from '../config/dbConn.js';

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
      const companyId = req.headers["x-company-id"] || req.user.company_id;

      // Multi-hotel support: parse from header or query
      // Priority: x-hotel-ids (multiple) > x-hotel-id (single) > query.hotel_id
      let hotelIds = [];
      if (req.headers["x-hotel-ids"]) {
        hotelIds = req.headers["x-hotel-ids"]
          .split(",")
          .map(id => parseInt(id.trim(), 10))
          .filter(id => !isNaN(id) && id > 0);
      } else if (req.headers["x-hotel-id"]) {
        const id = parseInt(req.headers["x-hotel-id"], 10);
        if (!isNaN(id) && id > 0) hotelIds = [id];
      } else if (req.query.hotel_id) {
        const id = parseInt(req.query.hotel_id, 10);
        if (!isNaN(id) && id > 0) hotelIds = [id];
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
          GROUP BY urs.user_id
          HAVING COUNT(DISTINCT (p.resource || '.' || p.action)) = $5
          `,
          [userId, companyId, hotelIds.length > 0 ? hotelIds : null, permKeys, permKeys.length]
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
          LIMIT 1
          `,
          [userId, companyId, hotelIds.length > 0 ? hotelIds : null, permKeys]
        );
      }

      if (!hasPermission) {
        return res.status(403).json({
          status: false,
          message: "You do not have permission to perform this action"
        });
      }

      // Attach context to request for downstream use
      req.permissionContext = { hotelIds, permKeys, needEvery };

      return next();
    } catch (err) {
      console.error("RBAC can() error:", err);
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
              user = await adminModel.getUserById(cryptr.decrypt(payload.sub));
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
  authUserOrGRNToken: (req, res, next) => {
    // Use passport in "custom callback" mode
    console.log("REQ BODY:", req.body);
    passport.authenticate(
      "jwtUsr",
      { session: false },
      async (err, user, info) => {
        console.log("LOGGED IN USING PASSPORT AUTHENTICATE")
        if (err) {
          return next(err);
        }

        // If normal user auth works, proceed as usual
        if (user) {
          console.log("USER FOUND AUTHENTICATED QUICKLY")
          req.user = user;
          return next();
        }

        // Fallback to GRN token auth
        const { token } = req.query;

        let po_id = null;
        if(req.params.po_id) {
          po_id = req.params.po_id
        } else if (req.body.po_id) {
          po_id = req.body.po_id
        }

        console.log("UNAUTHENTICATED TOKEN:", token, " PO ID:", po_id);

        if (!token || !po_id) {
          // No JWT and no token → unauthorized
          return res.status(403).json({
            status: 0,
            message: "Unauthorized: missing authentication or token.",
          });
        }

        try {
          // Validate token against tbl_token_login_data
          const tokenRow = await db.oneOrNone(
            `
              SELECT id, token_type, entity_id, name, email, phone, token
              FROM tbl_token_login_data
              WHERE token_type = $1
                AND entity_id = $2
                AND token = $3
            `,
            ["GRN", Number(po_id), token]
          );

          console.log("TOKEN ROW:", tokenRow);

          if (!tokenRow) {
            console.log("TOKEN ROW NOT FOUND!")
            return res.status(403).json({
              status: 0,
              message: "Forbidden: invalid or expired GRN token.",
            });
          }

          // Mock user object representing Site Representative (token-based)
          req.user = {
            id: -1, // special marker for "token login / site rep"
            name: tokenRow.name,
            email: tokenRow.email,
            phone: tokenRow.phone,
            tokenLoginId: tokenRow.id,
            tokenType: tokenRow.token_type,
            entityId: tokenRow.entity_id,
            is_token_user: true,
          };

          console.log("REQ USER:", req.user);

          return next();
        } catch (dbErr) {
          console.error("Error validating GRN token:", dbErr);
          return next(dbErr);
        }
      }
    )(req, res, next);
  },
};
export default auth;
