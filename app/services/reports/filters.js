// ============================================================================
// filters.js
// ----------------------------------------------------------------------------
// Turns the filter payload a report page sends into the validated, normalised
// shape the model layer binds.
//
// Nothing in here carries tenant identity. A report's scope comes from
// req.user via deriveScope(); these are the facets a user is allowed to choose
// — a period, a business unit, a category — and they can only ever narrow what
// the scope predicate already allows. That separation is what makes it safe to
// echo the payload straight back into the export ledger.
// ============================================================================

import { currentFinancialYearIst } from "../../helper/financialYear.js";

/** "2026-27" -> 2026. Returns null for anything that is not an FY label. */
function fyStartYear(label) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(label || "").trim());
  if (!m) return null;
  const start = Number(m[1]);
  // The second half must be the next year, so "2026-28" is rejected rather
  // than silently treated as 2026-27.
  if (Number(m[2]) !== (start + 1) % 100) return null;
  return start;
}

/**
 * The FY window as IST calendar dates, `to` exclusive.
 *
 * Exclusive upper bound on purpose: `<= '2027-03-31'` against a timestamp
 * drops everything after midnight on the last day of the year, which is a
 * whole day of March spend that nobody notices is missing until finance does.
 */
export function fyWindow(label) {
  const start = fyStartYear(label);
  if (start === null) return null;
  return {
    label,
    from: `${start}-04-01`,
    to: `${start + 1}-04-01`,
    priorLabel: `${start - 1}-${String(start % 100).padStart(2, "0")}`,
    priorFrom: `${start - 1}-04-01`,
    priorTo: `${start}-04-01`,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, or null: "2026-02-30" is not one. */
function isoDay(raw) {
  if (!raw || !ISO_DATE.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return null;
  return d;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Resolve the period a report covers.
 *
 * Accepts either `{ fy: "2026-27" }` or an explicit `{ from, to }` custom
 * range. Falls back to the current Indian FY, which is what every one of the
 * approved samples is built around.
 *
 * A custom range is the days a person picked, both ends included: 1–25 Oct
 * covers 25 Oct, and a single day (from = to) is a valid range. Internally
 * every period is [from, to) like the FY window, so the returned `to` is the
 * day after the picked end; the label keeps the picked dates.
 *
 * A custom range still reports a prior-period comparison — the immediately
 * preceding window of the same length — so the YoY columns stay meaningful
 * instead of rendering blank whenever someone picks their own dates.
 */
export function resolvePeriod(raw = {}) {
  const from = isoDay(raw.from);
  const last = isoDay(raw.to);
  if (from && last && last >= from) {
    const to = new Date(last.getTime() + DAY_MS); // exclusive
    const span = to.getTime() - from.getTime();
    const priorFrom = new Date(from.getTime() - span);
    const priorLast = new Date(from.getTime() - DAY_MS);
    return {
      label: `${raw.from} to ${raw.to}`,
      from: raw.from,
      to: iso(to),
      priorLabel: `${iso(priorFrom)} to ${iso(priorLast)}`,
      priorFrom: iso(priorFrom),
      priorTo: raw.from,
    };
  }

  return fyWindow(raw.fy && fyStartYear(raw.fy) !== null ? raw.fy : currentFinancialYearIst());
}

/**
 * Hotel ids the caller wants to narrow to.
 *
 * These are a FACET, not a scope: deriveScope intersects them with the user's
 * mapped hotels, so naming a hotel you cannot see returns fewer rows, never
 * more. Garbage is dropped rather than rejected — a stray id should not 400 a
 * report page.
 */
export function resolveHotelIds(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return [
    ...new Set(
      list
        .map((v) => parseInt(String(v).trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    ),
  ];
}

export default { fyWindow, resolvePeriod, resolveHotelIds };
