# `approval:changed` — push for the pending-approval badge

Backend half of PORTAL_PERF_PLAN_2026-10 Phase 3 ("push instead of poll").
`GET /api/v1/general/hospitality/approval/pending/counts` is polled every 5 s
from two always-mounted navs and is ~45% of all backend time. The backend now
pushes a signal whenever someone's pending set may have changed.

## Contract

| | |
|---|---|
| Event | `approval:changed` |
| Room | `user:<id>` — the socket is placed there from its handshake token (and by `addNewUser`, which the frontend already emits on connect) |
| Payload | `{ entity_type: string, entity_id: number }` — a signal only, **no counts, no names** |
| Client action | refetch `/approval/pending/counts` (and any open approval view for that entity). Duplicates / out-of-order frames are harmless. |

Emitted after COMMIT of every write that can change a pending set:
instance created (incl. auto-skipped steps), step approved / rejected (step
advance, instance approve / reject), instance cancelled (generic cancel, RFQ
edit / withdraw / close / re-submit, PO edit, negotiation round cancel /
expiry, ARC send-back), RFQ auto-approval on publish, approver reassigned,
approver / step added or removed mid-flight (policy propagation, membership and
role-permission revalidation). Delegation takes effect at resolution (instance
creation), so it is covered by "instance created".

Recipients: every user with an approver row on the instance, any status
(REMOVED tombstones included).

Not emitted: APPROVED → CANCELLED heals (no pending set changes), or inside a
transaction that rolls back.

## Recommended client behaviour

- On `approval:changed`: refetch counts (debounce ~300 ms; several frames can
  arrive for one action).
- Also refetch on window focus / `visibilitychange` → visible.
- Poll only while the socket is disconnected (e.g. 60 s), not at all while
  connected.

Implementation: `app/services/approvalEvents.js` (`notifyApprovalChanged`).
Tests: `tests/services/approval.changedEvent.test.js`.
