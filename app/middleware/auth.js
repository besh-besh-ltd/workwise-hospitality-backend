import passport from 'passport';
import Config from '../config/app.config.js';
import { logError } from '../helper/common.js';
import adminModel from '../models/adminModel.js';
import Cryptr from 'cryptr';
const cryptr = new Cryptr(Config.cryptR.secret);

import JWT from 'jsonwebtoken';
import db from '../config/dbConn.js';

export const can = (permKey) => {
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

      // hotel context (optional)
      const hotelId =
        req.headers["x-hotel-id"] ||
        req.query.hotel_id ||
        null;

      const [resource, action] = permKey.split(".");

      if (!resource || !action) {
        throw new Error("Invalid permission key format");
      }

      const hasPermission = await db.oneOrNone(
        `
        SELECT 1
        FROM tbl_user_role_scopes urs
        JOIN tbl_role_permissions rp
          ON rp.role_id = urs.role_id
        JOIN tbl_permissions p
          ON p.id = rp.permission_id
        WHERE urs.user_id = $1
          AND urs.company_id = $2
          AND (
            urs.hotel_id IS NULL
            OR urs.hotel_id = $3
          )
          AND p.resource = $4
          AND p.action = $5
        LIMIT 1
        `,
        [
          userId,
          companyId,
          hotelId,
          resource,
          action
        ]
      );

      if (!hasPermission) {
        return res.status(403).json({
          status: false,
          message: "You do not have permission to perform this action"
        });
      }

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
