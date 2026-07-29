# Final Full-Suite Confirmation — Backend (feature/mrp-quoting)

Date: 2026-07-27
Branch: `feature/mrp-quoting`
Runner: `npm test -- <patterns>` (batched, maxWorkers=1, local Postgres via `tests/setup/globalSetup.js`)

## Scope

- `tests/services/*.test.js` — 62 files
- `tests/services/arc_v2/*.test.js` — 74 files
- Total: **136 suite files**, no test files exist outside these two directories (`find tests -name "*.test.js"` = 136).

Code change under scrutiny: `app/controllers/arc_v2/arcController.js` `terminate()` — moved from
respond-inside-tx to respond-after-commit (mirrors the verifyOtp/clarification pattern), with
`notifyArcEvent` now fire-and-forget (`.catch` logged) after the response is sent.

## Result: ALL GREEN — 0 failures across every batch

**136/136 suites passed. 0 FAIL lines in any of the 20 `npm test` invocations run (15 initial
coverage batches + 5 anchored re-verification batches for `tests/services/*`).**

Grand totals (de-duplicated — anchored re-runs used `services/<name>` prefixed patterns to avoid
counting a suite's tests twice when it incidentally matched more than one batch pattern):

| Group | Suites | Tests total | Passed | Skipped | Todo |
|---|---|---|---|---|---|
| `tests/services/arc_v2/*` (B1–B10) | 74 | 578 | 577 | 1 | 0 |
| `tests/services/*` (SV1b–SV5, anchored) | 62 | 793 | 774 | 0 | 19 |
| **Total** | **136** | **1371** | **1351** | **1** | **19** |

(The 1 skipped and 19 todo are pre-existing `test.skip`/`test.todo` markers inside otherwise-passing
suites — not failures, not new.)

## Priority check: `arc.draft.persistence` batched with other ARC-status suites (race repro)

Batch B1 = `arc.draft.persistence`, `arc.lifecycle.immutability`, `arc.lifecycle.states`,
`arc.expiry`, `arc.serial.fy`, `arc.commEval.reconciliation`, `arc.commEval.sendBackToTech`
(7 suites, all exercise ARC status transitions / pool contention under one Jest process):

```
PASS tests/services/arc_v2/arc.lifecycle.states.test.js
PASS tests/services/arc_v2/arc.draft.persistence.test.js
PASS tests/services/arc_v2/arc.commEval.sendBackToTech.test.js
PASS tests/services/arc_v2/arc.lifecycle.immutability.test.js
PASS tests/services/arc_v2/arc.serial.fy.test.js
PASS tests/services/arc_v2/arc.commEval.reconciliation.test.js
PASS tests/services/arc_v2/arc.expiry.test.js
Test Suites: 7 passed, 7 total
Tests:       56 passed, 56 total
```

**Confirmed: `arc.draft.persistence` PASSES when batched with several other ARC status-mutating
suites — the previously-flaky pool-contention race did not reproduce.**

## Direct coverage of the `terminate()` respond-after-commit change

Suites that reference `terminate` (grep across `tests/services/arc_v2/*.test.js`), all PASS:
- `arc.draft.persistence.test.js` — PASS (batch B1)
- `arc.lifecycle.states.test.js` — PASS (batch B1, same batch as above — race-repro context)
- `arc.manual.contracts.test.js` — PASS (batch B2)
- `arc.extendSubmission.test.js` — PASS (batch B7)

No regression from the `terminate` respond-after-commit + fire-and-forget notify change.

## Recently-changed test files — explicitly re-confirmed green

- `tests/services/vendor.statusBanner.test.js` — PASS (batches SV4, SV4b — 2 independent runs)
- `tests/services/arc_v2/arc.contract.multiVendor.test.js` — PASS (batches B5, SV4 — 2 independent runs)
- `tests/services/pricing.preview.test.js`, `tests/services/pricingEngine.test.js`,
  `tests/services/quote.submission.test.js` (MRP quoting feature test changes) — PASS (batches SV3, SV3b)
- `app/models/quoteCompareViewModel.js` is exercised by `tests/services/quoteCompareService.test.js`
  and `tests/services/rfq.quoteCompare*.test.js` — all PASS.
- Frontend `DashboardRegistry.test.js` is out of scope for this backend suite run (frontend repo is
  a separate Jest/test project); not exercised here.

## Known pre-existing items — checked, not blockers

- **`po.auto_initiated` schema gap** (previously known red, per project memory): the `schema.sql`
  used for the test DB now contains the column (`tests/setup/schema.sql:4663`:
  `auto_initiated boolean DEFAULT false NOT NULL`). The regression-named test
  `arc.e2e.deployment.test.js › "10. the call-off PO detail loads (regression: the auto_initiated 500)"`
  and `po.dashboard.test.js` (which reads `po.auto_initiated`) both PASS. This pre-existing gap
  appears to already be resolved in the current tree — no red observed, nothing to chase.
- **`mr.flow.test.js`** — ran once (batch B10), PASS, no flake observed. No re-run needed.
- **`arc.vendor.pricing.test.js`** (global-charges async race) — ran twice independently (batch B8,
  batch SV4/SV3 incidental matches), PASS every time, no flake observed.

## Batch log (all 20 `npm test` invocations — pattern set → result)

Initial coverage pass (arc_v2, B1–B10) + services (SV1–SV5):

| Batch | Patterns | Suites | Tests | Result |
|---|---|---|---|---|
| B1 | arc.draft.persistence, arc.lifecycle, arc.expiry, arc.serial.fy, arc.commEval | 7 | 56 | PASS |
| B2 | arc.manual, arc.amendment, arc.addendumTemplate | 13 | 87 | PASS |
| B3 | arc.negotiation, arc.autoApprove, arc.approvalPolicy | 7 | 46 | PASS |
| B4 | arc.techEval, arc.techEnvelope, arc.techShortlist, arc.universalTechEval, arc.blindTechEval | 7 | 82 | PASS |
| B5 | arc.publish, arc.contract, arc.quote | 8 | 52 | PASS |
| B6 | arc.create, arc.list.scope, arc.multiCompanyScope, arc.group | 8 | 46 (1 skipped) | PASS |
| B7 | arc.submission, arc.extendSubmission, arc.committee | 5 | 45 | PASS |
| B8 | arc.vendor, arcPricingResolver, arc.notifications | 6 | 83 | PASS |
| B9 | admin.selfServe.e2e, arc.e2e.deployment, negotiationPolymorphic, signatureOtp | 4 | 25 | PASS |
| B10 | mr\. | 9 | 56 | PASS |
| SV1 | buyerDashboard, dashboard\., harness.smoke, fixtures.smoke, authorizationService | 24* | 211* | PASS |
| SV2 | rfq\., financialYear, listView.fyFilter, arc.approvers.processScope, rbac.processScope | 19 | 292 (7 todo) | PASS |
| SV3 | po\., poTemplatePricing, pricing\., pricingEngine, quote | 21* | 326* | PASS |
| SV4 | vendor\., vendorDashboard, vendorEligibility, negotiation, techEval | 28* | 259* | PASS |
| SV5 | approval.willBeFinalApprover, approvalHelper, approvalPolicyResolution | 3 | 37 | PASS |

(*SV1/SV3/SV4 counts include incidental extra matches from `tests/services/arc_v2/` — all passed;
superseded by the anchored re-run below for the clean grand total.)

Anchored re-verification pass (services only, `services/<pattern>`, no arc_v2 crossover):

| Batch | Patterns | Suites | Tests | Result |
|---|---|---|---|---|
| SV1b | services/buyerDashboard, services/dashboard\., services/harness.smoke, services/fixtures.smoke, services/authorizationService | 20 | 162 | PASS |
| SV2b | services/rfq\., services/financialYear, services/listView.fyFilter, services/arc.approvers.processScope, services/rbac.processScope | 19 | 292 (7 todo) | PASS |
| SV3b | services/po\., services/poTemplatePricing, services/pricing\., services/pricingEngine, services/quote | 11 | 224 (11 todo) | PASS |
| SV4b | services/vendor\., services/vendorDashboard, services/vendorEligibility, services/negotiation, services/techEval | 9 | 78 (1 todo) | PASS |
| SV5 (reused) | approval.willBeFinalApprover, approvalHelper, approvalPolicyResolution | 3 | 37 | PASS |

## Conclusion

Zero unexplained failures. Zero regressions from the `terminate` respond-after-commit fix.
`arc.draft.persistence` passes when batched with other ARC status-mutating suites. GO.
