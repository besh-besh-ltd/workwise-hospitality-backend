import passport from 'passport';
import { acl, noAcl } from '../../helper/common.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

/** Buyer-side routes: signed in, vendors refused. Spread into each route. */
export const buyerGuard = [passportSignIn, noAcl([3])];

/** Vendor-side routes: signed in, vendors only. Spread into each route. */
export const vendorGuard = [passportSignIn, acl([3])];
