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
