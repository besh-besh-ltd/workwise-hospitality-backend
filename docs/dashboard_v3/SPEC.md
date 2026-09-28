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
