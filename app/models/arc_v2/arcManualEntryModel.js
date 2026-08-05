import db from '../../config/dbConn.js';

/**
 * ARC v2 — Manual / backfill data-entry model.
 *
 * Powers the back-office "Manual ARC Entry" workspace (spec §5/§6): the purchase
 * team hand-keys a complete Annual Rate Contract — at any lifecycle target stage
 * (draft … ended) — with BACKDATED timestamps, reusing the existing ARC v2 tables
 * and lifecycle rather than a parallel data model.
 *
 * Why a dedicated model: the live-flow helpers in arcModel / arcEvaluationModel /
 * arcContractModel hardcode NOW()/CURRENT_TIMESTAMP on the columns we must
 * backdate (created_at, floated event `at`, quote submitted_at, comm finalized_at,
 * contract generated_at / signed_by_vendor_at, every event `at`). This model adds
 * thin timestamp-ACCEPTING variants for exactly those inserts. Everything else
 * reuses the existing tables/columns verbatim.
 *
 * Every function accepts an optional txContext so finalizeManualArc can compose
 * the whole object graph in ONE transaction (spec §6.5).
 */
const arcManualEntryModel = {
  // ============================================================
  // Provenance row (one per ARC)
  // ============================================================

  /**
   * Create the provenance row for a manually-entered ARC. is_manual is always
   * true; entered_by is the server-derived actor (never from the body).
   */
  create: async (arcId, data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_manual_entry
         (arc_id, is_manual, target_stage, eligibility_overridden,
          committee_decision, committee_decided_at, committee_decided_by, committee_comment,
          entered_by, entry_notes)
       VALUES ($1, TRUE, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        arcId,
        data.target_stage,
        data.eligibility_overridden ?? false,
        data.committee_decision ?? null,
        data.committee_decided_at ?? null,
        data.committee_decided_by ?? null,
        data.committee_comment ?? null,
        data.entered_by,
        data.entry_notes ?? null,
      ]
    );
  },

  getByArc: async (arcId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT * FROM tbl_arc_manual_entry WHERE arc_id = $1`,
      [arcId]
    );
  },

  /**
   * Patch the provenance row. Only the manual-entry-owned fields are writable;
   * arc_id / entered_by / is_manual are immutable.
   */
  update: async (arcId, patch, txContext = null) => {
    const runner = txContext || db;
    const allowed = [
      'target_stage', 'eligibility_overridden',
      'committee_decision', 'committee_decided_at', 'committee_decided_by', 'committee_comment',
      'entry_notes', 'backdated_dates',
    ];
    const setParts = [];
    const values = [];
    let p = 1;
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        if (key === 'backdated_dates') {
          // JSONB column — stringify + cast (the column has no implicit text→jsonb cast).
          setParts.push(`backdated_dates = $${p++}::jsonb`);
          values.push(JSON.stringify(patch[key] && typeof patch[key] === 'object' ? patch[key] : {}));
        } else {
          setParts.push(`${key} = $${p++}`);
          values.push(patch[key]);
        }
      }
    }
    if (setParts.length === 0) {
      return runner.oneOrNone(`SELECT * FROM tbl_arc_manual_entry WHERE arc_id = $1`, [arcId]);
    }
    setParts.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(arcId);
    return runner.one(
      `UPDATE tbl_arc_manual_entry SET ${setParts.join(', ')} WHERE arc_id = $${p} RETURNING *`,
      values
    );
  },

  // ============================================================
  // Backdated INSERT variants (the live helpers hardcode NOW())
  // ============================================================

  /**
   * Create a draft ARC honouring a backdated created_at (and updated_at). Mirrors
   * arcModel.createDraft column-for-column but lets the caller stamp created_at.
   * status is forced to 'draft' — the manual flow flips to the final status only
   * at finalize, never at draft-create.
   */
  createBackdatedDraft: async (data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc
         (arc_number, title, description, category_id, sub_category_ids,
          hospitality_company_id, hotel_id, department_id, process_id,
          status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          technical_response_required, sample_required, eligibility_type,
          escalation_clause_json, payment_terms_expected, delivery_expected, penalty_clause,
          type, created_by, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5::jsonb,
          $6, $7, $8, $9,
          'draft',
          $10, $11, $12, $13,
          $14, $15, $16,
          $17::jsonb, $18, $19, $20,
          $21, $22, COALESCE($23, CURRENT_TIMESTAMP), COALESCE($23, CURRENT_TIMESTAMP))
       RETURNING *`,
      [
        data.arc_number, data.title, data.description ?? null, data.category_id,
        JSON.stringify(data.sub_category_ids ?? []),
        data.hospitality_company_id, data.hotel_id, data.department_id, data.process_id ?? null,
        data.submission_start_at ?? null, data.submission_end_at ?? null,
        data.contract_start_at ?? null, data.contract_end_at ?? null,
        !!data.technical_response_required, !!data.sample_required, data.eligibility_type ?? 'open',
        JSON.stringify(data.escalation_clause_json ?? {}),
        data.payment_terms_expected ?? null, data.delivery_expected ?? null, data.penalty_clause ?? null,
        data.type ?? 'product', data.created_by, data.created_at ?? null,
      ]
    );
  },

  /** Add an ARC item, with optional HSN (spec §5.2). */
  addItem: async (arcId, data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_item
         (arc_id, product_variant_id, spec_text, target_price,
          indicative_qty, uom, hsn, spec_attachment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [arcId, data.product_variant_id, data.spec_text ?? null, data.target_price ?? null,
       data.indicative_qty, data.uom ?? null, data.hsn ?? null, data.spec_attachment_id ?? null]
    );
  },

  /** Insert an invitation row with a backdated invited_at. */
  addInvitation: async (arcId, vendorId, { status = 'submitted', invited_at = null, responded_at = null } = {}, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status, invited_at, responded_at)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_TIMESTAMP), $5)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET status       = EXCLUDED.status,
             invited_at   = EXCLUDED.invited_at,
             responded_at = EXCLUDED.responded_at
       RETURNING *`,
      [arcId, vendorId, status, invited_at, responded_at]
    );
  },

  /** Insert (or upsert) a vendor quote with a backdated submitted_at. */
  addQuote: async (arcId, vendorId, { submitted_at = null, payment_terms = null, gstin_used = null } = {}, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, payment_terms, gstin_used)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET submitted_at  = EXCLUDED.submitted_at,
             payment_terms = EXCLUDED.payment_terms,
             gstin_used    = EXCLUDED.gstin_used,
             updated_at    = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcId, vendorId, submitted_at, payment_terms, gstin_used]
    );
  },

  /** Insert (or upsert) a quote line. */
  addQuoteLine: async (arcQuoteId, line, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_quote_line
         (arc_quote_id, arc_item_id, rate, gst_pct, charges, lead_time_days, moq, validity_notes)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (arc_quote_id, arc_item_id) DO UPDATE
         SET rate           = EXCLUDED.rate,
             gst_pct        = EXCLUDED.gst_pct,
             charges        = EXCLUDED.charges,
             lead_time_days = EXCLUDED.lead_time_days,
             moq            = EXCLUDED.moq,
             validity_notes = EXCLUDED.validity_notes,
             updated_at     = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcQuoteId, line.arc_item_id, line.rate ?? null, line.gst_pct ?? null,
       JSON.stringify(line.charges ?? []),
       line.lead_time_days ?? null, line.moq ?? null, line.validity_notes ?? null]
    );
  },

  /** Create the comm-eval row at a chosen status with backdated finalized_at. */
  createCommEval: async (arcId, { status = 'finalized', finalized_by = null, finalized_at = null } = {}, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_comm_evaluation (arc_id, status, finalized_by, finalized_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (arc_id) DO UPDATE
         SET status       = EXCLUDED.status,
             finalized_by = EXCLUDED.finalized_by,
             finalized_at = EXCLUDED.finalized_at,
             updated_at   = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcId, status, finalized_by, finalized_at]
    );
  },

  /** Insert one award row (item × vendor). */
  addAward: async (commEvalId, award, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_comm_evaluation_award
         (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id,
          awarded_quote_line_id, allocated_qty, allocated_share_pct,
          l_rank, is_l1_default, awarded_quote_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [commEvalId, award.arc_item_id, award.awarded_vendor_id,
       award.awarded_quote_line_id, award.allocated_qty, award.allocated_share_pct ?? null,
       award.l_rank ?? null, award.is_l1_default ?? false,
       JSON.stringify(award.awarded_quote_snapshot ?? {})]
    );
  },

  /**
   * Create a contract honouring backdated generated_at, signed_by_vendor_at,
   * document_source, document_hash and an explicit status. Distinct from
   * arcContractModel.createContract, which hardcodes status 'awaiting_acceptance'
   * and generated_at = NOW().
   */
  createBackdatedContract: async (data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_contract
         (arc_id, vendor_id, document_s3_url, document_hash, document_source,
          status, generated_at, awaiting_until, signed_by_vendor_at,
          terminated_at, terminated_reason, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6,
          COALESCE($7, CURRENT_TIMESTAMP), $8, $9, $10, $11,
          COALESCE($7, CURRENT_TIMESTAMP), COALESCE($7, CURRENT_TIMESTAMP))
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET document_s3_url     = EXCLUDED.document_s3_url,
             document_hash       = EXCLUDED.document_hash,
             document_source     = EXCLUDED.document_source,
             status              = EXCLUDED.status,
             generated_at        = EXCLUDED.generated_at,
             awaiting_until      = EXCLUDED.awaiting_until,
             signed_by_vendor_at = EXCLUDED.signed_by_vendor_at,
             terminated_at       = EXCLUDED.terminated_at,
             terminated_reason   = EXCLUDED.terminated_reason,
             updated_at          = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        data.arc_id, data.vendor_id, data.document_s3_url ?? null, data.document_hash ?? null,
        data.document_source ?? 'generated', data.status ?? 'awaiting_acceptance',
        data.generated_at ?? null, data.awaiting_until ?? null, data.signed_by_vendor_at ?? null,
        data.terminated_at ?? null, data.terminated_reason ?? null,
      ]
    );
  },

  /** Insert (or upsert) a contract line. */
  addContractLine: async (arcContractId, line, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_contract_line
         (arc_contract_id, arc_item_id, unit_rate, gst_pct, charges,
          payment_terms, delivery_terms, committed_qty, awarded_quote_snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)
       ON CONFLICT (arc_contract_id, arc_item_id) DO UPDATE
         SET unit_rate              = EXCLUDED.unit_rate,
             gst_pct                = EXCLUDED.gst_pct,
             charges                = EXCLUDED.charges,
             payment_terms          = EXCLUDED.payment_terms,
             delivery_terms         = EXCLUDED.delivery_terms,
             committed_qty          = EXCLUDED.committed_qty,
             awarded_quote_snapshot = EXCLUDED.awarded_quote_snapshot,
             updated_at             = CURRENT_TIMESTAMP
       RETURNING *`,
      [arcContractId, line.arc_item_id, line.unit_rate, line.gst_pct ?? null,
       JSON.stringify(line.charges ?? []),
       line.payment_terms ?? null, line.delivery_terms ?? null,
       line.committed_qty, JSON.stringify(line.awarded_quote_snapshot ?? {})]
    );
  },

  /** Append a lifecycle event with a backdated `at` and a manual_entry marker. */
  addBackdatedEvent: async (arcId, { eventType, actorId = null, payload = {}, at = null }, txContext = null) => {
    const runner = txContext || db;
    return runner.oneOrNone(
      `INSERT INTO tbl_arc_event_log (arc_id, event_type, actor_id, payload, at)
       VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, CURRENT_TIMESTAMP))
       RETURNING id`,
      [arcId, eventType, actorId, JSON.stringify({ ...payload, manual_entry: true }), at]
    );
  },

  // ============================================================
  // Read helpers (resume / hydrate)
  // ============================================================

  /**
   * Hydrate the full manual-entry graph for resume (spec §6.2 GET draft):
   * arc + manual_entry + items + invitations + quotes(+lines) + comm-eval(+awards)
   * + contracts(+lines).
   */
  hydrate: async (arcId, txContext = null) => {
    const runner = txContext || db;
    const arc = await runner.oneOrNone(`SELECT * FROM tbl_arc WHERE id = $1`, [arcId]);
    if (!arc) return null;
    const [manual_entry, items, invitations, quotes, commEval, contracts] = await Promise.all([
      runner.oneOrNone(`SELECT * FROM tbl_arc_manual_entry WHERE arc_id = $1`, [arcId]),
      runner.any(`SELECT * FROM tbl_arc_item WHERE arc_id = $1 ORDER BY id`, [arcId]),
      runner.any(`SELECT * FROM tbl_arc_invitation WHERE arc_id = $1 ORDER BY id`, [arcId]),
      runner.any(`SELECT * FROM tbl_arc_quote WHERE arc_id = $1 ORDER BY id`, [arcId]),
      runner.oneOrNone(`SELECT * FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId]),
      runner.any(`SELECT * FROM tbl_arc_contract WHERE arc_id = $1 ORDER BY id`, [arcId]),
    ]);
    for (const q of quotes) {
      q.lines = await runner.any(`SELECT * FROM tbl_arc_quote_line WHERE arc_quote_id = $1 ORDER BY arc_item_id`, [q.id]);
    }
    let awards = [];
    if (commEval) {
      awards = await runner.any(`SELECT * FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id = $1 ORDER BY arc_item_id`, [commEval.id]);
    }
    for (const c of contracts) {
      c.lines = await runner.any(`SELECT * FROM tbl_arc_contract_line WHERE arc_contract_id = $1 ORDER BY arc_item_id`, [c.id]);
    }
    return { arc, manual_entry, items, invitations, quotes, comm_eval: commEval, awards, contracts };
  },
};

export default arcManualEntryModel;
