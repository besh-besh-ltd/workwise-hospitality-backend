// Action emails must be readable and tappable on a phone.
//
// The entry point for an approver or vendor on a phone is almost always the
// email ("PO awaits your approval", "Submit your quote"). The shared layout used
// to be a bare <div> fragment with no <head>: phone clients laid it out at a
// ~980px desktop viewport and shrank it, and the CTA was a small padded link.
// Prod: PO approvals take a median 29.5h to decide; 25% of vendors use phones.
//
// Product-level per CONVENTIONS.md §1: we drive the real production email
// builders and read the HTML that would land in the inbox. The only mocks are
// the mail transport, the in-app dispatch, and the PO product/user lookups
// (so no DB is needed). Nothing is sent.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const sentMails = [];

jest.unstable_mockModule("../../app/helper/common.js", () => ({
  sendMail: (opts) => {
    sentMails.push(opts);
    return Promise.resolve(true);
  },
  logError: () => {},
}));

jest.unstable_mockModule("../../app/services/notificationService.js", () => ({
  dispatch: async () => {},
  resolveRecipientUserIds: async (rs = []) => rs.map((r) => r.user_id || r.id).filter(Boolean),
}));

jest.unstable_mockModule("../../app/config/dbConn.js", () => ({
  default: {
    any: async () => [
      { id: 1, name: "5 WATT LED PANEL LIGHT", quantity: 10, unit: "nos", unit_price: 120, total_price: 1200 },
      { id: 2, name: "Bath Towel 700 GSM", quantity: 40, unit: "nos", unit_price: 560, total_price: 22400 },
    ],
    one: async () => ({}),
    oneOrNone: async () => ({ id: 501, name: "Surya Enterprises Pvt Ltd" }),
    none: async () => {},
    tx: async (fn) => fn({ any: async () => [], none: async () => {} }),
  },
  pgp: {},
}));

jest.unstable_mockModule("../../app/models/userModel.js", () => ({
  default: {
    getUserById: async (id) =>
      id === 42
        ? [{ id: 42, name: "Asha Menon", email: "asha@example.com" }]
        : [{ id: 501, name: "Surya Enterprises", organization_name: "Surya Enterprises", email: "surya@example.com" }],
    getCompanyDetail: async () => [{ company_name: "Orchid Hotels" }],
  },
}));

const BASE = "https://hospitality.letsworkwise.com";
process.env.FRONT_END_WEBSITE = BASE;

const { generateEmailTemplate, emailButton } = await import("../../app/helper/notificationEmailLayout.js");
const { sendApprovalStepNotification, sendVendorRfqNotification } = await import(
  "../../app/helper/sendEmailFunctions/approvalEmails.js"
);
const { sendApprovalNotification, sendPOAcceptanceRequestToVendor } = await import(
  "../../app/controllers/po/purchaseOrderEmails.js"
);
const { sendNegotiationRoundVendorNotification } = await import(
  "../../app/helper/sendEmailFunctions/negotiationEmails.js"
);
const { sendVendorTechAcceptanceNotification } = await import(
  "../../app/helper/sendEmailFunctions/techEvalEmails.js"
);

const lastHtml = () => String(sentMails[sentMails.length - 1].html);

// The <a> carrying a given href, and its visible text.
const anchorFor = (html, href) => {
  const esc = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(new RegExp(`<a href="${esc}"[^>]*>([\\s\\S]*?)</a>`));
  return m ? { tag: m[0], label: m[1].trim() } : null;
};

// Phone-safety invariants every action email must satisfy.
const expectPhoneSafe = (html) => {
  expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1"/);
  // No fixed width attribute or inline width wider than a phone-safe 600px.
  for (const [, w] of html.matchAll(/\bwidth="(\d+)"/g)) expect(Number(w)).toBeLessThanOrEqual(600);
  for (const [, w] of html.matchAll(/(?<!max-|min-)width:\s*(\d+)px/g)) expect(Number(w)).toBeLessThanOrEqual(600);
  expect(html).toMatch(/max-width: 600px/);
  expect(html).toMatch(/@media only screen and \(max-width: 620px\)/);
};

// The CTA is a bulletproof, >=44px tap target.
const expectBulletproofCta = (html, href, label) => {
  const a = anchorFor(html, href);
  expect(a).not.toBeNull();
  expect(a.label).toBe(label);
  expect(a.tag).toContain('class="ww-btn"');
  // 14px top + 20px line + 14px bottom = 48px
  expect(a.tag).toContain("padding: 14px 24px");
  expect(a.tag).toContain("line-height: 20px");
};

beforeEach(() => {
  sentMails.length = 0;
});

describe("shared layout (generateEmailTemplate)", () => {
  it("is a full document with a viewport and a fluid 600px container", () => {
    const html = generateEmailTemplate("<h2>Hello Asha,</h2>", "<p>BODY-MARKER</p>");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expectPhoneSafe(html);
    expect(html).toContain("<h2>Hello Asha,</h2>");
    expect(html).toContain("<p>BODY-MARKER</p>");
    // Fluid logo image
    expect(html).toMatch(/<img width="260" style="width: 260px; max-width: 100%; height: auto;/);
    // Long product names / URLs wrap instead of widening the card.
    expect(html).toContain("word-break: break-word");
    // Footer content preserved.
    expect(html).toContain('href="mailto:support@phileeinhospitality.com"');
  });

  it("keeps company-branded templates working", () => {
    const html = generateEmailTemplate("<h2>Hi</h2>", "<p>x</p>", 6729);
    expect(html).toContain("background: #29577b");
    expectPhoneSafe(html);
  });

  it("has no [key] brackets that the users-controller placeholder pass would rewrite", () => {
    const html = generateEmailTemplate("", "");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).not.toMatch(/\[[a-z_]+\]/i);
  });

  it("emailButton emits the href and label unchanged", () => {
    const href = `${BASE}/dashboard/vendor/inquiries-details?id=5&token=a&b`;
    const html = emailButton(href, "Review & Approve", { bg: "#059669" });
    expectBulletproofCta(html, href, "Review & Approve");
    expect(html).toContain('bgcolor="#059669"');
  });
});

describe("approver action emails", () => {
  it("PO approval request (purchaseOrderEmails.sendApprovalNotification)", async () => {
    await sendApprovalNotification({ id: 587, po_number: "138859", rfq_id: 2386, finalized_vendor_id: 501, created_at: "2026-09-29 11:42:10" }, 42);
    const html = lastHtml();
    expectPhoneSafe(html);
    expectBulletproofCta(html, `${BASE}/dashboard/buyer/purchase-orders/587`, "View Purchase Order");
    for (const v of ["Hello Asha Menon,", "5 WATT LED PANEL LIGHT, Bath Towel 700 GSM", "50", "₹23,600", "Surya Enterprises Pvt Ltd", "2026-09-29 11:42:10"]) {
      expect(html).toContain(v);
    }
    expect(sentMails[0].subject).toBe("New PO Approval Request — Your Action is Needed");
  });

  it("commercial (NEGOTIATION_QUOTE) approval step", async () => {
    await sendApprovalStepNotification({
      entityType: "NEGOTIATION_QUOTE", entityId: 8891, entityIdentifier: "536631", stepOrder: 1, totalSteps: 2,
      initiatorName: "Ravi Kumar",
      approvers: [{ user_id: 42, user_name: "Asha Menon", user_email: "asha@example.com" }],
      extraContext: { rfq_id: 2386, rfq_title: "Guest room linen" },
    });
    const html = lastHtml();
    expectPhoneSafe(html);
    expectBulletproofCta(html, `${BASE}/dashboard/buyer/quote-comparison?rfq=2386&rfq_product_id=8891&focus=approval`, "Review & Approve");
    for (const v of ["Hello Asha Menon,", "Step 1 of 2", "#536631", "Guest room linen", "Ravi Kumar", "Vendor Finalization"]) {
      expect(html).toContain(v);
    }
  });

  it("negotiation round approval step keeps its guide and CTA", async () => {
    await sendApprovalStepNotification({
      entityType: "NEGOTIATION", entityId: 2386, entityIdentifier: "536631", stepOrder: 1, totalSteps: 1,
      initiatorName: "Ravi Kumar",
      approvers: [{ user_id: 42, user_name: "Asha Menon", user_email: "asha@example.com" }],
      extraContext: { rfq_id: 2386, rfq_title: "ORCHID PASSAROS GOA", end_date: "2026-10-02 12:30:00", product_name: "Bath Towel", company_name: "Orchid Hotels", hotel_name: "ORCHID GOA" },
    });
    const html = lastHtml();
    expectPhoneSafe(html);
    expectBulletproofCta(html, `${BASE}/dashboard/buyer/quote-comparison?rfq=2386&focus=approval`, "View Quote Compare");
    for (const v of ["Bath Towel", "Orchid Hotels", "ORCHID GOA", "2 Oct 2026", "How to approve this negotiation round:"]) {
      expect(html).toContain(v);
    }
  });
});

describe("vendor action emails", () => {
  it("RFQ invite carries both CTAs with the vendor token", async () => {
    await sendVendorRfqNotification({
      rfq_id: 2386, rfq_no: "536631", is_tender: 0, title: "Linen", bid_end_date: "2026-10-05T12:30:00Z",
      hotel_name: "ORCHID GOA", hospitality_company_name: "Orchid Hotels", buyerName: "Orchid Hotels",
      vendors: [{ user_id: 501, name: "Surya Enterprises", email: "surya@example.com", token: "tok_abc", products: ["Bath Towel", "Hand Towel"] }],
    });
    const html = lastHtml();
    expectPhoneSafe(html);
    const url = `${BASE}/dashboard/vendor/inquiries-details?id=2386&token=tok_abc`;
    const anchors = [...html.matchAll(/<a href="([^"]+)"[^>]*class="ww-btn"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(anchors).toEqual([[url, "Submit Your Quote"], [url, "View Details"]]);
    for (const v of ["Hello Surya Enterprises,", "#536631", "Linen", "ORCHID GOA", "Bath Towel", "Hand Towel", "5 Oct 2026"]) {
      expect(html).toContain(v);
    }
  });

  it("PO acceptance request", async () => {
    await sendPOAcceptanceRequestToVendor({ id: 587, po_number: "138859", rfq_id: 2386, finalized_vendor_id: 501 }, { rfq_no: 536631, title: "LED PANEL" });
    const html = lastHtml();
    expectPhoneSafe(html);
    expectBulletproofCta(html, `${BASE}/dashboard/vendor/purchase-orders/587`, "Review Purchase Order");
    for (const v of ["138859", "#536631 — LED PANEL", "Rs. 23,600", "Please review and accept or reject this Purchase Order."]) {
      expect(html).toContain(v);
    }
  });

  it("negotiation round invite", async () => {
    await sendNegotiationRoundVendorNotification({
      round: { rfq_id: 2386, round_number: 2, end_date: "2026-10-02 12:30:00" }, rfqNo: "536631", rfqTitle: "ORCHID GOA",
      productName: "Bath Towel", buyerCompanyName: "Orchid Hotels", companyName: "Orchid Hotels", businessUnitName: "ORCHID GOA",
      vendors: [{ user_id: 501, name: "Surya Enterprises", email: "surya@example.com", token: "tok_abc", quote: { unit_price: 560, quantity: 40 }, negotiation_fields: [{ name: "unit_price", target: 520 }] }],
    });
    const html = lastHtml();
    expectPhoneSafe(html);
    expectBulletproofCta(html, `${BASE}/dashboard/vendor/inquiries-details?id=2386&token=tok_abc`, "Submit Quote");
    for (const v of ["Round 2", "Bath Towel", "Orchid Hotels", "2 Oct 2026"]) expect(html).toContain(v);
  });

  it("technical acceptance", async () => {
    await sendVendorTechAcceptanceNotification({
      rfqDetails: { id: 2386, rfq_no: "536631", is_tender: 0, product_name: "Bath Towel", company_name: "Orchid Hotels" },
      vendors: [{ user_id: 501, vendor_name: "Surya Enterprises", email: "surya@example.com", token: "tok_abc" }],
    });
    const html = lastHtml();
    expectPhoneSafe(html);
    expectBulletproofCta(html, `${BASE}/dashboard/vendor/inquiries-details?id=2386&token=tok_abc`, "View Details");
    for (const v of ["Hello Surya Enterprises,", "Bath Towel", "#536631", "Orchid Hotels"]) expect(html).toContain(v);
  });
});
