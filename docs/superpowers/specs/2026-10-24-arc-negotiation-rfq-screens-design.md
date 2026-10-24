# ARC negotiation on the RFQ negotiation screens — design

Date: 2026-10-24 · Ticket: Phileein (Sandeep Pinge, 22 Oct) — "No revised quotes submitted yet"
during approval; the approver (Mrs. Shetty) cannot see the target price.

## Why

ARC negotiation was built in June 2026 as a separate mini-module with its own three screens. Only
step 2 of the create wizard was later moved onto the shared RFQ components. The approval page and
round cards kept reading the legacy `tbl_negotiation_rounds.target_price` column, but the wizard now
stores targets per vendor and per item in `products[].vendor_targets[].fields`. All 8 production ARC
rounds have `target_price = NULL`, so no ARC approver has ever seen a target.

Production also shows the deadline problem: ARC-2026-27-0006 has had 8 rounds since 16 Oct and zero
vendor responses. 7 rounds expired in PENDING_APPROVAL with windows of 4–64 minutes, while they needed
ALL of three approvers to approve.

The user wants ARC to use the RFQ negotiation screens, which clients already like.

## Goals

1. An ARC approver sees exactly what an RFQ approver sees: who opened the round and why, approver
   chips, each item's target per vendor against the vendor's current rate, totals, and the deadline
   with time remaining. Approve/reject goes through the same modal and phone action bar.
2. ARC rounds open in the Negotiation Command Center (`/dashboard/buyer/negotiation/round/:id`) with
   correct targets, and the actions shown are ones the ARC API honours.
3. The round cards on the ARC commercial stage show the real targets and state-aware copy, and link to
   the command center.
4. The ARC create wizard's review step is the RFQ review (the creator sees what the approver will see).
5. ARC cards on the Negotiations listing open an ARC level-2 page (same component as RFQ level 2).
6. Round deadlines must be at least 2 hours after creation, for RFQ and ARC, enforced server-side and
   mirrored in the pickers. Approval pages show the deadline with time remaining.

## Non-goals

- Per-line "withhold" on ARC approvals. The ARC approval backend does not support it; the
  checkboxes are hidden for ARC (decision 2026-10-24).
- Vendor-window-starts-at-approval (duration model). Follow-up.
- The vendor-side ARC negotiation banner.
- Changing the Negotiations listing's read scope (still `negotiation.read`).

## Anti-goals

- Any behaviour change on the RFQ approval page beyond the added deadline chip. Its existing tests must
  pass unchanged.
- Widening data exposure. An ARC user gains no read they did not already have through the ARC
  endpoints, and approvers see only the items and vendors of rounds on that ARC.
- Rendering a button the API refuses.

## Decisions (made with the user, 2026-10-24)

- Deadline: option (a) — refuse `end_date < now + 2h` for RFQ and ARC; show time remaining.
- No ARC per-line withholding for now.
- Add the ARC level-2 page.
- ARC uses the RFQ look as-is (my call; matching RFQ is the point).

## Shape

Backend (keep ARC writes, add reads):
- `GET /arc-v2/evaluation/:arcId/comm-eval/negotiation/approval-bundle` has the same shape as
  the RFQ approval bundle (`rounds_history`, `negotiation_instances`), plus `arc` header, `items`,
  `quotes` (only the rounds' items × vendors) and `qualified_by_item`. Access: ARC commercial
  read/evaluate/approve or `arc.admin` in the ARC's scope, OR the caller is an approver on one of this
  ARC's ARC_NEGOTIATION instances (policy approvers may hold no module role).
- Command center: target lookup understands `arc_item_id` / `is_arc_level`. ARC rounds use an ARC read
  scope (negotiation.read ∪ arc-comm.{read,evaluate,approve} ∪ arc.admin ∪ approver-on-ARC-instance).
  ARC actions: approve/reject = pending on me; close/next-round = `arc-comm.evaluate|arc.admin`.
  Line, vendor, withdraw and submit-quotes actions are always false. `POST /negotiation/rounds/:id/withdraw`
  refuses ARC rounds.
- Minimum window 120 minutes on RFQ and ARC create; ARC approve refuses a lapsed round (RFQ parity).

Frontend:
- Extract `NegotiationApprovalView` from `ApproveRoundPage`; RFQ and ARC loaders feed it. ARC keeps
  its URL `/rate-contracts/:contractId/negotiation/:roundId/approve` (the notification link).
- ARC → RFQ product shape via the existing `normalizeArcProducts`; ARC round → review entries via a new
  adapter function.
- Level 2 ARC page at `/dashboard/buyer/negotiation/arc/:arcId` reusing `RfqNegotiationPage`.

## Left to the builder

Copy wording beyond what is quoted in the plan, internal helper names, test fixture ids.
