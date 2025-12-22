import passport from 'passport';
import Config from '../config/app.config.js';
import { logError } from '../helper/common.js';
import adminModel from '../models/adminModel.js';
import Cryptr from 'cryptr';
const cryptr = new Cryptr(Config.cryptR.secret);

import JWT from 'jsonwebtoken';
import db from '../config/dbConn.js';

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
    passport.authenticate(
      "jwtUsr",
      { session: false },
      async (err, user, info) => {
        if (err) {
          return next(err);
        }

        // If normal user auth works, proceed as usual
        if (user) {
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

        console.log("UNAUTHENTICATED TOKEN:", token, " PO ID:", req.body);

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

          if (!tokenRow) {
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

          return next();
        } catch (dbErr) {
          console.error("Error validating GRN token:", dbErr);
          return next(dbErr);
        }
      }
    )(req, res, next);
  }
};
export default auth;
