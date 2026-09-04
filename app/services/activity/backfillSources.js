/**
 * Where the activity trail's history comes from.
 *
 * The trail starts empty, but the system has been recording fragments of what
 * happened since go-live on 2026-02-17 — in seven tables, in seven shapes,
 * none of them readable side by side. These queries gather them into one feed
 * so an admin's first visit is not an empty page.
 *
 * Each source is one INSERT ... SELECT rather than a read-modify-write loop.
 * There are around 46,000 rows to project; pulling them through Node to push
 * them back would be slow for no benefit, since the scope resolution is a join
 * either way.
 *
 * Every projected row is flagged `is_reconstructed` and carries where it came
 * from. That matters: some sources have a trustworthy actor and some have
 * none, and presenting an inferred actor as a recorded one would make the feed
 * worse than admitting the gap. The provenance also gives each row a
 * deterministic identity — see uq_activity_backfill_source — so ON CONFLICT
 * DO NOTHING makes re-running free and an interrupted run simply restartable.
 *
 * Lives here rather than in the script so the queries can be tested.
 */
/**
 * A person's name as it is today.
 *
 * Snapshotting the *current* name onto a historical row is a small lie, but
 * the alternative — no name at all — is a bigger one, and the row is marked
 * reconstructed so the reader knows its provenance is weaker.
 */
const ACTOR_LABEL = `COALESCE(u.name, u.email, 'User #' || u.id::text)`;

/**
 * A past-tense verb for a lifecycle action.
 *
 * The raw values are enum-ish shouts — AUTO_PUBLISH, SUBMIT_FOR_APPROVAL —
 * and lowercasing them produces "auto publish rfq 536445", which reads like a
 * log line rather than a sentence. The eight actions below cover the large
 * majority of the 14,158 rows on record; anything else falls back to the
 * generic form, which is ungainly but never wrong.
 */
const LIFECYCLE_VERB = `
  CASE lh.action
    WHEN 'APPROVE' THEN 'approved'
    WHEN 'REJECT' THEN 'rejected'
    WHEN 'FINALIZE' THEN 'finalised'
    WHEN 'SUBMIT' THEN 'submitted'
    WHEN 'SUBMIT_FOR_APPROVAL' THEN 'submitted for approval'
    WHEN 'AUTO_PUBLISH' THEN 'auto-published'
    WHEN 'PUBLISH' THEN 'published'
    WHEN 'PUBLISH_WITHOUT_APPROVAL' THEN 'published without approval'
    WHEN 'CREATE_ROUND' THEN 'opened a negotiation round on'
    WHEN 'ROUND_PUBLISHED' THEN 'published a negotiation round on'
    WHEN 'NEGOTIATION_ROUND_ENDED' THEN 'closed a negotiation round on'
    WHEN 'TERMINATE' THEN 'terminated'
    WHEN 'WITHDRAW' THEN 'withdrew'
    WHEN 'ACCEPT' THEN 'accepted'
    ELSE lower(replace(lh.action, '_', ' '))
  END`;

/**
 * Entity names as a person would write them. "RFQ" is an acronym and looks
 * wrong lowercased; "PO" is not what anyone calls a purchase order out loud.
 */
const ENTITY_NOUN = (col) => `
  CASE ${col}
    WHEN 'RFQ' THEN 'RFQ'
    WHEN 'TENDER' THEN 'tender'
    WHEN 'PO' THEN 'purchase order'
    WHEN 'NEGOTIATION' THEN 'negotiation'
    WHEN 'NEGOTIATION_QUOTE' THEN 'negotiated quote'
    WHEN 'TECHNICAL' THEN 'technical evaluation'
    WHEN 'ARC' THEN 'rate contract'
    WHEN 'INDENT' THEN 'indent'
    ELSE lower(replace(${col}::text, '_', ' '))
  END`;

export const SOURCES = [
  {
    name: 'lifecycle',
    table: 'tbl_lifecycle_history',
    // The richest source: a real actor on every row (NOT NULL), a typed
    // entity, and a stage/action pair that reads almost as a sentence already.
    sql: `
      INSERT INTO tbl_activity_events (
        occurred_at, source, event_key, category, severity,
        actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id,
        entity_type, entity_id, entity_label,
        summary, metadata, is_reconstructed)
      SELECT
        lh.created_at,
        'BACKFILL',
        lower(lh.entity_type::text || '_' || lh.action),
        CASE
          WHEN lh.entity_type::text IN ('RFQ','TENDER') THEN 'Sourcing'
          WHEN lh.entity_type::text = 'NEGOTIATION' THEN 'Negotiation'
          WHEN lh.entity_type::text = 'NEGOTIATION_QUOTE' THEN 'Negotiation'
          WHEN lh.entity_type::text = 'PO' THEN 'Purchase Orders'
          WHEN lh.entity_type::text = 'TECHNICAL' THEN 'Technical Evaluation'
          WHEN lh.entity_type::text = 'ARC' THEN 'Rate Contracts'
          ELSE 'Other'
        END,
        CASE
          WHEN lh.action IN ('APPROVE','REJECT','FINALIZE','TERMINATE','AUTO_PUBLISH') THEN 'critical'
          WHEN lh.action IN ('SUBMIT','SUBMIT_FOR_APPROVAL','PUBLISH','CREATE_ROUND') THEN 'notable'
          ELSE 'routine'
        END,
        CASE WHEN u.id IS NULL THEN 'UNKNOWN' ELSE 'USER' END,
        lh.performed_by,
        COALESCE(${ACTOR_LABEL}, 'Someone'),
        COALESCE(r.hospitality_company_id, po_r.hospitality_company_id),
        COALESCE(r.hotel_id, po_r.hotel_id),
        lh.entity_type::text,
        lh.entity_id,
        COALESCE(r.rfq_no::text, po.po_number::text),
        COALESCE(${ACTOR_LABEL}, 'Someone')
          || ' ' || ${LIFECYCLE_VERB}
          || ' ' || ${ENTITY_NOUN('lh.entity_type::text')}
          || COALESCE(' ' || COALESCE(r.rfq_no::text, po.po_number::text), ''),
        jsonb_build_object(
          'source_table', 'tbl_lifecycle_history',
          'source_id', lh.id::text,
          'stage', lh.stage,
          'action', lh.action,
          'remarks', lh.remarks)
          || COALESCE(lh.metadata, '{}'::jsonb),
        true
      FROM tbl_lifecycle_history lh
      LEFT JOIN tbl_users u ON u.id = lh.performed_by
      LEFT JOIN tbl_rfq r
        ON lh.entity_type::text IN ('RFQ','TENDER','NEGOTIATION','TECHNICAL','NEGOTIATION_QUOTE')
       AND r.id = lh.entity_id
      LEFT JOIN tbl_rfq_purchase_order po
        ON lh.entity_type::text = 'PO' AND po.id = lh.entity_id
      LEFT JOIN tbl_rfq po_r ON po_r.id = po.rfq_id
      WHERE COALESCE(r.hospitality_company_id, po_r.hospitality_company_id) IS NOT NULL
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'approvals',
    table: 'tbl_approval_actions',
    // Every approval decision ever taken. The approval instance carries its
    // own company and hotel, so this needs no entity lookup.
    sql: `
      INSERT INTO tbl_activity_events (
        occurred_at, source, event_key, category, severity,
        actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id, department_id,
        entity_type, entity_id,
        summary, metadata, is_reconstructed)
      SELECT
        aa.created_at,
        'BACKFILL',
        'approval_' || lower(aa.action),
        'Approvals',
        'critical',
        CASE WHEN u.id IS NULL THEN 'UNKNOWN' ELSE 'USER' END,
        aa.approver_user_id,
        COALESCE(${ACTOR_LABEL}, 'Someone'),
        ai.hospitality_company_id,
        ai.hotel_id,
        ai.department_id,
        ai.entity_type::text,
        ai.entity_id,
        COALESCE(${ACTOR_LABEL}, 'Someone')
          || ' ' || CASE aa.action
                      WHEN 'APPROVE' THEN 'approved'
                      WHEN 'REJECT' THEN 'rejected'
                      WHEN 'CANCEL' THEN 'cancelled'
                      ELSE lower(replace(aa.action, '_', ' '))
                    END
          || ' ' || ${ENTITY_NOUN('ai.entity_type::text')} || ' #' || ai.entity_id::text
          || COALESCE(' — "' || nullif(trim(aa.comment), '') || '"', ''),
        jsonb_build_object(
          'source_table', 'tbl_approval_actions',
          'source_id', aa.id::text,
          'action', aa.action,
          'comment', aa.comment,
          'approval_instance_id', aa.approval_instance_id),
        true
      FROM tbl_approval_actions aa
      JOIN tbl_approval_instances ai ON ai.id = aa.approval_instance_id
      LEFT JOIN tbl_users u ON u.id = aa.approver_user_id
      WHERE ai.hospitality_company_id IS NOT NULL
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'rfq_edits',
    table: 'tbl_rfq_change_history',
    // One event per edit *session*, not per field. A save that touched
    // fourteen fields was one thing the buyer did; fourteen lines in the feed
    // would bury everything around it.
    sql: `
      INSERT INTO tbl_activity_events (
        occurred_at, source, event_key, category, severity,
        actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id,
        entity_type, entity_id, entity_label,
        summary, metadata, is_reconstructed)
      SELECT
        min(ch.changed_at),
        'BACKFILL',
        'rfq_edited',
        'Sourcing',
        CASE WHEN bool_or(ch.is_material) THEN 'notable' ELSE 'routine' END,
        CASE WHEN max(u.id) IS NULL THEN 'UNKNOWN' ELSE 'USER' END,
        ch.changed_by,
        COALESCE(max(COALESCE(u.name, u.email)), 'Someone'),
        max(r.hospitality_company_id),
        max(r.hotel_id),
        'RFQ',
        ch.rfq_id,
        max(r.rfq_no::text),
        COALESCE(max(COALESCE(u.name, u.email)), 'Someone')
          || ' edited RFQ ' || COALESCE(max(r.rfq_no::text), ch.rfq_id::text)
          || ' (' || count(*)::text || ' field'
          || CASE WHEN count(*) = 1 THEN '' ELSE 's' END || ')',
        jsonb_build_object(
          'source_table', 'tbl_rfq_change_history',
          'source_id', ch.edit_session_id::text,
          'field_count', count(*),
          'fields', array_agg(DISTINCT ch.field_name)),
        true
      FROM tbl_rfq_change_history ch
      JOIN tbl_rfq r ON r.id = ch.rfq_id
      LEFT JOIN tbl_users u ON u.id = ch.changed_by
      WHERE r.hospitality_company_id IS NOT NULL AND ch.edit_session_id IS NOT NULL
      GROUP BY ch.edit_session_id, ch.rfq_id, ch.changed_by
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'quote_activity',
    table: 'tbl_quote_activity',
    sql: `
      INSERT INTO tbl_activity_events (
        occurred_at, source, event_key, category, severity,
        actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id,
        entity_type, entity_id, entity_label,
        summary, metadata, is_reconstructed)
      SELECT
        qa.created_at,
        'BACKFILL',
        'quote_status_changed',
        'Quoting',
        'routine',
        CASE WHEN u.id IS NULL THEN 'UNKNOWN' ELSE 'USER' END,
        qa.created_by,
        COALESCE(${ACTOR_LABEL}, 'Someone'),
        r.hospitality_company_id,
        r.hotel_id,
        'RFQ',
        qa.rfq_id,
        r.rfq_no::text,
        COALESCE(${ACTOR_LABEL}, 'Someone')
          || ' moved RFQ ' || COALESCE(r.rfq_no::text, qa.rfq_id::text)
          || ' to ' || COALESCE(lower(replace(qa.current_status, '_', ' ')), 'a new status'),
        jsonb_build_object(
          'source_table', 'tbl_quote_activity',
          'source_id', qa.id::text,
          'from', qa.prev_status,
          'to', qa.current_status),
        true
      FROM tbl_quote_activity qa
      JOIN tbl_rfq r ON r.id = qa.rfq_id
      LEFT JOIN tbl_users u ON u.id = qa.created_by
      WHERE r.hospitality_company_id IS NOT NULL
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'logins',
    table: 'tbl_login_log',
    // Who was in the system and when. Routine individually, but the first
    // thing anyone asks when an account is suspected of being misused.
    sql: `
      INSERT INTO tbl_activity_events (
        occurred_at, source, event_key, category, severity,
        actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id,
        entity_type, entity_id,
        summary, metadata, is_reconstructed)
      SELECT
        ll.date,
        'BACKFILL',
        'user_signed_in',
        'People',
        'routine',
        'USER',
        ll.user_id,
        COALESCE(${ACTOR_LABEL}, 'Someone'),
        m.hospitality_company_id,
        m.hospitality_hotel_id,
        'USER',
        ll.user_id,
        COALESCE(${ACTOR_LABEL}, 'Someone') || ' signed in',
        jsonb_build_object(
          'source_table', 'tbl_login_log',
          'source_id', ll.id::text,
          'user_agent', ll.user_agent),
        true
      FROM tbl_login_log ll
      JOIN tbl_users u ON u.id = ll.user_id
      JOIN LATERAL (
        SELECT hospitality_company_id, hospitality_hotel_id
          FROM tbl_hospitality_user_mappings
         WHERE user_id = ll.user_id
         ORDER BY mapping_type ASC, id ASC LIMIT 1
      ) m ON true
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'arc_events',
    table: 'tbl_arc_event_log',
    sql: `
      INSERT INTO tbl_activity_events (
        occurred_at, source, event_key, category, severity,
        actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id,
        entity_type, entity_id, entity_label,
        summary, metadata, is_reconstructed)
      SELECT
        ael.at,
        'BACKFILL',
        'arc_' || lower(ael.event_type),
        'Rate Contracts',
        'notable',
        CASE WHEN ael.actor_id IS NULL THEN 'SYSTEM' ELSE 'USER' END,
        ael.actor_id,
        COALESCE(${ACTOR_LABEL}, 'System'),
        a.hospitality_company_id,
        a.hotel_id,
        'ARC',
        ael.arc_id,
        COALESCE(a.arc_number::text, a.title),
        COALESCE(${ACTOR_LABEL}, 'System')
          || ' — ' || replace(ael.event_type, '_', ' ')
          || ' on contract ' || COALESCE(a.arc_number::text, a.title, ael.arc_id::text),
        jsonb_build_object(
          'source_table', 'tbl_arc_event_log',
          'source_id', ael.id::text,
          'event_type', ael.event_type)
          || COALESCE(ael.payload, '{}'::jsonb),
        true
      FROM tbl_arc_event_log ael
      JOIN tbl_arc a ON a.id = ael.arc_id
      LEFT JOIN tbl_users u ON u.id = ael.actor_id
      WHERE a.hospitality_company_id IS NOT NULL
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'approval_changes',
    table: 'tbl_approval_instance_change_log',
    // Approval flows mutating mid-flight — a policy edited, a role revoked,
    // a user deactivated — while something was already waiting on them. Rare,
    // and exactly the kind of thing nobody can reconstruct after the fact.
    sql: `
      INSERT INTO tbl_activity_events (
        occurred_at, source, event_key, category, severity,
        actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id,
        entity_type, entity_id,
        summary, metadata, is_reconstructed)
      SELECT
        cl.created_at,
        'BACKFILL',
        'approval_flow_changed',
        'Approval Setup',
        'critical',
        'UNKNOWN',
        NULL,
        'System',
        ai.hospitality_company_id,
        ai.hotel_id,
        ai.entity_type::text,
        ai.entity_id,
        'An in-flight approval on ' || ${ENTITY_NOUN('ai.entity_type::text')}
          || ' #' || ai.entity_id::text || ' was changed',
        jsonb_build_object(
          'source_table', 'tbl_approval_instance_change_log',
          'source_id', cl.id::text)
          || COALESCE(cl.change_summary, '{}'::jsonb),
        true
      FROM tbl_approval_instance_change_log cl
      JOIN tbl_approval_instances ai ON ai.id = cl.approval_instance_id
      WHERE ai.hospitality_company_id IS NOT NULL
      ON CONFLICT DO NOTHING`,
  },
];

