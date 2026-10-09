# Vendor Networks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a vendor HQ run a network of branch, distributor and dealer entities and team logins. Coverage rules suggest routing; the admin routes RFQs and Group ARC hotel fulfilment to members; members accept or decline; call-off POs flow to the assigned member with correct GST.

**Architecture:**
- **Entities stay as `tbl_users` vendor rows (user_type 3).** That keeps every existing `vendor_id` table, predicate and ownership check working unchanged.
- **Acting-entity context.** A new JWT claim `ent`, verified on every request in `jwtUsr`, makes `req.user` *be* the acting entity. The human is carried in `req.user.network.actor_user_id` for audit.
- **One routing engine.** A single assignment state machine with two subject handlers (RFQ, ARC_HOTEL) drives all routing.

**Tech Stack:**
- Backend: Node ESM, Express 4, pg-promise, Joi, Jest + supertest against real Postgres.
- Frontend: Next.js (pages router), React, Redux (persisted `userProfile`), axios (`lib/axios.js`), Jest + RTL.

**Spec:** `/Users/apple/Documents/Workwise/hospitality/docs/superpowers/specs/2026-10-06-vendor-networks-design.md`. It is the binding authority; read the sections each task cites.

## Global Constraints

- **Branches and worktrees:**
  - BE: `/Users/apple/Documents/Workwise/hospitality/.worktrees/vendor-networks/backend`, branch `feat/vendor-networks` (base `origin/qa`).
  - FE: `/Users/apple/Documents/Workwise/hospitality/.worktrees/vendor-networks/frontend`, branch `feat/vendor-networks` (base `origin/main`).
  - Never commit `.env*` or `node_modules`. Never `git stash`. Never push.
- **BE tests:**
  - Run `npm test -- <path-or---testPathPatterns>`, never `npx jest`. The worktree has its own DB (`TEST_RUN_ID=vnet`).
  - Follow `tests/CONVENTIONS.md`: call production functions, and drive HTTP through `tests/helpers/http.js` `httpClient(userId)`.
  - Add every new test file to `tests/shards.json` and check with `npm run test:shards`.
  - Assert observable behaviour (HTTP status + DB state), not mocks.
- **FE tests:** `npm test -- <path>` (jest + RTL); `npm run build` must succeed at the end of every FE task.
- **Migrations:**
  - New SQL files go in `migrations/` with a matching `.down.sql`.
  - List each one in `tests/setup/pendingMigrations.json` (`migrations` array, append at end).
  - Idempotent DDL (`IF NOT EXISTS`). No destructive change to existing columns.
- **Security** (spec §10 and the project's "security first" rule):
  - Never accept a tenant, org, entity or vendor id from the body or query to decide *whose* data is read or written. Derive scope from `req.user` / `req.user.network`.
  - An id in the body is only a *target* that must then be verified as belonging to the caller's org.
- **Role gates:** use `acl([...])` from `app/helper/common.js`. Do NOT use `can()` middleware (it relies on untrusted x-headers). Branch on `req.user.network.role` inside controllers via the helper `requireOrgAdmin(req)` (Task 3).
- **Response shape:** `{ status: 1, message, data }` on success, `{ status: 0, message }` on business errors, with HTTP 400/401/403/404/409 as specified per task.
- **Constants** (exact values):
  - `VENDOR_MEMBER_USER_TYPE = 11`
  - roles `'ORG_ADMIN' | 'ENTITY_MEMBER'`
  - relationships `'PRINCIPAL' | 'BRANCH' | 'DISTRIBUTOR' | 'DEALER'`
  - entity status `'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED'`
  - member status `'INVITED' | 'ACTIVE' | 'DISABLED'`
  - routing mode `'ADMIN_ROUTES' | 'AUTO_SINGLE_MATCH'`
  - subject types `'RFQ' | 'ARC_HOTEL'`
  - assignment status `'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TIMED_OUT' | 'REVOKED' | 'SUPERSEDED'`
  - decline reasons `'NO_STOCK' | 'CANNOT_MEET_DEADLINE' | 'OUT_OF_AREA' | 'OTHER'`
  - Env: `NETWORK_SEAT_FEE_INR` (default `0`), `NETWORK_MAX_PERSONS` (default `25`)
  - Link invite TTL 7 days; member invite TTL 72 hours
  - RFQ due_at cap `bid_end_date − 6h`, floor `now + 1h`
  - Sweep cron `*/15 * * * *`
- **Time:** `tbl_rfq.bid_end_date` is naive IST text. Compare it only via `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')` patterns (see `IST_NOW` in `app/models/dashboardModel.js`). New timestamp columns are `TIMESTAMPTZ`.
- **Back-compat:** a vendor with no network must see byte-identical behaviour (spec §10.1).
- **FE styling:** new vendor network UI uses `styles/arc_v2.css` tokens/classes and mirrors the inline/class mix of the nearest sibling file. Do not add global SCSS.
- **Fixture naming:** `tests/fixtures/network.js` already exists and means the *buyer hotel* network. Name new helpers `tests/helpers/vendorNetworkSeed.js`. Use fixture id range **95001–95999** for every row the seed inserts (`tbl_company`, `tbl_users`, orgs …).

## Review Focus

1. **Stale token after the network changes.** A person removed from an entity mid-session, holding a token whose `ent` is that entity, must get 401 on the very next request, not at token expiry. Test: Task 3, `revocation takes effect next request`.
2. **The principal is also its own login.** A vendor who creates a network keeps logging in with the same credentials and must land as the principal with `role = ORG_ADMIN`, with no `ent` claim needed. Test: Task 3, `principal without ent acts as self with ORG_ADMIN`.
3. **Legacy duplicate accounts linked into one org must not produce two invites or two quotes.** For example, Daikin UP (with its own subscription) linked under Daikin HQ. Test: Task 5 `collapse dedupes linked entities`; Task 9 `one quote per org`.
4. **An RFQ's bid deadline passes while an assignment is PENDING.** The sweep must time it out (due_at was capped to bid_end − 6h) and the principal must still be able to quote directly. Test: Task 8 `rfq due_at capped by bid end`; Task 9 `principal can quote after member timed out`.
5. **A hotel with no state/city ids** (prod has 8). Coverage must treat it as matched only by HOTEL rules, never crash and never match everything. Test: Task 7 `hotel without location ids only matches HOTEL rules`.

---

## File Structure

**Backend (new)**
- `migrations/20261006100000_vendor_networks.sql` / `.down.sql`: all DDL plus the hotel location backfill.
- `app/constants/vendorNetwork.js`: the exact constants above.
- `app/models/vendorNetworkModel.js`: org, entity, member, seat and link-invite data access. Pure SQL, accepts `runner` (db or tx).
- `app/services/vendorNetwork/actingContext.js`: `resolveActingContext`, `subscriptionHolderIdsFor`, `collapseToPrincipals`, `entityCanOperate`.
- `app/services/vendorNetwork/coverage.js`: `resolveCoverageCandidates`.
- `app/services/vendorNetwork/routingEngine.js`: the assignment state machine plus the subject-handler registry.
- `app/services/vendorNetwork/subjects/rfqSubject.js`, `subjects/arcHotelSubject.js`
- `app/services/vendorNetwork/routingSweep.js`: timeout and auto-route tick.
- `app/helper/gstState.js`: GST state code map plus `taxSplitFor`.
- `app/helper/hotelLocation.js`: `resolveHotelLocationIds`.
- `app/controllers/vendorNetwork/{orgController,entityController,memberController,coverageController,routingController,dashboardController}.js`
- `app/routes/vendorNetwork/vendorNetworkRoutes.js`, mounted at `/api/v1/vendor-network` in `app/routes/index.js`.
- `scripts/vendor_networks/hotel_location_report.mjs`
- `tests/helpers/vendorNetworkSeed.js`, plus test files named per task under `tests/services/vendorNetwork.*.test.js`.

**Backend (modified):** `app/helper/jwtHelper.js`, `app/middleware/passport.js`, `app/middleware/requestContext.js`, `app/controllers/users/usersController.js` (get_profile, user_login), `app/models/hospitalityModel.js`, `app/middleware/hospitality.js`, `app/helper/arc_v2/arcEligibility.js`, `app/controllers/rfq/rfqController.js` (createQuote / updateQuoteItems / regret), `app/controllers/arc_v2/arcContractController.js`, `app/services/callOffPoService.js`, `app/helper/arc_v2/callOffPoRenderer.js`, `app/helper/cronManager.js`, `server.js`, `app/services/arcNotificationService.js`, hotel create/update in `app/controllers/users/hospitalityController.js`.

**Frontend (new)**
- `services/vendorNetwork.js`
- `components/dashboard/vendor/network/*`
- `pages/dashboard/vendor/network/{index,entities,team,coverage,routing,assigned}.js`
- `pages/vendor/network/accept-invite.js`
- `components/layout/Header/EntitySwitcher.js`

**Frontend (modified):** `components/landing/LandingAuth.js` (persona for user_type 11), `components/layout/Header/headerConfig.js` (+ visibility function), `pages/dashboard/vendor/rate-contracts/[contractId]/{accept,index}.js`, `components/dashboard/vendor/purchase-orders/VendorPoDetail.js`, buyer ARC contract detail and RFQ vendor list components (located in Task 16).

---

### Task 1: Migration, constants, test seed helper

**Files:**
- Create: `migrations/20261006100000_vendor_networks.sql`, `migrations/20261006100000_vendor_networks.down.sql`
- Create: `app/constants/vendorNetwork.js`
- Create: `tests/helpers/vendorNetworkSeed.js`
- Modify: `tests/setup/pendingMigrations.json` (append the migration path)
- Test: `tests/services/vendorNetwork.schema.test.js`

**Interfaces:**
- Produces:
  - all tables in spec §3;
  - the `tbl_vendor_payments.payment_type` CHECK widened to include `'network_seat'`;
  - `tbl_hospitality_company_hotels.state_id/city_id` (backfilled);
  - `tbl_rfq_product_vendors.routed_from_vendor_id`.
- Produces (seed helper, used by every later BE test):
```js
// tests/helpers/vendorNetworkSeed.js
// seedVendorEntity({ id, companyId, name, email, gstin, stateId=null, cityId=null, password=null, status=1, runner=db })
//   -> inserts tbl_company(id=companyId, company_name=name, gstin) + tbl_users(id, user_type=3, company_id, email, name, status, password)
//      + tbl_company_location if stateId given. Returns { id, companyId }.
// seedPerson({ id, email, name, status=1, runner=db }) -> tbl_users user_type=11, company_id NULL. Returns { id }.
// seedOrg({ id, principalVendorId, name, routingMode='ADMIN_ROUTES', runner=db })
//   -> tbl_vendor_orgs + PRINCIPAL entity row (ACTIVE) + ORG_ADMIN membership for principal (person_user_id=principalVendorId). Returns { orgId }.
// addEntity({ orgId, vendorId, relationship='BRANCH', status='ACTIVE', withSeat=true, runner=db })
//   -> entity row (+ active seat valid to the FY end if withSeat).
// addMember({ orgId, personId, entityVendorId=null, role, status='ACTIVE', runner=db })
// cleanupVendorNetworkFixtures(runner=db) -> deletes every row with ids in 95001..95999 from the new tables first, then tbl_users / tbl_company.
```

- [ ] **Step 1: Write the failing schema test.** `vendorNetwork.schema.test.js` asserts (via `information_schema` / `pg_indexes` / `pg_constraint`):
  - every new table and column exists;
  - the partial unique indexes reject: a second live org membership of one entity; a second PRINCIPAL per org; a second PENDING per `(subject_type, subject_id, hotel_id)`; a second ACCEPTED likewise;
  - the role/entity CHECK rejects `ORG_ADMIN` with an entity and `ENTITY_MEMBER` without one;
  - `payment_type = 'network_seat'` is insertable.
  - Use Pattern A `withTx`; each violation is asserted with `await expect(t.none(...)).rejects.toThrow(/unique|check/i)` inside its own `t.tx` savepoint so the outer tx survives.
- [ ] **Step 2:** `npm test -- tests/services/vendorNetwork.schema.test.js`. Expected FAIL: relation does not exist.
- [ ] **Step 3: Write the migration** exactly per spec §3 DDL, plus:
```sql
-- payment type
ALTER TABLE tbl_vendor_payments DROP CONSTRAINT IF EXISTS tbl_vendor_payments_payment_type_check;
ALTER TABLE tbl_vendor_payments ADD CONSTRAINT tbl_vendor_payments_payment_type_check
  CHECK (payment_type IN ('hospitality','tender','network_seat'));
-- hotel location backfill (India = country_id 1 in tbl_location_states)
UPDATE tbl_hospitality_company_hotels h SET state_id = s.id
  FROM tbl_location_states s
 WHERE h.state_id IS NULL AND s.country_id = 1 AND lower(trim(s.state_name)) = lower(trim(h.state));
UPDATE tbl_hospitality_company_hotels h SET city_id = c.id
  FROM tbl_location_cities c
 WHERE h.city_id IS NULL AND h.state_id IS NOT NULL AND c.state_id = h.state_id
   AND lower(trim(c.city_name)) = lower(trim(h.city));
```
  - Verify the real constraint name first: `grep -n "payment_type" tests/setup/schema.sql`. Use the existing name in DROP.
  - The down migration drops the new tables and columns and restores the old CHECK.
  - Index names are prefixed `ix_vn_`.
- [ ] **Step 4:** Write `app/constants/vendorNetwork.js` exporting frozen objects for every constant in Global Constraints. Env-backed values are FUNCTIONS read at call time (tests flip env): `export const seatFeeInr = () => Number(process.env.NETWORK_SEAT_FEE_INR ?? 0)` and `export const maxNetworkPersons = () => Number(process.env.NETWORK_MAX_PERSONS ?? 25)`.
- [ ] **Step 5:** Write the seed helper with the exact signatures above. Append the migration to `pendingMigrations.json` and the test file to `tests/shards.json` (choose the shard whose pattern fits `vendorNetwork`; if none, add `vendorNetwork` to the most appropriate shard's pattern). Run `npm run test:shards`.
- [ ] **Step 6:** Run the schema test; expected PASS.
- [ ] **Step 7:** Commit: `feat(vendor-network): schema, constants, test seed helper`.

### Task 2: Network data model and acting-context service

**Files:**
- Create: `app/models/vendorNetworkModel.js`, `app/services/vendorNetwork/actingContext.js`
- Test: `tests/services/vendorNetwork.actingContext.test.js`

**Interfaces:**
- Consumes: Task 1 tables, constants and seed helper.
- Produces:
```js
// actingContext.js
export async function resolveActingContext(personRow, entClaim /* number|null */, runner = db)
  // -> { entityRow, network } | null   (null => caller must 401)
  // personRow: full tbl_users row of the authenticated person.
  // network: undefined when the person is a type-3 vendor in no org and entClaim is null/self
  //          (back-compat), else { org_id, org_name, role, actor_user_id, actor_name,
  //          acting_entity_id, is_principal, entity_relationship }
export async function subscriptionHolderIdsFor(vendorId, runner = db)   // -> number[] (ACTIVE org entities, or [vendorId])
export async function collapseToPrincipals(vendorIds, runner = db)      // -> number[] distinct; a live org entity maps to its org's principal
export async function entityCanOperate(vendorId, runner = db)
  // -> { ok: true } | { ok: false, reason: 'NOT_ACTIVE'|'NO_SEAT' }
  //    principal or no-org vendor => ok; non-principal needs entity ACTIVE and a seat with
  //    status 'active' AND end_date >= CURRENT_DATE, OR NETWORK_SEAT_FEE_INR === 0 and entity ACTIVE
export async function listActableEntities(personRow, runner = db)
  // -> [{ vendor_id, name, relationship, org_id }] for the switcher
```
- `vendorNetworkModel.js` exports small named SQL functions used here and by later tasks: `getOrgByEntity(vendorId)`, `getOrgById(id)`, `getEntity(orgId, vendorId)`, `listEntities(orgId)`, `getActiveMemberships(personId)`, `getActiveSeat(entityId)`. Each takes `runner = db`.

**Resolution rules** (spec §4.1 table, verbatim):
- **Person `user_type` 3:**
  - Find its live entity row (`status <> 'REMOVED'`).
  - No org: `ent` null or equal to self → act as self, `network` undefined. Any other `ent` → null.
  - Principal: default self with role ORG_ADMIN. `ent` may be any entity of its org with status ACTIVE.
  - Member entity: only self; role ENTITY_MEMBER. If its entity status is SUSPENDED or INVITED, it still acts as itself but `network.entity_status` carries the status; `entityCanOperate` gates actions.
- **Person `user_type` 11:**
  - Active memberships only.
  - ORG_ADMIN membership → may act as any ACTIVE entity of the org; default is the principal.
  - Otherwise, ENTITY_MEMBER entities that are ACTIVE; default is the lowest `vendor_id`.
  - `ent` not in the actable set → null. No actable entity → null.
- **Every case:** the acting entity row must have `status = 1` and `is_deleted = 0`. Otherwise null, *except* the back-compat no-org self case, which keeps today's semantics (passport already loads only `is_deleted = 0`).

- [ ] **Step 1: Write failing tests.** One `it` each, Pattern B with `cleanupVendorNetworkFixtures` in `afterEach`:
  1. no-org vendor, no ent → self, network undefined
  2. no-org vendor, ent = other id → null
  3. principal no ent → self, role ORG_ADMIN, is_principal true
  4. principal ent = ACTIVE branch → branch row, actor = principal
  5. principal ent = SUSPENDED branch → null
  6. principal ent = entity of another org → null
  7. type-11 ORG_ADMIN no ent → principal
  8. type-11 ENTITY_MEMBER of branch B no ent → B
  9. type-11 member of B, ent = sibling C → null
  10. disabled membership → null
  11. entity REMOVED → null
  12. person status 0 → null
  13. `subscriptionHolderIdsFor` returns all ACTIVE entities for a member entity, `[id]` for a no-org vendor
  14. `collapseToPrincipals([branch, unrelated, principal])` → `[principal, unrelated]` (sorted)
  15. `entityCanOperate`: no seat with fee env 0 → ok; no seat with `process.env.NETWORK_SEAT_FEE_INR = '500'` (re-import constants via `jest.isolateModulesAsync`, or `seatFeeInr()` reads env at call time) → `NO_SEAT`; active seat → ok; principal → ok
- [ ] **Step 2:** Run; expected FAIL (module not found).
- [ ] **Step 3: Implement.** `resolveActingContext` uses at most two indexed queries: memberships plus entity in one, then the acting entity row. Use `seatFeeInr()` from constants (read at call time).
- [ ] **Step 4:** Run; expected PASS. Commit: `feat(vendor-network): acting-context resolution and subscription holder helpers`.

### Task 3: Auth integration (token, passport, login, audit, profile, switch-entity)

**Files:**
- Modify: `app/helper/jwtHelper.js`, `app/middleware/passport.js` (`jwtUsr` and `localUsr`), `app/middleware/requestContext.js` (`resolveActor`), `app/controllers/users/usersController.js` (`user_login`, `get_profile`)
- Create: `app/services/vendorNetwork/guards.js` (`requireOrgAdmin(req)`, `requireNetwork(req)`)
- Create: `app/routes/vendorNetwork/vendorNetworkRoutes.js` with `POST /switch-entity`; mount it in `app/routes/index.js` as `v1.use('/vendor-network', VendorNetworkRoutes)`
- Create: `app/controllers/vendorNetwork/orgController.js` (only `switchEntity` in this task)
- Modify: `tests/helpers/auth.js` (`loginAs(userId, { ent } = {})` adds the encrypted `ent` claim when given)
- Test: `tests/services/vendorNetwork.auth.test.js`

**Interfaces:**
- Consumes: `resolveActingContext`, `listActableEntities` (Task 2).
- Produces:
  - `signAccessTokenUser({ user_id, user_agent, name, sessions, ent })` where `ent` is already encrypted, or omitted.
  - `req.user = { ...entityRow, network }`.
  - `requireOrgAdmin(req)` returns `null` when OK, otherwise an `{ http, body }` the controller returns (403 `'Network admin access required'`).
  - `GET /api/v1/users/get-profile` response gains `network: { org_id, org_name, role, actor_user_id, actor_name, acting_entity_id, is_principal, actable_entities: [...] } | null`.
  - `POST /api/v1/vendor-network/switch-entity { entity_vendor_id }` → `{ status: 1, data: { token, acting_entity_id } }`.

**Required behaviour:**
- **`jwtUsr`:**
  - Decrypt `sub` → load person. Check `ag` against the **person** row.
  - Then, if the person's `user_type` is 3 or 11, call `resolveActingContext(person, ent ? Number(decryptClaim(ent)) : null)`. A null result → `done(null, false)`.
  - Otherwise (buyers, admins) behaviour is unchanged.
  - `req.user = { ...ctx.entityRow, network: ctx.network }`. Keep the property absent when `network` is undefined so no-org vendors get the identical object.
- **`localUsr`:**
  - `user_type 11` may log in by email exactly like vendors.
  - A type-11 person with status 0 gets the existing inactive-account message.
  - An entity row with NULL password must fail as invalid credentials, never crash. Check `bcrypt.compare` is guarded.
  - `user_login` must not run the hospitality-subscription approval branch for type 11.
- **Persona:** the `user_login` response for type 11 includes `user_type: 11`; FE maps it to vendor (Task 13).
- **`resolveActor`:** when `user.network?.actor_user_id` differs from `user.id`, return `actorType VENDOR`, `actorUserId = network.actor_user_id`, `actorLabel = "${actor_name} (${entity name})"`. Then grep `app/config/dbConn.js` for how `app.actor_id` gets its value and make sure it uses `resolveActor` (adapt if it reads `req.user.id` directly).
- **`switchEntity`:**
  - `acl([3])` (the acting entity is type 3 after `jwtUsr`).
  - Recompute the context from the **person**, which is `req.user.network?.actor_user_id ?? req.user.id`, with the requested `ent`. Null → 403 `'You cannot act for this entity'`.
  - Sign a fresh token with the same `ag` (re-encrypt from the person row's `user_agent`).

- [ ] **Step 1: Write failing HTTP tests** with `httpClient`. Extend it to accept `{ ent }` and pass it to `loginAs`. Cases:
  - (a) **Back-compat:** a no-org vendor's `GET /api/v1/users/get-profile` returns the same keys as before plus `network: null`, and `GET /api/v1/po/vendor/...` (choose any existing vendor-scoped GET used in `tests/services/po*`) still returns 200.
  - (b) A type-11 ORG_ADMIN person calling `get-profile` sees `data.id === principalId`, `network.actor_user_id === personId`.
  - (c) A token with `ent` = sibling entity the person isn't a member of → 401.
  - (d) **Revocation takes effect next request:** member call OK; set membership DISABLED; same token → 401.
  - (e) **Principal without ent acts as self with ORG_ADMIN.**
  - (f) `switch-entity` to an ACTIVE branch returns a token; using it, `get-profile` shows the branch id.
  - (g) `switch-entity` to a foreign entity → 403.
  - (h) **Audit:** a type-11 person performing `switch-entity` writes a `tbl_activity_events` row whose `actor_user_id = personId`. If switch-entity isn't captured by `activityCapture`, assert via `resolveActor(req)` in a unit test instead (call `resolveActor` with a fake req carrying `network`).
  - (i) **Login:** `POST /api/v1/users/login` with a type-11 email/password returns a token whose `get-profile` resolves; a NULL-password entity email → 401/invalid credentials.
- [ ] **Step 2:** Run; expected FAIL.
- [ ] **Step 3:** Implement as specified.
- [ ] **Step 4:** Run the new file plus the regression set `npm test -- --testPathPatterns "tests/services/(activity|security|admin)\."`. All green.
- [ ] **Step 5:** Commit: `feat(vendor-network): acting-entity auth context, login for members, audit attribution, switch-entity`.

### Task 4: Org and entity management API (create, settings, link, create branch, suspend, remove, seats)

**Files:**
- Create: `app/controllers/vendorNetwork/entityController.js`
- Modify: `orgController.js` and `vendorNetworkRoutes.js`
- Extend: `vendorNetworkModel.js`
- Create: `app/services/vendorNetwork/seats.js`
- Test: `tests/services/vendorNetwork.orgEntities.test.js`

**Interfaces:**
- Consumes: guards (Task 3); `entityCanOperate`, `collapseToPrincipals` (Task 2).
- Produces the endpoints of spec §5 (org, entities, link invites, suggestions, leave) and seats (§5.1):
```js
// seats.js
export async function ensureSeatForEntity({ orgId, entityVendorId, actorUserId }, runner)
  // fee 0 => insert active seat (start today, end = FY end Mar 31) if none active; returns { seat, payable:false }
  // fee >0 => insert pending seat if none pending/active; returns { seat, payable:true, amount }
export async function createSeatPaymentOrder({ orgId, seatIds, actorUserId })  // Razorpay order via the same client hospitalityController uses; inserts tbl_vendor_payments(payment_type='network_seat', payment_status='created')
export async function activateSeatsForPayment(paymentId, runner)               // on verified payment: payment -> 'paid', seats -> 'active'
export function financialYearEnd(date = new Date())                          // -> 'YYYY-03-31' string of the FY containing date (Indian FY)
```
- Routes (all `passportSignIn, acl([3])`; admin ones call `requireOrgAdmin`):
  - `POST /org`
  - `GET /org`
  - `PATCH /org`
  - `GET /entities/suggestions`
  - `POST /entities/link-invites`
  - `GET /link-invites/incoming` (target entity)
  - `POST /link-invites/:id/accept`
  - `POST /link-invites/:id/decline`
  - `DELETE /entities/link-invites/:id` (cancel)
  - `POST /entities`
  - `PATCH /entities/:vendorId` `{ status: 'SUSPENDED'|'ACTIVE', preference_rank }`
  - `DELETE /entities/:vendorId`
  - `POST /entities/self/leave`
  - `POST /seats/pay { seat_ids }` → razorpay order
  - `POST /seats/verify-payment { razorpay_order_id, razorpay_payment_id, razorpay_signature }` (HMAC verify exactly like `/hospitality/verify-payment`; read that handler and reuse its signature helper)
- **Link invites:** accept/decline are addressed by invite **id**, checked against the caller (`target_vendor_id = req.user.id`). The token hash in the table is used for emailed links. Store a sha256 hash, never the raw token.

**Rules** (each gets a test):
1. **`POST /org`:** caller in no live org; name required (1–120 chars). Creates org + PRINCIPAL ACTIVE + ORG_ADMIN membership (person = caller). A second call → 409.
2. **Suggestions:** PAN = `upper(substr(gstin,3,10))` from `tbl_company.gstin` of the principal, falling back to `tbl_vendor_documents` `document_type='pan'`. Match active vendors (user_type 3, status 1, is_deleted 0) with the same PAN, excluding self and entities in any live org.
3. **Link invite:**
   - Target by `target_vendor_id` or `target_email` (exact, case-insensitive, user_type 3).
   - Target must be active, in no live org, and not a principal of any org → else 409 with reasons `ALREADY_IN_NETWORK` / `IS_PRINCIPAL` / `NOT_FOUND`.
   - Creates a PENDING invite (expires now + 7d) and an INVITED entity row is **not** created yet.
   - Notifies the target via `notificationService.dispatch({ userIds:[target], category:'NETWORK', type:'NETWORK_LINK_INVITE', title, body, actionUrl:'/dashboard/vendor/network/invites' })`.
4. **Accept invite:**
   - Only the target (acting as itself) can accept. The invite must be PENDING and not expired; an expired one is flipped to EXPIRED → 410.
   - In one tx: invite ACCEPTED, entity row ACTIVE with relationship from the invite, `ensureSeatForEntity`.
   - Re-check the "in no live org" race inside the tx (the unique index is the backstop; map a violation to 409).
   - Notify the principal.
5. **Decline** → DECLINED, principal notified. **Cancel** by the admin → CANCELLED.
6. **`POST /entities` (create new):**
   - Validate GSTIN format `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$`, and that no active vendor holds the same GSTIN (→ 409 `GSTIN_EXISTS` with a hint to link instead).
   - Email must not exist in `tbl_users`.
   - `state_id` must exist in `tbl_location_states`; `city_id`, if given, must belong to that state.
   - Insert `tbl_company(company_name, gstin)` + `tbl_users(user_type 3, status 1, company_id, email, name = company_name, password NULL)` + `tbl_company_location(company_id, country_id 1, state_id, city_id, address)` + entity ACTIVE + `ensureSeatForEntity`. One tx.
7. **Suspend / reactivate:**
   - Admin only; cannot target the principal (400).
   - Suspending calls `routingEngine.revokeLiveAssignmentsForEntity(vendorId, { actorUserId, reason: 'ENTITY_SUSPENDED' })`. **Task 8 provides this; until then call it through a no-op stub exported from `routingEngine.js` that Task 8 replaces.** Create `routingEngine.js` with `export async function revokeLiveAssignmentsForEntity(vendorId, { actorUserId = null, reason = 'ENTITY_REMOVED' } = {}) { return 0; }` in this task (same signature Task 8 implements).
8. **Remove (admin) and leave (self):**
   - Entity → REMOVED, `removed_at`; revoke live assignments; disable ENTITY_MEMBER memberships for that entity; cancel pending seats; active seats stay until expiry, unused.
   - The principal can't leave or be removed (400).
9. **`PATCH /org`:** `routing_mode` in the enum; `routing_timeout_hours` 1..168.
10. **Isolation:** every `:vendorId` target must be an entity of the caller's org → else 404.
11. **Seats:** with fee 0, linking or creating yields an active seat. With fee > 0 (set env in the test), the seat is pending, `entityCanOperate` → NO_SEAT, `/seats/pay` creates the payment row (mock only the Razorpay SDK `orders.create` with `jest.unstable_mockModule` or the existing razorpay test seam; grep tests for `razorpay`), and `/seats/verify-payment` with a valid HMAC (compute it in the test using `RAZORPAY_KEY_SECRET` from `.env.test`) activates the seat.

- [ ] **Step 1:** Write failing HTTP tests, one `it` per numbered rule, with positive and negative halves where applicable.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, plus the Task 2–3 test files.
- [ ] **Step 5:** Commit: `feat(vendor-network): org, entity linking/creation, suspension, seats`.

### Task 5: People (team logins) API

**Files:**
- Create: `app/controllers/vendorNetwork/memberController.js`
- Modify: routes, model
- Test: `tests/services/vendorNetwork.members.test.js`

**Interfaces:**
- Consumes: guards; mail helper `sendMail` from `app/helper/common.js`. Find the existing invite/reset email layout via `grep -rn "send-password-reset" app/controllers/users/usersController.js` and reuse its layout helper.
- Produces:
  - `GET /members`
  - `POST /members { email, name, role, entity_vendor_id? }`
  - `PATCH /members/:id { status: 'ACTIVE'|'DISABLED', role?, entity_vendor_id? }`
  - `POST /members/:id/resend`
  - public `POST /member-invites/accept { token, password }`
  - public `GET /member-invites/:token` (returns `{ email, org_name, entity_name, expired }` for the accept page; never other data)

**Rules:**
1. **Admin only.** ORG_ADMIN requires no entity. ENTITY_MEMBER requires `entity_vendor_id` that is a live entity of the caller's org (else 404).
2. **New email:**
   - The email must not exist in `tbl_users` (case-insensitive) → else 409 `EMAIL_EXISTS`.
   - Creates `tbl_users(user_type 11, status 0, email, name, company_id = principal's company_id)`. If `company_id` is used by buyer-company queries as a tenant, set NULL instead. Check `grep -rn "company_id" app/models/userModel.js | head` and document the choice.
   - Membership INVITED with a sha256 `invite_token_hash` and `invite_expires_at = now + 72h`.
   - Emails a link `${FRONTEND_URL}/vendor/network/accept-invite?token=<raw>`. Find the FE base URL env name used by the existing password-reset email.
3. **Adding a membership to an existing type-11 person of the same org** (a second entity) is allowed with no new invite. A person of another org → 409 `PERSON_IN_OTHER_ORG`.
4. **Cap:** the count of non-DISABLED distinct persons in the org must be < `NETWORK_MAX_PERSONS` (read at call time) → else 409 `PERSON_LIMIT`.
5. **Accept:**
   - Token hash must match an INVITED, non-expired membership. Password must be ≥ 8 chars, with a letter and a digit.
   - Sets bcrypt password (same cost as registration), user status 1, and **all** that person's INVITED memberships in the org → ACTIVE.
   - Invalid/expired → 410. Reuse of the token → 410.
6. **Disable:** sets DISABLED. That person's next request with any token → 401 (Task 3 guarantees). Cannot disable the principal's own ORG_ADMIN membership (400), and cannot disable the last ACTIVE ORG_ADMIN (400 `LAST_ADMIN`).
7. **Resend:** only for INVITED; rotates the token (old token → 410).

- [ ] **Steps:** failing tests per rule → implement → pass, plus the earlier vendorNetwork tests → commit `feat(vendor-network): team member invites and management`.

### Task 6: Subscription and eligibility integration (parent covers network, invites collapse to principal, seat gate)

**Files:**
- Modify: `app/models/hospitalityModel.js`:
  - `hasValidPaidSubscription` → evaluate over `subscriptionHolderIdsFor`;
  - `getEligibleVendorsForVariant` and the recompute/add-missing sync (~lines 1244-1385) and `getMatchingOpenRfqsForVendor` / `addVendorToRfq` (~2063-2160) → collapse results with `collapseToPrincipals`.
- Modify: `app/middleware/hospitality.js` `requireActiveSubscription`. After the subscription check, also require `entityCanOperate(req.user.id).ok` → else 403 `{ status:0, message:'Network seat required for this entity', code:'NO_SEAT' }`.
- Modify: `app/helper/arc_v2/arcEligibility.js`:
  - `resolveArcVendorCoverage` → collapse to principals, unioning hotel ids and renewal-needed ids per principal;
  - `vendorCanSubmitForHotels` → evaluate over holder ids.
- Test: `tests/services/vendorNetwork.eligibility.test.js`

**Interfaces:**
- Consumes: `subscriptionHolderIdsFor`, `collapseToPrincipals`, `entityCanOperate`.
- Produces: no new exports. Behaviour per spec §5.2.

**Required tests:**
1. **Collapse dedupes linked entities:** branch B (own category+hotel subs, variant mapped) linked ACTIVE under principal P. `getEligibleVendorsForVariant(variant,[hotel])` → contains P, not B. Before linking it contained B.
2. A no-org vendor's eligibility is unchanged (same result before and after the code change; compare with a vendor seeded identically).
3. **Member without subscription:** P subscribed; member M with none. `hasValidPaidSubscription(M)` true. `requireActiveSubscription` lets M through when it has a seat, and returns 403 NO_SEAT when the fee env is > 0 and the seat is pending.
4. **ARC:** `resolveArcVendorCoverage({category_id, hotel_ids})` with B subscribed to hotel H1 and P to H2 → one row for P with hotel_ids `[H1,H2]`.
5. The RFQ sync (find the function that recomputes vendors when RFQ hotels change; name it in the report) does not add B after linking and does **not delete** rows that have `routed_from_vendor_id IS NOT NULL`.
6. **Regression:** run `npm test -- --testPathPatterns "tests/services/(hospitality|rfq\.vendor|arc|vendor)"`. Every previously-green suite stays green. If any existing test seeds vendors in ways the collapse changes, the code is wrong, not the test, unless the test seeds an org.

- [ ] **Steps:** failing tests → implement → pass + regression set → commit `feat(vendor-network): parent subscription covers network; invites collapse to principal; seat gate`.

### Task 7: Hotel location ids and coverage rules API and resolver

**Files:**
- Create: `app/helper/hotelLocation.js`, `app/services/vendorNetwork/coverage.js`, `app/controllers/vendorNetwork/coverageController.js`, `scripts/vendor_networks/hotel_location_report.mjs`
- Modify: hotel create/update handlers (`grep -n "INSERT INTO tbl_hospitality_company_hotels\|UPDATE tbl_hospitality_company_hotels" -r app/` and hook every write), routes
- Test: `tests/services/vendorNetwork.coverage.test.js`

**Interfaces:**
```js
// hotelLocation.js
export async function resolveHotelLocationIds(stateText, cityText, runner = db) // -> { state_id|null, city_id|null } (India states, case/trim-insensitive; city must belong to state)
// coverage.js
export async function resolveCoverageCandidates({ orgId, hotelIds, categoryId = null }, runner = db)
  // -> [{ entity_vendor_id, name, specificity /*max over hotels*/, preference_rank, covers_all_hotels, hotels_covered:number[] }]
  //    ranked: covers_all_hotels desc, specificity desc, preference_rank asc, entity_vendor_id asc
  //    excludes principal, non-ACTIVE entities, entities failing entityCanOperate
export async function entityCoversHotel(entityVendorId, hotelId, categoryId, runner = db) // -> { covered:boolean, specificity:0..3 }
```
- Routes (admin):
  - `GET /coverage/:vendorId` (rules plus a "covered hotels preview" across all hotels of companies the org has RFQ/ARC relationships with; **simplify:** preview over hotels that appear in any `tbl_rfq_product_vendors` / `tbl_arc_invitation` of the org's principal)
  - `PUT /coverage/:vendorId { rules: [{ scope_type, scope_id, mode, category_id|null }] }` (replace-all in one tx; validate every `scope_id` exists in its table; max 500 rules)
  - Also exposed: `GET /coverage/lookup/states`, `GET /coverage/lookup/cities?state_id=`, `GET /coverage/lookup/hotels?q=` (hotels limited to the preview set, for HOTEL rules).

**Decision algorithm** (implement exactly; `entityCoversHotel` per hotel):
```text
rules R = rules of entity where (category_id IS NULL OR category_id = $categoryId)
match(r) = (r.scope_type='HOTEL' AND r.scope_id=hotel.id)
        OR (r.scope_type='CITY'  AND hotel.city_id IS NOT NULL AND r.scope_id=hotel.city_id)
        OR (r.scope_type='STATE' AND hotel.state_id IS NOT NULL AND r.scope_id=hotel.state_id)
spec(r) = HOTEL 3, CITY 2, STATE 1
M = matched rules; if empty -> not covered
top = max spec(r) over M
T = rules in M with spec = top; if any has category_id = $categoryId (non-null) restrict T to those
covered = no rule in T has mode 'EXCLUDE'
```
Do this in SQL with one query per call over all requested hotels: join hotels × rules, then window by `(hotel_id)`.

**Required tests:**
1. State include covers every hotel in that state.
2. City exclude inside a state include → that city's hotel not covered, a sibling-city hotel covered.
3. Hotel include beats city exclude.
4. A category-specific exclude beats a category-null include at equal specificity, for that category only.
5. **Hotel without location ids only matches HOTEL rules.** A NULL state/city hotel with a STATE rule for "its" state text → not covered; with a HOTEL rule → covered.
6. Ranking: two candidates, one covering all hotels and one covering some → full first; tie → lower `preference_rank` first.
7. SUSPENDED / unseated / principal entities excluded.
8. `PUT` validation: unknown `scope_id` → 400; foreign `vendorId` → 404; non-admin → 403.
9. `resolveHotelLocationIds('maharashtra ', 'Pune')` resolves; an unknown city → `{ state_id, city_id:null }`.
10. Hotel update through the existing endpoint (find its route) sets `state_id/city_id`.
11. The report script prints unmatched hotels (`node scripts/vendor_networks/hotel_location_report.mjs` against the test DB via `TEST` env, or unit-test its exported `findUnmatchedHotels(runner)`).

- [ ] **Steps:** failing tests → implement → pass → commit `feat(vendor-network): hotel location ids, coverage rules and resolver`.

### Task 8: Routing engine and sweep cron

**Files:**
- Replace the stub: `app/services/vendorNetwork/routingEngine.js`
- Create: `app/services/vendorNetwork/routingSweep.js`, `app/controllers/vendorNetwork/routingController.js`
- Modify: `app/helper/cronManager.js` (`runVendorRoutingSweepTick`, `startVendorRoutingSweep` with `*/15 * * * *`), `server.js` (start it next to `startRfqStuckPublishWatchdog()`), routes
- Test: `tests/services/vendorNetwork.routingEngine.test.js`

**Interfaces:**
```js
// routingEngine.js
export function registerSubject(subjectType, handler)
// handler = {
//   async validateSubject({ orgId, subjectId, hotelId }, t)  -> { ok:true, dueCap?:Date, hotelIds:number[], categoryId:number|null } | { ok:false, http, message }
//   async onPending(assignment, t)   // e.g. RFQ: copy rpv rows
//   async onAccepted(assignment, previousAccepted|null, t)
//   async onReleased(assignment, priorStatus, t) // DECLINED|TIMED_OUT|REVOKED|SUPERSEDED cleanup
//   async describe(assignment, t) -> { title, actionUrl } for notifications
// }
export async function assign({ orgId, subjectType, subjectId, hotelId = null, assigneeVendorId, actorUserId, autoRouted = false })
export async function respond({ assignmentId, actingVendorId, actorUserId, decision: 'ACCEPT'|'DECLINE', reason, note })
export async function revoke({ assignmentId, orgId, actorUserId })
export async function revokeLiveAssignmentsForEntity(vendorId, { actorUserId = null, reason = 'ENTITY_REMOVED' } = {}) // -> count
export async function listForOrg(orgId, { status, subjectType }) ; export async function listForAssignee(vendorId, { status })
```
**Transitions (all in `db.tx`, with `SELECT … FOR UPDATE` on the subject's live rows):**
- **`assign`:**
  - The assignee must be an ACTIVE, non-principal entity of the org with `entityCanOperate.ok` → else 409 `ASSIGNEE_NOT_ELIGIBLE`.
  - The handler validates the subject.
  - An existing PENDING for the same `(subject, hotel)` becomes REVOKED (via `onReleased`).
  - Insert PENDING with `due_at = max(now+1h, min(now + org.routing_timeout_hours, dueCap))`, then call `onPending`.
  - An existing ACCEPTED for the same `(subject, hotel)` assigned to the **same** vendor → 409 `ALREADY_ACCEPTED`.
- **`respond`:**
  - Only when `assignment.assigned_vendor_id === actingVendorId` (else 404, to avoid leaking existence) and status PENDING (else 409).
  - **ACCEPT:** the previous ACCEPTED for the same `(subject, hotel)` → SUPERSEDED (`onReleased`), then this → ACCEPTED, then `onAccepted`.
  - **DECLINE:** a valid reason is required, and a note is required for OTHER (400 otherwise) → DECLINED + `onReleased`.
- **`revoke`:** admin of the same org. PENDING or ACCEPTED → REVOKED + `onReleased`. The handler's `onReleased` may throw `{http:409}` to forbid (RFQ with a submitted quote).
- **Notifications:**
  - Notify the principal on DECLINED / TIMED_OUT / ACCEPTED (`category 'NETWORK'`, types `NETWORK_ROUTING_DECLINED|TIMED_OUT|ACCEPTED`).
  - Notify the assignee on PENDING (`NETWORK_ROUTING_ASSIGNED`) and REVOKED.
  - Email the assignee entity's email plus the active member persons' emails on PENDING.
  - Dispatch after commit.
- **Activity:** each transition writes a `tbl_activity_events` row. Find the writer in `app/models/activityModel.js` and use its public function, with the actor = person.
- **Sweep `runVendorRoutingSweepTick(now = new Date())`:**
  1. PENDING with `due_at <= now` → TIMED_OUT + `onReleased` + notify.
  2. For orgs with `AUTO_SINGLE_MATCH`, ask each registered handler for `listUnrouted(orgId)` (add `listUnrouted` to the handler contract) and auto-assign when `resolveCoverageCandidates` returns exactly one candidate covering all hotels, with `autoRouted: true`, skipping subjects where that candidate previously DECLINED or TIMED_OUT.
  - Idempotent; safe under overlap. Use `pg_try_advisory_lock(hashtext('vendor_routing_sweep'))` and skip if not acquired.
- **Routes:**
  - `GET /routing/queue` (admin): unrouted subjects (`listUnrouted` across handlers) plus live and recent assignments, with candidates for each unrouted or declined item.
  - `POST /routing/assign` (admin)
  - `POST /routing/:id/revoke` (admin)
  - `GET /routing/assigned-to-me` (any network entity)
  - `POST /routing/:id/respond`

**Required tests** (use a **fake subject handler** registered under a test-only type — register `'RFQ'` with a fake in this task's test via `registerSubject`, then restore):
1. assign → PENDING, `onPending` called
2. re-assign while PENDING → old REVOKED
3. accept → ACCEPTED; a second assign+accept → the first SUPERSEDED
4. decline without reason → 400; with OTHER and no note → 400
5. a sibling entity responding → 404
6. a non-admin assign → 403
7. an assignee in another org / SUSPENDED / principal → 409
8. sweep times out overdue PENDING and notifies the principal
9. **RFQ due_at capped by bid end:** via the fake handler returning `dueCap = now+2h` and org timeout 24h → `due_at ≈ now+2h`
10. due floor: dueCap in the past → `due_at = now+1h`
11. auto-route assigns only on a single full-coverage candidate and never re-assigns to a decliner
12. concurrent `respond` ACCEPT calls on two PENDING… impossible by index; instead test two concurrent `assign` calls for the same subject → exactly one PENDING remains (`Promise.all`)
13. advisory lock: a second concurrent tick returns `{ skipped:true }`

- [ ] **Steps:** failing tests → implement → pass → commit `feat(vendor-network): routing assignment engine and sweep`.

### Task 9: RFQ subject (routing of RFQ invites, quoting gates, buyer labels)

**Files:**
- Create: `app/services/vendorNetwork/subjects/rfqSubject.js` (registered at module load; import it from `routingEngine.js`'s index or `app/routes/vendorNetwork/vendorNetworkRoutes.js` so it registers in both app and tests)
- Modify: `app/controllers/rfq/rfqController.js` `createQuote` and `updateQuoteItems`, plus the regret path (`grep -n "is_regret" app/controllers/rfq/rfqController.js | head`), the buyer RFQ vendor list and invited-vendor counts, and the buyer quote list (locate via `grep -rn "rpv.user_id\|tbl_rfq_product_vendors" app/models/rfqModel.js | grep -i count`). Change ONLY the buyer-facing count/list queries named in your report.
- Test: `tests/services/vendorNetwork.rfqRouting.test.js`

**Interfaces:**
- Consumes: the routing engine contract (Task 8); RFQ factories in `tests/factories/rfq.js`.
- Produces the handler:
  - **`validateSubject`:** the RFQ is published, its bid end is in the future (IST compare), and the org's principal has `tbl_rfq_product_vendors` rows for it. `dueCap = bid_end − 6h`. Returns the RFQ's hotel ids and category.
  - **`onPending`:** copy the principal's rpv rows for the RFQ to the assignee with `routed_from_vendor_id = principal` (skip rows that already exist).
  - **`onReleased`:** if the assignee has a non-regret quote on the RFQ → throw 409 `QUOTE_SUBMITTED` for REVOKED/SUPERSEDED. For DECLINED/TIMED_OUT a quote cannot exist, because quoting requires ACCEPTED. Otherwise delete the assignee's routed rows (`routed_from_vendor_id IS NOT NULL`).
  - **`listUnrouted`:** published, open RFQs mapped to the principal with no PENDING/ACCEPTED assignment.
- **Quote gates**, applied in `createQuote` and `updateQuoteItems` before any write; a single helper `assertOrgMayQuote(rfqId, vendorId)` in `rfqSubject.js`:
  - (a) If the vendor is a non-principal org entity → it must hold an ACCEPTED RFQ assignment for the RFQ → else 403 `ROUTING_REQUIRED`.
  - (b) If the vendor is the principal and a member holds ACCEPTED → 409 `ROUTED_TO_MEMBER`.
  - (c) If any *other* entity of the same org has a non-regret quote on the RFQ → 409 `ORG_ALREADY_QUOTED`.
  - (d) No-org vendor → no-op.
- **Buyer view:** buyer counts of invited vendors exclude `routed_from_vendor_id IS NOT NULL` rows. Buyer vendor and quote lists add `org_name` (LEFT JOIN `tbl_vendor_org_entities` → `tbl_vendor_orgs` on the vendor id, live entity).

**Required tests** (HTTP where an endpoint exists):
1. Admin routes RFQ → the member can `GET` the RFQ (vendor RFQ detail endpoint) while PENDING, but `createQuote` → 403 ROUTING_REQUIRED.
2. Member accepts → `createQuote` 200 and the quote's `created_by` = member.
3. **One quote per org:** principal then member → 409 ORG_ALREADY_QUOTED (or member then principal → 409 ROUTED_TO_MEMBER).
4. Decline → the member's routed rpv rows are gone and the member's RFQ GET → 403/404 like any unmapped vendor.
5. **Principal can quote after member timed out:** sweep with a past `due_at` → TIMED_OUT → principal `createQuote` 200.
6. Revoke after the member quoted → 409 QUOTE_SUBMITTED.
7. Buyer invited-vendor count unchanged by routing (principal counted once, member row excluded); the buyer vendor list shows `org_name` for both.
8. Buyer finalizes the member's quote → PO `finalized_vendor_id` = member. Use the existing finalize/PO path in tests; reuse helpers from `tests/services/po*.test.js` (grep for a "finalize" helper); if too heavy, assert at the `tbl_quote_finalization.vendor_id` level and note it.
9. Sibling isolation: member C cannot GET the RFQ routed to B.
10. A no-org vendor's quote flow is unchanged (existing rfq quote suites green: `npm test -- --testPathPatterns "tests/services/rfq\.(quote|vendor)"`).

- [ ] **Steps:** failing tests → implement → pass + regression → commit `feat(vendor-network): RFQ routing subject, one-quote-per-org gates, buyer org labels`.

### Task 10: ARC_HOTEL subject (Group ARC per-hotel fulfilment) and member contract view

**Files:**
- Create: `app/services/vendorNetwork/subjects/arcHotelSubject.js`
- Modify: `app/controllers/arc_v2/arcContractController.js` (vendor contract GET around line 553: allow a fulfilment member; filter hotels; add `viewer_role`), `app/services/arcNotificationService.js` (new event `CONTRACT_FULFILMENT_ASSIGNED` with audience = creator + covered-hotel buyers + `EVENT_VENDOR` (principal); follow how `CONTRACT_ACTIVE` resolves buyers at covered hotels), `app/controllers/arc_v2/arcContractController.js` list endpoint (`listForVendor`, model at `app/models/arc_v2/arcContractModel.js:78-80`: include contracts where the vendor holds an ACCEPTED ARC_HOTEL assignment, flagged `viewer_role:'fulfilment_member'`)
- Test: `tests/services/vendorNetwork.arcFulfilment.test.js`

**Interfaces:**
- Consumes: the engine; `tests/helpers/arcGroupSeed.js` (`grantVendorHotelSubs`, `markAsVendors`, …) for building a group ARC with a contract. Read the existing `tests/services/arc*group*` tests and reuse their seeding.
- Produces the handler:
  - **`validateSubject({subjectId: contractId, hotelId})`:** the contract belongs to the org principal (`c.vendor_id = principal`); status IN (`awaiting_acceptance`,`clarification`,`active`,`expiring_soon`); the hotel has a `tbl_arc_contract_line_hotel` row on this contract. Returns `hotelIds:[hotelId]`, `categoryId` = the ARC's category (find the column on `tbl_arc`), no dueCap.
  - **`onAccepted`:** `UPDATE tbl_arc_contract_line_hotel SET fulfilling_vendor_id = assignee WHERE hotel_id = $hotel AND arc_contract_line_id IN (lines of contract)`. Notify `CONTRACT_FULFILMENT_ASSIGNED` with payload `{ hotelId, vendorId: assignee, entityName, gstin, contactName, contactEmail }`. Contact = the first ACTIVE ENTITY_MEMBER person of the entity, else the entity email.
  - **`onReleased(assignment, prior)`:** only when the released assignment had been ACCEPTED (REVOKED from ACCEPTED, or SUPERSEDED) **and** no newer ACCEPTED exists for that hotel → set `fulfilling_vendor_id = NULL` and notify the buyer (`CONTRACT_FULFILMENT_ASSIGNED` with vendor = principal). For SUPERSEDED, `onAccepted` of the new one overwrites, so do nothing.
  - **`listUnrouted`:** contracts of the principal in the statuses above × hotels without PENDING/ACCEPTED.
- **Member contract view:**
  - Allowed when the caller holds an ACCEPTED ARC_HOTEL assignment on the contract.
  - Response `hotels` and `lines[].hotels` are filtered to the assigned hotel ids; `viewer_role: 'fulfilment_member'`.
  - OTP request/verify, decline, clarification, amendment and addendum endpoints stay principal-only. Add explicit tests that they return 403 for the member.

**Required tests:**
1. Principal assigns hotel H1 to branch B → PENDING; B accepts → every line of the contract for H1 has `fulfilling_vendor_id = B`; H2 untouched.
2. A buyer notification row exists for the ARC creator with type `CONTRACT_FULFILMENT_ASSIGNED`.
3. A call-off released for H1 after acceptance (use `releaseForMr` the way existing call-off tests do: `grep -rln releaseForMr tests/`) → `finalized_vendor_id = B`; a call-off for H2 → principal.
4. Reassign H1 to C; C accepts → B SUPERSEDED, lines = C; the earlier PO for B is unchanged.
5. Remove entity C (Task 4 endpoint) → assignment REVOKED, lines NULL, buyer notified.
6. B views the contract → 200, only H1, `viewer_role` set; B OTP request / decline / clarification / amendment request → 403; sibling D (no assignment) → 403.
7. B's vendor PO list/detail endpoints show the call-off PO, and B can accept it (`/po/accept/:po_id`).
8. Assigning a hotel not on the contract → 400; assigning on another vendor's contract → 404.

- [ ] **Steps:** failing tests → implement → pass + `npm test -- --testPathPatterns "tests/services/arc"` → commit `feat(vendor-network): Group ARC per-hotel fulfilment routing and member contract view`.

### Task 11: Supplier details, GST split, contract PDF GSTIN, call-off reminders

**Files:**
- Create: `app/helper/gstState.js`
- Modify: `app/helper/arc_v2/callOffPoRenderer.js` (`loadCallOffPoContext` supplier block, ~128-170; template lines ~60, ~105-108), `app/services/callOffPoService.js` (persist tax split on lines if line tax fields exist; read ~195-245 and `tbl_purchase_order_product` columns in `tests/setup/schema.sql`), `app/controllers/arc_v2/arcContractController.js` (callers at ~506 and ~703 pass the vendor GSTIN), `app/helper/cronManager.js` `startVendorAcceptanceReminderCron` query (~858-914: `LEFT JOIN tbl_rfq` so call-offs are included; make the email copy work without an RFQ number; extract the query to an exported `findPosNeedingVendorReminder(now)` for testability)
- Test: `tests/services/vendorNetwork.callOffGst.test.js`

**Interfaces:**
```js
// gstState.js
export const GST_STATE_CODES = { /* '01':'Jammu and Kashmir' … '38':'Ladakh', '97':'Other Territory' } — full official list */ };
export function stateCodeFromGstin(gstin) // -> '27' | null (validates 15-char format)
export async function stateCodeForHotel(hotelId, runner = db) // hotel.gst -> code; else hotel.state_id -> state_name -> code by name match; else null
export function taxSplitFor(supplierCode, placeCode) // -> 'IGST' | 'CGST_SGST' | null (null if either unknown)
export async function supplierDetailsFor(vendorId, runner = db)
  // -> { name, gstin, address, state_name, state_code } from tbl_company(+gstin) / latest tbl_company_location / tbl_vendor_documents('gst') fallback
```
**Required tests:**
1. `stateCodeFromGstin('27AABCD0971F1ZW') === '27'`; invalid → null.
2. `taxSplitFor('27','27') === 'CGST_SGST'`, `('09','27') === 'IGST'`, `(null,'27') === null`.
3. The call-off PO context for a member in UP (09) delivering to a Maharashtra hotel (gst 27…) → supplier block shows the member's name, GSTIN and state, and `tax_split = 'IGST'`. The rendered HTML (`callOffPoRenderer` exports the HTML builder; find it) contains "IGST" and not "CGST". Same state → "CGST" and "SGST" each at half rate. Unknown → the legacy single "GST" column (assert identical output to before for a no-GSTIN vendor).
4. The contract PDF data for a principal with GSTIN prints it, not "N/A". Unit-test the template data builder at `arcContractController.js:250`; extract it to a named export if it is inline.
5. `findPosNeedingVendorReminder` returns a call-off PO in `acceptance_pending` due for a reminder, and still returns RFQ POs as before.

- [ ] **Steps:** failing tests → implement → pass + `npm test -- --testPathPatterns "tests/services/(po|pdf|arc)"` → commit `feat(vendor-network): fulfilling supplier block, IGST/CGST split, contract GSTIN, call-off reminders`.

### Task 12: Network dashboard API

**Files:**
- Create: `app/controllers/vendorNetwork/dashboardController.js`
- Modify: routes
- Test: `tests/services/vendorNetwork.dashboard.test.js`

**Endpoints** (admin):
- `GET /dashboard/summary`: `{ entities:[{vendor_id,name,relationship,status,seat:{status,end_date}|null, live_assignments, open_pos}], routing:{unrouted, pending, declined_7d, timed_out_7d}, pos:{ by_status:{…} } }`
- `GET /dashboard/pos?entity_vendor_id=&status=&page=&page_size=` over `tbl_rfq_purchase_order` where `finalized_vendor_id = ANY(org ACTIVE + SUSPENDED + REMOVED entity ids)`. Removed entities keep their history.
  - `entity_vendor_id` is validated as an entity of the org (else 404).
  - Paginated, `page_size ≤ 100`.
  - Columns: po id, number, entity name, buyer hotel name, status, amount, created_at, `is_call_off`.
- `GET /dashboard/contracts`: the principal's ARC contracts with per-hotel fulfilment `{ hotel_id, hotel_name, fulfilling_vendor_id, fulfilling_name, assignment_status }`.

**Required tests:**
- Counts are correct across 2 entities.
- The entity filter works; a foreign entity filter → 404.
- A non-admin member → 403.
- A removed entity's POs are still listed.
- `page_size` 500 → clamped to 100.

- [ ] **Steps:** failing tests → implement → pass → commit `feat(vendor-network): HQ network dashboard API`.

### Task 13: FE foundation (service, login persona, entity switcher, nav, accept-invite)

**Work dir:** FE worktree.

**Files:**
- Create: `services/vendorNetwork.js` (one function per BE endpoint from Tasks 3–12, using the same axios instance and export style as `services/arc_v2.js`)
- Create: `components/layout/Header/EntitySwitcher.js`
- Create: `pages/vendor/network/accept-invite.js`
- Modify: `components/landing/LandingAuth.js` (`USER_TYPE_BY_CODE[11] = 'vendor'`)
- Modify: `components/layout/Header/headerConfig.js`:
  - add a vendor "Network" group: Overview `/dashboard/vendor/network`, Entities `/dashboard/vendor/network/entities`, Team `/dashboard/vendor/network/team`, Coverage `/dashboard/vendor/network/coverage`, Routing `/dashboard/vendor/network/routing`, each with `requiresNetworkAdmin: true`;
  - add "Assigned to me" `/dashboard/vendor/network/assigned` with `requiresNetworkMember: true`;
  - extend the visibility function so items are hidden unless `userProfile.network?.role === 'ORG_ADMIN'` (admin items) or `userProfile.network` exists and the acting entity is not the principal (member items);
  - add a "Set up network" item under Account, shown when `!userProfile.network`, linking to `/dashboard/vendor/network`.
- Modify: wherever the header renders the user block (find via `grep -rn "Profile" components/layout/Header/*.js`) to include `EntitySwitcher`.
- Tests: `components/layout/Header/EntitySwitcher.test.js`, `components/layout/Header/headerConfig.network.test.js`, `pages/vendor/network/accept-invite.test.js` (or the repo's test location convention; check where existing `*.test.js` for pages live).

**Behaviour:**
- **EntitySwitcher:** renders only when `userProfile.network?.actable_entities?.length > 1`. Shows "Acting as {entity} · {org}". Selecting calls `switchEntity(id)`, then stores the new token via `utils/storageInstance.js` `token`, refetches `/users/get-profile`, dispatches `setUserProfile`, and does a `router.replace('/dashboard/vendor')`.
- **Accept-invite page:** reads `token`, calls `GET /member-invites/:token`, and shows the org/entity and expired state. Password + confirm form with the same rules as BE (≥ 8, a letter and a digit). Calls accept, then redirects to the login landing with a success toast.
- **Login:** a type-11 user lands on the vendor dashboard.

- [ ] **Steps:**
  1. Write RTL tests: switcher hidden for a single entity; visible and switches for multiple (mock service); nav visibility matrix (no network / admin / member); accept-invite validation and success path.
  2. Run → FAIL.
  3. Implement.
  4. Run → PASS; `npm run build`.
  5. Commit `feat(vendor-network): FE foundation — service, switcher, nav, member invite acceptance`.

### Task 14: FE Network pages (Overview, Entities and seats, Team)

**Files:**
- `pages/dashboard/vendor/network/index.js` (no network → "Set up network" form `POST /org`; admin → dashboard summary tiles + routing counts + the entity table from `GET /dashboard/summary`)
- `pages/dashboard/vendor/network/entities.js` (entity table; "Link existing account" modal with suggestions + email field; "Create branch / distributor" form with GSTIN validation and state/city selects from the lookup endpoints; suspend / reactivate / remove with a confirm; seat badge, and a "Pay for seats" button when any are pending → Razorpay checkout exactly as `components/dashboard/vendor/subscription/*` does it; find the checkout helper there)
- `pages/dashboard/vendor/network/team.js` (people table; invite modal with email, name, role and entity select; disable/enable; resend)
- An incoming link-invite banner component rendered on `pages/dashboard/vendor/index.js` when `GET /link-invites/incoming` is non-empty (accept/decline)
- Components under `components/dashboard/vendor/network/`
- Tests: one RTL test per page covering render from mocked services, the main action call with the correct payload, and the error toast on a 409 with the server `message`.

- [ ] **Steps:** tests → implement → pass → build → commit `feat(vendor-network): network overview, entities & seats, team pages`.

### Task 15: FE Coverage, Routing queue, Assigned-to-me

**Files:**
- `pages/dashboard/vendor/network/coverage.js`: pick an entity, then a rule editor table (scope type, scope picker via the lookup endpoints, include/exclude, optional category), save → `PUT`, preview of covered hotels.
- `pages/dashboard/vendor/network/routing.js`: queue grouped "Needs routing" / "Pending" / "Declined & timed out" / "Recently accepted". Each row shows the subject (RFQ number + hotel(s) + bid end, or contract + hotel), ranked candidates with a "why" (specificity label "Hotel rule"/"City rule"/"State rule"), Assign/Reassign/Revoke, and the decline reason/note display. Routing-mode toggle and timeout field (`PATCH /org`).
- `pages/dashboard/vendor/network/assigned.js`: the member's pending and accepted items. Accept, or Decline with a modal (reason radio + note required for Other). Links to the RFQ detail (existing vendor inquiry detail route) or the contract page.
- Tests: RTL per page: render, assign payload, decline validation (note required for OTHER), accept call.

- [ ] **Steps:** tests → implement → pass → build → commit `feat(vendor-network): coverage editor, routing queue, assigned-to-me`.

### Task 16: FE ARC fulfilment panels, buyer surfaces, PO link fix

**Files:**
- `pages/dashboard/vendor/rate-contracts/[contractId]/accept.js` and `index.js`: a "Fulfilled by" panel per hotel. Admin as principal: select entity → assign (`POST /routing/assign` with `subject_type:'ARC_HOTEL'`); shows assignment status. Member view (`viewer_role === 'fulfilment_member'`): read-only contract, only its hotels, all sign/decline/clarify/amend controls hidden.
- `components/dashboard/vendor/purchase-orders/VendorPoDetail.js:210-212`: link to `/dashboard/vendor/rate-contracts/${callOff.arc_contract_id}`.
- **Buyer:**
  - ARC contract detail (find the buyer contract detail page under `pages/dashboard/buyer/**/rate-contract*` or `arc*`) shows a per-hotel "Fulfilled by" column (from the contract payload; extend the BE buyer contract GET in this task if it lacks `fulfilling_vendor_id`/name — keep the BE change minimal and tested in `tests/services/vendorNetwork.arcFulfilment.test.js`).
  - RFQ vendor list and quote compare show "via {org_name}" when present.
- Tests: RTL for the panel (admin vs member rendering), the link fix, and the buyer label.

- [ ] **Steps:** tests → implement → pass → build (FE) + BE test if touched → commit in each repo `feat(vendor-network): ARC fulfilment panels, buyer fulfilment visibility, call-off link fix`.

### Task 18: Follow-ups from the authz hotfix (single-PR delivery)

**Files:**
- Modify: `app/routes/rfq/rfqRoutes.js` (`/clarification/message`, ~line 920)
- Modify: `app/controllers/rfq/rfqController.js` (`addVendorResponse`)
- Modify: `app/models/rfqModel.js` (`addVendorResponse`, ~12759)
- Test: extend `tests/services/security.vendorOwnershipHotfix.test.js` and `tests/services/security.techEvalVendorResponseAuth.test.js`

**Required behaviour:**
1. **`/rfq/clarification/message`** runs `noLogin.customer_auth` before `clarificationFileUploadHandler`, so anonymous S3 uploads happen before the controller rejects them. Switch it to `passportSignIn`, the same change already made to `/clarification/raise` in commit acae7b23. Check the FE origin/main callers send a JWT. Test: anonymous multipart → 401 and no row; an authenticated owner still works.
2. **Persist disagree reasons.** For each element whose `vendor_response` is `'I Dont Agree'` and has a non-empty trimmed `deviation_text`, insert into `tbl_rfq_product_tech_evaluation_comments` (`tbl_rfq_product_tech_evaluation_clauses_id`, `timestamp now()`, `sender_id` = vendor, `receiver_id` = RFQ owner (the buyer `created_by` on `tbl_rfq`; confirm against how existing chat messages set receiver_id via `grep -n "tbl_rfq_product_tech_evaluation_comments" app/models/rfqModel.js`), `text` = deviation_text).
   - Use the same transaction as the response write.
   - Do not insert a duplicate when an identical text from the same sender already exists as the latest comment on that clause (re-submits).
   - **Tests:** a disagree with text → the comment row exists and `getDeviationPreviews` returns it; an agree with text → no comment; a re-submit of the same text → still one comment.

- [ ] **Steps:** failing tests → implement → pass + `npm test -- --testPathPatterns "tests/services/(security|techEval|rfq\.clarification)"` → commit `fix: persist vendor disagree reasons to clause chat; auth before clarification message upload`.

### Task 17: E2E seed and full verification run

**Files:**
- Create (BE): `scripts/vendor_networks/e2e_seed.mjs`. Seeds a LOCAL dev DB only; refuses to run unless `DATABASE_NAME` matches `/local|dev|test/` and the host is localhost:
  - buyer company + 3 hotels in MH (27), UP (09) and Goa (30), with gst and state ids;
  - principal vendor "Daikin HQ" (MH);
  - branch "Daikin UP" (UP GSTIN);
  - a person (type 11) as ENTITY_MEMBER of Daikin UP;
  - category + subscriptions for the principal;
  - a published RFQ for the UP hotel;
  - a Group ARC contract `awaiting_acceptance` covering MH + UP.
  - Prints all credentials and ids.
- E2E is run by the controller with chrome-devtools MCP or Playwright MCP against local BE (`npm run dev`, port per `.env.development`) + FE (`npm run dev`).

**Scenarios to execute and screenshot:**
1. HQ logs in → Network → links/creates the branch → invites a person.
2. Coverage: Daikin UP covers state UP.
3. Routing queue shows the RFQ with Daikin UP suggested → assign.
4. Person logs in → Assigned to me → Decline (No stock) → HQ sees declined → reassigns → person accepts → quotes.
5. Buyer sees one vendor "via Daikin network" → finalizes → PO reaches Daikin UP.
6. HQ opens the Group ARC accept page → assigns the UP hotel to Daikin UP → signs (OTP shown in non-prod).
7. Person accepts → buyer gets the fulfilment notification.
8. Buyer raises an MR for the UP hotel → call-off PO goes to Daikin UP with IGST (MH contract principal vs UP branch supplying a UP hotel → same state → CGST/SGST; assert whichever matches the seeded states).
9. The person cannot see the MH hotel, nor sign.
10. HQ dashboard lists both POs.

- [ ] **Steps:** write the seed → run it locally → start BE+FE → execute the scenarios → record failures. Each failure becomes a fix dispatch (bug fix + regression test) before the final review.
- [ ] Full suites: BE `npm test` per shard (`tests/shards.json`; run each shard's pattern), FE `npm test` + `npm run build`. All green, output pristine.
