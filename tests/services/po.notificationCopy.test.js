// The words of the PO rejection and hold notices (E2E defects 6 and 6b).
// ----------------------------------------------------------------------------
// 6:  a hold closed because the approval's steps changed, or because the
//     approval was cancelled, used to tell the person asked "the approval was
//     restarted". Nothing restarts on those paths.
// 6b: a comment is quoted inside our own sentence, `"{comment}".`, so one that
//     already ended a sentence read `"…line 3.".`.
//
// The copy builders are pure; the product-level checks of the same text are in
// po.sendBack.supersede / po.sendBack.infoRequest / po.reject.reaward /
// po.reject.cancelRoute.

import { describe, it, expect } from "@jest/globals";

const { buildSendBackCopy, CLOSED_BECAUSE } = await import("../../app/services/po/poSendBackNotifier.js");
const { buildRejectionCopy } = await import("../../app/services/po/poRejectionNotifier.js");

const ctx = (over = {}) => ({
  po_id: 7,
  po_number: "PO-7",
  rfq_id: 3,
  rfq_no: 536900,
  reason_category: "INFO_MISSING",
  comment: null,
  response_text: null,
  requested_by_name: "Asha",
  resolution: null,
  ...over,
});
const po = { id: 7, po_number: "PO-7", rfq_id: 3, rfq_no: 536900 };

describe("why a hold was closed", () => {
  it.each([
    ["PO_AMENDED_RESTARTED", "the PO was edited"],
    ["RFQ_CLOSED", "the RFQ was closed"],
    ["PO_SUPERSEDED", "the approval steps for this PO changed"],
  ])("%s reads: closed because %s", (resolution, why) => {
    const { body } = buildSendBackCopy("closed", { ctx: ctx({ resolution }) });
    expect(body).toBe(`The request for information on PO PO-7 was closed because ${why}. Nothing more is needed from you.`);
  });

  it("the cancel path's own reason wins over the resolution's", () => {
    const { body } = buildSendBackCopy("closed", {
      ctx: ctx({ resolution: "PO_SUPERSEDED" }),
      because: "the approval was cancelled",
    });
    expect(body).toBe(
      "The request for information on PO PO-7 was closed because the approval was cancelled. Nothing more is needed from you."
    );
  });

  it("no closed hold is ever explained as a restart", () => {
    for (const why of Object.values(CLOSED_BECAUSE)) expect(why).not.toMatch(/restart/i);
    const { body } = buildSendBackCopy("closed", { ctx: ctx({ resolution: null }) });
    expect(body).not.toMatch(/restart/i);
  });
});

describe("a quoted comment ends with exactly one full stop", () => {
  // [as typed, as quoted inside our sentence]
  const cases = [
    ["Need the invoice", '"Need the invoice".'],
    ["Need the invoice.", '"Need the invoice."'],
    ["Why so high?", '"Why so high?"'],
    ["Urgent!", '"Urgent!"'],
    ["Wait…", '"Wait…"'],
    ["  Spaced out.  ", '"Spaced out."'],
  ];

  it.each(cases)("rejection notice: %j", (comment, quoted) => {
    const { body } = buildRejectionCopy({ po, actorName: "Asha", route: "COMMERCIAL", reasonCategory: "PRICE_TAX_QUERY", comment });
    expect(body).toBe(
      `PO PO-7 was rejected by Asha: Question on price, GST or calculation. ${quoted} It is back in commercial evaluation for re-award.`
    );
  });

  it.each(cases)("cancel notice: %j", (comment, quoted) => {
    const { body } = buildRejectionCopy({ po, actorName: "Asha", route: "CANCEL", reasonCategory: "NOT_REQUIRED", comment });
    expect(body).toBe(
      `PO PO-7 was rejected by Asha: Not needed any more. ${quoted} It was cancelled as not needed. ` +
        "Please close RFQ 536900 if nothing else is required."
    );
  });

  it.each(cases)("hold notices: %j", (comment, quoted) => {
    expect(buildSendBackCopy("requested", { ctx: ctx({ comment }), actorName: "Asha" }).body).toBe(
      `Asha asked you for information on PO PO-7 (RFQ 536900): Need more details or justification. ${quoted} The approval waits until you answer.`
    );
    expect(buildSendBackCopy("reminder", { ctx: ctx({ comment }) }).body).toBe(
      `Asha asked you for information on PO PO-7 (RFQ 536900): Need more details or justification. ${quoted} The approval is waiting for your answer.`
    );
    expect(buildSendBackCopy("answered", { ctx: ctx({ response_text: comment }), actorName: "Ravi" }).body).toBe(
      `Ravi answered the request for information on PO PO-7 (RFQ 536900). ${quoted} The approval can continue.`
    );
  });

  it("a blank comment is not quoted at all", () => {
    for (const comment of [null, "", "   "]) {
      expect(buildRejectionCopy({ po, actorName: "Asha", route: "COMMERCIAL", reasonCategory: "OTHER", comment }).body).toBe(
        "PO PO-7 was rejected by Asha: Something else. It is back in commercial evaluation for re-award."
      );
      expect(buildSendBackCopy("requested", { ctx: ctx({ comment }), actorName: "Asha" }).body).toBe(
        "Asha asked you for information on PO PO-7 (RFQ 536900): Need more details or justification. The approval waits until you answer."
      );
    }
  });
});
