// Purchase Requisitions — reviewer edits during technical review (spec §6.3).
//
//   reviewRights       the detail's capabilities.review (lines the caller may edit).
//   editSpecification  a line's specification (the caller's own open review).
//   addClause / removeClause
//                      technical clauses on a line of the caller's open review.
//   addAttachment / removeAttachment
//                      the requester (draft / returned) or a reviewer (own
//                      lines, in_review) — attachmentRole decides.
//
// These change a PR's content, never its status: the state machine (submit,
// review complete / send back, approval, withdraw) lives in prWorkflow.js,
// whose shared helpers (lockReadable, stateConflict…) are used here so both
// answer the same refusals the same way.
//
// Who is a reviewer is decided HERE, at action time, by one model call —
// prModel.eligibleReviews (the eligible-reviewer predicate of the lists and
// now_with, narrowed to the caller) — never from the reviewer ids recorded at
// submit. Order of refusals in every handler: not readable / unknown → 404;
// wrong state → 409; not an eligible reviewer (or not the requester) → 403;
// a bad body → 422 — authorization before validation, so a caller without
// access learns nothing about the payload. Every change runs in one db.tx under
// the PR row lock and writes its tbl_pr_event in the same transaction.

import db from '../../config/dbConn.js';
import * as prModel from '../../models/pr/prModel.js';
import { PR_ERR, prError } from './prErrors.js';
import { record } from './prEvents.js';
import { assertPerm, cellOf, isRequester } from './prAccess.js';
import { isOwnUploadUrl } from './prCatalog.js';
import {
  EDITABLE_STATUSES, MAX_LEN, CLAUSE_TYPES, DEFAULT_CLAUSE_TYPE, MAX_WEIGHTAGE, ATTACHMENT_KINDS,
} from './prConstants.js';
import { asObject, humanStatus, lockReadable, stateConflict } from './prWorkflow.js';

const NOT_REVIEWER = 'Only a technical reviewer of this line’s department can change it during the review';

async function lineOrNotFound(t, pr, lineId) {
  const line = lineId ? await prModel.lineOfPr(t, pr.id, lineId) : null;
  if (!line) throw prError(PR_ERR.NOT_FOUND, 'Requisition line not found');
  return line;
}

const notInReview = (pr) => prError(PR_ERR.STATE_CONFLICT,
  `This requisition is ${humanStatus(pr.status)} and is no longer in technical review — refresh to see the latest`,
  { status: pr.status });

/**
 * The caller's open review covering `lineId` (they are an eligible reviewer of
 * its department, it is pending on the current revision). 409 when the PR is
 * not in_review, 403 when no such review is the caller's.
 */
async function reviewOfLineForCaller(t, pr, user, lineId) {
  if (pr.status !== 'in_review') throw notInReview(pr);
  const review = (await prModel.eligibleReviews(t, pr.id, user.id)).find((r) => r.line_ids.includes(Number(lineId)));
  if (!review) throw prError(PR_ERR.FORBIDDEN, NOT_REVIEWER);
  return review;
}

/**
 * The detail's `capabilities.review`: the caller's first open review (by
 * department title) and EVERY line they may edit now (all their open reviews —
 * a department-wide reviewer can hold more than one; completing one surfaces
 * the next). null unless the PR is in_review and the caller is eligible.
 * @returns {Promise<{review_id: number, can_edit_lines: number[]}|null>}
 */
export async function reviewRights(pr, user, t = db) {
  if (pr.status !== 'in_review') return null;
  const mine = await prModel.eligibleReviews(t, Number(pr.id), user.id);
  if (!mine.length) return null;
  return {
    review_id: mine[0].id,
    can_edit_lines: [...new Set(mine.flatMap((r) => r.line_ids))].sort((a, b) => a - b),
  };
}

/** PUT /pr/:id/lines/:lineId/specification {specification} — ONLY the specification. */
function parseSpecificationBody(body) {
  const b = asObject(body);
  const errors = Object.keys(b).filter((k) => k !== 'specification').map((field) => ({
    field, message: 'Only the specification can be changed during technical review',
  }));
  let specification = null;
  if (!('specification' in b)) {
    errors.push({ field: 'specification', message: 'specification is required' });
  } else if (b.specification !== null && typeof b.specification !== 'string') {
    errors.push({ field: 'specification', message: 'specification must be text' });
  } else {
    specification = (b.specification || '').trim() || null;
    if (specification && specification.length > MAX_LEN.specification) {
      errors.push({ field: 'specification', message: `Must be at most ${MAX_LEN.specification} characters` });
    }
  }
  return { specification, errors };
}

/**
 * A reviewer edits a line's specification (their own open review's lines).
 * Item, quantity, unit, price and category are not editable here — any other
 * field is a 422. An unchanged value writes nothing.
 * @returns {Promise<{line_id: number, specification: string|null}>}
 */
export async function editSpecification(prId, lineId, user, body) {
  return db.tx(async (t) => {
    const pr = await lockReadable(t, prId, user);
    const line = await lineOrNotFound(t, pr, lineId);
    await reviewOfLineForCaller(t, pr, user, line.id);
    const { specification, errors } = parseSpecificationBody(body);
    if (errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', errors);

    const before = line.specification ?? null;
    if (before !== specification) {
      await prModel.setLineSpecification(t, line.id, specification);
      await record(t, {
        prId: pr.id, lineId: line.id, revision: pr.revision, actorId: user.id, type: 'spec_edited',
        payload: { line_no: Number(line.line_no), before, after: specification },
      });
    }
    return { line_id: Number(line.id), specification };
  });
}

/** {clause_text, clause_type?, weightage?} under the RFQ add-clause rules. */
function parseClauseBody(body) {
  const b = asObject(body);
  const errors = [];
  const clauseText = typeof b.clause_text === 'string' ? b.clause_text.trim() : '';
  if (!clauseText) errors.push({ field: 'clause_text', message: 'Clause text is required' });
  else if (clauseText.length > MAX_LEN.clause_text) {
    errors.push({ field: 'clause_text', message: `Must be at most ${MAX_LEN.clause_text} characters` });
  }
  const clauseType = b.clause_type === undefined || b.clause_type === null || b.clause_type === ''
    ? DEFAULT_CLAUSE_TYPE : b.clause_type;
  if (!CLAUSE_TYPES.includes(clauseType)) {
    errors.push({ field: 'clause_type', message: `Clause type must be one of ${CLAUSE_TYPES.join(', ')}` });
  }
  let weightage = null;
  if (b.weightage !== undefined && b.weightage !== null && b.weightage !== '') {
    const w = typeof b.weightage === 'number' ? b.weightage
      : typeof b.weightage === 'string' && /^\d{1,3}$/.test(b.weightage.trim()) ? Number(b.weightage.trim()) : NaN;
    if (!Number.isInteger(w) || w < 0 || w > MAX_WEIGHTAGE) {
      errors.push({ field: 'weightage', message: `Weightage must be a whole number from 0 to ${MAX_WEIGHTAGE}` });
    } else {
      weightage = w;
    }
  }
  return { clauseText, clauseType, weightage, errors };
}

const clausePayload = (c) => ({
  clause_id: Number(c.id), clause_text: c.clause_text, clause_type: c.clause_type, weightage: c.weightage,
});

/** A reviewer adds a technical clause to a line of their open review. @returns {Promise<{clause}>} */
export async function addClause(prId, lineId, user, body) {
  return db.tx(async (t) => {
    const pr = await lockReadable(t, prId, user);
    const line = await lineOrNotFound(t, pr, lineId);
    await reviewOfLineForCaller(t, pr, user, line.id);
    const { clauseText, clauseType, weightage, errors } = parseClauseBody(body);
    if (errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', errors);

    const clause = await prModel.insertClause(t, {
      lineId: line.id, clauseText, clauseType, weightage, addedBy: user.id,
    });
    await record(t, {
      prId: pr.id, lineId: line.id, revision: pr.revision, actorId: user.id, type: 'clause_added',
      payload: clausePayload(clause),
    });
    return { clause };
  });
}

/** A reviewer removes a clause from a line of their open review (whoever added it). */
export async function removeClause(prId, lineId, clauseId, user) {
  return db.tx(async (t) => {
    const pr = await lockReadable(t, prId, user);
    const line = await lineOrNotFound(t, pr, lineId);
    const clause = clauseId ? await prModel.clauseOfLine(t, line.id, clauseId) : null;
    if (!clause) throw prError(PR_ERR.NOT_FOUND, 'Clause not found');
    await reviewOfLineForCaller(t, pr, user, line.id);

    await prModel.deleteClause(t, clause.id);
    await record(t, {
      prId: pr.id, lineId: line.id, revision: pr.revision, actorId: user.id, type: 'clause_removed',
      payload: { ...clausePayload(clause), added_by: clause.added_by },
    });
    return { id: Number(clause.id) };
  });
}

/**
 * May `user` change the files of `pr` (on `lineId`, null = the header)?
 *   draft / returned  the requester, still holding pr.create on the PR's cell
 *                     (the same gate as editing the draft);
 *   in_review         an eligible reviewer of the open review covering the
 *                     line — never the header; the requester's files are
 *                     frozen (409) until the PR comes back;
 *   anything else     409.
 * @returns {Promise<'requester'|'reviewer'>}
 */
async function attachmentRole(t, pr, user, lineId) {
  if (EDITABLE_STATUSES.includes(pr.status)) {
    if (!isRequester(user, pr)) {
      throw prError(PR_ERR.FORBIDDEN, 'Only the requester can change the files of a requisition that is not in review');
    }
    await assertPerm(user.id, 'pr.create', cellOf(pr), t);
    return 'requester';
  }
  if (pr.status !== 'in_review') throw stateConflict(pr, 'changed');
  const mine = await prModel.eligibleReviews(t, pr.id, user.id);
  if (lineId && mine.some((r) => r.line_ids.includes(Number(lineId)))) return 'reviewer';
  if (isRequester(user, pr)) {
    throw prError(PR_ERR.STATE_CONFLICT,
      'This requisition is in technical review — its files can be changed again if it is sent back', { status: pr.status });
  }
  if (!lineId && mine.length) {
    throw prError(PR_ERR.FORBIDDEN, 'Reviewers attach files to the lines they review, not to the requisition');
  }
  throw prError(PR_ERR.FORBIDDEN, NOT_REVIEWER);
}

const optionalId = (v) => {
  if (v === undefined || v === null || v === '') return { id: null, ok: true };
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? { id: n, ok: true } : { id: null, ok: false };
};

function parseAttachmentBody(b) {
  const errors = [];
  const kind = b.kind;
  if (!ATTACHMENT_KINDS.includes(kind)) {
    errors.push({ field: 'kind', message: `Kind must be one of ${ATTACHMENT_KINDS.join(', ')}` });
  }
  const fileUrl = typeof b.file_url === 'string' ? b.file_url.trim() : '';
  if (!isOwnUploadUrl(fileUrl)) {
    errors.push({ field: 'file_url', message: 'Upload the file first — only files uploaded to Workwise can be attached' });
  }
  const fileName = typeof b.file_name === 'string' ? b.file_name.trim() : '';
  if (!fileName) errors.push({ field: 'file_name', message: 'File name is required' });
  else if (fileName.length > MAX_LEN.file_name) {
    errors.push({ field: 'file_name', message: `Must be at most ${MAX_LEN.file_name} characters` });
  }
  return { kind, fileUrl, fileName, errors };
}

const attachmentPayload = (a) => ({
  attachment_id: Number(a.id), kind: a.kind, file_name: a.file_name, file_url: a.file_url,
});

/**
 * POST /pr/:id/attachments {pr_line_id|null, kind, file_url, file_name}.
 * `file_url` must be one of our own uploads (isOwnUploadUrl).
 * @returns {Promise<{attachment}>}
 */
export async function addAttachment(prId, user, body) {
  return db.tx(async (t) => {
    const pr = await lockReadable(t, prId, user);
    const b = asObject(body);
    const lineRef = optionalId(b.pr_line_id);
    const line = lineRef.id ? await prModel.lineOfPr(t, pr.id, lineRef.id) : null;
    if (!lineRef.ok || (lineRef.id && !line)) {
      throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', [{
        field: 'pr_line_id', message: 'This line is not part of this requisition',
      }]);
    }
    await attachmentRole(t, pr, user, line ? line.id : null);
    const { kind, fileUrl, fileName, errors } = parseAttachmentBody(b);
    if (errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', errors);

    const attachment = await prModel.insertAttachment(t, {
      prId: pr.id, lineId: line ? line.id : null, kind, fileUrl, fileName, uploadedBy: user.id,
    });
    await record(t, {
      prId: pr.id, lineId: attachment.pr_line_id, revision: pr.revision, actorId: user.id, type: 'attachment_added',
      payload: attachmentPayload(attachment),
    });
    return { attachment };
  });
}

/**
 * DELETE /pr/:id/attachments/:attId — the same rules as adding, and in review
 * only the person who uploaded the file (or the requester) may remove it.
 */
export async function removeAttachment(prId, attId, user) {
  return db.tx(async (t) => {
    const pr = await lockReadable(t, prId, user);
    const att = attId ? await prModel.attachmentOfPr(t, pr.id, attId) : null;
    if (!att) throw prError(PR_ERR.NOT_FOUND, 'Attachment not found');
    const role = await attachmentRole(t, pr, user, att.pr_line_id);
    if (role === 'reviewer' && Number(att.uploaded_by) !== Number(user.id) && !isRequester(user, pr)) {
      throw prError(PR_ERR.FORBIDDEN, 'Only the person who uploaded this file, or the requester, can remove it');
    }

    await prModel.deleteAttachment(t, att.id);
    await record(t, {
      prId: pr.id, lineId: att.pr_line_id, revision: pr.revision, actorId: user.id, type: 'attachment_removed',
      payload: { ...attachmentPayload(att), uploaded_by: att.uploaded_by },
    });
    return { id: Number(att.id) };
  });
}

export default {
  reviewRights, editSpecification, addClause, removeClause, addAttachment, removeAttachment,
};
