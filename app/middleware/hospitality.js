import userModel from '../models/userModel.js';
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

export default {
  checkHospitality,
  requireHospitality
};

