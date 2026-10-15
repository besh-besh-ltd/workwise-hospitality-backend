import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { encode } from 'html-entities';
import Moment from 'moment';
import bcrypt from 'bcryptjs';
import Config from '../config/app.config.js';
import adminModel from '../models/adminModel.js';
import userModel from '../models/userModel.js';
import { logger } from '../util/logger.js';
// Claim decryption only (never the auth decision) — see app/helper/claimCrypto.js.
import { decryptClaim } from '../helper/claimCrypto.js';
import { resolveFromTokenPayload } from '../services/vendorNetwork/actingContext.js';
import { markGuestSession } from '../helper/guestSession.js';
import {
  VENDOR_MEMBER_USER_TYPE,
  NETWORK_MANAGED_MESSAGE
} from '../constants/vendorNetwork.js';
import { isNetworkManagedLogin } from '../models/vendorNetworkModel.js';

// import models from '../models/productModel.js';
// const userModel = models.user;

const isValidPassword = async function (newPassword, existingPassword) {
  try {
    //console.log(newPassword + '' + existingPassword);
    return await bcrypt.compare(newPassword, existingPassword);
  } catch (error) {
    throw new Error(error);
  }
};

passport.use(
  'localAdm',
  new LocalStrategy(async (username, password, done) => {
    try {
      let user = await adminModel.getUser(username);
      if (user.length > 0) {
        const isMatch = await isValidPassword(password, user[0].password);
        if (!isMatch) {
          return done(null, { id: 0 });
        } else {
          return done(null, user[0]);
        }
      } else {
        return done(null, { id: 0 });
      }
    } catch (error) {
      logger.error('passport error');
      done(error, false);
    }
  })
);

passport.use(
  'localUsr',
  new LocalStrategy(
    {
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true
    },
    async (req, username, password, done) => {
      try {
        const employeeCode = req.body.employee_code;
        let user;
        if (employeeCode) {
          user = await userModel.getUserAuthByEmployeeCode(employeeCode);
        } else {
          user = await userModel.getUserAuthEmail(username?.toLowerCase());
        }
        // console.log('username--', username);
        // console.log('user_passport--', user);
        let user_dtls = Object.assign({}, ...user);
        // console.log('user_dtls_passport--', user_dtls);
        if (Object.keys(user_dtls).length > 0) {
          // Restrict buyer login to Employee Code only. Vendors (user_type === '3') unchanged.
          const usedEmployeeCode = !!req.body.employee_code;
          const isBuyer = String(user_dtls.user_type) === '2';
          if (isBuyer && !usedEmployeeCode) {
            return done(null, {
              id: 0,
              err_msg: 'Please use your Employee Code to login. Email login is only for vendors.'
            });
          }
          let isMatch = '';
          if (user_dtls.password == null) {
            logger.debug('Case 1');
            // A passwordless network entity is reached through its people's
            // memberships; "forgot password" would be refused anyway (§4.2).
            if (await isNetworkManagedLogin(user_dtls.id)) {
              return done(null, { id: 0, err_msg: NETWORK_MANAGED_MESSAGE });
            }
            return done(null, {
              id: 0,
              err_msg:
                'Password not set. Please click forgot password to set new password'
            });
          } else {
            // console.log('Case 2');
            // A stored value bcrypt cannot read is a failed login, never a 500.
            isMatch = await isValidPassword(password, user_dtls.password).catch(() => false);
          }
          // console.log('Case 22', isMatch);
          const isMatchAdminApprove = user_dtls.status;
          // A network person (user_type 11) holds no subscription of its own, so an
          // inactive (INVITED) one gets the plain not-approved message, never the
          // hospitality payment flow.
          const isHospitalityVendor =
            Number(user_dtls.user_type) !== VENDOR_MEMBER_USER_TYPE &&
            (user_dtls.is_hospitality === 1 || user_dtls.is_hospitality === '1');
          const sanitizedUser = { ...user_dtls };
          delete sanitizedUser.password;
          if (!isMatch) {
            return done(null, { id: 0, err_msg: 'Password not matched' });
          } else {
            if (isMatchAdminApprove != '1') {
              if (isHospitalityVendor) {
                return done(null, {
                  ...sanitizedUser,
                  login_status: 'hospitality_pending'
                });
              }
              return done(null, {
                id: 0,
                err_msg: 'User not approved by admin'
              });
            } else {
              return done(null, sanitizedUser);
            }
          }
        } else {
          return done(null, { id: 0 });
        }
      } catch (error) {
        logger.error('passport error');
        done(error, false);
      }
    }
  )
);
passport.use(
  'jwtAdm',
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: Config.jwt.secret
    },
    async (payload, done) => {
      try {
        if (!payload.admin) {
          return done(null, false, { message: 'Unauthorized' });
        }
        if (!payload.sub) {
          return done(null, false, { message: 'Unauthorized' });
        }
        if (!payload.ag) {
          return done(null, false, { message: 'Unauthorized' });
        }
        if (!payload.exp) {
          return done(null, false, { message: 'Unauthorized' });
        } else {
          var current_time = Math.round(new Date().getTime() / 1000);
          if (current_time > payload.exp) {
            return done(null, false, { message: 'Unauthorized' });
          }
        }

        const user = await adminModel.getUserById(decryptClaim(payload.sub));

        if (user.length > 0) {
          // The token, not the account, is what makes this Workwise staff.
          // Three accounts hold user_type 7 and can sign in to both consoles;
          // the same person reading a client's RFQ through the client app is
          // that client's administrator, and reading it here is Workwise
          // looking at a customer. Only the token that was minted for this
          // console can tell those apart, so the mark is set here.
          return done(null, { ...user[0], is_internal_admin: true });
        } else {
          return done(null, false, { message: 'Unauthorized' });
        }
      } catch (error) {
        logger.error('passport error');
        done(error, false);
      }
    }
  )
);

passport.use(
  'jwtUsr',
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: Config.jwt.secret
    },
    async (payload, done) => {
      try {
        if (!payload.user) {
          return done(null, false, { message: 'Unauthorized' });
        }
        if (!payload.sub) {
          return done(null, false, { message: 'Unauthorized' });
        }
        if (!payload.ag) {
          return done(null, false, { message: 'Unauthorized' });
        }
        if (!payload.exp) {
          return done(null, false, { message: 'Unauthorized' });
        } else {
          var current_time = Math.round(new Date().getTime() / 1000);
          if (current_time > payload.exp) {
            return done(null, false, { message: 'Unauthorized' });
          }
        }

        // `sub` is the PERSON who logged in; `ag` is checked against that person.
        let user = await userModel.user_detail_check(
          decryptClaim(payload.sub)
        );

        let user_details = Object.assign({}, ...user);
        if (
          !(user.length > 0 &&
          decryptClaim(payload.ag) == user_details.user_agent)
        ) {
          return done(null, false, { message: 'Unauthorized' });
        }
        // Vendor Networks (spec §4.1): which entity this person acts as, re-checked
        // on every request so a revoked membership or removed entity is refused on
        // the very next call. A null context is a tampered/foreign `ent` -> 401.
        // Buyers and admins return immediately with no query and `ent` ignored.
        const ctx = await resolveFromTokenPayload(user_details, payload);
        if (!ctx) {
          return done(null, false, { message: 'Unauthorized' });
        }
        // A vendor in no network gets exactly today's object: no `network` key at all.
        const authed =
          ctx.network === undefined
            ? ctx.entityRow
            : { ...ctx.entityRow, network: ctx.network };
        // Emailed-link token: RFQ view/quote/regret only (helper/guestSession.js).
        if (payload.guest) markGuestSession(authed);
        return done(null, authed);
      } catch (error) {
        logger.error('passport error');
        done(error, false);
      }
    }
  )
);

export default passport;
