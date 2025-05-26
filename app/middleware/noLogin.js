import passport from './passport.js';
import { validateDbBody } from "../validations/dbValidation/userDbValidation.js";

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
    }
};

export default noLogin;
