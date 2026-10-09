# Vendor Authorization Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four pre-existing vendor authorization holes on prod, without changing behaviour for legitimate callers.

**Architecture:**
- Every vendor identity and tenant scope is derived from `req.user`, never from the request body or query.
- Ownership is checked against the target row loaded from the database.
- Each fix gets a negative HTTP test, driven through the full middleware chain.

**Tech Stack:** Node ESM, Express, pg-promise, Jest + supertest (`tests/helpers/http.js`), real Postgres test DB.

**Spec:** `/Users/apple/Documents/Workwise/hospitality/docs/investigations/2026-10-05-vendor-networks-research.md` §4 (Security defects)

## Global Constraints
- **Branch:** `fix/vendor-authz-hotfix`, cut from `origin/qa`. Worktree: `/Users/apple/Documents/Workwise/hospitality/.worktrees/vendor-authz/backend`.
- **Tests:** run with `npm test -- <path>`, never `npx jest`. Follow `tests/CONVENTIONS.md`. Register every new test file in `tests/shards.json`; check with `npm run test:shards`.
- **Scope:** never accept `vendor_id`, `company_id` or `user_id` from the body or query to decide whose data is read or written. Derive it from `req.user.id` / `req.user.company_id`.
- **Error format:** forbidden responses use the surrounding file's existing error shape (e.g. `{ status: 0, message }`) with HTTP 401 (unauthenticated) or 403 (not owner).
- **Legitimate callers keep working:**
  - A logged-in vendor posting its own responses.
  - An emailed-link vendor (`vendorTokenOrJwt` / guest JWT).
  - Buyers reading tech-eval responses through their existing buyer endpoints.
- **Do not refactor** unrelated code in the touched files.

## Review Focus
1. An emailed-link (guest JWT) vendor submitting tech-eval responses must still succeed for **its own** vendor id.
2. A frontend caller that still sends `vendor_id` equal to its own id must keep working. A different `vendor_id` must be rejected with 403, not silently rewritten, so attacks are visible in logs.
3. A buyer page that calls `/rfq/get-vendor-responses` (if any exists) must keep working. Find the FE callers first (`grep -rn "get-vendor-responses" ../../vendor-networks/frontend` or the main frontend checkout at `/Users/apple/Documents/Workwise/hospitality/frontend`).
4. An amendment request from the true contract vendor must still create an amendment.
5. A vendor's own SPOC and location CRUD must keep working.

---

### Task 1: Tech-eval vendor response endpoints require auth and bind to the caller (P0)

**Files:**
- Modify: `app/routes/rfq/rfqRoutes.js` (the `/get-vendor-responses` and `/add-vendor-response` routes, around lines 703-717)
- Modify: `app/controllers/rfq/rfqController.js` (`addVendorResponse` around line 16881, `getVendorResponses` around line 17106)
- Test: `tests/services/security.techEvalVendorResponseAuth.test.js` (new)

**Background:**
- `noLogin.customer_auth` lets a request with **no Authorization header** through with `req.is_verified = false`.
- `hospitalityMiddleware.requireActiveSubscriptionIfAuthenticated` skips unauthenticated callers.
- `addVendorResponse` then writes `tbl_rfq_product_tech_evaluation_vendors_response` using `vendor_id` from each body element (`rfqModel.addVendorResponse`, `app/models/rfqModel.js:12759`).
- Result: anyone on the internet can overwrite or read any vendor's clause answers.

**Required behaviour:**
- **Authentication:** both routes require an authenticated user. Use `noLogin.vendorTokenOrJwt` if the frontend reaches them from emailed links (check `noLogin.js` and the FE callers); otherwise use passport `jwtUsr`. No `Authorization` → 401.
- **`add-vendor-response`:**
  - Caller must be `user_type 3` (403 otherwise).
  - Every element's `vendor_id` must equal `req.user.id`; any mismatch → 403 and nothing written.
  - Elements with no `vendor_id` get `req.user.id`.
  - The caller must be mapped to the RFQ that owns each `clause_id`. Clause → `rfq_product` → `rfq`; mapping via `tbl_rfq_product_vendors.user_id = req.user.id`. Not mapped → 403.
- **`get-vendor-responses`:**
  - A vendor caller can only read its own responses (`vendor_id` forced or validated as above).
  - If a buyer FE caller exists, a buyer (`user_type` 2/7/8, …) must pass the existing RFQ access check used by the buyer RFQ endpoints (`validateDbBody.rfq_access_check` or `assertUserHasScope` via the RFQ row). If no buyer caller exists, restrict to vendors.

- [ ] **Step 1: Find callers.** `grep -rn "add-vendor-response\|get-vendor-responses" /Users/apple/Documents/Workwise/hospitality/frontend/{components,pages,services}`. Note each caller's auth (logged-in vs token link) and persona. Record them in the report.
- [ ] **Step 2: Write failing tests** in `tests/services/security.techEvalVendorResponseAuth.test.js`, using `httpClient` and fixture vendors/RFQ from `tests/factories/techEval.js` (read it for the seeding API). Cases:
  - (a) no auth header → 401 and no row inserted;
  - (b) vendor A posting `vendor_id = B` → 403 and B's existing response unchanged;
  - (c) vendor A posting `vendor_id = A` for a clause on an RFQ A is mapped to → 200 and row present;
  - (d) vendor A posting for a clause on an RFQ A is NOT mapped to → 403;
  - (e) vendor A reading B's responses → 403 or only A's rows;
  - (f) no auth header on get → 401.
- [ ] **Step 3:** Run `npm test -- tests/services/security.techEvalVendorResponseAuth.test.js`. Expect (a), (b), (d), (e), (f) to FAIL.
- [ ] **Step 4: Implement** the middleware change and controller guards. In the model, read the clause → RFQ mapping with one query: `SELECT DISTINCT rp.rfq_id FROM tbl_rfq_product_tech_evaluation_clauses c JOIN tbl_rfq_products rp ON … WHERE c.id = ANY($1)`. Confirm the column names against `tests/setup/schema.sql`.
- [ ] **Step 5:** Re-run the test file (all pass), then `npm test -- tests/services/techEval` (existing tech-eval suites still green).
- [ ] **Step 6:** Commit: `fix(security): require auth and caller binding on tech-eval vendor responses`.

### Task 2: Amendment request ownership, SPOC/location ownership, clarification mapping

**Files:**
- Modify: `app/controllers/arc_v2/arcAmendmentController.js` (`requestAmendment`, ctx query around lines 238-252)
- Modify: `app/routes/user/usersRoutes.js` (`/add-spoc` around line 523; location routes around lines 466-490) and `app/controllers/admin/vendorController.js` (location/SPOC-map handlers around lines 584-700)
- Modify: `app/controllers/rfq/rfqController.js` (`raiseClarification` around line 17818)
- Test: `tests/services/security.vendorOwnershipHotfix.test.js` (new)

**Required behaviour:**
1. **`requestAmendment`:** select `c.vendor_id` in the ctx query. If `Number(ctx.vendor_id) !== Number(req.user.id)` → 403 `'You can only request amendments on your own contracts'`. The check goes BEFORE any insert or notification.
2. **`/add-spoc`:** the vendor id is always `req.user.id`; ignore `req.body.vendor_id` unless it equals `req.user.id`, otherwise 403.
   - `update-spoc/:spoc_id` and `delete-spoc/:spoc_id`: verify `tbl_users_spoc.user_id = req.user.id` (403 otherwise) if not already checked.
3. **Vendor location endpoints** (`/add-buyer-vendor-location`, `/update-buyer-vendor-location`, `/delete-buyer-vendor-location/:id`, `/map-spoc-location`):
   - The company id is always `req.user.company_id`.
   - Update/delete require the location row's `company_id = req.user.company_id`.
   - Map requires both the SPOC (`user_id = req.user.id`) and the location (`company_id = req.user.company_id`) to be owned.
   - **Admin-panel callers:** if these handlers are also mounted for internal admins (`user_type 1`/`7`), keep their existing behaviour. Only apply the ownership rule to vendor/buyer callers, and document which routes that is.
4. **`raiseClarification`:** a vendor caller must be mapped to the RFQ (`tbl_rfq_product_vendors.user_id = req.user.id AND rfq_id = …`) → 403 otherwise.

- [ ] **Step 1: Write failing HTTP tests** for each of 1–4. Each needs:
  - a negative case (another vendor's contract / SPOC / location / an unmapped RFQ → 403, and no row changed);
  - a positive case (the owner succeeds).
  - For amendments, reuse ARC seeding from `tests/helpers/arcGroupSeed.js` or the existing amendment tests (`grep -rln requestAmendment tests/`).
- [ ] **Step 2:** Run the new file; the negative cases FAIL.
- [ ] **Step 3:** Implement the guards.
- [ ] **Step 4:** Re-run the new file, plus `npm test -- tests/services/arc` and any existing spoc/location/clarification suites (`grep -rln "add-spoc\|clarification" tests/services`). All green.
- [ ] **Step 5:** Commit: `fix(security): ownership checks on amendment request, vendor SPOC/location, clarification`.
