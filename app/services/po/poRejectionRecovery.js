/**
 * PO rejection recovery — core (REQ-0032).
 *
 * A vendor rejection (purchaseOrderController.rejectPO) tears the award down:
 *   - RFQ PO: handlePORejection moves this vendor's tbl_quote_finalization row
 *     for every PO line into tbl_quote_finalization_history (changed_by = the
 *     vendor, comment not copied) and, once no vendor is left finalized on the
 *     product, sets the latest APPROVED NEGOTIATION_QUOTE instance to CANCELLED.
 *   - Call-off PO: handleCallOffRejection gives the contract quantity back (line
 *     and hotel ledger) and sets the requisition back to 'approved'. The
 *     tbl_arc_callof_po link rows are kept.
 * The PO row itself (number, lines, prices, its own approval) is left intact.
 *
 * This module answers "can that be put back exactly as it was?" and puts it
 * back. It never changes the PO's own status — the two callers do that:
 * the vendor's "accept this order instead" (approved) and the buyer's "send
 * back to vendor" (acceptance_pending). Neither does any authorization here.
 *
 * The rule is all-or-nothing: if anything has moved on since the rejection
 * (another vendor finalized, a replacement PO, a new award approval, an open
 * negotiation round, ...) recovery is refused as a whole. restoreAward
 * re-checks every guard under the PO row lock and throws instead of restoring
 * part of the award.
 *
 * No migration: the award is recovered from history rows matching
 * (rfq_id, product_variant_id, variant, vendor_id = changed_by = the PO's
 * vendor). A vendor rejection is the only writer whose changed_by is the
 * vendor itself; the latest such row wins.
 */
import db from '../../config/dbConn.js';
import { recordLifecycleEvent } from '../../models/generalModel.js';
import { evaluateVendorTechnicalQualification } from '../technicalQualificationService.js';
import { coversProductSql } from '../../models/negotiationModel.js';
import { lockMrHotelLedgerRows } from '../callOffPoService.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../arcEventLogService.js';
import { PO_STATUSES, RFQ_STATUSES } from '../../util/constants.js';
import { assertCanReadParentRfq, assertUserHasScope, isAuthorizationError } from '../authorizationService.js';
import { assertPoAccess, PoAccessError } from '../../models/purchaseOrderModel.js';

export const UNDO_WINDOW_HOURS = 24;

export const BLOCKERS = Object.freeze({
  NOT_REJECTED_BY_VENDOR: 'NOT_REJECTED_BY_VENDOR',
  UNDO_WINDOW_EXPIRED: 'UNDO_WINDOW_EXPIRED',
  RFQ_CLOSED: 'RFQ_CLOSED',
  PRODUCT_REAWARDED: 'PRODUCT_REAWARDED',
  REPLACEMENT_PO_EXISTS: 'REPLACEMENT_PO_EXISTS',
  AWARD_APPROVAL_PENDING: 'AWARD_APPROVAL_PENDING',
  NEGOTIATION_IN_PROGRESS: 'NEGOTIATION_IN_PROGRESS',
  VENDOR_NOT_QUALIFIED: 'VENDOR_NOT_QUALIFIED',
  AWARD_HISTORY_MISSING: 'AWARD_HISTORY_MISSING',
  CONTRACT_NOT_ACTIVE: 'CONTRACT_NOT_ACTIVE',
  CONTRACT_QUANTITY_EXCEEDED: 'CONTRACT_QUANTITY_EXCEEDED',
  REQUISITION_CHANGED: 'REQUISITION_CHANGED',
});

/** Plain-language default for each blocker. Callers may word their own. */
export const BLOCKER_MESSAGES = Object.freeze({
  NOT_REJECTED_BY_VENDOR: 'This order is not rejected by the vendor, so there is nothing to undo.',
  UNDO_WINDOW_EXPIRED: `The ${UNDO_WINDOW_HOURS} hours to undo this rejection have passed.`,
  RFQ_CLOSED: 'The RFQ for this order has been closed.',
  PRODUCT_REAWARDED: 'A product on this order has been given to a vendor since it was rejected.',
  REPLACEMENT_PO_EXISTS: 'Another purchase order has been raised for a product on this order since it was rejected.',
  AWARD_APPROVAL_PENDING: 'A new award for a product on this order is waiting for approval.',
  NEGOTIATION_IN_PROGRESS: 'A negotiation round is open, or waiting for approval, on a product on this order.',
  VENDOR_NOT_QUALIFIED: 'The vendor is no longer technically qualified for a product on this order.',
  AWARD_HISTORY_MISSING: 'The original award for this order cannot be found, so it cannot be put back.',
  CONTRACT_NOT_ACTIVE: 'The rate contract for this order is no longer active.',
  CONTRACT_QUANTITY_EXCEEDED: 'The rate contract does not have enough quantity left for this order.',
  REQUISITION_CHANGED: 'The requisition for this order has changed since the order was rejected.',
});

export class RecoveryError extends Error {
  /**
   * @param {number} status   HTTP status the caller should answer with
   * @param {string} code     machine code (a BLOCKERS value or a caller code)
   * @param {string} [message] plain-language message; defaults per blocker
   */
  constructor(status, code, message) {
    super(message || BLOCKER_MESSAGES[code] || code);
    this.name = 'RecoveryError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

// A rate contract in its final days (expiring_soon) is still live: the MR line
// picker and MR validation both accept 'active' and 'expiring_soon'
// (mrController.validateMrItemAgainstLine, mrModel).
const LIVE_CONTRACT_STATUSES = ['active', 'expiring_soon'];

// REPLACEMENT_PO_EXISTS: another PO on one of this PO's rfq_product_ids that is
// either NEWER than this one (any status — even a dead newer PO means the
// product moved on, and its own rejection left the latest history row, which
// restoring this older PO would wrongly pick up), or OLDER and still alive
// (not one of these dead statuses).
const DEAD_PO_STATUSES = [PO_STATUSES.REJECTED, PO_STATUSES.REJECTED_BY_VENDOR, PO_STATUSES.CANCELLED];

/**
 * SELECT * ... FOR UPDATE on the PO. Returns null for an unknown or malformed id.
 * Every recovery write path takes this lock first, as do acceptPO and rejectPO,
 * so concurrent vendor/buyer actions on one PO serialise and the loser sees the
 * winner's status.
 */
export async function lockPo(t, poId) {
  const id = Number(poId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return t.oneOrNone(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1 FOR UPDATE`, [id]);
}

// Distinct (rfq_product_id, product_variant_id, variant) behind the PO's lines
// ($1 = PO id) — the same source of truth handlePORejection walks.
const RFQ_LINES_SQL = `
  SELECT DISTINCT pop.rfq_product_id, rp.product_variant_id, rp.variant
    FROM tbl_purchase_order_product pop
    JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
   WHERE pop.purchase_order_id = $1`;

async function loadRfqLines(t, poId) {
  return t.any(`${RFQ_LINES_SQL} ORDER BY 1`, [poId]);
}

// The open-window test is the finalize guard's (rfqController.finalize):
// end_date is a naive column holding UTC wall clock.
const RFQ_GUARDS_SQL = `
  WITH lines AS (${RFQ_LINES_SQL})
  SELECT
    (SELECT r.status FROM tbl_rfq r WHERE r.id = $2) AS rfq_status,
    EXISTS (
      SELECT 1 FROM lines l
        JOIN tbl_quote_finalization qf
          ON qf.rfq_id = $2
         AND qf.product_variant_id = l.product_variant_id
         AND qf.variant IS NOT DISTINCT FROM l.variant
    ) AS product_reawarded,
    EXISTS (
      SELECT 1 FROM lines l
        JOIN tbl_purchase_order_product opp
          ON opp.rfq_product_id = l.rfq_product_id
         AND opp.purchase_order_id <> $1
        JOIN tbl_rfq_purchase_order opo ON opo.id = opp.purchase_order_id
       WHERE opo.id > $1
          OR NOT (opo.status::text = ANY($4::text[]))
    ) AS replacement_po_exists,
    EXISTS (
      SELECT 1 FROM lines l
        JOIN tbl_approval_instances ai
          ON ai.entity_type = 'NEGOTIATION_QUOTE'
         AND ai.entity_id = l.rfq_product_id
         AND ai.status = 'PENDING'
    ) AS award_approval_pending,
    EXISTS (
      SELECT 1 FROM lines l
        JOIN tbl_negotiation_rounds nr
          ON nr.rfq_id = $2
         AND nr.source_type = 'RFQ'
       WHERE (
               (nr.status = 'ACTIVE'
                AND (nr.end_date IS NULL OR nr.end_date > (now() AT TIME ZONE 'UTC')))
               OR nr.status = 'PENDING_APPROVAL'
             )
         AND ${coversProductSql('l.rfq_product_id')}
    ) AS negotiation_in_progress,
    (
      NOT EXISTS (SELECT 1 FROM lines)
      OR EXISTS (
        SELECT 1 FROM lines l
         WHERE NOT EXISTS (
           SELECT 1 FROM tbl_quote_finalization_history h
            WHERE h.rfq_id = $2
              AND h.product_variant_id = l.product_variant_id
              AND h.variant IS NOT DISTINCT FROM l.variant
              AND h.vendor_id = $3
              AND h.changed_by = $3
         )
      )
    ) AS award_history_missing`;

async function findRfqBlockers(t, po) {
  const g = await t.one(RFQ_GUARDS_SQL, [po.id, po.rfq_id, po.finalized_vendor_id, DEAD_PO_STATUSES]);

  let vendorNotQualified = false;
  for (const line of await loadRfqLines(t, po.id)) {
    const decision = await evaluateVendorTechnicalQualification(
      {
        rfq_id: po.rfq_id,
        vendor_id: po.finalized_vendor_id,
        product_variant_id: line.product_variant_id,
        variant: line.variant,
      },
      t
    );
    if (!decision.qualified) {
      vendorNotQualified = true;
      break;
    }
  }

  const blockers = [];
  if (Number(g.rfq_status) === RFQ_STATUSES.CLOSED) blockers.push(BLOCKERS.RFQ_CLOSED);
  if (g.product_reawarded) blockers.push(BLOCKERS.PRODUCT_REAWARDED);
  if (g.replacement_po_exists) blockers.push(BLOCKERS.REPLACEMENT_PO_EXISTS);
  if (g.award_approval_pending) blockers.push(BLOCKERS.AWARD_APPROVAL_PENDING);
  if (g.negotiation_in_progress) blockers.push(BLOCKERS.NEGOTIATION_IN_PROGRESS);
  if (vendorNotQualified) blockers.push(BLOCKERS.VENDOR_NOT_QUALIFIED);
  // A PO with no RFQ lines has no award to put back either.
  if (g.award_history_missing) blockers.push(BLOCKERS.AWARD_HISTORY_MISSING);
  return blockers;
}

// Contract and requisition behind a call-off PO. The header carries both; the
// link rows are the fallback handleCallOffRejection itself reads.
async function loadCallOffContext(t, po) {
  const links = await t.any(
    `SELECT id, mr_id, arc_contract_id, arc_contract_line_id, quantity
       FROM tbl_arc_callof_po WHERE po_id = $1 ORDER BY id`,
    [po.id]
  );
  const mrId = po.source_mr_id ?? links[0]?.mr_id ?? null;
  const contractId = po.arc_contract_id ?? links[0]?.arc_contract_id ?? null;
  return { links, mrId, contractId };
}

// Requisition facts the post-commit notices need for a call-off PO: who raised it
// and what it is called. Shared by the vendor undo and the buyer send-back.
async function loadCallOffNotice(t, po) {
  const { mrId } = await loadCallOffContext(t, po);
  const mr = mrId
    ? await t.oneOrNone(`SELECT id, mr_number, raised_by FROM tbl_material_requisition WHERE id = $1`, [mrId])
    : null;
  return { raised_by: mr?.raised_by ?? null, mr_id: mr?.id ?? null, mr_number: mr?.mr_number ?? null };
}

async function findCallOffBlockers(t, po) {
  const { mrId, contractId } = await loadCallOffContext(t, po);
  // Summed per contract line, so two links on one line are tested together —
  // exactly what restoreAward's guarded increments will need.
  const g = await t.one(
    `SELECT
       (SELECT c.status FROM tbl_arc_contract c WHERE c.id = $2) AS contract_status,
       (SELECT m.status FROM tbl_material_requisition m WHERE m.id = $3) AS mr_status,
       EXISTS (
         SELECT 1
           FROM (SELECT arc_contract_line_id, SUM(quantity) AS qty
                   FROM tbl_arc_callof_po WHERE po_id = $1
                  GROUP BY arc_contract_line_id) l
           JOIN tbl_arc_contract_line cl ON cl.id = l.arc_contract_line_id
          WHERE (cl.consumed_qty + l.qty <= cl.committed_qty) IS NOT TRUE
       ) AS quantity_exceeded`,
    [po.id, contractId, mrId]
  );

  const blockers = [];
  if (!LIVE_CONTRACT_STATUSES.includes(g.contract_status)) blockers.push(BLOCKERS.CONTRACT_NOT_ACTIVE);
  if (g.mr_status !== 'approved') blockers.push(BLOCKERS.REQUISITION_CHANGED);
  if (g.quantity_exceeded) blockers.push(BLOCKERS.CONTRACT_QUANTITY_EXCEEDED);
  return blockers;
}

/**
 * Every reason the PO cannot be restored, in a fixed order. Guards only: no
 * authorization and no undo window (callers add UNDO_WINDOW_EXPIRED).
 * NOT_REJECTED_BY_VENDOR is returned alone.
 *
 * @param {object} t   pg-promise task/tx (or db)
 * @param {object} po  tbl_rfq_purchase_order row — pass the lockPo row when acting on it
 * @returns {Promise<string[]>}
 */
export async function findRecoveryBlockers(t, po) {
  if (!po || po.status !== PO_STATUSES.REJECTED_BY_VENDOR) {
    return [BLOCKERS.NOT_REJECTED_BY_VENDOR];
  }
  return po.is_call_off ? findCallOffBlockers(t, po) : findRfqBlockers(t, po);
}

/**
 * The vendor's undo window: open while vendor_action_at + 24h is still ahead.
 *
 * Computed in SQL so the session timezone cannot skew it. vendor_action_at is
 * timestamptz in the live schema (tests/setup/schema.sql), so the comparison
 * against LOCALTIMESTAMP and the ::timestamptz cast both resolve to the true
 * instant under any session zone. The cast is the same conversion as
 * AT TIME ZONE current_setting('TimeZone') for a naive column, and correct for
 * a timestamptz one, where AT TIME ZONE would turn the instant back into a
 * zone-less wall clock. The deadline is formatted in SQL as a UTC ISO instant,
 * independent of the driver's type parsers.
 *
 * @returns {Promise<{open:boolean, deadline:string|null}>}
 */
export async function undoWindow(t, po) {
  if (!po?.id) return { open: false, deadline: null };
  const row = await t.oneOrNone(
    `SELECT (vendor_action_at + make_interval(hours => $2) > LOCALTIMESTAMP) AS open,
            to_char(
              (vendor_action_at + make_interval(hours => $2))::timestamptz AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS deadline
       FROM tbl_rfq_purchase_order
      WHERE id = $1`,
    [po.id, UNDO_WINDOW_HOURS]
  );
  return { open: row?.open === true, deadline: row?.deadline ?? null };
}

async function restoreRfqAward(t, po) {
  const lines = await loadRfqLines(t, po.id);

  const restoredKeys = new Set();
  for (const line of lines) {
    const key = `${line.product_variant_id}:${line.variant}`;
    if (restoredKeys.has(key)) continue;
    restoredKeys.add(key);
    const row = await t.oneOrNone(
      `INSERT INTO tbl_quote_finalization
         (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, "timestamp", variant, comment)
       SELECT h.rfq_id, h.rfq_no, h.quote_id, h.product_variant_id, h.vendor_id, h.created_by,
              h."timestamp", h.variant, NULL
         FROM tbl_quote_finalization_history h
        WHERE h.rfq_id = $1
          AND h.product_variant_id = $2
          AND h.variant IS NOT DISTINCT FROM $3
          AND h.vendor_id = $4
          AND h.changed_by = $4
        ORDER BY h.id DESC
        LIMIT 1
       RETURNING id`,
      [po.rfq_id, line.product_variant_id, line.variant, po.finalized_vendor_id]
    );
    if (!row) throw new RecoveryError(409, BLOCKERS.AWARD_HISTORY_MISSING);
  }

  // Re-approve the award approval the rejection cancelled: the latest
  // NEGOTIATION_QUOTE instance, when it is CANCELLED and had actually been
  // approved. handlePORejection cancels an APPROVED instance and leaves its
  // steps alone; a request withdrawn before approval has a PENDING step turned
  // CANCELLED, and must never come back as an approval. completed_at is kept.
  const rfqProductIds = [...new Set(lines.map((l) => l.rfq_product_id))];
  for (const rfqProductId of rfqProductIds) {
    await t.none(
      `UPDATE tbl_approval_instances ai
          SET status = 'APPROVED'
        WHERE ai.id = (
                SELECT id FROM tbl_approval_instances
                 WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = $1
                 ORDER BY created_at DESC NULLS LAST, id DESC
                 LIMIT 1
              )
          AND ai.status = 'CANCELLED'
          AND NOT EXISTS (
                SELECT 1 FROM tbl_approval_instance_steps s
                 WHERE s.approval_instance_id = ai.id
                   AND s.status IN ('PENDING', 'REJECTED', 'CANCELLED')
              )`,
      [rfqProductId]
    );
  }
}

async function restoreCallOffAward(t, po, ctx, mrHotelId, actorUserId) {
  for (const link of ctx.links) {
    // The release's own over-consumption guard (recordCallOffAndUpdateConsumption).
    const res = await t.result(
      `UPDATE tbl_arc_contract_line
          SET consumed_qty = consumed_qty + $1, updated_at = NOW()
        WHERE id = $2
          AND consumed_qty + $1 <= committed_qty`,
      [link.quantity, link.arc_contract_line_id]
    );
    if (res.rowCount === 0) throw new RecoveryError(409, BLOCKERS.CONTRACT_QUANTITY_EXCEEDED);
    await t.none(
      `UPDATE tbl_arc_contract_line_hotel
          SET consumed_qty = consumed_qty + $1, updated_at = NOW()
        WHERE arc_contract_line_id = $2 AND hotel_id = $3`,
      [link.quantity, link.arc_contract_line_id, mrHotelId]
    );
  }

  // Conditional, so a requisition changed by a concurrent writer is refused
  // rather than overwritten. The link rows were never deleted: none are added.
  const mrRes = await t.result(
    `UPDATE tbl_material_requisition
        SET status = 'po_released', updated_at = NOW()
      WHERE id = $1 AND status = 'approved'`,
    [ctx.mrId]
  );
  if (mrRes.rowCount === 0) throw new RecoveryError(409, BLOCKERS.REQUISITION_CHANGED);

  const arcId = (await t.oneOrNone(
    `SELECT arc_id FROM tbl_arc_contract WHERE id = $1`, [ctx.contractId]
  ))?.arc_id;
  if (arcId) {
    await logArcEvent({
      arcId,
      eventType: ARC_EVENT_TYPES.CALL_OFF_REJECTION_REVERSED,
      actorId: actorUserId ?? null,
      payload: { po_id: Number(po.id), mr_id: Number(ctx.mrId) },
      txContext: t,
    });
  }
}

/**
 * Put the award behind a vendor-rejected PO back exactly as it was.
 *
 * Safe on its own: it takes the PO row lock (and, for a call-off, the hotel
 * ledger rows in handleCallOffRejection's order), re-reads the PO and re-runs
 * findRecoveryBlockers before writing anything. Any blocker throws
 * RecoveryError(409, firstBlocker). It runs in a savepoint, so a refusal
 * leaves nothing half-restored even if the caller catches the error.
 *
 * Does NOT change the PO's own status; the caller does that in the same
 * transaction, which is also what stops a second restore (it then sees
 * NOT_REJECTED_BY_VENDOR, or PRODUCT_REAWARDED if the status was left alone).
 *
 * @param {object} t            pg-promise tx (the caller's)
 * @param {object} po           tbl_rfq_purchase_order row (only id is trusted)
 * @param {number} actorUserId  who is restoring (vendor or buyer); recorded on the ARC event
 * @returns {Promise<void>}
 */
export async function restoreAward(t, po, actorUserId) {
  await t.tx(async (tx) => {
    const locked = await lockPo(tx, po?.id);
    if (!locked) throw new RecoveryError(404, 'NOT_FOUND', 'Purchase order not found.');

    let callOff = null;
    let mrHotelId = null;
    if (locked.status === PO_STATUSES.REJECTED_BY_VENDOR && locked.is_call_off) {
      callOff = await loadCallOffContext(tx, locked);
      mrHotelId = (await tx.oneOrNone(
        `SELECT hotel_id FROM tbl_material_requisition WHERE id = $1`, [callOff.mrId]
      ))?.hotel_id ?? null;
      // Same lock order as the release and the rejection: the requisition
      // hotel's ledger rows (id order), then the contract lines.
      await lockMrHotelLedgerRows(tx, callOff.mrId, mrHotelId);
    }

    const blockers = await findRecoveryBlockers(tx, locked);
    if (blockers.length) throw new RecoveryError(409, blockers[0]);

    if (callOff) {
      await restoreCallOffAward(tx, locked, callOff, mrHotelId, actorUserId);
    } else {
      await restoreRfqAward(tx, locked);
    }
  });
}

// Same ownership test acceptPO / rejectPO apply: the PO's finalized vendor must
// be the calling user.
function assertOwnPo(po, vendorUserId) {
  if (!po) throw new RecoveryError(404, 'NOT_FOUND', 'Purchase order not found.');
  if (po.finalized_vendor_id !== vendorUserId) {
    throw new RecoveryError(403, 'NOT_YOUR_PO', 'You are not the assigned vendor for this PO.');
  }
}

/**
 * What the vendor's "Rejected by mistake? Accept this order instead." panel
 * needs: is it available, until when, and if not, why. Read only.
 *
 * @returns {Promise<{available:boolean, deadline:string|null, blockers:string[]}>}
 */
export async function getVendorUndoState(poId, vendorUserId) {
  return db.task(async (t) => {
    const id = Number(poId);
    const po = Number.isSafeInteger(id) && id > 0
      ? await t.oneOrNone(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [id])
      : null;
    assertOwnPo(po, vendorUserId);
    const blockers = await findRecoveryBlockers(t, po);
    if (po.status !== PO_STATUSES.REJECTED_BY_VENDOR) {
      return { available: false, deadline: null, blockers };
    }
    const win = await undoWindow(t, po);
    if (!win.open) blockers.push(BLOCKERS.UNDO_WINDOW_EXPIRED);
    return { available: blockers.length === 0, deadline: win.deadline, blockers };
  });
}

/**
 * The vendor takes a rejection back: restore the award and accept the PO, in
 * one transaction. The end state is a normal accept's (status approved,
 * vendor_action_at now, PO_ACCEPTED_BY_VENDOR lifecycle row) plus a
 * PO_REJECTION_WITHDRAWN row recording what was undone.
 *
 * @returns {Promise<{po: object, callOff: null|{raised_by:number|null, mr_id:number|null, mr_number:string|null}}>}
 */
export async function withdrawRejectionByVendor(poId, vendorUserId) {
  return db.tx(async (t) => {
    const po = await lockPo(t, poId);
    assertOwnPo(po, vendorUserId);

    const blockers = await findRecoveryBlockers(t, po);
    if (po.status === PO_STATUSES.REJECTED_BY_VENDOR) {
      const win = await undoWindow(t, po);
      if (!win.open) blockers.push(BLOCKERS.UNDO_WINDOW_EXPIRED);
    }
    if (blockers.length) throw new RecoveryError(409, blockers[0]);

    await restoreAward(t, po, vendorUserId);

    await t.none(
      `UPDATE tbl_rfq_purchase_order
          SET status = 'approved', vendor_rejection_reason = NULL,
              vendor_action_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [po.id]
    );

    await recordLifecycleEvent({
      entity_type: 'PO',
      entity_id: po.id,
      stage: 'PO_REJECTION_WITHDRAWN',
      action: 'WITHDRAW_REJECTION',
      performed_by: vendorUserId,
      metadata: {
        rfq_id: po.rfq_id,
        po_number: po.po_number,
        previous_rejection_reason: po.vendor_rejection_reason ?? null,
        previous_rejected_at: po.vendor_action_at ?? null,
      },
      txContext: t,
    });
    await recordLifecycleEvent({
      entity_type: 'PO',
      entity_id: po.id,
      stage: 'PO_ACCEPTED_BY_VENDOR',
      action: 'ACCEPT',
      performed_by: vendorUserId,
      metadata: { rfq_id: po.rfq_id, po_number: po.po_number },
      txContext: t,
    });

    const callOff = po.is_call_off ? await loadCallOffNotice(t, po) : null;

    return { po: { ...po, status: 'approved' }, callOff };
  });
}

export const NOTE_MAX_LENGTH = 1000;

const notFound = () => new RecoveryError(404, 'NOT_FOUND', 'Purchase order not found.');

// Tenant gate, first. tbl_rfq_purchase_order.company_id is a tbl_company id,
// which spans several hospitality companies, so it cannot isolate a legal
// entity; the PO is resolved to its real tenancy tuple instead (RFQ, or the ARC
// for a call-off) and the caller's read scope on it is checked, exactly as every
// other buyer PO endpoint does (assertPoAccess). Anything out of scope, or
// unknown, is a 404 so another tenant's PO is never confirmed to exist.
async function assertPoVisible(t, user, poId) {
  try {
    await assertPoAccess(user, poId, t);
  } catch (err) {
    if (err instanceof PoAccessError) throw notFound();
    throw err;
  }
}

/**
 * May this user send this PO back? RFQ PO: read scope on the RFQ plus
 * quote-compare.create on its tuple. Call-off PO: mr.create on the
 * requisition's company and hotel. Scope comes from the loaded rows only.
 * Authorization failures become 403 NOT_PERMITTED; anything else propagates.
 */
export async function assertCanReinstate(t, user, po) {
  try {
    if (po.is_call_off) {
      const { mrId } = await loadCallOffContext(t, po);
      const mr = mrId
        ? await t.oneOrNone(
          `SELECT hospitality_company_id, hotel_id FROM tbl_material_requisition WHERE id = $1`, [mrId]
        )
        : null;
      await assertUserHasScope(user.id, 'mr.create', {
        hospitality_company_id: mr?.hospitality_company_id,
        hotel_id: mr?.hotel_id,
      }, t);
    } else {
      const rfq = await t.oneOrNone(
        `SELECT id, hospitality_company_id, hotel_id, department_id, process_id, is_tender
           FROM tbl_rfq WHERE id = $1`,
        [po.rfq_id]
      );
      if (!rfq) throw notFound();
      await assertCanReadParentRfq(user.id, rfq.id, t, { rfqRow: rfq });
      await assertUserHasScope(user.id, 'quote-compare.create', {
        hospitality_company_id: rfq.hospitality_company_id,
        hotel_id: rfq.hotel_id,
        department_id: rfq.department_id,
        process_id: rfq.process_id,
      }, t);
    }
  } catch (err) {
    if (isAuthorizationError(err)) {
      throw new RecoveryError(403, 'NOT_PERMITTED', 'You do not have permission to send this order back to the vendor.');
    }
    throw err;
  }
}

const isoOrNull = (v) => (v ? new Date(v).toISOString() : null);

/**
 * What the buyer's "Send back to vendor" panel needs. Read only. A user without
 * the permission gets permitted:false (the UI explains it), not a 403; only an
 * unknown PO or another tenant's PO is a 404.
 *
 * @returns {Promise<{permitted:boolean, available:boolean, blockers:string[],
 *   rejection:{reason:string|null, rejected_at:string|null, vendor_name:string|null}}>}
 */
export async function getReinstateState(poId, user) {
  return db.task(async (t) => {
    await assertPoVisible(t, user, poId);
    const po = await t.oneOrNone(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [Number(poId)]);
    if (!po) throw notFound();

    let permitted = true;
    try {
      await assertCanReinstate(t, user, po);
    } catch (err) {
      if (err instanceof RecoveryError && err.code === 'NOT_PERMITTED') permitted = false;
      else throw err;
    }

    const blockers = await findRecoveryBlockers(t, po);
    const rejected = po.status === PO_STATUSES.REJECTED_BY_VENDOR;
    const vendor = rejected
      ? await t.oneOrNone(`SELECT name, organization_name FROM tbl_users WHERE id = $1`, [po.finalized_vendor_id])
      : null;
    return {
      permitted,
      available: permitted && blockers.length === 0,
      blockers,
      rejection: {
        reason: rejected ? (po.vendor_rejection_reason ?? null) : null,
        rejected_at: rejected ? isoOrNull(po.vendor_action_at) : null,
        vendor_name: vendor ? (vendor.organization_name || vendor.name || null) : null,
      },
    };
  });
}

/**
 * The buyer sends a vendor-rejected PO back to the SAME vendor: restore the
 * award and return the PO to acceptance_pending, in one transaction. No new
 * approval — vendor, price and quantity are unchanged. The reminder counter and
 * the vendor's action stamp reset so the reminder cron starts again from day 1.
 *
 * The note is internal: it is stored on the lifecycle row only, and never sent
 * to the vendor.
 *
 * @returns {Promise<{po:object, previous:{reason:string|null, rejected_at:*}, callOff:null|{raised_by:number|null, mr_id:number|null, mr_number:string|null}}>}
 */
export async function reinstateByBuyer(poId, user, note) {
  return db.tx(async (t) => {
    await assertPoVisible(t, user, poId);

    const text = typeof note === 'string' ? note.trim() : '';
    if (!text) {
      throw new RecoveryError(400, 'NOTE_REQUIRED', 'Add a note saying why the order is being sent back.');
    }
    if ([...text].length > NOTE_MAX_LENGTH) {
      throw new RecoveryError(400, 'NOTE_TOO_LONG', `Keep the note to ${NOTE_MAX_LENGTH} characters or fewer.`);
    }

    const po = await lockPo(t, poId);
    if (!po) throw notFound();

    await assertCanReinstate(t, user, po);

    const blockers = await findRecoveryBlockers(t, po);
    if (blockers[0] === BLOCKERS.NOT_REJECTED_BY_VENDOR) {
      throw new RecoveryError(
        409, BLOCKERS.NOT_REJECTED_BY_VENDOR,
        'This order is no longer rejected by the vendor, so there is nothing to send back.'
      );
    }
    if (blockers.length) throw new RecoveryError(409, blockers[0]);

    await restoreAward(t, po, user.id);

    await t.none(
      `UPDATE tbl_rfq_purchase_order
          SET status = 'acceptance_pending', vendor_rejection_reason = NULL,
              vendor_action_at = NULL, vendor_reminder_count = 0, updated_at = NOW()
        WHERE id = $1`,
      [po.id]
    );

    const previous = { reason: po.vendor_rejection_reason ?? null, rejected_at: po.vendor_action_at ?? null };
    await recordLifecycleEvent({
      entity_type: 'PO',
      entity_id: po.id,
      stage: 'PO_SENT_BACK_TO_VENDOR',
      action: 'REINSTATE',
      performed_by: user.id,
      remarks: text,
      metadata: {
        rfq_id: po.rfq_id,
        po_number: po.po_number,
        previous_rejection_reason: previous.reason,
        previous_rejected_at: previous.rejected_at,
      },
      txContext: t,
    });

    const callOff = po.is_call_off ? await loadCallOffNotice(t, po) : null;

    const fresh = await t.one(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [po.id]);
    return { po: fresh, previous, callOff, note: text };
  });
}

export default {
  UNDO_WINDOW_HOURS,
  BLOCKERS,
  BLOCKER_MESSAGES,
  RecoveryError,
  lockPo,
  findRecoveryBlockers,
  undoWindow,
  restoreAward,
  getVendorUndoState,
  withdrawRejectionByVendor,
  assertCanReinstate,
  getReinstateState,
  reinstateByBuyer,
};
