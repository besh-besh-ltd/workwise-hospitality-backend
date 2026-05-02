# Test Suite TODOs — registry

Every `it.todo(...)` in the test suite represents a real test we intend to
write. Each entry below pins the location, the blocker, and the planned
landing wave/task. **No `it.todo` is allowed without a corresponding row in
this file** — the audit pre-deploy check is meaningless if our follow-up work
silently disappears into greppable code comments.

| Test (file:line) | Description | Blocker | Planned in |
|---|---|---|---|
| `rfq.withdrawTerminate.test.js:328` | Withdraw vs scheduler-fire race condition (F-WITHDRAW-RACE) | Concurrency harness — needs ability to invoke production scheduler-fire handler concurrently with HTTP withdraw | Wave 4 (Task 13). Tracked: Task 25. |
| `quote.submission.test.js` (F-QUOTE-001) | F-QUOTE-001 — vendor whose subscription expired between submit and update is currently allowed to update | Subscription middleware refactor + tests; addressed when we fix F-USERTYPE-QUOTE | Wave 3 (Task 12) |
| `negotiation.flow.test.js` (deferred-block) | Round expiration cron: end_date elapses with no buyer action → EXPIRED, approval CANCELLED | Time-mock helper + cron-driven test harness | Task 13 (Wave 4 concurrency / scheduler) |
| `po.acceptReject.test.js` (deferred-block) | rfqController.finalize: NEGOTIATION_QUOTE auto-approve → PO drafted | Approver-acting helper + finalize chain | Task 30 |
| `po.acceptReject.test.js` (deferred-block) | F-PO-001: same-vendor multi-product → merge prompt API | finalize + draftPO chain | Task 30 |
| `po.acceptReject.test.js` (deferred-block) | F-PO-FINAL-001: concurrent finalize race | Concurrency harness | Task 13 (Wave 4) |
| `po.acceptReject.test.js` (deferred-block) | initiatePO: creates PO approval instance | finalize → draftPO chain | Task 30 |
| `po.acceptReject.test.js` (deferred-block) | approvePO: multi-step approve → handlePOPostApproval | Approver-acting helper | Task 30 |
| `po.acceptReject.test.js` (deferred-block) | F-PO-PDF-001: PDF regeneration failure swallow | Mock Puppeteer to fail | Task 30 |
| `po.acceptReject.test.js` (deferred-block) | F-EMAIL-SCOPE-001: BU buyer recipient list scope | Multi-hotel user fixtures | Task 30 |
| `po.acceptReject.test.js` (deferred-block) | F-PO-REMINDER-001: cron tier-drift on missed days | Time-mock helper, refactor cron body to invokable fn | Task 13 (Wave 4) |
| `rfq.create.flow.test.js` (deferred-block) | F-RBAC-001: `can('tender.create')` middleware blocks unprivileged user | HTTP-level test through full middleware stack | Task 12 (Wave 3 admin/RBAC audit) |
| `pricing.serverAuthoritative.test.js` (5 todos) | Pricing engine server-authoritative write paths: createQuote / updateQuoteItems / draftPO / handleUpdatePO must overwrite client-supplied totals with engine output | Needs RFQ + vendor-mapping factories in a withTx context (similar to rfq.create.flow.test.js setup) | Tracks the pricing-centralization rollout |

## Discipline

- Adding a new `it.todo`: **also add a row here** in the same commit, pointing
  to the blocking dependency.
- Resolving an `it.todo`: replace it with a real `it(...)`, **delete the row
  from this table**, mark the corresponding TaskX completed.
- Wave 5 (final report assembly) **must verify this file is empty** before
  declaring the suite production-ready.
