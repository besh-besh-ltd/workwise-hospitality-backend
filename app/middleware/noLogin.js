import passport from './passport.js';
import { validateDbBody } from "../validations/dbValidation/userDbValidation.js";
import db from '../config/dbConn.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const noLogin = {
    customer_auth: async (req, res, next) => {
        try {
            if (req.headers.authorization) {


                // Call passportSignIn and pass a custom 'next' function
                passportSignIn(req, res, (err) => {
                    if (err) {
                        // Pass errors to Express error handler
                        console.log(err);
                        return next(err);
                    }

                    // Call validateDbBody.user_id_profileexists after passportSignIn
                    validateDbBody.user_id_profileexists(req, res, (err) => {

                    // Set verification flag and proceed to the next middleware
                    req.is_verified = true;
                    return next();
                    });
                });
            } else {
                // No authorization header, mark as not verified and proceed
                req.is_verified = false;
                next();
            }
        } catch (error) {
            // Log error and respond with error status
            logError(error);
            res.status(400).json({
                status: 3,
                message: Config.errorText.value
            }).end();
        }
    },

    /**
     * Tries JWT auth first. If no Authorization header, falls back to
     * ?token= param validated against tbl_vendor_rfq_tokens_non_login.
     * Sets req.user with the vendor's user record in both cases.
     */
    vendorTokenOrJwt: async (req, res, next) => {
        try {
            if (req.headers.authorization) {
                passportSignIn(req, res, (err) => {
                    if (err) return next(err);
                    req.is_verified = true;
                    return next();
                });
            } else if (req.query.token) {
                const tokenData = await db.oneOrNone(
                    'SELECT vendor_id FROM tbl_vendor_rfq_tokens_non_login WHERE token = $1',
                    [req.query.token]
                );
                if (!tokenData) {
                    return res.status(400).json({ status: 0, message: 'Invalid or expired token' });
                }
                const user = await db.oneOrNone(
                    'SELECT id, name, email, user_type, company_id, status FROM tbl_users WHERE id = $1',
                    [tokenData.vendor_id]
                );
                if (!user) {
                    return res.status(404).json({ status: 0, message: 'Vendor not found' });
                }
                req.user = user;
                req.is_verified = false;
                next();
            } else {
                return res.status(401).json({ status: 0, message: 'Authentication required' });
            }
        } catch (error) {
            console.error('vendorTokenOrJwt error:', error);
            return res.status(400).json({ status: 3, message: 'Authentication failed' });
        }
    }
};

export default noLogin;
