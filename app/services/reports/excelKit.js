// ============================================================================
// excelKit.js
// ----------------------------------------------------------------------------
// The workbook primitives shared by every .xlsx this backend produces.
//
// Two layers live here:
//
//   1. The primitives the PO exports already used — istDate, writeGrid,
//      writeReportInfo, sendWorkbook, datedFilename. They were private to
//      poExcelExport.js; the Reports module needs the same streaming contract
//      and the same IST mechanics, and a second copy would drift. That file now
//      imports them from here and its tests are the proof the move was safe.
//
//   2. The "report sheet" house style — title / params / header / body / total
//      / footer — which is the layout product signed off in
//      prototypes/report_samples/. Report definitions describe a sheet as data
//      (columns + rows + a few labels) and writeReportSheet() renders it, so
//      sixteen reports cannot drift into sixteen dialects of the same table.
//
// ── Conventions, and why ────────────────────────────────────────────────────
//   • REAL NUMBERS AND REAL DATES, never pre-formatted strings. A money cell is
//     a number carrying a number format; a date cell is a Date. Text money does
//     not sum, sort, filter or pivot, which is how an export gets thrown away.
//   • NO MERGED CELLS anywhere in a data grid — merges break sort and filter.
//     The title and params block sit ABOVE the grid in column A/B, never across
//     it, which is what keeps that rule and a human-readable header compatible.
//   • The total row is a FORMULA (=SUM(G12:G71)), not a pre-computed number, so
//     a reader who filters or edits the sheet sees the total follow.
//   • Freeze below the header, not above it. The samples freeze at D8 while
//     their header sits at row 11 — which scrolls the header away and defeats
//     the stated intent ("keep title + headers visible"). We freeze at the row
//     after the header instead, keeping the identity columns pinned too.
//   • IST. Postgres hands back absolute instants; the product renders Indian
//     wall-clock everywhere else, so the workbook does too — see istDate().
// ============================================================================

import excelJS from "exceljs";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── Number formats ─────────────────────────────────────────────────────────
// Lifted verbatim from the approved samples (read back out of the .xlsx files,
// not retyped from the generator) so a diff against them is empty.
export const FMT = {
  /** Indian lakh/crore grouping: 1,52,40,000. Negatives red. */
  INR: "##\\,##\\,##\\,##0;[Red]\\-##\\,##\\,##\\,##0;0",
  INR_2: "##\\,##\\,##\\,##0.00;[Red]\\-##\\,##\\,##\\,##0.00;0.00",
  LAKH: '#,##0.00" L"',
  CRORE: '#,##0.00" Cr"',
  INT: "#,##0",
  PCT: "0.0%",
  /** Signed variance: +5.2% / -3.4%. */
  PCT_VAR: "+0.0%;-0.0%;0.0%",
  DATE: "dd-mmm-yyyy",
  DATE_TIME: "dd-mmm-yyyy hh:mm",
  /** The plain money format the PO exports already shipped. Left as-is. */
  MONEY: "#,##0.00",
};

// ── Colour tokens ──────────────────────────────────────────────────────────
const INK = "FF000000";
const MUTE = "FF595959";
const HEAD_BG = "FFD9D9D9";
const TOTAL_BG = "FFBFBFBF";
export const TONE = { BAD: "FFC00000", WARN: "FFBF8F00", OK: "FF548235" };

const PO_HEAD_BG = "FFF1F5F9"; // the PO exports' lighter header; kept for them
const FONT = "Calibri";

const thin = { style: "thin", color: { argb: INK } };
const BOX = { top: thin, bottom: thin, left: thin, right: thin };

/**
 * A Date whose UTC components equal the IST wall-clock of `value`.
 *
 * ExcelJS converts a JS Date to an Excel serial straight from its epoch
 * milliseconds (`25569 + t / 86400000`), i.e. it writes the UTC wall-clock and
 * offers no timezone option. Shifting by +05:30 first is therefore the only way
 * to make the cell READ as IST while staying a real date that sorts and
 * filters. Column headers say "(IST)" so nobody has to infer it.
 */
export function istDate(value) {
  if (!value) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : new Date(t.getTime() + IST_OFFSET_MS);
}

export function nowIstLabel() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "30-Apr-2026" — the samples' date style, for prose lines not cells. */
export function istDateLabel(value) {
  const d = istDate(value);
  if (!d) return "";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${dd}-${mon[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

export function workbook(creator) {
  const wb = new excelJS.Workbook();
  wb.creator = creator || "Workwise";
  wb.created = new Date();
  return wb;
}

const colLetter = (n) => {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
};

// ===========================================================================
// Layer 1 — the primitives the PO exports use. Behaviour unchanged.
// ===========================================================================

/**
 * Write one tabular sheet from a column spec, starting at row 1.
 *
 * columns: [{ header, key, width, numFmt?, align? }]
 * rows:    plain objects keyed by `key`. A null/undefined cell is left EMPTY
 *          rather than zero-filled — a 0 in a money column sorts as the
 *          cheapest and quietly poisons any min()/average built on the sheet.
 */
export function writeGrid(ws, columns, rows) {
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16 }));

  for (const r of rows) ws.addRow(r);

  const header = ws.getRow(1);
  header.font = { bold: true, size: 10 };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 26;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PO_HEAD_BG } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
  });

  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.numFmt) col.numFmt = c.numFmt;
    if (c.align) col.alignment = { horizontal: c.align };
  });

  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  return ws;
}

/**
 * The provenance sheet: what was exported, by whom, under which filters, at
 * what time. Without it an exported file forwarded to a third party is an
 * unlabelled pile of rows, and "why does your number differ from mine?" has no
 * answer. Two columns, no merges.
 */
export function writeReportInfo(wb, { title, generatedBy, filters = [], rowCount, truncated, rowCap }) {
  const ws = wb.addWorksheet("Report info");
  ws.columns = [{ width: 26 }, { width: 62 }];
  const put = (k, v) => {
    const row = ws.addRow([k, v]);
    row.getCell(1).font = { bold: true, size: 10 };
  };
  put("Report", title);
  put("Generated at (IST)", nowIstLabel());
  if (generatedBy) put("Generated by", generatedBy);
  put("Rows", rowCount);
  if (truncated) {
    put(
      "NOTE",
      `Only the first ${rowCap} rows are included. Narrow the filters and export again for the rest.`
    );
  }
  if (filters.length > 0) {
    ws.addRow([]);
    const head = ws.addRow(["Filters applied", ""]);
    head.getCell(1).font = { bold: true, size: 10 };
    for (const [k, v] of filters) put(k, v);
  }
  return ws;
}

/**
 * Stream a workbook to the HTTP response as a downloadable .xlsx.
 * Content-Disposition carries the filename so the browser does not save it as
 * the endpoint path ("export" with no extension, which Excel refuses to open).
 */
export async function sendWorkbook(res, wb, filename) {
  const safe = String(filename).replace(/[^\w.\-]+/g, "_");
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  // The browser fetch reads the filename off the response; without this the
  // header is invisible to cross-origin XHR and every download is named
  // "export.xlsx" regardless of the filters.
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  await wb.xlsx.write(res);
  res.end();
}

/** "purchase-orders_2026-08-11.xlsx" — dated so repeat exports do not collide. */
export function datedFilename(base) {
  const stamp = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  return `${base}_${stamp}.xlsx`;
}

// ===========================================================================
// Layer 2 — the report house style (prototypes/report_samples/)
// ===========================================================================

/** A worksheet pre-set for print: landscape A4, fit to width, no gridlines. */
export function reportSheet(wb, name, { orientation = "landscape", footerTitle = "" } = {}) {
  // Excel rejects : \ / ? * [ ] in a sheet name and truncates past 31 chars.
  const safe = String(name).replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
  const ws = wb.addWorksheet(safe);
  ws.pageSetup = {
    orientation,
    paperSize: 9, // A4
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
  };
  if (footerTitle) {
    ws.headerFooter = { oddFooter: `&L&8${footerTitle}&R&8Page &P of &N` };
  }
  return ws;
}

/**
 * Render one standard report sheet and return the row indices it used, so a
 * caller can bolt on a second table or a note underneath.
 *
 * spec:
 *   title, subtitle
 *   params      [[label, value], ...]            the run's parameters
 *   columns     [{ header, key, width, numFmt, align, total }]
 *                 total: "sum" renders =SUM(...) in the total row;
 *                 total: (ctx) => formulaOrValue for derived cells
 *   rows        plain objects keyed by column key
 *   totalLabel  omit to skip the total row entirely
 *   footerLines extra provenance lines after the standard five
 *   freezeCols  identity columns to pin horizontally (default 0)
 *   startRow    default 1
 */
export function writeReportSheet(ws, spec) {
  const {
    title,
    subtitle,
    params = [],
    columns = [],
    rows = [],
    totalLabel,
    footerLines = [],
    freezeCols = 0,
    startRow = 1,
    generatedBy,
    asOf,
  } = spec;

  let r = startRow;

  // ── Title + subtitle ─────────────────────────────────────────────────────
  if (title) {
    const c = ws.getCell(r, 1);
    c.value = title;
    c.font = { name: FONT, size: 14, bold: true };
    ws.getRow(r).height = 22;
    r += 1;
  }
  if (subtitle) {
    const c = ws.getCell(r, 1);
    c.value = subtitle;
    c.font = { name: FONT, size: 10, color: { argb: MUTE } };
    ws.getRow(r).height = 16;
    r += 1;
  }
  r += 1; // spacer

  // ── Parameters block ─────────────────────────────────────────────────────
  for (const [label, value] of params) {
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 1).font = { name: FONT, size: 10, color: { argb: MUTE } };
    ws.getCell(r, 2).value = value;
    ws.getCell(r, 2).font = { name: FONT, size: 10 };
    ws.getRow(r).height = 14;
    r += 1;
  }
  if (params.length) r += 1; // spacer

  // ── Header row ───────────────────────────────────────────────────────────
  const headerRow = r;
  columns.forEach((col, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = col.header;
    cell.font = { name: FONT, size: 10, bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_BG } };
    cell.border = BOX;
    cell.alignment = {
      horizontal: col.align || "left",
      vertical: "middle",
      wrapText: true,
    };
    ws.getColumn(i + 1).width = col.width || 16;
  });
  ws.getRow(headerRow).height = 30;
  r += 1;

  // ── Body ─────────────────────────────────────────────────────────────────
  const bodyStart = r;
  for (const row of rows) {
    columns.forEach((col, i) => {
      const cell = ws.getCell(r, i + 1);
      const v = row[col.key];
      // null/undefined is left EMPTY, never zero-filled: a 0 in a money column
      // sorts as the cheapest and poisons any min()/average built on the sheet.
      if (v !== null && v !== undefined) cell.value = v;
      if (col.numFmt) cell.numFmt = col.numFmt;
      cell.font = { name: FONT, size: 10 };
      cell.border = BOX;
      cell.alignment = { horizontal: col.align || "left", vertical: "middle" };
      if (typeof col.tone === "function") {
        const argb = col.tone(row);
        if (argb) cell.font = { name: FONT, size: 10, color: { argb } };
      }
    });
    r += 1;
  }
  const bodyEnd = r - 1;

  // ── Total row ────────────────────────────────────────────────────────────
  let totalRowIdx = null;
  if (totalLabel && rows.length > 0) {
    totalRowIdx = r;
    const ctx = { bodyStart, bodyEnd, totalRow: totalRowIdx, col: colLetter };
    columns.forEach((col, i) => {
      const cell = ws.getCell(totalRowIdx, i + 1);
      cell.font = { name: FONT, size: 10, bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
      cell.border = BOX;
      cell.alignment = { horizontal: col.align || "left", vertical: "middle" };
      if (col.total === "sum") {
        const L = colLetter(i + 1);
        // A formula, not a precomputed number, so the total follows the sheet
        // if the reader filters or edits it.
        cell.value = { formula: `SUM(${L}${bodyStart}:${L}${bodyEnd})` };
        if (col.numFmt) cell.numFmt = col.numFmt;
      } else if (typeof col.total === "function") {
        const out = col.total(ctx);
        if (out !== null && out !== undefined) cell.value = out;
        if (col.numFmt) cell.numFmt = col.numFmt;
      }
    });
    ws.getCell(totalRowIdx, 1).value = totalLabel;
    ws.getRow(totalRowIdx).height = 18;
    r += 1;
  }

  // ── Freeze + autofilter ──────────────────────────────────────────────────
  // ySplit = headerRow keeps the title block AND the header visible; xSplit
  // pins the identity columns. Unlike the samples' D8 this cannot scroll the
  // header out of view.
  ws.views = [
    { state: "frozen", xSplit: freezeCols || 0, ySplit: headerRow, showGridLines: false },
  ];
  if (rows.length > 0) {
    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: bodyEnd, column: columns.length },
    };
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  r += 1; // spacer
  const lines = [
    generatedBy ? `Generated by: ${generatedBy}` : null,
    `Generated on: ${nowIstLabel()} IST`,
    "Source: WorkWise Procurement Platform",
    asOf ? `Data as of: ${asOf}` : null,
    "Currency: Indian Rupees (INR)",
    ...footerLines,
  ].filter(Boolean);
  for (const line of lines) {
    const c = ws.getCell(r, 1);
    c.value = line;
    c.font = { name: FONT, size: 9, italic: true, color: { argb: MUTE } };
    ws.getRow(r).height = 12;
    r += 1;
  }

  return { headerRow, bodyStart, bodyEnd, totalRow: totalRowIdx, endRow: r - 1 };
}

export default {
  FMT,
  TONE,
  istDate,
  istDateLabel,
  nowIstLabel,
  workbook,
  writeGrid,
  writeReportInfo,
  sendWorkbook,
  datedFilename,
  reportSheet,
  writeReportSheet,
};
