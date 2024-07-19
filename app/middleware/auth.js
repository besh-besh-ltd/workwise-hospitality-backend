import Config from '../config/app.config.js';
import { logError } from '../helper/common.js';
import adminModel from '../models/adminModel.js';
import Cryptr from 'cryptr';
const cryptr = new Cryptr(Config.cryptR.secret);

import JWT from 'jsonwebtoken';

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
  }
};
export default auth;
