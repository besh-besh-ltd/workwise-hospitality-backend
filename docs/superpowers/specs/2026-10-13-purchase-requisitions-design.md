# Purchase Requisitions (PR): Design Spec

**Date:** 2026-10-13 · **Status:** Approved by product (2026-10-13), building
**Research:** `hospitality/docs/investigations/2026-10-12-pr-research/01-platforms.md` (SAP Ariba / S/4HANA, Oracle Fusion, Coupa, Workday, Dynamics 365, Zip, Procurify…), `02-hospitality-and-data.md` (hotel SOPs, APQC / Hackett / Ardent benchmarks, Companies Act IFC).
**Branches:** BE `feat/purchase-requisitions` off `feat/vendor-networks` (→ qa after VN merges); FE `feat/purchase-requisitions` off `feat/vendor-networks` (→ main); admin-panel `feat/purchase-requisitions` off its current branch.

**Decisions confirmed with product (2026-10-13):**
1. A PR line may be a **catalog item or free text**. RFQs stay **catalog-only**. The buyer maps a free-text line to a catalog variant while converting it to an RFQ. If no variant exists, the line goes to the platform team as a **catalog request** and waits as *Awaiting catalog*.
2. **Technical review is category-driven.** A company admin maps categories to a *reviewing department*. When a PR contains lines in a mapped category, that department's technical reviewers review those lines *before* the approval chain. Reviewers can edit specs, add technical clauses and attachments, or send the PR back. Different categories are reviewed in parallel.

---

## 1. Why: the evidence

| Evidence | Source |
|---|---|
| About 26 of the 46 people who created RFQs in the last 12 months sit in **Purchase**, yet RFQs are filed for Engineering (332), Projects (303), IT (105) and Housekeeping (91). Purchase keys in other departments' demand. | prod, read-only, 2026-10-12 |
| 246 active buyer logins across 15 departments. Requesters already have accounts. | prod |
| 21% of RFQ lines (1,195 of 5,704) re-request the same variant in the same company within 30 days; 130 of those come from another hotel. | prod |
| All 12,625 catalog products created in the last 12 months were added by the platform team. Buyers have no way to add or request a product. | prod |
| Universal model across 5+ platforms: work is **line-level**; approved lines wait in a **buyer pool**; a buyer **merges** lines from many PRs into one RFQ; cancelled or unawarded quantity **returns to the pool**; each RFQ line traces back to its PR lines. | 01-platforms §synthesis |
| "Return for rework" is distinct from Reject. Approvers are view-only. Workday-style *Review* steps can edit. | 01-platforms |
| Hotels: technical review depends on category (Chief Engineer, Exec Chef). The approval chain is value-based (HOD → Controller → GM → corporate) and its thresholds differ by client. Auditors expect separation of duties (requester ≠ approver) and an edit trail. | 02-hospitality §A, §C |
| APQC median PR→PO time is about 2 days (top quartile about 1 day). The bigger problem is how much it varies, not the average. | 02-hospitality §B |
| Gaps no vendor documents: a buyer-queue SLA/ageing view, a requester↔buyer conversation on the PR, and duplicate-demand hints. | 01-platforms (c) |

## 2. Goals

1. A requester (any department) can raise a PR without involving Purchase, and can always see **who holds it now and what happens next**.
2. Technical input is captured **on the PR**, by the right department, before money is approved.
3. Approval is **value-aware, auditable and fail-closed**. A PR is never approved by its requester, and never approved because a step silently resolved to nobody.
4. The purchase team gets **one queue** of approved demand across PRs. They can merge lines into an RFQ when they see fit, and the result lands in the **existing RFQ wizard**.
5. Contracted items are routed to **MR**, not PR (guided buying).
6. Status after conversion (in sourcing → ordered, or returned to the pool) is **derived from the RFQ and PO tables**, so it can never drift.

### Non-goals (v1)
- Budget / GL commitment checks. We have no budget data.
- Splitting one PR line across several RFQs (a line converts whole).
- Cross-hotel consolidation into one RFQ. RFQs are per hotel, so a conversion is limited to one hotel. Group buying goes through Group ARC.
- Quote-before-PR (Ariba tactical sourcing) and RFQ-during-approval (D365).
- Market lists (daily perishables) and store issues. These are not PRs.
- Free-text lines on RFQs.
- Routing approval chains by PR type. Type is informational in v1.

## 3. Vocabulary & roles

| Term | Meaning |
|---|---|
| **PR** | Header: hotel, department, title, justification, need-by date, urgency, type (`goods`/`service`/`capex`). |
| **PR line** | One requested item: a catalog variant **or** a free-text description with a category; quantity, unit, estimated unit price, specification. |
| **Review group** | The set of a PR's lines whose category maps to one reviewing department. Gets one review task. |
| **Pool** | Approved, not-yet-sourced lines visible to buyers of that hotel. |
| **Conversion** | A buyer turns selected pool lines (same hotel) into one RFQ draft. |
| **Catalog request** | A request to the platform team to add a product for an unmapped free-text line. |

New RBAC resource **`pr`**. Actions (the existing `permission_action_type` enum plus one new value, `convert`):

| Permission | Who | Seeded system role |
|---|---|---|
| `pr.create` + `pr.read` | Raise PRs for a hotel × department | **PR Requester** |
| `pr.evaluate` + `pr.read` | Technical review in the reviewing department | **PR Technical Reviewer** |
| `pr.approve` + `pr.read` | Be resolved as an approver (`ROLE` steps) | **PR Approver** |
| `pr.convert` + `pr.read` | Buyer pool, map lines, convert, close lines | **PR Buyer** |
| all of the above | | Company Administrator |

Scopes use `tbl_user_role_scopes` (company × hotel × department × process). PR rows carry `process_id` (always NULL in v1) so that `buildScopeExistsClause` works unchanged.

## 4. Lifecycle

### 4.1 Header status (stored)

```
draft ──submit──▶ in_review ──all reviews complete──▶ pending_approval ──approved──▶ approved
  ▲  │                │  │                               │   │
  │  └─cancel──▶ cancelled                                │   └─reject──▶ rejected (terminal)
  │                   │  └─send back (reviewer)──▶ returned ◀─send back (approver)
  └──withdraw─────────┴──────────────────────────────────┘        │
                                                                  ├─resubmit (revision+1) ──▶ in_review / pending_approval
                                                                  └─cancel──▶ cancelled
```

- **submit:** draft/returned → `in_review` if there is at least one review group, else `pending_approval`. Every submission is a new **revision**, and reviews and approval always restart from scratch (the "re-approval on change" model, in its safest form).
- **withdraw** (requester, from `in_review`/`pending_approval`): cancels open reviews and the approval instance, then returns to `draft`.
- **send back** (reviewer or current-step approver, note required): cancels the instance and open reviews, then `returned`.
- **cancel** (requester, from `draft`/`returned`): terminal.
- **approved:** every active line enters the pool.
- Every transition is guarded by `SELECT … FOR UPDATE` on the PR row plus an expected-status check. A wrong state returns **409 `PR_STATE_CONFLICT`**.

### 4.2 Line state

Stored: `status ∈ {active, cancelled, closed}`, plus `mapped_variant_id` and catalog-request state. **Progress is derived** by one SQL function, `prLineProgressSql` in `prModel`, which is the single source of truth for lists, detail, pool and KPIs:

| Derived progress | Condition (first match wins) |
|---|---|
| `cancelled` / `closed` | stored status |
| `pending` | PR header not `approved` |
| `ordered` | a **live link** to an RFQ product that has a live PO (`po.status NOT IN ('rejected','rejected_by_vendor','cancelled','draft')`, the canonical `livePoForProduct`) |
| `in_sourcing` | a live link whose RFQ is not closed (`status <> 2`; a withdrawn publish request, status 5, is revivable and keeps its lines) |
| `awaiting_catalog` | free-text, unmapped, with an open catalog request |
| `needs_mapping` | free-text, unmapped, no open request |
| `in_pool` | otherwise |

A **live link** is a `tbl_pr_line_rfq` row whose RFQ product still exists (FK `ON DELETE CASCADE`, so deleting a draft releases the line automatically) and whose RFQ has `status <> 2`, **or** which has a live PO. (Ruling R24, 2026-10-14: status 5 = publish request withdrawn returns the RFQ to the creator's drafts, so it must not release lines.) Consequences, all with no hooks in RFQ/PO code:
- RFQ draft deleted → line returns to `in_pool`.
- RFQ closed without a PO for this product → `in_pool` (an unawarded line returns to the pool). A withdrawn publish request (status 5) keeps the line `in_sourcing`.
- PO cancelled or rejected and the RFQ already closed → `in_pool`.
- RFQ approval rejected → the RFQ returns to draft → still `in_sourcing`.

A derived **header label** for approved PRs is shown in the UI: *In purchase queue*, *Partly in sourcing*, *In sourcing*, *Partly ordered*, *Ordered*, *Completed* (all lines ordered or closed or cancelled).

## 5. Data model (new tables; migrations are idempotent and have `.down.sql`)

```
tbl_purchase_requisition
  id, pr_number UNIQUE ('PR-YYYY-<base36>'), title, pr_type CHECK (goods|service|capex),
  hospitality_company_id NOT NULL, hotel_id NOT NULL, department_id NOT NULL, process_id NULL,
  urgency CHECK (low|normal|urgent), required_by_date DATE NOT NULL, justification TEXT NOT NULL,
  delivery_location TEXT, status CHECK (draft|in_review|pending_approval|returned|approved|rejected|cancelled),
  revision INT NOT NULL DEFAULT 0, estimated_total NUMERIC(18,2) (server-computed at submit),
  raised_by NOT NULL, submitted_at, approved_at, approval_instance_id,
  assigned_buyer_id NULL, assigned_at, returned_note, cancelled_reason,
  created_at, updated_at

tbl_purchase_requisition_line
  id, pr_id FK CASCADE, line_no, line_kind CHECK (catalog|free_text),
  product_variant_id NULL (required iff catalog), free_text_name NULL (required iff free_text),
  category_id NOT NULL (catalog: derived from the product server-side; free text: chosen),
  quantity NUMERIC(18,3) CHECK > 0, uom VARCHAR NOT NULL, estimated_unit_price NUMERIC(18,2) CHECK > 0,
  specification TEXT, suggested_vendor_note TEXT,
  status CHECK (active|cancelled|closed) DEFAULT active, close_reason, closed_by, closed_at,
  mapped_variant_id NULL, mapped_by, mapped_at,
  created_at, updated_at

tbl_pr_line_clause      (id, pr_line_id FK CASCADE, clause_text, clause_type, weightage, added_by, created_at)
tbl_pr_attachment       (id, pr_id FK CASCADE, pr_line_id NULL FK CASCADE, kind CHECK (spec|datasheet|qap|other),
                         file_url, file_name, uploaded_by, created_at)
tbl_pr_review_category_map (id, hospitality_company_id, category_id, department_id, created_by, created_at,
                            UNIQUE (hospitality_company_id, category_id))
tbl_pr_review           (id, pr_id FK CASCADE, revision, department_id, status CHECK (pending|completed|sent_back|superseded),
                         acted_by, acted_at, note, self_reviewed BOOL, created_at,
                         UNIQUE (pr_id, revision, department_id))
tbl_pr_review_line      (review_id FK CASCADE, pr_line_id FK CASCADE, PRIMARY KEY (review_id, pr_line_id))
tbl_pr_line_rfq         (id, pr_line_id FK CASCADE, rfq_id FK → tbl_rfq CASCADE, rfq_product_id FK → tbl_rfq_products CASCADE,
                         quantity, converted_by, created_at)
tbl_pr_catalog_request  (id, hospitality_company_id, pr_line_id FK CASCADE, requested_name, description, category_id,
                         status CHECK (open|fulfilled|rejected), requested_by, requested_at,
                         resolved_by, resolved_at, resolution_note, resolved_variant_id)
                         partial UNIQUE (pr_line_id) WHERE status='open'
tbl_pr_comment          (id, pr_id FK CASCADE, author_id, body TEXT CHECK length 1..4000, created_at)
tbl_pr_event            (id, pr_id FK CASCADE, pr_line_id NULL, revision, actor_id, event_type, payload JSONB, created_at)
                         append-only audit trail: every transition, every reviewer field edit (before/after),
                         mapping, conversion, close, catalog request
tbl_approval_policy_steps + min_amount NUMERIC(18,2) NULL   (ignored for every entity type except PR)
```

Money is stored as `NUMERIC`, never float. `estimated_total = Σ round(qty × estimated_unit_price, 2)` over active lines, **computed by the server** at submit. Client totals are display-only.

## 6. Technical review

1. **Routing:** for each active line, take its category (catalog: `tbl_product_categories` of the variant's product; free text: the chosen category). Find a mapping row for that category, else for its parent. Unmapped lines need no review.
2. On submit, for each distinct reviewing department, create a `tbl_pr_review(pending)` with its lines.
   - **Reviewers** are users holding `pr.evaluate` scoped to (company, PR hotel, *reviewing* department).
   - **Fail-closed:** if a group resolves to **no reviewer at all**, the submit is refused (**422 `PR_NO_REVIEWER`**, naming the department).
   - If the requester is themselves an eligible reviewer (for example, the Chief Engineer raising an engineering PR), the group is still created and they may complete it. The event is recorded as `self_reviewed` and shown on the chain. This is technical input, not financial approval; separation of duties is enforced at approval (§7).
3. **Reviewer powers** (for lines in their group only, while `in_review`): edit `specification`, add and remove technical clauses and attachments. They **cannot** change item, quantity, unit or price. Every edit writes a `tbl_pr_event` with before/after.
4. **Complete review** (optional note) → `completed`. When all of a revision's reviews are completed, the PR moves to `pending_approval` and the approval instance is created, in the same transaction.
5. **Send back** (note required): this review becomes `sent_back`, other pending reviews of the revision become `superseded`, and the PR becomes `returned`.
6. Reviews are listed at `/dashboard/buyer/purchase-requisitions/review` for anyone holding `pr.evaluate`.

## 7. Approval

- `entity_type = 'PR'`, resource `pr`. The policy is matched by company and hotel (`process_id` NULL), using the existing `findBestMatchingPolicyTx`. Steps resolve against the **PR's department**, so for example an HOD step resolves to the requesting department's HOD.
- **Amount thresholds:** a step with `min_amount` applies only when `estimated_total ≥ min_amount`. Steps that don't apply are recorded in the instance's `metadata.approval_diagnostics` as `below_threshold` and shown greyed ("Not required below ₹X").
- **Separation of duties (PR only, enforced inside the engine):** the requester is **never** an approver of their own PR.
  - They are removed from every resolved step: at creation, on mid-flight policy propagation, on membership revalidation and on delegation.
  - A step whose only resolved approver is the requester is **skipped as `sod_self`** (recorded and shown).
  - The requester is never auto-recorded as having approved.
- **Fail-closed:** before creating the instance, the PR controller resolves the whole applicable chain.
  - If any applicable step resolves to **nobody** (not even the requester), the submit is refused with **422 `PR_STEP_UNRESOLVED`**, naming the step.
  - If no step remains with an independent approver, it is refused with **422 `PR_NO_INDEPENDENT_APPROVER`**.
  - No policy: **422 `PR_NO_POLICY`**.
  - The engine is also called with `strictSteps` so it throws instead of silently skipping (defence in depth).
- **Actions:**
  - Approve and Reject go through the generic engine endpoint.
  - **Send back** is a PR endpoint. It is allowed only for a pending approver of the current step, and it cancels the instance via `cancelApprovalInstance`.
  - **Withdraw** is a PR endpoint for the requester.
- **Post-approval handler** (`handlePrPostApproval`, registered in **both** registries): row-locks the PR, sets `approved`/`approved_at`, writes an event, and notifies the requester and the hotel's buyers. It is idempotent: an already-approved PR is a no-op.
- **Rejection handler:** sets `rejected`, writes an event, notifies the requester. Also idempotent.
- The admin approval-hierarchy UI gets a process-free **PR flow** and a per-step "Only when PR value ≥ ₹" field. The policy upsert whitelist accepts `PR` (and `MR`, which was missing too). `insertPolicySteps` writes `min_amount`, and `computePolicyStepDiff` treats a `min_amount` change as a modify, so it propagates.

## 8. Requester experience

- **Create / edit draft** (`/purchase-requisitions/create?id=`):
  - Header fields, then lines. A line is either picked from the catalog (`/rfq/search-product`, filtered to the hotel) or entered as free text (name, category, unit).
  - **Guided buying:** when a catalog variant has an active contract for this hotel × department (the predicate of `mrModel.searchContractedItems`), the line is **blocked** with "On contract — raise an MR instead" and a link to MR create. The server enforces the same check on save and submit (**422 `PR_LINE_ON_CONTRACT`**).
  - **Duplicate hint:** "N open requests / RFQs for this item in your company in the last 30 days." Details are shown only for records the user may read.
  - **Live routing preview** (`GET /v1/pr/routing-preview`): which lines go to which reviewing department and who reviews them; the approval steps with resolved names, thresholds, SoD skips; and any **blocking problems**, shown before submit with the same codes as submit.
- **Detail** (`/purchase-requisitions/[prId]`):
  - Header and status, with a "Now with: …" line naming the current holders (reviewers / step approvers / buyer queue / assigned buyer).
  - Lines with derived progress and downstream RFQ/PO links.
  - Review panels and the approval chain.
  - A **conversation** thread (comments from requester, reviewers, approvers and buyers).
  - The **timeline** from `tbl_pr_event`.
  - Actions by role: submit / withdraw / cancel / copy-as-new / cancel line (approved, not converted) / review / send back / approve / reject.
- **List** (`/purchase-requisitions`): my PRs plus PRs readable in my scope. Status tabs, facets (hotel, department, type, urgency, progress), search. KPIs: open, awaiting me, in purchase queue, average time to approval.

## 9. Buyer pool & conversion

- **Pool** (`/purchase-requisitions/queue`, `pr.convert`): one row per pool line across PRs for the hotels in the buyer's scope.
  - Columns: PR number, department, item (or free text), category, quantity and unit, estimated value, need-by, urgency, **age since approval** (amber ≥ 3 days, red ≥ 7 days, from the APQC median of 2 days), assigned buyer, duplicate hint.
  - Filters: hotel, department, category, progress (`in_pool`/`needs_mapping`/`awaiting_catalog`), assigned to me.
- **Assign** (a PR to me or to a colleague holding `pr.convert` for that hotel). The requester sees "Handled by …".
- **Map** a free-text line to a catalog variant. It must satisfy the RFQ "usable" predicate (`p.status=1 AND p.is_deleted=0 AND p.is_review=0 AND p.is_approve=1 AND pv.is_approve=1`) and must not be on contract.
- **Request catalog item** → a `tbl_pr_catalog_request(open)`, plus a notification to platform admins.
- **Close line** (reason required) → requester notified.
- **Convert** (`POST /v1/pr/convert`, body `{line_ids[], department_id}`). In **one transaction**:
  1. Lock the selected lines and their PRs (`FOR UPDATE`, ordered by id).
  2. Verify each line, otherwise **409 `PR_LINE_NOT_CONVERTIBLE`** listing the offending lines:
     - same company and **same hotel**;
     - PR `approved`, line `active`, catalog or mapped;
     - no live link;
     - not on contract;
     - the caller holds `pr.convert` for the hotel and `rfq.create` for (company, hotel, chosen department).
  3. Group the lines by effective variant. Lines of the same variant must share the same unit, otherwise **422 `PR_UNIT_MISMATCH`**.
  4. Build the RFQ draft with the same inserts as `copyRfq`:
     - `tbl_rfq` (status 1, unpublished, the buyer's contact fields, hotel, department; title = first PR's title + " & N more" (R25); `comment` = '' because it is the vendor-visible terms field that also lands on the PO (R22)).
     - `tbl_rfq_hotel_mappings`.
     - Per variant group:
       - `tbl_rfq_products`, with comment = de-duplicated specifications tagged "[PR-… · department · qty unit]" (never requester names). The RFQ product comment is capped at 1000 characters, so PR line specifications are capped at 1000 at entry and a merge that would exceed 1000 is refused with **422 `PR_SPEC_TOO_LONG`**, never truncated (R23).
       - Specs `Quantity` (sum) and `Unit`.
       - Files mapped from attachments (`spec→SPEC`, `datasheet→TDS`, `qap→QAP`).
       - Tech-evaluation clauses from the reviewers' clauses.
       - Vendors via the same eligibility resolver plus the vendor-network direct invites that the add-product flow uses.
  5. Insert `tbl_pr_line_rfq` links and events. Notify the requesters ("Your PR-… is being sourced: RFQ #…").
  6. The response `{rfq_id}` sends the FE to `/dashboard/buyer/rfq-management?tab=create-rfq&draft_id=<rfq_id>`. The buyer finishes in the existing wizard (bid end date, vendors, terms), and RFQ approval runs as today.
- **Concurrency:** two buyers converting the same line at once — one wins, the other gets 409. A DB-level guard backs this up: an advisory lock per line inside the transaction, plus the live-link re-check after the lock.

## 10. Catalog requests (platform admin)

- admin-panel page **Catalog requests** (list open / fulfilled / rejected).
- **Fulfil:** pick or create the variant, then save. This sets `resolved_variant_id`, maps the line (`mapped_variant_id`) after validating it is usable, and notifies the requester and the assigned buyer (or the hotel's buyers).
- **Reject** (reason required): notifies the same people. The line returns to `needs_mapping`.
- Backend: `GET/POST /api/v1/admin/pr-catalog-requests…` behind `jwtAdm`.

## 11. Notifications (in-app via `notificationService.dispatch`, plus email for action-required events)

| Event | To |
|---|---|
| Submitted → review tasks | reviewers of each group |
| Review sent back / approval sent back | requester |
| Approval step pending | engine (automatic) — PR label/link registered |
| Approved | requester; buyers of the hotel (pool) |
| Rejected | requester |
| Assigned | assigned buyer; requester ("handled by") |
| Converted | requester(s) |
| Line closed by buyer | requester |
| Catalog request created / fulfilled / rejected | platform admins / requester + buyer |
| New comment | all participants except the author |

Deep link: `/dashboard/buyer/purchase-requisitions/:id` (`buyerPrDetail`), plus `ENTITY_LABELS.PR`, the `approvalActionUrl` case and the PR identifier in approval emails (`pr_number`).

## 12. Security

- Tenant scope is **always** derived from `req.user` plus the PR row, never from the body or query. Every `:id` route loads the PR and asserts readability: requester, `pr.read` on the cell, a reviewer of one of its groups, an approver on its instance, or a buyer with `pr.convert` on its hotel.
- Mutations re-assert their specific permission on the PR's own scope.
- Variant ids, category ids, hotel and department are validated against the company (no cross-tenant ids). Attachment URLs must come from our upload endpoint (same validation as RFQ files).
- Rate-limit-free but idempotent: double submit, approve or convert are made safe by state checks under row locks.

## 13. Testing strategy (product-level, real HTTP + Postgres)

1. **State machine:** every legal transition, and every illegal one → 409.
2. **Money:** totals are server-computed (a client-supplied total is ignored); threshold boundaries (`=`, just below, just above); NUMERIC precision.
3. **Separation of duties:**
   - The requester holds every approver role → never auto-approved.
   - A sole-approver step is skipped as `sod_self`.
   - No independent approver → 422.
   - Propagation or revalidation never re-adds the requester.
   - A delegation to the requester is filtered out.
4. **Fail-closed:** an unresolved step, no reviewer, or no policy → 422 with a precise code.
5. **Review:** category and parent-category routing, parallel groups, reviewers editing only their own lines, field restrictions, send-back supersedes other reviews, completing the last review creates the instance.
6. **Pool / conversion:**
   - Merge by variant and the sum of quantities.
   - Unit mismatch.
   - Hotel mismatch.
   - On-contract block.
   - Clauses, files and vendors carried into the draft; the draft opens in the wizard (`get-draft-by-id` returns it).
   - Derived progress across draft delete / RFQ close / PO create / PO cancel.
   - Concurrent double convert → exactly one link.
7. **AuthZ / IDOR:** cross-company, cross-hotel and cross-department reads and mutations → 403/404; a reviewer of department A cannot act on department B's group; buyer scope by hotel.
8. **Catalog requests:** fulfil maps the line and re-validates usability; reject returns the line to `needs_mapping`.
9. **Notifications:** recipients per event.
10. **FE:** page tests with mocked services for create (guided-buying block, preview problems), detail (action visibility per role), queue (selection rules, convert redirect), admin mapping and PR flow wizard.
11. **Browser E2E** on the local e2e stack across personas: requester → reviewer → 2-step approval with a threshold → buyer maps, converts and finishes the RFQ in the wizard; plus send-back and withdraw loops.

## 14. Deploy notes

- DB-first. Migrations in order:
  1. Enum `resource_type += 'pr'`, `permission_action_type += 'convert'` (own transaction).
  2. Permissions plus system roles.
  3. PR tables.
  4. `min_amount` column.
- No backfill.
- Clients need: (a) PR roles granted, (b) a PR approval policy, (c) category → review department mappings. Without a policy, submit is refused with a clear message. Nothing is silently auto-approved.
