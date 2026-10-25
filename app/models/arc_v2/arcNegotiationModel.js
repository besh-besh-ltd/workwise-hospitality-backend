import db from '../../config/dbConn.js';
import { NEGOTIATION_TIMESTAMP_KEYS, parseAsUTC, withIsoTimestamps } from '../../helper/dbTime.js';
import { redactDisqualifiedQuotes } from '../../helper/arc_v2/quoteRedaction.js';
import { arcNegotiationSeatSql, assembleApprovalInstances } from '../negotiationModel.js';
import arcModel from './arcModel.js';
import arcEvalModel from './arcEvaluationModel.js';

/**
 * ARC Negotiation Model
 *
 * ARC-scoped round/quote queries. All reads and writes filter
 *   source_type = 'ARC'  AND  source_id = arcId
 * so they never touch RFQ negotiation rows (the RFQ model accessors INNER JOIN
 * tbl_rfq on nr.rfq_id and would silently drop ARC rounds whose rfq_id is NULL).
 *
 * Persistence rule (mirrors RFQ negotiationModel convention):
 *   single item entry  → arc_item_id = <that item>, products = NULL
 *   multi/arc-level    → arc_item_id = NULL, products = JSONB array of entries
 */

const arcNegotiationModel = {

  // ──────────────────────────────────────────────────────────────────────────
  // Round CRUD
  // ──────────────────────────────────────────────────────────────────────────

  /** Insert one negotiation round (ARC-sourced). */
  createRound: async (data, txContext = null) => {
    const {
      arcId,
      arcItemId = null,   // non-null = single-item round
      products  = null,   // non-null = multi-item or arc-level round
      endDate,
      targetPrice = null,
      remarks = null,
      creatorRemarks = null,
      createdBy,
      vendorIds = [],
      vendorApprovals = [],
      roundNumber,
    } = data;
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, rfq_id, rfq_product_id,
          arc_item_id, products,
          round_number, end_date, target_price, remarks, creator_remarks,
          status, created_by, vendor_ids, vendor_approvals,
          created_at, updated_at)
       VALUES
         ('ARC', $1, NULL, NULL,
          $2, $3::jsonb,
          $4, $5, $6, $7, $11,
          'PENDING_APPROVAL', $8, $9::int[], $10::jsonb,
          NOW(), NOW())
       RETURNING *`,
      [
        arcId,
        arcItemId,
        products ? JSON.stringify(products) : null,
        roundNumber,
        endDate,
        targetPrice,
        remarks,
        createdBy,
        vendorIds,
        JSON.stringify(vendorApprovals),
        creatorRemarks,
      ]
    );
  },

  /** Next round number for this ARC (MAX + 1). */
  getNextRoundNumber: async (arcId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT COALESCE(MAX(round_number), 0) + 1 AS next_no
         FROM tbl_negotiation_rounds
        WHERE source_type = 'ARC' AND source_id = $1`,
      [arcId]
    );
    return row ? Number(row.next_no) : 1;
  },

  getRoundById: async (roundId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT * FROM tbl_negotiation_rounds WHERE id = $1`,
      [roundId]
    );
  },

  /** All rounds for an ARC with item-name decoration (item-level and arc-level). */
  getRoundsForArc: async (arcId, userId = null, txContext = null) => {
    const rows = await (txContext || db).any(
      `SELECT nr.*,
              pv.name AS arc_item_name,
              -- The approve/reject action belongs to the round's ARC_NEGOTIATION
              -- approval instance's CURRENT-step PENDING approver — NOT to anyone
              -- holding the arc-comm.evaluate permission. Surface can_user_approve
              -- (+ the pending approver's name) so the FE gates the button on the
              -- real approver, mirroring arcLifecycleModel.loadInstance and the
              -- engine check in executeApprovalAction.
              (nr.status = 'PENDING_APPROVAL' AND COALESCE(appr.is_me, false)) AS can_user_approve,
              appr.pending_approver
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_arc_item ai ON ai.id = nr.arc_item_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
         LEFT JOIN LATERAL (
           SELECT id AS instance_id, current_step
             FROM tbl_approval_instances
            WHERE entity_type = 'ARC_NEGOTIATION' AND entity_id = nr.id
            ORDER BY created_at DESC
            LIMIT 1
         ) inst ON true
         LEFT JOIN LATERAL (
           SELECT bool_or(sa.approver_user_id = $2 AND sa.status = 'PENDING') AS is_me,
                  MIN(CASE WHEN sa.status = 'PENDING' THEN u.name END) AS pending_approver
             FROM tbl_approval_instance_steps s
             JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
             JOIN tbl_users u ON u.id = sa.approver_user_id
            WHERE s.approval_instance_id = inst.instance_id
              AND s.step_order = inst.current_step
         ) appr ON true
        WHERE nr.source_type = 'ARC' AND nr.source_id = $1
        ORDER BY nr.round_number DESC`,
      [arcId, userId]
    );
    // `SELECT nr.*` — the naive UTC columns get an explicit offset before they
    // reach ArcRoundsList / ArcApproveRoundPanel, both of which parsed the bare
    // string as local wall clock. See helper/dbTime.js.
    return rows.map((r) => withIsoTimestamps(r, NEGOTIATION_TIMESTAMP_KEYS));
  },

  /**
   * Overlap guard: is there already a non-terminal round that covers the
   * same scope for any of the given vendor ids?
   *
   * For item-level entries (arcItemId provided): match rows where
   *   arc_item_id = arcItemId  (single-item rounds)
   *   OR the products JSONB array contains an entry with that arc_item_id
   *   OR there is an arc-level round (products @> '[{"is_arc_level":true}]')
   *
   * For arc-level entries (arcItemId = null): match any non-terminal round
   * for this ARC that overlaps any of the vendor ids.
   *
   * Returns the first overlapping round row, or null.
   */
  getOverlappingRound: async (arcId, { arcItemId = null, vendorIds = [] }, txContext = null) => {
    const runner = txContext || db;
    if (arcItemId) {
      return runner.oneOrNone(
        `SELECT nr.id, nr.round_number, nr.status, nr.end_date, nr.arc_item_id, nr.products
           FROM tbl_negotiation_rounds nr
          WHERE nr.source_type = 'ARC'
            AND nr.source_id = $1
            AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
            AND nr.end_date > NOW()
            AND (
              nr.arc_item_id = $2
              OR (nr.products IS NOT NULL AND nr.products @> $3::jsonb)
              OR (nr.products IS NOT NULL AND nr.products @> '[{"is_arc_level":true}]'::jsonb)
            )
            AND nr.vendor_ids && $4::int[]
          LIMIT 1`,
        [arcId, arcItemId, JSON.stringify([{ arc_item_id: arcItemId }]), vendorIds]
      );
    }
    // Arc-level entry: any non-terminal round for this ARC with overlapping vendors
    return runner.oneOrNone(
      `SELECT nr.id, nr.round_number, nr.status, nr.end_date, nr.arc_item_id, nr.products
         FROM tbl_negotiation_rounds nr
        WHERE nr.source_type = 'ARC'
          AND nr.source_id = $1
          AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
          AND nr.end_date > NOW()
          AND nr.vendor_ids && $2::int[]
        LIMIT 1`,
      [arcId, vendorIds]
    );
  },

  updateRoundStatus: async (roundId, status, extras = {}, txContext = null) => {
    const sets   = ['status = $2', 'updated_at = NOW()'];
    const params = [roundId, status];
    let p = 3;
    if (extras.approved_at  !== undefined) { sets.push(`approved_at  = $${p++}`); params.push(extras.approved_at); }
    if (extras.published_at !== undefined) { sets.push(`published_at = $${p++}`); params.push(extras.published_at); }
    if (extras.closed_at    !== undefined) { sets.push(`closed_at    = $${p++}`); params.push(extras.closed_at); }
    return (txContext || db).oneOrNone(
      `UPDATE tbl_negotiation_rounds SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
  },

  /**
   * Set all vendor_approvals[] entries to a uniform status (e.g. 'APPROVED').
   * Uses the same JSONB merge pattern as negotiationModel (lines 1532-1601).
   */
  updateAllVendorsStatus: async (roundId, status, txContext = null) => {
    return (txContext || db).oneOrNone(
      `UPDATE tbl_negotiation_rounds
          SET vendor_approvals = (
                SELECT jsonb_agg(
                  jsonb_set(elem, '{status}', $2::jsonb)
                )
                FROM jsonb_array_elements(vendor_approvals) AS elem
              ),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [roundId, JSON.stringify(status)]
    );
  },

  /** Flip the status of one vendor inside vendor_approvals[]. */
  updateVendorApprovalStatus: async (roundId, vendorId, status, txContext = null) => {
    return (txContext || db).oneOrNone(
      `UPDATE tbl_negotiation_rounds
          SET vendor_approvals = (
                SELECT jsonb_agg(
                  CASE WHEN (elem->>'vendor_id')::int = $2
                    THEN jsonb_set(elem, '{status}', $3::jsonb)
                    ELSE elem
                  END
                )
                FROM jsonb_array_elements(vendor_approvals) AS elem
              ),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [roundId, vendorId, JSON.stringify(status)]
    );
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Round quotes
  // ──────────────────────────────────────────────────────────────────────────

  insertRoundQuote: async (data, txContext = null) => {
    const { negotiationRoundId, vendorId, arcItemId, quotedPrice, previousPrice } = data;
    return (txContext || db).one(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, arc_item_id,
          quoted_price, previous_price, submitted_at, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, NOW(), NOW())
       RETURNING *`,
      [negotiationRoundId, vendorId, arcItemId, quotedPrice, previousPrice]
    );
  },

  getExistingRoundQuote: async (roundId, vendorId, arcItemId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT * FROM tbl_negotiation_round_quotes
        WHERE negotiation_round_id = $1 AND vendor_id = $2 AND arc_item_id = $3`,
      [roundId, vendorId, arcItemId]
    );
  },

  getRoundQuotes: async (roundId, txContext = null) => {
    return (txContext || db).any(
      `SELECT nrq.*,
              u.name  AS vendor_name,
              u.email AS vendor_email,
              pv.name AS arc_item_name
         FROM tbl_negotiation_round_quotes nrq
         LEFT JOIN tbl_users u   ON u.id  = nrq.vendor_id
         LEFT JOIN tbl_arc_item ai ON ai.id = nrq.arc_item_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
        WHERE nrq.negotiation_round_id = $1
        ORDER BY nrq.submitted_at DESC`,
      [roundId]
    );
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Vendor quote-line helpers (DECISION-1 auto-apply path)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Fetch the vendor's tbl_arc_quote_line row for a given item, with a
   * FOR UPDATE lock so the caller's tx serializes concurrent submissions.
   */
  getVendorQuoteLineForItem: async (arcId, vendorId, arcItemId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT ql.*
         FROM tbl_arc_quote_line ql
         JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1
          AND q.vendor_id = $2
          AND ql.arc_item_id = $3
          AND q.submitted_at IS NOT NULL
          AND q.withdrawn_at IS NULL
        FOR UPDATE`,
      [arcId, vendorId, arcItemId]
    );
  },

  /**
   * DECISION-1 write: archive old rate → tbl_arc_quote_line_history, then
   * UPDATE the live line with the negotiated rate + tag.
   * Must be called inside the caller's db.tx (txContext required).
   */
  applyNegotiatedRate: async ({ lineId, oldRate, oldGstPct, oldCharges, rate, gstPct, charges, roundId, changedBy }, txContext) => {
    const t = txContext;
    // 1a. Archive previous values
    await t.none(
      `INSERT INTO tbl_arc_quote_line_history
         (arc_quote_line_id, rate, gst_pct, charges, changed_by, changed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
      [lineId, oldRate, oldGstPct, JSON.stringify(oldCharges || []), changedBy]
    );
    // 1b+1c. Make the negotiated rate CURRENT and tag it
    return t.oneOrNone(
      `UPDATE tbl_arc_quote_line
          SET rate                = $2,
              gst_pct             = COALESCE($3, gst_pct),
              charges             = COALESCE($4::jsonb, charges),
              rate_source         = 'NEGOTIATED',
              negotiated_round_id = $5,
              line_pricing        = NULL,
              updated_at          = NOW()
        WHERE id = $1
        RETURNING *`,
      [lineId, rate, gstPct, charges ? JSON.stringify(charges) : null, roundId]
    );
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Vendor helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Rows from tbl_users for the vendor_ids on a round. */
  getVendorsForRound: async (roundId, txContext = null) => {
    return (txContext || db).any(
      `SELECT u.id, u.name, u.email
         FROM tbl_negotiation_rounds nr
         JOIN tbl_users u ON u.id = ANY(nr.vendor_ids)
        WHERE nr.id = $1`,
      [roundId]
    );
  },

  /**
   * Lazy-expiry check: returns true when the round is in ACTIVE status but
   * its end_date has already passed (mirror negotiationModel.isRoundExpired).
   */
  isRoundExpired: async (roundId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT status, end_date FROM tbl_negotiation_rounds WHERE id = $1`,
      [roundId]
    );
    if (!row) return false;
    // parseAsUTC is what the RFQ original this claims to mirror actually uses
    // (negotiationModel.isRoundExpired). new Date() on the bare column resolves
    // through the process timezone and expires the round 5h30m early on IST.
    return row.status === 'ACTIVE' && parseAsUTC(row.end_date) <= new Date();
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ARC cron accessors (JOIN tbl_arc, NOT tbl_rfq)
  // The RFQ accessors at negotiationModel.js:1327-1404 INNER JOIN tbl_rfq on
  // nr.rfq_id, so ARC rounds (rfq_id NULL) are silently dropped.
  // ──────────────────────────────────────────────────────────────────────────

  /** Re-fetch a round with ARC context for the cron expiry handler. */
  getRoundWithArcContext: async (roundId) => {
    return db.oneOrNone(
      `SELECT nr.*,
              a.id             AS arc_id,
              a.title          AS arc_title,
              a.arc_number     AS arc_number,
              a.hospitality_company_id,
              a.hotel_id,
              a.department_id,
              a.process_id
         FROM tbl_negotiation_rounds nr
         JOIN tbl_arc a ON a.id = nr.source_id
        WHERE nr.id = $1
          AND nr.source_type = 'ARC'`,
      [roundId]
    );
  },

  /** All ARC rounds that are non-terminal with a future end_date (for reschedule on startup). */
  getArcRoundsForReschedule: async () => {
    return db.any(
      `SELECT id, end_date
         FROM tbl_negotiation_rounds
        WHERE source_type = 'ARC'
          AND status IN ('PENDING_APPROVAL', 'ACTIVE')
          AND end_date > NOW()
        ORDER BY end_date ASC`
    );
  },

  /** ARC rounds that were non-terminal when the server shut down and have since expired. */
  getExpiredArcRoundsDuringDowntime: async () => {
    return db.any(
      `SELECT id, end_date
         FROM tbl_negotiation_rounds
        WHERE source_type = 'ARC'
          AND status IN ('PENDING_APPROVAL', 'ACTIVE')
          AND end_date <= NOW()
        ORDER BY end_date ASC`
    );
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Approval page
  // ──────────────────────────────────────────────────────────────────────────

  /** Does the user hold a live seat on the approval of any round of this ARC? */
  isApproverOnArcNegotiation: async (arcId, userId) => {
    const row = await db.one(
      `SELECT ${arcNegotiationSeatSql('$1::int', '$2')} AS seated`,
      [Number(arcId), Number(userId)]
    );
    return row.seated === true;
  },

  /**
   * Everything the negotiation approval page reads for an ARC, in the RFQ
   * approval bundle's shape (rounds_history + negotiation_instances keyed by
   * round id), plus the ARC header and the items, quotes and technical
   * qualifications the rounds negotiate over.
   *
   * Only the rounds' own vendors and items leave the server: an item entry
   * brings that item × its target vendors; an ARC-level entry (or a legacy
   * round with no item) brings its vendors' whole quote. Prices the technical
   * committee ruled out are redacted exactly as on the commercial evaluation.
   *
   * Access is the caller's concern (arcNegotiationController.getApprovalBundle).
   * Returns null when the ARC does not exist.
   */
  getApprovalBundleForArc: async (arcId, userId) => {
    const [arc, rounds] = await Promise.all([
      db.oneOrNone(
        `SELECT a.id, a.arc_number, a.title, a.status,
                a.hospitality_company_id, a.hotel_id, a.department_id,
                hc.name   AS company_name,
                h.name    AS hotel_name,
                d.title   AS department_title,
                cat.title AS category_title
           FROM tbl_arc a
           LEFT JOIN tbl_hospitality_companies hc     ON hc.id = a.hospitality_company_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_department d                 ON d.id = a.department_id
           LEFT JOIN tbl_category cat                 ON cat.id = a.category_id
          WHERE a.id = $1`,
        [arcId]
      ),
      db.any(
        `SELECT nr.*, u.name AS created_by_name, u.email AS created_by_email,
                pv.name AS arc_item_name
           FROM tbl_negotiation_rounds nr
           LEFT JOIN tbl_users u            ON u.id = nr.created_by
           LEFT JOIN tbl_arc_item ai        ON ai.id = nr.arc_item_id
           LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
          WHERE nr.source_type = 'ARC' AND nr.source_id = $1
          ORDER BY nr.round_number ASC, nr.created_at DESC`,
        [arcId]
      ),
    ]);
    if (!arc) return null;

    const [instances, allItems, allQuotes, qualifiedByItem, universallyFailed] = await Promise.all([
      assembleApprovalInstances(['ARC_NEGOTIATION'], rounds.map((r) => Number(r.id)), userId),
      arcModel.listItems(arcId),
      arcEvalModel.listAllQuotesForArc(arcId),
      arcEvalModel.qualifiedVendorsByItem(arcId),
      arcEvalModel.universallyFailedVendorIds(arcId),
    ]);

    // What the rounds negotiate: item × vendor pairs, and vendors asked at ARC level.
    const pairs = new Set();
    const wholeQuoteVendors = new Set();
    const roundVendors = new Set();
    for (const r of rounds) {
      const entries = Array.isArray(r.products) && r.products.length > 0
        ? r.products
        : [{
            arc_item_id: r.arc_item_id,
            is_arc_level: r.arc_item_id == null,
            vendor_targets: [
              ...(r.vendor_ids || []),
              ...(r.vendor_approvals || []).map((va) => va?.vendor_id),
            ].filter((v) => v != null).map((v) => ({ vendor_id: v })),
          }];
      for (const e of entries) {
        for (const vt of e?.vendor_targets || []) {
          const vendorId = Number(vt?.vendor_id);
          if (!Number.isFinite(vendorId)) continue;
          roundVendors.add(vendorId);
          if (e.is_arc_level === true || e.arc_item_id == null) wholeQuoteVendors.add(vendorId);
          else pairs.add(`${Number(e.arc_item_id)}:${vendorId}`);
        }
      }
    }

    const inPlay = allQuotes.filter((q) =>
      wholeQuoteVendors.has(Number(q.vendor_id)) ||
      pairs.has(`${Number(q.arc_item_id)}:${Number(q.vendor_id)}`)
    );
    const itemIds = new Set(inPlay.map((q) => Number(q.arc_item_id)));
    for (const key of pairs) itemIds.add(Number(key.split(':')[0]));

    const qualified_by_item = {};
    for (const [itemId, vendorIds] of Object.entries(qualifiedByItem)) {
      if (!itemIds.has(Number(itemId))) continue;
      qualified_by_item[itemId] = vendorIds.filter((v) => roundVendors.has(Number(v)));
    }

    const negotiation_instances = {};
    for (const inst of instances) {
      const key = String(inst.entity_id);
      (negotiation_instances[key] ||= []).push(inst);
    }

    const rounds_history = rounds.map((r) => {
      withIsoTimestamps(r, NEGOTIATION_TIMESTAMP_KEYS);
      const current = negotiation_instances[String(r.id)]?.[0];
      return {
        ...r,
        approvals: current
          ? current.steps.flatMap((st) => st.approvers.map((ap) => ({
              id: ap.id,
              approver_name: ap.user_name,
              approver_email: ap.user_email,
              status: ap.status,
              acted_at: ap.acted_at,
              comment: ap.comment,
            })))
          : [],
      };
    });

    return {
      arc,
      rounds_history,
      negotiation_instances,
      items: allItems.filter((i) => itemIds.has(Number(i.id))),
      quotes: redactDisqualifiedQuotes(inPlay, qualifiedByItem, universallyFailed),
      qualified_by_item,
    };
  },
};

export default arcNegotiationModel;
