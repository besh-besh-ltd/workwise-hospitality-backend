// Vendor Networks: coverage rules (spec §6.1, §10.5). ORG_ADMIN only.
//
//   GET /coverage/:vendorId               rules + covered-hotels preview
//   PUT /coverage/:vendorId { rules }     replace-all, one transaction
//   GET /coverage/lookup/states           India states
//   GET /coverage/lookup/cities?state_id= cities of one state
//   GET /coverage/lookup/hotels?q=        preview-set hotels by name (limit 50)
//
// The org comes from req.user.network; :vendorId is only a target, verified to be a live
// entity of that org (404 otherwise). The preview hotel set is derived from the org's
// principal, never from a client-supplied id.

import db from "../../config/dbConn.js";
import Config from "../../config/app.config.js";
import { logger } from "../../util/logger.js";
import { requireOrgAdmin, actingPersonId } from "../../services/vendorNetwork/guards.js";
import { COVERAGE_SCOPE, COVERAGE_MODE } from "../../constants/vendorNetwork.js";
import { getEntity, getOrgById } from "../../models/vendorNetworkModel.js";
import {
  listCoverageRules,
  findUnknownRuleTargets,
  replaceCoverageRules,
  previewCoveredHotels,
  searchPreviewHotels,
  listIndiaStates,
  listCitiesOfState,
} from "../../services/vendorNetwork/coverage.js";

export const MAX_COVERAGE_RULES = 500;
const HOTEL_LOOKUP_LIMIT = 50;
const SCOPE_TYPES = Object.values(COVERAGE_SCOPE);
const MODES = Object.values(COVERAGE_MODE);

/** A positive int4 from a number or a digit string, else null. */
function parseId(value) {
  const n = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

const fail = (res, http, message, extra = {}) => res.status(http).json({ status: 0, message, ...extra });

function handleError(res, error, label) {
  logger.error({ err: error.message }, `vendor-network ${label} failed`);
  return res.status(400).json({ status: 3, message: Config.errorText.value });
}

/** The live entity :vendorId of the caller's org, or null. */
async function targetEntity(req, runner = db) {
  const vendorId = parseId(req.params.vendorId);
  return vendorId ? getEntity(req.user.network.org_id, vendorId, runner) : null;
}

async function principalOf(req) {
  const org = await getOrgById(req.user.network.org_id);
  return org?.principal_vendor_id ?? null;
}

/**
 * Validates PUT rules. Returns { rules } normalised, or { error } with a message.
 * Shape only; whether the ids exist is checked against the database afterwards.
 */
function parseRules(body) {
  const input = body?.rules;
  if (!Array.isArray(input)) return { error: "rules must be an array" };
  if (input.length > MAX_COVERAGE_RULES) return { error: `At most ${MAX_COVERAGE_RULES} rules` };
  const rules = [];
  const seen = new Set();
  for (const [i, raw] of input.entries()) {
    const scopeType = raw?.scope_type;
    const mode = raw?.mode;
    const scopeId = parseId(raw?.scope_id);
    const categoryId = raw?.category_id == null ? null : parseId(raw.category_id);
    if (!SCOPE_TYPES.includes(scopeType)) return { error: `rules[${i}].scope_type must be one of ${SCOPE_TYPES.join(", ")}` };
    if (!MODES.includes(mode)) return { error: `rules[${i}].mode must be INCLUDE or EXCLUDE` };
    if (scopeId === null) return { error: `rules[${i}].scope_id must be a positive id` };
    if (raw?.category_id != null && categoryId === null) {
      return { error: `rules[${i}].category_id must be a positive id or null` };
    }
    const key = `${scopeType}:${scopeId}:${categoryId ?? 0}`;
    if (seen.has(key)) return { error: `rules[${i}] duplicates another rule for the same scope and category` };
    seen.add(key);
    rules.push({ scope_type: scopeType, scope_id: scopeId, mode, category_id: categoryId });
  }
  return { rules };
}

/** GET /coverage/:vendorId[?category_id=] */
export async function getCoverage(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const entity = await targetEntity(req);
    if (!entity) return fail(res, 404, "Entity not found in your network");
    const rawCategory = req.query?.category_id;
    const categoryId = rawCategory === undefined || rawCategory === "" ? null : parseId(rawCategory);
    if (rawCategory !== undefined && rawCategory !== "" && categoryId === null) {
      return fail(res, 400, "category_id must be a positive id");
    }

    const principalVendorId = await principalOf(req);
    const [rules, preview] = await Promise.all([
      listCoverageRules(entity.vendor_id),
      previewCoveredHotels({ principalVendorId, entityVendorId: entity.vendor_id, categoryId }),
    ]);
    return res.status(200).json({
      status: 1,
      message: "Coverage",
      data: { vendor_id: entity.vendor_id, rules, preview },
    });
  } catch (error) {
    return handleError(res, error, "getCoverage");
  }
}

/** PUT /coverage/:vendorId { rules: [{ scope_type, scope_id, mode, category_id|null }] } */
export async function putCoverage(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const entity = await targetEntity(req);
    if (!entity) return fail(res, 404, "Entity not found in your network");

    const { rules, error } = parseRules(req.body);
    if (error) return fail(res, 400, error);
    const unknown = await findUnknownRuleTargets(rules);
    if (unknown.scopes.length || unknown.categories.length) {
      return fail(res, 400, "Some rules point at a state, city, hotel or category that does not exist", {
        data: unknown,
      });
    }

    const saved = await db.tx(async (t) => {
      // Lock the entity row: concurrent replace-alls serialise instead of colliding.
      const locked = await t.oneOrNone(
        `SELECT vendor_id FROM tbl_vendor_org_entities
          WHERE org_id = $1 AND vendor_id = $2 AND status <> 'REMOVED' FOR UPDATE`,
        [req.user.network.org_id, entity.vendor_id]
      );
      if (!locked) return null;
      await replaceCoverageRules(entity.vendor_id, rules, actingPersonId(req), t);
      return listCoverageRules(entity.vendor_id, t);
    });
    if (!saved) return fail(res, 404, "Entity not found in your network");
    return res.status(200).json({
      status: 1,
      message: "Coverage saved",
      data: { vendor_id: entity.vendor_id, rules: saved },
    });
  } catch (error) {
    return handleError(res, error, "putCoverage");
  }
}

/** GET /coverage/lookup/states */
export async function lookupStates(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    return res.status(200).json({ status: 1, message: "States", data: await listIndiaStates() });
  } catch (error) {
    return handleError(res, error, "lookupStates");
  }
}

/** GET /coverage/lookup/cities?state_id= */
export async function lookupCities(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const stateId = parseId(req.query?.state_id);
    if (stateId === null) return fail(res, 400, "state_id is required");
    return res.status(200).json({ status: 1, message: "Cities", data: await listCitiesOfState(stateId) });
  } catch (error) {
    return handleError(res, error, "lookupCities");
  }
}

/** GET /coverage/lookup/hotels?q= (the org's preview hotel set only) */
export async function lookupHotels(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const q = typeof req.query?.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const principalVendorId = await principalOf(req);
    const hotels = await searchPreviewHotels({ principalVendorId, q, limit: HOTEL_LOOKUP_LIMIT });
    return res.status(200).json({ status: 1, message: "Hotels", data: hotels });
  } catch (error) {
    return handleError(res, error, "lookupHotels");
  }
}

export default { getCoverage, putCoverage, lookupStates, lookupCities, lookupHotels };
