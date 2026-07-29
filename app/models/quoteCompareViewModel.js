// ============================================================================
// quoteCompareViewModel.js
// ----------------------------------------------------------------------------
// Read-only query + reshape layer powering the buyer "Quote Comparison" UI
// (GET /rfq/quote-comparison-view/:id).
//
// This DOES NOT re-query the comparison data from scratch. It reuses the rich
// model logic that already powers GET /rfq/quote-compare/:id:
//   1. rfqModel.getQuotesByRfqById2(...)        -> raw products + quotations
//   2. quoteCompareService.enrichQuoteCompareData(...) -> pricing-engine output
//      (per-cell base/freight/packaging/tax/total, lowest_vendor_id, l1_total,
//       last_purchase_rate, latest_target_price, finalization, etc.)
// then RESHAPES that output into the single, flat "QC contract" the frontend
// renders straight from, and layers on:
//   - per-product state (open|pending|approved|rejected) via tbl_quote_finalization
//     + the NEGOTIATION_QUOTE approval instance for that rfq_product_id
//   - reject_info (approver name + role + reason + acted_at) from the REJECT
//     approval action (mirrors poDashboardModel.buildAuditTrail's rejection node)
//   - vendor technical status/score (mirrors poDashboardModel.buildTechEval —
//     cleared_vendors.calculated_score / status), else tech:'none'/null
//   - product categories (tbl_product_categories -> tbl_category), else a single
//     synthetic "All items" bucket
//   - the commercial/quote approval chain (the NEGOTIATION_QUOTE instance steps,
//     or the applicable policy steps if no instance has been raised yet)
//
// SECURITY: the caller (controller) derives company/hotel/department scope from
// req.user + headers ONLY and passes it in. We verify the RFQ belongs to the
// scoped company before returning anything; out-of-scope -> null (controller 404).
// All queries are parameterized pg-promise.
// ============================================================================

import db from "../config/dbConn.js";
import { logError } from "../helper/common.js";
import rfqModel from "./rfqModel.js";
import { enrichQuoteCompareData } from "../services/quoteCompareService.js";
import { buildQuoteVisibilityMeta } from "../helper/quoteVisibility.js";

const toNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const num0 = (v) => toNum(v) ?? 0;
const iso = (d) => (d ? new Date(d).toISOString() : null);

function initialsOf(name) {
  if (!name || typeof name !== "string") return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Pull the single line-item detail object regardless of the shape variant
// returned by the model (array vs single object). Mirrors quoteCompareService.
const getDetail = (quote) => {
  if (!quote) return null;
  if (Array.isArray(quote.quote_details)) return quote.quote_details[0] || null;
  if (quote.quote_details && typeof quote.quote_details === "object") return quote.quote_details;
  return null;
};

// Pricing/identity fields live on EITHER the parent quote (when quote_details
// is a single metadata object) OR on `detail` (when quote_details is an array
// of line items). The legacy FE + quoteCompareService both read via the merged
// view `{ ...quote, ...detail }`. Reading only `detail.unit_price` /
// `detail.tax` / `detail.delivery_period` (as the old code did) returns 0/empty
// whenever those values sit on the parent quote — which is exactly the real-data
// bug. Merge first, then read.
const mergedRow = (quote, detail) => ({ ...(quote || {}), ...(detail || {}) });

// Normalise a raw quote row (previous_quote or current merged) to the fields we
// diff across rounds. other_charges is jsonb (pg returns it parsed).
function normHistoryRow(row) {
  let oc = row?.other_charges;
  if (typeof oc === "string") {
    try { oc = JSON.parse(oc); } catch { oc = []; }
  }
  return {
    unit_price: toNum(row?.unit_price),
    total_price: toNum(row?.total_price),
    tax: toNum(row?.tax),
    tax_mode: row?.tax_mode || null,
    delivery_period: row?.delivery_period != null ? String(row.delivery_period) : null,
    quantity: toNum(row?.quantity),
    other_charges: Array.isArray(oc) ? oc : [],
    comment: row?.comment || null,
    timestamp: row?.timestamp || null,
  };
}

// label -> amount map for a row's other_charges (label | name | slug).
function chargeMap(arr) {
  const m = {};
  (arr || []).forEach((c) => {
    const label = c?.label || c?.name || c?.slug;
    if (label) m[label] = toNum(c?.amount ?? c?.value);
  });
  return m;
}

// What changed from round `a` to round `b` — every editable field, not just the
// base price. dir 'up' = increased (bad, red), 'down' = decreased (good, green).
function diffHistoryRows(a, b) {
  const ch = [];
  const pushNum = (label, from, to, kind = "money") => {
    if (from == null && to == null) return;
    if (from !== to) ch.push({ label, from, to, dir: (to ?? 0) > (from ?? 0) ? "up" : "down", kind });
  };
  pushNum("Unit price", a.unit_price, b.unit_price, "money");
  pushNum("Line total", a.total_price, b.total_price, "money");
  if (a.tax !== b.tax && (a.tax != null || b.tax != null)) {
    ch.push({
      label: "Tax",
      from: a.tax,
      to: b.tax,
      dir: (b.tax ?? 0) > (a.tax ?? 0) ? "up" : "down",
      kind: (b.tax_mode || a.tax_mode) === "percentage" ? "pct" : "money",
    });
  }
  if ((a.delivery_period || "") !== (b.delivery_period || "")) {
    ch.push({ label: "Delivery", from: a.delivery_period, to: b.delivery_period, kind: "text" });
  }
  pushNum("Quantity", a.quantity, b.quantity, "num");
  const am = chargeMap(a.other_charges);
  const bm = chargeMap(b.other_charges);
  for (const label of new Set([...Object.keys(am), ...Object.keys(bm)])) {
    const from = am[label];
    const to = bm[label];
    if (from === to) continue;
    ch.push({
      label,
      from: from ?? null,
      to: to ?? null,
      dir: (to ?? 0) > (from ?? 0) ? "up" : "down",
      kind: "money",
      added: from == null,
      removed: to == null,
    });
  }
  return ch;
}

// Build the NEGOTIATION-ROUND history for one cell from the quotation's
// previous_quotes (newest-first from the model) + the current submission.
//
// A vendor can save the same quote many times — both before negotiation starts
// and several times within a single round. We only want, per negotiation round,
// the vendor's FINAL update. tbl_quote_item_history carries no round id, so we
// align each revision to a round purely by timestamp: a revision belongs to the
// latest round whose start (`created_at`) is <= its timestamp. Revisions before
// the first round's start are pre-negotiation noise (kept only as the baseline
// the first round diffs against, never emitted).
//
// `allRounds` is the full ordered list for the RFQ; we keep the rounds relevant
// to THIS product (RFQ-level rfq_product_id=NULL applies to all; product-level
// only to its own product) and, when vendor_ids is set, that targeted this
// vendor. One entry is emitted per round the vendor actually updated, labelled
// with the real round_number, oldest→newest, with a SIGNED price delta and a
// `changes` breakdown vs the previous emitted round (or the baseline for the
// first one).
function buildCellHistory(quote, merged, allRounds = [], rfqProductId = null, vendorId = null) {
  const prev = Array.isArray(quote?.previous_quotes) ? [...quote.previous_quotes] : [];
  prev.reverse(); // previous_quotes is ORDER BY timestamp DESC -> oldest-first
  const norms = prev.map(normHistoryRow);
  const cur = normHistoryRow(merged);
  if (cur.timestamp == null) cur.timestamp = quote?.timestamp || null;
  norms.push(cur);

  const tsOf = (n) => (n?.timestamp ? new Date(n.timestamp).getTime() : null);

  // Rounds that apply to this product + vendor, oldest-first by start.
  const relevant = (allRounds || [])
    .filter((r) => r.rfq_product_id == null || Number(r.rfq_product_id) === Number(rfqProductId))
    .filter((r) => {
      const ids = Array.isArray(r.vendor_ids) ? r.vendor_ids.map(Number) : [];
      return ids.length === 0 || vendorId == null || ids.includes(Number(vendorId));
    })
    .map((r) => ({ round_number: Number(r.round_number), start: new Date(r.created_at).getTime() }))
    .filter((r) => Number.isFinite(r.start))
    .sort((a, b) => a.start - b.start);

  // No negotiation rounds recorded for this product+vendor: fall back to the
  // quote's own revision trail (previous_quotes oldest→newest + current) as a
  // sequential history — one entry per revision, numbered 1..N, each diffed
  // against the original (first) revision. Without this, a vendor's quote-edit
  // history never surfaces in the comparison unless a formal negotiation round
  // was opened.
  if (relevant.length === 0) {
    return norms.map((n, idx) => {
      const final = idx === norms.length - 1;
      // Round-over-round: diff each revision against its immediate predecessor.
      // positive delta => price dropped from the previous revision.
      const prevN = idx > 0 ? norms[idx - 1] : null;
      const delta =
        prevN && n.unit_price != null && prevN.unit_price != null
          ? prevN.unit_price - n.unit_price
          : null;
      return {
        round: idx + 1,
        price: n.unit_price ?? n.total_price,
        total_price: n.total_price,
        date: iso(n.timestamp),
        note: n.comment || `Update ${idx + 1}`,
        delta,
        final,
        breakdown: {
          unit_price: n.unit_price,
          total_price: n.total_price,
          tax: n.tax,
          tax_mode: n.tax_mode,
          delivery_period: n.delivery_period,
          quantity: n.quantity,
        },
        changes: prevN ? diffHistoryRows(prevN, n) : [],
      };
    });
  }
  const firstStart = relevant[0].start;

  // Original quote = the vendor's quote as it stood BEFORE negotiation started
  // (last revision strictly before the first round). Every round is diffed
  // against this so the modal can show "original (struck) → this round's value".
  let baseline = null;
  for (const n of norms) {
    const t = tsOf(n);
    if (t != null && t < firstStart) baseline = n;
  }
  // Fallback: if the vendor has no pre-negotiation revision, use the earliest
  // revision we have as the original reference.
  if (!baseline && norms.length) baseline = norms[0];

  // Bucket each in-round revision into the latest round whose start <= ts.
  // norms are oldest→newest, so the last write per round is that round's final.
  const finalByRound = new Map(); // round_number -> norm
  for (const n of norms) {
    const t = tsOf(n);
    if (t == null || t < firstStart) continue;
    let chosen = null;
    for (const r of relevant) {
      if (r.start <= t) chosen = r;
      else break;
    }
    if (chosen) finalByRound.set(chosen.round_number, n);
  }

  // One entry per round that had an update, ascending by round_number.
  const orderedRounds = [];
  const seen = new Set();
  for (const r of relevant) {
    if (finalByRound.has(r.round_number) && !seen.has(r.round_number)) {
      seen.add(r.round_number);
      orderedRounds.push(r.round_number);
    }
  }

  // Each round is compared to the ORIGINAL (pre-negotiation) quote — both the
  // savings delta and the per-field `changes` (original → this round's value).
  const original = baseline;
  return orderedRounds.map((rn, idx) => {
    const n = finalByRound.get(rn);
    const final = idx === orderedRounds.length - 1;
    // signed: original - current. positive => price dropped (savings).
    const delta =
      original && n.unit_price != null && original.unit_price != null
        ? original.unit_price - n.unit_price
        : null;
    return {
      round: rn,
      price: n.unit_price ?? n.total_price,
      total_price: n.total_price,
      date: iso(n.timestamp),
      note: n.comment || `Round ${rn} update`,
      delta,
      final,
      breakdown: {
        unit_price: n.unit_price,
        total_price: n.total_price,
        tax: n.tax,
        tax_mode: n.tax_mode,
        delivery_period: n.delivery_period,
        quantity: n.quantity,
      },
      // original → round value, per field (label + from/to/dir/kind)
      changes: original ? diffHistoryRows(original, n) : [],
    };
  });
}

// Extract the engine charge subtotal for a given canonical slug from a detail's
// engine breakdown (engine.charges[] carries { slug, name, subtotal }).
function chargeSubtotal(engine, slug) {
  const charges = engine?.charges || [];
  const hit = charges.find((c) => {
    if (c?.slug) return c.slug === slug;
    return (c?.name || "").toLowerCase() === slug;
  });
  return hit ? num0(hit.subtotal) : 0;
}

// Find the engine charge object matching a saved other_charges entry, so we can
// surface the engine-COMPUTED rupee subtotal (the value the engine actually
// applied, after % / inheritance) rather than the raw user-typed amount.
// Matches by canonical slug first, then by name (case-insensitive).
function findEngineCharge(engine, savedCharge) {
  const charges = engine?.charges || [];
  return (
    charges.find((c) => {
      if (c?.slug && savedCharge?.slug) return c.slug === savedCharge.slug;
      return (c?.name || "").toLowerCase() === (savedCharge?.name || "").toLowerCase();
    }) || null
  );
}

// Parse the line item's `other_charges` jsonb into [{ label, amount }]. `amount`
// is the engine-computed rupee subtotal (amount + inherited/explicit tax) so it
// reflects what the engine actually added to the landed total; falls back to the
// raw amount when no engine charge matched (legacy / un-enriched rows).
//
// NOTE on field locations: the saved `other_charges` jsonb sits on the PARENT
// quote (it's a line-item column), while the engine breakdown sits on the
// `detail` (quote_details) object after enrichment. So we read saved charges
// from the merged row and the engine from `detail`.
function parseOtherCharges(merged, detail) {
  const saved = Array.isArray(merged?.other_charges) ? merged.other_charges : [];
  const engine = detail?.engine || {};
  return saved
    .map((c) => {
      const label = c?.name || c?.slug || "Charge";
      const eng = findEngineCharge(engine, c);
      const amount = eng != null ? num0(eng.subtotal) : num0(c?.amount);
      return { label: String(label), amount };
    })
    .filter((c) => c.label);
}

// Parse the vendor's quote-level `global_charges` jsonb (TCS/TDS/document fees)
// into [{ label, amount }]. Prefer the engine-resolved rupee values the service
// already computed (engine_global_charges[]); fall back to the raw saved array
// (normalised via the tri-state {amount|tax} shapes) when absent.
function parseGlobalCharges(quote) {
  const resolved = Array.isArray(quote?.engine_global_charges) ? quote.engine_global_charges : null;
  if (resolved && resolved.length) {
    return resolved
      .map((c) => ({ label: String(c?.name || c?.slug || "Charge"), amount: num0(c?.amount) }))
      .filter((c) => c.label);
  }
  const saved = Array.isArray(quote?.global_charges) ? quote.global_charges : [];
  return saved
    .map((c) => {
      const label = c?.name || c?.slug || "Charge";
      // Both on-disk shapes: { amount, amount_mode } and legacy { tax, tax_mode }.
      const amount = num0(c?.amount ?? c?.tax);
      return { label: String(label), amount };
    })
    .filter((c) => c.label);
}

// Build a human payment-terms string from a merged quote row. Mirrors the
// legacy getPaymentTermsText: prefer the structured payment_terms[] list
// (type/days/comment/value), else fall back to the free-text global_payment_term.
function paymentTermsText(merged) {
  const terms = Array.isArray(merged?.payment_terms) ? merged.payment_terms : [];
  const termText = terms
    .map((t) => {
      const label = t?.comment
        ? t.comment
        : `${t?.type || ""}${t?.days ? ` ${t.days} days` : ""}`.trim();
      const pct = t?.value != null ? ` (${t.value}%)` : "";
      return `${label}${pct}`.trim();
    })
    .filter(Boolean)
    .join(", ");

  const gpt = merged?.global_payment_term;
  const globalDetail =
    Array.isArray(gpt) ? gpt[0]?.details || "" : typeof gpt === "string" ? gpt : "";

  const out = [globalDetail, termText].filter(Boolean).join("\n");
  return out || null;
}

// ---------------------------------------------------------------------------
// Main entry: build the QC contract object, or null when out-of-scope / not found.
// ---------------------------------------------------------------------------
export async function getQuoteComparisonView(rfqId, scope, { noFreight } = {}) {
  const id = parseInt(rfqId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  // ---- 1) Scope guard: load RFQ header, verify it belongs to the caller. ----
  const rfq = await db.oneOrNone(
    `SELECT r.id, r.rfq_no, r.title, r.status, r.company_name, r.response_email,
            r.contact_name, r.contact_number, r.location, r.bid_end_date,
            r.reverse_auction, r.hospitality_company_id, r.hotel_id, r.department_id,
            r.created_by, r.project_id,
            hc.name AS company_label, hh.name AS hotel_label, dep.title AS department_label
       FROM tbl_rfq r
       LEFT JOIN tbl_hospitality_companies hc ON hc.id = r.hospitality_company_id
       LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = r.hotel_id
       LEFT JOIN tbl_department dep ON dep.id = r.department_id
      WHERE r.id = $1`,
    [id]
  );
  if (!rfq) return null;

  // Tenant check: never leak across tenants. `scope.hospitalityCompanyIds` is
  // the caller's mappings-derived company scope (from deriveScope), NOT a client
  // header, so it can't be spoofed: null = super admin (all companies) → no gate;
  // otherwise (a real user, array possibly empty) the RFQ's hospitality company
  // MUST be in that set or we return null (controller → 404). (Hotel/department
  // are narrowing filters in the dashboards; the single-RFQ view only needs the
  // company-level ownership gate.)
  if (scope && Array.isArray(scope.hospitalityCompanyIds)) {
    const allowed = scope.hospitalityCompanyIds.map(Number);
    if (!allowed.includes(Number(rfq.hospitality_company_id))) {
      return null;
    }
  }

  // ---- 2) Reuse the existing comparison pipeline. ----
  // no_freight passes straight through to the model/engine so totals recompute
  // base-only when freight=0.
  const rawProducts = await rfqModel.getQuotesByRfqById2(
    id,
    scope ? scope.userId : null,
    rfq.hospitality_company_id || (scope ? scope.companyId : null),
    "TA",
    noFreight,
    null,
    false,
    null
  );
  const enriched = enrichQuoteCompareData(rawProducts || [], { normalizeApplied: false });
  const products = enriched.products || [];

  // ---- 3) Side lookups (categories, approvals, tech eval, rounds, files). ----
  const rfqProductIds = products.map((p) => Number(p.id)).filter(Number.isInteger);

  const categoryByRfqProduct = await fetchCategories(id, rfqProductIds);
  const approvalByRfqProduct = await fetchQuoteApprovals(rfqProductIds);
  const finalizationByRfqProduct = await fetchFinalizations(id, products);
  const roundByRfqProduct = await fetchActiveRounds(rfqProductIds);
  const allRounds = await fetchAllRounds(id);
  const docCountByQuote = await fetchQuoteDocCounts(id);
  const techByVendor = await fetchVendorTech(id);
  const techByProduct = await fetchProductTech(id);
  const approvalChain = await fetchApprovalChain(rfq, approvalByRfqProduct, scope);

  // Which PENDING quote-approval instances are awaiting THIS user's action —
  // drives per-product `awaiting_me` (the FE auto-selects approver vs evaluator).
  const pendingInstanceIds = [];
  for (const v of approvalByRfqProduct.values()) {
    if (v && (v.status || "").toUpperCase() === "PENDING" && v.instance_id) pendingInstanceIds.push(v.instance_id);
  }
  const awaitingInstanceIds = scope && scope.userId
    ? await fetchAwaitingInstanceIds(pendingInstanceIds, scope.userId)
    : new Set();

  // Full approval trail + current approvers per instance (for the QC approval
  // drawer + the "Awaiting approval from …" badge).
  const allQuoteInstanceIds = [];
  for (const v of approvalByRfqProduct.values()) {
    if (v && v.instance_id) allQuoteInstanceIds.push(v.instance_id);
  }
  const approvalDataByInstance = await buildQuoteApprovalData(allQuoteInstanceIds);

  // ---- 4) Assemble vendors[] (union of all vendors that quoted any product). ----
  const vendorMap = new Map();
  for (const p of products) {
    for (const q of p.quotations || []) {
      const detail = getDetail(q) || {};
      const vd = detail.vendor_details || {};
      const vId = vd.id ?? detail.created_by ?? q.created_by;
      if (vId == null) continue;
      const key = String(vId);
      if (!vendorMap.has(key)) {
        const name = vd.organization_name || vd.name || vd.email || "Vendor";
        const tech = techByVendor.get(key) || { tech: "none", tech_score: null };
        vendorMap.set(key, {
          id: Number(vId),
          name,
          short: initialsOf(name),
          tech: tech.tech,
          tech_score: tech.tech_score,
        });
      }
    }
  }
  const vendors = Array.from(vendorMap.values());

  // Per-vendor performance fields (batched, additive, never crash the endpoint):
  //   orders_done  : REAL count of POs awarded to the vendor in this tenant.
  //   track_record : 0-100 composite — not cleanly derivable from real data yet,
  //                  so always null (do NOT fabricate).
  //   on_time_pct  : on-time delivery % — not modelled (the PO module already
  //                  found this isn't stored), so always null.
  const orderCountByVendor = await fetchVendorOrderCounts(
    vendors.map((v) => v.id),
    rfq.hospitality_company_id
  );
  // Real, tenant-scoped track record surfaced in each product×vendor cell:
  //   pos_accepted : # POs the vendor has ACCEPTED (passed the acceptance gate)
  //   po_value     : ₹ value of those accepted POs
  //   quote_pct    : % of invited RFQs the vendor actually quoted (quoted/invited)
  //   is_new       : fewer than 3 accepted POs => "newly started working with you"
  const trackByVendor = await fetchVendorTrackRecord(
    vendors.map((v) => v.id),
    rfq.hospitality_company_id
  );
  for (const v of vendors) {
    v.orders_done = orderCountByVendor.get(v.id) ?? 0;
    v.track_record = null;
    v.on_time_pct = null;
    const tr =
      trackByVendor.get(v.id) || { pos_accepted: 0, po_value: 0, quoted_rfqs: 0, invited_rfqs: 0 };
    v.pos_accepted = tr.pos_accepted;
    v.po_value = Math.round(tr.po_value);
    v.quoted_rfqs = tr.quoted_rfqs;
    v.invited_rfqs = tr.invited_rfqs;
    v.quote_pct = tr.invited_rfqs > 0 ? Math.round((tr.quoted_rfqs / tr.invited_rfqs) * 100) : null;
    v.is_new = (tr.pos_accepted || 0) < 3;
  }

  // ---- 5) Categories list. ----
  const categorySet = new Map();
  for (const p of products) {
    const cat = categoryByRfqProduct.get(Number(p.id));
    if (cat && !categorySet.has(cat.id)) categorySet.set(cat.id, { id: cat.id, name: cat.name });
  }
  let categories = Array.from(categorySet.values());
  let useSyntheticCategory = false;
  const SYNTHETIC_CATEGORY = { id: 0, name: "All items" };
  if (categories.length === 0) {
    categories = [SYNTHETIC_CATEGORY];
    useSyntheticCategory = true;
  }

  // ---- 6) Products[] in the contract shape. ----
  const contractProducts = products.map((p) => {
    const rfqProductId = Number(p.id);
    const pd = Array.isArray(p.product_details) ? p.product_details[0] : p.product_details;
    const name = pd?.product_name || pd?.name || `Product ${rfqProductId}`;

    // qty / unit from product specs (Quantity / Unit) when present.
    const specs = Array.isArray(pd?.rfq_details) ? pd.rfq_details : [];
    const qtySpec = specs.find((s) => (s.title || "").toLowerCase() === "quantity");
    const unitSpec = specs.find((s) => (s.title || "").toLowerCase() === "unit");

    // Per-cell quotes keyed by vendor id.
    const quotesByVendor = {};
    let qtyFromQuote = null;
    for (const q of p.quotations || []) {
      const detail = getDetail(q) || {};
      // Merge parent quote + line detail so pricing/identity fields resolve
      // regardless of which shape the model returned them in (see mergedRow).
      const merged = mergedRow(q, detail);
      const vd = merged.vendor_details || {};
      const vId = vd.id ?? merged.created_by ?? q.created_by;
      if (vId == null) continue;
      const engine = detail.engine || {};

      // qty: prefer the merged quote's quantity (used to derive per-unit base).
      const qty = num0(merged.quantity);
      if (qtyFromQuote == null && qty > 0) qtyFromQuote = qty;

      // ---- AUTHORITATIVE money values from the engine breakdown. ----
      // engine.base = unit_price * qty (the base SUB-TOTAL). The old code read
      // detail.unit_price directly, which is 0/missing whenever unit_price lives
      // on the parent quote (the real-data bug). We prefer the merged unit_price,
      // else derive per-unit base from engine.base / qty so base is non-zero for
      // every real quote.
      const subtotal = num0(engine.base);
      const rawUnit = num0(merged.unit_price);
      const base = rawUnit > 0 ? rawUnit : qty > 0 && subtotal > 0 ? Math.round((subtotal / qty) * 100) / 100 : 0;

      // tax_amt: engine.base_tax is the computed rupee tax on the base.
      // tax_pct: the merged row's tax when in percentage mode (engine applied it).
      const tax_amt = num0(engine.base_tax);
      const taxMode = merged.tax_mode;
      const taxPct = taxMode === "percentage" || taxMode == null ? num0(merged.tax) : null;

      const freight = chargeSubtotal(engine, "freight");
      const packaging = chargeSubtotal(engine, "packaging");
      const docs = docCountByQuote.get(Number(merged.quote_id ?? q.quote_id)) || 0;
      // "missing" = a freight component looks absent (no freight charge present),
      // a common signal the buyer must clarify before comparing landed cost.
      const missing = freight <= 0;

      quotesByVendor[String(vId)] = {
        base,
        subtotal,
        freight,
        packaging,
        tax_pct: taxPct,
        tax_amt,
        delivery: toNum(merged.delivery_period),
        // Payment terms: structured list first, else free-text global term.
        pay: paymentTermsText(merged),
        comment: merged.comment || merged.global_comment || null,
        docs,
        missing,
        total: num0(q.engine_grand_total ?? q.engine_total ?? engine.total),
        // Per-item other_charges (engine-computed rupee values).
        other_charges: parseOtherCharges(merged, detail),
        // Per-vendor quote-level global_charges (same across that vendor's
        // products); carried on each cell so the breakdown can render them.
        global_charges: parseGlobalCharges(q),
        // Everything the FE needs to FINALIZE this cell, so it no longer has to
        // make a second (legacy) round-trip. Mirrors the old buildFinalizePayload
        // sources exactly (raw quote line, not the engine-landed values).
        finalize: {
          quote_id: toNum(merged.quote_id ?? q.quote_id),
          quote_item_id: toNum(merged.quote_item_id ?? q.quote_item_id),
          vendor_id: toNum(detail.created_by ?? merged.created_by ?? vId),
          unit_price: toNum(merged.unit_price),
          total_value: toNum(merged.total_price ?? q.total_price),
          charges_meta: {
            freight_price: merged.freight_price ?? null,
            freight_mode: merged.freight_mode ?? null,
            package_price: merged.package_price ?? null,
            package_mode: merged.package_mode ?? null,
            tax: merged.tax ?? null,
            tax_mode: merged.tax_mode ?? null,
            other_charges: merged.other_charges || detail.other_charges || [],
          },
        },
        // Negotiation round history — one entry per round the vendor updated in
        // (final update only), oldest→newest with savings delta. Powers the
        // history modal. See buildCellHistory for the timestamp→round bucketing.
        history: buildCellHistory(q, merged, allRounds, Number(p.id), vId),
      };
    }
    // Every vendor in vendors[] gets an explicit null when they didn't quote.
    for (const v of vendors) {
      if (!(String(v.id) in quotesByVendor)) quotesByVendor[String(v.id)] = null;
    }

    // LPR. `rate`/`date` are the last-purchase BASE unit price + when. We ALSO
    // surface the all-in (GST/charges included) view so the FE can compare
    // "grand total now vs grand total previously":
    //   total       = the raw last-purchase all-in line total (total_price)
    //   qty         = the last-purchase quantity
    //   landed_unit = total / qty, 2dp -> the all-in per-unit cost
    // landed_unit is null when total or qty is missing/0 (guarded division).
    const lprSrc = p.last_purchase_rate || null;
    const lprTotal = lprSrc ? toNum(lprSrc.total_price) : null;
    const lprQty = lprSrc ? toNum(lprSrc.quantity) : null;
    const lprLandedUnit =
      lprTotal != null && lprQty != null && lprQty !== 0
        ? Math.round((lprTotal / lprQty) * 100) / 100
        : null;
    const lpr = {
      rate: lprSrc ? toNum(lprSrc.unit_price) : null,
      date: lprSrc ? iso(lprSrc.timestamp) : null,
      landed_unit: lprLandedUnit,
      total: lprTotal,
      qty: lprQty,
    };

    // Target price: prefer round target, else any vendor latest_target_price.
    const round = roundByRfqProduct.get(rfqProductId) || null;
    let target = round ? toNum(round.target_price) : null;
    if (target == null) {
      for (const q of p.quotations || []) {
        const detail = getDetail(q) || {};
        const tp = toNum(detail.latest_target_price);
        if (tp != null) { target = tp; break; }
      }
    }

    // State + finalized vendor + reject_info.
    const fin = finalizationByRfqProduct.get(rfqProductId) || null;
    const appr = approvalByRfqProduct.get(rfqProductId) || null;
    const { state, reject_info } = deriveState(fin, appr);
    const finalized_vendor = fin ? fin.vendor_id : null;
    // It's THIS user's turn to approve this product (current pending step).
    const awaiting_me = !!(
      appr &&
      (appr.status || "").toUpperCase() === "PENDING" &&
      appr.instance_id &&
      awaitingInstanceIds.has(Number(appr.instance_id))
    );

    // Approval drawer payload: current approvers (badge/tooltip) + full trail.
    const approval =
      (appr && appr.instance_id && approvalDataByInstance.get(appr.instance_id)) || {
        current_approvers: [],
        trail: [],
      };

    // Category.
    let category;
    if (useSyntheticCategory) category = SYNTHETIC_CATEGORY.id;
    else {
      const cat = categoryByRfqProduct.get(rfqProductId);
      category = cat ? cat.id : null;
    }

    // Per-product technical evaluation. `configured` is true when this product
    // has a tech-evaluation row; `scores` maps vendor_id -> calculated_score so
    // the FE can rank T1/T2/... per product (T1 = highest technical score).
    const ptech = techByProduct.get(rfqProductId) || null;
    const tech = {
      configured: !!ptech,
      scores: ptech ? Object.fromEntries(ptech.scores) : {},
    };

    return {
      id: rfqProductId,
      // Identity needed to build the finalize payload (no legacy call).
      product_variant_id: toNum(p.product_variant_id),
      variant: toNum(p.variant) ?? 0,
      name,
      category,
      qty: num0(qtySpec ? qtySpec.value : qtyFromQuote),
      unit: unitSpec ? String(unitSpec.value) : "",
      lpr,
      target,
      tech,
      round: {
        n: round ? toNum(round.round_number) : null,
        status: round ? round.status : null,
        when: round ? iso(round.end_date || round.closed_at) : null,
      },
      state,
      finalized_vendor,
      reject_info,
      awaiting_me,
      approval,
      quotes: quotesByVendor,
    };
  });

  // ---- 7) RFQ header block. ----
  const quotesReceived = await countDistinctQuoters(id);
  const quotesInvited = await countInvitedVendors(id);
  const techClauses = await rfqHasTechClauses(id);
  const rounds = await countRounds(id);

  const rfqBlock = {
    id: rfq.id,
    rfq_no: rfq.rfq_no,
    project_id: rfq.project_id ?? null,
    number: String(rfq.rfq_no),
    title: rfq.title || null,
    status: mapRfqStatus(rfq.status),
    company: rfq.company_label || rfq.company_name || null,
    hotel: rfq.hotel_label || null,
    department: rfq.department_label || null,
    contact: rfq.contact_name || null,
    phone: rfq.contact_number || null,
    email: rfq.response_email || null,
    deadline: parseDeadline(rfq.bid_end_date),
    reverse_auction: rfq.reverse_auction === 1 || rfq.reverse_auction === true,
    delivery_location: rfq.location || null,
    quotes_received: quotesReceived,
    quotes_invited: quotesInvited,
    tech_clauses: techClauses,
    rounds,
  };

  // ---- 8) Pre-deadline lock. Until bid_end_date passes, quotes stay hidden:
  // we still reveal HOW MANY vendors quoted each product (quoted_count) and keep
  // the column/row structure, but never leak any number or vendor identity. The
  // FE blurs the placeholders and shows a "locked until deadline" banner.
  // Use the SHARED visibility rule (IST, inclusive boundary) so the lock matches
  // the legacy quote-compare page exactly.
  const quotesLocked = buildQuoteVisibilityMeta(rfq).locked;

  for (const p of contractProducts) {
    const n = Object.values(p.quotes).filter((c) => c != null).length;
    p.quoted_count = n;
    if (quotesLocked) {
      for (const k of Object.keys(p.quotes)) {
        if (p.quotes[k] != null) p.quotes[k] = { locked: true }; // truthy, zero numbers
      }
      // Nothing is actionable or evaluatable before the deadline.
      p.finalized_vendor = null;
      p.awaiting_me = false;
      p.reject_info = null;
      p.state = "open";
      p.target = null;
      p.tech = { configured: !!p.tech?.configured, scores: {} };
      p.approval = { current_approvers: [], trail: [] };
    }
  }
  if (quotesLocked) {
    for (const v of vendors) {
      v.name = "Hidden until deadline";
      v.short = "•";
      v.tech = "none";
      v.tech_score = null;
      v.orders_done = null;
      v.track_record = null;
      v.on_time_pct = null;
      v.pos_accepted = null;
      v.po_value = null;
      v.quoted_rfqs = null;
      v.invited_rfqs = null;
      v.quote_pct = null;
      v.is_new = false;
    }
  }

  return {
    rfq: rfqBlock,
    quotes_locked: quotesLocked,
    bid_end_date: iso(rfq.bid_end_date),
    vendors,
    categories,
    products: contractProducts,
    approval_chain: approvalChain,
  };
}

// ---------------------------------------------------------------------------
// State derivation per product.
//   open     : no finalization, OR finalization with no quote-approval instance
//   pending  : finalized AND its NEGOTIATION_QUOTE instance is PENDING
//   approved : that instance is APPROVED
//   rejected : that instance is REJECTED -> populate reject_info
// ---------------------------------------------------------------------------
function deriveState(fin, appr) {
  if (!fin && !appr) return { state: "open", reject_info: null };
  if (!appr) return { state: "open", reject_info: null };
  const status = (appr.status || "").toUpperCase();
  if (status === "APPROVED") return { state: "approved", reject_info: null };
  if (status === "REJECTED") {
    return {
      state: "rejected",
      reject_info: appr.reject
        ? {
            by: appr.reject.by || null,
            role: appr.reject.role || null,
            reason: appr.reject.reason || null,
            date: iso(appr.reject.date),
          }
        : null,
    };
  }
  if (status === "PENDING") {
    // Pending only counts as "pending" once finalized; otherwise it's still open.
    return { state: fin ? "pending" : "open", reject_info: null };
  }
  return { state: "open", reject_info: null };
}

// ---------------------------------------------------------------------------
// Side-lookup helpers.
// ---------------------------------------------------------------------------

// rfq_product_id -> { id, name } category. Maps through
// tbl_rfq_products -> product_variant -> tbl_product -> tbl_product_categories.
// Prefers the most specific (child) category when a product has several.
async function fetchCategories(rfqId, rfqProductIds) {
  const map = new Map();
  if (!rfqProductIds.length) return map;
  try {
    const rows = await db.any(
      `SELECT rp.id AS rfq_product_id, c.id AS category_id, c.title AS category_name,
              c.parent_id
         FROM tbl_rfq_products rp
         JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
         JOIN tbl_category c ON c.id = pc.category_id
        WHERE rp.id = ANY($1::int[])
          AND COALESCE(c.is_deleted, 0) = 0
        ORDER BY rp.id, (c.parent_id IS NOT NULL) DESC, c.id ASC`,
      [rfqProductIds]
    );
    for (const r of rows) {
      const pid = Number(r.rfq_product_id);
      if (!map.has(pid)) map.set(pid, { id: Number(r.category_id), name: r.category_name });
    }
  } catch (e) {
    logError("quoteCompareView fetchCategories failed", e);
  }
  return map;
}

// rfq_product_id -> { status, reject:{by,role,reason,date} | null } for the
// latest NEGOTIATION_QUOTE approval instance on that product.
async function fetchQuoteApprovals(rfqProductIds) {
  const map = new Map();
  if (!rfqProductIds.length) return map;
  try {
    const instances = await db.any(
      `SELECT DISTINCT ON (entity_id) id, entity_id, status, created_at
         FROM tbl_approval_instances
        WHERE entity_type = 'NEGOTIATION_QUOTE'
          AND entity_id = ANY($1::int[])
        ORDER BY entity_id, created_at DESC`,
      [rfqProductIds]
    );
    if (!instances.length) return map;

    const rejectedIds = instances.filter((i) => (i.status || "").toUpperCase() === "REJECTED").map((i) => i.id);
    const rejectByInstance = new Map();
    if (rejectedIds.length) {
      // Mirror poDashboardModel.buildAuditTrail: take the REJECT action, the
      // acting user's name + their role title + the action comment + when.
      const actions = await db.any(
        `SELECT DISTINCT ON (a.approval_instance_id)
                a.approval_instance_id, a.comment, a.created_at,
                u.name AS actor_name,
                (SELECT rl.title
                   FROM tbl_user_role_scopes urs
                   JOIN tbl_roles rl ON rl.id = urs.role_id
                  WHERE urs.user_id = a.approver_user_id
                  ORDER BY urs.id ASC LIMIT 1) AS actor_role
           FROM tbl_approval_actions a
           JOIN tbl_users u ON u.id = a.approver_user_id
          WHERE a.approval_instance_id = ANY($1::int[])
            AND a.action = 'REJECT'
          ORDER BY a.approval_instance_id, a.created_at DESC`,
        [rejectedIds]
      );
      for (const a of actions) {
        rejectByInstance.set(a.approval_instance_id, {
          by: a.actor_name,
          role: a.actor_role || null,
          reason: a.comment || null,
          date: a.created_at,
        });
      }
    }

    for (const i of instances) {
      map.set(Number(i.entity_id), {
        instance_id: i.id,
        status: i.status,
        reject: rejectByInstance.get(i.id) || null,
      });
    }
  } catch (e) {
    logError("quoteCompareView fetchQuoteApprovals failed", e);
  }
  return map;
}

// Batched per-instance approval data for the QC approval drawer. Returns
// Map(instanceId -> { current_approvers:[{name,initials,role}], trail:[node] }).
// Each trail node mirrors poDashboardModel.buildAuditTrail:
//   { key, status:'done'|'rejected'|'current'|'pending', title, by, initials,
//     role, when, reason, approvers:[{name,initials,role,status}] }
// A leading "Sent for approval" node uses the instance initiator + created_at.
async function buildQuoteApprovalData(instanceIds) {
  const out = new Map();
  const ids = (instanceIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return out;
  try {
    const instances = await db.any(
      `SELECT ai.id, ai.status, ai.current_step, ai.created_at, ai.initiated_by,
              u.name AS initiator_name
         FROM tbl_approval_instances ai
         LEFT JOIN tbl_users u ON u.id = ai.initiated_by
        WHERE ai.id = ANY($1::int[])`,
      [ids]
    );
    const steps = await db.any(
      `SELECT st.approval_instance_id, st.id, st.step_order, st.status, st.completed_at,
              COALESCE(
                JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'user_id', sa.approver_user_id, 'name', u.name,
                    'status', sa.status, 'acted_at', sa.acted_at,
                    'role', (SELECT rl.title FROM tbl_user_role_scopes urs
                               JOIN tbl_roles rl ON rl.id = urs.role_id
                              WHERE urs.user_id = sa.approver_user_id
                              ORDER BY urs.id ASC LIMIT 1)
                  ) ORDER BY sa.id
                ) FILTER (WHERE sa.id IS NOT NULL),
                '[]'
              ) AS approvers
         FROM tbl_approval_instance_steps st
         LEFT JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = st.id
         LEFT JOIN tbl_users u ON u.id = sa.approver_user_id
        WHERE st.approval_instance_id = ANY($1::int[])
        GROUP BY st.id
        ORDER BY st.approval_instance_id, st.step_order ASC`,
      [ids]
    );
    const actions = await db.any(
      `SELECT a.approval_instance_id, a.action, a.comment, a.created_at, a.approver_user_id
         FROM tbl_approval_actions a
        WHERE a.approval_instance_id = ANY($1::int[]) AND a.action IN ('APPROVE', 'REJECT')
        ORDER BY a.created_at ASC`,
      [ids]
    );

    const instById = new Map(instances.map((i) => [i.id, i]));
    const stepsByInst = new Map();
    for (const s of steps) {
      if (!stepsByInst.has(s.approval_instance_id)) stepsByInst.set(s.approval_instance_id, []);
      stepsByInst.get(s.approval_instance_id).push(s);
    }
    const rejectByUserByInst = new Map();
    const firstRejectByInst = new Map();
    for (const a of actions) {
      if (a.action !== "REJECT") continue;
      if (!firstRejectByInst.has(a.approval_instance_id) && a.comment) {
        firstRejectByInst.set(a.approval_instance_id, a.comment);
      }
      if (a.approver_user_id != null && a.comment) {
        if (!rejectByUserByInst.has(a.approval_instance_id)) rejectByUserByInst.set(a.approval_instance_id, new Map());
        rejectByUserByInst.get(a.approval_instance_id).set(a.approver_user_id, a.comment);
      }
    }

    const personOf = (a) => ({ name: a?.name || null, initials: initialsOf(a?.name), role: a?.role || null });

    for (const instId of ids) {
      const inst = instById.get(instId);
      if (!inst) continue;
      const istatus = (inst.status || "").toUpperCase();
      const trail = [
        {
          key: "sent",
          status: "done",
          title: "Sent for approval",
          by: inst.initiator_name || null,
          initials: initialsOf(inst.initiator_name),
          role: null,
          when: iso(inst.created_at),
          reason: null,
          approvers: [],
        },
      ];
      let current_approvers = [];
      for (const st of stepsByInst.get(instId) || []) {
        const approvers = Array.isArray(st.approvers) ? st.approvers : [];
        const acted = approvers.find((a) => a.acted_at);
        const pendingApprover = approvers.find((a) => a.status === "PENDING");
        const rejecter = approvers.find((a) => (a.status || "").toUpperCase() === "REJECTED");
        const sStatus = (st.status || "").toUpperCase();

        let nodeStatus;
        if (sStatus === "REJECTED") nodeStatus = "rejected";
        else if (sStatus === "APPROVED") nodeStatus = "done";
        else if (sStatus === "PENDING" && st.step_order === inst.current_step && istatus === "PENDING")
          nodeStatus = "current";
        else nodeStatus = "pending";

        const actor = rejecter || acted || pendingApprover || approvers[0] || null;
        let reason = null;
        if (nodeStatus === "rejected") {
          const rc = rejectByUserByInst.get(instId);
          reason =
            (rejecter && rc && rc.get(rejecter.user_id)) ||
            (acted && rc && rc.get(acted.user_id)) ||
            firstRejectByInst.get(instId) ||
            null;
        }
        if (nodeStatus === "current") {
          const pend = approvers.filter((a) => (a.status || "").toUpperCase() === "PENDING");
          current_approvers = (pend.length ? pend : approvers).map(personOf);
        }

        trail.push({
          key: `step-${st.step_order}`,
          status: nodeStatus,
          title: `L${st.step_order} approval`,
          by: actor ? actor.name : null,
          initials: initialsOf(actor ? actor.name : null),
          role: actor ? actor.role || null : null,
          when: iso(st.completed_at),
          reason,
          approvers: approvers.map((a) => ({ ...personOf(a), status: a.status })),
        });
      }

      // Terminal outcome node so the chain end is explicit (it's not just "the
      // next approver" — once every step clears, the quote is forwarded onward).
      // Skip on rejection: the rejected step already terminates the trail.
      if (istatus === "APPROVED") {
        trail.push({
          key: "completed",
          kind: "terminal",
          status: "done",
          title: "Approval complete",
          note: "Forwarded to the next stage",
          by: null,
          initials: "",
          role: null,
          when: null,
          reason: null,
          approvers: [],
        });
      } else if (istatus !== "REJECTED") {
        trail.push({
          key: "forward",
          kind: "terminal",
          status: "pending",
          title: "Forwarded to the next stage",
          note: "Once all approvals are complete",
          by: null,
          initials: "",
          role: null,
          when: null,
          reason: null,
          approvers: [],
        });
      }

      out.set(instId, { current_approvers, trail });
    }
  } catch (e) {
    logError("quoteCompareView buildQuoteApprovalData failed", e);
  }
  return out;
}

// Set of approval_instance ids (from the given list) where `userId` is a PENDING
// approver of the instance's CURRENT pending step — i.e. it's that user's turn.
// Mirrors poDashboardModel.fetchCurrentApproverInfo. Best-effort; empty on error.
async function fetchAwaitingInstanceIds(instanceIds, userId) {
  const ids = (instanceIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  const set = new Set();
  if (!ids.length || !userId) return set;
  try {
    const rows = await db.any(
      `SELECT DISTINCT tai.id
         FROM tbl_approval_instances tai
         JOIN tbl_approval_instance_steps st
           ON st.approval_instance_id = tai.id
          AND st.step_order = tai.current_step
          AND st.status = 'PENDING'
         JOIN tbl_approval_step_approvers sa
           ON sa.approval_instance_step_id = st.id
          AND sa.status = 'PENDING'
        WHERE tai.id = ANY($1::int[])
          AND tai.status = 'PENDING'
          AND sa.approver_user_id = $2`,
      [ids, userId]
    );
    for (const r of rows) set.add(Number(r.id));
  } catch (e) {
    logError("quoteCompareView fetchAwaitingInstanceIds failed", e);
  }
  return set;
}

// rfq_product_id -> { vendor_id } latest finalization. Finalization is keyed by
// (rfq_id, product_variant_id, variant); map each back to its rfq_product row.
async function fetchFinalizations(rfqId, products) {
  const map = new Map();
  try {
    const rows = await db.any(
      `SELECT DISTINCT ON (product_variant_id, COALESCE(variant, 0))
              product_variant_id, COALESCE(variant, 0) AS variant, vendor_id, "timestamp"
         FROM tbl_quote_finalization
        WHERE rfq_id = $1
        ORDER BY product_variant_id, COALESCE(variant, 0), "timestamp" DESC`,
      [rfqId]
    );
    const byVariant = new Map();
    for (const r of rows) byVariant.set(`${r.product_variant_id}:${r.variant}`, r);
    for (const p of products) {
      const pvid = Number(p.product_variant_id);
      const variant = Number(p.variant || 0);
      const hit = byVariant.get(`${pvid}:${variant}`);
      if (hit) map.set(Number(p.id), { vendor_id: Number(hit.vendor_id) });
    }
  } catch (e) {
    logError("quoteCompareView fetchFinalizations failed", e);
  }
  return map;
}

// rfq_product_id -> latest negotiation round row.
// All negotiation rounds for an RFQ (both RFQ-level and product-level), oldest
// first — powers the per-round quote history (buildCellHistory). Unlike
// fetchActiveRounds (latest active round per product, product-scoped only) this
// keeps every round and its `created_at` start + vendor_ids for time-bucketing.
async function fetchAllRounds(rfqId) {
  try {
    return await db.any(
      `SELECT round_number, rfq_product_id, created_at, vendor_ids
         FROM tbl_negotiation_rounds
        WHERE rfq_id = $1
        ORDER BY created_at ASC, round_number ASC`,
      [rfqId]
    );
  } catch (e) {
    logError("quoteCompareView fetchAllRounds failed", e);
    return [];
  }
}

async function fetchActiveRounds(rfqProductIds) {
  const map = new Map();
  if (!rfqProductIds.length) return map;
  try {
    const rows = await db.any(
      `SELECT DISTINCT ON (rfq_product_id)
              rfq_product_id, round_number, target_price, end_date, closed_at,
              CASE WHEN status = 'ACTIVE' AND end_date <= NOW() THEN 'ENDED' ELSE status END AS status
         FROM tbl_negotiation_rounds
        WHERE rfq_product_id = ANY($1::int[])
        ORDER BY rfq_product_id, round_number DESC`,
      [rfqProductIds]
    );
    for (const r of rows) map.set(Number(r.rfq_product_id), r);
  } catch (e) {
    logError("quoteCompareView fetchActiveRounds failed", e);
  }
  return map;
}

// vendor_id (number) -> orders_done (int): count of purchase orders awarded to
// this vendor, batched across all vendors with a single GROUP BY. Restricted to
// the RFQ's hospitality company (via the joined tbl_rfq) and excluding statuses
// that are not real awards (draft / cancelled / rejected / rejected_by_vendor).
// Defensive: on any failure returns an empty map so callers default to 0.
async function fetchVendorOrderCounts(vendorIds, hospitalityCompanyId) {
  const map = new Map();
  const ids = (vendorIds || []).map((v) => Number(v)).filter(Number.isInteger);
  if (!ids.length) return map;
  try {
    const rows = await db.any(
      `SELECT po.finalized_vendor_id AS vendor_id, COUNT(*)::int AS cnt
         FROM tbl_rfq_purchase_order po
         JOIN tbl_rfq r ON r.id = po.rfq_id
        WHERE po.finalized_vendor_id = ANY($1::int[])
          AND ($2::int IS NULL OR r.hospitality_company_id = $2)
          AND po.status NOT IN ('draft', 'cancelled', 'rejected', 'rejected_by_vendor')
        GROUP BY po.finalized_vendor_id`,
      [ids, hospitalityCompanyId != null ? Number(hospitalityCompanyId) : null]
    );
    for (const r of rows) map.set(Number(r.vendor_id), Number(r.cnt));
  } catch (e) {
    logError("quoteCompareView fetchVendorOrderCounts failed", e);
  }
  return map;
}

// quote_id -> document file count.
async function fetchQuoteDocCounts(rfqId) {
  const map = new Map();
  try {
    const rows = await db.any(
      `SELECT qf.quote_id, COUNT(*)::int AS cnt
         FROM tbl_quotes_files qf
         JOIN tbl_quotes q ON q.id = qf.quote_id
        WHERE q.rfq_id = $1
        GROUP BY qf.quote_id`,
      [rfqId]
    );
    for (const r of rows) map.set(Number(r.quote_id), Number(r.cnt));
  } catch (e) {
    logError("quoteCompareView fetchQuoteDocCounts failed", e);
  }
  return map;
}

// vendor_id (string) -> { tech: 'cleared'|'pending'|'none', tech_score:int|null }.
// Mirrors poDashboardModel.buildTechEval's read of cleared_vendors
// (status / calculated_score). A vendor is 'cleared' if they passed (status=1)
// for at least one of this RFQ's tech evaluations; 'pending' if a verdict row
// exists but not yet passed; 'none' if the RFQ has no tech clauses for them.
async function fetchVendorTech(rfqId) {
  const map = new Map();
  try {
    const teRows = await db.any(
      `SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`,
      [rfqId]
    );
    if (!teRows.length) return map; // no tech eval at all -> everyone 'none'
    const teIds = teRows.map((r) => r.id);
    const cvRows = await db.any(
      `SELECT vendor_id, status, calculated_score
         FROM tbl_rfq_product_tech_evaluation_cleared_vendors
        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    );
    for (const r of cvRows) {
      const key = String(r.vendor_id);
      const score = r.calculated_score != null ? Math.round(Number(r.calculated_score)) : null;
      const passed = Number(r.status) === 1;
      const prev = map.get(key);
      // Prefer a cleared verdict if any product passed; keep best score.
      if (!prev) {
        map.set(key, { tech: passed ? "cleared" : "pending", tech_score: score });
      } else {
        const tech = prev.tech === "cleared" || passed ? "cleared" : "pending";
        const tech_score =
          score != null && (prev.tech_score == null || score > prev.tech_score) ? score : prev.tech_score;
        map.set(key, { tech, tech_score });
      }
    }
  } catch (e) {
    logError("quoteCompareView fetchVendorTech failed", e);
  }
  return map;
}

// rfqProductId -> { scores: Map(vendorId(string) -> calculated_score|int) }.
// A product is in the map iff it has a technical evaluation configured (a row in
// tbl_rfq_product_tech_evaluation). Per-product per-vendor scores power the FE's
// T-rank (T1 = highest technical score for that product). Vendors without a
// scored verdict simply don't appear in `scores`.
async function fetchProductTech(rfqId) {
  const map = new Map();
  try {
    const rows = await db.any(
      `SELECT te.tbl_rfq_product_id AS rfq_product_id,
              cv.vendor_id, cv.calculated_score
         FROM tbl_rfq_product_tech_evaluation te
         LEFT JOIN tbl_rfq_product_tech_evaluation_cleared_vendors cv
                ON cv.tbl_rfq_product_tech_evaluation_id = te.id
        WHERE te.rfq_id = $1`,
      [rfqId]
    );
    for (const r of rows) {
      const pid = Number(r.rfq_product_id);
      if (!map.has(pid)) map.set(pid, { scores: new Map() });
      if (r.vendor_id != null && r.calculated_score != null) {
        map.get(pid).scores.set(String(r.vendor_id), Math.round(Number(r.calculated_score)));
      }
    }
  } catch (e) {
    logError("quoteCompareView fetchProductTech failed", e);
  }
  return map;
}

// vendor_id -> { pos_accepted, po_value, quoted_rfqs, invited_rfqs }. All
// tenant-scoped by hospitality_company_id. "accepted" = the PO passed the vendor
// acceptance gate (status beyond acceptance_pending; never rejected/cancelled).
// Quote participation = distinct RFQs quoted / distinct RFQs invited.
async function fetchVendorTrackRecord(vendorIds, hospitalityCompanyId) {
  const map = new Map();
  const ids = (vendorIds || []).map((v) => Number(v)).filter(Number.isInteger);
  if (!ids.length) return map;
  const hc = hospitalityCompanyId != null ? Number(hospitalityCompanyId) : null;
  const ensure = (id) => {
    if (!map.has(id)) map.set(id, { pos_accepted: 0, po_value: 0, quoted_rfqs: 0, invited_rfqs: 0 });
    return map.get(id);
  };
  try {
    const poRows = await db.any(
      `SELECT po.finalized_vendor_id AS vendor_id,
              COUNT(*)::int AS pos,
              COALESCE(SUM(po.total_value), 0)::float8 AS value
         FROM tbl_rfq_purchase_order po
         JOIN tbl_rfq r ON r.id = po.rfq_id
        WHERE po.finalized_vendor_id = ANY($1::int[])
          AND ($2::int IS NULL OR r.hospitality_company_id = $2)
          AND po.status IN ('approved', 'sent', 'GRN', 'completed', 'invoice_raised', 'dispatched')
        GROUP BY po.finalized_vendor_id`,
      [ids, hc]
    );
    for (const r of poRows) {
      const e = ensure(Number(r.vendor_id));
      e.pos_accepted = Number(r.pos);
      e.po_value = Number(r.value);
    }
  } catch (e) {
    logError("quoteCompareView trackRecord PO failed", e);
  }
  try {
    const invRows = await db.any(
      `SELECT pv.user_id AS vendor_id, COUNT(DISTINCT pv.rfq_id)::int AS cnt
         FROM tbl_rfq_product_vendors pv
         JOIN tbl_rfq r ON r.id = pv.rfq_id
        WHERE pv.user_id = ANY($1::int[])
          AND ($2::int IS NULL OR r.hospitality_company_id = $2)
        GROUP BY pv.user_id`,
      [ids, hc]
    );
    for (const r of invRows) ensure(Number(r.vendor_id)).invited_rfqs = Number(r.cnt);
  } catch (e) {
    logError("quoteCompareView trackRecord invited failed", e);
  }
  try {
    const qRows = await db.any(
      `SELECT q.created_by AS vendor_id, COUNT(DISTINCT q.rfq_id)::int AS cnt
         FROM tbl_quotes q
         JOIN tbl_rfq r ON r.id = q.rfq_id
        WHERE q.created_by = ANY($1::int[])
          AND ($2::int IS NULL OR r.hospitality_company_id = $2)
          AND (q.is_regret IS NULL OR q.is_regret != 1)
        GROUP BY q.created_by`,
      [ids, hc]
    );
    for (const r of qRows) ensure(Number(r.vendor_id)).quoted_rfqs = Number(r.cnt);
  } catch (e) {
    logError("quoteCompareView trackRecord quoted failed", e);
  }
  return map;
}

// Commercial / quote approval chain for the RFQ. Prefer the actual steps of the
// latest NEGOTIATION_QUOTE instance (reflects resolved approvers); fall back to
// the applicable policy steps when no instance exists yet. [] if not derivable.
async function fetchApprovalChain(rfq, approvalByRfqProduct, scope) {
  try {
    // Find the latest NEGOTIATION_QUOTE instance for this RFQ (any product).
    const instanceId = (() => {
      let best = null;
      for (const v of approvalByRfqProduct.values()) {
        if (v && v.instance_id && (!best || v.instance_id > best)) best = v.instance_id;
      }
      return best;
    })();

    if (instanceId) {
      const rows = await db.any(
        `SELECT st.step_order,
                sa.approver_user_id, u.name AS approver_name,
                (SELECT rl.title FROM tbl_user_role_scopes urs
                   JOIN tbl_roles rl ON rl.id = urs.role_id
                  WHERE urs.user_id = sa.approver_user_id
                  ORDER BY urs.id ASC LIMIT 1) AS approver_role
           FROM tbl_approval_instance_steps st
           LEFT JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = st.id
           LEFT JOIN tbl_users u ON u.id = sa.approver_user_id
          WHERE st.approval_instance_id = $1
          ORDER BY st.step_order ASC, sa.id ASC`,
        [instanceId]
      );
      const byStep = new Map();
      for (const r of rows) {
        if (!byStep.has(r.step_order)) byStep.set(r.step_order, []);
        if (r.approver_user_id != null) byStep.get(r.step_order).push(r);
      }
      const chain = [];
      for (const [stepOrder, approvers] of byStep) {
        const first = approvers[0] || {};
        const youHit = approvers.find(
          (a) => scope && Number(a.approver_user_id) === Number(scope.userId)
        );
        chain.push({
          num: Number(stepOrder),
          name: approvers.length > 1 ? `${approvers.length} approvers` : first.approver_name || null,
          role: first.approver_role || null,
          you: !!youHit,
        });
      }
      if (chain.length) return chain;
    }

    // Fallback: applicable policy steps.
    const policy = await db.oneOrNone(
      `SELECT id FROM tbl_approval_policies
        WHERE entity_type = 'NEGOTIATION_QUOTE'
          AND hospitality_company_id = $1
          AND (hotel_id IS NULL OR hotel_id = $2)
          AND (department_id IS NULL OR department_id = $3)
          AND COALESCE(is_active, true) = true
        ORDER BY (hotel_id IS NOT NULL)::int + (department_id IS NOT NULL)::int DESC,
                 created_at DESC
        LIMIT 1`,
      [rfq.hospitality_company_id, rfq.hotel_id, rfq.department_id]
    );
    if (!policy) return [];
    const steps = await db.any(
      `SELECT s.step_order, s.approver_source_type, s.approver_source_id,
              CASE
                WHEN s.approver_source_type = 'USER' THEN (SELECT name FROM tbl_users WHERE id = s.approver_source_id)
                WHEN s.approver_source_type = 'ROLE' THEN (SELECT title FROM tbl_roles WHERE id = s.approver_source_id)
                WHEN s.approver_source_type = 'DEPARTMENT' THEN (SELECT title FROM tbl_department WHERE id = s.approver_source_id)
                ELSE NULL
              END AS source_name
         FROM tbl_approval_policy_steps s
        WHERE s.approval_policy_id = $1
        ORDER BY s.step_order ASC`,
      [policy.id]
    );
    return steps.map((s) => ({
      num: Number(s.step_order),
      name: s.approver_source_type === "USER" ? s.source_name : null,
      role: s.approver_source_type === "ROLE" ? s.source_name : s.source_name || null,
      you:
        s.approver_source_type === "USER" &&
        scope &&
        Number(s.approver_source_id) === Number(scope.userId),
    }));
  } catch (e) {
    logError("quoteCompareView fetchApprovalChain failed", e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Small RFQ-header aggregate helpers.
// ---------------------------------------------------------------------------
async function countDistinctQuoters(rfqId) {
  try {
    const r = await db.oneOrNone(
      `SELECT COUNT(DISTINCT created_by)::int AS cnt
         FROM tbl_quotes
        WHERE rfq_id = $1 AND (is_regret IS NULL OR is_regret != 1)`,
      [rfqId]
    );
    return r ? Number(r.cnt) : 0;
  } catch (e) {
    logError("quoteCompareView countDistinctQuoters failed", e);
    return 0;
  }
}

async function countInvitedVendors(rfqId) {
  try {
    const r = await db.oneOrNone(
      `SELECT COUNT(DISTINCT user_id)::int AS cnt FROM tbl_rfq_product_vendors WHERE rfq_id = $1`,
      [rfqId]
    );
    return r ? Number(r.cnt) : 0;
  } catch (e) {
    logError("quoteCompareView countInvitedVendors failed", e);
    return 0;
  }
}

async function rfqHasTechClauses(rfqId) {
  try {
    const r = await db.oneOrNone(
      `SELECT EXISTS(
         SELECT 1 FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1
       ) AS has`,
      [rfqId]
    );
    return !!(r && r.has);
  } catch (e) {
    logError("quoteCompareView rfqHasTechClauses failed", e);
    return false;
  }
}

async function countRounds(rfqId) {
  const out = { active: 0, pending: 0, ended: 0 };
  try {
    const rows = await db.any(
      `SELECT CASE WHEN status = 'ACTIVE' AND end_date <= NOW() THEN 'ENDED' ELSE status END AS status,
              COUNT(*)::int AS cnt
         FROM tbl_negotiation_rounds
        WHERE rfq_id = $1
        GROUP BY 1`,
      [rfqId]
    );
    for (const r of rows) {
      const s = (r.status || "").toUpperCase();
      if (s === "ACTIVE") out.active += Number(r.cnt);
      else if (s === "PENDING_APPROVAL") out.pending += Number(r.cnt);
      else if (s === "ENDED" || s === "CLOSED") out.ended += Number(r.cnt);
    }
  } catch (e) {
    logError("quoteCompareView countRounds failed", e);
  }
  return out;
}

// tbl_rfq.status is an integer code. Map the common codes to a label; unknown
// codes pass through as a string so the FE always gets something renderable.
const RFQ_STATUS_LABELS = {
  1: "PUBLISHED",
  2: "CLOSED",
  3: "AWARDED",
  4: "PENDING_APPROVAL",
  5: "DRAFT",
};
function mapRfqStatus(status) {
  if (status == null) return null;
  return RFQ_STATUS_LABELS[Number(status)] || String(status);
}

// bid_end_date is stored as free text ("YYYY-MM-DD HH:mm:ss"); coerce to ISO
// when parseable, else null.
function parseDeadline(raw) {
  if (!raw) return null;
  const d = new Date(String(raw).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default { getQuoteComparisonView };
