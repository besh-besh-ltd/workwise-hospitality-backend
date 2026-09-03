import { logError } from '../../helper/common.js';
import {
  companiesVisibleTo,
  listActivity,
  activityFacets,
  activityChanges,
} from '../../models/activityModel.js';
import { getUncataloguedRoutes } from '../../middleware/activityCapture.js';

/**
 * Reading the company activity trail.
 *
 * The scope is taken from the session and nothing else. Every filter here
 * narrows; none can widen. A query parameter that could change which
 * company's events come back would make this an information-disclosure
 * endpoint rather than an audit trail, and the codebase has fixed that class
 * of bug more than once already.
 */

const asArray = (value) => {
  if (value == null || value === '') return null;
  return Array.isArray(value) ? value : String(value).split(',').map((v) => v.trim()).filter(Boolean);
};

const scopeFor = async (req) => {
  const buyerCompanyId = req.companyDetails?.id;
  return companiesVisibleTo(buyerCompanyId);
};

const activityController = {
  list: async (req, res) => {
    try {
      const companyIds = await scopeFor(req);
      if (!companyIds.length) {
        return res.status(200).json({ status: 1, data: { rows: [], total: 0, page: 1, limit: 0 } });
      }

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);

      const { rows, total } = await listActivity({
        companyIds,
        from: req.query.from || null,
        to: req.query.to || null,
        categories: asArray(req.query.category),
        severities: asArray(req.query.severity),
        actorUserId: req.query.actor_user_id ? Number(req.query.actor_user_id) : null,
        actorType: req.query.actor_type || null,
        entityType: req.query.entity_type || null,
        entityId: req.query.entity_id ? Number(req.query.entity_id) : null,
        hotelId: req.query.hotel_id ? Number(req.query.hotel_id) : null,
        search: req.query.q || null,
        limit,
        offset: (page - 1) * limit,
      });

      return res.status(200).json({
        status: 1,
        data: { rows, total, page, limit, hasMore: page * limit < total },
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({ status: 3, message: 'Could not load activity' });
    }
  },

  facets: async (req, res) => {
    try {
      const companyIds = await scopeFor(req);
      const facets = await activityFacets(companyIds);
      return res.status(200).json({ status: 1, data: facets });
    } catch (error) {
      logError(error);
      return res.status(400).json({ status: 3, message: 'Could not load activity filters' });
    }
  },

  changes: async (req, res) => {
    try {
      const companyIds = await scopeFor(req);
      const result = await activityChanges(Number(req.params.id), companyIds);
      // An event belonging to another company is indistinguishable from one
      // that does not exist. That is deliberate.
      if (!result) return res.status(404).json({ status: 2, message: 'Activity not found' });
      return res.status(200).json({ status: 1, data: result });
    } catch (error) {
      logError(error);
      return res.status(400).json({ status: 3, message: 'Could not load activity detail' });
    }
  },

  /**
   * Mutating routes the registry does not name yet.
   *
   * Exposed rather than merely logged so the gap can be checked deliberately —
   * on staging after an exploratory pass, or in a test — instead of being
   * noticed a year later when somebody asks why an event has no description.
   */
  coverageGaps: async (req, res) => {
    try {
      return res.status(200).json({ status: 1, data: { routes: getUncataloguedRoutes() } });
    } catch (error) {
      logError(error);
      return res.status(400).json({ status: 3, message: 'Could not read coverage gaps' });
    }
  },
};

export default activityController;
