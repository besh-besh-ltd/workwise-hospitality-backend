// Vendor fixtures: subscriptions (tbl_vendor_hotel_category_subscription) +
// preferred-vendor mappings (tbl_buyer_private_vendors_mapping).
//
// Subscription source-of-truth: tbl_vendor_hotel_category_subscription.
// item_type ∈ {category, hotel, subcategory}. We use 'category' (the actual
// production model — vendors register at category level, not subcategory).
//
// Status states tested:
//   active           — current, in-window, can receive inquiries AND send quotes
//   active-but-lapsed — start_date past, end_date past, status='active' until
//                       the renewal cron flips it. Vendor still receives
//                       inquiries (per Wave-2 step-1 rule); quote-send blocked.
//   expired          — end_date past, status='expired' (post-cron).
//   cancelled        — admin cancelled.
//   pending          — awaiting payment.
//
// Categories used: 215 (BEVERAGES), 217 (OTHER BEVERAGES), 218 (JUICE) —
// real seeded categories. Tests assert on these IDs.

import { IDS } from "./ids.js";

export const TEST_CATEGORIES = Object.freeze({
  beverages:      215,
  otherBeverages: 217,
  juice:          218,
});

const TODAY = new Date();
const futureDate = (daysFromNow) =>
  new Date(TODAY.getTime() + daysFromNow * 86400_000).toISOString().slice(0, 10);
const pastDate = (daysAgo) =>
  new Date(TODAY.getTime() - daysAgo * 86400_000).toISOString().slice(0, 10);

const SUBSCRIPTIONS = [
  // Alpha: active, in-window, beverages.
  {
    vendor: IDS.users.vendor_alpha,
    item_type: "category",
    item_id: TEST_CATEGORIES.beverages,
    fee_amount: 500,
    start: pastDate(30),
    end: futureDate(335), // ~1 year subscription, mostly remaining
    status: "active",
  },
  // Beta: active, multi-category (beverages + juice).
  {
    vendor: IDS.users.vendor_beta,
    item_type: "category",
    item_id: TEST_CATEGORIES.beverages,
    fee_amount: 500,
    start: pastDate(60),
    end: futureDate(305),
    status: "active",
  },
  {
    vendor: IDS.users.vendor_beta,
    item_type: "category",
    item_id: TEST_CATEGORIES.juice,
    fee_amount: 500,
    start: pastDate(60),
    end: futureDate(305),
    status: "active",
  },
  // Gamma: lapsed-was-active. status flipped to 'expired' by renewal cron;
  // vendor should still see inquiries but be blocked at quote-send.
  {
    vendor: IDS.users.vendor_gamma,
    item_type: "category",
    item_id: TEST_CATEGORIES.beverages,
    fee_amount: 500,
    start: pastDate(395),
    end: pastDate(30), // ended 30 days ago
    status: "expired",
  },
  // Delta: cancelled mid-subscription.
  {
    vendor: IDS.users.vendor_delta,
    item_type: "category",
    item_id: TEST_CATEGORIES.beverages,
    fee_amount: 500,
    start: pastDate(120),
    end: futureDate(245),
    status: "cancelled",
  },
  // Epsilon: pending payment (admin-mapped).
  {
    vendor: IDS.users.vendor_epsilon,
    item_type: "category",
    item_id: TEST_CATEGORIES.otherBeverages,
    fee_amount: 500,
    start: futureDate(0),
    end: futureDate(365),
    status: "pending",
  },
];

// Buyer's preferred-vendor list (tbl_buyer_private_vendors_mapping).
// 'created_by' = the buyer who marked them; 'vendor_id' = vendor user.
// The preferred-vendors page (frontend/preffered-vendors.js) reads this.
const PREFERRED_VENDORS = [
  { createdBy: IDS.users.a1_proc_buyer, vendor: IDS.users.vendor_alpha, company: IDS.companies.A },
  { createdBy: IDS.users.a1_proc_buyer, vendor: IDS.users.vendor_beta,  company: IDS.companies.A },
  { createdBy: IDS.users.companyB_admin, vendor: IDS.users.vendor_alpha, company: IDS.companies.B },
];

export async function seedVendors(t) {
  await seedVendorSubscriptions(t);

  for (const pv of PREFERRED_VENDORS) {
    await t.none(
      `INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id)
       VALUES ($1, $2, $3)`,
      [pv.createdBy, pv.vendor, pv.company]
    );
  }
}

// Subscriptions only — used by `truncateDynamic()` to restore the rows that
// CASCADE-truncated through tbl_vendor_payments. Preferred-vendor mappings
// survive the truncate (their only FK is to tbl_company, which isn't dynamic),
// so we don't reinsert them here — that would just create duplicates.
export async function seedVendorSubscriptions(t) {
  for (const s of SUBSCRIPTIONS) {
    await t.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ON CONSTRAINT uq_vendor_hotel_category_subscription DO NOTHING`,
      [s.vendor, s.item_type, s.item_id, s.fee_amount, s.start, s.end, s.status]
    );
  }
}
