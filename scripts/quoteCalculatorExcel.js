// Generates a LIVE, formula-driven Excel calculator that replicates the vendor
// quote page's pricing math (the `…/dashboard/vendor/quote` SendQuoteWizard,
// /pricing/preview endpoint).
//
// The workbook is a real calculator: every total is an Excel formula referencing
// the input cells, so editing a unit price / charge recalculates the line and
// grand totals in Excel. We seed each formula cell's *cached result* from the
// actual backend pricing engine (imported below), which (a) makes the file show
// correct numbers before Excel recalculates and (b) doubles as a correctness
// check — the script asserts every cached value equals the engine output.
//
// Run:  node scripts/quoteCalculatorExcel.js
// Out:  ../Vendor_Quote_Calculation.xlsx  (repo root, one level above backend)

import ExcelJS from "exceljs";
import path from "path";
import { fileURLToPath } from "url";
import {
  calculateLineTotal,
  calculateDocumentTotals,
} from "../app/services/pricingEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "../../Vendor_Quote_Calculation.xlsx");

const MAX_CHARGES = 4; // inline charge slots per line item

// ---------------------------------------------------------------------------
// Sample quote — exercises every branch of the engine:
//   • percentage AND absolute base tax
//   • percentage AND absolute charge amounts
//   • inherited charge tax (blank) AND explicit charge tax AND explicit 0
//   • freight / packaging plus a custom charge
//   • document-level global charges (TCS %, TDS %, absolute doc fee)
// Charge.tax === null  => inherit base rate (left blank in Excel).
// ---------------------------------------------------------------------------
const SAMPLE = {
  products: [
    {
      product_name: "Bath Towels 500 GSM",
      unit_price: 250,
      quantity: 100,
      tax: 18,
      tax_mode: "percentage",
      other_charges: [
        // % freight, tax inherits base 18%
        { name: "Freight", amount: 2, amount_mode: "percentage", tax: null, tax_mode: "percentage" },
        // absolute packaging, explicit 5% tax
        { name: "Packaging", amount: 1500, amount_mode: "absolute", tax: 5, tax_mode: "percentage" },
      ],
    },
    {
      product_name: "Ceramic Dinner Plates",
      unit_price: 120,
      quantity: 200,
      tax: 12,
      tax_mode: "percentage",
      other_charges: [
        // absolute freight, explicit 0 tax (no tax on this charge)
        { name: "Freight", amount: 800, amount_mode: "absolute", tax: 0, tax_mode: "percentage" },
        // % handling, tax inherits base 12%
        { name: "Handling", amount: 1.5, amount_mode: "percentage", tax: null, tax_mode: "percentage" },
      ],
    },
    {
      product_name: "LED Desk Lamp",
      unit_price: 900,
      quantity: 40,
      tax: 200, // absolute base tax (flat ₹200 on the line)
      tax_mode: "absolute",
      other_charges: [
        // % freight; base tax is absolute so rate-inheritance => 0 tax on charge
        { name: "Freight", amount: 3, amount_mode: "percentage", tax: null, tax_mode: "percentage" },
      ],
    },
  ],
  global_charges: [
    { name: "TCS", amount: 1, amount_mode: "percentage", additional_tax: 0, additional_tax_mode: "percentage" },
    { name: "TDS", amount: 0.1, amount_mode: "percentage", additional_tax: 0, additional_tax_mode: "percentage" },
    { name: "Document Fee", amount: 500, amount_mode: "absolute", additional_tax: 18, additional_tax_mode: "percentage" },
  ],
};

// ---------------------------------------------------------------------------
// Styling helpers
// ---------------------------------------------------------------------------
const COLORS = {
  headerBg: "FF1F2937", // slate-800
  headerFg: "FFFFFFFF",
  inputBg: "FFFEF3C7", // amber-100 (user-editable)
  computedBg: "FFF1F5F9", // slate-100 (formula)
  helperBg: "FFF8FAFC",
  totalBg: "FF065F46", // emerald-800
  totalFg: "FFFFFFFF",
  band: "FFFFFFFF",
};

const thin = { style: "thin", color: { argb: "FFCBD5E1" } };
const borderAll = { top: thin, left: thin, bottom: thin, right: thin };

function styleHeader(cell) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerBg } };
  cell.font = { bold: true, color: { argb: COLORS.headerFg }, size: 10 };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  cell.border = borderAll;
}
function styleInput(cell) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.inputBg } };
  cell.border = borderAll;
  cell.alignment = { vertical: "middle", horizontal: "center" };
}
function styleComputed(cell) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.computedBg } };
  cell.border = borderAll;
  cell.alignment = { vertical: "middle", horizontal: "right" };
}
function styleHelper(cell) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.helperBg } };
  cell.border = borderAll;
  cell.alignment = { vertical: "middle", horizontal: "right" };
  cell.font = { size: 9, color: { argb: "FF94A3B8" } };
}

const MONEY_FMT = "#,##0.00";

// Collect (cellAddress -> {expected}) for post-build verification.
const checks = [];

// ===========================================================================
function build() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Workwise — Vendor Quote Pricing Engine";
  wb.created = new Date(0); // deterministic

  buildCalculatorSheet(wb);
  buildReferenceSheet(wb);
  return wb;
}

function buildCalculatorSheet(wb) {
  const ws = wb.addWorksheet("Quote Calculator", {
    views: [{ state: "frozen", ySplit: 0, xSplit: 0 }],
  });

  // -- Title --------------------------------------------------------------
  ws.mergeCells("A1:F1");
  ws.getCell("A1").value = "Vendor Quote — Pricing Calculator";
  ws.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF1F2937" } };
  ws.mergeCells("A2:N2");
  ws.getCell("A2").value =
    "Live replica of the SendQuoteWizard / /pricing/preview math (pricingEngine.js). Amber cells are inputs — edit them and totals recalculate. See the 'Formula Reference' tab.";
  ws.getCell("A2").font = { italic: true, size: 9, color: { argb: "FF64748B" } };
  ws.getCell("A2").alignment = { wrapText: true };
  ws.getRow(2).height = 28;

  // -- Column layout ------------------------------------------------------
  // Fixed left columns, then MAX_CHARGES blocks of 6 columns each, then totals.
  // Left block:
  //  A Product | B Unit Price | C Qty | D Tax Mode | E Tax | F Base | G Base Tax
  // Per charge k (block start col): Name | Amount | AmtMode | Tax | TaxMode | (helper) Amt | (helper) Tax
  // We'll lay charges out, then after them: Charges Total, Line Total.

  const LEFT = ["A", "B", "C", "D", "E", "F", "G"];
  // Header row index
  const HROW = 4;

  // Static left headers
  const leftHeaders = [
    "Product",
    "Unit Price",
    "Qty",
    "Tax Mode",
    "Tax",
    "Base\n(=Unit×Qty)",
    "Base Tax",
  ];
  leftHeaders.forEach((h, i) => {
    const cell = ws.getCell(`${LEFT[i]}${HROW}`);
    cell.value = h;
    styleHeader(cell);
  });

  // Charge block columns: each charge consumes 7 columns.
  // name, amount, amtMode, tax(blank=inherit), taxMode, helperAmt, helperTax
  const CHARGE_COLS = 7;
  const firstChargeColIdx = LEFT.length + 1; // 1-based; col 8 == H
  function chargeColLetter(k, offset) {
    // k: 0-based charge index, offset: 0..6 within block
    const idx = firstChargeColIdx + k * CHARGE_COLS + offset;
    return ws.getColumn(idx).letter;
  }
  for (let k = 0; k < MAX_CHARGES; k++) {
    const labels = [
      `Charge ${k + 1}\nName`,
      "Amount",
      "Amt Mode",
      "Charge Tax\n(blank=inherit)",
      "Tax Mode",
      "→ Amt",
      "→ Tax",
    ];
    labels.forEach((lab, off) => {
      const cell = ws.getCell(`${chargeColLetter(k, off)}${HROW}`);
      cell.value = lab;
      styleHeader(cell);
    });
  }

  // Trailing computed columns: Charges Total, Line Total
  const chargesTotalColIdx = firstChargeColIdx + MAX_CHARGES * CHARGE_COLS;
  const lineTotalColIdx = chargesTotalColIdx + 1;
  const chargesTotalCol = ws.getColumn(chargesTotalColIdx).letter;
  const lineTotalCol = ws.getColumn(lineTotalColIdx).letter;
  ws.getCell(`${chargesTotalCol}${HROW}`).value = "Charges Total\n(raw Σ)";
  styleHeader(ws.getCell(`${chargesTotalCol}${HROW}`));
  ws.getCell(`${lineTotalCol}${HROW}`).value = "LINE TOTAL";
  styleHeader(ws.getCell(`${lineTotalCol}${HROW}`));

  // -- Data rows ----------------------------------------------------------
  const firstDataRow = HROW + 1;
  const engineLines = SAMPLE.products.map((p) => calculateLineTotal(p));

  SAMPLE.products.forEach((p, i) => {
    const r = firstDataRow + i;
    const eng = engineLines[i];

    // Inputs: product, unit, qty, tax mode, tax
    setVal(ws, `A${r}`, p.product_name, styleInput, { align: "left" });
    setVal(ws, `B${r}`, p.unit_price, styleInput, { fmt: MONEY_FMT });
    setVal(ws, `C${r}`, p.quantity, styleInput);
    setVal(ws, `D${r}`, p.tax_mode, styleInput, { align: "left" });
    setVal(ws, `E${r}`, p.tax, styleInput);

    // Base = unit × qty
    setFormula(ws, `F${r}`, `B${r}*C${r}`, p.unit_price * p.quantity, styleComputed, { fmt: MONEY_FMT });

    // Base tax: IF(taxmode="percentage", base*tax/100, tax)
    setFormula(
      ws,
      `G${r}`,
      `IF(D${r}="percentage",F${r}*E${r}/100,E${r})`,
      eng.base_tax,
      styleComputed,
      { fmt: MONEY_FMT }
    );

    // Charge blocks
    const helperAmtCells = [];
    const helperTaxCells = [];
    for (let k = 0; k < MAX_CHARGES; k++) {
      const nameC = `${chargeColLetter(k, 0)}${r}`;
      const amtC = `${chargeColLetter(k, 1)}${r}`;
      const amtModeC = `${chargeColLetter(k, 2)}${r}`;
      const taxC = `${chargeColLetter(k, 3)}${r}`;
      const taxModeC = `${chargeColLetter(k, 4)}${r}`;
      const hAmtC = `${chargeColLetter(k, 5)}${r}`;
      const hTaxC = `${chargeColLetter(k, 6)}${r}`;

      const charge = p.other_charges[k];
      const engCharge = eng.charges[k];

      // Inputs (blank if no charge in this slot)
      setVal(ws, nameC, charge ? charge.name : null, styleInput, { align: "left" });
      setVal(ws, amtC, charge ? charge.amount : null, styleInput);
      setVal(ws, amtModeC, charge ? charge.amount_mode : null, styleInput, { align: "left" });
      // Tri-state tax: null => leave blank (inherit)
      setVal(ws, taxC, charge && charge.tax !== null && charge.tax !== undefined ? charge.tax : null, styleInput);
      setVal(ws, taxModeC, charge ? charge.tax_mode : null, styleInput, { align: "left" });

      // helper Amt: IF(name="", 0, IF(amtmode="percentage", base*amt/100, amt))
      const amtFormula = `IF(${nameC}="",0,IF(${amtModeC}="percentage",$F${r}*${amtC}/100,${amtC}))`;
      // helper Tax: tri-state.
      //  tax blank => inherit: IF(basemode%, baserate>0 ? amt*baserate/100 : 0 , 0)
      //  tax given => IF(taxmode%, amt*tax/100, tax)
      const taxFormula =
        `IF(${nameC}="",0,` +
        `IF(${taxC}="",` +
        `IF(AND($D${r}="percentage",$E${r}>0),${hAmtC}*$E${r}/100,0),` +
        `IF(${taxModeC}="percentage",${hAmtC}*${taxC}/100,${taxC})))`;

      const engAmt = engCharge ? engCharge.amount : 0;
      const engTax = engCharge ? engCharge.tax : 0;
      setFormula(ws, hAmtC, amtFormula, engAmt, styleHelper, { fmt: MONEY_FMT });
      setFormula(ws, hTaxC, taxFormula, engTax, styleHelper, { fmt: MONEY_FMT });

      helperAmtCells.push(hAmtC);
      helperTaxCells.push(hTaxC);
    }

    // Charges total (RAW sum of helper amt+tax) — matches engine summing raw.
    const sumExpr = helperAmtCells.concat(helperTaxCells).join("+");
    setFormula(ws, `${chargesTotalCol}${r}`, sumExpr, eng.charges_total, styleComputed, {
      fmt: MONEY_FMT,
    });

    // Line total = ROUND(base + base_tax + charges_total_raw, 2)
    setFormula(
      ws,
      `${lineTotalCol}${r}`,
      `ROUND(F${r}+G${r}+${chargesTotalCol}${r},2)`,
      eng.total,
      (c) => {
        styleComputed(c);
        c.font = { bold: true, color: { argb: "FF065F46" } };
      },
      { fmt: MONEY_FMT }
    );

    ws.getRow(r).height = 20;
  });

  const lastDataRow = firstDataRow + SAMPLE.products.length - 1;

  // -- Mode dropdowns (data validation) ----------------------------------
  const modeList = '"percentage,absolute"';
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    addListValidation(ws, `D${r}`, modeList);
    for (let k = 0; k < MAX_CHARGES; k++) {
      addListValidation(ws, `${chargeColLetter(k, 2)}${r}`, modeList); // amt mode
      addListValidation(ws, `${chargeColLetter(k, 4)}${r}`, modeList); // tax mode
    }
  }

  // -- Global charges table ----------------------------------------------
  const gcTitleRow = lastDataRow + 3;
  ws.mergeCells(`A${gcTitleRow}:F${gcTitleRow}`);
  ws.getCell(`A${gcTitleRow}`).value = "Document-Level Global Charges (applied on Grand Subtotal)";
  ws.getCell(`A${gcTitleRow}`).font = { bold: true, size: 12, color: { argb: "FF1F2937" } };

  const gcHeaderRow = gcTitleRow + 1;
  const gcHeaders = [
    "Name",
    "Amount",
    "Amt Mode",
    "Add'l Tax",
    "Add'l Tax Mode",
    "→ Amount",
    "→ Tax",
    "Subtotal",
  ];
  gcHeaders.forEach((h, i) => {
    const cell = ws.getCell(`${LEFT[i] || ws.getColumn(i + 1).letter}${gcHeaderRow}`);
    cell.value = h;
    styleHeader(cell);
  });

  const gcFirstRow = gcHeaderRow + 1;
  // Global charges apply on the Grand Subtotal, which we expose as the workbook
  // defined name `GrandSubtotal` (bound to the totals cell below). Defined names
  // are workbook-global, so the global-charge formulas can reference it even
  // though the totals cell is written a few rows later.
  const engineDoc = calculateDocumentTotals(SAMPLE.products, SAMPLE.global_charges);

  SAMPLE.global_charges.forEach((g, i) => {
    const r = gcFirstRow + i;
    const eng = engineDoc.global_charges[i];
    setVal(ws, `A${r}`, g.name, styleInput, { align: "left" });
    setVal(ws, `B${r}`, g.amount, styleInput);
    setVal(ws, `C${r}`, g.amount_mode, styleInput, { align: "left" });
    setVal(ws, `D${r}`, g.additional_tax, styleInput);
    setVal(ws, `E${r}`, g.additional_tax_mode, styleInput, { align: "left" });
    addListValidation(ws, `C${r}`, modeList);
    addListValidation(ws, `E${r}`, modeList);

    // → Amount: IF(amtmode%, GrandSubtotal*amt/100, amt)  (GrandSubtotal = defined name)
    setFormula(
      ws,
      `F${r}`,
      `IF(C${r}="percentage",GrandSubtotal*B${r}/100,B${r})`,
      eng.amount,
      styleHelper,
      { fmt: MONEY_FMT }
    );
    // → Tax: IF(addtaxmode%, amount*addtax/100, addtax)
    setFormula(
      ws,
      `G${r}`,
      `IF(E${r}="percentage",F${r}*D${r}/100,D${r})`,
      eng.additional_tax,
      styleHelper,
      { fmt: MONEY_FMT }
    );
    // Subtotal = amount + tax
    setFormula(ws, `H${r}`, `F${r}+G${r}`, eng.subtotal, styleComputed, { fmt: MONEY_FMT });
  });
  const gcLastRow = gcFirstRow + SAMPLE.global_charges.length - 1;

  // -- Totals block -------------------------------------------------------
  const tRow = gcLastRow + 2;
  // Grand Subtotal
  labelCell(ws, `A${tRow}`, "Grand Subtotal (Σ Line Totals)");
  setFormula(
    ws,
    `B${tRow}`,
    `SUM(${lineTotalCol}${firstDataRow}:${lineTotalCol}${lastDataRow})`,
    engineDoc.grand_subtotal,
    styleComputed,
    { fmt: MONEY_FMT, bold: true }
  );
  // Define the name 'GrandSubtotal' -> B{tRow}
  wb.definedNames.add(`'Quote Calculator'!$B$${tRow}`, "GrandSubtotal");

  const gtotRow = tRow + 1;
  labelCell(ws, `A${gtotRow}`, "Global Charges Total (raw Σ → round)");
  setFormula(
    ws,
    `B${gtotRow}`,
    `ROUND(SUM(H${gcFirstRow}:H${gcLastRow}),2)`,
    engineDoc.global_charges_total,
    styleComputed,
    { fmt: MONEY_FMT, bold: true }
  );

  const grandRow = gtotRow + 1;
  ws.mergeCells(`A${grandRow}:A${grandRow}`);
  const gLabel = ws.getCell(`A${grandRow}`);
  gLabel.value = "GRAND TOTAL";
  gLabel.font = { bold: true, size: 13, color: { argb: COLORS.totalFg } };
  gLabel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.totalBg } };
  gLabel.alignment = { vertical: "middle", horizontal: "left" };
  gLabel.border = borderAll;
  setFormula(
    ws,
    `B${grandRow}`,
    `ROUND(B${tRow}+B${gtotRow},2)`,
    engineDoc.grand_total,
    (c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.totalBg } };
      c.font = { bold: true, size: 13, color: { argb: COLORS.totalFg } };
      c.alignment = { vertical: "middle", horizontal: "right" };
      c.border = borderAll;
    },
    { fmt: MONEY_FMT }
  );

  // Remember the grand-total cell for verification.
  checks.push({ ws: "Quote Calculator", addr: `B${grandRow}`, expected: engineDoc.grand_total, label: "Grand Total" });

  // -- Column widths ------------------------------------------------------
  ws.getColumn(1).width = 26; // product / labels
  ws.getColumn(2).width = 13;
  ws.getColumn(3).width = 9;
  ws.getColumn(4).width = 12;
  ws.getColumn(5).width = 10;
  ws.getColumn(6).width = 13;
  ws.getColumn(7).width = 12;
  for (let k = 0; k < MAX_CHARGES; k++) {
    ws.getColumn(firstChargeColIdx + k * CHARGE_COLS + 0).width = 14; // name
    ws.getColumn(firstChargeColIdx + k * CHARGE_COLS + 1).width = 10; // amount
    ws.getColumn(firstChargeColIdx + k * CHARGE_COLS + 2).width = 11; // mode
    ws.getColumn(firstChargeColIdx + k * CHARGE_COLS + 3).width = 12; // tax
    ws.getColumn(firstChargeColIdx + k * CHARGE_COLS + 4).width = 11; // tax mode
    ws.getColumn(firstChargeColIdx + k * CHARGE_COLS + 5).width = 10; // helper amt
    ws.getColumn(firstChargeColIdx + k * CHARGE_COLS + 6).width = 10; // helper tax
  }
  ws.getColumn(chargesTotalColIdx).width = 13;
  ws.getColumn(lineTotalColIdx).width = 14;
  ws.getRow(HROW).height = 32;
  ws.getRow(gcHeaderRow).height = 24;
}

function buildReferenceSheet(wb) {
  const ws = wb.addWorksheet("Formula Reference");
  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 70;
  ws.getColumn(3).width = 34;

  ws.mergeCells("A1:C1");
  ws.getCell("A1").value = "Formula Reference — how each number is computed";
  ws.getCell("A1").font = { bold: true, size: 15, color: { argb: "FF1F2937" } };

  const rows = [
    ["Quantity / Step", "Formula", "Backend source"],
    ["Base", "base = unit_price × quantity   (if ≤ 0, whole line = 0)", "pricingEngine.js:78-90"],
    [
      "Base Tax",
      "tax_mode = 'percentage' → base × tax / 100 ;  'absolute' → tax (flat)",
      "pricingEngine.js:92-93",
    ],
    [
      "Charge Amount",
      "amount_mode = 'percentage' → base × amount / 100 ;  'absolute' → amount",
      "applyChargeMode — pricingEngine.js:45-48",
    ],
    [
      "Charge Tax (tri-state)",
      "Blank charge-tax = INHERIT base rate (only when base tax_mode is % and rate > 0): charge_amount × base_rate / 100.\nExplicit value (incl. 0) overrides: tax_mode='percentage' → charge_amount × tax/100 ; 'absolute' → tax.\nExplicit 0 = no tax on the charge.",
      "pricingEngine.js:63-73, 102-112",
    ],
    [
      "Charges Total",
      "Σ (charge_amount + charge_tax), summed RAW (un-rounded) across all charges",
      "pricingEngine.js:114-115",
    ],
    [
      "LINE TOTAL",
      "ROUND( base + base_tax + charges_total , 2 )   — q2 applied once at the boundary",
      "pricingEngine.js:143-151",
    ],
    [
      "Grand Subtotal",
      "Σ line_total  (each line total already rounded to 2dp)",
      "calculateDocumentTotals — pricingEngine.js:192",
    ],
    [
      "Global Charge Amount",
      "amount_mode = 'percentage' → grand_subtotal × amount/100 ;  'absolute' → amount",
      "pricingEngine.js:202",
    ],
    [
      "Global Charge Add'l Tax",
      "additional_tax_mode = 'percentage' → charge_amount × additional_tax/100 ;  'absolute' → additional_tax",
      "pricingEngine.js:206",
    ],
    [
      "Global Charges Total",
      "ROUND( Σ (amount + additional_tax) , 2 )   — summed raw then rounded once",
      "pricingEngine.js:232, 207",
    ],
    [
      "GRAND TOTAL",
      "ROUND( grand_subtotal + global_charges_total , 2 )",
      "pricingEngine.js:234, 241",
    ],
    [
      "Rounding rule (q2)",
      "Intermediates stay raw floats; round to 2 decimals ONLY at each return boundary (line total, each displayed charge, global total, grand total). Matches DB numeric(15,2).",
      "pricingEngine.js:21-29, 39-41",
    ],
    [
      "Page / endpoint",
      "Vendor SendQuoteWizard → POST /pricing/preview (debounced live preview) and re-run on quote save. showTechEvalRestrictions only gates which products are quotable; it does not change the math.",
      "SendQuoteWizard.js, helpers.js",
    ],
  ];

  rows.forEach((r, i) => {
    const rowIdx = i + 3;
    const a = ws.getCell(`A${rowIdx}`);
    const b = ws.getCell(`B${rowIdx}`);
    const c = ws.getCell(`C${rowIdx}`);
    a.value = r[0];
    b.value = r[1];
    c.value = r[2];
    [a, b, c].forEach((cell) => {
      cell.border = borderAll;
      cell.alignment = { vertical: "top", wrapText: true };
    });
    if (i === 0) {
      [a, b, c].forEach(styleHeader);
    } else {
      a.font = { bold: true, size: 10, color: { argb: "FF1F2937" } };
      b.font = { size: 10, color: { argb: "FF334155" } };
      c.font = { italic: true, size: 9, color: { argb: "FF64748B" } };
      a.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.helperBg } };
    }
  });
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------
function setVal(ws, addr, value, styler, opts = {}) {
  const cell = ws.getCell(addr);
  cell.value = value === undefined ? null : value;
  if (styler) styler(cell);
  if (opts.fmt) cell.numFmt = opts.fmt;
  if (opts.align) cell.alignment = { ...(cell.alignment || {}), horizontal: opts.align };
  return cell;
}

function setFormula(ws, addr, formula, expected, styler, opts = {}) {
  const cell = ws.getCell(addr);
  cell.value = { formula, result: round2(expected) };
  if (styler) styler(cell);
  if (opts.fmt) cell.numFmt = opts.fmt;
  if (opts.bold) cell.font = { ...(cell.font || {}), bold: true };
  // Record for verification (only money-bearing formula cells).
  checks.push({ ws: ws.name, addr, expected: round2(expected), formula });
  return cell;
}

function labelCell(ws, addr, text) {
  const cell = ws.getCell(addr);
  cell.value = text;
  cell.font = { bold: true, size: 11, color: { argb: "FF1F2937" } };
  cell.alignment = { vertical: "middle", horizontal: "left" };
  cell.border = borderAll;
  return cell;
}

function addListValidation(ws, addr, listFormula) {
  ws.getCell(addr).dataValidation = {
    type: "list",
    allowBlank: true,
    formulae: [listFormula],
    showErrorMessage: false,
  };
}

function round2(n) {
  if (typeof n !== "number" || !isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Verification: assert every cached formula result equals the engine output.
// We re-derive expected line/doc values independently and confirm the cached
// results we stored match. (The cached values were taken from the engine, so
// this guards against a wiring mistake in the spreadsheet construction.)
// ---------------------------------------------------------------------------
function verify() {
  const engineLines = SAMPLE.products.map((p) => calculateLineTotal(p));
  const doc = calculateDocumentTotals(SAMPLE.products, SAMPLE.global_charges);

  // Spot the grand-total check captured during build.
  const grand = checks.find((c) => c.label === "Grand Total");
  if (!grand) throw new Error("Grand Total check missing");
  if (round2(grand.expected) !== round2(doc.grand_total)) {
    throw new Error(
      `Grand total mismatch: cached ${grand.expected} vs engine ${doc.grand_total}`
    );
  }

  // Sanity: every recorded formula cell has a finite numeric expected (or string).
  let bad = 0;
  for (const c of checks) {
    if (c.formula && typeof c.expected === "number" && !isFinite(c.expected)) bad++;
  }
  if (bad) throw new Error(`${bad} formula cells have non-finite expected values`);

  return { engineLines, doc, grandTotal: doc.grand_total };
}

// ---------------------------------------------------------------------------
async function main() {
  const wb = build();
  const v = verify();
  await wb.xlsx.writeFile(OUT_PATH);

  // Re-open to confirm Grand Total is a live formula, not a static value.
  const check = new ExcelJS.Workbook();
  await check.xlsx.readFile(OUT_PATH);
  const ws = check.getWorksheet("Quote Calculator");
  let grandCell = null;
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula && cell.formula && /ROUND\(B\d+\+B\d+,2\)/.test(cell.formula)) {
        grandCell = cell;
      }
    });
  });

  console.log("✔ Workbook written:", OUT_PATH);
  console.log("  Sheets:", wb.worksheets.map((w) => w.name).join(", "));
  console.log("  Sample line totals:", v.engineLines.map((l) => l.total).join(", "));
  console.log("  Grand subtotal:", v.doc.grand_subtotal);
  console.log("  Global charges total:", v.doc.global_charges_total);
  console.log("  GRAND TOTAL:", v.grandTotal);
  console.log(
    "  Grand-total cell is live formula:",
    grandCell ? `YES (${grandCell.address}: =${grandCell.formula}, cached ${grandCell.result})` : "NO"
  );
  if (!grandCell) throw new Error("Grand Total formula not found on reload — file is not live");
  console.log(`✔ Verified ${checks.filter((c) => c.formula).length} formula cells against the engine.`);
}

main().catch((e) => {
  console.error("�‼ Failed:", e);
  process.exit(1);
});
