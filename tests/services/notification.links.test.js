// Notification deep-link registry.
// ----------------------------------------------------------------------------
// Every notification destination used to be hand-built at its call site, six
// builders' worth, and several had rotted into hard 404s or pointed at a page
// that had been superseded. Nothing asserted on `action_url` anywhere, so the
// rot was invisible until a user clicked.
//
// This suite is that missing assertion. The route strings below were verified
// against the frontend `pages/` tree on 2026-08-07; if a page is renamed or
// removed, these break instead of production.
//
// The `PAGES` guard at the bottom is the important one: it re-reads the actual
// frontend route tree and fails when a link the registry emits no longer
// resolves to a real page.

import { describe, it, expect } from "@jest/globals";
import fs from "fs";
import path from "path";
import links from "../../app/services/notificationLinks.js";

const {
  buyerRfqDetail,
  vendorRfqDetail,
  buyerQuoteComparison,
  buyerTechnicalEvaluation,
  buyerPoDetail,
  buyerPoApproval,
  vendorPoDetail,
  buyerArcDetail,
  arcVendorContract,
  arcVendorContractAccept,
  arcVendorQuote,
  arcVendorRequests,
  arcVendorAmendments,
  buyerMrDetail,
  buyerMrList,
  queryThread,
  approvalActionUrl,
  entityLabel,
  toAbsoluteUrl,
  buyerHome,
  vendorHome,
} = links;

describe("route shapes", () => {
  it("sends a buyer to the RFQ workspace, not the vendor inquiry page", () => {
    // Buyers used to land on /dashboard/vendor/inquiries-details?type=buyer-view,
    // a stranded legacy branch that no frontend code links to and which is
    // missing the entire redesigned stage timeline.
    expect(buyerRfqDetail(354)).toBe(
      "/dashboard/buyer/rfq-management-details?type=buyer-view&id=354"
    );
  });

  it("carries stage and approval focus when asked", () => {
    expect(buyerRfqDetail(354, { stage: "technical", focusApproval: true })).toBe(
      "/dashboard/buyer/rfq-management-details?type=buyer-view&id=354&stage=technical&focus=approval"
    );
  });

  it("sends a vendor to the inquiry page keyed on id, never rfq", () => {
    // `?rfq=` renders a completely blank page: the component reads `id`, and
    // with it undefined none of its three render branches are true.
    expect(vendorRfqDetail(359)).toBe("/dashboard/vendor/inquiries-details?id=359");
  });

  it("uses the current comparison page, not the superseded one", () => {
    expect(buyerQuoteComparison(359)).toBe("/dashboard/buyer/quote-comparison?rfq=359");
    expect(buyerQuoteComparison(359)).not.toContain("/quote-compare?");
  });

  it("points a finalization approval at the specific product card", () => {
    expect(buyerQuoteComparison(359, { rfqProductId: 88, focusApproval: true })).toBe(
      "/dashboard/buyer/quote-comparison?rfq=359&rfq_product_id=88&focus=approval"
    );
  });

  it("uses the current PO detail page keyed on PO id", () => {
    expect(buyerPoDetail(61)).toBe("/dashboard/buyer/purchase-orders/61");
    expect(vendorPoDetail(61)).toBe("/dashboard/vendor/purchase-orders/61");
  });

  it("never emits the retired vendor order-book route", () => {
    // /dashboard/vendor/order-book is a redirect stub that discards its query
    // string, so a deep link there silently became an unfiltered list.
    expect(vendorPoDetail(61)).not.toContain("order-book");
  });

  it("routes technical-evaluation approvals to the RFQ technical stage", () => {
    // The standalone evaluation page ignores rfq_id entirely.
    expect(buyerTechnicalEvaluation(363)).toBe(
      "/dashboard/buyer/rfq-management-details?type=buyer-view&id=363&stage=technical&focus=approval"
    );
  });

  it("shares one query page between roles", () => {
    expect(queryThread(363, "buyer")).toBe("/dashboard/buyer/query?rfq_id=363&role=buyer");
    expect(queryThread(363, "vendor")).toBe("/dashboard/buyer/query?rfq_id=363&role=vendor");
  });

  it("deep-links a material requisition", () => {
    expect(buyerMrDetail(812)).toBe("/dashboard/buyer/material-requisitions/812");
    expect(buyerMrList({ tab: "for_me" })).toBe(
      "/dashboard/buyer/material-requisitions/all?tab=for_me"
    );
  });

  it("lands users on a real home, never the Coming Soon placeholder", () => {
    expect(buyerHome()).toBe("/dashboard/buyer");
    expect(vendorHome()).toBe("/dashboard/vendor");
    expect(buyerHome()).not.toBe("/dashboard");
  });
});

describe("ARC id semantics", () => {
  // The single most damaging bug this registry replaces. The buyer route is
  // keyed on tbl_arc.id; the vendor contract routes are keyed on
  // tbl_arc_contract.id and 403 when handed the wrong one. Measured on staging,
  // 14 of 19 vendor ARC links pointed at a contract the recipient did not own.
  it("keys the buyer workspace on the ARC id", () => {
    expect(buyerArcDetail(13)).toBe("/dashboard/buyer/rate-contracts/13");
    expect(buyerArcDetail(13, { stage: "awarding" })).toBe(
      "/dashboard/buyer/rate-contracts/13?stage=awarding"
    );
  });

  it("keys the vendor contract pages on the CONTRACT id", () => {
    expect(arcVendorContract(47)).toBe("/dashboard/vendor/rate-contracts/47");
    expect(arcVendorContractAccept(47)).toBe("/dashboard/vendor/rate-contracts/47/accept");
  });

  it("keys the vendor quote wizard on the ARC id, because no contract exists yet", () => {
    expect(arcVendorQuote(13)).toBe("/dashboard/vendor/rate-contracts/13/quote");
  });

  it("treats the vendor requests list as a leaf page with no id segment", () => {
    // `/rate-contracts/requests/<id>` matches no route at all — `requests` is a
    // page, not a directory.
    expect(arcVendorRequests()).toBe("/dashboard/vendor/rate-contracts/requests");
    expect(arcVendorRequests({ tab: "submitted" })).toBe(
      "/dashboard/vendor/rate-contracts/requests?tab=submitted"
    );
    expect(arcVendorAmendments()).toBe("/dashboard/vendor/rate-contracts/amendments");
  });
});

describe("approval routing", () => {
  it("names every ARC entity type instead of leaking the raw enum", () => {
    // Users were shown "Action required: Approve ARC_PUBLISH #ID-12".
    for (const t of [
      "ARC_PUBLISH", "ARC_TECH", "ARC_COMMERCIAL",
      "ARC_COMMITTEE", "ARC_NEGOTIATION", "ARC_AMENDMENT", "MR",
    ]) {
      const label = entityLabel(t);
      expect(label).not.toBe(t);
      expect(label).not.toMatch(/_/);
    }
  });

  it("deep-links every ARC approval to its own stage", () => {
    const ctx = { arc_id: 12 };
    expect(approvalActionUrl("ARC_PUBLISH", 12, ctx)).toBe(
      "/dashboard/buyer/rate-contracts/12?stage=overview"
    );
    expect(approvalActionUrl("ARC_TECH", 12, ctx)).toBe(
      "/dashboard/buyer/rate-contracts/12?stage=technical"
    );
    expect(approvalActionUrl("ARC_COMMERCIAL", 12, ctx)).toBe(
      "/dashboard/buyer/rate-contracts/12?stage=commercial"
    );
    expect(approvalActionUrl("ARC_COMMITTEE", 12, ctx)).toBe(
      "/dashboard/buyer/rate-contracts/12?stage=awarding"
    );
  });

  it("routes a negotiation-round approval to the round approve screen", () => {
    expect(approvalActionUrl("ARC_NEGOTIATION", 169, { arc_id: 18, round_id: 169 })).toBe(
      "/dashboard/buyer/rate-contracts/18/negotiation/169/approve"
    );
  });

  it("no longer sends any approval to the bare dashboard", () => {
    // Every ARC_* type fell through to `/dashboard` — a Coming Soon page.
    for (const t of [
      "RFQ", "TENDER", "TECHNICAL", "NEGOTIATION", "PO", "MR",
      "ARC", "ARC_PUBLISH", "ARC_TECH", "ARC_COMMERCIAL",
      "ARC_COMMITTEE", "ARC_NEGOTIATION", "ARC_AMENDMENT",
    ]) {
      const url = approvalActionUrl(t, 12, { rfq_id: 12, arc_id: 12, mr_id: 12, po_id: 12 });
      expect(url).not.toBe("/dashboard");
      expect(url).toBeTruthy();
    }
  });

  it("never points the retired ARC committee page", () => {
    // /dashboard/buyer/arc-committee was deleted with ARC v1 but the link map
    // still referenced it.
    expect(approvalActionUrl("ARC", 13, { arc_id: 13 })).not.toContain("arc-committee");
  });

  it("refuses to guess when a finalization carries no RFQ id", () => {
    // Emitting `?rfq=<product id>` would drop the approver into a different RFQ.
    expect(approvalActionUrl("NEGOTIATION_QUOTE", 88, {})).toBeNull();
    expect(approvalActionUrl("NEGOTIATION_QUOTE", 88, { rfq_id: 88 })).toBeNull();
    expect(approvalActionUrl("NEGOTIATION_QUOTE", 88, { rfq_id: 359 })).toBe(
      "/dashboard/buyer/quote-comparison?rfq=359&rfq_product_id=88&focus=approval"
    );
  });

  it("returns null for an unknown entity type rather than a wrong record", () => {
    expect(approvalActionUrl("SOMETHING_NEW", 1, {})).toBeNull();
  });
});

describe("relative vs absolute", () => {
  it("keeps in-app links relative so a row works in every environment", () => {
    // Baking the production host into the row is what sent staging and local
    // users to production when they clicked a notification.
    const all = [
      buyerRfqDetail(1), vendorRfqDetail(1), buyerQuoteComparison(1),
      buyerPoDetail(1), vendorPoDetail(1), buyerArcDetail(1),
      arcVendorContract(1), arcVendorQuote(1), arcVendorRequests(),
      buyerMrDetail(1), queryThread(1, "buyer"), buyerHome(), vendorHome(),
    ];
    for (const url of all) {
      expect(url.startsWith("/")).toBe(true);
      expect(url).not.toMatch(/^https?:/);
    }
  });

  it("absolutises for email without depending on the env var being set", () => {
    const prev = process.env.FRONT_END_WEBSITE;
    try {
      process.env.FRONT_END_WEBSITE = "https://staging.example.com";
      expect(toAbsoluteUrl("/dashboard/buyer")).toBe("https://staging.example.com/dashboard/buyer");

      // Unset used to yield the literal string "undefined/dashboard/...".
      delete process.env.FRONT_END_WEBSITE;
      expect(toAbsoluteUrl("/dashboard/buyer")).toBe(
        "https://hospitality.letsworkwise.com/dashboard/buyer"
      );
      expect(toAbsoluteUrl("/dashboard/buyer")).not.toMatch(/undefined/);
    } finally {
      if (prev === undefined) delete process.env.FRONT_END_WEBSITE;
      else process.env.FRONT_END_WEBSITE = prev;
    }
  });

  it("leaves an already-absolute URL alone", () => {
    expect(toAbsoluteUrl("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("missing identifiers", () => {
  it("returns null rather than emitting a link to record 'undefined'", () => {
    for (const fn of [
      buyerRfqDetail, vendorRfqDetail, buyerQuoteComparison, buyerPoDetail,
      vendorPoDetail, buyerArcDetail, arcVendorContract, arcVendorQuote, buyerMrDetail,
    ]) {
      expect(fn(null)).toBeNull();
      expect(fn(undefined)).toBeNull();
      expect(fn("")).toBeNull();
      expect(fn(0)).toBeNull();
    }
  });

  it("falls back to a usable page when a PO id is unknown", () => {
    expect(buyerPoApproval(61, 359)).toBe("/dashboard/buyer/purchase-orders/61");
    expect(buyerPoApproval(null, 359)).toBe(
      "/dashboard/buyer/rfq-management-details?type=buyer-view&id=359&stage=purchase-order&focus=approval"
    );
    expect(buyerPoApproval(null, null)).toBe("/dashboard/buyer/purchase-orders");
  });
});

// ─── The guard that actually catches route rot ───────────────────────────────
//
// This one reads the FRONTEND repo's route tree, so it can only run where that
// tree is on disk. Backend CI checks out this repo alone, so there it is
// skipped rather than failed — a cross-repo invariant cannot be a single-repo
// gate, and asserting against a checked-in copy of the route list would only
// re-state what the per-route assertions above already pin.
//
// It resolves the frontend as a sibling of the backend, which holds for a normal
// two-repo checkout and for matched git worktrees. Set NOTIFICATION_LINKS_FRONTEND_DIR
// to point it anywhere else — e.g. a combined CI job that checks out both.

const resolveFrontendPages = () => {
  // An explicit setting wins outright, so a caller can point this at a specific
  // checkout — or at nothing, to exercise the skip path.
  const dir =
    process.env.NOTIFICATION_LINKS_FRONTEND_DIR ||
    path.resolve(process.cwd(), "..", "frontend");

  const pages = path.join(dir, "pages");
  try {
    return fs.statSync(pages).isDirectory() ? pages : null;
  } catch (_) {
    return null;
  }
};

const PAGES = resolveFrontendPages();
const describeIfFrontend = PAGES ? describe : describe.skip;

describeIfFrontend("every emitted link resolves to a real frontend page", () => {
  const routeExists = (urlPath) => {
    const clean = urlPath.split("?")[0].split("#")[0].replace(/^\/+|\/+$/g, "");
    const segs = clean ? clean.split("/") : [];

    const walk = (dir, i) => {
      if (i === segs.length) {
        return [".js", ".jsx", ".ts", ".tsx"].some((e) =>
          fs.existsSync(path.join(dir, `index${e}`))
        );
      }
      const seg = segs[i];
      const isLast = i === segs.length - 1;

      // A static file wins over a dynamic segment, matching Next's precedence.
      if (isLast) {
        for (const e of [".js", ".jsx", ".ts", ".tsx"]) {
          if (fs.existsSync(path.join(dir, `${seg}${e}`))) return true;
        }
      }
      if (fs.existsSync(path.join(dir, seg)) && fs.statSync(path.join(dir, seg)).isDirectory()) {
        if (walk(path.join(dir, seg), i + 1)) return true;
      }
      // Fall back to a [dynamic] directory or leaf.
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (_) {
        return false;
      }
      for (const entry of entries) {
        if (!entry.startsWith("[")) continue;
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          if (walk(full, i + 1)) return true;
        } else if (isLast && /^\[[^\]]+\]\.(js|jsx|ts|tsx)$/.test(entry)) {
          return true;
        }
      }
      return false;
    };

    return walk(PAGES, 0);
  };

  const EVERY_LINK = [
    buyerHome(), vendorHome(),
    buyerRfqDetail(1), links.buyerRfqList(), vendorRfqDetail(1), links.vendorRfqList(),
    buyerQuoteComparison(1), buyerTechnicalEvaluation(1),
    buyerPoDetail(1), links.buyerPoList(), vendorPoDetail(1), links.vendorPoList(),
    buyerArcDetail(1), links.buyerArcList(),
    arcVendorContract(1), arcVendorContractAccept(1), arcVendorQuote(1),
    arcVendorRequests(), arcVendorAmendments(),
    buyerMrDetail(1), buyerMrList(),
    links.buyerNegotiationRound(1), links.buyerNegotiationApprove(1),
    queryThread(1, "buyer"), links.buyerClarifications(1),
    links.vendorSubscription(), links.vendorProfile(), links.buyerProfile(),
    approvalActionUrl("ARC_NEGOTIATION", 1, { arc_id: 1, round_id: 2 }),
  ];

  it("is reading a real route tree, not an empty directory", () => {
    // Without this the walk below would return false for everything and the
    // suite would look like it had caught 29 dead links.
    expect(fs.existsSync(path.join(PAGES, "dashboard"))).toBe(true);
  });

  it("reports a route that genuinely does not exist", () => {
    // Proves the walk can still fail — otherwise a bug that made routeExists
    // always return true would leave this whole guard silently useless.
    expect(routeExists("/dashboard/buyer/rfq-details")).toBe(false);
    expect(routeExists("/dashboard/buyer/arc-committee")).toBe(false);
    expect(routeExists("/dashboard/vendor/rate-contracts/requests/1")).toBe(false);
  });

  it.each(EVERY_LINK)("%s", (url) => {
    expect(routeExists(url)).toBe(true);
  });
});
