// Phase 3.5 — tender send-back orchestration with full snapshot history.
//
// One entry point: sendBackTender({ rfq_id, from_stage, to_stage,
// reason, performed_by, txContext }). Validates the transition,
// snapshots the data being wiped into tbl_tender_sendback_history,
// CANCELS (never deletes) approval instances, hard-deletes the active
// state per the matrix, increments tbl_rfq.iteration_number, emits a
// TENDER_SENDBACK lifecycle event. All inside the supplied transaction.
//
// Stage matrix (from → to):
//   ARC                  → TENDER_NEGOTIATION       (snapshot: arc, finalization, instances)
//   ARC                  → TENDER_TECHNICAL_EVAL    (+ negotiation)
//   ARC                  → TENDER_QUOTING           (+ tech_eval; quotes reopened, NOT deleted)
//   ARC                  → DRAFT                    (full wipe; rfq → DRAFT)
//   TENDER_NEGOTIATION   → TENDER_TECHNICAL_EVAL    (negotiation + instances)
//   TENDER_NEGOTIATION   → TENDER_QUOTING           (+ tech_eval; quotes reopened)
//   TENDER_TECHNICAL_EVAL→ TENDER_QUOTING           (tech_eval + instances; quotes reopened)
//
// Quotes are never deleted unless the destination is DRAFT — vendor
// effort survives a send-back. Approval instances are CANCELLED with
// metadata.cancellation = { reason, sendback_from, sendback_to,
// performed_by, at } so the audit trail stays whole.

import db from '../config/dbConn.js';
import { recordLifecycleEvent } from '../models/generalModel.js';
import { logError } from '../helper/common.js';

// Stages that can serve as "from" / "to". Keep these in lockstep with
// the FE SendBackModal target dropdown.
const FROM_STAGES = new Set([
  'ARC',
  'TENDER_NEGOTIATION',
  'TENDER_TECHNICAL_EVAL',
]);

// Allowed transitions: ordered earliest → latest. From any "from"
// stage, you can only send back to a stage strictly earlier.
const STAGE_ORDER = [
  'DRAFT',
  'TENDER_QUOTING',
  'TENDER_TECHNICAL_EVAL',
  'TENDER_NEGOTIATION',
  'ARC',
];

// Per-(from, to) descriptor of which active tables we wipe.
const wipePlan = ({ from, to }) => {
  const fromIdx = STAGE_ORDER.indexOf(from);
  const toIdx = STAGE_ORDER.indexOf(to);
  if (fromIdx <= 0 || toIdx < 0 || toIdx >= fromIdx) {
    return null; // invalid transition
  }
  return {
    arc:           fromIdx >= STAGE_ORDER.indexOf('ARC'),
    negotiation:   fromIdx >= STAGE_ORDER.indexOf('TENDER_NEGOTIATION') && toIdx <= STAGE_ORDER.indexOf('TENDER_TECHNICAL_EVAL'),
    finalization:  fromIdx >= STAGE_ORDER.indexOf('ARC'),
    tech_eval:     toIdx <= STAGE_ORDER.indexOf('TENDER_QUOTING'),
    // Quotes only fully delete on the all-the-way-back-to-DRAFT path;
    // any other to_stage just reopens the quoting window.
    quotes_delete: to === 'DRAFT',
    quotes_reopen: to === 'TENDER_QUOTING' && fromIdx > STAGE_ORDER.indexOf('TENDER_QUOTING'),
    rfq_status_after: to === 'DRAFT'
      ? 0  // DRAFT
      : to === 'TENDER_QUOTING'
        ? 1  // OPEN — vendors quote
        : to === 'TENDER_TECHNICAL_EVAL'
          ? 1  // OPEN — back to tech-eval phase
          : to === 'TENDER_NEGOTIATION'
            ? 1  // OPEN — back to negotiation phase
            : null,
    is_published_after: to === 'DRAFT' ? 0 : null,
  };
};

const ENTITY_TYPES_BY_FROM = {
  ARC: ['ARC'],
  TENDER_NEGOTIATION: ['NEGOTIATION', 'NEGOTIATION_QUOTE'],
  TENDER_TECHNICAL_EVAL: ['TECHNICAL'],
};

/**
 * Capture the snapshot blobs that will be lost when the wipe runs.
 * Each blob is a plain JSON dump of the relevant rows. We don't need
 * referential integrity to query the snapshot — it's an audit record.
 */
async function captureSnapshot(t, { rfq_id, plan }) {
  const out = {
    snapshot_arc: null,
    snapshot_finalization: null,
    snapshot_negotiation: null,
    snapshot_tech_eval: null,
    snapshot_quotes: null,
    snapshot_approval_instances: null,
    affected_products: [],
    affected_vendors: [],
  };

  if (plan.arc) {
    const envelopes = await t.any(`SELECT * FROM tbl_arc WHERE rfq_id = $1`, [rfq_id]);
    const items = envelopes.length > 0
      ? await t.any(
          `SELECT * FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`,
          [envelopes.map((e) => e.id)]
        )
      : [];
    const hotels = envelopes.length > 0
      ? await t.any(
          `SELECT * FROM tbl_arc_hotels WHERE arc_id = ANY($1::int[])`,
          [envelopes.map((e) => e.id)]
        )
      : [];
    out.snapshot_arc = { envelopes, items, hotels };
    out.affected_vendors = [...new Set(envelopes.map((e) => e.vendor_id))];
    out.affected_products = [...new Set(items.map((i) => i.product_variant_id))];
  }

  if (plan.finalization) {
    const finalizations = await t.any(`SELECT * FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq_id]);
    const finHistory = await t.any(`SELECT * FROM tbl_quote_finalization_history WHERE rfq_id = $1`, [rfq_id]);
    out.snapshot_finalization = { finalizations, history: finHistory };
  }

  if (plan.negotiation) {
    const rounds = await t.any(`SELECT * FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfq_id]);
    if (rounds.length > 0) {
      const roundIds = rounds.map((r) => r.id);
      const roundQuotes = await t.any(
        `SELECT * FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`,
        [roundIds]
      );
      const roundApprovals = await t.any(
        `SELECT * FROM tbl_negotiation_round_approvals WHERE negotiation_round_id = ANY($1::int[])`,
        [roundIds]
      );
      out.snapshot_negotiation = { rounds, round_quotes: roundQuotes, round_approvals: roundApprovals };
    } else {
      out.snapshot_negotiation = { rounds: [], round_quotes: [], round_approvals: [] };
    }
  }

  if (plan.tech_eval) {
    // tech-eval tables vary across the codebase; we capture what's there
    // and skip silently when not.
    try {
      const techEval = await t.any(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'tbl_tech_eval%'`
      );
      const dump = {};
      for (const { table_name } of techEval) {
        try {
          const rows = await t.any(`SELECT * FROM ${table_name} WHERE rfq_id = $1`, [rfq_id]);
          if (rows.length > 0) dump[table_name] = rows;
        } catch (_) { /* table may not have rfq_id */ }
      }
      out.snapshot_tech_eval = dump;
    } catch (_) {
      out.snapshot_tech_eval = {};
    }
  }

  if (plan.quotes_delete) {
    const quotes = await t.any(`SELECT * FROM tbl_quotes WHERE rfq_id = $1`, [rfq_id]);
    if (quotes.length > 0) {
      const quoteIds = quotes.map((q) => q.id);
      const quoteItems = await t.any(
        `SELECT * FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`,
        [quoteIds]
      );
      out.snapshot_quotes = { quotes, quote_items: quoteItems };
    } else {
      out.snapshot_quotes = { quotes: [], quote_items: [] };
    }
  }

  // Always snapshot every approval instance for the rfq across the
  // affected entity types — committee + earlier stage approvals all
  // get cancelled, so the audit needs every one.
  const fromStages = Object.entries(ENTITY_TYPES_BY_FROM)
    .filter(([fromKey]) => {
      // Include all entity types from `from_stage` and earlier.
      const idx = STAGE_ORDER.indexOf(fromKey);
      return idx >= 0;
    })
    .flatMap(([, types]) => types);
  const allTypes = [...new Set(['RFQ', 'TENDER', ...fromStages])];

  // We collect instances tied to this rfq. The legacy product-level
  // ARC instances and the new arc_item-level ones are both included.
  const productIds = await t.any(
    `SELECT id FROM tbl_rfq_products WHERE rfq_id = $1`,
    [rfq_id]
  );
  const productIdList = productIds.map((p) => p.id);
  const arcIds = await t.any(`SELECT id FROM tbl_arc WHERE rfq_id = $1`, [rfq_id]);
  const arcItemIds = arcIds.length > 0
    ? (await t.any(`SELECT id FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [arcIds.map((a) => a.id)])).map((r) => r.id)
    : [];

  const candidateEntityIds = [rfq_id, ...productIdList, ...arcItemIds];
  if (candidateEntityIds.length > 0) {
    const instances = await t.any(
      `SELECT * FROM tbl_approval_instances
       WHERE entity_type = ANY($1::text[])
         AND entity_id = ANY($2::int[])
         AND status IN ('PENDING', 'APPROVED')`,
      [allTypes, candidateEntityIds]
    );
    out.snapshot_approval_instances = instances;
  } else {
    out.snapshot_approval_instances = [];
  }

  return out;
}

/**
 * Cancel every relevant approval instance with a structured cancellation
 * marker in metadata. We never DELETE — the audit trail must show the
 * decision tree as it stood at send-back time.
 */
async function cancelApprovalInstances(t, { snapshotInstances, sendback_from, sendback_to, performed_by, reason }) {
  if (!snapshotInstances || snapshotInstances.length === 0) return;
  const ids = snapshotInstances.map((i) => i.id);
  const cancellation = {
    reason: reason || null,
    sendback_from,
    sendback_to,
    performed_by,
    at: new Date().toISOString(),
  };

  // Update each instance individually to merge cancellation into metadata.
  for (const inst of snapshotInstances) {
    const merged = { ...(inst.metadata || {}), cancellation };
    await t.none(
      `UPDATE tbl_approval_instances
       SET status = 'CANCELLED',
           completed_at = COALESCE(completed_at, NOW()),
           metadata = $2::jsonb
       WHERE id = $1`,
      [inst.id, JSON.stringify(merged)]
    );
  }

  // Cancel any pending instance steps for these instances too.
  await t.none(
    `UPDATE tbl_approval_instance_steps
     SET status = 'CANCELLED'
     WHERE approval_instance_id = ANY($1::int[]) AND status = 'PENDING'`,
    [ids]
  );
}

/**
 * Hard-delete the live state per the wipe plan. Quotes stay (their rows
 * survive a send-back) unless the destination is DRAFT. ARC envelopes,
 * items, hotels, and finalization rows are removed; the snapshot is the
 * only remaining trace.
 */
async function wipeActiveState(t, { rfq_id, plan }) {
  if (plan.arc) {
    const envelopes = await t.any(`SELECT id FROM tbl_arc WHERE rfq_id = $1`, [rfq_id]);
    if (envelopes.length > 0) {
      const ids = envelopes.map((e) => e.id);
      // Children cascade via FK ON DELETE CASCADE on tbl_arc_item /
      // tbl_arc_hotels. tbl_arc_release retains its rows (no cascade)
      // because release POs that were already drafted are independent
      // legal artefacts; deleting them would orphan a Contracted PO.
      await t.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [ids]);
    }
  }

  if (plan.finalization) {
    await t.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq_id]);
    // Finalization history is intentionally PRESERVED — that's the
    // audit trail for prior award/de-award cycles.
  }

  if (plan.negotiation) {
    const rounds = await t.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfq_id]);
    if (rounds.length > 0) {
      const ids = rounds.map((r) => r.id);
      await t.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [ids]);
      await t.none(`DELETE FROM tbl_negotiation_round_approvals WHERE negotiation_round_id = ANY($1::int[])`, [ids]);
      await t.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [ids]);
    }
  }

  if (plan.tech_eval) {
    // Best-effort: clear rows in any tbl_tech_eval_* table that
    // carries an rfq_id column. Skips silently when the column is
    // absent.
    const tables = await t.any(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'tbl_tech_eval%'`
    );
    for (const { table_name } of tables) {
      try {
        await t.none(`DELETE FROM ${table_name} WHERE rfq_id = $1`, [rfq_id]);
      } catch (_) { /* not a table with rfq_id */ }
    }
  }

  if (plan.quotes_delete) {
    const quoteIds = await t.any(`SELECT id FROM tbl_quotes WHERE rfq_id = $1`, [rfq_id]);
    if (quoteIds.length > 0) {
      const ids = quoteIds.map((q) => q.id);
      await t.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [ids]);
      await t.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [ids]);
    }
  } else if (plan.quotes_reopen) {
    // Vendors keep their rows; the buyer reopens the quoting window.
    await t.none(`UPDATE tbl_quotes SET status = 'active' WHERE rfq_id = $1`, [rfq_id]);
  }
}

/**
 * Apply rfq-level resets (status, is_published) per the destination
 * stage. Always increments iteration_number.
 */
async function resetRfqHeader(t, { rfq_id, plan }) {
  const sets = ['iteration_number = COALESCE(iteration_number, 1) + 1'];
  const vals = [rfq_id];
  let p = 2;
  if (plan.rfq_status_after !== null) {
    sets.push(`status = $${p++}`);
    vals.push(plan.rfq_status_after);
  }
  if (plan.is_published_after !== null) {
    sets.push(`is_published = $${p++}`);
    vals.push(plan.is_published_after);
  }
  await t.none(
    `UPDATE tbl_rfq SET ${sets.join(', ')} WHERE id = $1`,
    vals
  );

  const after = await t.one(
    `SELECT iteration_number, status, is_published FROM tbl_rfq WHERE id = $1`,
    [rfq_id]
  );
  return after;
}

/**
 * Public entry point. Throws on invalid transitions or missing data.
 * Caller (controller) is responsible for permission gating.
 */
export async function sendBackTender({
  rfq_id,
  from_stage,
  to_stage,
  reason,
  performed_by,
  txContext = null,
}) {
  if (!rfq_id || !from_stage || !to_stage || !performed_by) {
    throw new Error('rfq_id, from_stage, to_stage, and performed_by are required');
  }
  if (!FROM_STAGES.has(from_stage)) {
    throw new Error(`Unsupported from_stage: ${from_stage}`);
  }
  if (!reason || reason.trim().length < 30) {
    throw new Error('A reason of at least 30 characters is required for any send-back.');
  }

  const plan = wipePlan({ from: from_stage, to: to_stage });
  if (!plan) {
    throw new Error(`Invalid send-back transition: ${from_stage} → ${to_stage}`);
  }

  const run = async (t) => {
    // 1. Confirm the rfq is a tender.
    const rfq = await t.oneOrNone(`SELECT id, is_tender, iteration_number FROM tbl_rfq WHERE id = $1`, [rfq_id]);
    if (!rfq) throw new Error(`RFQ ${rfq_id} not found`);
    if (rfq.is_tender !== 1) throw new Error('Send-back is only valid for tenders');

    // 2. Capture snapshot first so the wipe doesn't lose anything.
    const snapshot = await captureSnapshot(t, { rfq_id, plan });

    // 3. Persist the snapshot history row BEFORE the wipe. The
    //    iteration_number we record is the iteration that's being
    //    sent back (i.e. the value BEFORE we increment).
    const historyRow = await t.one(
      `INSERT INTO tbl_tender_sendback_history
        (rfq_id, iteration_number, sent_back_from_stage, sent_back_to_stage,
         sent_back_by, reason,
         snapshot_arc, snapshot_finalization, snapshot_negotiation,
         snapshot_tech_eval, snapshot_quotes, snapshot_approval_instances,
         affected_products, affected_vendors, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        rfq_id,
        rfq.iteration_number || 1,
        from_stage,
        to_stage,
        performed_by,
        reason.trim(),
        snapshot.snapshot_arc ? JSON.stringify(snapshot.snapshot_arc) : null,
        snapshot.snapshot_finalization ? JSON.stringify(snapshot.snapshot_finalization) : null,
        snapshot.snapshot_negotiation ? JSON.stringify(snapshot.snapshot_negotiation) : null,
        snapshot.snapshot_tech_eval ? JSON.stringify(snapshot.snapshot_tech_eval) : null,
        snapshot.snapshot_quotes ? JSON.stringify(snapshot.snapshot_quotes) : null,
        snapshot.snapshot_approval_instances ? JSON.stringify(snapshot.snapshot_approval_instances) : null,
        snapshot.affected_products,
        snapshot.affected_vendors,
        JSON.stringify({ wipe_plan: plan }),
      ]
    );

    // 4. Cancel approval instances (NOT delete — audit trail stays whole).
    await cancelApprovalInstances(t, {
      snapshotInstances: snapshot.snapshot_approval_instances || [],
      sendback_from: from_stage,
      sendback_to: to_stage,
      performed_by,
      reason: reason.trim(),
    });

    // 5. Wipe the active state per plan.
    await wipeActiveState(t, { rfq_id, plan });

    // 6. Reset rfq header + bump iteration counter.
    const after = await resetRfqHeader(t, { rfq_id, plan });

    // 7. Lifecycle audit.
    await recordLifecycleEvent({
      entity_type: 'TENDER',
      entity_id: rfq_id,
      stage: 'TENDER_SENDBACK',
      action: 'SEND_BACK',
      performed_by,
      metadata: {
        from_stage,
        to_stage,
        iteration_before: rfq.iteration_number || 1,
        iteration_after: after.iteration_number,
        history_id: historyRow.id,
        affected_products: snapshot.affected_products,
        affected_vendors: snapshot.affected_vendors,
      },
      remarks: reason.trim(),
      txContext: t,
    });

    return {
      history_id: historyRow.id,
      iteration_before: rfq.iteration_number || 1,
      iteration_after: after.iteration_number,
      from_stage,
      to_stage,
      affected_products: snapshot.affected_products,
      affected_vendors: snapshot.affected_vendors,
    };
  };

  return txContext ? run(txContext) : db.tx(run);
}

/**
 * Helper for callers (controllers, tests) to fetch the iteration history
 * panel data. Returns rows newest first, with the snapshot blobs
 * intact for drawer rendering on the FE.
 */
export async function getTenderIterationHistory(rfq_id) {
  return db.any(
    `SELECT h.*, u.name AS sent_back_by_name
     FROM tbl_tender_sendback_history h
     LEFT JOIN tbl_users u ON u.id = h.sent_back_by
     WHERE h.rfq_id = $1
     ORDER BY h.sent_back_at DESC, h.id DESC`,
    [rfq_id]
  );
}
