# ARC negotiation on the RFQ screens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ARC negotiation rounds use the RFQ negotiation screens (approval page, command center,
level-2 page, create review), so ARC approvers see targets. Round deadlines must be ≥ 2 h out.

**Architecture:** Keep ARC's write endpoints. Add one ARC read endpoint (approval bundle) and make the
command center ARC-correct. On the frontend, extract the RFQ approval page into a shared view fed by RFQ
and ARC loaders, using the existing ARC→RFQ product adapter.

**Tech Stack:** Express + pg-promise (backend, Jest + Supertest on real Postgres); Next.js 15 / React 19
(frontend, Jest + Testing Library).

**Spec:** `docs/superpowers/specs/2026-10-24-arc-negotiation-rfq-screens-design.md`

## Global Constraints

- Branch `feat/arc-negotiation-rfq-screens` in BOTH repos, off `origin/qa`; PRs target `qa`.
- Minimum round window: `120` minutes. Server message (verbatim):
  `The round deadline must be at least 2 hours from now, so approvers have time to approve and vendors have time to respond.`
- Tenant scope always derives from `tbl_arc` / `tbl_negotiation_rounds` rows, never from body/query/headers.
- Backend tests via `npm test -- --testPathPatterns "<pattern>"`; run with `TZ=UTC PGOPTIONS="-c timezone=UTC"` to match CI.
- New backend test files must match a shard in `tests/shards.json` (`npm run test:shards`).
- Never use backticks inside SQL comments in JS template literals.
- Match each file's existing style (ARC v2 files: arc_v2.css classes + tokenized inline styles).

## Review Focus

1. ARC round created by the legacy single-item path (`arc_item_id` set, `products` NULL, `target_price` set) — the approval page and cards must still show `₹target` (FE2/FE3 tests).
2. Whole-ARC round (`products: [{is_arc_level:true,…}]`) — the review shows "Whole rate contract" with aggregated vendor data, and the command center shows the target on the ARC-level line (BE2/FE2 tests).
3. Approver whose module role was revoked mid-flight but who is still PENDING on the instance — the bundle still loads (BE4 test).
4. A deadline exactly at the 2 h boundary from a browser in IST sending a `Z` string — accepted at 2 h + 1 min, refused at 1 h 59 min (BE1 test).
5. URL round that is not pending for me (expired, or someone else's) — ARC approval page shows an empty state with a link to the round in the command center, never buttons (FE2 test).

---

## Backend

### Task 1 (BE1): Minimum round window + ARC approve refuses a lapsed round

**Files:**
- Create: `app/helper/negotiation/roundWindow.js`
- Modify: `app/controllers/negotiation/negotiationController.js` (createRound end_date check, ~L998)
- Modify: `app/controllers/arc_v2/arcNegotiationController.js` (createRound end_date check; approveRound)
- Test: `tests/services/negotiation.minimumWindow.test.js`

**Interfaces — Produces:** `MIN_ROUND_WINDOW_MINUTES = 120`, `ROUND_WINDOW_TOO_SHORT_MESSAGE`,
`roundWindowError(endDate: Date|string, now = new Date()): string|null` (null = OK; past dates keep their existing messages, so only call it after the future check).

- [ ] Test: RFQ POST `/api/v1/negotiation/rounds` with end_date now+90m → 400, message equals the constant; now+2h+1m → 200. ARC POST `…/comm-eval/negotiation/rounds` with now+90m → 400 same message; now+3h → 200. ARC approve on a PENDING round whose end_date was moved into the past → 400 and status stays PENDING_APPROVAL.
- [ ] Run → fails. Implement. Run → passes.
- [ ] Run shards `negotiation` and `arc_v2/arc\.` → green (no existing test uses < 2 h).
- [ ] Commit `feat(negotiation): rounds must give at least two hours before their deadline`.

### Task 2 (BE2): Command center reads ARC targets

**Files:** Modify `app/models/negotiationModel.js` `getVendorFieldsForProduct` (L212). Test: `tests/services/arc_v2/arc.negotiation.rfqScreens.test.js` (new suite shared with BE3/BE4).

- [ ] Test: ARC round with products `[{arc_item_id:A, vendor_targets:[{vendor_id:V, fields:[{name:'base_price',target:'80'}]}]}, {is_arc_level:true, vendor_targets:[{vendor_id:V, fields:[{name:'payment_terms',target:'45 days'}]}]}]` → `GET /api/v1/negotiation/rounds/:id/detail` returns a line for item A whose `numeric_targets` contains base_price 80 and `target_unit` = 80, and an ARC-level line carrying the payment_terms text target.
- [ ] Implement: an entry matches when `rfqProductId === 'RFQ_LEVEL'` and (`is_rfq_level` or `is_arc_level`), else when `rfq_product_id` OR `arc_item_id` equals the id. RFQ behaviour unchanged.
- [ ] Commit `fix(negotiation): the round page reads ARC targets`.

### Task 3 (BE3): Command center access + actions for ARC rounds; withdraw refuses ARC

**Files:** Modify `app/models/negotiationModel.js` (new `arcNegotiationReadScopeSql`, use it on the ARC branch of `userCanReadRound`, `getScopedRoundsByIds`, `getRelatedRoundIds`, `getRoundDisplayPositions`, `countScopedRoundsOnParent`; ARC branch in `getNegotiationPermissionsForRound`), `app/controllers/negotiation/negotiationRoundDetailController.js` (`deriveActions({... sourceType})`), `negotiationController.withdrawRound`.

**Interfaces:** `arcNegotiationReadScopeSql(alias, userParam)` — read grants: `negotiation.read`, `arc-comm.read|evaluate|approve`, `arc.admin` in the ARC's 4-axis scope, OR the user is on any ARC_NEGOTIATION instance's approver list for a round with `source_id = alias.id`. ARC permissions `{read, create, update, approve, delete}`: create/update = `arc-comm.evaluate|arc.admin`; approve = `arc-comm.approve|negotiation.approve`; delete false.
`deriveActions` for `sourceType === 'ARC'`: `can_approve/can_reject = preApproval && isPendingForMe`; `can_approve_line/can_reject_line/can_withdraw/can_approve_vendor/can_reject_vendor/can_resubmit_vendor/can_submit_quotes_for_approval = false`; close/next/view as today on the ARC permission set.

- [ ] Tests (same suite): arc-comm-only evaluator (no negotiation perms) → 200; outsider with no scope → 403; pending approver → `actions.can_approve === true`, `can_withdraw === false`, `can_approve_line === false`; creator/evaluator who is not the approver → `can_approve === false`, `can_create_next_round` false while pending. `POST /api/v1/negotiation/rounds/:id/withdraw` by the creator on an ARC round → 400, round still PENDING_APPROVAL, instance still PENDING.
- [ ] Run `negotiation.roundDetail` suites → still green (RFQ unchanged).
- [ ] Commit `fix(negotiation): ARC rounds open in the round page for ARC users, with ARC-true actions`.

### Task 4 (BE4): ARC approval bundle endpoint

**Files:** Modify `app/middleware/arcPermission.js` (export `heldArcPermissions(userId, arc): Promise<Set<string>>`, reused by the middleware), `app/models/arc_v2/arcNegotiationModel.js` (`getApprovalBundleForArc(arcId, userId)`, `isApproverOnArcNegotiation(arcId, userId)`), `app/controllers/arc_v2/arcNegotiationController.js` (`getApprovalBundle`), `app/routes/arc_v2/evaluationRoutes.js`.

**Interfaces — Produces:** `GET /api/v1/arc-v2/evaluation/:arcId/comm-eval/negotiation/approval-bundle` →
`{ status:1, data: { arc:{id, arc_number, title, status, hotel_name, department_title, company_name}, rounds_history:[round rows + created_by_name, arc_item_name; timestamps ISO], negotiation_instances:{ [roundId]: [{id, status, current_step, total_steps, can_user_approve, steps:[{id, step_order, status, decision_rule, approvers:[{id, approver_user_id, user_name, user_email, user_designation, status, acted_at, removal_reason, removed_at}]}]}] }, items:[arcModel.listItems rows for items in rounds], quotes:[listAllQuotesForArc rows for (item,vendor) pairs in rounds], qualified_by_item } }`.

- [ ] Tests: buyer (arc-comm) → 200 with the shape above, `can_user_approve` false; approver → `can_user_approve` true; quotes contain only the rounds' vendor × item with current `rate`; outsider → 403; unknown ARC → 404; approver whose role scope is deleted after round creation → still 200.
- [ ] Commit `feat(arc): approval bundle for ARC negotiation rounds`.

## Frontend

### Task 5 (FE1): Shared approval view + deadline chip

**Files:** Create `components/dashboard/buyer/negotiation/create-round/NegotiationApprovalView.js`; modify `ApproveRoundPage.js` (RFQ loader only; keep exporting `fieldTargetLabel`); test `NegotiationApprovalView.deadline.test.js`.

**Interfaces — Produces:** `<NegotiationApprovalView loading loadError header={{title, number, status, subtitle}} bundle products chargeNamesList toReviewEntries={(round, products) => entries} allowLineWithhold onApprove={(round, comment, lines) => Promise<res>} onReject={(round, comment) => Promise} refetchBundle={() => Promise<bundle>} onDone backLabel onBack emptyExtra focusRoundId />`; `roundToReviewEntries` exported from `ApproveRoundPage.js`; `roundTimeLeft(endDate, now) → {text, urgent}` in `utils/negotiationTime.js`.

- [ ] Existing `ApproveRoundPage*.test.js` (4 files) pass unchanged.
- [ ] New test: a round ending in 90 min shows "Vendors' deadline … · 1h 30m left" marked urgent; 5 h out not urgent.
- [ ] Commit.

### Task 6 (FE2): ARC approval page on the shared view

**Files:** Create `components/dashboard/rate-contracts/buyer/negotiation/ArcApproveRoundPage.js`; add `arcRoundToReviewEntries(round, products)` to `create-round/adapters/arcNegotiationAdapter.js`; `services/arc_v2.js` `getArcNegotiationApprovalBundle(arcId)`; route `pages/.../[roundId]/approve.js` renders the new page; delete `ArcApproveRoundPanel.js` + its test, replaced by `ArcApproveRoundPage.test.js`.

- [ ] Tests: approver sees "PANEER TABELA", "base_price 200", current "₹240", approver chips, Approve → modal → `approveArcNegotiationRound(arcId, roundId, {comment})`; no withhold checkboxes; legacy `target_price` round shows target 150; whole-ARC entry renders; URL round not pending for me → "No rounds awaiting your approval" with a "View round" link to `/dashboard/buyer/negotiation/round/:id`; creator remarks shown.
- [ ] Commit.

### Task 7 (FE3): ARC round cards

**Files:** Modify `ArcRoundsList.js` (+ `ArcNegotiationPanel.js` passes `items`); test `ArcRoundsList.test.js`.

- [ ] Tests: target chips from `products` ("PANEER TABELA · Base price ₹200"); PENDING_APPROVAL expand copy "Vendors see this round once it is approved." (never "No revised quotes submitted yet."); ACTIVE empty → "Waiting for vendors — closes …"; ENDED/EXPIRED empty → "No vendor responded before the round closed."; "Open round" link → command center.
- [ ] Commit.

### Task 8 (FE4): ARC create uses StepReview; 2 h floor in pickers

**Files:** `ArcCreateRoundPanel.js` step 3 → `StepReview`; `useCreateRoundState.js` step3Errors adds the 2 h rule; `StepReview.js` `min=localDateTimeInputMin(MIN_ROUND_WINDOW_MS)` + hint; `NegotiationModal.js` picker min + guard; `utils/negotiationTime.js` `MIN_ROUND_WINDOW_MS`, `isRoundDeadlineTooSoon(localValue, now)`; delete unused `ArcStep{Item,VendorsTargets,Review}.js`, `useArcCreateRoundState.js`.

- [ ] Tests: ArcCreateRoundPanel step 3 renders "Round timeline" + remarks (existing remarks test still passes); step3Errors contains "Pick a deadline at least 2 hours from now." for a 1 h value.
- [ ] Commit.

### Task 9 (FE5): ARC level-2 page + routing

**Files:** `RfqNegotiationPage.js` accepts `arcId`; new route `pages/dashboard/buyer/negotiation/arc/[arcId].js`; `list/parentRow.js` `parentHref` ARC → `/dashboard/buyer/negotiation/arc/:arcId`; `round-detail/RoundActions.js` ARC `next_round` → `/dashboard/buyer/rate-contracts/:arcId/negotiation/create`.

- [ ] Tests: ARC mode queries parentKey `ARC:9`, eyebrow "Rate contract · Negotiation", action-required row links to the ARC per-round approve URL, others to the round page, "Open rate contract" link; listing ARC card href updated; RoundActions ARC next_round href.
- [ ] Commit.

## Verification

- [ ] Backend shards `negotiation`, `arc-core` (both halves), `arc-mr`, `security-approval` green under `TZ=UTC PGOPTIONS="-c timezone=UTC"`; `npm run test:shards`.
- [ ] Frontend full `npm test`, `npm run lint` on touched files, `next build`.
- [ ] Live E2E on an isolated local stack (`scripts/vendor_networks/e2e_server.sh`): create ARC round (deadline 3 h) → approver opens notification URL, sees targets vs current rates → approve → round ACTIVE → command center shows targets; listing ARC card → level 2.
- [ ] Whole-branch review by a fresh reviewer; PRs to `qa`; CI green; merge.
