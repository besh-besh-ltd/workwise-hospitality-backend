# Client feedback batch — what to check before we go live

**For:** product
**What this is:** the 13 items the client raised on 10 Aug. Eight are built and ready for you to try. Two are half-done on purpose. Two need a decision from you. One needs a single question answered — and it may already be finished.

Nothing is live yet. Once you've signed off, we merge.

---

## Part 1 — Ready for you to try (8 items)

### 1. A search box for Business Unit when creating an RFQ

**They asked for:** a way to find a business unit without scrolling.

**Try it:** Start a new RFQ. On the "Pick the business units" step there's now a search box above the list. Type part of a hotel name *or* a company name — both match. The list is sorted alphabetically now too, which it never was.

**Note:** the box only appears if you're mapped to **6 or more** business units. Most people have one, and a search box for one item is clutter. To see it, use an account mapped to Kamat (14).

---

### 3. Sampling asked per product, not once for everything

**They asked for:** the sampling clause to be specific to each product.

Two different things were wrong. Both fixed.

**On an RFQ:** open the clause screen for a product and look at the "Sampling Clause" card. It now asks **what sample you want** and lets you attach a file. Before, it only asked for marks and every product's clause literally said the word "Sampling" — so you could never write *"send two 500ml bottles, sealed"* for one product and something else for another.

**On a rate contract (ARC):** on the **Items** step each item has its own "Require a sample of this item" tick box. The **Terms** step no longer asks; it just reports how many items need one.

**Also check:** a supplier now sees a **"Sample required"** tag on those items. The setting existed before but was never actually shown to any supplier.

---

### 4. Attaching a document to a clause

**They asked for:** attach images/documents against each clause.

**Try it (rate contracts):** Create an ARC, go to the **Tech & vendors** step, add a clause, click **"Attach reference document"**. It now opens a file picker. Attach something, save, reopen the draft — it's still there.

**Check both readers:**
- The **supplier** sees it on their quote page labelled **"Buyer's reference:"** — read-only, no delete button. Their own evidence files stay separate and still deletable.
- The **evaluator** sees a **"Reference doc"** link beside the clause while scoring.

**Worth knowing:** this already worked on RFQs. On rate contracts the storage existed but the button was decorative — drawn on screen, did nothing.

---

### 8. Approving a negotiation line by line

**They asked for:** approve/reject per line item, not the whole round.

**Try it:** Create a negotiation round covering two or more products, open it as the approver. Each line now has a **withhold** tick box. Tick one, then approve.

**What should happen:** the round goes live, but the withheld line **is not sent to the supplier** — they only re-quote what you approved. You can open a fresh round on the withheld line immediately; it isn't blocked.

**One deliberate refusal:** withhold *every* line and it won't let you approve. That's a rejection, and Reject is the button that cancels the round and tells its creator why.

---

### 9. A tooltip on "Force Initiate"

**Try it:** Open a draft purchase order that doesn't cover every product on its RFQ — the button reads **Force Initiate** in amber. There's now an **i** icon beside it explaining how many products of how many this covers, that initiating **freezes** the order, that anything finalised afterwards becomes a **separate** purchase order, and that it can't be undone.

The plain green **Initiate** has its own calmer version.

**Deliberately not said:** "this sends it to the vendor." It only reaches the vendor if no approval step applies — otherwise it goes to approvers first.

---

### 10. Helping the Commercial Approver initiate a draft PO

This turned out **not to be a permissions problem** — the Commercial Approver already had the right. They couldn't find the drafts, and nothing said it was their move.

**Try it:**
1. Purchase orders list — new **Draft** tab with a count. Drafts used to be reachable only by scrolling "All".
2. Open a draft you can initiate — a note says *"This purchase order is a draft and is waiting for you to initiate it — nothing else is blocking it."*
3. If other drafts exist for the same supplier on the same RFQ, it says so and suggests merging first — because once you initiate, they become separate orders.

**Also fixed:** clicking Initiate twice used to say "Purchase order has been initiated" both times, even though the second click did nothing.

**Context:** production had 7 drafts stuck this way, oldest 32 days, every one ready to go.

---

### 11. Choosing L2, L3 and L4 approvers at once

**Try it:** Admin, approval workflow, expand a stage. Below "Add Next Approval Level" there's now a multi-select. Pick three people, click **"Add 3 levels"** — you get L2, L3, L4 in the order picked.

**Confirm with the client.** We read this as *"pick three people, get three levels"* — one approver per level. If they meant *"three people on the same level"*, that's a different feature and a much bigger change. Please check the wording.

---

### 13. Showing the RFQ number and title when a supplier accepts a PO

**Try it (as a supplier):** open a purchase order awaiting acceptance.
- The header shows the RFQ **number and title**, not just the number.
- The **Accept** and **Reject** confirmations now name the RFQ. That's the moment the decision is made, and they previously named neither.

**Also check the email.** The "please accept or reject" email and its three reminders now carry the RFQ title in the body *and* the subject. They had only the number — so a supplier bidding on several of your RFQs couldn't tell which one the order was for.

---

## Part 2 — Half-done, on purpose (2 items)

### 5. A mandatory reason when a technical approver changes a mark

**Done for rate contracts.** As the technical approver, tick "Amend marks before approving", change a mark, try to approve **without** a reason — it stops you. Rejecting already required a reason; changing someone else's score didn't — and that reason is what the audit trail stores, so it was recording *what* changed and nothing about *why*.

**Not done for RFQs, and here's the honest reason.** On the RFQ side there's a way to change marks with **no permission check on it at all** — anyone logged in can call it. Adding a "reason required" box to the screen wouldn't help, because the screen isn't what's protecting it.

Not theoretical. In production: **1,629 mark changes**, **1,539 by someone other than the original scorer**, **348 by someone with approver authority over that very evaluation**, and **12 while the approval was still open**.

We'd like to raise that as its own piece of work. **It's the most serious thing we found.**

---

### 7. Sending a rejected PO back to the originator

**What's done.** When an approver rejects a purchase order, the person who created it now gets a notification — *"Sent back to you"* — with the rejecter's actual words and a link to the order. The order page says the same.

Worth knowing: the reject dialog has **always promised this**. It literally says "will be rejected and returned to the initiator". Nothing ever did it. Now it's true.

**What's not done, and needs your decision.** Rejecting a PO currently **deletes the award underneath it**. So by the time the originator reads "amend and resubmit", the thing they'd amend is gone.

The numbers: **46 purchase orders rejected in production, exactly one ever resubmitted.** Everything else just stopped.

**The question:** should rejecting a PO *pause* it instead of tearing it down? That's a real change to how the system behaves and we didn't want to decide it quietly.

---

## Part 3 — We need an answer from you (3 items)

### 12. One comment box when finalising, instead of one per item

**This may already be done — we just need to know which screen they use.**

Two Quote Comparison screens are live:

| Screen | Behaviour |
|---|---|
| The **newer** one | **Already has exactly one comment box** for the whole finalisation |
| The **older** one | A separate comment for every product x supplier — award 14 lines, write 14 justifications |

**Please ask the client which page they're on.** If it's the newer one, this item is finished. If it's the older one, we'll fix it — but the real work there is letting them select several products at once, not the comment box.

**Reassuring:** collapsing to one box loses nothing. The per-item comments are only displayed in one place, and that place reads them per product anyway. Historical data keeps showing correctly.

---

### 2. Multi-select departments on an ARC

**Two things to put to the client before anyone estimates this.**

**First: "multi-select of stores instead" is not the easier option.** There is no concept of a "store" anywhere in the product — no list, no screen, nothing. Building it means a new thing to create and manage, plus admin screens and permissions. It is **bigger** than multi-department, not smaller. If they mean a *department* called "Stores", we can add that in minutes.

**Second: the full version is blocked on a governance question, not on effort.** The field's own label says it "scopes who can raise requisitions against this contract". If a contract belongs to three departments:

> **Who has to approve it?** Everyone from all three? Just the most specific one? Or three separate approvals?

The system has one answer per contract today and there's no sensible default. That's a policy question about who signs off on money — we shouldn't guess it.

**A cheaper option worth offering:** if what they want is "more than one department can order against this contract", we can do just that — leave approvals and permissions alone and only widen who can raise requisitions. Much smaller, much safer, possibly the whole ask.

---

### 6. Should the mandatory gate stay?

They flagged this as an open internal discussion. One fact should frame it.

**The mandatory gate has never once been used in production.** Not a single clause has ever been marked mandatory, on staging or live. Fully built, completely dormant. It also only exists on rate contracts — RFQs have no such concept at all.

So the question probably isn't "keep or remove" but **"why has nobody ever ticked the box?"** Is it something they don't want, or don't know is there?

**And the pain they describe comes from somewhere else.** There's a separate behaviour where a supplier failing the technical check on **one** product is dropped from **every** line of that RFQ — including lines with no technical check at all. That's almost certainly the "all the lines disappeared" complaint. Different fix, smaller, and probably what they actually want.

---

## Part 4 — Two things we fixed that nobody reported

1. **"Pending for me" showed purchase orders people couldn't act on.** The list used a looser rule than the button did, so a user could see a draft, click it, and be refused.
2. **Purchase orders could be edited after the supplier had them.** Nothing stopped someone changing quantities or prices on an order already approved, sent, or completed. There is now.

---

## Part 5 — Before we merge

1. **A database change needs applying.** One small change (per-item sampling) goes to staging then production as part of this release. Safe, and carries existing settings forward automatically — but it must not be forgotten.
2. **Two items can't be properly tested on staging as it stands.** Staging has no draft purchase orders, no multi-line negotiation rounds awaiting approval, and its Commercial Approver account has weaker permissions than the real one. We need realistic data seeded first, or testing items 8 and 10 there will show the wrong behaviour.
3. **Three answers from the client:** which Quote Comparison screen (12), what "L2, L3, L4 at once" means exactly (11), and whether to fund departments (2) or the narrower version.

---

## Summary

| | Count | Items |
|---|---|---|
| **Built and ready to verify** | 8 | 1, 3, 4, 8, 9, 10, 11, 13 |
| **Half-done on purpose** | 2 | 5, 7 |
| **Waiting on your decision** | 2 | 2, 6 |
| **Waiting on one question** | 1 | 12 |

Everything built has been tested — roughly 4,000 automated checks across both halves of the system are passing, including new ones written specifically for each item above.

**The most interesting finding:** five of the thirteen were *already built* and simply unreachable — a button that did nothing, a field that couldn't be typed into, a tooltip that only appeared when the button was disabled. The client is describing a discoverability problem at least as much as a missing-feature problem, and that's worth saying back to them.
