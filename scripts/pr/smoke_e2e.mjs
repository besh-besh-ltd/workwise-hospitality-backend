// PR E2E backend smoke (Task 19a): drives the whole PR flow over HTTP against the LOCAL e2e server.
//   node scripts/pr/smoke_e2e.mjs [http://localhost:8124]      (seed first: scripts/pr/e2e_up.sh)
// Talks only to the base URL it is given and refuses anything but localhost. Prints a transcript.
import fs from "fs";

const BASE = (process.argv[2] || "http://localhost:8124").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) { console.error("ABORT: base URL must be http://localhost:<port>"); process.exit(2); }
const API = `${BASE}/api/v1`;
const PASSWORD = "PrE2e@12345";
const CODES = { REQ_HK: "PRREQHK", REQ_ENG: "PRREQENG", RV_ENG: "PRRVENG", HOD_HK: "PRHODHK", FC: "PRFC", GM: "PRGM", BUY1: "PRBUY1", BUY2: "PRBUY2", COMPANY_ADMIN: "PRCADMIN" };
const HOTEL = 10101, DEPT_HK = 10204, DEPT_PROC = 10201, CAT_KITCHEN = 284;
const V = { teaMaker: 1445, grinder: 1446, foodWarmer: 1449, onContract: 1452 };

const tokens = {};
let failures = 0, step = 0;
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

async function call(who, method, path, body, { form, raw } = {}) {
  const headers = {};
  if (tokens[who]) headers.Authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (form) payload = form; else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  return raw ? { res, json } : { http: res.status, ...json };
}
function check(label, ok, detail = "") {
  step += 1;
  if (!ok) failures += 1;
  say(`${String(step).padStart(2, "0")}. [${ok ? "PASS" : "FAIL"}] ${label}${detail ? `  -> ${detail}` : ""}`);
  return ok;
}
const money = (s) => Number(s).toFixed(2);

async function login(who, creds) {
  const { json } = await call(null, "POST", "/users/login?conform=true", creds, { raw: true });
  tokens[who] = json.token;
  return !!json.token;
}

async function approve(who, detail) {
  const a = detail.capabilities.approval;
  return call(who, "POST", "/general/hospitality/approval/action",
    { approval_instance_id: a.instance_id, approval_instance_step_id: a.current_step_id, action: "APPROVE", comment: "ok (smoke)" });
}

/** Draft -> in_review -> review done -> approvals -> approved, as REQ_HK. Returns the PR id. */
async function approvedPr(title, lines, { upload } = {}) {
  const c = await call("REQ_HK", "POST", "/pr", {
    hotel_id: HOTEL, department_id: DEPT_HK, title, justification: "E2E smoke", required_by_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
    pr_type: "goods", urgency: "normal", delivery_location: "HK store", lines,
  });
  if (c.http !== 200) { check(`create ${title}`, false, JSON.stringify(c).slice(0, 300)); return null; }
  const id = c.data.id;
  if (upload) {
    const d0 = (await call("REQ_HK", "GET", `/pr/${id}`)).data;
    const att = await call("REQ_HK", "POST", `/pr/${id}/attachments`, { pr_line_id: d0.lines[0].id, kind: "spec", file_url: upload.file_path, file_name: upload.file_name });
    check("attach the uploaded sink file to a PR line (isOwnUploadUrl accepts the local sink URL)", att.http === 200, `http ${att.http} ${att.http === 200 ? att.data.attachment.file_url : JSON.stringify(att).slice(0, 200)}`);
  }
  const sub = await call("REQ_HK", "POST", `/pr/${id}/submit`, {});
  check(`submit ${c.data.pr_number}`, sub.http === 200 && sub.data.pr.status === "in_review", `http ${sub.http} ${sub.message} status=${sub.data?.pr?.status}`);
  const rv = await call("RV_ENG", "GET", "/pr/review-queue");
  const item = rv.data?.items?.find((i) => i.pr_id === id);
  check("RV_ENG sees it in the review queue", !!item, `${rv.data?.count} open`);
  if (!item) return null;
  const detail = (await call("RV_ENG", "GET", `/pr/${id}`)).data;
  const catLine = detail.lines.find((l) => l.line_kind === "catalog") || detail.lines[0];
  const cl = await call("RV_ENG", "POST", `/pr/${id}/lines/${catLine.id}/clauses`, { clause_text: "OEM warranty 12 months", clause_type: "clause", weightage: 40 });
  check("RV_ENG adds a technical clause to a line", cl.http === 200, `http ${cl.http}`);
  const done = await call("RV_ENG", "POST", `/pr/${id}/reviews/${item.review_id}/complete`, { note: "Spec ok" });
  check("RV_ENG completes the review -> approval chain starts", done.http === 200 && done.data.pr.status === "pending_approval", `${done.message}; now_with=${done.data?.pr?.now_with}`);
  let d = (await call("HOD_HK", "GET", `/pr/${id}`)).data;
  check("HOD_HK (step 1 ROLE) may approve", d.capabilities.approval?.can_approve === true);
  let r = await approve("HOD_HK", d);
  check("HOD_HK approves step 1", r.http === 200 && r.data.instance_status === "PENDING", `${r.http} ${r.data?.message}`);
  d = (await call("FC", "GET", `/pr/${id}`)).data;
  r = await approve("FC", d);
  check("FC approves step 2 -> final (GM step skipped below Rs 1,00,000)", r.http === 200 && r.data.instance_status === "APPROVED", `${r.http} instance=${r.data?.instance_status}`);
  const fin = (await call("REQ_HK", "GET", `/pr/${id}`)).data;
  check(`${c.data.pr_number} is approved`, fin.pr.status === "approved", `status=${fin.pr.status} now_with=${fin.pr.now_with}`);
  return id;
}

async function main() {
  say(`# 19a backend smoke  (${new Date().toISOString()}, ${API})\n`);
  for (const [who, code] of Object.entries(CODES)) {
    check(`login ${who} (${code})`, await login(who, { employee_code: code, password: PASSWORD }));
  }
  tokens.ADMIN = null;
  const adm = await call(null, "POST", "/admin/auth/login", { username: "pr.platform.admin@example.com", password: PASSWORD });
  tokens.ADMIN = adm.token;
  check("login PLATFORM_ADMIN (admin console)", !!adm.token);

  // Pickers + guided buying
  const hotels = await call("REQ_HK", "GET", "/pr/form/hotels");
  check("REQ_HK form/hotels lists A1", hotels.data?.hotels?.some((h) => h.id === HOTEL), JSON.stringify(hotels.data?.hotels?.map((h) => h.name)));
  const depts = await call("REQ_HK", "GET", `/pr/form/departments?hotel_id=${HOTEL}`);
  check("REQ_HK form/departments lists Housekeeping only", depts.http === 200 && depts.data.departments.length === 1 && depts.data.departments[0].id === DEPT_HK, JSON.stringify(depts.data?.departments));
  const items = await call("REQ_HK", "GET", `/pr/search-items?hotel_id=${HOTEL}&department_id=${DEPT_HK}&q=gas%20lighter`);
  const gl = items.data?.items?.find((i) => i.variant_id === V.onContract);
  check("search-items flags GAS LIGHTER as on_contract (raise an MR)", gl?.on_contract === true, JSON.stringify(gl));
  const blocked = await call("REQ_HK", "POST", "/pr", {
    hotel_id: HOTEL, department_id: DEPT_HK, title: "blocked", justification: "x", required_by_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10),
    lines: [{ product_variant_id: V.onContract, quantity: 1, uom: "NOS", estimated_unit_price: 100 }],
  });
  check("creating a PR with the on-contract variant is refused", blocked.http === 422 && blocked.code === "PR_LINE_ON_CONTRACT", `${blocked.http} ${blocked.code}`);

  // Upload through the running e2e server (local AWS sink)
  const form = new FormData();
  form.append("file", new Blob(["%PDF-1.4 e2e spec sheet\n"], { type: "application/pdf" }), "tea-maker-spec.pdf");
  const up = await call("REQ_HK", "POST", "/users/upload-file", undefined, { form });
  const file = up.data?.[0];
  check("POST /users/upload-file lands in the local sink", !!file?.file_path, file?.file_path);

  // Routing preview: below and above Rs 1,00,000
  const lines = [
    { product_variant_id: V.teaMaker, quantity: "4", uom: "NOS", estimated_unit_price: "5000.00", specification: "Stainless steel, 5L" },
    { free_text_name: "Commercial pizza oven, 2 deck", category_id: CAT_KITCHEN, quantity: "1", uom: "NOS", estimated_unit_price: "40000.00" },
  ];
  const prev = await call("REQ_HK", "POST", "/pr/routing-preview", { hotel_id: HOTEL, department_id: DEPT_HK, lines });
  const pa = prev.data?.approval;
  say(`    preview amount ${prev.data?.amount}; reviews: ${JSON.stringify(prev.data?.reviews?.map((r) => ({ dept: r.department_title, reviewers: r.reviewers.map((x) => x.name), lines: r.line_nos })))}`);
  say(`    preview steps: ${JSON.stringify(pa?.steps?.map((s) => ({ n: s.step_order, type: s.approver_source_type, applies: s.applies, skipped: s.skipped_reason, approvers: s.approvers.map((x) => x.name) })))}`);
  check("preview: Engineering review with RV_ENG (+REQ_ENG) as reviewers", prev.data?.reviews?.length === 1 && prev.data.reviews[0].department_title === "Engineering" && prev.data.reviews[0].reviewers.some((r) => r.id === 96013));
  check("preview Rs 60,000: HOD_HK -> FC apply, GM greyed (below_threshold)",
    pa?.steps?.length === 3 && pa.steps[0].applies && pa.steps[0].approvers.some((a) => a.id === 96014) && pa.steps[1].applies && pa.steps[2].applies === false && pa.steps[2].skipped_reason === "below_threshold" && !prev.data.problems.length,
    `problems=${JSON.stringify(prev.data?.problems)}`);
  const big = await call("REQ_HK", "POST", "/pr/routing-preview", { hotel_id: HOTEL, department_id: DEPT_HK, lines: [{ ...lines[0], quantity: "30" }, lines[1]] });
  check("preview Rs 1,90,000: GM step now applies", big.data?.approval?.steps?.[2]?.applies === true, `amount ${big.data?.amount}`);

  // The full flow, PR 1 (catalog tea maker + free-text pizza oven, with an attachment)
  const pr1 = await approvedPr("Pantry tea makers + pizza oven (smoke)", lines, { upload: file });
  // PR 2: another free-text line that goes through catalog request + admin fulfil
  const pr2 = await approvedPr("Bain-marie (smoke)", [
    { free_text_name: "Bain-marie 6 pan", category_id: CAT_KITCHEN, quantity: "2", uom: "NOS", estimated_unit_price: "12000.00" },
    { product_variant_id: V.grinder, quantity: "1", uom: "NOS", estimated_unit_price: "9000.00" },
  ]);
  if (!pr1 || !pr2) throw new Error("approved PRs missing, cannot continue");

  // Buyer pool
  const pool = await call("BUY1", "GET", "/pr/pool?progress=in_pool,needs_mapping,awaiting_catalog&page_size=100");
  const mine = pool.data?.rows?.filter((r) => [pr1, pr2].includes(r.pr_id)) || [];
  say(`    pool rows: ${JSON.stringify(mine.map((r) => ({ pr: r.pr_number, line: r.line_no, item: r.item_name, progress: r.progress, band: r.age_band })))}`);
  check("BUY1 pool shows 4 lines: 2 in_pool (catalog) + 2 needs_mapping (free text)", mine.length === 4 && mine.filter((r) => r.progress === "in_pool").length === 2 && mine.filter((r) => r.progress === "needs_mapping").length === 2);
  const nonBuyer = await call("REQ_HK", "GET", "/pr/pool");
  check("a requester has no pool (403)", nonBuyer.http === 403, `${nonBuyer.http} ${nonBuyer.code}`);

  const buyers = await call("BUY1", "GET", `/pr/buyers?hotel_id=${HOTEL}`);
  check("buyers list has BUY1 and BUY2", [96018, 96019].every((id) => buyers.data?.some((b) => b.id === id)));
  const asg = await call("BUY1", "POST", `/pr/${pr1}/assign`, { buyer_id: 96018 });
  check("BUY1 assigns PR 1 to self", asg.http === 200, asg.message);

  // Map free text (PR 1) directly
  const ft1 = mine.find((r) => r.pr_id === pr1 && r.progress === "needs_mapping");
  const bad = await call("BUY1", "POST", `/pr/${pr1}/lines/${ft1.line_id}/map`, { variant_id: V.onContract });
  check("mapping a free-text line onto the on-contract variant is refused", bad.http === 422 && bad.code === "PR_LINE_ON_CONTRACT", `${bad.http} ${bad.code}`);
  const map = await call("BUY1", "POST", `/pr/${pr1}/lines/${ft1.line_id}/map`, { variant_id: V.foodWarmer });
  check("BUY1 maps 'pizza oven' to FOOD WARMER LAMP", map.http === 200 && map.data.mapped_variant_id === V.foodWarmer, `${map.http} progress=${map.data?.progress}`);

  // PR 2 free text: catalog request -> platform admin fulfils
  const ft2 = mine.find((r) => r.pr_id === pr2 && r.progress === "needs_mapping");
  const cr = await call("BUY1", "POST", `/pr/${pr2}/lines/${ft2.line_id}/catalog-request`, { requested_name: "Bain-marie 6 pan", description: "Stainless, GN 1/3" });
  check("BUY1 requests a catalog item for 'Bain-marie'", cr.http === 200 && cr.data.status === "open", `request ${cr.data?.id}`);
  const list = await call("ADMIN", "GET", "/admin/pr-catalog-requests?status=open");
  check("platform admin sees the open catalog request", list.data?.rows?.some((r) => r.id === cr.data?.id), `${list.data?.total} open`);
  const ful = await call("ADMIN", "POST", `/admin/pr-catalog-requests/${cr.data.id}/fulfil`, { variant_id: V.teaMaker, note: "Added to the catalog (smoke)" });
  check("admin fulfils it (maps the line)", ful.http === 200 && ful.data.line_mapped === true, `${ful.http} ${JSON.stringify(ful.data)}`);

  // Convert
  const pool2 = await call("BUY1", "GET", "/pr/pool?page_size=100");
  const ready = pool2.data.rows.filter((r) => [pr1, pr2].includes(r.pr_id));
  check("all 4 lines are now in_pool", ready.length === 4 && ready.every((r) => r.progress === "in_pool"), ready.map((r) => r.progress).join(","));
  const dup = await call("BUY1", "GET", `/pr/duplicates?hotel_id=${HOTEL}&variant_id=${V.teaMaker}`);
  say(`    duplicates for tea maker: count=${dup.data?.count}`);
  const conv = await call("BUY1", "POST", "/pr/convert", { line_ids: ready.map((r) => r.line_id), department_id: DEPT_PROC });
  check("BUY1 converts the 4 lines to ONE RFQ draft", conv.http === 200 && conv.data?.rfq_id, `${conv.http} ${JSON.stringify(conv.data ?? conv)}`);
  const draft = await call("BUY1", "GET", `/rfq/get-draft-by-id/${conv.data.rfq_id}`);
  const dd = draft.data;
  say(`    draft: rfq_no=${dd?.rfq_no} products=${JSON.stringify((dd?.rfq_products || []).map((p) => ({ variant: p.product_id, name: p.name, vendors: p.vendor_count })))}`);
  const prods = dd?.rfq_products || [];
  check("GET /rfq/get-draft-by-id returns the draft: one product per distinct variant, each with eligible vendors",
    draft.http === 200 && dd?.rfq_id === conv.data.rfq_id && prods.length === 3 && prods.every((p) => p.vendor_count >= 1),
    `${prods.length} products (tea maker x2 merged), vendor_count=${prods.map((p) => p.vendor_count)}`);
  const after = await call("REQ_HK", "GET", `/pr/${pr1}`);
  const progress = after.data.lines.map((l) => l.progress);
  check("PR 1 lines now in_sourcing and linked to the RFQ", progress.every((p) => p === "in_sourcing") && after.data.lines[0].links[0]?.rfq_id === conv.data.rfq_id, progress.join(","));
  const kp = await call("REQ_HK", "GET", "/pr/kpis");
  say(`    REQ_HK kpis: ${JSON.stringify(kp.data)}`);
  const ev = after.data.events.map((e) => e.event_type);
  say(`    PR 1 events: ${ev.join(" > ")}`);

  // Company admin: review routing
  const rr = await call("COMPANY_ADMIN", "GET", "/pr/admin/review-routing");
  check("COMPANY_ADMIN sees review routing KITCHEN EQUIPMENTS -> Engineering", rr.data?.some?.((m) => m.category_id === CAT_KITCHEN && m.department_title === "Engineering"), `http ${rr.http}`);

  say(`\n${failures ? `FAILED: ${failures} check(s)` : "ALL CHECKS PASSED"} (${step} checks)`);
  say(`ids: pr1=${pr1} pr2=${pr2} rfq=${conv.data.rfq_id}`);
}

main().catch((e) => { say(`\nSMOKE CRASHED: ${e.stack || e}`); failures += 1; }).finally(() => {
  fs.writeFileSync(process.env.SMOKE_OUT || "/tmp/pr-e2e-smoke.txt", out.join("\n") + "\n");
  process.exit(failures ? 1 : 0);
});
