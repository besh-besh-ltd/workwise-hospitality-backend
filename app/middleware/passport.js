import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { encode } from 'html-entities';
import Moment from 'moment';
import Cryptr from 'cryptr';
import bcrypt from 'bcryptjs';
import Config from '../config/app.config.js';
import adminModel from '../models/adminModel.js';
import userModel from '../models/userModel.js';

const cryptr = new Cryptr(Config.cryptR.secret);

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
      console.error('passport error');
      done(error, false);
    }
  })
);

passport.use(
  'localUsr',
  new LocalStrategy(
    {
      usernameField: 'email',
      passwordField: 'password'
    },
    async (username, password, done) => {
      try {
        let user = await userModel.getUserAuthEmail(username);
        // console.log('username--', username);
        // console.log('user_passport--', user);
        let user_dtls = Object.assign({}, ...user);
        // console.log('user_dtls_passport--', user_dtls);
        if (Object.keys(user_dtls).length > 0) {
          let isMatch = '';
          if (user_dtls.password == null) {
            console.log('Case 1');
            return done(null, {
              id: 0,
              err_msg:
                'Password not set. Please click forgot password to set new password'
            });
          } else {
            // console.log('Case 2');
            isMatch = await isValidPassword(password, user_dtls.password);
          }
          // console.log('Case 22', isMatch);
          const isMatchAdminApprove = user_dtls.status;
          if (!isMatch) {
            return done(null, { id: 0, err_msg: 'Password not matched' });
          } else {
            if (isMatchAdminApprove != '1') {
              return done(null, {
                id: 0,
                err_msg: 'User not approved by admin'
              });
            } else {
              return done(null, user_dtls);
            }
          }
        } else {
          return done(null, { id: 0 });
        }
      } catch (error) {
        console.error('passport error');
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

        const user = await adminModel.getUserById(cryptr.decrypt(payload.sub));

        if (user.length > 0) {
          return done(null, user[0]);
        } else {
          return done(null, false, { message: 'Unauthorized' });
        }
      } catch (error) {
        console.error('passport error');
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

        let user = await userModel.user_detail_check(
          cryptr.decrypt(payload.sub)
        );

        let user_details = Object.assign({}, ...user);
        if (
          user.length > 0 &&
          cryptr.decrypt(payload.ag) == user_details.user_agent
        ) {
          return done(null, Object.assign({}, ...user));
        } else {
          return done(null, false, { message: 'Unauthorized' });
        }
      } catch (error) {
        console.error('passport error');
        done(error, false);
      }
    }
  )
);

export default passport;
