// A deliberately busy RFQ, used to pin RESPONSE EQUIVALENCE and QUERY BUDGETS
// on the read endpoints that fan out per approval instance / step / approver
// (GET /rfq/:id/lifecycle, the quote-comparison view, …).
//
// Every shape those loops have to get right is present at least once:
//   - two products; product 1 tech-evaluated, finalized and on a PO
//     (a PARTIAL award), product 2 still in negotiation
//   - two invited vendors with quotes; one passes tech eval, one fails
//   - RFQ approval  : APPROVED, 2 steps (ANY then ALL), a REMOVED tombstone
//                     approver on step 1, full action history
//   - TECHNICAL     : APPROVED, 1 step
//   - NEGOTIATION_QUOTE : one CANCELLED instance, one PENDING 2-step instance
//                     whose CURRENT step names the requesting buyer
//   - PO            : one CANCELLED (superseded) instance and one PENDING
//                     instance with a live approver + a REMOVED tombstone
//   - negotiation   : two rounds on product 2, one on product 1, vendor quotes
//   - an ACTIVE approval delegation (poApp → commApp), so upcoming-actor
//     resolution goes through applyDelegations
//
// Every timestamp is a fixed literal so the response can be snapshotted; ids
// are tokenised by normalizeForSnapshot below.
//
// Commit + cleanup (Pattern B): the endpoints read through the app pool, so
// the rows must be committed. cleanupRichRfq deletes exactly what was made.

import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const T = (d, h = 10) => `2026-09-${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:00:00`;

export async function seedRichRfq({ buyer = IDS.users.a1_proc_buyer } = {}) {
  const U = IDS.users;
  const made = { rfqId: null, instanceIds: [], delegationIds: [], poIds: [], roundIds: [] };

  await db.tx(async (t) => {
    const { rfq_id, rfq_no } = await makeRFQ(t, {
      createdBy: buyer, status: 1, is_published: 1, is_tender: 0,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, process: IDS.processes.A_P1,
      bid_end_date: "2026-09-10 18:00:00", title: "Perf rich RFQ",
      timestamp: "2026-09-01T09:00:00Z",
    });
    made.rfqId = rfq_id;
    await t.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
      [rfq_id, IDS.hotels.A1, buyer]
    );

    const variants = await t.any(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 2`);
    const [pv1, pv2] = variants.map((v) => v.id);
    const p1 = await t.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 0) RETURNING id`, [rfq_id, pv1]);
    const p2 = await t.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 0) RETURNING id`, [rfq_id, pv2]);

    const vendors = [U.vendor_alpha, U.vendor_beta];
    const quoteIds = {};
    for (const v of vendors) {
      for (const pv of [pv1, pv2]) {
        await t.none(
          `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant, is_rfq_viewed)
           VALUES ($1, $2, $3, 0, 1)`, [rfq_id, pv, v]);
      }
      const q = await t.one(
        `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
         VALUES ($1, $2, $3, $3, 1, $4) RETURNING id`, [rfq_id, rfq_no, v, T(5)]);
      quoteIds[v] = q.id;
      let price = v === U.vendor_alpha ? 100 : 120;
      for (const pv of [pv1, pv2]) {
        await t.none(
          `INSERT INTO tbl_quote_items (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
                                        comment, delivery_period, quantity, variant, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'ok', '7 days', '10', 0, $7)`,
          [rfq_id, rfq_no, q.id, pv, price, price * 10, T(5)]);
        price += 50;
      }
    }

    // Tech eval on product 1: alpha passes, beta fails.
    const te = await t.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, is_complete, current_round, minimum_passing_score)
       VALUES ($1, $2, true, 1, 50) RETURNING id`, [rfq_id, p1.id]);
    const clauses = [];
    for (const [i, w] of [[1, 60], [2, 40]]) {
      const c = await t.one(
        `INSERT INTO tbl_rfq_product_tech_evaluation_clauses (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
         VALUES ($1, $2, $3, 'clause') RETURNING id`, [te.id, `Clause ${i}`, w]);
      clauses.push(c.id);
    }
    for (const [v, marks] of [[U.vendor_alpha, [55, 30]], [U.vendor_beta, [10, 5]]]) {
      for (let i = 0; i < clauses.length; i++) {
        await t.none(
          `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
             (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_marks, buyer_remark, score_timestamp)
           VALUES ($1, $2, 'agree', $3, 'fine', $4)`, [clauses[i], v, marks[i], T(6)]);
      }
      await t.none(
        `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
           (tbl_rfq_product_tech_evaluation_id, vendor_id, status, reject_message, created_by, evaluation_round, "timestamp")
         VALUES ($1, $2, $3, $4, $5, 1, $6)`,
        [te.id, v, v === U.vendor_alpha ? 1 : 0, v === U.vendor_alpha ? null : "Below threshold", U.a1_proc_techEval, T(6, 12)]);
    }

    // Approval instance builder. steps: [{ order, rule, status, completed, approvers: [{ user, status, acted, removed, reason, mid }] }]
    const instance = async ({ type, entityId, policy, status, current, created, completed, metadata = {}, steps, actions = [] }) => {
      const inst = await t.one(
        `INSERT INTO tbl_approval_instances
           (entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id,
            department_id, initiated_by, metadata, created_at, completed_at, process_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [type, entityId, policy, status, current, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc,
         buyer, JSON.stringify({ rfq_id, ...metadata }), created, completed, IDS.processes.A_P1]);
      made.instanceIds.push(inst.id);
      const stepIds = {};
      for (const s of steps) {
        const st = await t.one(
          `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status, created_at, completed_at, added_mid_flight)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [inst.id, s.order, s.rule, s.status, created, s.completed ?? null, !!s.mid]);
        stepIds[s.order] = st.id;
        for (const a of s.approvers) {
          await t.none(
            `INSERT INTO tbl_approval_step_approvers
               (approval_instance_step_id, approver_user_id, status, acted_at, comment, removed_at, removal_reason, added_mid_flight, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [st.id, a.user, a.status, a.acted ?? null, a.comment ?? null, a.removed ?? null, a.reason ?? null, !!a.mid, created]);
        }
      }
      for (const a of actions) {
        await t.none(
          `INSERT INTO tbl_approval_actions (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [inst.id, stepIds[a.step] ?? null, a.user, a.action, a.comment ?? null, a.at]);
      }
      return inst.id;
    };

    await instance({
      type: "RFQ", entityId: rfq_id, policy: IDS.policies.A1_P1_RFQ, status: "APPROVED", current: 2,
      created: T(1, 11), completed: T(2, 15),
      steps: [
        { order: 1, rule: "ANY", status: "APPROVED", completed: T(2, 12), approvers: [
          { user: U.a1_proc_techApp, status: "APPROVED", acted: T(2, 12), comment: "ok" },
          { user: U.midFlightApprover, status: "REMOVED", removed: "2026-09-02 09:00:00+00", reason: "role_removed" },
        ] },
        { order: 2, rule: "ALL", status: "APPROVED", completed: T(2, 15), approvers: [
          { user: U.a1_proc_finance, status: "APPROVED", acted: T(2, 14) },
          { user: U.a1_proc_commApp, status: "APPROVED", acted: T(2, 15), mid: true },
        ] },
      ],
      actions: [
        { step: 1, user: U.a1_proc_techApp, action: "APPROVE", comment: "ok", at: T(2, 12) },
        { step: 1, user: U.midFlightApprover, action: "APPROVER_REMOVED", at: T(2, 9) },
        { step: 2, user: U.a1_proc_finance, action: "APPROVE", at: T(2, 14) },
        { step: 2, user: U.a1_proc_commApp, action: "APPROVE", at: T(2, 15) },
      ],
    });

    await instance({
      type: "TECHNICAL", entityId: te.id, policy: IDS.policies.A1_P1_TECHNICAL, status: "APPROVED", current: 1,
      created: T(7), completed: T(7, 16),
      steps: [{ order: 1, rule: "ANY", status: "APPROVED", completed: T(7, 16), approvers: [
        { user: U.a1_proc_techApp, status: "APPROVED", acted: T(7, 16) },
      ] }],
      actions: [{ step: 1, user: U.a1_proc_techApp, action: "APPROVE", at: T(7, 16) }],
    });

    await instance({
      type: "NEGOTIATION_QUOTE", entityId: p1.id, policy: IDS.policies.A1_P1_NEGOTIATION_QUOTE, status: "CANCELLED",
      current: 1, created: T(11), completed: T(11, 15), metadata: { rfq_product_id: p1.id },
      steps: [{ order: 1, rule: "ANY", status: "CANCELLED", approvers: [
        { user: U.a1_proc_commApp, status: "PENDING" },
      ] }],
      actions: [{ step: 1, user: buyer, action: "CANCELLED", comment: "superseded", at: T(11, 15) }],
    });
    await instance({
      type: "NEGOTIATION_QUOTE", entityId: p2.id, policy: IDS.policies.A1_P1_NEGOTIATION_QUOTE, status: "PENDING",
      current: 2, created: T(12), completed: null, metadata: { rfq_product_id: p2.id },
      steps: [
        { order: 1, rule: "ANY", status: "APPROVED", completed: T(12, 14), approvers: [
          { user: U.a1_proc_commApp, status: "APPROVED", acted: T(12, 14) },
          { user: U.a1_proc_techApp, status: "PENDING" },
        ] },
        { order: 2, rule: "ALL", status: "PENDING", approvers: [
          { user: buyer, status: "PENDING" },
          { user: U.a1_proc_finance, status: "APPROVED", acted: T(12, 16) },
          { user: U.midFlightApprover, status: "REMOVED", removed: "2026-09-12 17:00:00+00", reason: "user_deactivated" },
        ] },
      ],
      actions: [
        { step: 1, user: U.a1_proc_commApp, action: "APPROVE", at: T(12, 14) },
        { step: 2, user: U.a1_proc_finance, action: "APPROVE", at: T(12, 16) },
      ],
    });

    // Negotiation rounds.
    const round = async (productId, n, status, endDay) => {
      const r = await t.one(
        `INSERT INTO tbl_negotiation_rounds (rfq_id, round_number, target_price, end_date, status, created_by,
                                             rfq_product_id, vendor_ids, source_type, source_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RFQ',$1,$9,$9) RETURNING id`,
        [rfq_id, n, 90, T(endDay, 18), status, buyer, productId, vendors, T(endDay - 1)]);
      made.roundIds.push(r.id);
      for (const [v, price] of [[U.vendor_alpha, 95 - n], [U.vendor_beta, 110 - n]]) {
        await t.none(
          `INSERT INTO tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6)`, [r.id, v, productId, price, price + 5, T(endDay, 12)]);
      }
    };
    await round(p1.id, 1, "CLOSED", 9);
    await round(p2.id, 1, "CLOSED", 13);
    await round(p2.id, 2, "ACTIVE", 14);

    // Partial award: product 1 only.
    await t.none(
      `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, "timestamp", variant)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
      [rfq_id, rfq_no, quoteIds[U.vendor_alpha], pv1, U.vendor_alpha, buyer, T(15)]);

    const po = await t.one(
      `INSERT INTO tbl_rfq_purchase_order
         (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
          finalized_vendor_id, total_value, quote_id, initiated_by, created_at)
       VALUES ($1,$2,$3,'pending_approval',ARRAY[$4]::int[],10,100,$5,1000,ARRAY[$6]::int[],$7,$8) RETURNING id`,
      [rfq_id, IDS.companies.A, `PERF-PO-${rfq_id}`, p1.id, U.vendor_alpha, quoteIds[U.vendor_alpha], buyer, T(16)]);
    made.poIds.push(po.id);
    await t.none(
      `INSERT INTO tbl_purchase_order_product (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
       VALUES ($1,$2,$3,10,'units',100,1000)`, [po.id, p1.id, quoteIds[U.vendor_alpha]]);

    await instance({
      type: "PO", entityId: po.id, policy: IDS.policies.A1_P1_PO, status: "CANCELLED", current: 1,
      created: T(16, 11), completed: T(16, 12),
      steps: [{ order: 1, rule: "ANY", status: "CANCELLED", approvers: [{ user: U.a1_proc_poApp, status: "PENDING" }] }],
      actions: [{ step: 1, user: buyer, action: "CANCELLED", comment: "re-initiated", at: T(16, 12) }],
    });
    const livePo = await instance({
      type: "PO", entityId: po.id, policy: IDS.policies.A1_P1_PO, status: "PENDING", current: 1,
      created: T(16, 13), completed: null,
      steps: [{ order: 1, rule: "ANY", status: "PENDING", approvers: [
        { user: U.a1_proc_poApp, status: "PENDING" },
        { user: U.a1_proc_finance, status: "REMOVED", removed: "2026-09-16 14:00:00+00", reason: "role_removed" },
      ] }],
    });
    await t.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = $1 WHERE id = $2`, [livePo, po.id]);

    const del = await t.one(
      `INSERT INTO tbl_approval_delegations (delegator_user_id, delegate_user_id, starts_at, ends_at, reason, created_by)
       VALUES ($1, $2, '2026-01-01 00:00:00+00', '2099-01-01 00:00:00+00', 'Perf fixture cover', $3) RETURNING id`,
      [U.a1_proc_poApp, U.a1_proc_commApp, U.companyA_admin]);
    made.delegationIds.push(del.id);

    made.productIds = [p1.id, p2.id];
    made.techEvalId = te.id;
  });

  return made;
}

export async function cleanupRichRfq(made) {
  if (!made?.rfqId) return;
  const rfq = made.rfqId;
  const ids = made.instanceIds;
  await db.tx(async (t) => {
    if (made.delegationIds.length) {
      await t.none(`DELETE FROM tbl_approval_delegations WHERE id = ANY($1::int[])`, [made.delegationIds]);
    }
    if (ids.length) {
      await t.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [ids]);
      await t.none(
        `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
           (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [ids]);
      await t.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [ids]);
      await t.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE rfq_id = $1`, [rfq]);
      await t.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`, [ids]).catch(() => {});
      await t.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
    }
    await t.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1)`, [rfq]);
    await t.none(`DELETE FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id IN (SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1)`, [rfq]);
    await t.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors WHERE tbl_rfq_product_tech_evaluation_id IN (SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1)`, [rfq]);
    await t.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response WHERE tbl_rfq_product_tech_evaluation_clauses_id IN
         (SELECT c.id FROM tbl_rfq_product_tech_evaluation_clauses c
            JOIN tbl_rfq_product_tech_evaluation te ON te.id = c.tbl_rfq_product_tech_evaluation_id WHERE te.rfq_id = $1)`, [rfq]);
    await t.none(`DELETE FROM tbl_rfq_product_tech_evaluation_clauses WHERE tbl_rfq_product_tech_evaluation_id IN (SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1)`, [rfq]);
    await t.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_quote_items WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_quotes WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1`, [rfq]);
    await t.none(`DELETE FROM tbl_rfq WHERE id = $1`, [rfq]);
  });
}

// ── Snapshot normalisation ──────────────────────────────────────────────────
// Sequence-assigned ids differ run to run, so they are replaced by a token
// numbered in ORDER OF FIRST APPEARANCE within their key's namespace
// (`id`, `user_id`, `entity_id`, …). Two places that carried the same id still
// carry the same token, and a response that starts emitting a different id in
// some position changes the token sequence — so identity relationships are
// still asserted, only the absolute numbers are not. Fixture ids (users,
// hotels) are stable but tokenised too, for uniformity.
//
// Timestamp-looking strings are tokenised the same way (fixtures use fixed
// literals, but a few columns are DB-defaulted).
const ID_KEY = /(^id$|_id$|_ids$|^rfq_no$|^po_number$|_no$|^number$)/;
const TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

//
// `mask` names keys whose values depend on data OUTSIDE the fixture (e.g. a
// vendor's lifetime RFQ count, which other suites in the same shard can move);
// they are replaced by their type so the snapshot stays deterministic.
//
// `idKeyed` maps a key whose value is an object KEYED BY ids (e.g. the
// negotiation `vendors` map, keyed by rfq_product_id) to the id namespace its
// keys belong to; those keys are tokenised in that namespace.
export function normalizeForSnapshot(value, { mask = [], idKeyed = {} } = {}) {
  const masked = new Set(mask);
  const tables = new Map();
  const tok = (ns, v) => {
    if (!tables.has(ns)) tables.set(ns, new Map());
    const m = tables.get(ns);
    if (!m.has(v)) m.set(v, m.size + 1);
    return `<${ns}#${m.get(v)}>`;
  };
  // A bare `id` is namespaced by the key that holds its object (users[].id,
  // rfq.id, …): two DIFFERENT entities that merely share a sequence value in
  // one run would otherwise collapse into one token there and not in another.
  const walk = (v, key, owner) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key, owner));
    if (v && typeof v === "object" && key && idKeyed[key]) {
      const out = {};
      for (const k of Object.keys(v)) out[tok(idKeyed[key], String(k))] = walk(v[k], null, key);
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        out[k] = masked.has(k) ? `<masked:${v[k] === null ? "null" : typeof v[k]}>` : walk(v[k], k, key);
      }
      return out;
    }
    // Timestamps collapse to one token. Numbering them by distinct value (as ids
    // are) made the snapshot depend on whether two fixture writes landed in the
    // same millisecond — true on a fast laptop, false on a CI runner — which
    // renumbered every later token without any change in behaviour.
    if (typeof v === "string" && TS.test(v)) return "<ts>";
    if (key && ID_KEY.test(key) && (typeof v === "number" || (typeof v === "string" && /^\S+$/.test(v)))) {
      return tok(key === "id" ? `${owner || "root"}.id` : key, String(v));
    }
    return v;
  };
  return walk(value, null, null);
}
