import userModel from '../models/userModel.js';
import hospitalityModel from '../models/hospitalityModel.js';
import Config from '../config/app.config.js';
import { logError } from '../helper/common.js';
import { entityCanOperate } from '../services/vendorNetwork/actingContext.js';

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

const settle = (promise) => promise.then((value) => ({ value }), (err) => ({ err }));

const OPERATE_REFUSALS = {
  NOT_ACTIVE: { status: 0, message: 'This network entity is suspended', code: 'NOT_ACTIVE' },
  NO_SEAT: { status: 0, message: 'Network seat required for this entity', code: 'NO_SEAT' },
};

/**
 * Whether this request must check that its entity may operate (Vendor Networks spec
 * §5.1). jwtUsr resolved the acting entity's network on THIS request, so a JWT vendor
 * with no `network` is in no org and one acting as the principal needs no seat:
 * neither costs a query. A non-principal acting entity, and (when `tokenPath`) an
 * emailed-link token vendor (vendorTokenOrJwt, is_verified === false, network never
 * resolved), pay one query.
 */
const needsOperateCheck = (req, { tokenPath }) => {
  const network = req.user.network;
  if (network) return !network.is_principal;
  return tokenPath && req.is_verified === false;
};

/** 403 body for an entityCanOperate refusal (NOT_ACTIVE when suspended, else NO_SEAT). */
const operateRefusal = (reason) => OPERATE_REFUSALS[reason] ?? OPERATE_REFUSALS.NO_SEAT;

/**
 * Builds the subscription gate. With `seatGate`, a vendor entity that may not operate
 * in its network (Vendor Networks spec §5.1: a member entity without an active seat,
 * or not ACTIVE) is refused too; principals and vendors in no org always pass it.
 */
const subscriptionGate = ({ seatGate }) => async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return next(); // Let auth middleware handle this
    }

    const userId = req.user.id;

    // Check if user is a vendor (user_type === 3). Buyers/admins pass through.
    //
    // Every authenticator in front of this middleware (passport's JWT strategy,
    // vendorTokenOrJwt's token path) has just loaded req.user from tbl_users in
    // THIS request, user_type included — so read it there. userModel.userinfo
    // re-read the same row (two serial statements) on every call, which made
    // this gate the most common redundant round trip on getRfqById. It is kept
    // only as the fallback for a req.user that does not carry user_type.
    let userType = req.user.user_type;
    if (userType === undefined) {
      const userInfo = await userModel.userinfo(userId);
      userType = userInfo?.user_type || (Array.isArray(userInfo) ? userInfo[0]?.user_type : null);
    }
    if (userType !== 3 && userType !== '3') {
      return next(); // Not a vendor, no subscription check needed
    }

    // Independent reads: the subscription check is only CONSULTED for a
    // hospitality vendor, but issuing the reads together saves serial round trips
    // on every vendor request (non-hospitality vendors are the legacy minority).
    // A failure of a read only matters if it is consulted, as before — so each is
    // settled here and re-thrown below only when needed.
    // hasValidPaidSubscription counts the subscriptions of the vendor's whole
    // network (spec §5.2) inside its own statement.
    const [companyDetails, subscription, operate] = await Promise.all([
      userModel.getCompanyDetail(userId),
      settle(hospitalityModel.hasValidPaidSubscription(userId)),
      seatGate && needsOperateCheck(req, { tokenPath: true }) ? settle(entityCanOperate(userId)) : null,
    ]);

    // The network operate check applies to every networked vendor, hospitality or
    // not; a vendor in no org never reaches it.
    if (operate) {
      if (operate.err) throw operate.err;
      if (!operate.value.ok) return res.status(403).json(operateRefusal(operate.value.reason));
    }

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

    if (subscription.err) throw subscription.err;
    if (!subscription.value) {
      return res.status(403).json({
        status: 0,
        message: 'Your subscription has expired. Please renew to continue.',
        subscription_expired: true
      });
    }

    return next();
  } catch (error) {
    logError(error);
    return res.status(400).json({
      status: 3,
      message: Config.errorText.value
    });
  }
};

/**
 * Middleware to block hospitality vendors with expired/no subscription, and network
 * entities that may not operate (no active seat).
 * Non-hospitality vendors and non-vendor users pass through unaffected.
 * Use after passportSignIn on endpoints that require active subscription.
 */
const requireActiveSubscription = subscriptionGate({ seatGate: true });

/**
 * The subscription check WITHOUT the seat gate, for actions on POs already addressed
 * to the vendor (dispatch, invoice). Spec §5.1: those stay actionable when an
 * entity's seat lapses, so buyers are never stranded.
 */
const requireActiveSubscriptionForIssuedPo = subscriptionGate({ seatGate: false });

/**
 * Only the Vendor Networks operate check (spec §5.1), for vendor actions outside the
 * subscription gate (ARC quote and technical-envelope submission). A non-principal
 * org entity must be ACTIVE with a live seat: else 403 NOT_ACTIVE / NO_SEAT. Vendors
 * in no org and principals pass with no query. Use after passportSignIn.
 */
const requireNetworkEntityCanOperate = async (req, res, next) => {
  try {
    if (!req.user?.id || !needsOperateCheck(req, { tokenPath: false })) return next();
    const operate = await entityCanOperate(req.user.id);
    if (!operate.ok) return res.status(403).json(operateRefusal(operate.reason));
    return next();
  } catch (error) {
    logError(error);
    return res.status(400).json({ status: 3, message: Config.errorText.value });
  }
};

/**
 * Vendor Networks (spec §5.2): the org's subscription is bought and changed by the
 * principal. A request acting as a non-principal entity (a member's own login, a
 * person acting for it, or the admin switched into it) may not renew, preview,
 * modify or extend a subscription for that entity: 403 reason NETWORK_MEMBER.
 * Vendors in no network and the principal pass with no query.
 */
const refuseNetworkMemberSubscriptionChange = (req, res, next) => {
  const network = req.user?.network;
  if (!network || network.is_principal) return next();
  return res.status(403).json({
    status: 0,
    message: `Your subscription is covered by ${network.org_name}. Ask your network admin to change it.`,
    reason: 'NETWORK_MEMBER',
  });
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
  requireActiveSubscriptionForIssuedPo,
  requireActiveSubscriptionIfAuthenticated,
  requireNetworkEntityCanOperate,
  refuseNetworkMemberSubscriptionChange,
};

