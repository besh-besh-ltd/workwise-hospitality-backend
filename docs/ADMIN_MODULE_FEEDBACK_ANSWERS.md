# Company admin — answers to the testing round

Written for the testing and product teams, in reply to the thirteen items
raised on the company admin module. It answers the questions, says what changed
for the defects, and gives a retest path for each.

Three items turned out to have a different cause than the report assumed, and
one "missing feature" was already built — those are called out, because
retesting the reported symptom would not have told you whether the real problem
was fixed.

Two things need a decision from product rather than a fix; they are at the end.

---

## The four questions

### 1. How does approval setup work? *(item 2)*

Eight ideas, in the order you meet them.

**Business unit.** Every approval workflow is scoped to one company *and* one
business unit. A unit with no workflow sends nothing for approval — it is not
that approvals are optional there, it is that nothing will ever be routed. The
unit grid on **Approvals → Setup** exists because "never configured" and
"configured" used to look identical.

**Process.** A named route through the business, e.g. "Day to Day Procurement".
RFQ and Tender flows hang off a process. **ARC (rate contracts) is deliberately
process-free** — an ARC never carries a process, so an ARC policy saved against
one can never be matched. See the open question at the end.

**Entity type.** *What* is being approved: RFQ, TENDER, PO, NEGOTIATION,
NEGOTIATION_QUOTE, TECHNICAL, and the five ARC stages.

**Stages.** The ordered route. RFQ: RFQ → Technical → Negotiation →
Negotiation Quote → PO. Tender: Tender → … → ARC.

**Levels (steps).** Within one stage, level 1..N. Approval moves down them in
order.

**Approver source.** Each level names either a **Specific User** or a
**User Role**. (The database also supports a Department source and some older
policies use it, but the wizard does not offer it.)

**Decision rule.** *Any one person can approve*, or *Everyone must approve*.
This is what makes a deactivated approver merely untidy on an ANY level and
genuinely blocking on an ALL level.

**Resolution.** When something is submitted, the engine turns each level's
source into actual people — filtered by company, unit, department and process,
and requiring that they hold both **view** and **approve** on that entity's
area. Somebody named on a level who does not hold both is dropped. Active cover
(see below) is applied at this moment.

Two consequences worth knowing:

- **Editing a live workflow affects approvals already in flight.** Before
  saving, the wizard tells you how many open approvals a change will touch.
- **Approvals are decided against the approvers resolved when they were
  created.** Changing a workflow does not retrospectively change who may
  approve something already open — moving those is what *Reassign* is for.

---

### 2. "You can create an administrator, reset someone's password, and you
can't accidentally remove the last admin" *(item 4)*

That bullet ran three separate things together. All three are built and working.

**Create an administrator.** An administrator is an ordinary buyer who also
holds the **Company Administrator** role. It is a capability, not a user type —
so promoting someone keeps all their existing access, and they stay visible in
every listing. Assign it like any other role on **People → edit a person**.

**Reset someone's password.** On the same screen. The administrator triggers
the reset; the employee receives it. **The administrator never sees the code.**

**You cannot remove the last administrator.** If you try to deactivate the only
remaining administrator — or take away the role that carries the capability —
the save is refused with:

> *"This is the only administrator left. Give someone else administrator access
> first, or the company will have nobody who can manage users, units and
> approvals."*

The check runs **before** the write, so nothing is half-saved. This matters
because nobody inside the company could undo it: creating administrators is
itself an administrator's power, so the company would be locked out of its own
configuration until we intervened directly in the database.

**To retest:** make a second administrator, then try to deactivate the first —
that must succeed. Remove the second, then try to deactivate the remaining one
— that must be refused with the message above.

---

### 3. "Every role listed, including the built-in ones, with permissions in
plain English" *(item 5)*

**This was already built** — and it was a real bug that made it look broken.

**Access** lists every role, splitting *built-in* (shipped with the platform,
not editable) from your own. Each role shows its permissions as words —
"RFQ Creation · View", "Technical Evaluation · Evaluate", "PO Awarding ·
Approve" — with a short description on hover, and a bar showing how much of the
catalogue the role covers.

What made it look empty: **a custom role was only visible to whoever created
it.** The roles query filtered on the calling user, so a role Admin A created
did not appear for Admin B — while the same role still showed up in the
assignment dropdowns. "Your roles: 0" next to a role you could clearly assign.

**Fixed.** Roles are now visible to everyone in the company. Built-in roles were
always visible to all; nobody loses sight of anything they could see before.

**To retest:** have one administrator create a custom role, then look at
**Access** as a *different* administrator in the same company. It must be
listed, with its permissions in words. An administrator of a *different*
company must still not see it.

---

### 4. Editing a company's details *(item 9)*

**This exists** — the pencil on the company header in **Organisation**. Twelve
fields: name, region, contact email, both addresses, GST, PAN, the four bank
fields, and MSME. Changes apply to the company and every unit under it.

Testing it turned up two real defects, both now fixed:

- **Replacement documents were silently discarded.** The form shows four file
  inputs when editing and the server accepts them, but the page sent the text
  fields only. You could attach a new GST certificate, be told "Company
  updated", and nothing left the browser. Now uploaded.
- **Nothing showed which unit is the Head Office.** The flag has been recorded
  and enforced in the database for a while — a company cannot have two — but no
  screen displayed it, so the only way to tell was to read the name. Now badged
  on the unit card.

---

## The defects, and how to retest them

| # | What you reported | What was actually wrong | Retest |
|---|---|---|---|
| 7 | Cover: usernames not in the dropdown | The people list arrives with `status: "active"`; the screen kept only `status === 1`. Nothing ever matched, so **cover had never once worked** — zero delegations exist in staging. | Approvals → Cover. Both dropdowns list active staff; arranging cover saves. |
| 3 | Duplicate role assignment shows no error | The server returned a proper message; the page threw it away and said "Failed to update user". | Assign a person the same role/scope twice. You should see *"This role assignment already exists for this user."* |
| 6 | Don't show people ineligible for reassignment | The list was "anyone with any role in this company" — no permission check at all. An admin could hand a purchase-order approval to someone the engine would refuse. | Approvals → In progress → Give it to. People who cannot approve *that* item are shown greyed with the reason, and are refused if forced. |
| 8 | Where do archived business units go? | Nowhere. Archiving hid the unit from every list and no screen could restore it. | Organisation → archive a unit. It now appears under **Archived business units** with a **Restore** button. |
| 1 | Overview shows no data (Phileein) | There was no admin Overview — the route rendered the *buyer's* dashboard, whose every panel needs an `RFQ view` permission administrators don't hold. Phileein also genuinely has no RFQs. | **/dashboard/admin** is now an administrator's page: blocked approvals, approvals waiting, critical activity, units, people, cover. Phileein is no longer blank. |
| 11 | Before/after shown as key-value pairs | Only the *formatting* — unchanged columns were already being dropped. Raw column names, raw timestamps, bare `true`, `tbl_rfq_purchase_order`. | Activity → expand a line. Fields read "Quote submission end date", dates read "05 Sep 2026, 02:30 pm", flags read Yes/No. Hover a field name for the raw column. |
| 13 | Only last 30 days of history | **There is no 30-day limit on the feed and never was** — that text was the label on the risk summary above it. The real cause: the backfill had never been run. | Staging now holds **3,606 entries back to 19 February**. Use the date filters to reach them. |
| 10 | When does "Cannot act" appear? | When an approver's account is deactivated while a step still lists them. Two screens ignored this and kept naming those people as people we were waiting on. | Deactivate a user named on an open approval. Every screen must now agree: excluded from "waiting on", shown as *Cannot act — account deactivated*. |
| 12 | "Critical only" toggle | It is the **Critical** tile on the risk summary. It worked, but counted 30 days while filtering an unbounded feed — so the number and the list disagreed. | Click **Critical**. The feed is now scoped to the same 30 days, unless you have set your own dates. |

---

## Two things that need a decision, not a fix

### Critical is 62% of the trail

Now that staging carries real history, **2,240 of the 2,248 "critical" entries
are ordinary approvals** — someone approving something. Critical is 62% of the
whole trail and 56% of the last thirty days.

That is the event catalogue's own rule, not a backfill mistake: approval
decisions are classified critical when captured live too. But it means
"Critical only" is not the short Monday-morning list item 12 describes.

The fix is a product judgement — probably that a *rejection*, a *reassignment*
or a *cancellation* is critical while a routine approval is merely notable. We
have not changed it unilaterally, because it would also split reconstructed
history from live capture. **Worth deciding before item 12 is retested.**

### Approval workflows saved against a process for ARC

ARC contracts never carry a process, and the engine matches a policy by
process, so **an ARC workflow saved under a process can never fire**. Staging
has 26 such workflows and production 1; none has ever been used.

They are now reported on the Approvals page rather than drawn as if configured,
but nobody has deleted them. Someone should.

---

## Two notes for whoever tests next

**Phileein's activity trail is empty, and that is correct.** It has no history
to reconstruct. Use Kamat (2,436 entries) to exercise the trail.

**Reconstructed history cannot be expanded.** Entries recovered from before
29 August carry no link to the row-level changes, so they show the sentence and
nothing more. That is by design — the detail genuinely was not recorded at the
time — and the screen says so rather than showing an empty box.
