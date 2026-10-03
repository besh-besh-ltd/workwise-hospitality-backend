// FROZEN ORACLE — do not edit, do not import from production code.
//
// Verbatim copy of rfqController.getRfqListView as it stood on origin/main
// (719ba386), before the list-view split (portal perf plan 2026-10, item 1.3).
// It still calls the LIVE rfqModel.getAllBuyerRfq, which the split leaves
// untouched for its other callers, so this oracle also catches the two
// drifting apart: if someone changes getAllBuyerRfq's scope/visibility WHERE
// and not the list-view's slim query (or vice versa), the parity suite fails.
//
// Call it with a mock req/res; it writes the payload through res.json().

import rfqModel from "../../../app/models/rfqModel.js";
import { getPersonalPendingForRFQs } from "../../../app/models/rfq/rfqPendingPersonal.js";
import { logError } from "../../../app/helper/common.js";

const PENDING_KIND_ORDER = { approval: 0, response: 1, evaluation: 2 };

const legacy = {
  getRfqListView: async (req, res) => {
    const user_id = req.user.id;
    try {
      const body = req.body || {};
      // 'approval' = awaiting publish approval (status 3/4). It used to be
      // folded into 'drafts', which sent approvers into the edit wizard.
      const tab = ['all', 'pending', 'drafts', 'approval', 'ongoing', 'approved', 'closed'].includes(body.tab) ? body.tab : 'all';
      const search = (body.search || body.search_val || '').toString().trim() || null;
      const sort = ['recent', 'oldest', 'deadline'].includes(body.sort) ? body.sort : 'recent';
      const page = Number(body.page) > 0 ? Number(body.page) : 1;
      const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 100) : 20;
      const f = body.filters || {};
      const asStrArr = (v) => (Array.isArray(v) ? v.map(String) : []);
      // Accept an ISO calendar date "YYYY-MM-DD"; ignore anything else (never throw).
      const asISODate = (v) => {
        if (typeof v !== 'string') return null;
        const s = v.trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
      };
      const filters = {
        status: asStrArr(f.status), buId: asStrArr(f.buId), categoryId: asStrArr(f.categoryId),
        departmentId: asStrArr(f.departmentId), productId: asStrArr(f.productId), vendorId: asStrArr(f.vendorId),
        dateFrom: asISODate(f.dateFrom),
        dateTo: asISODate(f.dateTo),
      };
      const hotel_ids = Array.isArray(body.hotel_ids) ? body.hotel_ids : undefined;

      // 1. Fetch the buyer's scoped RFQs (RFQ-only). Big cap so faceting is
      //    complete; search is pushed to SQL.
      const FETCH_CAP = 1000;
      const all = await rfqModel.getAllBuyerRfq(FETCH_CAP, 0, user_id, null, 'DESC', null, null, search, 0, undefined, hotel_ids, true);
      const rows = Array.isArray(all) ? all : [];

      // 2. Lifecycle stage → bucket + normalized status key.
      let lifecycleMap = {};
      if (rows.length > 0) lifecycleMap = await rfqModel.computeLifecycleStages(rows.map((r) => parseInt(r.id)));
      const STAGE_BUCKET = {
        // NOT 'drafts'. A pending-approval RFQ is somebody's to-do, not the
        // creator's unfinished paperwork — the card must route to the detail
        // page where the approver can act, and must not offer Edit/Delete only.
        RFQ_APPROVAL: 'approval',
        AWAITING_QUOTES: 'ongoing', TECHNICAL_AWAITING_QUOTES: 'ongoing', TECHNICAL_EVALUATING: 'ongoing',
        TECHNICAL_APPROVING: 'ongoing', TECHNICAL_REJECTED: 'ongoing', RFQ_STUCK_TECHNICAL: 'ongoing',
        RFQ_STUCK_COMMERCIAL: 'ongoing', COMMERCIAL_EVALUATION: 'ongoing', NEGOTIATION_ONGOING: 'ongoing',
        QUOTATION_APPROVAL: 'ongoing', AWAITING_PO: 'ongoing', PO_APPROVAL: 'ongoing', PO_VENDOR_REJECTED: 'ongoing',
        APPROVED_COMPLETED: 'approved',
      };
      const statusKey = (r) => {
        const s = Number(r.status);
        if (s === 2) return 'CLOSED';
        if (s === 5) return 'WITHDRAWN';
        if (s === 0) return 'DRAFT';
        // status 0 is unused in practice — a saved draft is an unpublished RFQ
        // (is_published = 0) that isn't awaiting publish approval (status 3/4).
        if (Number(r.is_published) === 0 && s !== 3 && s !== 4) return 'DRAFT';
        if (r.lifecycle_stage) return r.lifecycle_stage;
        if (s === 3 || s === 4) return 'RFQ_APPROVAL';
        return 'AWAITING_QUOTES';
      };
      const bucketOf = (r) => {
        const s = Number(r.status);
        if (s === 2) return 'closed';
        if (s === 0 || s === 5) return 'drafts';
        // status 3 = PENDING_APPROVAL, 4 = READY_TO_PUBLISH. Both are
        // is_published = 0, so this MUST be tested before the is_published
        // short-circuit below — otherwise an RFQ an approver has to act on is
        // filed as one of the creator's drafts (the P0 this fixes).
        if (s === 3 || s === 4) return 'approval';
        // Not yet published (and not closed / not awaiting approval) → a real
        // draft: an unpublished status-1 RFQ.
        if (Number(r.is_published) === 0) return 'drafts';
        const stage = r.lifecycle_stage;
        if (stage && STAGE_BUCKET[stage]) return STAGE_BUCKET[stage];
        if (r.po_completed) return 'approved';
        return 'ongoing';
      };
      for (const r of rows) {
        r.lifecycle_stage = lifecycleMap[parseInt(r.id)] || null;
        r._bucket = bucketOf(r);
        r._statusKey = statusKey(r);
      }

      // Action holders for ALL scoped rows — powers the per-row lifecycle
      // tooltip and the approval/evaluation halves of "Pending for me". The
      // helper batches its approval + RBAC queries, so it stays bounded.
      let actionMap = {};
      if (rows.length > 0) {
        try { actionMap = await rfqModel.getActionHoldersForRFQs(rows, lifecycleMap); } catch (e) { logError('getRfqListView action holders', e); }
      }

      // Per-caller personal work: open clarifications, unread vendor queries,
      // stuck RFQs, expired negotiation rounds. None of these notify today, so
      // this listing is the only surface that can show them.
      let personalMap = {};
      if (rows.length > 0) {
        try { personalMap = await getPersonalPendingForRFQs(rows, user_id, lifecycleMap); } catch (e) { logError('getRfqListView personal pending', e); }
      }

      for (const r of rows) {
        const holders = actionMap[parseInt(r.id)];
        const users = holders?.users || [];
        const inHolders = users.some((u) => Number(u.id) === Number(user_id));
        const holderKind = holders?.kind || (holders?.type === 'approval' ? 'approval' : 'evaluation');

        // One row joins exactly ONE group, by precedence, but carries every
        // reason so the card can show the rest as secondary chips.
        const reasons = [];
        if (inHolders && holderKind === 'approval') {
          reasons.push({
            kind: 'approval',
            code: r.lifecycle_stage || 'RFQ_APPROVAL',
            label: 'Your approval',
            count: 1,
            instance_id: holders.instance_id ?? null,
            step_id: holders.step_id ?? null,
            entity_type: holders.entity_type || null,
            decision_rule: holders.decision_rule || null,
          });
        }
        for (const p of (personalMap[parseInt(r.id)] || [])) {
          reasons.push({ kind: 'response', code: p.code, label: p.label, count: p.count ?? 1 });
        }
        if (inHolders && holderKind === 'evaluation') {
          reasons.push({
            kind: 'evaluation',
            code: r.lifecycle_stage || null,
            label: holders.label || 'Your evaluation',
            count: 1,
          });
        }
        reasons.sort((a, b) => PENDING_KIND_ORDER[a.kind] - PENDING_KIND_ORDER[b.kind]);

        r._pendingReasons = reasons;
        r._pendingKind = reasons.length ? reasons[0].kind : null;
        r._isMyAction = reasons.length > 0;

        // Approval affordances for the card. `can_approve` is narrower than
        // `_isMyAction`: it is true only when the pending action is an APPROVAL
        // this user is a pending approver on (not, say, a tech-eval task).
        r._canApprove = holders?.type === 'approval' && inHolders;
        r._approvalInstanceId = holders?.type === 'approval' ? (holders.instance_id ?? null) : null;
        r._approvalStepId = holders?.type === 'approval' ? (holders.step_id ?? null) : null;
        r._approvalEntityType = holders?.type === 'approval' ? (holders.entity_type || null) : null;
      }

      // Safe array accessors for the json columns.
      const parseArr = (v) => {
        if (Array.isArray(v)) return v;
        if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
        return [];
      };
      const dedupe = (arr, keyFn) => { const seen = new Set(); const out = []; for (const x of arr) { const k = keyFn(x); if (k && !seen.has(k)) { seen.add(k); out.push(x); } } return out; };
      const productPairs = (r) => dedupe(parseArr(r.products).map((p) => ({
        id: String(p.product_id ?? p.id ?? ''),
        name: (Array.isArray(p.product_details) && p.product_details[0] && p.product_details[0].name) || `Product ${p.product_id ?? p.id ?? ''}`,
      })), (p) => p.id);
      const vendorPairs = (r) => {
        const out = [];
        for (const p of parseArr(r.products)) for (const v of parseArr(p.vendor_details)) {
          const id = String(v.user_id ?? v.id ?? '');
          const name = (v.user_details && v.user_details.name) || '';
          if (id) out.push({ id, name: name || `Vendor ${id}` });
        }
        return dedupe(out, (v) => v.id);
      };
      const categoryPairs = (r) => dedupe(parseArr(r.categories).map((c) => ({ id: String(c.id), title: c.title })), (c) => c.id);

      // 3. tab counts (full scoped+search set).
      const tab_counts = { all: rows.length, pending: 0, drafts: 0, approval: 0, ongoing: 0, approved: 0, closed: 0 };
      const pending_breakdown = { approval: 0, evaluation: 0, response: 0 };
      for (const r of rows) {
        tab_counts[r._bucket] = (tab_counts[r._bucket] || 0) + 1;
        if (r._isMyAction) {
          tab_counts.pending++;
          pending_breakdown[r._pendingKind] = (pending_breakdown[r._pendingKind] || 0) + 1;
        }
      }
      tab_counts.pending_breakdown = pending_breakdown;

      // 4. tab scope. "pending" cuts across buckets — every row needing my action.
      const tabRows = tab === 'all' ? rows
        : tab === 'pending' ? rows.filter((r) => r._isMyAction)
        : rows.filter((r) => r._bucket === tab);

      // 5. facets over the tab scope (not narrowed by facet selections).
      const fm = { status: new Map(), buId: new Map(), categoryId: new Map(), departmentId: new Map(), productId: new Map(), vendorId: new Map() };
      const bump = (m, key, label) => { const e = m.get(key) || { key, label: label || null, count: 0 }; e.count++; if (label && !e.label) e.label = label; m.set(key, e); };
      for (const r of tabRows) {
        bump(fm.status, r._statusKey, null);
        if (r.hotel_id != null) bump(fm.buId, String(r.hotel_id), r.hotel_name || `Hotel ${r.hotel_id}`);
        if (r.department_id != null) bump(fm.departmentId, String(r.department_id), r.department_title || `Dept ${r.department_id}`);
        for (const c of categoryPairs(r)) bump(fm.categoryId, c.id, c.title);
        for (const p of productPairs(r)) bump(fm.productId, p.id, p.name);
        for (const v of vendorPairs(r)) bump(fm.vendorId, v.id, v.name);
      }
      const toFacet = (m) => Array.from(m.values()).sort((a, b) => b.count - a.count);
      const facets = {
        status: toFacet(fm.status), buId: toFacet(fm.buId), categoryId: toFacet(fm.categoryId),
        departmentId: toFacet(fm.departmentId), productId: toFacet(fm.productId), vendorId: toFacet(fm.vendorId),
      };

      // FY / custom-range window (epoch ms). Inclusive of both calendar days.
      const fromMs = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
      const toMs = filters.dateTo ? (new Date(`${filters.dateTo}T00:00:00`).getTime() + 86400000) : null; // exclusive upper

      // 6. apply facet selections (OR within a facet, AND across facets).
      const filtered = tabRows.filter((r) => {
        if (filters.status.length && !filters.status.includes(r._statusKey)) return false;
        if (filters.buId.length && !filters.buId.includes(String(r.hotel_id))) return false;
        if (filters.departmentId.length && !filters.departmentId.includes(String(r.department_id))) return false;
        if (filters.categoryId.length && !categoryPairs(r).some((c) => filters.categoryId.includes(c.id))) return false;
        if (filters.productId.length && !productPairs(r).some((p) => filters.productId.includes(p.id))) return false;
        if (filters.vendorId.length && !vendorPairs(r).some((v) => filters.vendorId.includes(v.id))) return false;
        // FY / custom creation-date window (server-authoritative; AND with other facets).
        if (fromMs != null || toMs != null) {
          const c = new Date(r.timestamp || 0).getTime();
          if (fromMs != null && c < fromMs) return false;
          if (toMs != null && c >= toMs) return false;
        }
        return true;
      });

      // 7. sort.
      const ts = (r) => new Date(r.timestamp || 0).getTime();
      const dl = (r) => new Date(r.bid_end_date || 0).getTime();
      if (sort === 'oldest') filtered.sort((a, b) => ts(a) - ts(b));
      else if (sort === 'deadline') filtered.sort((a, b) => (dl(a) || Infinity) - (dl(b) || Infinity));
      else filtered.sort((a, b) => ts(b) - ts(a));

      // The pending tab groups by kind, so page 1 always leads with the
      // decisions. Within a group the requested sort above is preserved
      // (Array#sort is stable in V8) — this partitions, it does not re-sort.
      if (tab === 'pending') {
        filtered.sort((a, b) => (PENDING_KIND_ORDER[a._pendingKind] ?? 9) - (PENDING_KIND_ORDER[b._pendingKind] ?? 9));
      }

      // 8. paginate.
      const total = filtered.length;
      const start = (page - 1) * limit;
      const pageRows = filtered.slice(start, start + limit);

      // 8b. Why an RFQ went backwards. A rejected PO de-finalizes its products
      // and returns the RFQ to commercial evaluation; without this the card
      // just shows an earlier stage with different people on it. RFQ 536263
      // went PO Approval -> Commercial Evaluation that way and the client read
      // it as their approval matrix changing. One batch for the page, latest
      // live rejection per RFQ. Never fatal: a card without the marker still
      // renders correctly.
      const poRejectionMap = {};
      try {
        const rejections = await rfqModel.getLivePoRejectionsForRfqs(pageRows.map((r) => r.id));
        for (const row of rejections) {
          const key = Number(row.rfq_id);
          const entry = poRejectionMap[key] || (poRejectionMap[key] = { latest: null, poNumbers: new Set() });
          entry.poNumbers.add(row.po_number);
          // Rows arrive newest first, so the first one seen is the latest.
          if (!entry.latest) entry.latest = row;
        }
      } catch (rejErr) {
        logError('getRfqListView: could not load PO rejections for the page', rejErr);
      }
      const poRejectionFor = (id) => {
        const entry = poRejectionMap[Number(id)];
        if (!entry?.latest) return null;
        const r = entry.latest;
        return {
          po_number: r.po_number,
          rejection_type: r.rejection_type,
          rejected_by_name: r.rejected_by_name,
          rejected_at: r.rejected_at,
          rejection_reason: r.rejection_reason,
          rejected_po_count: entry.poNumbers.size,
        };
      };

      // 9. trim to the display payload (action holders already computed above).
      const data = pageRows.map((r) => ({
        id: r.id, rfq_no: r.rfq_no, title: r.title, status: r.status, is_published: r.is_published,
        is_tender: r.is_tender, rfq_type: r.rfq_type, reverse_auction: r.reverse_auction,
        lifecycle_stage: r.lifecycle_stage, bucket: r._bucket, status_key: r._statusKey,
        hotel_id: r.hotel_id, hotel_name: r.hotel_name, department_id: r.department_id, department_title: r.department_title,
        categories: categoryPairs(r), products: productPairs(r), vendors: vendorPairs(r),
        project_name: r.project_name, contact_name: r.contact_name, created_by: r.created_by,
        timestamp: r.timestamp, bid_end_date: r.bid_end_date,
        invited_count: parseArr(r.vendors)[0] ? (parseArr(r.vendors)[0].total_vendors ?? 0) : 0,
        submitted_count: parseArr(r.vendors)[0] ? (parseArr(r.vendors)[0].quote_received ?? 0) : 0,
        unseen_query_count: r.unseen_query_count ?? 0,
        is_finalized: r.is_finalized, po_completed: r.po_completed, can_edit: r.can_edit,
        // Fields canEditRfq() needs so the client can gate the Edit button.
        is_quotes_present: r.is_quotes_present, has_dead_end_product: r.has_dead_end_product,
        has_tech_stuck_product: r.has_tech_stuck_product,
        has_tech_unstartable_product: r.has_tech_unstartable_product,
        action_holders: actionMap[parseInt(r.id)] || null,
        // Approval affordances — let the card render Approve/Review and deep
        // link to the pending instance instead of falling back to Edit/Delete.
        can_approve: !!r._canApprove,
        is_pending_for_me: !!r._isMyAction,
        // Which of the three "Pending for me" groups this row joins, and the
        // reasons that put it there (the non-primary ones render as secondary
        // chips on the card).
        pending_kind: r._pendingKind ?? null,
        pending_reasons: r._pendingReasons || [],
        approval_instance_id: r._approvalInstanceId ?? null,
        approval_step_id: r._approvalStepId ?? null,
        approval_entity_type: r._approvalEntityType ?? null,
        po_rejection: poRejectionFor(r.id),
      }));

      return res.status(200).json({ status: 1, data: { rows: data, facets, tab_counts, total, page, limit } });
    } catch (error) {
      logError('getRfqListView error', error);
      return res.status(200).json({ status: 3, message: 'Error fetching RFQ listing' });
    }
  }
};

export const getRfqListViewLegacy = legacy.getRfqListView;
