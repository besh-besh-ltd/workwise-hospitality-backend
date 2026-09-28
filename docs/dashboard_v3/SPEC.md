# Buyer Dashboard V3 — launch spec

Status: IN PROGRESS (branch `feat/dashboard-v3` in backend + frontend).
Source: read-only review of origin/main + prod (hospitality_main) on 2026-09-28.
This file is the single contract between backend and frontend work. When a
response shape changes, update the **API contract** section in the same commit.

## Decisions (agreed 2026-09-28)

| # | Decision |
|---|---|
| D1 | **Spend = committed POs only**, same definition as Reports 1.1 (`SPEND_STATUSES` + IST window in `reportsModel.js`). Dashboard, Reports and the PO dashboard spend totals must reconcile for the same scope + window. |
| D2 | **Savings headline = awarded (realised) savings.** All-vendor savings is a secondary figure. |
| D3 | **Spend analytics audience = parity with today** (every buyer role that sees the legacy dashboard). Admins can narrow later through role permissions; the server-side guard makes that real. |
| D4 | **v1 widget cuts/merges** — see catalogue below. |
| D5 | **Rollout switch = per-buyer-company runtime flag** `tbl_company.buyer_dashboard_v3` (default false). No build flag. Legacy layout stays as the kill switch. |
| D6 | All phases ship together (single release), stage first, then prod. |

## Cross-cutting rules (every endpoint)

1. **Date window is half-open and IST.** `start_date`/`end_date` are IST calendar dates
   (`YYYY-MM-DD`). Window = `[start 00:00 IST, (end + 1 day) 00:00 IST)`. Use the shared
   helper; never `BETWEEN $a AND $b` on a date string. The helper must know each column's
   storage frame (timestamptz vs naive-UTC vs naive-IST) — verify per column against schema.
   Missing dates ⇒ no window (all time). "All" in the FE sends no `start_date`.
2. **Queues are never date-filtered.** Anything that is a to-do (pending approvals, drafts,
   evals pending, quotes ready, closing soon) ignores the date range.
3. **One predicate per concept**, in the shared module, reused everywhere:
   spend base, awarded savings, my-pending-approvals (same semantics as
   `generalModel` pending-approval counts: NULL hotel allowed, step PENDING, dead negotiation
   rounds excluded, counts **distinct actionable items**), live negotiation round
   (statuses that exist in prod: ACTIVE / PENDING_APPROVAL are live; ENDED, EXPIRED,
   CANCELLED, COMPLETED are not), RFQ bid-open, regret quote (₹0 / regret flag excluded from
   price stats), leaf category (Reports `LEAF_CATEGORY_JOIN`).
4. **Lists return a true `count`** (COUNT(*) / window) alongside a capped `items` list.
5. **Scope is resolved once per request** (materialised allowed tuples), not a correlated
   EXISTS per row. Semantics identical to `buildScopeExistsClause`; `dashboard.scope` tests
   must stay green. Budget: ≤ 50 ms server time per widget query on prod-sized data.
6. **Approval entity ids** (prod truth): `NEGOTIATION_QUOTE.entity_id = tbl_rfq_products.id`;
   `TECHNICAL.entity_id = negotiation/tech round id`, RFQ in `metadata->>'rfq_id'`;
   `PO.entity_id = tbl_purchase_order.id`; `RFQ.entity_id = tbl_rfq.id`. Test fixtures must
   use these shapes.
7. Security unchanged or stronger: scope derived from `req.user` only; `hotel_ids` narrows only.

## Widget catalogue v1

Permission codes are `dashboard.<code>`. Titles are user-facing.

| Code | Title | Persona | Notes |
|---|---|---|---|
| action_center | Action centre | cross | queues undated |
| procurement_snapshot | Procurement snapshot | cross | "Active RFQs" = bid window open; committed spend |
| negotiation_savings | Negotiation savings | cross | awarded headline |
| cost_intelligence | Price benchmarking | cross | like-for-like variant+spec, excl. regrets/rejected, gaps = null |
| category_insights | Spend by category | cross | leaf category |
| abc_analysis | ABC analysis | cross | value only (volume removed) |
| workflow_efficiency | Stage turnaround | cross | median + P90 + n, excl. cancelled/rejected |
| smart_insights | Insights | cross | every CTA an allow-listed real route; not "AI" |
| my_drafts | My drafts | rfq_creator | |
| my_active_rfqs | My active RFQs | rfq_creator | stage from lifecycle logic |
| my_no_response_rfqs | My RFQs with no response | rfq_creator | |
| my_rfqs_bid_closed_no_quotes | My RFQs closed without quotes | rfq_creator | regret-only counts as no quote |
| my_tech_evals_pending | Technical evaluations pending | tech_evaluator | actionable only (published, bid closed, not closed/PO'd) |
| tech_evals_with_vendor_disagreements | Vendor disagreements | tech_evaluator | `'I Dont Agree'` |
| my_tech_approvals_pending | Technical approvals awaiting me | tech_approver | absorbs "oldest pending" |
| my_quote_compares | Ready for quote comparison | commercial_evaluator | live-round predicate; bid closed |
| my_active_negotiations | My active negotiations | commercial_evaluator | |
| savings_pipeline | Savings pipeline | commercial_evaluator | honours date filter |
| my_commercial_approvals_pending | Negotiated quotes awaiting me | commercial_approver | entity NEGOTIATION_QUOTE |
| my_award_approvals_pending | POs awaiting my approval | awarding | entity PO |
| recent_awards | Recently approved POs | awarding | |
| award_value_pipeline | PO value by stage | awarding | honours date filter |
| **my_rfq_approvals_pending** (new) | RFQs awaiting my approval | rfq_approver | entity RFQ |
| **approval_turnaround** (new) | Approval turnaround | approver | tabs: tech eval / tech approval / quote approval / PO approval; step-relative; median + P90 + n |

Cut in v1 (registry entries + permission rows removed; enum values stay):
`tech_approval_oldest_pending`, `deals_with_price_anomalies`, `tech_eval_throughput`,
`tech_approval_throughput`, `commercial_approval_throughput`.

## Access & rollout

- Seed migration grants widgets by **capability**, not role id (ids differ stage vs prod):
  a role gets a widget when it holds the capability permission(s) listed in the migration.
  Verification query: every user with a PENDING approval step of type T holds the matching
  approval widget after the seed.
- Server guard `requireDashboardWidget(code)` on every widget route: when the caller's
  buyer company has `buyer_dashboard_v3 = false` → pass (legacy); else require the grant in
  the caller's role scopes. Banner + `/config` are unguarded; modals map to `action_center`.
- `GET /dashboard-v2/config` → `{ status:1, data:{ v3_enabled:boolean } }`.
- Enable: `UPDATE tbl_company SET buyer_dashboard_v3 = true WHERE id = <buyer company>`.
  Kill: set false. Pilot company 90, then 13.

## API contract changes

(Append per endpoint as implemented: field added/renamed/removed, and FE consumer.)

### Cross-role cards + banner + drill-downs (BE-FOUNDATION, backend `feat/dashboard-v3`)

All endpoints: `start_date` / `end_date` are IST calendar days, half-open, each
optional (omit `start_date` for "All"); malformed → unbounded, inverted → swapped.
The FE should stop sending `_refresh` and `duration_type` (ignored).

| Endpoint | Change | FE consumer |
|---|---|---|
| `action-center` | **Undated** (all tiles are queues). `pending_approvals` = distinct actionable items; **+`pending_approval_instances`**. `rfqs_awaiting` = published, open, no *real* (non-regret) quote. `rfqs_ending_soon` = bid still open and closes ≤72h (exact IST). `pos_awaiting` undated. `rejected_vendors` = POs (not lines) rejected by vendor with a line still un-replaced; **+`rejected_in_approval`** (status `rejected`, same rule). | ActionCenter |
| `no-response` | Undated. `is_expired` at exact IST time. Items **+`regret_count`**; `invited_vendor_count` = distinct vendors. | NoResponseModal |
| `pending-approvals` | Undated; accepts `hotel_ids` (same predicate as the badge ⇒ `length === pending_approvals`). One row per actionable item: **+`item_key`, `instance_count`, `rfq_id`, `po_id`, `po_number`**. `rfq_ref_id` kept (= `rfq_id`, now correct per SPEC rule 6). | PendingApprovalsModal |
| `rejected-pos` | Undated; honours `hotel_ids`; one row per PO. **+`po_number`, `rejection_source` ('vendor'\|'approval'), `rejection_reason`**; `po_value` summed per PO. `vendor_company` from tbl_company (organization_name dropped). `rejected_at` = vendor action time or last update. Length = `rejected_vendors + rejected_in_approval`. | RejectedPOsModal |
| `procurement-snapshot` | Committed spend (D1). `active_rfqs` = published, open, **bid window open**; **+`in_progress_rfqs`** (published, open, bid closed). `total_rfqs`, `closed_rfqs` = created in window. `pos_issued` = committed POs in window. **+`turnaround_days: {median, p90, n}`** (per RFQ, publish → first finalisation, RFQs first finalised in window); `avg_turnaround` = per-RFQ mean (compat — show the median). | ProcurementSnapshot, SpendBreakupModal |
| `negotiation-savings` | **Headline = awarded** (D2): `total_savings`, `market_baseline`, `negotiated_total`, `negotiation_count` are the awarded basis; **+`basis:'awarded'`, `savings_pct`, `rfq_count`, `all_vendors:{total_savings, market_baseline, negotiated_total, negotiation_count}`**. `awarded` kept (= headline). **Removed:** `top_category_saving`, `cost_avoidance`. Values SIGNED (negative = ended above baseline). | NegotiationSavings |
| `cost-intelligence` | Paid-vs-paid. `benchmark.current_price` = latest **paid** unit price in window (was avg of quotes); **+`benchmark.spec_variation`, `benchmark.basis:'paid_vs_paid'`**. `price_trend.*` gaps are **`null`** (use `spanGaps`), bucketed on IST days/months, never past today; regret (₹0) lines excluded. `top_products` only items with priced quotes in window. `vendor_comparison[]` **+`vendor_id`, `quote_count`**. Empty state: `top_products: []`, `benchmark: null`. `duration_type` ignored (granularity from span). | CostIntelligence |
| `category-insights` | Committed spend, leaf category. **+`total_spend`**; buckets **+`po_count`**; `rfq_count` = distinct RFQs. "Others" row has `rfq_count/po_count: null` and **+`bucket_count`**. | CategoryInsights |
| `abc-analysis` | **Value only.** `metric` param ignored, always `'value'`. **Removed:** `total_volume`, `items[].volume`, `classes[].volume`. | ABCAnalysis (drop the volume toggle) |
| `workflow-efficiency` | Stages ordered; each **+`samples`, `instant_count`, `median_hours`, `p90_hours`**; `rfq_count` = distinct RFQs (was instances); `avg_dwell_time_hours` = mean (compat — show median). Cohort = RFQs created in window. | WorkflowEfficiency |
| `smart-insights` | **No `action_url`.** Each insight: `{type, severity, title, description (plain text, no HTML), details:[{label,value}], action_label, action:{type, params}}`. `action.type` ∈ `rfqList` (`{search}`), `poList` (`{search}`), `reports` (`{}`). Types: `benchmark_alert`, `price_alert`, `vendor_optimization`, `spend_trend`. | SmartInsights (resolve via dashboardLinks; render details, not innerHTML) |
| `buyer-status-banner` | All `counts` **undated** queues. `pending_approvals` distinct items (= Action Centre). `closed_no_quotes` = my published open RFQs, bid closed, no real quote (= no-response `expired`, restricted to mine). `quote_compare_ready` requires bid closed and no live round (`PENDING_APPROVAL`/`ACTIVE`). **+`period: {rfqs_published, savings_pct, savings_basis:'awarded', windowed}`** — the only windowed part (last 7 days when no range). `weekly` kept as a deprecated alias. | BuyerStatusBanner |

### Deviations / notes (BE-FOUNDATION)

- **Like-for-like price benchmark is not derivable.** `tbl_rfq_products.variant` is a
  per-RFQ index (RFQ 776 variant 0 = ₹29,500; RFQ 901 variant 0 = ₹22,550 for the same
  catalogue item), and specs are free text with typos. The benchmark therefore compares
  per catalogue variant and flags `spec_variation` when more than one spec text (quantity
  excluded) exists in scope; Smart Insights raises no benchmark alarm for such items.
- **GST breakup** stays line-derived from `charges_meta` (the PO header has no tax total),
  identical to the PO-detail roll-up; only the PO population changed (committed).
- **ARC call-off POs** are included in spend, scoped through their contract at the
  requisitioning hotel (same rule as `poScope`). Prod has 0 today.
- **Rejected POs / no-response are undated** (not "accept dates") so the list always
  equals its tile.
- **Unit-rate negotiation prices** are normalised inside
  `negotiationModel.getNegotiationParentSavings` (26/728 prod prices). This also changes the
  negotiation module's own totals for those pairs — intentionally, the two stay equal.
- **Reports window fix** (`reportsModel.js`): `'<date>' AT TIME ZONE 'Asia/Kolkata'` resolved
  the date through the session zone first; on prod (UTC) every Reports boundary sat at
  11:00 IST. Fixed to `::date::timestamp AT TIME ZONE`, so Reports and the dashboard reconcile.
- **Found, not fixed (Reports):** `tbl_purchase_order_product.product_variant_id` is NULL on
  all 2,460 prod RFQ lines, and Reports' category/vendor-category reports join the variant
  only through that column — so their category breakdowns are empty on prod. The dashboard
  resolves the variant via `rfq_product` (`dashboardMetrics.lineVariant`).

### Performance (prod, read-only, user 180 — 24 hotels, FYTD)

| | Before | After |
|---|---|---|
| Server exec time, all captured dashboard statements (31 functions) | 6,158 ms | 570 ms (scope change only) |
| Slowest single statement | 133 ms (scope subplan ×800 loops) | 11.7 ms |
| Cross-role cards + banner + drill-downs (12 functions), server exec | — | 93 ms total |
| Same 12 fired in parallel from a laptop (incl. ~26 ms RTT each) | — | 531 ms wall |

Cause fixed: the RBAC scope clause is now an InitPlan over the caller's scope tuples
(`dashboardMetrics.scopeTuplesFilter`) instead of a correlated role→permission join per row.

## Link contract

Frontend module `components/dashboard/shared/dashboardLinks.js` (frontend branch
`feat/dashboard-v3-links`, commit 6875fb00) is the ONLY place a dashboard widget builds a
URL. `dashboardLinks.test.js` fails CI if a builder URL has no page file or emits a param no
page reads. There is no `/dashboard/buyer/approval` page — never emit it.

| Destination | Builder | URL | Target behaviour (verified) |
|---|---|---|---|
| RFQ detail | `rfqDetail(id, {stage, focus})` | `/dashboard/buyer/rfq-management-details?id=9&stage=technical` | ViewRFQ honours `stage` (overview, technical, negotiation-award, purchase-order) and `focus=approval` (scrolls to decision card) |
| Resume draft | `resumeDraft(id)` | `/dashboard/buyer/rfq-management-edit?draft_id=9` | CreateRFQ loads the draft |
| RFQ list | `rfqList({tab,status,bu,search,sort})` | `/dashboard/buyer/rfq-management?tab=pending&status=RFQ_APPROVAL` | server-side list-view filters; any deep link clears the FY default |
| Named RFQ views | `rfqListView(view)` | draft, awaiting_approval, my_rfq_approvals, no_response, closing_soon, bid_closed_no_quotes, ended_no_quotes, tech_evaluation, my_tech_evaluations, tech_approval, my_tech_approvals, quote_compare, negotiation, quote_approval, my_quote_approvals, awarded, po_approval, completed, closed, pending_for_me | presets of the above |
| Stage label → list | `rfqListForStage(stage)` | legacy persona names (awaiting_approval, bidding, quote_compare, negotiation, awarded…) or raw lifecycle keys (`NEGOTIATION_ONGOING`) | status facet |
| Tech eval | `techEval({rfqId, rfqProductId})` | `/dashboard/buyer/technical-evaluation?rfq_id=9&prod_id=4` | opens RFQ, auto-expands product (`product_id` also accepted) |
| Quote compare | `quoteCompare(rfqId, {rfqProductId})` | `/dashboard/buyer/quote-compare?rfq=9` | opens RFQ |
| Negotiation for RFQ | `negotiationForRfq(rfqId)` | `/dashboard/buyer/negotiation/9` | level-2 page, every round |
| Negotiation list | `negotiationList({tab, needsMyApproval, search})` | `/dashboard/buyer/negotiation?needs_my_approval=1` | toggle + tab + search applied |
| Round approval | `negotiationRoundApproval(rfqId)` | `/dashboard/buyer/negotiation/9/approve` | ApproveRoundPage |
| PO detail | `poDetail(poId)` | `/dashboard/buyer/purchase-orders/77` | PODetail — approvers approve/reject here |
| PO list | `poList({status, search})` | `/dashboard/buyer/purchase-orders?status=action-required` | status ∈ all, action-required, draft, approved, rejected |
| PO tracking | `poTracking({tab, search})` | `/dashboard/buyer/purchase-orders/tracking?tab=awaiting-grn` | tab ∈ active, awaiting-grn, payment, completed, all |
| ARC | `arcContract(id, {stage, tab})` | `/dashboard/buyer/rate-contracts/5?stage=active&tab=amendments` | stage tabs |
| MR | `materialRequisition(id)` | `/dashboard/buyer/material-requisitions/3` | |
| Reports | `reports()` | `/dashboard/buyer/reports` | |
| Act on one approval | `approvalHref(entityType, {rfqId, poId, arcId, mrId, entityId})` | RFQ/TENDER → detail overview; TECHNICAL → detail technical; NEGOTIATION_QUOTE → detail negotiation-award; PO → PO detail; NEGOTIATION → round approve page; ARC_* → contract stage; MR → MR | `focus=approval` everywhere on RFQ detail |
| My approvals of a type | `approvalQueue(entityType)` | RFQ → `rfq-management?tab=pending&status=RFQ_APPROVAL`; TECHNICAL → `…status=TECHNICAL_APPROVING`; NEGOTIATION_QUOTE → `…status=QUOTATION_APPROVAL`; NEGOTIATION → `negotiation?needs_my_approval=1`; PO → `purchase-orders?status=action-required` | |

### Payload requirements for the backend (so links can be built)

1. Approval widget items MUST carry the RFQ id resolved per SPEC rule 6
   (`rfq_id` from `metadata->>'rfq_id'` for TECHNICAL, via `tbl_rfq_products` for
   NEGOTIATION_QUOTE), `po_id` for PO, `arc_id` for ARC types, plus `entity_type`.
   `approvalHref` never guesses an RFQ id from `entity_id` for TECHNICAL / NEGOTIATION_QUOTE.
2. Tech-eval items MUST carry `rfq_id` and the **rfq_product_id** (`tbl_rfq_products.id`)
   as `rfq_product_id` — the page matches on that, not the catalogue product id.
3. Stage keys returned by persona endpoints should be lifecycle status keys
   (`RfqListPage` STATUS_META / `computeLifecycleStages`); legacy names still map.
4. Smart Insights must not emit URLs. Emit `{ action: { type, params } }` where type
   is one of the builder names above (e.g. `{type:"rfqList", params:{search:"<product>"}}`,
   `{type:"reports"}`), and the FE resolves it through dashboardLinks.

### Backend gaps discovered (not blocking; "View all" is scope-wide until added)

- RFQ list-view has no "created by me" filter, so "My drafts / My active RFQs" View-all
  shows every RFQ in the caller's scope for that tab/status. Add `filters.mine=true`
  (`created_by = req.user.id`) to `POST /rfq/list-view` and a `mine` param to the builder.
- `sort=deadline` sorts ascending on `bid_end_date` without excluding past deadlines; fine
  while `AWAITING_QUOTES` implies an open bid window — confirm in `computeLifecycleStages`,
  otherwise add a `bid_open` filter for the closing-soon view.
- Negotiation list-view has no per-RFQ filter (only free-text search on title/number);
  per-RFQ links therefore go to the level-2 page `negotiation/<rfqId>` instead.
