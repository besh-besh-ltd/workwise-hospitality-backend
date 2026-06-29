import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcManualEntryModel from '../../models/arc_v2/arcManualEntryModel.js';
import rbacModel from '../../models/rbacModel.js';
import { uploadToS3 } from '../../models/generalModel.js';
import { dispatch as dispatchNotification } from '../../services/notificationService.js';
import { sendMail } from '../../helper/common.js';
import { ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';

/**
 * ARC v2 — Manual / backfill data-entry controller (spec §6).
 *
 * Lets the purchase team (role 2) + super-admin (role 8) hand-key a complete
 * Annual Rate Contract at any chosen lifecycle TARGET STAGE (draft … ended),
 * with BACKDATED timestamps, reusing the existing ARC v2 tables.
 *
 * SECURITY (spec §6.6, non-negotiable):
 *  - hospitality_company_id is ALWAYS derived from the hotel via
 *    getHotelCompanyMappings — never read from the body.
 *  - hotel_id must be in getAllAccessibleHotelIds(req.user) (super-admin bypass).
 *  - every PATCH/section/upload/finalize RELOADS the ARC by id and re-verifies
 *    scope before writing (reload-and-verify).
 *  - backdated timestamps must be ≤ now and internally ordered; future/out-of-
 *    order chains are rejected.
 *  - vendor notifications are SUPPRESSED for S1/S2/S4/S5; emitted ONLY for S3
 *    (the genuine pending-signature case).
 */

// ---- target-stage model (spec §2.2) -----------------------------------------
const TARGET_STAGES = ['draft', 'floated', 'evaluation', 'sig_pending', 'active', 'ended'];
const ENDED_SUB_STATUSES = ['expired', 'terminated', 'closed_no_award'];
// Ordinal rank for "is this stage at-or-past X" comparisons.
const STAGE_RANK = { draft: 0, floated: 1, evaluation: 2, sig_pending: 3, active: 4, ended: 5 };

function ok(res, data, message = 'success') {
  return res.status(200).json({ status: 1, message, data });
}
function bad(res, status, message, code = 0) {
  return res.status(status).json({ status: code, message });
}

function generateArcNumber(now = new Date()) {
  const yyyy = now.getFullYear();
  const stamp = now.getTime().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `ARC-${yyyy}-${stamp}${rand}`;
}

// Authorization: may this caller act on the given hotel? Super-admin (user_type 8)
// bypasses; everyone else must have the hotel in their accessible set. Scope is
// derived from the entity's hotel_id — never trusted from the client (§6.6).
async function userCanAccessHotel(req, hotelId) {
  if (Number(req.user?.user_type) === 8) return true;
  if (!req.user?.id || !hotelId) return false;
  const accessible = await rbacModel.getAllAccessibleHotelIds(req.user.id);
  return accessible.map(Number).includes(Number(hotelId));
}

// Reload the ARC + its manual-entry row and verify the caller still has scope.
// Returns { arc, manual } on success, or sends the response and returns null.
async function reloadAndVerify(req, res, arcId, runner = db) {
  const arc = await arcModel.getById(arcId, runner);
  if (!arc) { bad(res, 404, 'ARC not found', 2); return null; }
  const manual = await arcManualEntryModel.getByArc(arcId, runner);
  if (!manual) { bad(res, 404, 'This ARC was not created through the manual-entry workspace', 2); return null; }
  if (!(await userCanAccessHotel(req, arc.hotel_id))) { bad(res, 403, 'You do not have access to this ARC'); return null; }
  return { arc, manual };
}

function toDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d; // undefined = parse error
}

// ---- date-chain validation (spec §3 / §9.7) ---------------------------------
// Validates the full backdated chain for the chosen target stage. Returns an
// array of human-readable errors (empty = valid). Future timestamps are rejected.
function validateDateChain(stage, dates, wasAwarded = true) {
  const errs = [];
  const now = Date.now();
  let rank = STAGE_RANK[stage];
  // closed_no_award / not-awarded ended ARCs carry no contract or award, so they
  // only need created_at (+ no-future) — not the window/contract/comm/generated
  // chain (spec §2.3¹ / SC-4).
  if (stage === 'ended' && !wasAwarded) rank = STAGE_RANK.draft;

  const g = (k) => {
    const raw = dates[k];
    if (raw == null || raw === '') return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) { errs.push(`${k} is not a valid date`); return NaN; }
    return d.getTime();
  };

  const created = g('created_at');
  const floated = g('floated_at');
  const subStart = g('submission_start_at');
  const subEnd = g('submission_end_at');
  const ctStart = g('contract_start_at');
  const ctEnd = g('contract_end_at');
  const finalized = g('comm_finalized_at');
  const generated = g('generated_at');
  const signed = g('signed_by_vendor_at');

  // No future timestamps anywhere.
  for (const [k, v] of Object.entries({ created_at: created, floated_at: floated, submission_start_at: subStart, submission_end_at: subEnd, comm_finalized_at: finalized, generated_at: generated, signed_by_vendor_at: signed })) {
    if (typeof v === 'number' && !Number.isNaN(v) && v > now) errs.push(`${k} cannot be in the future`);
  }

  // created_at required for every stage.
  if (created == null) errs.push('created_at is required');

  if (rank >= STAGE_RANK.floated) {
    if (floated == null) errs.push('floated_at is required from the Floated stage onward');
    if (subStart == null) errs.push('submission_start_at is required from the Floated stage onward');
    if (subEnd == null) errs.push('submission_end_at is required from the Floated stage onward');
    if (created != null && floated != null && floated < created) errs.push('floated_at must be ≥ created_at');
    if (floated != null && subStart != null && subStart < floated) errs.push('submission_start_at must be ≥ floated_at');
    if (subStart != null && subEnd != null && subEnd <= subStart) errs.push('submission_end_at must be > submission_start_at');
  }

  if (rank >= STAGE_RANK.sig_pending) {
    if (ctStart == null) errs.push('contract_start_at is required from the Sig-pending stage onward');
    if (ctEnd == null) errs.push('contract_end_at is required from the Sig-pending stage onward');
    if (subEnd != null && ctStart != null && ctStart < subEnd) errs.push('contract_start_at must be ≥ submission_end_at');
    if (ctStart != null && ctEnd != null && ctEnd <= ctStart) errs.push('contract_end_at must be > contract_start_at');
    if (finalized == null) errs.push('comm_finalized_at is required from the Sig-pending stage onward');
    if (subEnd != null && finalized != null && finalized < subEnd) errs.push('comm_finalized_at must be ≥ submission_end_at');
  }

  if (rank >= STAGE_RANK.active) {
    if (generated == null) errs.push('generated_at is required from the Active stage onward');
    if (finalized != null && generated != null && generated < finalized) errs.push('generated_at must be ≥ comm_finalized_at');
    if (stage === 'active') {
      if (signed == null) errs.push('signed_by_vendor_at is required for the Active stage');
      if (generated != null && signed != null && signed < generated) errs.push('signed_by_vendor_at must be ≥ generated_at');
    }
  }

  return errs;
}

// Resolve a vendor that the user is allowed to award/contract: must be a real
// vendor user (user_type 3, status 1). Eligibility (subscription) is enforced
// separately at vendor-pick time; this is the existence-in-scope guard (§6.6).
async function vendorExists(vendorId, runner = db) {
  const row = await runner.oneOrNone(
    `SELECT id FROM tbl_users WHERE id = $1 AND user_type = 3 AND status = 1`, [vendorId]);
  return !!row;
}

async function userExists(userId, runner = db) {
  const row = await runner.oneOrNone(`SELECT id FROM tbl_users WHERE id = $1`, [userId]);
  return !!row;
}

// SEC-3/SEC-4 — is this vendor subscription-eligible for the ARC's scope? Mirrors
// the eligibility predicate used by listAllVendors / the live float: an active OR
// lapsed (expired) subscription to the ARC's hotel OR category. Used to gate
// vendor picks (and quotes) unless the caller explicitly overrides eligibility.
async function vendorEligibleForScope(vendorId, hotelId, categoryId, runner = db) {
  const row = await runner.oneOrNone(
    `SELECT EXISTS (
       SELECT 1 FROM tbl_vendor_hotel_category_subscription vhcs
        WHERE vhcs.vendor_id = $1
          AND vhcs.status IN ('active','expired')
          AND ((vhcs.item_type = 'hotel'    AND vhcs.item_id = $2)
            OR (vhcs.item_type = 'category' AND vhcs.item_id = $3))
     ) AS ok`,
    [vendorId, hotelId, categoryId]);
  return !!row?.ok;
}

// SEC-2 — is this user allowed to be recorded as a decider on THIS ARC? Must be a
// real user whose accessible hotels include the ARC's hotel (super-admin bypass).
// Prevents falsifying the committee approver with an out-of-scope / arbitrary id.
async function userInArcScope(userId, arc, runner = db) {
  if (userId == null) return false;
  const u = await runner.oneOrNone(`SELECT user_type FROM tbl_users WHERE id = $1`, [userId]);
  if (!u) return false;
  if (Number(u.user_type) === 8) return true;
  const accessible = await rbacModel.getAllAccessibleHotelIds(userId);
  return accessible.map(Number).includes(Number(arc.hotel_id));
}

// =============================================================================
// §6.1 — all-vendors (override toggle)
// =============================================================================
export async function listAllVendors(req, res) {
  try {
    const hotelId = Number(req.query.hotel_id);
    const categoryId = Number(req.query.category_id);
    if (!hotelId || !categoryId) return bad(res, 400, 'hotel_id and category_id are required');
    if (!(await userCanAccessHotel(req, hotelId))) return bad(res, 403, 'You do not have access to this hotel');
    // All active vendor users, with a `subscribed` flag for the chosen scope
    // (active OR expired subscription to this hotel/category). Unsubscribed
    // vendors carry subscribed=false so the FE can warn-chip them (§4.4).
    const rows = await db.any(
      `SELECT u.id, u.name, u.email, u.mobile,
              EXISTS (
                SELECT 1 FROM tbl_vendor_hotel_category_subscription vhcs
                 WHERE vhcs.vendor_id = u.id
                   AND vhcs.status IN ('active','expired')
                   AND ((vhcs.item_type = 'hotel'    AND vhcs.item_id = $1)
                     OR (vhcs.item_type = 'category' AND vhcs.item_id = $2))
              ) AS subscribed
         FROM tbl_users u
        WHERE u.user_type = 3 AND u.status = 1
        ORDER BY u.name`,
      [hotelId, categoryId]
    );
    return ok(res, { vendors: rows });
  } catch (err) {
    logger.error({ err }, '[arcManualController.listAllVendors]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// =============================================================================
// §6.2 — draft create
// =============================================================================
export async function createDraft(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return bad(res, 401, 'Unauthorized');
    const body = req.body || {};
    const header = body.header || {};
    const scope = body.scope || {};
    const provenance = body.provenance || {};

    const title = typeof header.title === 'string' ? header.title.trim() : '';
    const hotelId = Number(scope.hotel_id);
    const categoryId = Number(scope.category_id);
    const departmentId = Number(scope.department_id);
    if (!title || !hotelId || !categoryId || !departmentId) {
      return bad(res, 400, 'header.title, scope.hotel_id, scope.category_id, scope.department_id are required');
    }
    const targetStage = provenance.target_stage || 'draft';
    if (!TARGET_STAGES.includes(targetStage)) {
      return bad(res, 400, `provenance.target_stage must be one of ${TARGET_STAGES.join(', ')}`);
    }

    // Derive the hotel's TRUE hospitality company server-side — NEVER trust any
    // client-supplied hospitality_company_id (§6.6).
    const [hotelMapping] = await rbacModel.getHotelCompanyMappings([hotelId]);
    if (!hotelMapping) return bad(res, 400, 'invalid hotel_id');
    if (!(await userCanAccessHotel(req, hotelId))) {
      return bad(res, 403, 'You do not have access to this hotel');
    }

    // arc_number: blank → server-generated; supplied → respected but UNIQUE-checked.
    let arcNumber = typeof header.arc_number === 'string' ? header.arc_number.trim() : '';
    if (arcNumber) {
      const existing = await arcModel.getByNumber(arcNumber);
      if (existing) return bad(res, 409, `ARC number ${arcNumber} already exists`, 0);
    } else {
      arcNumber = generateArcNumber();
    }

    const createdAt = body.provenance?.created_at ? toDate(body.provenance.created_at) : null;
    if (createdAt === undefined) return bad(res, 400, 'provenance.created_at is not a valid date');
    if (createdAt && createdAt.getTime() > Date.now()) return bad(res, 400, 'provenance.created_at cannot be in the future');

    const result = await db.tx(async (t) => {
      const arc = await arcManualEntryModel.createBackdatedDraft({
        arc_number: arcNumber,
        title,
        description: header.description ?? null,
        category_id: categoryId,
        sub_category_ids: Array.isArray(scope.sub_category_ids) ? scope.sub_category_ids : [],
        hospitality_company_id: Number(hotelMapping.hospitality_company_id),
        hotel_id: hotelId,
        department_id: departmentId,
        process_id: null,
        technical_response_required: !!header.technical_response_required,
        sample_required: !!header.sample_required,
        eligibility_type: header.eligibility_type === 'invitation' ? 'invitation' : 'open',
        type: header.type === 'service' ? 'service' : 'product',
        created_by: userId,
        created_at: createdAt,
      }, t);
      const manual = await arcManualEntryModel.create(arc.id, {
        target_stage: targetStage,
        eligibility_overridden: !!provenance.eligibility_overridden,
        entered_by: userId,
        entry_notes: provenance.entry_notes ?? null,
      }, t);
      await arcManualEntryModel.addBackdatedEvent(arc.id, {
        eventType: ARC_EVENT_TYPES.CREATED, actorId: userId,
        payload: { source: 'manual_entry', target_stage: targetStage }, at: createdAt,
      }, t);
      return { arc, manual };
    });
    return ok(res, { arc: result.arc, manual_entry: { id: result.manual.id } }, 'Manual ARC draft created');
  } catch (err) {
    logger.error({ err }, '[arcManualController.createDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// =============================================================================
// §6.2 — draft patch (header/scope/provenance partials)
// =============================================================================
export async function patchDraft(req, res) {
  try {
    const arcId = Number(req.params.id);
    const verified = await reloadAndVerify(req, res, arcId);
    if (!verified) return;
    if (verified.arc.status !== 'draft') return bad(res, 409, 'Only a draft can be edited', 0);

    const body = req.body || {};
    const header = body.header || {};
    const scope = body.scope || {};
    const provenance = body.provenance || {};
    const saved = [];

    await db.tx(async (t) => {
      // Scope changes: if hotel_id changes, RE-DERIVE the company (never the body's).
      const arcPatch = {};
      if (scope.hotel_id !== undefined) {
        const hotelId = Number(scope.hotel_id);
        const [hm] = await rbacModel.getHotelCompanyMappings([hotelId]);
        if (!hm) throw Object.assign(new Error('invalid hotel_id'), { httpStatus: 400 });
        if (!(await userCanAccessHotel(req, hotelId))) throw Object.assign(new Error('You do not have access to this hotel'), { httpStatus: 403 });
        await t.none(`UPDATE tbl_arc SET hotel_id = $1, hospitality_company_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
          [hotelId, Number(hm.hospitality_company_id), arcId]);
        saved.push('scope.hotel');
      }
      if (scope.category_id !== undefined) arcPatch.category_id = Number(scope.category_id);
      if (scope.department_id !== undefined) arcPatch.department_id = Number(scope.department_id);
      if (scope.sub_category_ids !== undefined) arcPatch.sub_category_ids = Array.isArray(scope.sub_category_ids) ? scope.sub_category_ids : [];

      if (header.title !== undefined) arcPatch.title = String(header.title).trim();
      if (header.description !== undefined) arcPatch.description = header.description;
      if (header.type !== undefined) arcPatch.type = header.type === 'service' ? 'service' : 'product';
      if (header.eligibility_type !== undefined) arcPatch.eligibility_type = header.eligibility_type === 'invitation' ? 'invitation' : 'open';
      if (header.technical_response_required !== undefined) arcPatch.technical_response_required = !!header.technical_response_required;
      if (header.sample_required !== undefined) arcPatch.sample_required = !!header.sample_required;
      if (header.payment_terms_expected !== undefined) arcPatch.payment_terms_expected = header.payment_terms_expected;
      if (header.delivery_expected !== undefined) arcPatch.delivery_expected = header.delivery_expected;
      if (header.penalty_clause !== undefined) arcPatch.penalty_clause = header.penalty_clause;
      if (header.escalation_clause_json !== undefined) arcPatch.escalation_clause_json = header.escalation_clause_json || {};

      if (Object.keys(arcPatch).length) {
        await arcModel.updateDraft(arcId, arcPatch, t);
        saved.push('header/scope');
      }

      // Provenance / manual-entry fields.
      const mePatch = {};
      if (provenance.target_stage !== undefined) {
        if (!TARGET_STAGES.includes(provenance.target_stage)) throw Object.assign(new Error('invalid target_stage'), { httpStatus: 400 });
        mePatch.target_stage = provenance.target_stage;
      }
      if (provenance.eligibility_overridden !== undefined) mePatch.eligibility_overridden = !!provenance.eligibility_overridden;
      if (provenance.entry_notes !== undefined) mePatch.entry_notes = provenance.entry_notes;
      // SC-5 — persist the backdated date chain on the draft (restored on resume).
      if (provenance.backdated_dates !== undefined) {
        mePatch.backdated_dates = provenance.backdated_dates && typeof provenance.backdated_dates === 'object' ? provenance.backdated_dates : {};
      }
      const newCreated = provenance.created_at ?? provenance.backdated_dates?.created_at;
      if (newCreated != null && newCreated !== '') {
        const cd = toDate(newCreated);
        if (cd === undefined) throw Object.assign(new Error('created_at is not a valid date'), { httpStatus: 400 });
        if (cd && cd.getTime() > Date.now()) throw Object.assign(new Error('created_at cannot be in the future'), { httpStatus: 400 });
        if (cd) { await t.none(`UPDATE tbl_arc SET created_at = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [cd, arcId]); saved.push('created_at'); }
      }
      if (Object.keys(mePatch).length) {
        await arcManualEntryModel.update(arcId, mePatch, t);
        saved.push('provenance');
      }
    });
    const arc = await arcModel.getById(arcId);
    return ok(res, { arc, sections_saved: saved }, 'Draft updated');
  } catch (err) {
    if (err.httpStatus) return bad(res, err.httpStatus, err.message);
    logger.error({ err }, '[arcManualController.patchDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// =============================================================================
// §6.2 — draft get (full hydrated graph for resume)
// =============================================================================
export async function getDraft(req, res) {
  try {
    const arcId = Number(req.params.id);
    const verified = await reloadAndVerify(req, res, arcId);
    if (!verified) return;
    const graph = await arcManualEntryModel.hydrate(arcId);
    return ok(res, graph, 'Manual ARC draft');
  } catch (err) {
    logger.error({ err }, '[arcManualController.getDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// =============================================================================
// §6.3 — section PUT (autosave granularity)
// =============================================================================
const SECTIONS = ['header', 'scope', 'provenance', 'vendors', 'items', 'quotes', 'awards', 'terms', 'contract', 'signatures', 'approvals'];

export async function saveSection(req, res) {
  try {
    const arcId = Number(req.params.id);
    const section = req.params.section;
    if (!SECTIONS.includes(section)) return bad(res, 400, `Unknown section '${section}'`);
    const verified = await reloadAndVerify(req, res, arcId);
    if (!verified) return;
    if (verified.arc.status !== 'draft') return bad(res, 409, 'Only a draft can be edited', 0);
    const arc = verified.arc;
    const body = req.body || {};

    await db.tx(async (t) => {
      switch (section) {
        case 'header':
        case 'scope':
        case 'provenance': {
          // Header/scope/provenance share one writer (re-derives company on hotel change).
          await applyHeaderScopeProvenance(arcId, { [section]: body }, req, t);
          break;
        }
        case 'vendors': {
          // body.vendors = [{ vendor_id, eligibility_overridden? }]
          const vendors = Array.isArray(body.vendors) ? body.vendors : [];
          // SEC-3/SEC-4 — every picked vendor must be subscription-eligible for the
          // ARC's hotel×category, UNLESS the caller explicitly overrides eligibility.
          // The override is determined server-side and recorded authoritatively
          // (never trusted as an audit-clean default).
          const overrideRequested = body.override === true
            || vendors.some((v) => v.eligibility_overridden)
            || !!verified.manual.eligibility_overridden;
          let anyOverridden = false;
          for (const v of vendors) {
            const vid = Number(v.vendor_id);
            if (!(await vendorExists(vid, t))) throw Object.assign(new Error(`vendor ${vid} is not a valid active vendor`), { httpStatus: 400 });
            const eligible = await vendorEligibleForScope(vid, arc.hotel_id, arc.category_id, t);
            if (!eligible) {
              if (!overrideRequested) {
                throw Object.assign(new Error(`vendor ${vid} is not subscribed to this business unit / category — enable "show all vendors / override eligibility" to add it`), { httpStatus: 400 });
              }
              anyOverridden = true;
            }
          }
          // Replace the invitation set with exactly the picked vendors.
          await t.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
          for (const v of vendors) {
            await arcManualEntryModel.addInvitation(arcId, Number(v.vendor_id), { status: 'submitted' }, t);
          }
          // Record the override flag ONLY when a non-eligible vendor was actually added.
          if (anyOverridden) {
            await arcManualEntryModel.update(arcId, { eligibility_overridden: true }, t);
          }
          break;
        }
        case 'items': {
          // body.items = [{ id?, product_variant_id, indicative_qty, uom, spec_text?, target_price?, hsn?, history?[] }]
          const items = Array.isArray(body.items) ? body.items : [];
          for (const it of items) {
            if (!it.product_variant_id || it.indicative_qty == null) {
              throw Object.assign(new Error('each item needs product_variant_id and indicative_qty'), { httpStatus: 400 });
            }
            let row;
            if (it.id) {
              // SEC-1 (cross-tenant IDOR): the per-item update / raw HSN update /
              // history-snapshot writes below all key on the CLIENT-supplied
              // it.id. Verify IN-TX that this item actually belongs to THIS arc
              // before touching it — otherwise a user who owns draft ARC-A could
              // overwrite another tenant's item (qty/uom/spec/hsn/history) by
              // passing that foreign item's id. Reject any non-owned id (every
              // sibling branch already scopes by arc_id; this path must too).
              const owned = await t.oneOrNone(
                `SELECT id FROM tbl_arc_item WHERE id = $1 AND arc_id = $2`, [Number(it.id), arcId]);
              if (!owned) throw Object.assign(new Error(`item ${it.id} does not belong to this ARC`), { httpStatus: 400 });
              row = await arcModel.updateItem(Number(it.id), it, t);
              if (it.hsn !== undefined) await t.none(`UPDATE tbl_arc_item SET hsn = $1 WHERE id = $2 AND arc_id = $3`, [it.hsn, Number(it.id), arcId]);
            } else {
              row = await arcManualEntryModel.addItem(arcId, it, t);
            }
            if (Array.isArray(it.history) && it.history.length) {
              await arcModel.upsertHistorySnapshot(row.id, it.history, t);
            }
          }
          // Remove items the FE dropped (those not in the payload, by id).
          if (body.replace === true) {
            const keepIds = items.map((i) => Number(i.id)).filter(Boolean);
            if (keepIds.length) {
              await t.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1 AND id <> ALL($2::bigint[])`, [arcId, keepIds]);
            } else {
              await t.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
            }
          }
          break;
        }
        case 'quotes': {
          // body.quotes = [{ vendor_id, submitted_at?, payment_terms?, gstin_used?, lines:[{arc_item_id, rate, gst_pct?, charges?, lead_time_days?, moq?, validity_notes?}] }]
          const quotes = Array.isArray(body.quotes) ? body.quotes : [];
          for (const q of quotes) {
            const vid = Number(q.vendor_id);
            if (!(await vendorExists(vid, t))) throw Object.assign(new Error(`vendor ${vid} is not a valid active vendor`), { httpStatus: 400 });
            // SEC-3 — a quote may only come from an eligible vendor (or one added under override).
            if (!verified.manual.eligibility_overridden && !(await vendorEligibleForScope(vid, arc.hotel_id, arc.category_id, t))) {
              throw Object.assign(new Error(`vendor ${vid} is not subscribed to this business unit / category`), { httpStatus: 400 });
            }
            const quote = await arcManualEntryModel.addQuote(arcId, vid, {
              submitted_at: q.submitted_at ? toDate(q.submitted_at) : null,
              payment_terms: q.payment_terms ?? null,
              gstin_used: q.gstin_used ?? null,
            }, t);
            for (const line of (Array.isArray(q.lines) ? q.lines : [])) {
              await arcManualEntryModel.addQuoteLine(quote.id, line, t);
            }
          }
          break;
        }
        case 'awards': {
          // body.awards = [{ arc_item_id, awarded_vendor_id, allocated_qty, l_rank?, is_l1_default? }]
          // Stored on tbl_arc_comm_evaluation_award; the comm-eval row is created lazily.
          const awards = Array.isArray(body.awards) ? body.awards : [];
          const comm = await arcManualEntryModel.createCommEval(arcId, { status: 'in_progress' }, t);
          // Replace the award set.
          await t.none(`DELETE FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id = $1`, [comm.id]);
          for (const a of awards) {
            const vid = Number(a.awarded_vendor_id);
            if (!(await vendorExists(vid, t))) throw Object.assign(new Error(`awarded_vendor ${vid} is not a valid active vendor`), { httpStatus: 400 });
            // Resolve the awarded quote line for this vendor×item.
            const ql = await t.oneOrNone(
              `SELECT ql.id, ql.rate, ql.gst_pct, ql.charges
                 FROM tbl_arc_quote q
                 JOIN tbl_arc_quote_line ql ON ql.arc_quote_id = q.id
                WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`,
              [arcId, vid, Number(a.arc_item_id)]);
            if (!ql) throw Object.assign(new Error(`no quote line from vendor ${vid} for item ${a.arc_item_id}`), { httpStatus: 400 });
            await arcManualEntryModel.addAward(comm.id, {
              arc_item_id: Number(a.arc_item_id),
              awarded_vendor_id: vid,
              awarded_quote_line_id: ql.id,
              allocated_qty: Number(a.allocated_qty),
              l_rank: a.l_rank ?? null,
              is_l1_default: !!a.is_l1_default,
              awarded_quote_snapshot: { rate: ql.rate, gst_pct: ql.gst_pct, charges: ql.charges,
                payment_terms: a.payment_terms ?? null, delivery_terms: a.delivery_terms ?? null },
            }, t);
          }
          break;
        }
        case 'terms': {
          const patch = {};
          if (body.payment_terms_expected !== undefined) patch.payment_terms_expected = body.payment_terms_expected;
          if (body.delivery_expected !== undefined) patch.delivery_expected = body.delivery_expected;
          if (body.penalty_clause !== undefined) patch.penalty_clause = body.penalty_clause;
          if (body.escalation_clause_json !== undefined) patch.escalation_clause_json = body.escalation_clause_json || {};
          if (Object.keys(patch).length) await arcModel.updateDraft(arcId, patch, t);
          break;
        }
        case 'contract':
        case 'signatures':
        case 'approvals': {
          // These are recorded on the manual-entry row / staged inputs and bound
          // at finalize (the contract graph is written atomically). Persist the
          // approvals snapshot now so resume restores it.
          if (section === 'approvals') {
            const mePatch = {};
            if (body.committee_decision !== undefined) {
              if (body.committee_decision !== null && !['approved', 'rejected'].includes(body.committee_decision)) {
                throw Object.assign(new Error('committee_decision must be approved or rejected'), { httpStatus: 400 });
              }
              mePatch.committee_decision = body.committee_decision;
            }
            if (body.committee_decided_at !== undefined) mePatch.committee_decided_at = body.committee_decided_at ? toDate(body.committee_decided_at) : null;
            if (body.committee_decided_by !== undefined) {
              const decidedBy = body.committee_decided_by == null ? null : Number(body.committee_decided_by);
              // SEC-2 — the decider must be a user WITH ACCESS to this ARC (not just any user).
              if (decidedBy != null && !(await userInArcScope(decidedBy, arc, t))) throw Object.assign(new Error('committee_decided_by must be a user with access to this ARC'), { httpStatus: 400 });
              mePatch.committee_decided_by = decidedBy;
            }
            if (body.committee_comment !== undefined) mePatch.committee_comment = body.committee_comment;
            if (Object.keys(mePatch).length) await arcManualEntryModel.update(arcId, mePatch, t);
          }
          break;
        }
        default:
          break;
      }
    });
    return ok(res, { ok: true, section }, 'Section saved');
  } catch (err) {
    if (err.httpStatus) return bad(res, err.httpStatus, err.message);
    logger.error({ err }, '[arcManualController.saveSection]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Shared header/scope/provenance writer used by saveSection.
async function applyHeaderScopeProvenance(arcId, body, req, t) {
  const header = body.header || {};
  const scope = body.scope || {};
  const provenance = body.provenance || {};
  if (scope.hotel_id !== undefined) {
    const hotelId = Number(scope.hotel_id);
    const [hm] = await rbacModel.getHotelCompanyMappings([hotelId]);
    if (!hm) throw Object.assign(new Error('invalid hotel_id'), { httpStatus: 400 });
    if (!(await userCanAccessHotel(req, hotelId))) throw Object.assign(new Error('You do not have access to this hotel'), { httpStatus: 403 });
    await t.none(`UPDATE tbl_arc SET hotel_id = $1, hospitality_company_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [hotelId, Number(hm.hospitality_company_id), arcId]);
  }
  const arcPatch = {};
  if (scope.category_id !== undefined) arcPatch.category_id = Number(scope.category_id);
  if (scope.department_id !== undefined) arcPatch.department_id = Number(scope.department_id);
  if (scope.sub_category_ids !== undefined) arcPatch.sub_category_ids = Array.isArray(scope.sub_category_ids) ? scope.sub_category_ids : [];
  if (header.title !== undefined) arcPatch.title = String(header.title).trim();
  if (header.description !== undefined) arcPatch.description = header.description;
  if (header.type !== undefined) arcPatch.type = header.type === 'service' ? 'service' : 'product';
  if (header.eligibility_type !== undefined) arcPatch.eligibility_type = header.eligibility_type === 'invitation' ? 'invitation' : 'open';
  if (header.technical_response_required !== undefined) arcPatch.technical_response_required = !!header.technical_response_required;
  if (header.sample_required !== undefined) arcPatch.sample_required = !!header.sample_required;
  if (Object.keys(arcPatch).length) await arcModel.updateDraft(arcId, arcPatch, t);

  const mePatch = {};
  if (provenance.target_stage !== undefined) {
    if (!TARGET_STAGES.includes(provenance.target_stage)) throw Object.assign(new Error('invalid target_stage'), { httpStatus: 400 });
    mePatch.target_stage = provenance.target_stage;
  }
  if (provenance.eligibility_overridden !== undefined) mePatch.eligibility_overridden = !!provenance.eligibility_overridden;
  if (provenance.entry_notes !== undefined) mePatch.entry_notes = provenance.entry_notes;
  // SC-5 — persist the backdated date chain (+ S5 ended controls) on the draft
  // so Save-draft → resume restores them. These have no column on a draft ARC.
  if (provenance.backdated_dates !== undefined) {
    mePatch.backdated_dates = provenance.backdated_dates && typeof provenance.backdated_dates === 'object' ? provenance.backdated_dates : {};
  }
  // Keep the ARC's authoritative created_at in sync when edited via provenance.
  const newCreated = provenance.created_at ?? provenance.backdated_dates?.created_at;
  if (newCreated != null && newCreated !== '') {
    const cd = toDate(newCreated);
    if (cd === undefined) throw Object.assign(new Error('created_at is not a valid date'), { httpStatus: 400 });
    if (cd && cd.getTime() > Date.now()) throw Object.assign(new Error('created_at cannot be in the future'), { httpStatus: 400 });
    if (cd) await t.none(`UPDATE tbl_arc SET created_at = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [cd, arcId]);
  }
  if (Object.keys(mePatch).length) await arcManualEntryModel.update(arcId, mePatch, t);
}

// =============================================================================
// §6.4 — document upload (S4/S5 manually-signed PDF)
// =============================================================================
export async function uploadContractDocument(req, res) {
  let tmpPath = null;
  try {
    const arcId = Number(req.params.id);
    const vendorId = Number(req.params.vendorId);
    const verified = await reloadAndVerify(req, res, arcId);
    if (!verified) return;
    if (verified.arc.status !== 'draft') return bad(res, 409, 'Only a draft can be edited', 0);
    // S3 (sig-pending) never accepts a manual document — the PDF auto-generates on sign.
    if (verified.manual.target_stage === 'sig_pending') {
      return bad(res, 409, 'Sig-pending ARCs generate the contract PDF automatically on vendor sign; do not upload', 0);
    }
    if (!(await vendorExists(vendorId, db))) return bad(res, 400, 'invalid vendor');
    if (!req.file || !req.file.buffer) return bad(res, 400, 'file is required (multipart "file")');
    const mime = req.file.mimetype || '';
    const name = req.file.originalname || 'document.pdf';
    if (mime !== 'application/pdf' && !name.toLowerCase().endsWith('.pdf')) {
      return bad(res, 400, 'only PDF files are accepted');
    }

    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    let url = null;
    if (process.env.NODE_ENV !== 'test') {
      tmpPath = path.join(os.tmpdir(), `arc-manual-${arcId}-${vendorId}-${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, req.file.buffer);
      const s3Key = `arc-contract/manual/${verified.arc.arc_number}-${vendorId}-${Date.now()}.pdf`;
      const up = await uploadToS3(tmpPath, s3Key);
      url = up?.Location || up?.url || s3Key;
    } else {
      // In test mode, store a deterministic pseudo-URL — no real S3 round-trip.
      url = `s3://test/arc-contract/manual/${verified.arc.arc_number}-${vendorId}.pdf`;
    }

    // Stash the uploaded doc on the manual-entry staging via a contract row so
    // finalize can bind it. We DO NOT create the live contract here (still a
    // draft ARC); we record the pending doc on a scratch table keyed by vendor.
    // Reuse tbl_arc_manual_entry? No — multi-vendor. Persist on a transient
    // contract row in 'generated' state is risky on a draft; instead store on
    // the event log payload + return for the FE to send back at finalize.
    await arcManualEntryModel.addBackdatedEvent(arcId, {
      eventType: 'manual_document_uploaded', actorId: req.user.id,
      payload: { vendor_id: vendorId, document_s3_url: url, document_hash: hash, document_source: 'manual_upload' },
      at: null,
    }, db);

    return ok(res, { document_s3_url: url, document_hash: hash, document_source: 'manual_upload', vendor_id: vendorId });
  } catch (err) {
    logger.error({ err }, '[arcManualController.uploadContractDocument]');
    return bad(res, 500, err.message || 'Internal error', 3);
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
  }
}

// =============================================================================
// §6.5 — atomic finalize / backfill
// =============================================================================
export async function finalize(req, res) {
  try {
    const arcId = Number(req.params.id);
    const userId = req.user?.id;
    const verified = await reloadAndVerify(req, res, arcId);
    if (!verified) return;
    if (verified.arc.status !== 'draft') return bad(res, 409, 'This ARC has already been finalized', 0);
    // Double-finalize guard for the S0 (draft) target stage — where the final
    // status STAYS 'draft', so the status check above can't catch a replay. A
    // prior finalize always stamps a 'manual_finalized' event (§6.5.5).
    const already = await db.oneOrNone(
      `SELECT 1 FROM tbl_arc_event_log WHERE arc_id = $1 AND event_type = 'manual_finalized' LIMIT 1`, [arcId]);
    if (already) return bad(res, 409, 'This ARC has already been finalized', 0);

    const manual = verified.manual;
    const body = req.body || {};
    const stage = manual.target_stage;
    const rank = STAGE_RANK[stage];

    // The finalize body carries the backdated date chain + per-stage extras.
    const dates = {
      created_at: body.created_at ?? verified.arc.created_at,
      floated_at: body.floated_at,
      submission_start_at: body.submission_start_at,
      submission_end_at: body.submission_end_at,
      contract_start_at: body.contract_start_at,
      contract_end_at: body.contract_end_at,
      comm_finalized_at: body.comm_finalized_at,
      generated_at: body.generated_at,
      signed_by_vendor_at: body.signed_by_vendor_at,
    };

    // ---- §6.5.2 ended sub-status + awardedness FIRST (date validation depends
    // on it: a closed_no_award / not-awarded ARC has no contract or award and so
    // must NOT be forced to supply the contract/award date chain — §2.3¹/SC-4).
    let endedStatus = null;
    if (stage === 'ended') {
      endedStatus = body.ended_sub_status;
      if (!ENDED_SUB_STATUSES.includes(endedStatus)) {
        return bad(res, 400, `ended_sub_status must be one of ${ENDED_SUB_STATUSES.join(', ')}`);
      }
      if ((endedStatus === 'terminated' || endedStatus === 'closed_no_award') && !(body.closed_reason || '').trim()) {
        return bad(res, 400, 'closed_reason is required for terminated / closed_no_award');
      }
    }
    const wasAwarded = stage === 'ended' ? (endedStatus !== 'closed_no_award' && body.was_awarded !== false) : true;

    // ---- full server-side date-chain validation for the chosen target_stage ----
    const dateErrs = validateDateChain(stage, dates, wasAwarded);
    if (dateErrs.length) return res.status(400).json({ status: 0, message: dateErrs[0], errors: dateErrs });

    // Effective requirement rank: a not-awarded ended ARC (closed_no_award) needs
    // no items / vendors / window / contract data — collapse it to the draft
    // baseline (spec §2.3¹). Awarded ended ARCs keep the full chain.
    const effRank = (stage === 'ended' && !wasAwarded) ? STAGE_RANK.draft : rank;

    // Load the staged graph.
    const items = await arcModel.listItems(arcId);
    const invitations = await arcModel.listInvitations(arcId);
    const allQuoteLines = await db.any(
      `SELECT q.vendor_id, q.id AS quote_id, ql.id AS quote_line_id, ql.arc_item_id, ql.rate
         FROM tbl_arc_quote q JOIN tbl_arc_quote_line ql ON ql.arc_quote_id = q.id
        WHERE q.arc_id = $1`, [arcId]);

    // Items required for S0+ (warn at S0; block leaving evaluation+).
    if (effRank >= STAGE_RANK.floated && items.length === 0) {
      return bad(res, 400, 'at least one line item is required to leave Draft');
    }
    // Vendors required from D (floated+).
    if (effRank >= STAGE_RANK.floated && invitations.length === 0) {
      return bad(res, 400, 'at least one vendor is required from the Floated stage onward');
    }
    // SEC-4 — re-assert every invited vendor is subscription-eligible (unless the
    // ARC was explicitly marked override) so a finalized record is scope-clean.
    if (effRank >= STAGE_RANK.floated && !verified.manual.eligibility_overridden) {
      for (const inv of invitations) {
        if (!(await vendorEligibleForScope(inv.vendor_id, verified.arc.hotel_id, verified.arc.category_id))) {
          return bad(res, 400, `vendor ${inv.vendor_id} is not subscribed to this business unit / category`);
        }
      }
    }

    // Awards (G) required for S3+ (and S5 if awarded). Load award rows.
    const comm = await db.oneOrNone(`SELECT * FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId]);
    let awards = [];
    if (comm) awards = await db.any(`SELECT * FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id = $1`, [comm.id]);

    const needsAwards = rank >= STAGE_RANK.sig_pending && wasAwarded;
    if (needsAwards) {
      if (awards.length === 0) return bad(res, 400, 'awards are required from the Sig-pending stage onward');
      // §9.4 — Σ allocated_qty per item must equal indicative_qty.
      const byItem = new Map();
      for (const a of awards) {
        byItem.set(Number(a.arc_item_id), (byItem.get(Number(a.arc_item_id)) || 0) + Number(a.allocated_qty));
      }
      for (const it of items) {
        const allocated = byItem.get(Number(it.id)) || 0;
        if (Math.abs(allocated - Number(it.indicative_qty)) > 1e-6) {
          return res.status(400).json({
            status: 0,
            message: `awarded quantity for item ${it.id} (${allocated}) must equal its indicative quantity (${it.indicative_qty})`,
            field: `awards.item.${it.id}`,
          });
        }
      }
      // Committee decision required for S3+ (group L).
      if (!['approved', 'rejected'].includes(manual.committee_decision || body.committee_decision)) {
        return bad(res, 400, 'committee_decision (approved/rejected) is required from the Sig-pending stage onward');
      }
      // BE-6 — every awarded line must carry a real (> 0) rate. Without this, a
      // null/zero quote rate would materialize a contract line at unit_rate 0 —
      // a fabricated money value that feeds call-off PO consumption.
      const rateByLine = new Map(allQuoteLines.map((q) => [Number(q.quote_line_id), q.rate]));
      for (const a of awards) {
        const rate = rateByLine.get(Number(a.awarded_quote_line_id));
        if (rate == null || Number(rate) <= 0) {
          return res.status(400).json({
            status: 0,
            message: `awarded item ${a.arc_item_id}: the awarded vendor's quote rate must be greater than 0`,
            field: `awards.item.${a.arc_item_id}`,
          });
        }
      }
      // SEC-2 — the effective committee decider must be a user within the ARC's
      // scope. Guards the finalize-body path that bypasses the approvals section.
      const decidedBy = manual.committee_decided_by ?? (body.committee_decided_by != null ? Number(body.committee_decided_by) : null);
      if (decidedBy != null && !(await userInArcScope(decidedBy, verified.arc))) {
        return bad(res, 400, 'committee_decided_by must be a user with access to this ARC');
      }
    }

    // Uploaded documents (from §6.4) — keyed by vendor, latest wins.
    const docEvents = await db.any(
      `SELECT payload FROM tbl_arc_event_log
        WHERE arc_id = $1 AND event_type = 'manual_document_uploaded' ORDER BY at, id`, [arcId]);
    const docByVendor = new Map();
    for (const e of docEvents) {
      const pl = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {});
      if (pl.vendor_id) docByVendor.set(Number(pl.vendor_id), pl);
    }
    // S4 requires an uploaded signed PDF per awarded vendor.
    if (stage === 'active') {
      const awardedVendorIds = [...new Set(awards.map((a) => Number(a.awarded_vendor_id)))];
      for (const vid of awardedVendorIds) {
        if (!docByVendor.has(vid)) return bad(res, 400, `signed PDF upload is required for awarded vendor ${vid} (Active stage)`);
      }
    }

    const finalStatus = persistedStatusFor(stage, endedStatus, verified.arc);

    // ---- §6.5.3 write the graph atomically with BACKDATED timestamps ----
    const result = await db.tx(async (t) => {
      // S1+: backdate window + floated event + invitations invited_at.
      if (effRank >= STAGE_RANK.floated) {
        await t.none(
          `UPDATE tbl_arc SET submission_start_at = $2, submission_end_at = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [arcId, new Date(dates.submission_start_at), new Date(dates.submission_end_at)]);
        for (const inv of invitations) {
          await t.none(`UPDATE tbl_arc_invitation SET invited_at = $2 WHERE id = $1`, [inv.id, new Date(dates.floated_at)]);
        }
        await arcManualEntryModel.addBackdatedEvent(arcId, {
          eventType: ARC_EVENT_TYPES.PUBLISHED, actorId: userId,
          payload: { item_count: items.length, vendor_count: invitations.length }, at: new Date(dates.floated_at),
        }, t);
      }
      // S3+: contract window.
      if (effRank >= STAGE_RANK.sig_pending) {
        await t.none(
          `UPDATE tbl_arc SET contract_start_at = $2, contract_end_at = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [arcId, new Date(dates.contract_start_at), new Date(dates.contract_end_at)]);
      }

      // S2+: stamp quote submitted_at if not already set, within window.
      if (effRank >= STAGE_RANK.evaluation) {
        await t.none(
          `UPDATE tbl_arc_quote SET submitted_at = COALESCE(submitted_at, $2), updated_at = CURRENT_TIMESTAMP
            WHERE arc_id = $1 AND submitted_at IS NULL`,
          [arcId, dates.submission_end_at ? new Date(dates.submission_end_at) : new Date()]);
      }

      // S3+: comm-eval finalized + committee outcome snapshot.
      if (rank >= STAGE_RANK.sig_pending && wasAwarded) {
        await arcManualEntryModel.createCommEval(arcId, {
          status: 'finalized', finalized_by: userId, finalized_at: new Date(dates.comm_finalized_at),
        }, t);
        // Committee outcome snapshot on the manual-entry row (NO live approval instance).
        await arcManualEntryModel.update(arcId, {
          committee_decision: manual.committee_decision || body.committee_decision,
          committee_decided_at: body.committee_decided_at ? new Date(body.committee_decided_at) : new Date(dates.comm_finalized_at),
          committee_decided_by: manual.committee_decided_by || (body.committee_decided_by ? Number(body.committee_decided_by) : userId),
          committee_comment: manual.committee_comment || body.committee_comment || null,
        }, t);
        await arcManualEntryModel.addBackdatedEvent(arcId, {
          eventType: ARC_EVENT_TYPES.COMMITTEE_DECISION, actorId: userId,
          payload: { decision: manual.committee_decision || body.committee_decision }, at: new Date(dates.comm_finalized_at),
        }, t);
      }

      // S3/S4/S5(awarded): build one contract per awarded vendor.
      const contracts = [];
      if (rank >= STAGE_RANK.sig_pending && wasAwarded) {
        const awardsByVendor = new Map();
        for (const a of awards) {
          const vid = Number(a.awarded_vendor_id);
          if (!awardsByVendor.has(vid)) awardsByVendor.set(vid, []);
          awardsByVendor.get(vid).push(a);
        }
        for (const [vid, vAwards] of awardsByVendor) {
          const doc = docByVendor.get(vid) || {};
          let contractStatus = 'awaiting_acceptance';
          let docSource = 'generated';
          let docUrl = null, docHash = null, signedAt = null, awaitingUntil = null;
          if (stage === 'sig_pending') {
            contractStatus = 'awaiting_acceptance';
            awaitingUntil = new Date(new Date(dates.generated_at || dates.comm_finalized_at).getTime() + 7 * 86400_000);
          } else if (stage === 'active') {
            contractStatus = 'active';
            docSource = 'manual_upload';
            docUrl = doc.document_s3_url || null;
            docHash = doc.document_hash || null;
            signedAt = new Date(dates.signed_by_vendor_at);
          } else if (stage === 'ended') {
            contractStatus = endedStatus === 'terminated' ? 'terminated' : 'expired';
            if (doc.document_s3_url) { docSource = 'manual_upload'; docUrl = doc.document_s3_url; docHash = doc.document_hash; }
          }
          const contract = await arcManualEntryModel.createBackdatedContract({
            arc_id: arcId, vendor_id: vid,
            document_s3_url: docUrl, document_hash: docHash, document_source: docSource,
            status: contractStatus,
            generated_at: dates.generated_at ? new Date(dates.generated_at) : new Date(dates.comm_finalized_at),
            awaiting_until: awaitingUntil,
            signed_by_vendor_at: signedAt,
            terminated_at: stage === 'ended' && endedStatus === 'terminated' ? new Date(dates.contract_end_at) : null,
            terminated_reason: stage === 'ended' && endedStatus === 'terminated' ? (body.closed_reason || null) : null,
          }, t);
          for (const a of vAwards) {
            const snap = typeof a.awarded_quote_snapshot === 'string' ? JSON.parse(a.awarded_quote_snapshot) : (a.awarded_quote_snapshot || {});
            await arcManualEntryModel.addContractLine(contract.id, {
              arc_item_id: Number(a.arc_item_id),
              unit_rate: snap.rate ?? 0,
              gst_pct: snap.gst_pct ?? null,
              charges: snap.charges ?? [],
              payment_terms: snap.payment_terms ?? null,
              delivery_terms: snap.delivery_terms ?? null,
              committed_qty: Number(a.allocated_qty),
              awarded_quote_snapshot: snap,
            }, t);
          }
          contracts.push(contract);
          await arcManualEntryModel.addBackdatedEvent(arcId, {
            eventType: ARC_EVENT_TYPES.CONTRACT_GENERATED, actorId: userId,
            payload: { contract_id: contract.id, vendor_id: vid, status: contractStatus, document_source: docSource },
            at: dates.generated_at ? new Date(dates.generated_at) : new Date(dates.comm_finalized_at),
          }, t);
          if (stage === 'active') {
            await arcManualEntryModel.addBackdatedEvent(arcId, {
              eventType: ARC_EVENT_TYPES.CONTRACT_SIGNED, actorId: userId,
              payload: { contract_id: contract.id, vendor_id: vid, document_source: docSource },
              at: signedAt,
            }, t);
          }
        }
      }

      // Set the final ARC status + closed_reason.
      await arcModel.setStatus(arcId, finalStatus,
        endedStatus && (endedStatus === 'terminated' || endedStatus === 'closed_no_award')
          ? { closed_reason: body.closed_reason || null } : {}, t);

      await arcManualEntryModel.addBackdatedEvent(arcId, {
        eventType: 'manual_finalized', actorId: userId,
        payload: { target_stage: stage, final_status: finalStatus }, at: null,
      }, t);

      return { contracts };
    });

    const arc = await arcModel.getById(arcId);

    // ---- §6.5.6 post-commit: notifications ----
    // ONLY S3 (genuine pending sign) notifies vendors. S1/S2/S4/S5 suppress all.
    const warnings = [];
    if (stage === 'sig_pending') {
      await notifyAwaitingVendors(arc, result.contracts, userId).catch((err) => {
        logger.error({ err, arcId }, '[arcManualController.finalize] S3 vendor notify failed');
        warnings.push('vendor notification dispatch failed (non-fatal)');
      });
    }

    return ok(res, {
      arc: { id: arc.id, status: arc.status, arc_number: arc.arc_number },
      contracts: result.contracts.map((c) => ({ id: c.id, vendor_id: c.vendor_id, status: c.status, document_source: c.document_source })),
      warnings,
    }, 'Manual ARC finalized');
  } catch (err) {
    if (err.httpStatus) return bad(res, err.httpStatus, err.message);
    logger.error({ err }, '[arcManualController.finalize]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Map the target stage (+ended sub-status) to the persisted tbl_arc.status (§2.2).
function persistedStatusFor(stage, endedStatus, arc = {}) {
  switch (stage) {
    case 'draft': return 'draft';
    case 'floated': return 'floated';
    // SC-3 — when a technical response is required, the evaluation stage is the
    // technical envelope; otherwise it is the commercial one.
    case 'evaluation': return arc.technical_response_required ? 'tech_eval_in_progress' : 'comm_eval_in_progress';
    case 'sig_pending': return 'awaiting_vendor_acceptance';
    case 'active': return 'contract_active';
    case 'ended': return endedStatus; // expired | terminated | closed_no_award
    default: return 'draft';
  }
}

// S3 only — emit the real awaiting-acceptance notification to the contracted
// vendors so they receive the genuine pending sign request (the one live case).
async function notifyAwaitingVendors(arc, contracts, actorId) {
  const vendorIds = [...new Set(contracts.map((c) => Number(c.vendor_id)).filter(Boolean))];
  if (vendorIds.length === 0) return;
  await dispatchNotification({
    userIds: vendorIds,
    senderUserId: actorId,
    category: 'ARC',
    type: 'ARC_CONTRACT_AWAITING_ACCEPTANCE',
    title: 'Rate contract awaiting your signature',
    body: `${arc.title} (${arc.arc_number}) is ready for you to review and e-sign.`,
    data: { arc_id: arc.id, arc_number: arc.arc_number },
    actionUrl: '/dashboard/vendor/rate-contracts/pending-acceptance',
  });
  // Email is best-effort.
  const rows = await db.any(`SELECT id, name, email FROM tbl_users WHERE id = ANY($1::int[])`, [vendorIds]);
  for (const v of rows) {
    if (!v.email) continue;
    sendMail({
      to: v.email,
      subject: `Rate contract awaiting your signature: ${arc.title}`,
      html: `<p>Hello ${v.name || 'Vendor'},</p>
             <p>A rate contract <strong>${arc.title}</strong> (${arc.arc_number}) is awaiting your e-signature.</p>
             <p>Please log in to your vendor portal to review and sign.</p>`,
    }).catch((err) => logger.error({ err, arcId: arc.id, vendor: v.id }, '[arcManualController] awaiting email failed'));
  }
}
