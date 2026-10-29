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

/**
 * Company administration, rebuilt from the row-level audit.
 *
 * The live trail dropped administrators' events for its first weeks: users,
 * role and unit changes before the 22 Sep fix, and business-unit removals and
 * approval workflows until 2026-10-12 — the actor had no company of their own
 * and nothing else placed the event. The audit trigger recorded every row of
 * it, with the actor and the request it belonged to. This projects one event
 * per such request.
 *
 * Only requests with an actor and a request id — which is to say real app
 * requests since the request context shipped — and only ones the live trail
 * has no row for. Migrations and scripts (no request id) are not events.
 * Self-edits are not admin actions (logins rewrite user_agent and the push
 * endpoint on every visit), so a tbl_users update counts only when someone
 * changed somebody else's account in a column that means something.
 */
const ADMIN_AUDIT_TABLES = `
  'tbl_users', 'tbl_user_role_scopes', 'tbl_user_department',
  'tbl_hospitality_user_mappings', 'tbl_roles', 'tbl_role_permissions',
  'tbl_approval_processes', 'tbl_approval_policies', 'tbl_approval_policy_steps',
  'tbl_hospitality_companies', 'tbl_hospitality_company_hotels'`;

/** Columns a person's own session rewrites; a change to only these is noise. */
const USER_NOISE_COLUMNS = `'updated_at', 'updated_by', 'user_agent', 'endpoint'`;

/** A buyer company id, only if some administrator can read it. */
const READABLE_BUYER = (col) => `
  CASE WHEN EXISTS (SELECT 1 FROM tbl_hospitality_companies hcb
                     WHERE hcb.buyer_company_id = ${col} AND hcb.is_deleted = 0)
       THEN ${col} END`;

/**
 * "Final Awarding P2 at The Orchid Hotel Mumbai, …" — the role scopes one
 * request added (keep INSERT, drop DELETE) or removed (the reverse). The user
 * edit screen deletes and re-inserts every scope on save, so only the set
 * difference says what actually changed.
 */
const ROLE_SCOPE_DIFF = (keep, drop) => {
  const col = (op) => (op === 'INSERT' ? 'new_data' : 'old_data');
  return `
  SELECT string_agg(DISTINCT ro2.title || COALESCE(' at ' || h2.name, ' across the company'), ', ')
    FROM (
      SELECT (x.${col(keep)} ->> 'role_id')::int AS role_id,
             (x.${col(keep)} ->> 'hotel_id')::int AS hotel_id
        FROM tbl_audit_row_changes x
       WHERE x.request_id = l0.request_id AND x.table_name = 'tbl_user_role_scopes'
         AND x.operation = '${keep}'
      EXCEPT
      SELECT (x.${col(drop)} ->> 'role_id')::int,
             (x.${col(drop)} ->> 'hotel_id')::int
        FROM tbl_audit_row_changes x
       WHERE x.request_id = l0.request_id AND x.table_name = 'tbl_user_role_scopes'
         AND x.operation = '${drop}'
    ) d
    JOIN tbl_roles ro2 ON ro2.id = d.role_id
    LEFT JOIN tbl_hospitality_company_hotels h2 ON h2.id = d.hotel_id`;
};

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
  {
    name: 'admin_actions',
    table: 'tbl_audit_row_changes',
    // Must run after 20261012100000_activity_company_wide_events: workflows
    // and roles are company-wide events (buyer_company_id, no hospitality
    // company), which the table cannot hold before it.
    //
    // Shaped INSERT ... SELECT x.* FROM (WITH ...) x so the runner's dry-run
    // probe, which rewrites the first SELECT, still produces a valid count.
    //
    // occurred_at comes from the audit row's changed_at, a naive timestamp the
    // trigger wrote in the session's time zone; inserting it into the
    // timestamptz column reads it back in the same zone (UTC on production).
    sql: `
      INSERT INTO tbl_activity_events (
        occurred_at, request_id, source, event_key, category, severity,
        actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id, buyer_company_id,
        entity_type, entity_id, entity_label,
        summary, metadata, is_reconstructed)
      SELECT x.*
        FROM (
          WITH changes AS (
            SELECT a.*
              FROM tbl_audit_row_changes a
             WHERE a.request_id IS NOT NULL
               AND a.actor_user_id IS NOT NULL
               AND a.table_name IN (${ADMIN_AUDIT_TABLES})
               AND NOT EXISTS (SELECT 1 FROM tbl_activity_events e WHERE e.request_id = a.request_id)
          ),
          req AS (
            SELECT c.request_id,
                   max(c.actor_user_id) AS actor_id,
                   min(c.changed_at) AS at,
                   bool_or(c.table_name = 'tbl_users' AND c.operation = 'INSERT') AS user_created,
                   bool_or(c.table_name = 'tbl_hospitality_user_mappings' AND c.operation = 'DELETE') AS mapping_removed,
                   bool_or(c.table_name = 'tbl_hospitality_user_mappings' AND c.operation = 'INSERT') AS mapping_added,
                   bool_or(c.table_name IN ('tbl_user_role_scopes', 'tbl_user_department')) AS access_changed,
                   bool_or(c.table_name = 'tbl_approval_processes' AND c.operation = 'INSERT') AS process_created,
                   bool_or(c.table_name = 'tbl_approval_processes' AND c.operation <> 'INSERT') AS process_changed,
                   bool_or(c.table_name IN ('tbl_roles', 'tbl_role_permissions')) AS role_changed,
                   bool_or(c.table_name IN ('tbl_approval_policies', 'tbl_approval_policy_steps')) AS policy_changed,
                   bool_or(c.table_name IN ('tbl_hospitality_companies', 'tbl_hospitality_company_hotels')) AS org_changed,
                   bool_or(c.table_name = 'tbl_users' AND c.operation = 'UPDATE'
                           AND c.record_id <> c.actor_user_id
                           AND EXISTS (SELECT 1 FROM jsonb_object_keys(c.new_data) uk(key)
                                        WHERE uk.key NOT IN (${USER_NOISE_COLUMNS})
                                          AND (c.old_data -> uk.key) IS DISTINCT FROM (c.new_data -> uk.key))
                   ) AS other_user_edited,
                   bool_or(c.table_name = 'tbl_users' AND c.operation = 'UPDATE'
                           AND c.record_id <> c.actor_user_id
                           AND (c.old_data ->> 'otp') IS DISTINCT FROM (c.new_data ->> 'otp')) AS otp_changed,
                   max(CASE WHEN c.table_name = 'tbl_users' AND c.operation = 'UPDATE'
                                 AND c.record_id <> c.actor_user_id
                                 AND (c.old_data ->> 'status') IS DISTINCT FROM (c.new_data ->> 'status')
                            THEN c.new_data ->> 'status' END) AS new_status,
                   COALESCE(
                     max(CASE WHEN c.table_name = 'tbl_users' AND c.operation = 'INSERT' THEN c.record_id END),
                     max(CASE WHEN c.table_name IN ('tbl_user_role_scopes', 'tbl_user_department', 'tbl_hospitality_user_mappings')
                              THEN (COALESCE(c.new_data, c.old_data) ->> 'user_id')::bigint END),
                     max(CASE WHEN c.table_name = 'tbl_users' AND c.operation = 'UPDATE'
                                   AND c.record_id <> c.actor_user_id THEN c.record_id END)
                   ) AS target_user_id,
                   max(CASE WHEN c.table_name = 'tbl_hospitality_user_mappings' AND c.operation = 'DELETE'
                            THEN (c.old_data ->> 'hospitality_company_id')::int END) AS removed_company_id,
                   max(CASE WHEN c.table_name = 'tbl_hospitality_user_mappings' AND c.operation = 'DELETE'
                            THEN (c.old_data ->> 'hospitality_hotel_id')::int END) AS removed_hotel_id,
                   max(CASE WHEN c.table_name = 'tbl_hospitality_user_mappings' AND c.operation = 'INSERT'
                            THEN (c.new_data ->> 'hospitality_company_id')::int END) AS added_company_id,
                   count(DISTINCT CASE WHEN c.table_name = 'tbl_hospitality_user_mappings' AND c.operation = 'INSERT'
                                       THEN c.new_data ->> 'user_id' END) AS added_user_count,
                   max(CASE WHEN c.table_name = 'tbl_approval_processes' THEN c.record_id END) AS process_id,
                   COALESCE(
                     max(CASE WHEN c.table_name = 'tbl_roles' THEN c.record_id END),
                     max(CASE WHEN c.table_name = 'tbl_role_permissions'
                              THEN (COALESCE(c.new_data, c.old_data) ->> 'role_id')::bigint END)
                   ) AS role_id,
                   COALESCE(
                     max(CASE WHEN c.table_name = 'tbl_approval_policies' THEN c.record_id END),
                     max(CASE WHEN c.table_name = 'tbl_approval_policy_steps'
                              THEN (COALESCE(c.new_data, c.old_data) ->> 'policy_id')::bigint END)
                   ) AS policy_id,
                   max(CASE WHEN c.table_name = 'tbl_hospitality_company_hotels' THEN c.record_id END) AS hotel_row_id,
                   max(CASE WHEN c.table_name = 'tbl_hospitality_companies' THEN c.record_id END) AS company_row_id
              FROM changes c
             GROUP BY c.request_id
          ),
          classified AS (
            SELECT r.*,
                   CASE
                     WHEN r.process_created THEN 'approval_process_created'
                     WHEN r.process_changed THEN 'approval_process_updated'
                     WHEN r.role_changed THEN 'role_updated'
                     WHEN r.user_created THEN 'user_created'
                     WHEN r.mapping_removed THEN 'user_mapping_removed'
                     WHEN r.access_changed THEN 'user_updated'
                     WHEN r.mapping_added THEN 'users_mapped_to_unit'
                     WHEN r.otp_changed THEN 'password_reset_sent'
                     WHEN r.other_user_edited THEN 'user_updated'
                     WHEN r.policy_changed THEN 'approval_policy_saved'
                     WHEN r.org_changed THEN 'business_unit_updated'
                   END AS kind
              FROM req r
          ),
          labelled AS (
            SELECT l0.*,
                   COALESCE(NULLIF(TRIM(actor.name), ''), actor.email, 'Someone') AS actor_label,
                   (actor.id IS NOT NULL) AS actor_known,
                   COALESCE(NULLIF(TRIM(tu.name), ''), tu.email, 'a user') AS target_label,
                   tu.company_id AS target_buyer,
                   actor.company_id AS actor_buyer,
                   tm.hospitality_company_id AS target_company_id,
                   tm.hospitality_hotel_id AS target_hotel_id,
                   COALESCE(rh.name, rc.name, 'a business unit') AS removed_unit_label,
                   ac.name AS added_company_label,
                   ap.name AS process_label,
                   ap.company_id AS process_buyer,
                   ro.title AS role_label,
                   rcu.company_id AS role_buyer,
                   pol.entity_type::text AS policy_label,
                   pol.hospitality_company_id AS policy_company_id,
                   pol.hotel_id AS policy_hotel_id,
                   oh.name AS hotel_label,
                   oh.hospitality_company_id AS hotel_company_id,
                   (${ROLE_SCOPE_DIFF('INSERT', 'DELETE')}) AS roles_added,
                   (${ROLE_SCOPE_DIFF('DELETE', 'INSERT')}) AS roles_removed
              FROM classified l0
              LEFT JOIN tbl_users actor ON actor.id = l0.actor_id
              LEFT JOIN tbl_users tu ON tu.id = l0.target_user_id
              LEFT JOIN LATERAL (
                SELECT hospitality_company_id, hospitality_hotel_id
                  FROM tbl_hospitality_user_mappings
                 WHERE user_id = l0.target_user_id
                 ORDER BY mapping_type ASC, id ASC LIMIT 1
              ) tm ON true
              LEFT JOIN tbl_hospitality_companies rc ON rc.id = l0.removed_company_id
              LEFT JOIN tbl_hospitality_company_hotels rh ON rh.id = l0.removed_hotel_id
              LEFT JOIN tbl_hospitality_companies ac ON ac.id = l0.added_company_id
              LEFT JOIN tbl_approval_processes ap ON ap.id = l0.process_id
              LEFT JOIN tbl_roles ro ON ro.id = l0.role_id
              LEFT JOIN tbl_users rcu ON rcu.id = ro.created_by
              LEFT JOIN tbl_approval_policies pol ON pol.id = l0.policy_id
              LEFT JOIN tbl_hospitality_company_hotels oh ON oh.id = l0.hotel_row_id
             WHERE l0.kind IS NOT NULL
          ),
          placed AS (
            SELECT l.*,
                   CASE l.kind
                     WHEN 'user_mapping_removed' THEN l.removed_company_id
                     WHEN 'users_mapped_to_unit' THEN l.added_company_id
                     WHEN 'user_created' THEN l.target_company_id
                     WHEN 'user_updated' THEN l.target_company_id
                     WHEN 'password_reset_sent' THEN l.target_company_id
                     WHEN 'approval_policy_saved' THEN l.policy_company_id
                     WHEN 'business_unit_updated' THEN COALESCE(l.hotel_company_id, l.company_row_id::int)
                   END AS place_company_id,
                   CASE l.kind
                     WHEN 'user_mapping_removed' THEN l.removed_hotel_id
                     WHEN 'user_created' THEN l.target_hotel_id
                     WHEN 'user_updated' THEN l.target_hotel_id
                     WHEN 'password_reset_sent' THEN l.target_hotel_id
                     WHEN 'approval_policy_saved' THEN l.policy_hotel_id
                     WHEN 'business_unit_updated' THEN l.hotel_row_id::int
                   END AS place_hotel_id,
                   CASE
                     WHEN l.kind IN ('approval_process_created', 'approval_process_updated')
                       THEN ${READABLE_BUYER('l.process_buyer')}
                     WHEN l.kind = 'role_updated'
                       THEN ${READABLE_BUYER('COALESCE(l.role_buyer, l.actor_buyer)')}
                     ELSE ${READABLE_BUYER('l.target_buyer')}
                   END AS place_buyer_id
              FROM labelled l
          )
          SELECT
            p.at,
            p.request_id,
            'BACKFILL',
            p.kind,
            CASE
              WHEN p.kind IN ('user_created', 'user_updated', 'password_reset_sent') THEN 'People'
              WHEN p.kind IN ('user_mapping_removed', 'users_mapped_to_unit', 'role_updated') THEN 'Roles & Access'
              WHEN p.kind IN ('approval_process_created', 'approval_process_updated', 'approval_policy_saved') THEN 'Approval Setup'
              ELSE 'Organisation'
            END,
            CASE
              WHEN p.kind IN ('approval_process_created', 'approval_process_updated', 'business_unit_updated', 'user_updated') THEN 'notable'
              ELSE 'critical'
            END,
            CASE WHEN p.actor_known THEN 'USER' ELSE 'UNKNOWN' END,
            p.actor_id,
            p.actor_label,
            p.place_company_id,
            p.place_hotel_id,
            p.place_buyer_id,
            CASE
              WHEN p.kind IN ('user_created', 'user_updated', 'password_reset_sent', 'user_mapping_removed') THEN 'USER'
              WHEN p.kind = 'users_mapped_to_unit' THEN 'COMPANY'
              WHEN p.kind IN ('approval_process_created', 'approval_process_updated') THEN 'APPROVAL_PROCESS'
              WHEN p.kind = 'role_updated' THEN 'ROLE'
              WHEN p.kind = 'approval_policy_saved' THEN 'APPROVAL_POLICY'
              ELSE 'HOTEL'
            END,
            CASE
              WHEN p.kind IN ('user_created', 'user_updated', 'password_reset_sent', 'user_mapping_removed') THEN p.target_user_id
              WHEN p.kind = 'users_mapped_to_unit' THEN p.added_company_id
              WHEN p.kind IN ('approval_process_created', 'approval_process_updated') THEN p.process_id
              WHEN p.kind = 'role_updated' THEN p.role_id
              WHEN p.kind = 'approval_policy_saved' THEN p.policy_id
              ELSE p.hotel_row_id
            END,
            CASE
              WHEN p.kind IN ('user_created', 'user_updated', 'password_reset_sent', 'user_mapping_removed') THEN p.target_label
              WHEN p.kind = 'users_mapped_to_unit' THEN p.added_company_label
              WHEN p.kind IN ('approval_process_created', 'approval_process_updated') THEN p.process_label
              WHEN p.kind = 'role_updated' THEN p.role_label
              WHEN p.kind = 'approval_policy_saved' THEN p.policy_label
              ELSE p.hotel_label
            END,
            p.actor_label || CASE p.kind
              WHEN 'user_created' THEN
                ' created an account for ' || p.target_label
                  || COALESCE(' with approval roles — ' || p.roles_added, '')
              WHEN 'user_updated' THEN
                CASE
                  WHEN p.access_changed AND (p.roles_added IS NOT NULL OR p.roles_removed IS NOT NULL) THEN
                    ' changed ' || p.target_label || '''s approval roles — '
                      || concat_ws('; ', 'removed ' || p.roles_removed, 'added ' || p.roles_added)
                  WHEN p.new_status = '1' THEN ' activated ' || p.target_label || '''s account'
                  WHEN p.new_status = '0' THEN ' deactivated ' || p.target_label || '''s account'
                  ELSE ' updated ' || p.target_label || '''s account'
                END
              WHEN 'user_mapping_removed' THEN ' removed ' || p.target_label || ' from ' || p.removed_unit_label
              WHEN 'users_mapped_to_unit' THEN
                ' gave ' || p.added_user_count::text || ' user(s) access to ' || COALESCE(p.added_company_label, 'the company')
              WHEN 'password_reset_sent' THEN ' sent a password reset to ' || p.target_label
              WHEN 'approval_process_created' THEN
                ' created the approval workflow "' || COALESCE(p.process_label, 'a new workflow') || '"'
              WHEN 'approval_process_updated' THEN
                ' edited the approval workflow "' || COALESCE(p.process_label, 'an approval workflow') || '"'
              WHEN 'role_updated' THEN ' changed the role "' || COALESCE(p.role_label, '#' || p.role_id::text) || '"'
              WHEN 'approval_policy_saved' THEN ' changed who approves ' || COALESCE(p.policy_label, 'work') || ' at this unit'
              ELSE ' updated the business unit ' || COALESCE(p.hotel_label, '')
            END,
            jsonb_build_object(
              'source_table', 'tbl_audit_row_changes',
              'source_id', p.request_id::text,
              'reconstructed_kind', p.kind),
            true
          FROM placed p
          WHERE p.place_company_id IS NOT NULL OR p.place_buyer_id IS NOT NULL
        ) x
      ON CONFLICT DO NOTHING`,
  },
];

