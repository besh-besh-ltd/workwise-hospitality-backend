// GST state codes and the intra/inter-state tax split (Vendor Networks spec §6.4).
//
// The supplier's state is the first two characters of its GSTIN. The place of supply is
// the buyer hotel: its GSTIN, else its state_id resolved to a GST code by state name.
// Same state: CGST + SGST, each half the GST rate (CGST + UTGST in a Union Territory
// without a legislature). Different states: IGST at the full rate. Either side unknown:
// null, and callers keep the legacy single "GST" presentation.

import db from "../config/dbConn.js";

/**
 * The official GST state code list (GSTN). 25 and 28 are kept for reading old GSTINs:
 *   - 25 Daman and Diu merged into 26 on 26 Jan 2020 ("Dadra and Nagar Haveli and
 *     Daman and Diu"); its registrations were moved to 26.
 *   - 28 is Andhra Pradesh before the 2014 division; GST-era Andhra Pradesh is 37. A 28
 *     GSTIN is not mapped to either state: its tax split is unknown.
 */
export const GST_STATE_CODES = Object.freeze({
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (before division)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
});

// Codes that denote the same state today (see GST_STATE_CODES).
const CURRENT_CODE = Object.freeze({ "25": "26" });

// Union Territories without a legislature levy UTGST in place of SGST (UTGST Act 2017):
// Chandigarh, Daman and Diu (legacy), Dadra and Nagar Haveli and Daman and Diu,
// Lakshadweep, Andaman and Nicobar Islands, Ladakh, Other Territory. Delhi, Puducherry
// and Jammu and Kashmir have legislatures and levy SGST.
export const UTGST_CODES = Object.freeze(new Set(["04", "25", "26", "31", "35", "38", "97"]));

// Same format check as POST /entities (entityController GSTIN_RE).
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

const normalizeName = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

// State name -> code. Built from the official names, then the spellings found in
// tbl_location_states and in common use (old names, the pre-merger UTs, a known typo).
const CODE_BY_NAME = (() => {
  const map = new Map();
  for (const [code, name] of Object.entries(GST_STATE_CODES)) {
    if (code === "25" || code === "28") continue; // legacy codes are never a place of supply
    map.set(normalizeName(name), code);
  }
  const aliases = {
    "jammu kashmir": "01",
    "himachal praddesh": "02",
    "uttaranchal": "05",
    "nct of delhi": "07",
    "new delhi": "07",
    "national capital territory of delhi": "07",
    "orissa": "21",
    "daman and diu": "26",
    "dadra and nagar haveli": "26",
    "dadra nagar haveli": "26",
    "pondicherry": "34",
    "andaman and nicobar": "35",
    "andaman nicobar islands": "35",
  };
  for (const [name, code] of Object.entries(aliases)) map.set(name, code);
  return map;
})();

/** '27' for a well-formed GSTIN with a known state code, else null. */
export function stateCodeFromGstin(gstin) {
  const value = String(gstin ?? "").trim().toUpperCase();
  if (!GSTIN_RE.test(value)) return null;
  const code = value.slice(0, 2);
  return GST_STATE_CODES[code] ? code : null;
}

/** GST code for a state name (tbl_location_states.state_name), else null. */
export function stateCodeFromName(stateName) {
  return CODE_BY_NAME.get(normalizeName(stateName)) ?? null;
}

/**
 * Place of supply for a hotel: its GSTIN's code, else its state_id's name matched to a
 * code, else null. A hotel with neither (prod has some) is unknown, never a guess.
 */
export async function stateCodeForHotel(hotelId, runner = db) {
  if (hotelId == null) return null;
  const row = await runner.oneOrNone(
    `SELECT h.gst, s.state_name
       FROM tbl_hospitality_company_hotels h
       LEFT JOIN tbl_location_states s ON s.id = h.state_id
      WHERE h.id = $1`,
    [hotelId]
  );
  if (!row) return null;
  return stateCodeFromGstin(row.gst) ?? stateCodeFromName(row.state_name);
}

/**
 * 'CGST_SGST' within one state ('CGST_UTGST' within a UT without a legislature), 'IGST'
 * across states, null when either side is unknown (or is the pre-division 28).
 */
export function taxSplitFor(supplierCode, placeCode) {
  if (!GST_STATE_CODES[supplierCode] || !GST_STATE_CODES[placeCode]) return null;
  if (supplierCode === "28" || placeCode === "28") return null;
  const a = CURRENT_CODE[supplierCode] ?? supplierCode;
  const b = CURRENT_CODE[placeCode] ?? placeCode;
  if (a !== b) return "IGST";
  return UTGST_CODES.has(b) ? "CGST_UTGST" : "CGST_SGST";
}

/** The column labels of a split, in print order. */
export function taxLabelsFor(split) {
  if (split === "CGST_SGST") return ["CGST", "SGST"];
  if (split === "CGST_UTGST") return ["CGST", "UTGST"];
  if (split === "IGST") return ["IGST"];
  return ["GST"];
}

/**
 * The tax rows for one GST amount at one rate: [{ label, rate, amount }]. The amount is
 * first rounded to paise; CGST takes the lower half and SGST (or UTGST) the rest, so the
 * two add up to the GST amount exactly. A null split gives the single legacy 'GST' row.
 */
export function taxLinesFor(split, ratePct, gstAmount) {
  const rate = ratePct == null ? null : Number(ratePct);
  const paise = Math.round(Number(gstAmount || 0) * 100);
  if (split === "CGST_SGST" || split === "CGST_UTGST") {
    const cgst = Math.floor(paise / 2);
    const half = rate == null ? null : rate / 2;
    const [, second] = taxLabelsFor(split);
    return [
      { label: "CGST", rate: half, amount: cgst / 100 },
      { label: second, rate: half, amount: (paise - cgst) / 100 },
    ];
  }
  return [{ label: split === "IGST" ? "IGST" : "GST", rate, amount: paise / 100 }];
}

/** Sums tax rows of many lines by (label, rate), in paise, keeping first-seen order. */
export function summarizeTaxLines(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.label}|${r.rate}`;
    const prev = byKey.get(key);
    const paise = Math.round(Number(r.amount || 0) * 100);
    if (prev) prev.paise += paise;
    else byKey.set(key, { label: r.label, rate: r.rate, paise });
  }
  return [...byKey.values()].map(({ label, rate, paise }) => ({ label, rate, amount: paise / 100 }));
}

/**
 * The supplier's registered identity for documents. Name: the company name, else the
 * login name. GSTIN: tbl_company.gstin, else the latest 'gst' vendor document. Address
 * and state: the company's latest location. state_code comes from the GSTIN only (the
 * registration decides the tax), and names the state when it is known.
 * @returns {Promise<{ vendor_id, name, email, gstin, address, state_name, state_code }|null>}
 */
export async function supplierDetailsFor(vendorId, runner = db) {
  if (vendorId == null) return null;
  const row = await runner.oneOrNone(
    `SELECT u.id, u.name AS user_name, u.email, c.company_name, c.gstin AS company_gstin,
            doc.document_number AS doc_gstin,
            loc.address, ci.city_name, loc.postal_code, s.state_name
       FROM tbl_users u
       LEFT JOIN tbl_company c ON c.id = u.company_id
       LEFT JOIN LATERAL (
         SELECT l.address, l.city_id, l.state_id, l.postal_code
           FROM tbl_company_location l
          WHERE l.company_id = u.company_id
          ORDER BY l.updated_at DESC NULLS LAST, l.id DESC
          LIMIT 1
       ) loc ON TRUE
       LEFT JOIN tbl_location_cities ci ON ci.id = loc.city_id
       LEFT JOIN tbl_location_states s ON s.id = loc.state_id
       LEFT JOIN LATERAL (
         SELECT d.document_number
           FROM tbl_vendor_documents d
          WHERE d.vendor_id = u.id AND d.document_type = 'gst'
            AND NULLIF(trim(d.document_number), '') IS NOT NULL
          ORDER BY d.updated_at DESC NULLS LAST, d.id DESC
          LIMIT 1
       ) doc ON TRUE
      WHERE u.id = $1`,
    [vendorId]
  );
  if (!row) return null;
  const clean = (v) => {
    const s = String(v ?? "").trim();
    return s || null;
  };
  const gstin = (clean(row.company_gstin) ?? clean(row.doc_gstin))?.toUpperCase() ?? null;
  const stateCode = stateCodeFromGstin(gstin);
  const address = [clean(row.address), clean(row.city_name), clean(row.postal_code)].filter(Boolean).join(", ") || null;
  return {
    vendor_id: Number(row.id),
    name: clean(row.company_name) ?? clean(row.user_name),
    email: clean(row.email),
    gstin,
    address,
    state_name: stateCode ? GST_STATE_CODES[stateCode] : clean(row.state_name),
    state_code: stateCode,
  };
}

export default {
  GST_STATE_CODES,
  stateCodeFromGstin,
  stateCodeFromName,
  stateCodeForHotel,
  taxSplitFor,
  taxLabelsFor,
  taxLinesFor,
  summarizeTaxLines,
  supplierDetailsFor,
};
