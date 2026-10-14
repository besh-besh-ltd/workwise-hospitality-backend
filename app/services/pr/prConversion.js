// Purchase Requisitions — conversion: approved pool lines → ONE RFQ draft
// (spec §9; POST /pr/convert).
//
// A buyer selects approved PR lines — from one PR or many, all of one hotel —
// and the server builds a single RFQ draft in the shape copyRfq produces
// (rfqController.copyRfq): the tbl_rfq header (status 1, unpublished, created
// by the buyer), its hotel mapping, and per catalog variant one
// tbl_rfq_products row with Quantity/Unit specs, files (the lines' own, plus
// each source PR's files for the whole PR — R41), technical-evaluation
// clauses and the eligible vendors. The buyer then finishes it in the existing
// RFQ wizard (bid end date, vendors, terms) and the RFQ approval runs as for
// any other RFQ — conversion never publishes and never bypasses approval.
//
// Everything written to the RFQ is vendor-visible, so nothing internal goes
// there: tbl_rfq.comment (the buyer's "Additional Terms & Conditions", merged
// into the PO's T&C) stays empty (R22); the title is the first PR's title, not
// PR numbers (R25); a product's specification is the lines' specification —
// tagged "[PR-… · department · qty unit]" only when its lines disagree (R26) —
// never requester names, never the suggested-vendor note.
//
// Every source line gets a tbl_pr_line_rfq link to its RFQ product. Nothing in
// the RFQ / PO code knows about PRs: the line's progress (in_sourcing, ordered,
// back in_pool) is derived from the RFQ and PO tables alone (LINE_PROGRESS_SQL).
//
// One transaction, in this order:
//   1. tenant — on an UNLOCKED read: 404 for an unknown line, lines of several
//               companies, or a company that is not the caller's — so a
//               foreign caller never locks another tenant's rows;
//   2. lock   — the PR rows (id order), then the lines (id order), then the
//               per-line advisory lock pr_line_convert (R19: the order of every
//               buyer line action, so they can never deadlock each other);
//   3. check  — 422 PR_HOTEL_MISMATCH, 422 department / process, 403
//               pr.convert on the hotel and rfq.create on (company, hotel,
//               department, process) exactly as saveRfqDraft checks it, then
//               409 PR_LINE_NOT_CONVERTIBLE listing every refused line, then
//               422 PR_UNIT_MISMATCH and 422 PR_SPEC_TOO_LONG per variant;
//   4. build  — the RFQ draft, the links and one `converted` event per line.
// The requesters are notified after the commit (prNotify never throws).

import db from '../../config/dbConn.js';
import * as prModel from '../../models/pr/prModel.js';
import hospitalityModel from '../../models/hospitalityModel.js';
import { assertUserHasScope, isAuthorizationError } from '../authorizationService.js';
import { directInviteIdsForLine } from '../vendorNetwork/directInvites.js';
import { propagateRoutedCopiesLocked } from '../vendorNetwork/subjects/rfqRoutedCopies.js';
import { PR_ERR, prError } from './prErrors.js';
import { record } from './prEvents.js';
import { assertPerm, isSuperAdmin, notFound } from './prAccess.js';
import { describeVariants, contractCoverage } from './prCatalog.js';
import { CLAUSE_TYPES, DEFAULT_CLAUSE_TYPE } from './prConstants.js';
import { notifyConverted } from './prNotify.js';

/** Lines one conversion may take. */
export const MAX_CONVERT_LINES = 200;
/** How often the header insert retries a lost race for rfq_no (MAX + 1, as copyRfq). */
const RFQ_NO_ATTEMPTS = 3;
/** PR attachment kind → RFQ product file type (tbl_rfq_product_files.file_type). */
const FILE_TYPE_SQL = `CASE a.kind WHEN 'datasheet' THEN 'TDS' WHEN 'qap' THEN 'QAP' ELSE 'SPEC' END`;
/** tbl_rfq.title is VARCHAR(500). */
const RFQ_TITLE_MAX = 500;
/**
 * An RFQ product's specification (tbl_rfq_products.comment) holds 1000
 * characters — the RFQ wizard's and PUT /rfq/update's limit (CreateRFQ.js,
 * rfqValidation `comment: Joi.string().max(1000)`). A merged specification
 * longer than that is refused, never truncated (R23).
 */
export const RFQ_SPEC_MAX = 1000;

const INT4_MAX = 2147483647;
function posInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 && v <= INT4_MAX ? v : null;
  if (typeof v === 'string' && /^\d{1,10}$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 && n <= INT4_MAX ? n : null;
  }
  return null;
}
const asObject = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
const unitKey = (uom) => String(uom ?? '').trim().toLowerCase();

/**
 * RFQ create's contact_number rule (rfqValidation.create: max 20 characters,
 * /^(?:\+\d{1,4}-)?\d{6,15}$/). A converted draft must pass it as is.
 */
const RFQ_CONTACT_RE = /^(?:\+\d{1,4}-)?\d{6,15}$/;
const RFQ_CONTACT_MAX = 20;
const rfqContactOrEmpty = (value) => (value.length <= RFQ_CONTACT_MAX && RFQ_CONTACT_RE.test(value) ? value : '');

/**
 * The buyer's mobile in the RFQ wizard's stored contact shape, "+<CC>-<number>".
 *
 * Every draft the wizard saves itself has that shape, and the wizard splits it
 * on "-" when it loads a draft. A bare number ("9000096018") came back with an
 * empty country code and was re-sent as "-9000096018", which RFQ create
 * refuses. The wizard's default country is +91, so a number without one gets
 * +91 (an international "00" prefix, then a leading 0 or 91, is dropped:
 * "0091 98…" → "+91-98…"). The country code is 1-4 digits and the result must
 * pass RFQ create's own rule (RFQ_CONTACT_RE, ≤ 20 characters). Anything else
 * becomes '' and the wizard asks for it.
 */
export function rfqContactNumber(mobile) {
  const raw = String(mobile ?? '').trim();
  if (!raw) return '';
  const withCode = raw.match(/^\+(\d{1,4})[\s-]+([\d\s-]+)$/);
  if (withCode) return rfqContactOrEmpty(`+${withCode[1]}-${withCode[2].replace(/\D/g, '')}`);
  // "+919876543210": no separator, so only an Indian number can be split safely.
  const glued = raw.match(/^\+(\d+)$/);
  if (glued) return glued[1].length === 12 && glued[1].startsWith('91') ? rfqContactOrEmpty(`+91-${glued[1].slice(2)}`) : '';
  if (/[^\d\s-]/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return rfqContactOrEmpty(`+91-${digits}`);
}

/** The wizard page that opens an RFQ draft. */
export const rfqDraftUrl = (rfqId) => `/dashboard/buyer/rfq-management?tab=create-rfq&draft_id=${rfqId}`;

/**
 * POST /pr/convert's body → {lineIds (distinct, ascending), departmentId, processId|null}, else 422.
 */
export function parseConvertBody(body) {
  const b = asObject(body);
  const errors = [];
  let lineIds = null;
  if (!Array.isArray(b.line_ids) || b.line_ids.length === 0 || b.line_ids.length > MAX_CONVERT_LINES) {
    errors.push({ field: 'line_ids', message: `Select between 1 and ${MAX_CONVERT_LINES} lines` });
  } else {
    const ids = b.line_ids.map(posInt);
    if (ids.some((n) => n === null)) errors.push({ field: 'line_ids', message: 'line_ids must be line ids' });
    else lineIds = [...new Set(ids)].sort((x, y) => x - y);
  }
  const departmentId = posInt(b.department_id);
  if (!departmentId) errors.push({ field: 'department_id', message: 'Pick the department the RFQ is raised for' });
  let processId = null;
  if (b.process_id !== undefined && b.process_id !== null && b.process_id !== '') {
    processId = posInt(b.process_id);
    if (!processId) errors.push({ field: 'process_id', message: 'Invalid process' });
  }
  if (errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', errors);
  return { lineIds, departmentId, processId };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Why `line` (a convertLineStates row) of `pr` cannot be converted, or null.
 * First match wins: the PR, the line's own state, an existing live RFQ link,
 * a missing catalog item, then the catalog re-checks (the catalog can change
 * between approval and conversion — Review Focus 4).
 */
function refusal(pr, line, { variants, onContract }) {
  if (pr.status !== 'approved') return 'not_approved';
  if (line.status !== 'active') return 'not_active';
  if (line.has_live_link === true) return 'already_sourced';
  if (line.variant_id == null) return line.has_open_catalog_request === true ? 'awaiting_catalog' : 'needs_mapping';
  if (!variants.get(Number(line.variant_id))?.usable) return 'variant_not_usable';
  if (onContract.has(`${pr.department_id}:${line.variant_id}`)) return 'on_contract';
  return null;
}

/**
 * Variants on a live rate contract for (hotel, the line's PR department) — the
 * cell the PR was raised for, which is what an MR would be raised for instead
 * (the same rule as submit and map). Keys "department:variant".
 */
async function contractedKeys(t, hotelId, states, prById) {
  const byDept = new Map();
  for (const s of states) {
    if (s.variant_id == null) continue;
    const dept = Number(prById.get(Number(s.pr_id)).department_id);
    if (!byDept.has(dept)) byDept.set(dept, new Set());
    byDept.get(dept).add(Number(s.variant_id));
  }
  const keys = new Set();
  for (const [dept, variantIds] of byDept) {
    const covered = await contractCoverage({ hotelId, departmentId: dept, variantIds: [...variantIds] }, t);
    for (const variantId of covered.keys()) keys.add(`${dept}:${variantId}`);
  }
  return keys;
}

/**
 * The caller may create this RFQ: pr.convert on the hotel (any department),
 * then rfq.create exactly as saveRfqDraft checks it — mapped to the company /
 * hotel (hospitalityModel.userHasContext) and assertUserHasScope on
 * (company, hotel, department, process). Else 403.
 */
async function assertMayConvert(t, user, { companyId, hotelId, departmentId, processId }) {
  await assertPerm(user.id, 'pr.convert', { companyId, hotelId, departmentId: null }, t);
  const forbidden = () => prError(PR_ERR.FORBIDDEN,
    'You cannot create RFQs for this hotel and department', { permission: 'rfq.create' });
  if (!(await hospitalityModel.userHasContext(user.id, companyId, hotelId, t))) throw forbidden();
  try {
    await assertUserHasScope(user.id, 'rfq.create', {
      hospitality_company_id: companyId,
      hotel_id: hotelId,
      department_id: departmentId,
      process_id: processId,
    }, t);
  } catch (err) {
    if (isAuthorizationError(err)) throw forbidden();
    throw err;
  }
}

/** 422 PR_UNIT_MISMATCH when one variant's lines disagree on the unit (trimmed, case-insensitive). */
function assertOneUnitPerVariant(states) {
  const groups = new Map();
  for (const s of states) {
    const v = Number(s.variant_id);
    if (!groups.has(v)) groups.set(v, { variant_id: v, units: new Map(), line_ids: [] });
    const g = groups.get(v);
    if (!g.units.has(unitKey(s.uom))) g.units.set(unitKey(s.uom), s.uom);
    g.line_ids.push(Number(s.id));
  }
  const mismatched = [...groups.values()].filter((g) => g.units.size > 1)
    .map((g) => ({ variant_id: g.variant_id, units: [...g.units.values()], line_ids: g.line_ids }));
  if (mismatched.length) {
    throw prError(PR_ERR.UNIT_MISMATCH,
      'Lines of the same item must use the same unit — convert them separately or ask the requesters to align the unit',
      mismatched);
  }
}

// ---------------------------------------------------------------------------
// Building the RFQ draft
// ---------------------------------------------------------------------------

/**
 * The vendor-facing RFQ title (R25): the first PR's title (by PR id), plus
 * " & N more" when the lines come from N other PRs, within VARCHAR(500).
 */
function rfqTitle(prs) {
  const more = prs.length > 1 ? ` & ${prs.length - 1} more` : '';
  const title = String(prs[0].title ?? '').trim();
  return `${title.slice(0, RFQ_TITLE_MAX - more.length).trim()}${more}`;
}

/**
 * A product's merged specification (vendor-visible; R22, R23, R26).
 *
 * Each line contributes its text: the specification, after its free-text name
 * for a mapped free-text line (what the requester asked for). Texts are
 * compared trimmed.
 *   - ONE distinct text (one line, identical lines, or all empty): that text
 *     alone, untagged — so a line whose specification passed the 1000-character
 *     entry cap always converts. If a free-text name would push it past the RFQ
 *     limit, the name is dropped and the specification alone is used (R26).
 *   - Several texts but ONE distinct non-empty specification (the others are
 *     empty, or differ only by a free-text name): that specification alone,
 *     untagged — the "one spec" decision is keyed on the specification, so an
 *     empty line or a name never turns an entry-capped spec into a refusal.
 *   - Several distinct specifications: one block per text, in order of first
 *     appearance, each listing the tags of the lines it came from —
 *     "[PR-a · department · qty unit] [PR-b · …] text" — joined by a blank
 *     line. Only this form can exceed the limit (→ PR_SPEC_TOO_LONG).
 * Never requester names or the suggested-vendor note.
 */
function productComment(lines, prById, deptTitles) {
  const blocks = new Map(); // text → {specification, tags}
  const specifications = new Set(); // distinct non-empty specifications
  for (const l of lines) {
    const pr = prById.get(Number(l.pr_id));
    const tag = [pr.pr_number, deptTitles.get(Number(pr.id)), `${l.quantity_text} ${l.uom}`].filter(Boolean).join(' · ');
    const specification = typeof l.specification === 'string' ? l.specification.trim() : '';
    if (specification) specifications.add(specification);
    const text = [
      l.line_kind === 'free_text' ? String(l.free_text_name ?? '').trim() : null,
      specification,
    ].filter(Boolean).join(' — ');
    if (!blocks.has(text)) blocks.set(text, { specification, tags: [] });
    blocks.get(text).tags.push(`[${tag}]`);
  }
  if (blocks.size === 1) {
    const [[text, { specification }]] = blocks;
    return text.length <= RFQ_SPEC_MAX ? text : specification;
  }
  if (specifications.size === 1) return [...specifications][0];
  return [...blocks].map(([text, { tags }]) => `${tags.join(' ')}${text ? ` ${text}` : ''}`).join('\n\n');
}

/** The header, as copyRfq inserts it (rfq_no = MAX + 1). Retries a lost rfq_no race in a savepoint. */
async function insertRfqHeader(t, h) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await t.tx((sp) => sp.one(
        `INSERT INTO tbl_rfq (
           rfq_no, comment, company_name, response_email, contact_name, contact_number,
           bid_end_date, location, is_published, created_by, updated_by, status,
           reverse_auction, is_tender, hospitality_company_id, hotel_id, process_id, department_id, title
         ) VALUES (
           (SELECT COALESCE(MAX(rfq_no), 100000) + 1 FROM tbl_rfq), $1, $2, $3, $4, $5,
           '', $6, 0, $7, $7, 1,
           0, 0, $8, $9, $10, $11, $12
         )
         RETURNING id, rfq_no`,
        [h.comment, h.companyName, h.responseEmail, h.contactName, h.contactNumber,
          h.location, h.createdBy, h.companyId, h.hotelId, h.processId, h.departmentId, h.title]));
    } catch (err) {
      if (err?.code === '23505' && err?.constraint === 'uq_tbl_rfq_rfq_no' && attempt < RFQ_NO_ATTEMPTS) continue;
      throw err;
    }
  }
}

/**
 * One RFQ product for a variant group: the product row (variant index as
 * rfqModel.getNextVariant, no sheet), Quantity/Unit specs, files, the
 * technical evaluation (only when a source line has clauses) and the vendors.
 * Returns the product id and its variant index.
 */
async function insertProduct(t, { rfqId, hotelId, group, comment, unit }) {
  const product = await t.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, qap, datasheet_file, variant, sheet_id)
     VALUES ($1, $2, '', '', '', $3, '', '',
             (SELECT COALESCE(MAX(variant), -1) + 1 FROM tbl_rfq_products WHERE rfq_id = $1 AND product_variant_id = $3),
             NULL)
     RETURNING id, variant`,
    [rfqId, comment, group.variant_id]);
  const rfqProductId = Number(product.id);
  const variant = Number(product.variant);

  await t.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant, sheet_id)
     VALUES ($1, $2, 'Quantity', $3, $4, NULL), ($1, $2, 'Unit', $5, $4, NULL)`,
    [rfqId, group.variant_id, group.quantity, variant, unit]);

  // Line attachments: spec → SPEC, datasheet → TDS, qap → QAP, other → SPEC (one row per type + URL).
  await t.none(
    `INSERT INTO tbl_rfq_product_files (rfq_product_id, file_type, file_url)
     SELECT $1, f.file_type, f.file_url
       FROM (SELECT ${FILE_TYPE_SQL} AS file_type, a.file_url, MIN(a.id) AS first_id
               FROM tbl_pr_attachment a
              WHERE a.pr_line_id = ANY($2::int[])
              GROUP BY 1, 2) f
      ORDER BY f.first_id`,
    [rfqProductId, group.line_ids]);

  // Files for the whole PR (pr_line_id NULL, R41) of every PR this product's
  // lines come from. The RFQ has no vendor-visible RFQ-level document slot
  // (tbl_rfq_files holds only the buyer's T&C files), so they go on each product
  // built from that PR's lines, kind-mapped like line files and once per URL:
  // the same file on two merged PRs, or already put there by a line file, is
  // not added again.
  await t.none(
    `INSERT INTO tbl_rfq_product_files (rfq_product_id, file_type, file_url)
     SELECT $1, f.file_type, f.file_url
       FROM (SELECT DISTINCT ON (a.file_url) ${FILE_TYPE_SQL} AS file_type, a.file_url, a.id
               FROM tbl_pr_attachment a
              WHERE a.pr_line_id IS NULL
                AND a.pr_id IN (SELECT l.pr_id FROM tbl_purchase_requisition_line l WHERE l.id = ANY($2::int[]))
                AND NOT EXISTS (SELECT 1 FROM tbl_rfq_product_files x
                                 WHERE x.rfq_product_id = $1 AND x.file_url = a.file_url)
              ORDER BY a.file_url, a.id) f
      ORDER BY f.id`,
    [rfqProductId, group.line_ids]);

  // Technical evaluation, as POST /rfq/add-clause creates it: minimum_passing_score
  // is left to the column default (rfqModel.addClause never sets it).
  const evaluation = await t.oneOrNone(
    `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, "timestamp")
     SELECT $1, $2, NOW()
      WHERE EXISTS (SELECT 1 FROM tbl_pr_line_clause WHERE pr_line_id = ANY($3::int[]))
     RETURNING id`,
    [rfqId, rfqProductId, group.line_ids]);
  if (evaluation) {
    await t.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
         (tbl_rfq_product_tech_evaluation_id, clause_text, clause_type, weightage, "timestamp")
       SELECT $1, cl.clause_text,
              CASE WHEN cl.clause_type = ANY($3::text[]) THEN cl.clause_type ELSE $4 END,
              ROUND(cl.weightage)::int, NOW()
         FROM tbl_pr_line_clause cl
        WHERE cl.pr_line_id = ANY($2::int[])
        ORDER BY cl.pr_line_id, cl.id`,
      [evaluation.id, group.line_ids, [...CLAUSE_TYPES], DEFAULT_CLAUSE_TYPE]);
  }

  // Vendors: the add-product flow's eligibility resolver for the hotel, then the
  // Vendor Networks direct-invite rule. None is a legal draft (publish blocks it).
  const eligible = await hospitalityModel.getEligibleVendorsForVariant(group.variant_id, [hotelId], t);
  const vendorIds = await directInviteIdsForLine(
    t, { rfqId, productVariantId: group.variant_id, variant }, eligible.map((v) => v.vendor_id));
  if (vendorIds.length) {
    await t.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant, is_rfq_viewed)
       SELECT $1, $2, v.id, $3, 0 FROM unnest($4::int[]) WITH ORDINALITY AS v(id, n) ORDER BY v.n`,
      [rfqId, group.variant_id, variant, vendorIds]);
  }
  return { rfqProductId, variant };
}

// ---------------------------------------------------------------------------
// The conversion
// ---------------------------------------------------------------------------

/**
 * Convert approved pool lines into one RFQ draft, inside the caller's
 * transaction `t` (see the file header for the order of locks and checks).
 * @param {{user, lineIds: number[], departmentId: number, processId?: number|null}} input
 * @returns {Promise<{rfq_id, rfq_no, redirect, converted: Array<{pr, line_count}>}>}
 *   `converted` = what the after-commit notifications need.
 */
export async function convertLines({ user, lineIds, departmentId, processId = null }, t) {
  if (!t || typeof t.one !== 'function') throw new Error('prConversion.convertLines: a transaction is required');
  // 1. Tenant, on an unlocked read: one company, the caller's — else the lines
  //    do not exist for them, and none of their rows is ever locked.
  const owners = await prModel.lineOwners(lineIds, t);
  if (owners.length !== lineIds.length) throw notFound();
  const companyIds = [...new Set(owners.map((o) => o.company_id))];
  if (companyIds.length !== 1) throw notFound();
  const [companyId] = companyIds;
  if (!isSuperAdmin(user) && !(await prModel.isTenantMember(user.id, companyId, t))) throw notFound();

  // 2. Locks: PR rows, then lines, then the per-line advisory locks (R19).
  const prs = await prModel.lockPrs(t, [...new Set(owners.map((o) => o.pr_id))].sort((x, y) => x - y));
  const locked = await prModel.lockLines(t, lineIds);
  if (locked.length !== lineIds.length) throw notFound(); // a line deleted while we waited
  await prModel.lockLinesForConvert(t, lineIds);
  const prById = new Map(prs.map((p) => [Number(p.id), p]));
  if (locked.some((l) => !prById.has(l.pr_id))) throw notFound();
  if (prs.some((p) => Number(p.hospitality_company_id) !== companyId)) throw notFound(); // moved while we waited

  // 3. Checks.

  const hotelIds = [...new Set(prs.map((p) => Number(p.hotel_id)))].sort((x, y) => x - y);
  if (hotelIds.length !== 1) {
    throw prError(PR_ERR.HOTEL_MISMATCH, 'An RFQ is for one hotel — convert each hotel\'s lines separately',
      hotelIds.map((hotelId) => ({
        hotel_id: hotelId,
        line_ids: locked.filter((l) => Number(prById.get(l.pr_id).hotel_id) === hotelId).map((l) => l.id),
      })));
  }
  const [hotelId] = hotelIds;

  if (!(await prModel.departmentExists(departmentId, t))) {
    throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', [
      { field: 'department_id', message: 'This department does not exist' }]);
  }
  if (processId && !(await prModel.isActiveProcessOfCompany(processId, companyId, t))) {
    throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', [
      { field: 'process_id', message: 'This process is not an active process of the company' }]);
  }
  await assertMayConvert(t, user, { companyId, hotelId, departmentId, processId });

  const states = await prModel.convertLineStates(lineIds, t);
  const variants = await describeVariants(states.map((s) => s.variant_id).filter((v) => v != null), t);
  const onContract = await contractedKeys(t, hotelId, states, prById);
  const refused = states
    .map((s) => ({ s, reason: refusal(prById.get(Number(s.pr_id)), s, { variants, onContract }) }))
    .filter((x) => x.reason)
    .map(({ s, reason }) => ({
      line_id: Number(s.id), pr_number: prById.get(Number(s.pr_id)).pr_number, line_no: Number(s.line_no), reason,
    }));
  if (refused.length) {
    throw prError(PR_ERR.LINE_NOT_CONVERTIBLE,
      `${refused.length === 1 ? 'A selected line' : `${refused.length} selected lines`} can no longer be converted — refresh the purchase queue`,
      refused);
  }
  assertOneUnitPerVariant(states);

  // Each RFQ product's merged specification, refused (never truncated) over the RFQ limit.
  const deptTitles = await prModel.prDepartmentTitles(prs.map((p) => Number(p.id)), t);
  const stateById = new Map(states.map((s) => [Number(s.id), s]));
  const plan = (await prModel.convertGroups(lineIds, t)).map((group) => {
    const lines = group.line_ids.map((id) => stateById.get(id));
    return { group, lines, comment: productComment(lines, prById, deptTitles) };
  });
  const tooLong = plan.filter((x) => x.comment.length > RFQ_SPEC_MAX)
    .map((x) => ({ variant_id: x.group.variant_id, length: x.comment.length, line_ids: x.group.line_ids }));
  if (tooLong.length) {
    throw prError(PR_ERR.SPEC_TOO_LONG,
      `The merged specification of ${tooLong.length === 1 ? 'an item' : `${tooLong.length} items`} is longer than the `
      + `${RFQ_SPEC_MAX} characters an RFQ item allows — convert those lines in separate RFQs`,
      tooLong);
  }

  // 4. Build the draft.
  const hotel = await t.one(
    `SELECT hc.name AS company_name,
            COALESCE(NULLIF(btrim(h.delivery_address), ''), NULLIF(btrim(h.full_address), ''),
                     NULLIF(btrim(h.city), ''), '') AS location
       FROM tbl_hospitality_company_hotels h
       JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
      WHERE h.id = $1`,
    [hotelId]);
  const buyer = await t.one(`SELECT name, email, mobile FROM tbl_users WHERE id = $1`, [user.id]);

  const rfq = await insertRfqHeader(t, {
    comment: '', // R22: the buyer's vendor-visible "Additional Terms & Conditions" — not ours to fill
    companyName: hotel.company_name ?? '',
    responseEmail: buyer.email ?? '',
    contactName: buyer.name ?? '',
    contactNumber: rfqContactNumber(buyer.mobile),
    location: hotel.location,
    createdBy: user.id,
    companyId,
    hotelId,
    processId,
    departmentId,
    title: rfqTitle(prs),
  });
  const rfqId = Number(rfq.id);
  const rfqNo = Number(rfq.rfq_no);
  await t.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [rfqId, hotelId, user.id]);

  for (const { group, lines, comment } of plan) {
    const { rfqProductId } = await insertProduct(t, { rfqId, hotelId, group, comment, unit: lines[0].uom });
    await t.none(
      `INSERT INTO tbl_pr_line_rfq (pr_line_id, rfq_id, rfq_product_id, quantity, converted_by)
       SELECT l.id, $2, $3, l.quantity, $4
         FROM tbl_purchase_requisition_line l
        WHERE l.id = ANY($1::int[])
        ORDER BY l.id`,
      [group.line_ids, rfqId, rfqProductId, user.id]);
    for (const l of lines) {
      const pr = prById.get(Number(l.pr_id));
      await record(t, {
        prId: pr.id, lineId: l.id, revision: pr.revision, actorId: user.id, type: 'converted',
        payload: { rfq_id: rfqId, rfq_no: rfqNo, rfq_product_id: rfqProductId },
      });
    }
  }
  // Vendor Networks: routed members follow their principal's new invite rows.
  await propagateRoutedCopiesLocked(t, rfqId);

  return {
    rfq_id: rfqId,
    rfq_no: rfqNo,
    redirect: rfqDraftUrl(rfqId),
    converted: prs.map((pr) => ({ pr, line_count: locked.filter((l) => l.pr_id === Number(pr.id)).length })),
  };
}

/**
 * POST /pr/convert {line_ids, department_id, process_id?}: validate the body,
 * convert in one transaction, then tell each PR's requester (after the commit).
 * @returns {Promise<{rfq_id, rfq_no, redirect}>}
 */
export async function convert(user, body) {
  const input = parseConvertBody(body);
  const out = await db.tx((t) => convertLines({ user, ...input }, t));
  // One per PR, concurrently; each never throws (prNotify).
  await Promise.all(out.converted.map(({ pr, line_count: lineCount }) =>
    notifyConverted({ pr, rfqNo: out.rfq_no, lineCount, actorId: user.id })));
  return { rfq_id: out.rfq_id, rfq_no: out.rfq_no, redirect: out.redirect };
}

export default { convert, convertLines, parseConvertBody, rfqDraftUrl, rfqContactNumber, MAX_CONVERT_LINES, RFQ_SPEC_MAX };
