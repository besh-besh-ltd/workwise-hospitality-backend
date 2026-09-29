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

Implemented (BE-ROLLOUT, backend `feat/dashboard-v3`):

- **Catalogue** — migration `20260928100000_dashboard_v3_widget_catalogue`: registers the 24
  v1 codes (adds `my_rfq_approvals_pending`, `approval_turnaround`), removes the 5 cut codes'
  grants + permission rows (grants backed up in `tbl_dashboard_v3_cut_grants` for the down
  migration), orders the codes persona by persona. `GET /rbac/permissions` lists a
  resource's actions in `ordering` order, so the role editor receives them grouped.
- **Switch** — migration `20260928101000_company_buyer_dashboard_v3_flag`:
  `tbl_company.buyer_dashboard_v3 boolean NOT NULL DEFAULT false`. The app treats a missing
  column as off, so the code may deploy before the migration.
- **Default grants** — migration `20260928102000_dashboard_v3_seed_grants`, by capability
  (never role id), recorded in `tbl_dashboard_seed_grants` so the down migration removes
  exactly them:

  | Widgets | Granted to roles holding |
  |---|---|
  | 8 cross-role cards | any procurement permission (rfq, tender, te, quote-compare, po, commercial, negotiation, awarding, boq, arc, arc-tech, arc-comm, arc-committee, mr) — D3 parity |
  | my_drafts, my_active_rfqs, my_no_response_rfqs, my_rfqs_bid_closed_no_quotes | `rfq.create` |
  | my_tech_evals_pending, tech_evals_with_vendor_disagreements | `te.create` / `te.update` |
  | my_tech_approvals_pending | `te.approve` |
  | my_quote_compares, my_active_negotiations, savings_pipeline | `quote-compare.create` / `negotiation.create` |
  | my_commercial_approvals_pending (NEGOTIATION_QUOTE) | `negotiation.approve` / `quote-compare.approve` |
  | my_award_approvals_pending (PO) | `awarding.approve` |
  | recent_awards, award_value_pipeline | `awarding.approve` / `awarding.create` |
  | my_rfq_approvals_pending | `rfq.approve` / `tender.approve` / `boq.approve` |
  | approval_turnaround | any of the approve capabilities above |
  | everything | `company.admin` |

  Predicted on prod (read-only dry run 2026-09-28, 234 active mapped buyers):

  | Widget | Roles | Active users |
  |---|---|---|
  | 8 cross-role cards | 31 | 232 |
  | RFQ-creator widgets (4) | 4 | 38 |
  | tech-eval widgets (2) | 4 | 166 |
  | my_tech_approvals_pending | 4 | 69 |
  | my_quote_compares / my_active_negotiations / savings_pipeline | 4 | 46 |
  | my_commercial_approvals_pending | 5 | 69 |
  | my_award_approvals_pending | 8 | 11 |
  | recent_awards / award_value_pipeline | 10 | 39 |
  | my_rfq_approvals_pending | 5 | 135 |
  | approval_turnaround | 13 | 164 |

  Approver coverage (users with a PENDING step, or who acted in the last 120 days):
  PO 9/9, TECHNICAL 21/21, NEGOTIATION_QUOTE 69/69, **RFQ 55/59** — users 157, 206, 503,
  504 are named on USER-source RFQ policy steps without holding `rfq/tender/boq.approve`;
  their RFQ approvals still show in the Action Centre and banner. Fix by giving them the
  Tender Approver role if product wants the widget. **Zero widgets: users 384 and 261**
  (active buyers holding no role at all — they see nothing anywhere today either).
- **Guard** — `app/middleware/dashboardWidgetGuard.js`, folded into the routes file's shared
  signed-in middleware: company switch off → pass; on → the route's code (map
  `WIDGET_ROUTE_CODES`) must be granted in the caller's role scopes for the BUs in view
  (`resolveUserScope` hotel set, `getUserPermissionsForHotels` union). Unmapped routes are
  refused while the switch is on. `/config` and `/buyer-status-banner` are open to every
  buyer; drill-downs (`/pending-approvals`, `/rejected-pos`, `/no-response`) follow
  `action_center`. Vendors → controller 403; super admin (user_type 8) passes. Legacy
  admins (user_type 7) with no role scopes see nothing under V3 — give them Company
  Administrator.
- **Config** — `GET /dashboard-v2/config` → `{ status:1, data:{ v3_enabled, admin_contact_email? } }`.
  Email only when V3 is on: an active `company.admin` holder of the company, else a legacy
  user_type-7 admin of the company, else omitted. Vendors 403; buyers without hospitality
  access get `v3_enabled:false`.

## API contract changes

(Append per endpoint as implemented: field added/renamed/removed, and FE consumer.)

### Rollout endpoints and guard (BE-ROLLOUT, backend `feat/dashboard-v3`)

| Endpoint | Change | FE consumer |
|---|---|---|
| `GET /dashboard-v2/config` (new) | `{ status:1, data:{ v3_enabled:boolean, admin_contact_email?:string } }`; vendors 403 | `index.js` layout switch, `EmptyDashboard` contact link |
| every widget route | `403 { status:0, message }` when the company switch is on and the widget is not granted for the BUs in view | widget error state (should not happen: FE only renders granted widgets) |
| `GET /rbac/permissions` | `dashboard` actions ordered by catalogue `ordering` (persona order); v1 codes only | admin role editor |
| `POST /rbac/me/permissions/bulk {key:'dashboard'}` | returns `my_rfq_approvals_pending`, `approval_turnaround`; never the 5 cut codes | `useDashboardWidgets` |

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
| `smart-insights` | **No `action_url`.** Each insight: `{type, severity, title, description (plain text, no HTML), details:[{label,value}], action_label, action:{type, params}}`. `action.type` ∈ `poDetail` (`{poId}` — benchmark_alert: the in-window PO that tripped it, label "Open latest PO"), `quoteCompare` (`{rfqId}` — price_alert: the RFQ carrying the item's latest in-window quote, label "Review quotes"), `poList` (`{search}`), `reports` (`{}`). `rfqList {search}` is no longer emitted: the list search matches RFQ titles/numbers only, so a product-name search landed on 0 rows. Types: `benchmark_alert`, `price_alert`, `vendor_optimization`, `spend_trend`. | SmartInsights (resolve via dashboardLinks; render details, not innerHTML) |
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

### Persona widgets (BE-PERSONA, backend `feat/dashboard-v3-persona`)

Routes (all `GET /api/v1/dashboard-v2/…`, query `hotel_ids`, `start_date`, `end_date`).
**Queues ignore the date range; period widgets (marked ⏱) honour it.** Every list
returns a TRUE `count` next to `items` capped at 20.

Removed routes (catalogue v1 cuts): `tech-eval-throughput`, `tech-approval-oldest-pending`,
`tech-approval-throughput`, `deals-with-price-anomalies`, `commercial-approval-throughput`.

| Route | Response `data` |
|---|---|
| `my-drafts` | `{count, oldest_created_at, items:[{id, rfq_no, title, product_count, created_at}]}` — draft = `is_published=0 AND status NOT IN (2,3,4,5)`, i.e. status 3/4 (awaiting publish approval) is NOT a draft. `oldest_updated_at`/`updated_at` renamed (it was the creation time). |
| `my-active-rfqs` | `{total, stages:[{stage, label, count, oldest_age_days}]}` — `stage` is the **lifecycle key** from `rfqModel.computeLifecycleStages` (`RFQ_APPROVAL`, `AWAITING_QUOTES`, `TECHNICAL_AWAITING_QUOTES`, `TECHNICAL_EVALUATING`, `TECHNICAL_APPROVING`, `TECHNICAL_REJECTED`, `RFQ_STUCK_TECHNICAL`, `RFQ_STUCK_COMMERCIAL`, `COMMERCIAL_EVALUATION`, `NEGOTIATION_ONGOING`, `QUOTATION_APPROVAL`, `AWAITING_PO`, `PO_APPROVAL`, `PO_VENDOR_REJECTED`), label = the listing's STATUS_META label, ordered by lifecycle. Completed RFQs excluded. |
| `my-no-response-rfqs` | `{count, silent_vendor_count, items:[{id, rfq_no, title, bid_end_date, silent_vendor_count, total_vendor_count}]}` — bid still open (exact IST); a regret IS a response. Ordered closing-soonest first. |
| `my-rfqs-bid-closed-no-quotes` | `{count, items:[{id, rfq_no, title, bid_end_date, days_overdue, regret_count}]}` — status 1 only; no REAL quote (regret-only included). |
| `my-tech-evals-pending` | `{count, oldest_waiting_since, items:[{id, rfq_id, rfq_product_id, rfq_no, rfq_title, product_name, opened_at, waiting_since}]}` — actionable only: published + open, bid closed, a real quote, no live PO on the product, no PENDING TECHNICAL approval for it. `waiting_since` = bid close (IST text). `product_id` removed → `rfq_product_id`. Shared queue (title must not say "My"). |
| `tech-evals-with-disagreements` | `{count, total_disagreement_clauses, items:[{id, rfq_id, rfq_product_id, rfq_no, rfq_title, product_name, disagreeing_vendor_count, disagreeing_clause_count}]}` — matches `I Dont Agree` / `I do not agree` / `disagree` (normalised), open RFQs only. |
| `my-tech-approvals-pending` | approval queue, `TECHNICAL` (see shape below). Absorbs "oldest pending". |
| `my-rfq-approvals-pending` (new) | approval queue, `RFQ` + `TENDER`. |
| `my-commercial-approvals-pending` | approval queue **with `total_value`**, `NEGOTIATION_QUOTE` ("Negotiated quotes awaiting me"). `top_by_value` removed. |
| `my-award-approvals-pending` | approval queue **with `total_value`**, `PO` ("POs awaiting my approval"). |
| `approval-turnaround` ⏱ (new) | `{window:{start_date,end_date}, tabs:[{key, label, n, median_hours, p90_hours, instant_count}]}`, keys in order `tech_eval`, `tech_approval`, `quote_approval`, `po_approval`, `rfq_approval` (always all five; empty → `n:0`, nulls). Approvals: my APPROVED/REJECTED decisions, from the step reaching me to my action. `tech_eval`: my first TECHNICAL submission per product, measured from bid close. `instant_count` = decided within a minute. |
| `my-quote-compares` | `{count, items:[{id, rfq_no, title, vendor_count, bid_closed_at}]}` — exactly the RFQs whose lifecycle stage is `COMMERCIAL_EVALUATION` (the listing's "Commercial Evaluation" facet). `vendor_count` = real (non-regret) quoting vendors. `entered_qc_at` → `bid_closed_at`. |
| `my-active-negotiations` | `{count, awaiting_approval_count, total_silent_vendors, items:[{id, rfq_id, rfq_no, rfq_title, round_number, round_status, round_end_date, invited_vendor_count, silent_vendor_count}]}` — my rounds that are `ACTIVE` with the window open, or `PENDING_APPROVAL` (`silent_vendor_count: null`). ACTIVE first. |
| `savings-pipeline` ⏱ | `{basis:'awarded', total_savings, prior_period_savings, negotiation_count, avg_savings_pct, all_vendors_savings, window, prior_window}` — negotiations I led (earliest non-cancelled round is mine) that CONCLUDED in the window (no live round; concluded = last round's close). Prior window = the same length immediately before; "All" (no start) → `prior_period_savings: null`, `prior_window: null`. |
| `recent-awards` ⏱ | `{count, total_value, window, items:[{po_id, po_number, rfq_id, rfq_no, rfq_title, vendor_name, value, status, approved_at, approved_by_me}]}` — POs in my scope whose PO approval completed in the window (default last 30 days). |
| `award-value-pipeline` ⏱ | `{committed_value, committed_po_count, pending_value, pending_po_count, stages:[{key, label, value, po_count}]}` — POs raised in the window; `stages` keys `in_approval`, `awaiting_acceptance`, `approved`, `in_fulfilment` (sent/dispatched/GRN/invoice_raised), `completed`, `rejected`; drafts + cancelled excluded. `completed_value`/`ongoing_value` removed. |

**Approval queue shape** (the four approval routes):
`{count, [total_value], oldest_waiting_since, oldest_age_days, items:[{approval_id, item_key, entity_type, instance_count, rfq_id, rfq_no, rfq_title, rfq_product_ids:[], product_names:[], po_id, po_number, vendor_names:[], value, submitted_at, waiting_since, age_days, submitted_by_name, hotel_name}]}`.
Same predicate + item key as `pending-approvals` / the Action Centre badge ⇒ each queue's
`count` equals its entity types' rows in `pending-approvals` (tested). One item per
actionable decision (TECHNICAL / NEGOTIATION_QUOTE collapse to the RFQ). `value` = PO
`total_value` or the NEGOTIATION_QUOTE `po_payload.total_value`, latest instance per
product/PO (never summed across re-submissions). `waiting_since` = when the current step
reached me. Oldest first. Link with `approvalHref(entity_type, {rfqId: rfq_id, poId: po_id})`.

`POST /rfq/list-view` **+`filters.mine`** (`true`/`'true'`): only RFQs created by the JWT
user; tab counts and facets computed over that set. Use it for My-drafts / My-active
"View all". `POST /negotiation/list-view` already had `filters.rfqId` — no change needed.

### Deviations / notes (BE-PERSONA)

- **Queues vs periods.** Drafts, active RFQs, no-response, closed-without-quotes, tech evals,
  disagreements, quote compares, live negotiations and all approval queues are undated
  (SPEC rule 2); only the four ⏱ widgets take the header range.
- **Own RFQs with a NULL company.** Early drafts carry `hospitality_company_id` NULL (4 of
  users 322/392's 12 drafts on prod). The four creator widgets accept that for the caller's
  own RFQs; the hotel-mapping predicate still bounds the tenant.
- **Recent awards / PO value by stage are business-unit views** (RBAC-scoped), not "mine";
  `approved_by_me` flags my own approvals. ARC call-off POs (`rfq_id` NULL) are not included
  here (0 on prod); the spend cards include them.
- **Prod data finding — RFQ approvals.** 288 of 290 PENDING RFQ approvals sit on RFQs that are
  already published, so the shared predicate (and the approve page) treat them as not
  actionable: user 177 has 80 PENDING rows and an empty "RFQs awaiting my approval". These
  are stale instances for the approval-shape clean-up, not a widget bug.

### Prod verification (read-only, 2026-09-28) — widget vs independent SQL

Independent SQL = hand-written counts without the shared helpers (script
`/tmp/dashperf/persona.mjs`).

| User | Widget | Widget | Independent / drill-down |
|---|---|---|---|
| 157 (heavy NQ approver, 50 instances) | Negotiated quotes awaiting me | 3 items, ₹1,20,547.88 (RFQ 536435 = 26 instances, ₹94,379) | 3 / 3 drill-down rows; old widget: 50 blank ₹0 rows |
| 157 | Tech evals pending / quote compares | 1 / 5 | — |
| 177 (80 PENDING RFQ approvals) | RFQs awaiting my approval | 0 | 0 (all 80 on published RFQs) |
| 177 | Tech evals pending / disagreements / quote compares | 12 / 3 / 11 | old: 212-row queue, disagreements always 0 |
| 177 | Recently approved POs (30 d) | 17, ₹2.19 Cr | — |
| 322 (narrow scope) | Drafts / closed without quotes / active | 3 / 5 / 20 | 3 / 5 / — |
| 322 | Active stages | RFQ_APPROVAL 2 · AWAITING_QUOTES 1 · RFQ_STUCK_COMMERCIAL 5 · COMMERCIAL_EVALUATION 11 · AWAITING_PO 1 | — |
| 392 | Drafts (incl. one created today) / closed without quotes | 9 / 2 | 9 / 2 |

Every approval item resolved to an RFQ (0 blank rows across the four queues for all four users).

Timing (prod, user 180, 24 hotels, laptop incl. ~26 ms RTT): every persona function 26–68 ms;
all 16 in parallel 427 ms.

### Test-round fixes (FIX-BE-2, 2026-09-29)

- **Recently approved POs = committed spend.** Committed-status POs (D1
  `SPEND_STATUSES`) with lines, whose internal approval completed in the window.
  A PO approved internally but awaiting vendor acceptance, or later rejected by
  the vendor, is not listed. It is a subset of committed spend (a PO committed
  without an approval instance has no approval date); on prod every committed PO
  has one, so for user 125 FYTD it equals the pipeline's committed value exactly
  (427 POs, ₹30,28,65,918.79). Pinned by a reconciliation test.
- **Ready for quote comparison excludes tenders** (`is_tender = 1`): tenders are
  compared in ARC and the RFQ list its View-all opens excludes them.
- **Spend-trend insight** is suppressed unless the previous period of equal
  length holds at least 10% of the current period's committed spend (no more
  "+926.8%" against months before the client used the platform).
- **Benchmark insight wording**: "best price ever paid" / `Best paid (all time)`.
  The Price benchmarking card's own labels are frontend strings.
- **New list filter** `POST /rfq/list-view` `filters.vendor_disagreement` (boolean;
  `true`/`'true'`/`1`/`'1'`): RFQs with an incomplete technical evaluation that
  has at least one disagreeing vendor response — `dashboardMetrics.hasOpenVendorDisagreement`,
  the same predicate as the Vendor disagreements card. Applied in SQL before the
  1,000-row cap, under the list's normal scope. The FE links the card's View-all
  to `rfq-management?disagreements=1`, which RfqListPage forwards as this filter.

| Change | Prod before | Prod after | Results |
|---|---|---|---|
| Leaf-category join (dashboard + Reports), user 125 FYTD spend-by-category | 581 ms | 40 ms | identical (md5); 0 of 12,499 products pick a different category |
| PO value by stage | 111 ms | 8 ms | identical |
| Recently approved POs | 97 ms | 14 ms | identical rows |
| jwtUsr claim decrypt | ~55 ms blocked per authenticated request | once per token | auth decisions unchanged |

**Data note (not changed): RFQ hotel vs hotel mapping.** 10 prod RFQs carry
`tbl_rfq.hotel_id = 30` but are mapped (`tbl_rfq_hotel_mappings`) only to hotel 4.
The dashboard scopes by the mapping and the RFQ list scopes by `hotel_id`, so for
these RFQs a card and its View-all can differ by one business unit. Ids (rfq_no):
144 (535700), 145 (535701), 147 (535703), 148 (535704), 150 (535706),
155 (535711), 163 (535719), 167 (535723), 169 (535725), 175 (535731).
For a later data fix once product confirms which hotel is right.

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

### Backend gaps discovered (status)

- ~~RFQ list-view has no "created by me" filter~~ — DONE: `filters.mine` (BE-PERSONA).
  The FE builder still needs a `mine` param that the list page forwards.
- `sort=deadline` sorts ascending on `bid_end_date` without excluding past deadlines; fine
  while `AWAITING_QUOTES` implies an open bid window — confirm in `computeLifecycleStages`,
  otherwise add a `bid_open` filter for the closing-soon view.
- Negotiation list-view: `filters.rfqId` already exists server-side; per-RFQ links going to the
  level-2 page `negotiation/<rfqId>` is fine and needs no change.

## RUNBOOK — release, pilot, rollback

Order is **DB first**: every migration is idempotent and the application tolerates the
switch column being absent, so migrations can run before or after the deploy — but grants
must exist before any company is switched on.

1. **Backup** (prod): `caffeinate -i pg_dump -Fc … hospitality_main > ~/workwise-db-backups/hospitality_main-preDashboardV3-<ts>.dump`, verify the TOC.
2. **Apply, in order** (stage first, then prod), each with `psql -v ON_ERROR_STOP=1 -f`:
   1. `migrations/20260928100000_dashboard_v3_widget_catalogue.sql`
   2. `migrations/20260928101000_company_buyer_dashboard_v3_flag.sql`
   3. `migrations/20260928102000_dashboard_v3_seed_grants.sql`
   4. `migrations/20260929100000_po_line_variant_backfill.sql` — Reports fix (see below).
      Independent of 1–3; deploy the code first or together — the fixed reads work
      with or without it, the backfill only makes the stored column complete.

   Record each in the ledger: `INSERT INTO pgmigrations (name, run_on) VALUES ('<file name without .sql>', now());`
3. **Verify** (read-only):
   ```sql
   -- catalogue: 24 rows, none of the cut codes
   SELECT count(*) FROM tbl_permissions WHERE resource::text = 'dashboard';
   SELECT action FROM tbl_permissions WHERE resource::text = 'dashboard'
    AND action::text IN ('tech_approval_oldest_pending','deals_with_price_anomalies',
      'tech_eval_throughput','tech_approval_throughput','commercial_approval_throughput'); -- 0 rows
   -- switch exists and is off everywhere
   SELECT id, company_name, buyer_dashboard_v3 FROM tbl_company WHERE buyer_dashboard_v3;  -- 0 rows
   -- seeded grants (prod dry run: 31 roles hold the cross-role cards)
   SELECT p.action, count(*) roles FROM tbl_role_permissions rp
     JOIN tbl_permissions p ON p.id = rp.permission_id
    WHERE p.resource::text = 'dashboard' GROUP BY 1 ORDER BY 1;
   SELECT count(*) FROM tbl_dashboard_seed_grants;
   -- active buyers with no widget at all (prod dry run: 384, 261)
   SELECT u.id FROM tbl_users u WHERE u.user_type = 2 AND u.status = 1
     AND EXISTS (SELECT 1 FROM tbl_hospitality_user_mappings m WHERE m.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM tbl_user_role_scopes s JOIN tbl_role_permissions rp ON rp.role_id = s.role_id
                     JOIN tbl_permissions p ON p.id = rp.permission_id
                     WHERE s.user_id = u.id AND p.resource::text = 'dashboard');
   ```
4. **Deploy** backend then frontend. Nothing changes for users yet — every company is off.
5. **Pilot**: `UPDATE tbl_company SET buyer_dashboard_v3 = true WHERE id = 90;` (9 users).
   Smoke: log in as one user per persona, check `GET /dashboard-v2/config` → `v3_enabled:true`,
   expected widgets render, a widget not granted returns 403. Watch logs for
   `[dashboardWidgetGuard]` errors. After the pilot week: `… WHERE id = 13;` (253 users).
6. **Kill switch** (instant, no deploy): `UPDATE tbl_company SET buyer_dashboard_v3 = false WHERE id = <id>;`
   Users get the legacy layout on their next page load; grants are inert while off.
7. **Full rollback** (only if the grants/catalogue themselves are wrong), in reverse:
   `20260928102000_…seed_grants.down.sql`, `20260928101000_…flag.down.sql`,
   `20260928100000_…widget_catalogue.down.sql`, and delete their `pgmigrations` rows. The
   seed down removes exactly the rows it inserted; the catalogue down restores the five cut
   widgets with any grants they had.

## Reports category fix (fix/reports-category-variant)

`tbl_purchase_order_product.product_variant_id` was written only by the ARC
call-off path, so all 2,387 RFQ PO lines on prod carried NULL and every Reports
sheet that reached an item through the line was empty (1.1 category sheet, 1.2,
1.3 rate variance, 1.4 primary category, 2.2). Fixed three ways:

- **Reads** — `reportsModel.lineVariant()` + `LINE_VARIANT_JOIN` resolve a line
  through its rfq_product (call-off lines keep their own); the dashboard
  re-exports the same definition.
- **Writes** — `draftPurchaseOrder` stores the variant from the rfq_product on
  both inserts (new PO, merge onto a draft).
- **Backfill** — `20260929100000_po_line_variant_backfill.sql`, ledgered in
  `tbl_po_line_variant_backfill`; down clears exactly those rows.

Prod dry run (read-only, 2026-09-29): 2,387 lines would be set, 575 POs,
1,171 variants, 0 ambiguous. User 125 FYTD after the fix: spend ₹30,28,65,918.79
= category (10 parents / 68 leaves) = category×vendor (215 rows); rate variance
57 rows; single-source 500 (capped); primary category on 158/158 vendors —
all previously 0.

Verify after applying:
```sql
SELECT count(*) FILTER (WHERE product_variant_id IS NULL) AS still_null, count(*) AS lines
  FROM tbl_purchase_order_product;                        -- still_null = 0 on prod
SELECT count(*) FROM tbl_po_line_variant_backfill;         -- 2,387 (+ any lines drafted before deploy)
```
Rollback: `20260929100000_po_line_variant_backfill.down.sql` (the read fix keeps
Reports correct either way).

