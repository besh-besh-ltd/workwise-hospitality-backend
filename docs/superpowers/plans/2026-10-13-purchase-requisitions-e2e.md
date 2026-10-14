# Purchase Requisitions: E2E notes

## 19a backend smoke

Stack: `scripts/pr/e2e_up.sh` (database `hospitality_test_e2e_pr`, server http://localhost:8124, AWS sink :9556, file mail sink).
World: `scripts/pr/seed_e2e.mjs` (company A / hotel A1; password for every persona `PrE2e@12345`).
Driver: `node scripts/pr/smoke_e2e.mjs` (HTTP only, localhost only). Raw transcript of the passing run:

```
# 19a backend smoke  (2026-10-14T09:53:35.775Z, http://localhost:8124/api/v1)

01. [PASS] login REQ_HK (PRREQHK)
02. [PASS] login REQ_ENG (PRREQENG)
03. [PASS] login RV_ENG (PRRVENG)
04. [PASS] login HOD_HK (PRHODHK)
05. [PASS] login FC (PRFC)
06. [PASS] login GM (PRGM)
07. [PASS] login BUY1 (PRBUY1)
08. [PASS] login BUY2 (PRBUY2)
09. [PASS] login COMPANY_ADMIN (PRCADMIN)
10. [PASS] login PLATFORM_ADMIN (admin console)
11. [PASS] REQ_HK form/hotels lists A1  -> ["Hotel A-1"]
12. [PASS] REQ_HK form/departments lists Housekeeping only  -> [{"id":10204,"title":"Housekeeping"}]
13. [PASS] search-items flags GAS LIGHTER as on_contract (raise an MR)  -> {"variant_id":1452,"variant_name":"GAS LIGHTER 12\"","product_name":"GAS LIGHTER 12\"","category_id":235,"category_title":"KST","on_contract":true,"arc_contract_id":5,"arc_number":"ARC-E2E-PR-0001"}
14. [PASS] creating a PR with the on-contract variant is refused  -> 422 PR_LINE_ON_CONTRACT
15. [PASS] POST /users/upload-file lands in the local sink  -> http://vn-e2e-local.localhost:9556/1791971619174-93740829-319b-4607-ae82-08b0fa83b799.pdf
    preview amount 60000.00; reviews: [{"dept":"Engineering","reviewers":["Chitra Company Admin","Ravi Requester (Eng)","Rohit Reviewer (Eng)"],"lines":[1,2]}]
    preview steps: [{"n":1,"type":"ROLE","applies":true,"skipped":null,"approvers":["Hari HOD (HK)"]},{"n":2,"type":"USER","applies":true,"skipped":null,"approvers":["Farah Finance Controller"]},{"n":3,"type":"USER","applies":false,"skipped":"below_threshold","approvers":[]}]
16. [PASS] preview: Engineering review with RV_ENG (+REQ_ENG) as reviewers
17. [PASS] preview Rs 60,000: HOD_HK -> FC apply, GM greyed (below_threshold)  -> problems=[]
18. [PASS] preview Rs 1,90,000: GM step now applies  -> amount 190000.00
19. [PASS] attach the uploaded sink file to a PR line (isOwnUploadUrl accepts the local sink URL)  -> http 200 http://vn-e2e-local.localhost:9556/1791971619174-93740829-319b-4607-ae82-08b0fa83b799.pdf
20. [PASS] submit PR-2026-00006  -> http 200 Submitted for technical review status=in_review
21. [PASS] RV_ENG sees it in the review queue  -> 1 open
22. [PASS] RV_ENG adds a technical clause to a line  -> http 200
23. [PASS] RV_ENG completes the review -> approval chain starts  -> Review completed — sent for approval; now_with=Approval step 1: Hari HOD (HK)
24. [PASS] HOD_HK (step 1 ROLE) may approve
25. [PASS] HOD_HK approves step 1  -> 200 Step 1 approved. Moving to step 2.
26. [PASS] FC approves step 2 -> final (GM step skipped below Rs 1,00,000)  -> 200 instance=APPROVED
27. [PASS] PR-2026-00006 is approved  -> status=approved now_with=Purchase team
28. [PASS] submit PR-2026-00008  -> http 200 Submitted for technical review status=in_review
29. [PASS] RV_ENG sees it in the review queue  -> 1 open
30. [PASS] RV_ENG adds a technical clause to a line  -> http 200
31. [PASS] RV_ENG completes the review -> approval chain starts  -> Review completed — sent for approval; now_with=Approval step 1: Hari HOD (HK)
32. [PASS] HOD_HK (step 1 ROLE) may approve
33. [PASS] HOD_HK approves step 1  -> 200 Step 1 approved. Moving to step 2.
34. [PASS] FC approves step 2 -> final (GM step skipped below Rs 1,00,000)  -> 200 instance=APPROVED
35. [PASS] PR-2026-00008 is approved  -> status=approved now_with=Purchase team
    pool rows: [{"pr":"PR-2026-00006","line":1,"item":"TEA MAKER","progress":"in_pool","band":"ok"},{"pr":"PR-2026-00006","line":2,"item":"Commercial pizza oven, 2 deck","progress":"needs_mapping","band":"ok"},{"pr":"PR-2026-00008","line":1,"item":"Bain-marie 6 pan","progress":"needs_mapping","band":"ok"},{"pr":"PR-2026-00008","line":2,"item":"GRINDER","progress":"in_pool","band":"ok"}]
36. [PASS] BUY1 pool shows 4 lines: 2 in_pool (catalog) + 2 needs_mapping (free text)
37. [PASS] a requester has no pool (403)  -> 403 PR_FORBIDDEN
38. [PASS] buyers list has BUY1 and BUY2
39. [PASS] BUY1 assigns PR 1 to self  -> Assigned
40. [PASS] mapping a free-text line onto the on-contract variant is refused  -> 422 PR_LINE_ON_CONTRACT
41. [PASS] BUY1 maps 'pizza oven' to FOOD WARMER LAMP  -> 200 progress=in_pool
42. [PASS] BUY1 requests a catalog item for 'Bain-marie'  -> request 3
43. [PASS] platform admin sees the open catalog request  -> 1 open
44. [PASS] admin fulfils it (maps the line)  -> 200 {"id":3,"status":"fulfilled","line_id":8,"variant_id":1445,"variant_name":"TEA MAKER","line_mapped":true}
45. [PASS] all 4 lines are now in_pool  -> in_pool,in_pool,in_pool,in_pool
    duplicates for tea maker: count=2
46. [PASS] BUY1 converts the 4 lines to ONE RFQ draft  -> 200 {"rfq_id":113,"rfq_no":100001,"redirect":"/dashboard/buyer/rfq-management?tab=create-rfq&draft_id=113"}
    draft: rfq_no=100001 products=[{"variant":1445,"name":"TEA MAKER","vendors":2},{"variant":1449,"name":"FOOD WARMER LAMP","vendors":1},{"variant":1446,"name":"GRINDER","vendors":2}]
47. [PASS] GET /rfq/get-draft-by-id returns the draft: one product per distinct variant, each with eligible vendors  -> 3 products (tea maker x2 merged), vendor_count=2,1,2
48. [PASS] PR 1 lines now in_sourcing and linked to the RFQ  -> in_sourcing,in_sourcing
    REQ_HK kpis: {"open":0,"awaiting_me":0,"in_purchase_queue":0,"avg_days_to_approval":0}
    PR 1 events: created > attachment_added > submitted > review_created > clause_added > review_completed > approval_started > approved > assigned > line_mapped > converted > converted
49. [PASS] COMPANY_ADMIN sees review routing KITCHEN EQUIPMENTS -> Engineering  -> http 200

ALL CHECKS PASSED (49 checks)
ids: pr1=7 pr2=9 rfq=113
```

Notes from the run:

- `/users/upload-file` returns the local sink URL `http://<bucket>.localhost:<sink port>/<key>` (virtual-hosted). `isOwnUploadUrl`
  accepts it (and the path-style form) only while `AWS_ENDPOINT_URL_S3` is set, which only `e2e_server.sh` does; production never sets it.
- The kitchen variants are filed by the catalog under the product's lowest category id, KST (235), not KITCHEN EQUIPMENTS (284).
  Review routing is therefore seeded for both (free-text lines use the category the requester picks, 284).
- The review preview lists "Chitra Company Admin" as an eligible reviewer: the Company Administrator system role carries `pr.evaluate`.
- Step 1 of the approval policy is a ROLE step (HOD, scoped per department): only the HOD of the PR's own department can resolve it.

## 19b browser pass (2026-10-14)

Driver: chrome-devtools MCP, one isolated browser context per persona. Buyer FE http://localhost:3101 and admin panel
http://localhost:3102, both confirmed (bundle + network panel) to call http://localhost:8124/api/v1 before any login.
Screenshots: `docs/releases/2026-10-purchase-requisitions/screens/` (repo root). Two full passes: pass 1 on the 19a seed
(PR-2026-0000A, catalog-request path), pass 2 after the BE fixes and a re-seed (PR-2026-0000G, map path).

| step | result | screenshots |
|---|---|---|
| 1 create: on-contract item blocked with "raise an MR" link | PASS | 01 |
| 1 catalog + free-text line, preview Eng review + HOD -> FC, GM below Rs 1L | PASS after D1 (GM was drawn as done) | 02 (before), 40 (after) |
| 1 submit | PASS | 03 |
| 2 reviewer: queue, spec edit, 2 clauses (clause 60% + sampling 40%), datasheet upload, complete | PASS | 04, 05, 06 |
| 3 HOD approve, FC send back with note | PASS | 08, 09 |
| 3 requester edits qty above Rs 1L, resubmit, review, HOD, FC, GM | PASS (edit after a page reload failed until D7) | 10, 11, 42, 43 |
| 4 buyer queue, assign to self, catalog request -> admin-panel fulfil -> mappable | PASS | 12, 13, 14, 15, 16 |
| 4 buyer maps a free-text line (pass 2) | PASS | 45 |
| 4 convert -> wizard prefilled (products, Quantity/Unit, both clauses, datasheet as TDS, vendors in tbl_rfq_product_vendors) | PASS | 17, 18 |
| 4 set bid end date, submit RFQ | PASS after D4 (pass 1 needed a manual country code) | 19, 20, 21, 22, 46, 47 |
| 5 requester sees In sourcing + RFQ #100001, conversation both ways, timeline | PASS; step approvals missing until D5 | 23, 44 |
| 6 withdraw during review | PASS | 24, 25 |
| 6 REQ_ENG raising for Eng: HOD step skipped as self (REQ_ENG temporarily held the Eng HOD scope) | PASS | 27, 28 |
| 6 admin deletes the policy -> Submit disabled with copy; restored as a company-wide chain | PASS | 49, 50, 51 |
| 6 409 on a stale tab (withdraw from a second tab) | PASS: "This PR changed since you opened it. Refresh" | 26 |
| 7 mobile 390 px: list, detail, queue | PASS (no page overflow); tables scroll sideways, see cosmetics | 32, 33, 34, 35, 36 |
| admin: PR approval flow wizard (threshold field, hotel vs company-wide cards), PR review routing tab | PASS after the seed fix (L1 role showed "Unknown Role") | 29, 30, 31, 48, 50, 51 |
| awaiting-me tile for an approver | PASS after D2 | 07 (before), 41 (after) |

### Defects

| id | symptom | root cause | fix | test |
|---|---|---|---|---|
| D1 | Preview drew the GM level (below Rs 1L) and a level skipped as self with the green done tick | PrRoutingPreview used class `done` for skipped steps | FE 76f66055: `skipped` class, greyed dashed node | create.test.js "preview steps skipped by design are greyed out" |
| D2 | HOD with "Awaiting me: 1" clicked the tile and got "Nothing is waiting for your review" | KPI counts approvals + returned PRs, tile linked to the review-only queue | BE 2444231f: `GET /pr?tab=awaiting` (shared AWAITING_ME_IDS_SQL with the KPI); FE 9f037ec8: Waiting on me tab, tile opens it, `?tab=awaiting`, dashboard PR queue link | pr.list.test.js "tab=awaiting"; list.test.js, dashboardLinks.test.js |
| D3 | Editing a returned PR warned "1 open request for this item" naming the same PR | duplicate hint did not exclude the PR being edited | FE 76f66055 (+ 5a99f025 for the reload case) | create.test.js "never lists the PR being edited" |
| D4 | Converted RFQ failed to submit: "Contact number must be in the format +<country_code>-<mobile_number>" | conversion copied a bare mobile; the wizard split it into an empty code and sent "-9000096018" | BE 474219f0: `rfqContactNumber()` stores "+CC-number" (bare -> +91) | pr.convert.test.js "contact number" (unit + HTTP) |
| D5 | Timeline only showed the final Approved; after a send-back the first round's approvals vanished from the PR | no PR event for step approvals; chain panel shows only the current instance | BE 4898d362: detail `approval_history` (non-final APPROVEs over all instances); FE 298a1ddf merges it into the timeline | pr.approval.test.js "approval_history"; detail.test.js "merges step approvals" |
| D7 | After a reload of /purchase-requisitions/create?id=N, Save/Submit POSTed a new PR -> 422 "This line does not belong to this requisition"; the returned PR could not be resubmitted | prId state only read the route id on the first render, before the router was ready | FE 5a99f025: take the id when the router is ready | create.test.js "edit opened by a full page load" |
| S1 | Admin PR flow wizard showed L1 as "Unknown Role" with an empty picker | seed created the HOD custom role as the company-less fixture Super Admin, so rbac getRoles hid it | BE b614b478 (seed) | verified in the browser (48) |
| S2 | Re-seeding failed after the browser pass submitted an RFQ (tbl_lifecycle_history / auto-created projects) | seed wipe did not cover RFQ lifecycle rows and the wizard's "Auto Project" | BE a463959d (seed) | `scripts/pr/e2e_up.sh` re-run clean |

### Cosmetic / not fixed (each under 15 min would not cover it, or it is pre-existing)
- Department not auto-selected when the requester has exactly one; edit form shows quantity "2.000" and price "15000.00".
- Preview label for USER steps repeats the user's name (label = approver).
- Line progress says "Awaiting approval" while the PR is in review or returned.
- "Draft edited" has no detail for quantity-only changes and is logged on submit-from-edit with no change; "Was In technical review" capitalisation.
- Detail chain: skipped levels do not name the level (e.g. "Not required below Rs 1,00,000" without "GM").
- Queue table needs horizontal scroll at 1440 px (Actions clipped); at 390 px detail items and queue tables are 1084/1124 px wide inside a sideways scroller, KPI tiles + filters push the list down.
- The global AI-assistant button overlaps the right-most sticky action (Withdraw / Submit).
- RFQ draft does not carry the PR delivery location (uses the hotel address; empty for the seed hotel).
- Rail badge on "My requisitions" counts approvals but opens the Mine tab (Waiting on me is one click away).
- Approvers without pr.create still see "New requisition".
- Admin panel: catalog requests page has no heading; fulfil search does not show whether a variant has vendors.
- RFQ wizard "MARKS AND CLAUSES (1 clauses)" counts only non-sampling clauses (pre-existing wizard).

## 19c final browser confirmation (2026-10-14)

Confirms the final fix wave (BE Task 21 @ f52f3254, FE Task 22 @ 2d76ad93, AP Task 23 @ 8affe2f) in a real browser.
- Driver: chrome-devtools MCP, one isolated context per persona, 1440x900.
- Before any login, both FEs were checked: bundle and network panel use `localhost:8124/api/v1` only.
- Data: re-seeded first. The DB was not written to except through the app.
- Screenshots 70-90 are in `docs/releases/2026-10-purchase-requisitions/screens/` (repo root).

| # | check | result | shots |
|---|---|---|---|
| 1 | Create preview: Engineering reviewers are RV_ENG + REQ_ENG only (Company Administrator no longer listed, R40); GM "Not required below Rs 1,00,000" | PASS | 70 |
| 2 | GAS LIGHTER 12" blocked, "On contract ... raise an MR" | PASS | 71 |
| 2 | Department cleared and re-picked: the contract re-check runs by variant id (`variant_ids=1445`) and "Couldn't verify" never appears | PASS | - |
| 2 | Reload of the edit page: no blank-form flash, quantities "2", not blocked | PASS | 72 |
| 3 | Whole-PR file + line datasheet -> review -> HOD -> FC -> map -> convert -> wizard | PASS | 78-80 |
| 3 | Wizard (R41): every product carries the whole-PR file as Spec; the line datasheet is TDS; DB `tbl_rfq_product_files` agrees | PASS | 79, 80 |
| 3 | Wizard submit | PASS (first try) | - |
| 3 | Vendor quote view | SKIPPED: publishing needs an RFQ approval (instance pending), more than the wizard submit | - |
| 4 | Awaiting me tile opens "Waiting on me" with the same count; `?tab=awaiting` survives a reload; tab clicks update the URL | PASS | 73 |
| 5 | FC (approver only): no New requisition; create shows "can't raise requisitions yet"; review shows "You're not a technical reviewer" | PASS | 74-76 |
| 5 | Company Administrator: read-only list + detail, no New requisition | PASS | 81, 82 |
| 6 | Admin PR wizard: role lacking pr.approve marked "can't approve PRs"; Save shows the server refusal in a toast; Cancel leaves policy steps unchanged; preview still resolves | PASS | 84, 85, 90 |
| 7 | Purchase queue at 1440: Actions column sticky right and fully readable | PASS | 77 |
| 8 | Admin panel catalog requests: "Catalog requests" heading | PASS | 86 |
| m | 390 px: list/detail unchanged; the queue's pinned Actions column now takes ~47% of the table | cosmetic | 87 |

No defects in PR code, so no fix commits.

Reported, not fixed:
- **AI-assistant button over the sticky action.** At 1440x900 the global button covers the PR detail's right-most sticky action (Submit/Withdraw). A real click opened the assistant site instead of submitting. Root cause: `components/shared/WizardChat`, outside PR code.
- **Pinned Actions on mobile.** The pinned Actions column is heavy at 390 px.

Cosmetics, the old -> new screenshot map and the final DB state are in the SDD task-19c report.
