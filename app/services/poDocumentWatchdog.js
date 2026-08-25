import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { logError } from '../helper/common.js';
import { writePoDocument } from './poDocumentService.js';
import { dispatch as dispatchNotification } from './notificationService.js';
import { buyerPoList } from './notificationLinks.js';

/**
 * Repairs POs whose stored document is older than their own latest approval.
 *
 * The approval transaction (poApprovalService.js) stops new ones appearing: a
 * document that cannot be produced now rolls its approval back. This exists for
 * everything that rule does not reach —
 *
 *   - the sixteen POs already in that state in production;
 *   - documents written outside an approval (PO initiate, PO edit) where a
 *     failure has nothing to roll back;
 *   - anything a future path gets wrong.
 *
 * Modelled on `runRfqStuckPublishWatchdogTick` in cronManager.js, which has
 * been doing exactly this job for stuck RFQ publishes: find, retry, and tell a
 * human when retrying stops helping.
 *
 * Staleness is measurable without any new bookkeeping because the S3 key ends
 * in a millisecond timestamp:
 *
 *     .../purchase-order/po-138757-1756000000000.pdf
 *
 * which is how the production damage was quantified before this existed. New
 * writes also stamp `po_document_generated_at`; the key is the fallback for
 * rows written before that column.
 */

const GRACE_MS = 5 * 60_000;      // let a live approval finish before calling it stale
const MAX_ATTEMPTS = 5;           // then stop retrying and escalate
const BATCH_LIMIT = 25;           // bounded work per tick

// How far back the sweep will rebuild automatically.
//
// Four of the sixteen POs found damaged in production were approved in March
// and May. Their documents have been downloaded, emailed and quite possibly
// signed against, and both the PO template and the pricing code have moved
// since — rebuilding one now would hand the client a *different* PDF for a
// purchase order they consider closed. Anything past this window is reported
// and left alone; repairing it is a deliberate human decision, made with
// scripts/repair_stale_po_documents.mjs.
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

// Reads the write time of the stored document: the stamped column if present,
// else the millisecond timestamp in the S3 key.
const PDF_WRITTEN_AT_SQL = `
  COALESCE(
    po.po_document_generated_at,
    CASE WHEN po.po_pdf_url ~ '-[0-9]{13}\\.pdf$'
         THEN to_timestamp((regexp_match(po.po_pdf_url, '-([0-9]{13})\\.pdf$'))[1]::bigint / 1000.0) AT TIME ZONE 'UTC'
    END
  )`;

/**
 * Is the schema this watchdog needs actually present?
 *
 * deploy-prod.yml has no migration step, so the container can start ahead of
 * its schema. The watchdog is the backstop, not the guarantee — the approval
 * transaction is what stops new damage. When its columns are missing it should
 * say so once and stand down, rather than throw a scan error into the logs
 * every five minutes forever.
 */
const defaultSchemaProbe = (() => {
  let cached = null;
  return async (conn) => {
    if (cached !== null) return cached;
    const row = await conn.oneOrNone(
      `SELECT 1 AS present
         FROM information_schema.columns
        WHERE table_name = 'tbl_rfq_purchase_order'
          AND column_name = 'po_document_attempts'`
    );
    cached = Boolean(row);
    if (!cached) {
      logger.warn(
        '[PO Document Watchdog] Inert: tbl_rfq_purchase_order has no po_document_* columns. ' +
        'Apply migration 20260825120000_po_document_generation_state to enable stale-document repair.'
      );
    }
    return cached;
  };
})();

/**
 * @param {Object} [deps]
 * @param {Object} [deps.conn]        - connection or transaction
 * @param {Function} [deps.clock]     - () => epoch ms
 * @param {Function} [deps.writeDocument] - (poId, conn) => Promise<string>
 * @param {Function} [deps.notify]    - (po) => Promise<void>, escalation
 * @param {number} [deps.graceMs]
 * @param {number} [deps.maxAgeMs]  - do not auto-rebuild approvals older than this
 * @param {number} [deps.maxAttempts]
 * @param {number} [deps.limit]
 * @returns {Promise<{examined:number[], repaired:number[], failed:number[], escalated:number[], skippedTooOld:number[]}>}
 */
export async function runPoDocumentWatchdogTick({
  conn = db,
  clock = () => Date.now(),
  writeDocument = writePoDocument,
  notify = notifyPoDocumentFailure,
  graceMs = GRACE_MS,
  maxAgeMs = MAX_AGE_MS,
  maxAttempts = MAX_ATTEMPTS,
  limit = BATCH_LIMIT,
  hasDocumentStateColumns = defaultSchemaProbe,
} = {}) {
  const outcome = { examined: [], repaired: [], failed: [], escalated: [], skippedTooOld: [], skippedNoSchema: false };

  if (!(await hasDocumentStateColumns(conn))) {
    outcome.skippedNoSchema = true;
    return outcome;
  }

  let stale;
  try {
    stale = await conn.any(
      `
      WITH last_approval AS (
        SELECT ais.approval_instance_id, MAX(sa.acted_at) AS acted_at
          FROM tbl_approval_instance_steps ais
          JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = ais.id
         WHERE sa.status = 'APPROVED'
         GROUP BY ais.approval_instance_id
      )
      SELECT po.id, po.po_number, po.rfq_id, po.company_id,
             po.po_document_attempts, po.po_document_failure_notified_at,
             la.acted_at AS last_approval_at
        FROM tbl_rfq_purchase_order po
        JOIN last_approval la ON la.approval_instance_id = po.approval_instance_id
       WHERE po.approval_instance_id IS NOT NULL
         AND po.status <> 'draft'
         -- past the grace window: not a live approval still finishing
         AND la.acted_at < to_timestamp($1::bigint / 1000.0) AT TIME ZONE 'UTC' - ($2::text || ' milliseconds')::interval
         AND (
              po.po_pdf_url IS NULL
           OR po.po_pdf_url = ''
           OR ${PDF_WRITTEN_AT_SQL} IS NULL
           OR ${PDF_WRITTEN_AT_SQL} < la.acted_at
         )
       ORDER BY la.acted_at DESC
       LIMIT $3
      `,
      [String(clock()), String(graceMs), limit]
    );
  } catch (err) {
    logError('[PO Document Watchdog] Could not scan for stale documents', err);
    return outcome;
  }

  if (!stale.length) return outcome;

  logger.info({ count: stale.length }, '[PO Document Watchdog] Found POs with a stale document');

  const cutoff = clock() - maxAgeMs;

  for (const po of stale) {
    // Settled long enough ago that rewriting it would surprise someone.
    if (new Date(`${po.last_approval_at}Z`).getTime() < cutoff) {
      outcome.skippedTooOld.push(po.id);
      logger.warn(
        { poId: po.id, poNumber: po.po_number, lastApprovalAt: po.last_approval_at },
        '[PO Document Watchdog] Stale document past the auto-repair window; needs a human decision'
      );
      continue;
    }

    outcome.examined.push(po.id);

    try {
      await writeDocument(po.id, conn);
      await conn.none(
        `UPDATE tbl_rfq_purchase_order
            SET po_document_generated_at = NOW(),
                po_document_attempts = 0,
                po_document_failure_reason = NULL,
                po_document_failure_notified_at = NULL
          WHERE id = $1`,
        [po.id]
      );
      outcome.repaired.push(po.id);
      logger.info({ poId: po.id, poNumber: po.po_number }, '[PO Document Watchdog] Repaired stale PO document');
      continue;
    } catch (err) {
      // One PO's failure must not end the sweep — the rest still need repairing.
      logError(`[PO Document Watchdog] Rebuild failed for PO ${po.po_number}`, err);
      outcome.failed.push(po.id);

      const attempts = Number(po.po_document_attempts || 0) + 1;
      await conn.none(
        `UPDATE tbl_rfq_purchase_order
            SET po_document_attempts = $1, po_document_failure_reason = $2
          WHERE id = $3`,
        [attempts, String(err.message || err).slice(0, 500), po.id]
      );

      // Escalate once, when retrying has stopped being useful.
      if (attempts >= maxAttempts && !po.po_document_failure_notified_at) {
        try {
          await notify({ ...po, attempts, reason: err.message });
          await conn.none(
            `UPDATE tbl_rfq_purchase_order SET po_document_failure_notified_at = NOW() WHERE id = $1`,
            [po.id]
          );
          outcome.escalated.push(po.id);
        } catch (notifyErr) {
          logError(`[PO Document Watchdog] Could not escalate PO ${po.po_number}`, notifyErr);
        }
      }
    }
  }

  return outcome;
}

/**
 * Tell the buyers who can act that a PO cannot produce its document.
 *
 * The point of escalating is that somebody looks: a PO stuck here has an
 * approval on record and a document that does not match it, which is exactly
 * what the client complained about.
 */
async function notifyPoDocumentFailure(po) {
  const recipients = await db.any(
    `SELECT DISTINCT urs.user_id AS id
       FROM tbl_user_role_scopes urs
       JOIN tbl_rfq r ON r.id = $1
      WHERE urs.hospitality_company_id = r.hospitality_company_id
        AND (urs.hotel_id IS NULL OR urs.hotel_id = r.hotel_id)`,
    [po.rfq_id]
  );
  if (!recipients.length) return;

  await dispatchNotification({
    userIds: recipients.map((r) => Number(r.id)),
    category: 'po',
    type: 'po_document_generation_failed',
    title: `Action needed: PO #${po.po_number} document could not be generated`,
    body:
      `This purchase order is approved, but its PDF could not be regenerated after ${po.attempts} attempts ` +
      `(${po.reason || 'unknown error'}). The stored document does not reflect the latest approval.`,
    data: { po_id: po.id, po_number: po.po_number, attempts: po.attempts },
    actionUrl: buyerPoList(),
  });
}
