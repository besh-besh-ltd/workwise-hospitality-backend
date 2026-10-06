# Vendor Networks: Design Spec

**Date:** 2026-10-06 · **Status:** Draft for review
**Research:** `docs/investigations/2026-10-05-vendor-networks-research.md`
**Decisions confirmed with product (2026-10-06):**
1. **Commercials:** the parent's subscription covers its whole network. Each billable network member entity needs a paid **seat**.
2. **Buyer involvement:** buyers are **notified** of who fulfils each hotel. They do not approve it.
3. **Routing:** coverage rules suggest a member; the **org admin routes** by default. Members accept or decline with a reason. Declines and timeouts return the work to the admin. Auto-routing on a single match is an opt-in org setting.

**Branches.** BE `feat/vendor-networks` from `origin/qa` (PR → qa); FE `feat/vendor-networks` from `origin/main` (PR → main). The Phase 0 hotfix ships separately on BE `fix/vendor-authz-hotfix`.

---

## 1. Goals

1. One vendor firm appears to buyers as **one supplier**, even if it operates through several branches, distributors and people.
2. An **HQ admin** controls the network: its entities, team logins, coverage, routing, seats and a consolidated view.
3. **Regional members** quote, receive POs, accept, dispatch and invoice under their **own GSTIN** for the locations they serve.
4. **Group ARC:** HQ signs once and assigns per-hotel fulfilment to members. Call-off POs then flow to the assigned member automatically, at the contract rate, with correct GST.
5. **Zero behaviour change** for any vendor that does not set up a network.

### Non-goals (v1)
- Nested networks (a network inside a network).
- Cross-org sharing of an entity.
- Numeric capacity modelling. Accept/decline handles capacity.
- Pincode-level coverage.
- Fine-grained member permissions beyond two roles.
- Workwise admin-panel screens for networks.
- Changing buyer reports to group by org. That is v2; v1 only adds an `org_name` label to buyer vendor surfaces.

## 2. Vocabulary

| Term | Meaning | Stored as |
|---|---|---|
| **Entity** | A billing vendor with its own GSTIN, PAN, address and documents; the PO/quote/contract party | Existing `tbl_users` row, `user_type = 3` (unchanged) |
| **Org (network)** | A group of entities under one HQ | `tbl_vendor_orgs` |
| **Principal** | The HQ entity of an org. Receives invitations and signs contracts | `tbl_vendor_orgs.principal_vendor_id` |
| **Member entity** | A branch, distributor or dealer entity linked into an org | `tbl_vendor_org_entities` |
| **Person** | A human login that acts *on behalf of* an entity | New `tbl_users` row, **`user_type = 11` (VENDOR_MEMBER)**, or an existing entity login acting as itself |
| **Acting entity** | The entity a request runs as | JWT claim `ent` (encrypted), verified on every request |
| **Seat** | Paid right for a non-principal entity to operate in the network | `tbl_vendor_network_seats` row (own table — NOT the subscription table, whose readers count any active row as "subscribed") |

**Why entities stay `tbl_users` rows.** All 26 `vendor_id` tables, about 400 predicates and every ownership check already treat the vendor user id as "the vendor".
- Keeping the entity as that id means POs, quotes and contracts addressed to a member entity work with no rewrites.
- The acting-entity context makes `req.user` **be the entity**. The human is recorded separately for audit.

## 3. Data model

Everything below is in one migration: `migrations/20261006100000_vendor_networks.sql`, plus a `.down.sql`. It is listed in `tests/setup/pendingMigrations.json`.

```sql
tbl_vendor_orgs(
  id SERIAL PK,
  name TEXT NOT NULL,
  principal_vendor_id INT NOT NULL UNIQUE REFERENCES tbl_users(id),
  routing_mode TEXT NOT NULL DEFAULT 'ADMIN_ROUTES'
    CHECK (routing_mode IN ('ADMIN_ROUTES','AUTO_SINGLE_MATCH')),
  routing_timeout_hours INT NOT NULL DEFAULT 24 CHECK (routing_timeout_hours BETWEEN 1 AND 168),
  created_by INT REFERENCES tbl_users(id), created_at, updated_at)

tbl_vendor_org_entities(
  id SERIAL PK, org_id INT NOT NULL REFERENCES tbl_vendor_orgs(id),
  vendor_id INT NOT NULL REFERENCES tbl_users(id),
  relationship TEXT NOT NULL CHECK (relationship IN ('PRINCIPAL','BRANCH','DISTRIBUTOR','DEALER')),
  status TEXT NOT NULL CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','REMOVED')),
  preference_rank INT NOT NULL DEFAULT 100,
  invited_by INT, linked_at TIMESTAMPTZ, removed_at TIMESTAMPTZ, created_at, updated_at)
  -- an entity is live in at most one org at a time:
  UNIQUE INDEX ON (vendor_id) WHERE status <> 'REMOVED'
  -- exactly one principal per org:
  UNIQUE INDEX ON (org_id) WHERE relationship = 'PRINCIPAL' AND status <> 'REMOVED'

tbl_vendor_org_link_invites(        -- consent for linking an EXISTING account
  id SERIAL PK, org_id INT NOT NULL, target_vendor_id INT NOT NULL REFERENCES tbl_users(id),
  relationship TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','CANCELLED')),
  expires_at TIMESTAMPTZ NOT NULL, created_by INT NOT NULL, acted_at TIMESTAMPTZ, created_at)

tbl_vendor_org_members(             -- persons -> entities
  id SERIAL PK, org_id INT NOT NULL, person_user_id INT NOT NULL REFERENCES tbl_users(id),
  entity_vendor_id INT NULL REFERENCES tbl_users(id),   -- NULL only for ORG_ADMIN (org-wide)
  role TEXT NOT NULL CHECK (role IN ('ORG_ADMIN','ENTITY_MEMBER')),
  status TEXT NOT NULL CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  invite_token_hash TEXT UNIQUE, invite_expires_at TIMESTAMPTZ,
  invited_by INT, created_at, updated_at,
  CHECK ((role = 'ORG_ADMIN') = (entity_vendor_id IS NULL)))
  UNIQUE INDEX ON (person_user_id, COALESCE(entity_vendor_id,0)) WHERE status <> 'DISABLED'

tbl_vendor_coverage_rules(
  id SERIAL PK, entity_vendor_id INT NOT NULL REFERENCES tbl_users(id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('STATE','CITY','HOTEL')),
  scope_id INT NOT NULL,              -- tbl_location_states.id | tbl_location_cities.id | tbl_hospitality_company_hotels.id
  mode TEXT NOT NULL CHECK (mode IN ('INCLUDE','EXCLUDE')),
  category_id INT NULL,               -- NULL = all categories
  created_by INT, created_at)
  UNIQUE INDEX ON (entity_vendor_id, scope_type, scope_id, COALESCE(category_id,0))

tbl_vendor_routing_assignments(
  id SERIAL PK, org_id INT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('RFQ','ARC_HOTEL')),
  subject_id INT NOT NULL,            -- rfq_id | arc_contract_id
  hotel_id INT NULL,                  -- required for ARC_HOTEL
  assigned_vendor_id INT NOT NULL REFERENCES tbl_users(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','DECLINED','TIMED_OUT','REVOKED','SUPERSEDED')),
  decline_reason TEXT CHECK (decline_reason IN ('NO_STOCK','CANNOT_MEET_DEADLINE','OUT_OF_AREA','OTHER')),
  decline_note TEXT, due_at TIMESTAMPTZ, auto_routed BOOLEAN NOT NULL DEFAULT false,
  assigned_by_user_id INT, acted_by_user_id INT, created_at, acted_at)
  -- at most one PENDING and at most one ACCEPTED per org+subject+hotel (several orgs may route the same RFQ):
  UNIQUE INDEX ON (org_id, subject_type, subject_id, COALESCE(hotel_id,0)) WHERE status = 'PENDING'
  UNIQUE INDEX ON (org_id, subject_type, subject_id, COALESCE(hotel_id,0)) WHERE status = 'ACCEPTED'

ALTER tbl_hospitality_company_hotels ADD state_id INT NULL REFERENCES tbl_location_states(id),
                                     ADD city_id  INT NULL REFERENCES tbl_location_cities(id);
ALTER tbl_rfq_product_vendors ADD routed_from_vendor_id INT NULL;   -- set on rows added by routing
tbl_vendor_network_seats(
  id SERIAL PK, org_id INT NOT NULL REFERENCES tbl_vendor_orgs(id),
  entity_vendor_id INT NOT NULL REFERENCES tbl_users(id),
  fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0, start_date DATE NOT NULL, end_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','expired','cancelled')),
  payment_id INT NULL REFERENCES tbl_vendor_payments(id) ON DELETE SET NULL, created_at, updated_at)
  UNIQUE INDEX ON (entity_vendor_id, end_date) WHERE status IN ('pending','active')
```

**Hotel location backfill**
- Inside the migration: match `state` text to `tbl_location_states` (India, `country_id = 1`), then match `city` text within that state.
- A shared resolver `resolveHotelLocationIds(stateText, cityText)` keeps the id columns in sync from then on. It is called on every hotel create/update, so frontend forms need no change.
- Unmatched hotels stay NULL and are reported by `scripts/vendor_networks/hotel_location_report.mjs`. On prod that is 6 cities and 2 address-less hotels.
- A hotel with NULL `city_id` is matched by STATE and HOTEL rules only.

## 4. Identity and the acting-entity context

### 4.1 Token and `jwtUsr`
- `signAccessTokenUser` gains an optional `ent` claim (encrypted, like `sub`).
- `jwtUsr` loads the **person** row from `sub` and checks `ag` against the **person's** `user_agent`, as today.
- If the person's `user_type` is 3 or 11, it then runs one indexed query, `resolveActingContext(personId, entClaim)`:

| Person | `ent` absent | `ent` present |
|---|---|---|
| user_type 3, in no org | acts as self (**identical to today**) | must equal self, otherwise 401 |
| user_type 3, principal of org | acts as self, `role = ORG_ADMIN` | self, or any ACTIVE entity of the org |
| user_type 3, member entity | acts as self, `role = ENTITY_MEMBER` | must equal self |
| user_type 11 | its ORG_ADMIN → principal; else its single ENTITY_MEMBER entity; else the lowest-id one | an entity it holds an ACTIVE membership for (ORG_ADMIN: any ACTIVE entity of the org) |

- **Validity is re-checked on every request.** The entity must be `status = 1`, not deleted, and not SUSPENDED/REMOVED in the org. The membership must be ACTIVE. So disabling a person or removing an entity takes effect on the next request.
- `req.user` becomes `{ ...entityRow, network: { org_id, org_name, role, actor_user_id, actor_name, acting_entity_id, is_principal } }`. `network` is `undefined` for non-network vendors.
- A `user_type 11` person can **never** run as itself.
- `POST /api/v1/vendor-network/switch-entity {entity_vendor_id}` verifies through the same resolver and returns a fresh token with `ent`.
- Emailed-link (`vendorTokenOrJwt`) and guest tokens stay entity-scoped as today.

### 4.2 Login
- `localUsr` allows email login for `user_type 11`, the same as vendors.
- An INVITED member (status 0) cannot log in until the invite is accepted.
- An entity row with no password (a new branch created by an admin) cannot be logged into directly; people act for it through memberships.
- The login response persona is `vendor`.

### 4.3 Audit
- `resolveActor` uses `user.network.actor_user_id` / `actor_name` when present: `actorUserId = person`, `actorLabel = "Person (Entity)"`.
- `app.actor_id` (row-change audit) therefore records the person.
- Business columns (`created_by`, `finalized_vendor_id`) record the entity. That is intended.

### 4.4 Notifications
- In-app notifications and sockets are addressed to the entity id.
- `get-profile` returns the acting entity, so the frontend socket joins `user:<entityId>`. Every person acting as that entity shares its inbox with no fan-out code.
- Routing emails also go to the members' own email addresses.

## 5. Org, entities, people, seats

All endpoints are under `/api/v1/vendor-network/*`, `acl([3])`. Scope always comes from `req.user`, never from the body (see `feedback_security_first`). Admin endpoints require `req.user.network.role === 'ORG_ADMIN'`.

| Capability | Endpoint(s) | Rules |
|---|---|---|
| Create network | `POST /org` | Caller is an active entity in no org. Creates the org, a PRINCIPAL entity row and an ORG_ADMIN membership for the caller |
| Get network | `GET /org` | Org, entities with seat status, people, settings |
| Settings | `PATCH /org` | `name`, `routing_mode`, `routing_timeout_hours` |
| Suggested links | `GET /entities/suggestions` | Active vendors sharing the principal's PAN (from GSTIN chars 3-12 or the PAN document), not already in an org |
| Link existing account | `POST /entities/link-invites {target_vendor_id or target_email, relationship}` | Target must be active, in no org, not a principal. Creates a 7-day invite and notifies the target entity |
| Respond to link | `POST /link-invites/:token/accept\|decline` (target entity) | Accept → entity ACTIVE. If a seat is needed and unpaid, the entity is ACTIVE but **cannot operate** until the seat is active (§5.1) |
| Create new branch/distributor | `POST /entities {company_name, gstin, email, state_id, city_id, address, relationship}` | Creates `tbl_company` + `tbl_users` (type 3, status 1, no password) + `tbl_company_location`. GSTIN is validated by format and must be unique among active vendors |
| Suspend / reactivate / remove | `PATCH /entities/:vendorId`, `DELETE /entities/:vendorId` | Removing revokes live assignments (§6). Existing POs stay with the entity. The principal cannot be removed |
| People | `POST /members {email, name, role, entity_vendor_id?}`, `PATCH /members/:id`, `POST /members/:id/resend` | Creates a `user_type 11` user (status 0) and a 72h invite token, emailed. The email must not exist in `tbl_users`. Limit `NETWORK_MAX_PERSONS` (default 25) |
| Accept member invite | `POST /api/v1/vendor-network/member-invites/accept {token, password}` (public) | Sets password, user status 1, membership ACTIVE |
| Leave network (member entity) | `POST /entities/self/leave` | Same effects as remove |

### 5.1 Seats (product decision "c")
- Every non-principal entity needs an active `network_seat` to **operate**. "Operate" means: be assigned work, quote as itself, accept a routing assignment.
- POs already addressed to an entity whose seat lapsed stay actionable (accept, dispatch, invoice), so buyers are never stranded.
- **Fee:** `NETWORK_SEAT_FEE_INR` (config; **default 0**). At 0, seats activate free on link or create. Above 0, the seat is created `pending` and the admin pays through the existing Razorpay order/verify pattern (`tbl_vendor_payments.payment_type = 'network_seat'`); verify flips the seat to `active`.
- Seats end at financial-year end, like other subscription items. Renewal uses the existing flow.
- Persons are free (charging per login would push teams back to sharing passwords). This is capped by `NETWORK_MAX_PERSONS`.

### 5.2 Subscription coverage ("the parent's subscription covers the network")
- `subscriptionHolderIdsFor(vendorId)`: for an entity in an org, returns all ACTIVE entities of the org; otherwise returns `[vendorId]`.
- Every subscription and eligibility check routes through it:
  - `hasValidPaidSubscription`
  - `requireActiveSubscription`
  - `getEligibleVendorsForVariant`
  - `resolveArcVendorCoverage`
  - `vendorCanSubmitForHotels`
  - `getMatchingOpenRfqsForVendor`
- **The org is eligible if any of its ACTIVE entities holds the subscription.** The **invite always goes to the principal**. Linked legacy accounts that are independently eligible collapse into the principal, which removes duplicate invites (the Otis/Daikin case).
- A non-principal entity additionally needs an active seat.

## 6. Coverage and routing

### 6.1 Coverage resolver
`resolveCoverageCandidates({ orgId, hotelIds, categoryId })` → ranked list of `{ entity_vendor_id, specificity, preference_rank, covers_all_hotels, hotels_covered[] }`.
- **Per entity and hotel, the most specific matching rule decides.** HOTEL (3) beats CITY (2), which beats STATE (1).
  - Rules with a matching `category_id` beat category-NULL rules at the same specificity.
  - At equal footing, EXCLUDE wins.
- No matching rule means not covered.
- Only ACTIVE entities with an active seat are candidates. The principal is never a candidate; it is the fallback.
- **Ranking:** covers all hotels desc, specificity desc, preference_rank asc, vendor_id asc.

### 6.2 Assignment lifecycle (one engine, two subject types)
```
assign (admin, or auto) ─▶ PENDING ──accept──▶ ACCEPTED ──(reassign accepted)──▶ SUPERSEDED
                             │  ├─decline(reason)─▶ DECLINED   ─┐
                             │  ├─due_at passed ──▶ TIMED_OUT  ─┼─▶ admin notified; subject back in admin queue;
                             │  └─admin revoke ───▶ REVOKED    ─┘   suggestions exclude decliners for this subject
```
- **Assign:** only by ORG_ADMIN acting in the org. The target must be an ACTIVE entity of the same org with an active seat, not the principal.
  - Re-assigning while a PENDING exists → the old one becomes REVOKED.
  - While an ACCEPTED exists, the new PENDING runs alongside it. When the new one is accepted, the old one becomes SUPERSEDED.
- **Accept / decline:** only by the assigned entity (any person acting as it).
  - Decline requires a reason; the note is required when the reason is OTHER.
  - Notification `NETWORK_ROUTING_DECLINED` / `_TIMED_OUT` goes to the principal.
- **`due_at`:** `now + routing_timeout_hours`. For RFQs it is capped at `bid_end_date − 6h`, and never earlier than `now + 1h`.
- **Sweep cron** (every 15 min, `cronManager`):
  - times out overdue PENDING rows;
  - for `AUTO_SINGLE_MATCH` orgs, auto-assigns unrouted principal RFQ invites and new ARC contract hotels that have exactly one candidate.
- Each transition writes a `tbl_activity_events` row attributed to the person.

### 6.3 RFQ subject
- **The admin's inbox lists:** RFQs the principal is mapped to that are still open for quoting, plus their routing state and suggestions. Suggestions use the RFQ's hotels and category.
- **On PENDING:** the member entity gets copies of the principal's `tbl_rfq_product_vendors` rows with `routed_from_vendor_id = principal`, so it can view and decide.
- **Quoting requires an ACCEPTED assignment for the member.** The member quotes as itself (its GSTIN), so a won PO's `finalized_vendor_id` is the member.
- **One quote per org per RFQ.** Quote create/submit rejects with 409 if another entity of the same org holds a non-regret quote on the RFQ. While a member holds ACCEPTED, the principal is blocked from quoting; otherwise the principal can quote directly at any time.
- **On DECLINED / TIMED_OUT / REVOKED:** if the member has no quote, its routed rows are deleted. Revoking is blocked once the member has submitted a quote; the member must regret first.
- **Buyer view:** buyer counts of invited vendors exclude `routed_from_vendor_id IS NOT NULL` rows. Buyer vendor/quote lists show the entity with an `org_name` label.

### 6.4 ARC_HOTEL subject (Group ARC; single-hotel ARC uses the same path with one hotel)
- **Where:** the contract accept page (`awaiting_acceptance`) and the active contract page have a per-hotel "Fulfilled by" panel. Only the ORG_ADMIN acting as the principal (the contract vendor) can use it.
- **Signing is not blocked** by pending assignments.
- **On ACCEPTED:** `tbl_arc_contract_line_hotel.fulfilling_vendor_id = member` for every line of that contract × hotel, in the same transaction. Event `CONTRACT_FULFILMENT_ASSIGNED` goes to the ARC creator, the covered hotel's buyers and the principal, with entity name, GSTIN and contact.
- **On DECLINED / TIMED_OUT / REVOKED of an assignment that was never accepted:** nothing changes on the contract.
- **Removing an entity or revoking an ACCEPTED assignment:** `fulfilling_vendor_id` resets to NULL (the principal fulfils) and the buyer is notified.
- **Reassignment:** in-flight POs keep their vendor. Only call-offs released after the new ACCEPTED go to the new member.
- **Member visibility:** `GET /arc-v2/vendor/contracts/:id` is allowed for an entity holding an ACCEPTED ARC_HOTEL assignment on the contract.
  - The response is filtered to its hotels and flagged `viewer_role: 'fulfilment_member'`.
  - Sign, decline, clarify, amend and addendum stay principal-only.
- **Call-off POs:** routing already works through `COALESCE(clh.fulfilling_vendor_id, c.vendor_id)`. Changes:
  - The PO and PDF supplier block shows the fulfilling entity's company name, GSTIN, address and state.
  - **GST split:** supplier state code (GSTIN chars 1-2) vs place of supply (hotel GSTIN chars 1-2, else hotel `state_id` → GST state code map) → `IGST` if they differ, `CGST+SGST` if they match. If either side is unknown, fall back to today's single "GST" column.
  - The contract PDF prints the principal GSTIN, fixing the always-"N/A" bug.

## 7. Group ARC and PO fixes bundled with this work
1. Call-off POs are included in the vendor acceptance reminder cron (it inner-joins `tbl_rfq` today).
2. FE `VendorPoDetail.js:210` links to the contract id instead of the arc id.
3. Contract PDF vendor GSTIN (see above).

## 8. Network dashboard (HQ)
Read-only aggregates across the org's ACTIVE entities, ORG_ADMIN only:
- Entities with seat status and live assignment counts.
- The routing queue (unrouted, pending, declined, timed out).
- POs across entities: counts by status, plus a list with an entity filter.
- Contracts with their per-hotel fulfilment map.

**Acting on a member's item:** the "Act as" action switches entity (`switch-entity`) and deep-links. The ownership checks themselves are not widened.

## 9. Frontend

All new UI uses the `styles/arc_v2.css` tokens (see `feedback_arc_v2_styling`).
- **Header entity switcher:** "Acting as {entity} · {org}", shown only when a person can act for more than one entity.
- **Vendor nav "Network" group, ORG_ADMIN only:** Overview, Entities & Seats, Team, Coverage, Routing.
- **Vendor nav "Assigned to me", any network member entity:** pending RFQ and ARC hotel assignments with Accept / Decline (reason modal).
- **Pages:** `pages/dashboard/vendor/network/{index,entities,team,coverage,routing,assigned}.js`, plus public `pages/vendor/network/accept-invite.js`.
- **Link-invite banner** on the target entity's vendor dashboard.
- **ARC vendor accept and contract pages:** "Fulfilled by" panel per hotel. The contract page has a read-only member view.
- **Buyer:** `org_name` label in RFQ vendor and quote lists. ARC contract detail shows the fulfilment map.
- **Login:** accept `user_type 11`, persona vendor.

## 10. Security invariants (each one gets a test)
1. A vendor without a network behaves exactly as before: same `req.user`, same responses.
2. A tampered or foreign `ent` claim → 401. A `user_type 11` person never runs as itself.
3. A disabled person, removed entity, or deleted org loses access on the next request. A SUSPENDED entity loses all network operation on the next request: no assignments, no member quoting, and nobody else can act for it. Its own login still reaches its existing POs (§5.1).
4. A member of entity A cannot read or act on entity B's RFQs, quotes, POs or contracts (sibling isolation).
5. Only ORG_ADMIN can manage the org, entities, people, coverage, routing, seats and the dashboard. No tenant ids are accepted from the body.
6. Linking an existing account requires that account's consent. An entity belongs to at most one org. No nesting: a principal cannot be linked.
7. Assignments go only to ACTIVE, seated, same-org entities. Only the assignee accepts or declines.
8. One quote per org per RFQ. A member quotes only with an ACCEPTED assignment.
9. A fulfilment member can view, but not sign, decline, clarify or amend, the principal's contract.
10. Every routing and admin action is attributed to the person.

## 11. Phases
- **Phase 0 (hotfix branch):**
  - P0: unauthenticated tech-eval response write/read with `vendor_id` taken from the body.
  - `requestAmendment` ownership check.
  - `/add-spoc` and the vendor location endpoints: ownership.
  - `raiseClarification` mapping check.
- **Phase 1 (identity):** migration; acting-entity context; login; audit; org, entity, member and seat endpoints; subscription holder resolution; profile and switcher frontend; Network pages (Overview, Entities, Team).
- **Phase 2 (coverage and routing):** hotel location ids and backfill; coverage rules and resolver; assignment engine and sweep cron; RFQ routing and one-quote-per-org; Coverage, Routing and Assigned-to-me pages; buyer labels.
- **Phase 3 (Group ARC fulfilment):** ARC_HOTEL subject; contract member view; call-off supplier block and GST split; contract PDF GSTIN; call-off reminders; FE link fix; fulfilment panels; dashboard POs and contracts.
- **Phase 4 (verification):**
  - full backend suite;
  - frontend tests and build;
  - Playwright/chrome-devtools E2E against local BE+FE: HQ creates network → links a branch → invites a person → sets coverage → routes an RFQ → member declines → admin reroutes → member quotes → buyer awards → PO reaches member; and Group ARC accept → assign hotels → call-off PO reaches member with IGST/CGST correct.

## 12. Testing approach
- Follow `tests/CONVENTIONS.md`: call production functions and drive HTTP through `httpClient`, against real Postgres. Product-level assertions (`feedback_product_level_tests`).
- Every §10 invariant has a negative test.
- Run with `npm test` (`feedback_use_npm_test`).
- Each new test file is registered in `tests/shards.json`.
- Mutation check on critical guards: temporarily remove the guard, confirm the test fails, restore.
