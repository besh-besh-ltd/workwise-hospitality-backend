# Full Backend + Frontend Re-verification — Post security/bug-fix pass

**Repo:** `/Users/apple/Documents/Workwise/hospitality/backend` (branch `feature/mrp-quoting`)
**Date:** 2026-07-27
**Runner:** `npm test -- <pattern>` in batches (Jest, `maxWorkers: 1`), local Postgres via `npm run test:setup` / teardown (auto-run per invocation by pretest/posttest hooks). Frontend via `cd ../frontend && npm test`.

Scope of the just-applied working-tree changes (confirmed via `git diff --stat`):
- 4 cross-tenant IDOR guards: `arcCommitteeController.js`, `arcContractController.js`, `rfqController.js`, `quoteCompareViewModel.js` (also has `buildCellHistory` fallback)
- New tests: `arc.contract.multiVendor.test.js` (+34 lines)
- Also present in the working tree (pre-existing uncommitted MRP-quoting feature work per project memory, not part of this fix's scope): `arcVendorController.js`, `pricingController.js`, `arcEvaluationModel.js`, `rfqModel.js`, `pricingEngine.js`, `arc.vendor.pricing.test.js`, `pricing.preview.test.js`, `pricingEngine.test.js`, `quote.submission.test.js`, `tests/setup/schema.sql`.

---

## 1. Specifically-fixed suites (confirmed green)

| Suite | Result |
|---|---|
| `rfq.quoteComparisonView.test.js` | **PASS — 17/17** |
| `arc_v2/arc.contract.multiVendor.test.js` | **PASS — 7/7** (includes the 3 new cross-tenant IDOR tests) |

Combined: 2/2 suites, 24/24 tests. Both requested confirmations are satisfied.

---

## 2. `tests/services/*.test.js` (62 files) — batched results

| Batch | Files | Suites | Tests | Result |
|---|---|---|---|---|
| S1 | approval.willBeFinalApprover, approvalHelper.smoke, approvalPolicyResolution, arc.approvers.processScope, authorizationService, buyerDashboardAwarding, buyerDashboardCommercialApprover, buyerDashboardCommercialEvaluator, buyerDashboardPermissions, buyerDashboardRfqCreator | 10/10 pass | 100/100 pass | clean |
| S2 | buyerDashboardTechApprover, buyerDashboardTechEvaluator, buyerDashboardWidgetRoutes, dashboard.abcAnalysis, dashboard.categoryInsights, dashboard.costIntelligence, dashboard.negotiationSavings, dashboard.noResponse, dashboard.pendingApprovals, dashboard.procurementSnapshot | 10/10 pass | 71/71 pass | clean |
| S3 | dashboard.smartInsights, dashboard.statusBanner, financialYear, fixtures.smoke, harness.smoke, listView.fyFilter, negotiation.fields, negotiation.flow, negotiation.listView.sources, negotiationQuote.approveCharges (+2 extra matched by Jest substring pattern: `arc_v2/arc.negotiation.flow.test.js`, `vendorDashboard.statusBanner.test.js`) | 12/12 pass | 141 passed + 1 todo (142) | clean |
| S4 | po.acceptReject, po.dashboard, po.documentData, po.mergeDrafts, po.vendor.module, poTemplatePricing, pricing.preview, pricing.serverAuthoritative, pricingEngine, quote.submission | 10/10 pass | 200 passed + 11 todo (211) | clean (expected `InvalidAccessKeyId` S3-stub errors inside `po.acceptReject` are exercised/caught failure-path assertions, not real failures — test still passed) |
| S5 | quoteCompareService, rbac.processScope, rfq.clarification, rfq.copy.lineage, rfq.copy, rfq.create.flow, rfq.draft, rfq.editUnlock, rfq.lifecycle, rfq.publish.email | 10/10 pass | 130 passed + 3 todo (133) | clean |
| S6 | rfq.publishRetry, rfq.queryMessageReads, rfq.quoteCompare, rfq.quoteComparison, rfq.update.flow, rfq.withdrawTerminate, techEval.flow, vendor.quote.charges, vendor.statusBanner, vendorDashboard.statusBanner, vendorEligibility | **1 failed**, 10 passed (11) | 133 passed + 4 todo, **1 failed** (138) | `vendor.statusBanner.test.js` — 1 failure, see §4 |

**Coverage:** all 62 files in `tests/services/*.test.js` accounted for (61 run here + `rfq.quoteComparisonView.test.js` already confirmed in §1).

---

## 3. `tests/services/arc_v2/*.test.js` (74 files) — batched results

| Batch | Files (abbreviated) | Suites | Tests | Result |
|---|---|---|---|---|
| A1 | admin.selfServe.e2e, arc.addendumTemplate, arc.amendment.addendum.coverage, arc.amendment.addendum, arc.amendment.flow, arc.amendment.lifecycle, arc.approvalPolicy.adminFlow, arc.autoApprove.hooks, arc.blindTechEval, arc.commEval.reconciliation | 10/10 pass | 82/82 pass | clean |
| A2 | arc.commEval.sendBackToTech, arc.committee.decide, arc.contractClarification, arc.create.flow, arc.create.resume, arc.create.scope, arc.createPickers, arc.draft.persistence, arc.e2e.deployment, arc.expiry | **1 failed**, 9 passed (10) | 75 passed, **1 failed** (76) | `arc.draft.persistence.test.js` — see §4 (newly observed, NOT a regression from the reviewed fix set) |
| A3 | arc.extendSubmission, arc.groupH.vendorCompanyAndScope, arc.groupI.quoteForm, arc.lifecycle.immutability, arc.lifecycle.states, arc.list.scope, arc.manual.contracts, arc.manual.draft, arc.manual.hardening, arc.manual.idor | 10/10 pass | 63 passed + 1 skipped (64) | clean |
| A4 | arc.manual.scope, arc.manual.security, arc.manual.stages, arc.manual.vendors, arc.multiCompanyScope, arc.negotiation.approverDisplay, arc.negotiation.expiry, arc.negotiation.fieldTargets, arc.negotiation.flow, arc.negotiation.vendorApply | 10/10 pass | 61/61 pass | clean |
| A5 | arc.notifications, arc.publish.policy, arc.publish.validation, arc.publish.vendors, arc.publishApproval, arc.quote.guards, arc.quote.resubmit, arc.serial.fy, arc.submissionClose, arc.submissionOpen | 10/10 pass | 88/88 pass | clean |
| A6 | arc.submissionWindow.tz, arc.techEnvelope, arc.techEval.decide, arc.techEval.mandatory, arc.techEval.setupValidation, arc.techShortlist, arc.universalTechEval, arc.vendor.lifecycle, arc.vendor.phase1, **arc.vendor.pricing** | 10/10 pass | 121/121 pass | clean — `arc.vendor.pricing.test.js` (known global-charges race) passed on first try, no re-run needed |
| A7 | arc.vendorDashboard, arcPricingResolver, mr.analytics, mr.calloff.acceptance, mr.calloff.pdf, mr.calloff.po, mr.create.guards, mr.dashboard.scope, **mr.flow**, mr.phase5, mr.release.guards, negotiationPolymorphic, signatureOtp | 13/13 pass | 79/79 pass | clean — `mr.flow.test.js` (known flaky ×3) passed clean this run |

**Coverage:** all 74 files in `tests/services/arc_v2/*.test.js` accounted for (73 run here + `arc.contract.multiVendor.test.js` already confirmed in §1).

---

## 4. Failures observed — detail

### 4a. `vendor.statusBanner.test.js` — 1 failure (EXPECTED, pre-flagged)
- Failing test: `GET /vendor-dashboard/status-banner — mode escalates with state › action_needed: a PO is sitting in acceptance_pending for this vendor`
- This is the pre-communicated known stale-test-vs-design conflict being handled separately. Confirmed it is the **only** failure in that file (1 failed / rest passed).

### 4b. `arc_v2/arc.draft.persistence.test.js` — 1 failure (NEWLY OBSERVED — not a regression from the reviewed fix)
- Failing test: `ARC v2 — GROUP D: draft save/edit persistence + ownership › terminate / IDOR › the genuine owner CAN terminate their own ARC`
- Assertion: `expect(row.status).toBe("terminated")` — received `"draft"`, even though the HTTP `POST /:id/terminate` call itself returned `200`.
- **Reproducibility:** Failed identically on 2/2 runs when batched with 9 other arc_v2 suites (batch A2). Passed cleanly 10/10 when run **in isolation**.
- **Root cause hypothesis:** `app/controllers/arc_v2/arcController.js:679-708` (`terminate`) calls `ok(res, ...)` (sends the HTTP response) **inside** the `db.tx(async (t) => {...})` callback, before the transaction has committed:
  ```js
  await db.tx(async (t) => {
    const updated = await arcModel.setStatus(id, 'terminated', { closed_reason: reason }, t);
    await logArcEvent({ ... txContext: t });
    ok(res, { arc: updated }, 'ARC terminated');   // <-- responds before tx commits
  });
  await notifyArcEvent({ ... });
  ```
  Under low connection-pool contention (isolated run) the commit lands before the test's follow-up `db.one(...)` read fires; under batch load (prior suites' queries still draining the pool) the read-after-response races ahead of the commit, so the test observes stale `status = 'draft'`.
- **Confirmed NOT caused by the reviewed fixes:** `git diff --stat -- app/controllers/arc_v2/arcController.js tests/services/arc_v2/arc.draft.persistence.test.js` returns **no output** — neither file is part of the current working-tree changes. This is a latent, pre-existing response-before-commit pattern that this QA pass happened to surface under batched load; it was not in the previously-known flaky list and should be filed separately (recommend moving the `ok(res, ...)` call to after the `db.tx` block resolves).
- Not chased further per HARD rules (batch-and-report); flagging for a follow-up ticket.

### 4c. Frontend: `DashboardRegistry.test.js` — 1 failure (EXPECTED, pre-flagged)
- `declares 26 widgets (7 cross-role + 19 persona — incl. urgent-attention)` expects length 26, registry now has 27 (extra `dashboard.workflow_efficiency` widget present, test not yet updated). Matches the pre-communicated known stale assertion.

---

## 5. Known pre-existing red/flaky — status this run
- `po.auto_initiated` schema reds — not encountered as a distinct failure in this run's batches (no suite by that exact name was hit); no action taken, per instruction not to chase.
- `mr.flow.test.js` (×3 known) — ran clean (0 failures) in batch A7 this run.
- `arc.vendor.pricing.test.js` (global-charges async race) — ran clean (0 failures) on first attempt in batch A6; no re-run was necessary.

---

## 6. Frontend suite

`cd ../frontend && npm test`

```
Test Suites: 1 failed, 7 passed, 8 total
Tests:       1 failed, 63 passed, 64 total
```

Failure: `components/dashboard/buyer/DashboardRegistry.test.js` — known stale widget-count assertion (expected 26, actual 27), as pre-flagged. No other frontend failures.

---

## Verdict

**Backend:** 136/136 test files covered across 15 batches (62 in `tests/services/`, 74 in `tests/services/arc_v2/`, plus the 2 explicitly-fixed suites run standalone first). Aggregate observed: **134 suites clean, 2 suites with failures** — both accounted for and neither is a regression introduced by the reviewed IDOR/`buildCellHistory` fixes: (1) `vendor.statusBanner.test.js` is the pre-communicated expected failure, and (2) `arc.draft.persistence.test.js` is a newly-surfaced, pre-existing, order-dependent flake in an untouched file (`arcController.js` terminate responds before its `db.tx` commits) — confirmed via `git diff` to be outside the scope of this fix set, reproducible only under batch load and clean in isolation. The two suites specifically targeted by this re-verification, `rfq.quoteComparisonView.test.js` (17/17) and `arc_v2/arc.contract.multiVendor.test.js` (7/7, including all 3 new cross-tenant IDOR tests), are confirmed fully green. **No new regressions were introduced by the security/bug fixes.** Frontend: 7/8 suites and 63/64 tests pass, with the sole failure being the pre-flagged stale `DashboardRegistry` widget-count assertion (26 vs. actual 27) — not a regression. **Recommendation: GO for production**, with a follow-up ticket to fix the newly-discovered `arcController.js terminate` respond-before-commit race (currently latent/order-dependent, unrelated to this fix set) and the two already-tracked stale-test items (`vendor.statusBanner`, `DashboardRegistry`).
