# Client enhancement batch — the four things that need a product decision

**For:** product / the client conversation
**From:** the September 2026 client-feedback batch (items 1–13)
**Status:** everything else in the batch is built, tested and committed. These four are
deliberately *not* built, because each one rests on a decision the code cannot make.

---

## 1. ARC multi-select department (feedback item 2)

**The ask:** "Allow multi-select of departments while creating an ARC; if that isn't feasible,
allow multi-select of stores instead."

### Two things worth saying back to the client first

**"Multi-select of stores" is not the cheaper fallback it sounds like.** There is no store
entity in this product. Zero tables and zero columns match `store`, `warehouse` or `outlet`, and
"Stores" is not one of the 15 seeded departments. Offering it would mean a new table, CRUD, an
admin screen, hotel scoping and a new RBAC axis — strictly *more* work than multi-department,
not less. If they mean a *department* called Stores, adding that row is a five-minute change.

**A narrower cut may be all they actually need.** The department field's own on-screen caption
is *"scopes who can raise MRs against this ARC"*. If that is the real requirement — more than
one department may draw against a contract — a `tbl_arc_consuming_departments` table read by
**only** `mrModel.js:601` and `mrController.js:97` delivers it at S/M size, leaving approvals,
RBAC and the contract PDF on a single owning department. Worth asking before funding the big
version.

### Why the full version is blocked, not merely large

`tbl_arc.department_id` is a single `NOT NULL` FK read in roughly 45 places. Most are
mechanical. One is not:

> **When an ARC spans three departments, how does the approval policy resolve?**
> Union of all three departments' approvers? Most-specific-wins? One approval instance per
> department?

`generalModel.js:2135-2210 resolveApprovers` takes a **single** `department_id`. The policy
specificity ladder at `:1769-1775` has no defined answer for a multi-valued department. And
`tbl_approval_instances` itself stores one `department_id` per instance — so "which department
approved this" stops having an answer.

That is a governance question about who signs off on spend, not a schema question. Nobody
should guess it.

### Other hard blockers, for scoping

| Where | What breaks |
|---|---|
| `mrModel.js:601` | the MR contracted-item picker joins `a.department_id = $2` by **equality** — a multi-department ARC becomes invisible to all but one department |
| `mrController.js:88-103` | re-validates every MR line against the same single value |
| `arcScope.js:127`,`:151`,`:161` | the RBAC clause behind every ARC create/update/publish/withdraw |
| `arcNotificationService.js:680-718` | five recipient lookups, each passing one department |
| `arcContractController.js:904` | the signed contract PDF prints one department name |

If it is funded: keep `tbl_arc.department_id` as the primary (exactly as `tbl_rfq.hotel_id` was
kept beside `tbl_rfq_hotel_mappings`) and copy `hospitalityModel.js:1105-1150
reconcileRFQHotels` verbatim.

---

## 2. The mandatory technical gate — retain it? (feedback item 6)

The client flagged this as an open internal discussion. One fact should frame it.

### The gate has never fired in production

Zero mandatory clauses have ever been configured — on staging or production. Zero of 48 ARC
tech-eval responses carry a non-NULL `mandatory_passed`. The feature exists, is fully
implemented, and is completely dormant.

It also exists on **ARC only**. The RFQ tech-eval has no `is_mandatory` column and no concept of
a mandatory clause at all.

The knockouts that *do* fire are plain minimum-passing-score ones, and they are mostly catching
non-responders rather than genuine technical failures:

| reject_message | count |
|---|---|
| `Did not meet minimum passing score (0% < 50%)` | 21 |
| `(0% < 60%)` | 11 |
| `(43% < 60%)` | 3 |
| `(52% < 60%)` | 3 |
| `(0% < 80%)` | 2 |

So the question to put to them is probably not *retain or remove*, but:

> **Why has nobody ever ticked the box?** Is it a feature they don't want, or one they don't
> know exists?

### The pain they attribute to it is caused by something else

This is the more useful finding. **RFQ commercial-gate Condition 1 is RFQ-WIDE.**

`rfqModel.js:6899-6927` (duplicated around `:6527`, with a write-side twin at
`technicalQualificationService.js:91-110` whose own header says *"IF YOU EDIT `vendorCondition`
IN rfqModel.js, EDIT THIS TOO"*) evaluates the vendor's technical clearance against the **RFQ**,
not the product. So a vendor who fails technical on the single product that had an evaluation
configured is dropped from **every line of the RFQ** — including lines with no technical
evaluation at all.

That is the "all 14 lines hid" behaviour. It is an M-sized fix on its own, it is almost
certainly what they actually want, and it is independent of the mandatory gate entirely.

---

## 3. PO rejection: should it stop destroying the award? (feedback item 7, phase 2)

The scoped half **has shipped**: a rejected PO now notifies the person who can amend it, the
page tells them, and `handleUpdatePO` gained the status guard it never had.

What is deferred is the loop underneath.

`handlePORejection` (`purchaseOrderController.js:785-869`) is destructive, not a pause. On
rejection it **archives and DELETEs** the `tbl_quote_finalization` row and **cancels** the
`NEGOTIATION_QUOTE` approval instance that produced the PO. By the time anyone reads the
"sent back to you" notification, the award the PO was built from is gone.

So today "amend and resubmit" means amending the PO document, not rebuilding the award behind
it. Production bears this out: **46 rejected PO approvals, exactly ONE purchase order ever
resubmitted.**

**The decision:** should rejection preserve the finalization instead of deleting it?

If yes, it needs a `sent_back` value on the `po_status` Postgres enum — which means a migration
plus an audit of every `status IN (…)` / `NOT IN (…)` list in the codebase. The dead-end
detector's two lists (`rfqModel.js:2812`, `rfqController.js:6425`) are the dangerous pair: a new
status added to one half and not the other silently breaks `hasDeadEndProduct`, which is what
currently reopens the RFQ for editing after its POs are rejected.

Also worth deciding at the same time: does this apply to **vendor** rejections
(`rejected_by_vendor`) too, or only to internal approver rejections? The client's wording was
"rejection by the awarding/commercial approver", so only the latter is built.

---

## 4. One overall comment box at finalize (feedback item 12) — blocked on a question

**We need to know which page the client is on.** This one may already be delivered.

| page | behaviour |
|---|---|
| `/dashboard/buyer/quote-comparison` (**new**) | **already has exactly one mandatory overall comment box**, fanned out to every finalized item |
| `/dashboard/buyer/quote-compare` (**legacy**) | opens `FinalizeVendorModal` per product × per vendor — awarding 14 lines means 14 separate 10-character justifications |

Both pages are live and both are linked from the navigation.

If they are on the legacy page, note that the real work is **adding multi-select across the
product matrix** (`ProductComparisonMatrix.js:1471`), not changing the textarea — legacy
finalize is genuinely one-product-at-a-time. `FinalizeVendorModal` also carries the budget check
and the existing-PO picker, which have to survive.

**Nothing is stranded by collapsing.** The per-item comment has exactly one live consumer —
`FinalizerCommentPanel` (`ApprovalWorkflowSection.js:253-256`) — and it reads
`tbl_approval_instances.metadata.finalization_comment` per rfq_product, not
`tbl_quote_finalization`. It is not in the PO PDF and is never shown to vendors. Historical data
keeps displaying correctly; no backfill.

For context on how much the per-item box is used today: of production RFQs with more than one
finalized line, **145 used the same text (or none) across every item, and 52 used genuinely
different text** covering 461 line items. But all 52 were awarded on the legacy page — the only
one that offers a per-item box. So read that as *"when the product offers it, a quarter of
buyers use it"*, not *"a quarter of buyers need it"*.

---

## Two defects found along the way, both fixed in this batch

Neither was reported by the client; both are worth knowing about.

1. **The Action Required list disagreed with the gate it advertised.** Whether a draft PO
   appeared in a user's bucket was decided by a company-wide "does this user hold
   awarding.create anywhere" boolean, while the initiate endpoint evaluates the grant against
   the PO's own hotel and department. A user granted at hotel A2 was shown hotel A1's drafts and
   then got a 403 on the click.

2. **`handleUpdatePO` had no status check at all.** The creator, or a legacy hierarchy member,
   could rewrite quantities and prices on a purchase order the vendor was already acting on, or
   on a completed one.

## One more thing to raise separately

`POST /rfq/update-buyer-marks` (`rfqRoutes.js:895-900`) has **no middleware beyond
`passportSignIn`** — no `acl()`, no workflow-state guard. The lock is frontend-only.

Production shows **1,629 mark changes, 1,539 of them by a different user than the original
scorer, 348 by someone holding approver authority on that very evaluation, and 12 made while the
approval instance was already open.** In other words the RFQ approver already amends marks —
through an unguarded side door, with no reason captured and no audit attribution.

Client feedback item 5 asked for a mandatory reason when an approver amends a mark. That is
**shipped for ARC**, where the amend path is a real, gated, audited endpoint. The RFQ side needs
the endpoint closed first, which is a security ticket rather than a UX one.
