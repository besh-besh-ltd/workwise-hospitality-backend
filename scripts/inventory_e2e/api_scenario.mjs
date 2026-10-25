/* eslint-disable no-console */
// Inventory E2E: the runbook scenario driven through the HTTP API, with every
// expected number asserted. Run it against a FRESHLY SEEDED local backend:
//
//   E2E_RESET=seed scripts/inventory_e2e/e2e_server.sh      # terminal 1
//   node scripts/inventory_e2e/api_scenario.mjs             # terminal 2
//
// It is the source of the numbers in E2E_RUNBOOK.md, and a smoke test of the
// backend before a browser run. It changes the seeded world (re-seed before a
// browser run, or before running it again). Exit code 0 = every check passed.
//
// Talks to localhost only (refuses any other API base). Reads the seed manifest
// (/tmp/inv-e2e/seed.json) and the mail sink (/tmp/inv-e2e/mail). At the end it
// runs scripts/inventory_e2e/low_stock_digest.sh twice (skip: E2E_SKIP_DIGEST=1).
//
// PENDING CHECKS (tagged [D3 mr.create gate]): the storekeeper, who holds no mr.*
// permission, must get can.createMrDraft false and a 403 from POST /reorder/mr-draft.
// That needs D3's gate (mr.create at the exact hotel/department cell), which is not
// merged yet. Until then these print PENDING and do not fail the run. Once D3's gate
// is merged, run with E2E_REQUIRE_MR_GATE=1: they then count as ordinary checks
// (FAIL = exit 1). When the gate is in, make that the default by deleting the
// pendingCheck() indirection.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const BASE = (process.env.E2E_API || "http://localhost:8092/api/v1").replace(/\/+$/, "");
const MANIFEST = process.env.E2E_SEED_MANIFEST || "/tmp/inv-e2e/seed.json";
const MAIL_DIR = process.env.E2E_MAIL_DIR || "/tmp/inv-e2e/mail";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const { hostname } = new URL(BASE);
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) {
  console.error(`ABORT: E2E_API must be local, got ${BASE}`);
  process.exit(2);
}
const M = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const IST = 5.5 * 3600e3;
const istDay = (days = 0) => new Date(Date.now() + IST + days * 864e5).toISOString().slice(0, 10);
const uuid = () => crypto.randomUUID();
const tokens = {};
let failures = 0;
let checks = 0;
const REQUIRE_MR_GATE = process.env.E2E_REQUIRE_MR_GATE === "1";
const pending = { total: 0, passed: 0 };

async function api(who, method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, data: json?.data };
}

function check(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${a}${ok ? "" : `   (expected ${e})`}`);
  return ok;
}
/** A check that only holds once D3's mr.create gate is merged (see the header). */
function pendingCheck(label, actual, expected) {
  const tagged = `[D3 mr.create gate] ${label}`;
  if (REQUIRE_MR_GATE) return check(tagged, actual, expected);
  pending.total += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (ok) pending.passed += 1;
  console.log(`  ${ok ? "PASS   " : "PENDING"}  ${tagged}: ${a}${ok ? "" : `   (expected ${e} once D3's gate is merged)`}`);
  return ok;
}
const step = (title) => console.log(`\n== ${title}`);
const priceKeys = (obj) =>
  [...new Set(JSON.stringify(obj).match(/"[a-zA-Z_]*(price|cost|rate|amount|value)[a-zA-Z_]*"/gi) || [])];

async function stock(who, hotelId) {
  const r = await api(who, "GET", `/inventory/stock?hotelId=${hotelId}`);
  const rows = Object.fromEntries((r.data?.rows || []).map((x) => [x.invItemId, x]));
  return { ...r, rows, totals: r.data?.totals, startedAt: r.data?.stockStartedAt };
}
async function item(who, hotelId, invItemId) {
  return (await api(who, "GET", `/inventory/stock/${hotelId}/items/${invItemId}`)).data;
}
const batchesOf = (card) => (card?.batches || []).map((b) => [b.batchNo, b.expiryDate, b.qty]);
async function preview(who, key, filters) {
  return api(who, "POST", `/reports/${key}/preview`, { filters });
}
const mails = () => (fs.existsSync(MAIL_DIR) ? fs.readdirSync(MAIL_DIR).filter((f) => f.endsWith(".json")) : []);
const mailSubjects = () =>
  mails().map((f) => JSON.parse(fs.readFileSync(path.join(MAIL_DIR, f), "utf8")).subject || "");

// ---------------------------------------------------------------------------

const A1 = M.hotels.A1;
const A2 = M.hotels.A2;
const B1 = M.hotels.B1;
const FB = M.departments.fb;
const PO = M.pos.multiHotel.poId;
const CO = M.pos.callOff.poId;
const L = M.pos.multiHotel.lineIds; // paneer / rice / cap
const CL = M.pos.callOff.lineIds;
const I = { paneer: M.items.paneer.invItemId, rice: M.items.rice.invItemId, cap: M.items.cap.invItemId };
const P1 = istDay(2);
const P2 = istDay(9);
const EXP_OK = istDay(10);
const EXP_PAST = istDay(-1);

step("0. Logins (employee code)");
for (const [role, l] of Object.entries(M.logins)) {
  const r = await api(null, "POST", "/users/login?conform=true", { employee_code: l.employee_code, password: M.password });
  tokens[l.employee_code] = r.json?.token;
  check(`${l.employee_code} (${role}) login`, [r.status, Boolean(r.json?.token)], [200, true]);
}
const STORE = "INVE2E-STORE";
const CTRL = "INVE2E-CTRL";
const BUYER = "INVE2E-BUYER";
const BBUYER = "INVE2E-BBUYER";
const VENDOR = "INVE2E-VENDOR";

const fresh = await api(BUYER, "GET", `/inventory/po/${PO}/deliveries`);
if (fresh.status !== 200 || fresh.data.grns.length || fresh.data.deliveries.some((d) => d.hotelId != null)) {
  console.error("\nABORT: the world is not freshly seeded (PO 96801 already has a plan or receipts). Re-seed first:");
  console.error("  stop the backend, then E2E_RESET=seed scripts/inventory_e2e/e2e_server.sh");
  process.exit(2);
}

step("1. Split PO 96801 into hotel x 2 phases (buyer)");
const phase = (hotelId, phaseNo, dueDate, p, r, c) => ({
  hotelId, phaseNo, dueDate, remarks: null,
  lines: [{ poLineId: L.paneer, plannedQty: p }, { poLineId: L.rice, plannedQty: r }, { poLineId: L.cap, plannedQty: c }],
});
let r = await api(BUYER, "PUT", `/inventory/po/${PO}/deliveries`, {
  deliveries: [phase(A1, 1, P1, 12, 3, 150), phase(A1, 2, P2, 12, 3, 150), phase(A2, 1, P1, 8, 2, 100), phase(A2, 2, P2, 8, 2, 100)],
});
check("PUT plan", r.status, 200);
const D = Object.fromEntries((r.data?.deliveries || []).map((d) => [`${d.hotelId === A1 ? "A1" : "A2"}P${d.phaseNo}`, d.id]));
check("phases", Object.keys(D).sort(), ["A1P1", "A1P2", "A2P1", "A2P2"]);

step("2. Vendor dispatch note for A1 P1");
r = await api(VENDOR, "POST", `/inventory/vendor/po/${PO}/dispatches`, {
  hotelId: A1, deliveryId: D.A1P1, challanNo: "FK-DC-1001", challanDate: istDay(0), vehicleNo: "MH04 AB 1234",
  transporter: "FreshKart own fleet", expectedDeliveryDate: P1,
  lines: [{ poLineId: L.paneer, qty: 12 }, { poLineId: L.rice, qty: 3 }, { poLineId: L.cap, qty: 150 }],
});
check("dispatch", [r.status, r.data?.status], [201, "in_transit"]);
const dispatchId = r.data?.id;

step("3. Receive at A1 with a rejection, paneer batch PNR-E2E-01 expiring in 10 days (storekeeper)");
r = await api(STORE, "POST", "/inventory/grn", {
  poId: PO, hotelId: A1, dispatchId, receivedAt: istDay(0), vendorChallanNo: "FK-DC-1001", post: true, clientEventId: uuid(),
  lines: [
    { poLineId: L.paneer, receivedQty: 12, acceptedQty: 10, rejectedQty: 2, rejectionReason: "quality", batchNo: "PNR-E2E-01", expiryDate: EXP_OK },
    { poLineId: L.rice, receivedQty: 3, acceptedQty: 3, rejectedQty: 0 },
    { poLineId: L.cap, receivedQty: 150, acceptedQty: 150, rejectedQty: 0 },
  ],
});
check("GRN posted", [r.status, r.data?.status], [201, "posted"]);
const grn1 = r.data;
const capGrnLine = grn1?.lines?.find((l) => l.poLineId === L.cap)?.id;
let s = await stock(STORE, A1);
check("stock paneer / rice / caps", [s.rows[I.paneer]?.qty, s.rows[I.rice]?.qty, s.rows[I.cap]?.qty], [10, 75, 150]);
check("avg cost paneer / rice / caps", [s.rows[I.paneer]?.avgCost, s.rows[I.rice]?.avgCost, s.rows[I.cap]?.avgCost], [380, 90, 4]);
check("A1 stock value", s.totals?.value, 11150);
check("item card batches (paneer)", batchesOf(await item(STORE, A1, I.paneer)), [["PNR-E2E-01", EXP_OK, 10]]);

step("4. Short-close A2 P2 (buyer)");
r = await api(BUYER, "POST", `/inventory/po/${PO}/short-close`, {
  target: { type: "delivery", deliveryId: D.A2P2 }, reasonCode: "no_longer_needed", remarks: "Pune banquet cancelled",
});
check("short-close", [r.status, r.data?.receiptStatus, r.data?.shortCloses?.length], [200, "partial", 3]);

step("5. RTV Replacement of 10 caps (controller)");
r = await api(CTRL, "POST", "/inventory/rtv", {
  grnId: grn1?.id, disposition: "REPLACE", remarks: "Torn caps", lines: [{ grnLineId: capGrnLine, qty: 10, reason: "damaged" }],
});
check("RTV created", [r.status, r.data?.status], [200, "draft"]);
r = await api(CTRL, "POST", `/inventory/rtv/${r.data?.id}/dispatch`, { challanNo: "RTV-DC-01" });
check("RTV dispatched", [r.status, r.data?.status], [200, "dispatched"]);
check("caps at A1", (await item(STORE, A1, I.cap))?.balance?.qty, 140);

step("6-7. Mark out 6 kg paneer to F&B, return 2 kg (storekeeper)");
r = await api(STORE, "POST", "/inventory/out", {
  hotelId: A1, docType: "OUT", departmentId: FB, requestedByName: "Chef Arun", clientEventId: uuid(), lines: [{ invItemId: I.paneer, qty: 6 }],
});
check("mark-out", [r.status, r.data?.lines?.[0]?.value], [201, 2280]);
check("paneer batches after mark-out (FEFO)", batchesOf(await item(STORE, A1, I.paneer)), [["PNR-E2E-01", EXP_OK, 4]]);
r = await api(STORE, "POST", "/inventory/out", {
  hotelId: A1, docType: "RETURN", departmentId: FB, clientEventId: uuid(), lines: [{ invItemId: I.paneer, qty: 2 }],
});
check("return", [r.status, r.data?.lines?.[0]?.value], [201, 760]);
check("paneer batches after return (unbatched -> undated bucket)", batchesOf(await item(STORE, A1, I.paneer)), [
  [null, null, 2], ["PNR-E2E-01", EXP_OK, 4],
]);

step("8. Wastage -0.5 kg, approved by the controller");
r = await api(STORE, "POST", "/inventory/adjustments", {
  hotelId: A1, reasonCode: "WASTAGE", remarks: "Paneer soured in chiller", submit: true, clientEventId: uuid(),
  lines: [{ invItemId: I.paneer, qty: -0.5 }],
});
check("adjustment submitted", [r.status, r.data?.status], [201, "pending_approval"]);
const adj1 = r.data?.id;
check("storekeeper cannot approve", (await api(STORE, "POST", `/inventory/adjustments/${adj1}/approve`, {})).status, 403);
r = await api(CTRL, "POST", `/inventory/adjustments/${adj1}/approve`, {});
check("controller approves", [r.status, r.data?.status], [200, "posted"]);
check("paneer batches (FEFO took the undated bucket first)", batchesOf(await item(STORE, A1, I.paneer)), [
  [null, null, 1.5], ["PNR-E2E-01", EXP_OK, 4],
]);

step("9. FULL blind count at A1 with a variance, approved (starts stock at A1)");
r = await api(STORE, "POST", "/inventory/counts", { hotelId: A1, scope: "FULL", isBlind: true });
check("count started", [r.status, r.data?.status, r.data?.lines?.length], [201, "open", 3]);
const count = r.data;
const lineOf = (invItemId) => count?.lines?.find((l) => l.invItemId === invItemId);
r = await api(STORE, "PUT", `/inventory/counts/${count?.id}/lines`, {
  lines: [
    { invItemId: I.paneer, countedQty: 5, clientEventId: uuid() },
    { invItemId: I.rice, countedQty: 75, clientEventId: uuid() },
    { invItemId: I.cap, countedQty: 140, clientEventId: uuid() },
  ],
});
check("lines saved", r.status, 200);
r = await api(STORE, "POST", `/inventory/counts/${count?.id}/submit`, {});
check("submitted; blind to the storekeeper", [r.status, r.data?.status, r.data?.lines?.map((l) => l.systemQtyAtCount)], [
  200, "submitted", [null, null, null],
]);
r = await api(CTRL, "GET", `/inventory/counts/${count?.id}`);
const v = Object.fromEntries((r.data?.lines || []).map((l) => [l.invItemId, [l.systemQtyAtCount, l.countedQty, l.varianceQty, l.varianceValue]]));
check("controller sees paneer [system, counted, variance, value]", v[I.paneer], [5.5, 5, -0.5, -190]);
check("rice and caps have no variance", [v[I.rice]?.[2], v[I.cap]?.[2]], [0, 0]);
r = await api(CTRL, "POST", `/inventory/counts/${count?.id}/approve`, { reasons: { [lineOf(I.paneer)?.id]: "Trim loss while portioning" } });
check("count approved", [r.status, r.data?.status], [200, "approved"]);
s = await stock(STORE, A1);
check("A1 stock value after count", s.totals?.value, 9210);
check("A1 stock started", Boolean(s.startedAt), true);
check("paneer batches (count loss FEFO: undated first)", batchesOf(await item(STORE, A1, I.paneer)), [
  [null, null, 1], ["PNR-E2E-01", EXP_OK, 4],
]);

step("9b. An already-expired lot, then an EXPIRY write-off draws it first");
r = await api(STORE, "POST", "/inventory/grn", {
  poId: PO, hotelId: A1, receivedAt: istDay(0), vendorChallanNo: "FK-DC-1009", post: true, clientEventId: uuid(),
  lines: [{ poLineId: L.paneer, receivedQty: 3, acceptedQty: 3, rejectedQty: 0, batchNo: "PNR-E2E-OLD", expiryDate: EXP_PAST }],
});
check("GRN posted with an EXPIRED warning", [r.status, r.data?.status, (r.data?.warnings || []).map((w) => w.code)], [201, "posted", ["EXPIRED"]]);
check("paneer batches, FEFO order", batchesOf(await item(STORE, A1, I.paneer)), [
  [null, null, 1], ["PNR-E2E-OLD", EXP_PAST, 3], ["PNR-E2E-01", EXP_OK, 4],
]);
r = await preview(CTRL, "near_expiry", { hotel_ids: [A1] });
check("7.7 Near expiry rows [batch, days, status, qty]", (r.data?.rows || []).map((x) => [x.batch_no, x.days_to_expiry, x.status, x.qty]), [
  ["PNR-E2E-OLD", -1, "Expired", 3], ["PNR-E2E-01", 10, "Expiring", 4],
]);
r = await api(STORE, "POST", "/inventory/adjustments", {
  hotelId: A1, reasonCode: "EXPIRY", remarks: "Expired lot PNR-E2E-OLD", submit: true, clientEventId: uuid(),
  lines: [{ invItemId: I.paneer, qty: -3 }],
});
const adj2 = r.data?.id;
r = await api(CTRL, "POST", `/inventory/adjustments/${adj2}/approve`, {});
check("EXPIRY write-off approved", [r.status, r.data?.status], [200, "posted"]);
r = await api(STORE, "GET", `/inventory/stock/${A1}/items/${I.paneer}/ledger`);
const writeOff = (r.data?.rows || []).filter((m) => m.type === "ADJUST_OUT" && m.sourceId === adj2);
check("write-off movement rows [batch, expiry, qty, value]", writeOff.map((m) => [m.batchNo, m.expiryDate, m.qty, m.value]), [
  ["PNR-E2E-OLD", EXP_PAST, -3, -1140],
]);
check("paneer batches after the write-off (undated bucket untouched)", batchesOf(await item(STORE, A1, I.paneer)), [
  [null, null, 1], ["PNR-E2E-01", EXP_OK, 4],
]);

step("10. Reorder at A1 to an MR draft (controller)");
r = await api(CTRL, "GET", `/inventory/reorder?hotelId=${A1}`);
const ro = r.data;
check("worklist", [r.status, ro?.hotelId, ro?.can?.createMrDraft, Boolean(ro?.stockStartedAt)], [200, A1, true, true]);
check("F&B offered as an MR department", (ro?.departments || []).some((d) => d.id === FB), true);
const row = (id) => ro?.rows?.find((x) => x.invItemId === id);
const shape = (x) => x && [x.displayName, x.qty, x.reorderLevel, x.maxQty, x.onOrder, x.suggestedQty, x.packFactor, x.openMrQty];
check("rows by name", (ro?.rows || []).map((x) => x.displayName), ["Basmati Rice", "Paneer", "Shower Cap"]);
check("rice [name, qty, reorder, max, onOrder, suggested, pack, openMr]", shape(row(I.rice)), ["Basmati Rice", 75, 100, 300, 75, 150, 25, 0]);
check("paneer", shape(row(I.paneer)), ["Paneer", 5, 10, 30, 26, 0, null, 0]);
check("caps", shape(row(I.cap)), ["Shower Cap", 140, 200, 600, 460, 0, 100, 0]);
const contracted = (x) => x?.contracted && [x.contracted.departmentId, x.contracted.arcContractLineId, x.contracted.unitRate, x.contracted.uom, x.contracted.remainingQty];
check("rice contracted [dept, line, rate, uom, remaining]", contracted(row(I.rice)), [FB, M.contractLines.rice.arcContractLineId, 2200, "Bag", 120]);
check("paneer contracted", contracted(row(I.paneer)), [FB, M.contractLines.paneer.arcContractLineId, 360, "kg", 585]);
check("caps contracted", contracted(row(I.cap)), [FB, M.contractLines.cap.arcContractLineId, 3.8, "pc", 9700]);
check("no unallocated group orders once the PO is split", ro?.groupOrdersOpen, []);

const eventId = uuid();
const draftBody = { hotelId: A1, departmentId: FB, clientEventId: eventId, items: [{ invItemId: I.rice, qty: 150 }, { invItemId: I.paneer, qty: 10 }] };
r = await api(CTRL, "POST", "/inventory/reorder/mr-draft", draftBody);
check("MR draft created", [r.status, r.data?.status, r.data?.hotelId, r.data?.departmentId], [201, "draft", A1, FB]);
check("MR lines [line, qty, uom, rate]", (r.data?.items || []).map((x) => [x.arcContractLineId, x.quantity, x.uom, x.unitRate]), [
  [M.contractLines.rice.arcContractLineId, 6, "Bag", 2200], [M.contractLines.paneer.arcContractLineId, 10, "kg", 360],
]);
const mrId = r.data?.mrId;
r = await api(CTRL, "POST", "/inventory/reorder/mr-draft", draftBody);
check("replay, same clientEventId", [r.status, r.data?.replayed, r.data?.mrId === mrId], [200, true, true]);
r = await api(CTRL, "POST", "/inventory/reorder/mr-draft", { ...draftBody, clientEventId: uuid(), items: [{ invItemId: I.rice, qty: 3100 }] });
check("over contract remaining is refused [status, reason, quantity, remaining]", [r.status, r.json?.details?.reason, r.json?.details?.quantity, r.json?.details?.remaining], [
  400, "EXCEEDS_CONTRACT_REMAINING", 124, 120,
]);
console.log(`        message: ${r.json?.message}`);
r = await api(CTRL, "POST", "/inventory/reorder/mr-draft", {
  hotelId: A1, departmentId: M.departments.housekeeping, clientEventId: uuid(), items: [{ invItemId: I.cap, qty: 100 }],
});
check("no contract in Housekeeping is refused", [r.status, r.json?.details?.reason], [400, "NOT_CONTRACTED"]);
r = await api(CTRL, "GET", `/inventory/reorder?hotelId=${A1}`);
check("open MR qty now shown (rice kg, paneer kg)", [r.data?.rows?.find((x) => x.invItemId === I.rice)?.openMrQty, r.data?.rows?.find((x) => x.invItemId === I.paneer)?.openMrQty], [150, 10]);
check("company B buyer cannot read A1's list", (await api(BBUYER, "GET", `/inventory/reorder?hotelId=${A1}`)).status, 404);
// The storekeeper (Storekeeper @ A1: inventory.update, no mr.* permission) can read the
// worklist but must not draft an MR. PENDING until D3's mr.create gate is merged.
r = await api(STORE, "GET", `/inventory/reorder?hotelId=${A1}`);
pendingCheck("storekeeper reads the worklist but cannot draft [status, can.createMrDraft]", [r.status, r.data?.can?.createMrDraft], [200, false]);
r = await api(STORE, "POST", "/inventory/reorder/mr-draft", {
  hotelId: A1, departmentId: FB, clientEventId: uuid(), items: [{ invItemId: I.rice, qty: 25 }],
});
pendingCheck("storekeeper's MR draft is refused", r.status, 403);
console.log(`        storekeeper's draft: HTTP ${r.status} ${r.json?.code ?? ""} ${r.data?.mrNumber ? `created ${r.data.mrNumber}` : r.json?.message ?? ""}`);

step("11. Reports at A1");
const fy = (() => {
  const d = new Date(Date.now() + IST);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
})();
r = await preview(CTRL, "stock_on_hand", { fy, hotel_ids: [A1] });
check("7.1 Stock on hand [item, qty, value]", (r.data?.rows || []).map((x) => [x.item_name, x.qty, x.value]), [
  ["Basmati Rice", 75, 6750], ["Paneer", 5, 1900], ["Shower Cap", 140, 560],
]);
r = await preview(CTRL, "consumption_by_department", { fy, hotel_ids: [A1] });
check("7.3 Consumption [dept, out, returns, net]", (r.data?.rows || []).map((x) => [x.department_name, x.out_value, x.return_value, x.net_value]), [
  ["F&B", 2280, 760, 1520],
]);
r = await preview(CTRL, "stock_adjustments", { fy, hotel_ids: [A1] });
check("7.4 Adjustments [reason, qty, value]", (r.data?.rows || []).map((x) => [x.reason, x.qty, x.value]).sort(), [
  ["Expiry", -3, -1140], ["Wastage", -0.5, -190],
].sort());
r = await preview(CTRL, "count_variance", { fy, hotel_ids: [A1] });
check("7.5 Count variance [item, variance, value]", (r.data?.rows || []).map((x) => [x.item_name, x.variance_qty, x.value]), [["Paneer", -0.5, -190]]);
r = await preview(CTRL, "near_expiry", { hotel_ids: [A1] });
check("7.7 Near expiry after the write-off", (r.data?.rows || []).map((x) => [x.batch_no, x.days_to_expiry, x.qty]), [["PNR-E2E-01", 10, 4]]);

step("12. Site-rep link (no login): call-off PO at A1, prices hidden");
const H = { "X-Receive-Token": M.siteRep.token };
r = await api(null, "GET", "/inventory/token/receive-context", undefined, H);
check("context [status, po, open paneer, open caps]", [r.status, r.data?.po?.poNumber, r.data?.lines?.find((l) => l.poLineId === CL.paneer)?.openAtHotel, r.data?.lines?.find((l) => l.poLineId === CL.cap)?.openAtHotel], [
  200, M.pos.callOff.poNumber, 15, 300,
]);
check("no price keys in the context", priceKeys(r.json), []);
check("unknown token", (await api(null, "GET", "/inventory/token/receive-context", undefined, { "X-Receive-Token": "A".repeat(43) })).status, 401);
r = await api(null, "POST", "/inventory/token/grn", {
  poId: CO, hotelId: A1, receivedAt: istDay(0), vendorChallanNo: "FK-DC-2001", post: true, clientEventId: uuid(),
  lines: [
    { poLineId: CL.paneer, receivedQty: 15, acceptedQty: 15, rejectedQty: 0, batchNo: "PNR-E2E-01", expiryDate: EXP_OK },
    { poLineId: CL.cap, receivedQty: 300, acceptedQty: 300, rejectedQty: 0 },
  ],
}, H);
check("token GRN posted, no price keys", [r.status, r.data?.status, priceKeys(r.json)], [201, "posted", []]);
check("paneer batches", batchesOf(await item(STORE, A1, I.paneer)), [[null, null, 1], ["PNR-E2E-01", EXP_OK, 19]]);

step("13. Vendor deliveries view of PO 96801");
r = await api(VENDOR, "GET", `/inventory/vendor/po/${PO}/deliveries`);
check("[status, grns, rtvs, shortCloses, dispatch status]", [r.status, r.data?.grns?.length, r.data?.rtvs?.length, r.data?.shortCloses?.length, r.data?.dispatches?.[0]?.status], [
  200, 2, 1, 3, "received",
]);
check("rejection reason visible", r.data?.grns?.flatMap((g) => g.lines).find((l) => l.rejectedQty > 0)?.rejectionReason, "quality");
check("no price keys", priceKeys(r.json), []);

step("Isolation");
// Rule C3 (E1): a hotel the caller cannot see answers 404, the same body as a missing PO.
r = await api(STORE, "GET", `/inventory/receive/po/${PO}?hotelId=${A2}`);
check("storekeeper at A2 (not visible: 404 like a missing PO)", [r.status, r.json?.message], [404, "Purchase order not found"]);
check("company B buyer on PO 96801 deliveries", (await api(BBUYER, "GET", `/inventory/po/${PO}/deliveries`)).status, 404);
r = await api(BBUYER, "GET", `/inventory/scan/resolve?code=${M.items.paneer.barcodes[0].code}&context=hotel:${B1}`);
check("company B scan of the shared barcode", r.data?.item?.invItemId, M.companyBItem.invItemId);

step("Mail sink");
const before = mails().length;
r = await api(BUYER, "POST", "/po/addSiteRepresentative", { po_id: PO, hotel_id: A2, name: "Meera (Pune receiving, E2E)", email: "siterep.a2@inv-e2e.example.invalid", phone: "9000096898" });
check("site rep added at A2", r.status, 200);
await new Promise((res) => setTimeout(res, 500));
const subjects = mailSubjects();
check("one more mail, the receiving link", [mails().length - before, subjects.some((x) => /^Receiving link for PO/.test(x))], [1, true]);
const recipients = new Set();
for (const f of mails()) {
  const m = JSON.parse(fs.readFileSync(path.join(MAIL_DIR, f), "utf8"));
  for (const k of ["to", "cc", "bcc"]) for (const t of m[k] || []) recipients.add(t.address);
}
check("every recipient is .invalid", [...recipients].every((a) => a.endsWith(".invalid")), true);
console.log(`  INFO  ${mails().length} mails in the sink: ${[...new Set(subjects.map((x) => x.replace(/[A-Z]{2,4}\/[A-Z0-9]+\/\d{4}-\d{2}\/\d+/g, "<doc>")))].join(" | ")}`);

if (process.env.E2E_SKIP_DIGEST !== "1") {
  step("Low-stock digest (direct call of the 07:30 IST sweep)");
  const run = () => spawnSync("bash", [path.join(HERE, "low_stock_digest.sh")], { encoding: "utf8", cwd: path.resolve(HERE, "../..") });
  const mailBefore = mails().length;
  const first = run();
  process.stdout.write(first.stdout.split("\n").filter((x) => x.startsWith("[low-stock-digest]")).map((x) => `        ${x}\n`).join(""));
  const sweep1 = JSON.parse((first.stdout.match(/sweep: (\{.*\})/) || [])[1] || "{}");
  check("first run: one hotel digested", [first.status, sweep1.hotels, sweep1.digests, sweep1.alreadyDigested], [0, 1, 1, 0]);
  check("bells to the storekeeper and the controller", (first.stdout.match(/bell -> (\S+)/g) || []).map((x) => x.slice(8)).sort(), [CTRL, STORE].sort());
  const second = run();
  const sweep2 = JSON.parse((second.stdout.match(/sweep: (\{.*\})/) || [])[1] || "{}");
  check("second run the same day sends nothing", [second.status, sweep2.digests, sweep2.alreadyDigested], [0, 0, 1]);
  check("the digest is in-app only: no mail", mails().length - mailBefore, 0);
}

console.log(`\n${failures ? "FAILED" : "ALL PASSED"}: ${checks - failures}/${checks} checks`);
if (pending.total) {
  console.log(
    `PENDING [D3 mr.create gate]: ${pending.passed}/${pending.total} already hold. Not counted above; ` +
      "after D3's gate merges, rerun on a fresh seed with E2E_REQUIRE_MR_GATE=1."
  );
}
process.exit(failures ? 1 : 0);
