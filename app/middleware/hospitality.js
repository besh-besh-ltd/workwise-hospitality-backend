import userModel from '../models/userModel.js';
import hospitalityModel from '../models/hospitalityModel.js';
import Config from '../config/app.config.js';
import { logError } from '../helper/common.js';

/**
 * Middleware to check if user's company is hospitality
 * Attaches isHospitality and companyDetails to req
 * @param {boolean} requireHospitality - If true, returns 403 if not hospitality
 */
const checkHospitality = (requireHospitality = false) => {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          status: 0,
          message: 'Unauthorized'
        });
      }

      const userId = req.user.id;
      const companyDetails = await userModel.getCompanyDetail(userId);

      if (!companyDetails || companyDetails.length === 0) {
        if (requireHospitality) {
          return res.status(400).json({
            status: 2,
            message: 'Company not found'
          });
        }
        req.isHospitality = false;
        req.companyDetails = null;
        return next();
      }

      const company = companyDetails[0];
      const isHospitality =
        company.is_hospitality === 1 || company.is_hospitality === '1';

      req.isHospitality = isHospitality;
      req.companyDetails = company;

      if (requireHospitality && !isHospitality) {
        return res.status(403).json({
          status: 2,
          message: 'Hospitality access is not enabled for this company'
        });
      }

      next();
    } catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  };
};

/**
 * Middleware to require hospitality access
 * Shortcut for checkHospitality(true)
 */
const requireHospitality = checkHospitality(true);

const attachHospitalityContext = () => {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return next();
      }

      const rawCompanyId =
        req.headers['x-hospitality-company'] ||
        req.headers['x-hospitality-company-id'];
      const rawHotelId =
        req.headers['x-hospitality-hotel'] ||
        req.headers['x-hospitality-hotel-id'];

      if (!rawCompanyId) {
        req.hospitalityContext = null;
        return next();
      }

      const companyId = parseInt(rawCompanyId, 10);
      const hotelId =
        rawHotelId !== undefined && rawHotelId !== null && rawHotelId !== ''
          ? parseInt(rawHotelId, 10)
          : null;

      if (Number.isNaN(companyId) || (hotelId !== null && Number.isNaN(hotelId))) {
        return res.status(400).json({
          status: 2,
          message: 'Invalid hospitality context',
        });
      }

      const hasAccess = await hospitalityModel.userHasContext(
        req.user.id,
        companyId,
        hotelId
      );
      if (!hasAccess) {
        return res.status(403).json({
          status: 2,
          message: 'Hospitality context not permitted',
        });
      }

      req.hospitalityContext = {
        companyId,
        hotelId,
      };
      return next();
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value,
      });
    }
  };
};

/**
 * Middleware to block hospitality vendors with expired/no subscription.
 * Non-hospitality vendors and non-vendor users pass through unaffected.
 * Use after passportSignIn on endpoints that require active subscription.
 */
const requireActiveSubscription = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return next(); // Let auth middleware handle this
    }

    const userId = req.user.id;

    // Check if user is a vendor (user_type === 3). Buyers/admins pass through.
    const userInfo = await userModel.userinfo(userId);
    const userType = userInfo?.user_type || (Array.isArray(userInfo) ? userInfo[0]?.user_type : null);
    if (userType !== 3 && userType !== '3') {
      return next(); // Not a vendor, no subscription check needed
    }

    const companyDetails = await userModel.getCompanyDetail(userId);
    if (!companyDetails || companyDetails.length === 0) {
      return next();
    }

    const company = companyDetails[0];
    const isHospitality =
      company.is_hospitality === 1 || company.is_hospitality === '1';

    // Only restrict hospitality vendors
    if (!isHospitality) {
      return next();
    }

    const hasValidSub = await hospitalityModel.hasValidPaidSubscription(userId);
    if (hasValidSub) {
      return next();
    }

    return res.status(403).json({
      status: 0,
      message: 'Your subscription has expired. Please renew to continue.',
      subscription_expired: true
    });
  } catch (error) {
    logError(error);
    return res.status(400).json({
      status: 3,
      message: Config.errorText.value
    });
  }
};

/**
 * Variant for noLogin.customer_auth endpoints (quote submission etc.)
 * Only checks subscription if user is authenticated (req.user exists).
 * Unauthenticated requests pass through (handled by other logic).
 */
const requireActiveSubscriptionIfAuthenticated = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return next(); // Not authenticated, skip subscription check
    }

    // Delegate to the main middleware
    return requireActiveSubscription(req, res, next);
  } catch (error) {
    logError(error);
    return next();
  }
};

export default {
  checkHospitality,
  requireHospitality,
  attachHospitalityContext,
  requireActiveSubscription,
  requireActiveSubscriptionIfAuthenticated,
};

