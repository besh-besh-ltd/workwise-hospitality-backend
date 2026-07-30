# WH-67 repair runbook — vendors 832 & 833 stranded with zero RFQs

**Status: NOT EXECUTED. This document describes the repair; nobody has run it.**

Branch: `hotfix/post-deploy-p0`. Incident date: 2026-07-29/30.

---

## 1. What happened

`tbl_rfq.bid_end_date` is a **TEXT** column. Production RFQ id **744**
(`rfq_no` 536286, created by user 322) was published on 2026-07-29 with
`bid_end_date = ''` — an empty string, not `NULL`.

The post-payment vendor backfill query
(`hospitalityModel.getMatchingOpenRfqsForVendor`, behind
`GET /api/v1/hospitality/vendor/matching-open-rfqs`) cast that column with no
guard:

```sql
AND r.bid_end_date::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
```

RFQ 744 satisfies `status = 1 AND is_published = 1`, so the cast was evaluated
on it and **the entire query aborted** with:

```
ERROR: invalid input syntax for type timestamp: ""
```

The endpoint 500'd. The frontend swallowed the failure
(`components/register/PostPaymentFlow.js` wrapped the whole auto-join phase in
`try { … } catch (_) {}`) and fell through to the "You're All Set!" screen. The
vendor got a successful signup and a completely empty dashboard, and nothing
recorded that it had happened.

**Bisect proof:** the query as written → error; with `NULLIF(bid_end_date,'')`
→ 12 RFQs; unmodified but excluding row 744 → the same 12. Row 744 is the sole
poison.

### Code fixes already applied on this branch

| File | Line | Change |
|---|---|---|
| `app/models/hospitalityModel.js` | 2005 | `NULLIF(r.bid_end_date, '')::timestamp` |
| `app/controllers/users/hospitalityController.js` | 3775 | `NULLIF(bid_end_date, '')::timestamp` |
| `frontend/components/register/PostPaymentFlow.js` | 47, 88-117, 273-306 | failure now surfaces `PHASE.RFQ_ERROR` with a Retry button and is reported via `sendLog` (OTel → SigNoz) |

Regression test: `tests/services/vendor.joinOpenRfqs.test.js`.

**Semantics chosen:** `NULLIF` makes an empty deadline **exclude** the RFQ from
auto-join — conservative, we do not auto-join a vendor to an RFQ that has no
deadline. Note this deliberately differs from the vendor *listing* query
(`app/models/rfqModel.js:1935-1940`) which treats `bid_end_date = ''` as
*open*. That inconsistency is intentional and left alone.

---

## 2. Affected vendors

| Vendor id | Email | Matched open RFQs | Actually joined |
|---|---|---|---|
| 832 | `swagat@dhanshreespecialities.in` | 15 (at registration) | 0 |
| 833 | `vectusworld@rediffmail.com` | 1 (at registration) | 0 |

Every vendor registering after 2026-07-29 was affected until the code fix ships.
**Re-run the dry run in §3 before repairing** to pick up anyone else.

---

## 3. Dry run (read-only — safe to run against production)

This is the fixed query verbatim. Run it once per vendor id.

```sql
-- :vendor_id — substitute the vendor's tbl_users.id
WITH vendor_variants AS (
  SELECT product_variant_id
  FROM tbl_product_variant_vendor_mapping
  WHERE vendor_id = :vendor_id AND status = true AND is_approved = true
),
vendor_hotels AS (
  SELECT item_id AS hotel_id
  FROM tbl_vendor_hotel_category_subscription
  WHERE vendor_id = :vendor_id AND item_type = 'hotel' AND status IN ('active','expired')
),
vendor_cats AS (
  SELECT item_id AS category_id
  FROM tbl_vendor_hotel_category_subscription
  WHERE vendor_id = :vendor_id AND item_type = 'category' AND status IN ('active','expired')
),
finalized_products AS (
  SELECT DISTINCT pop.rfq_product_id
  FROM tbl_purchase_order_product pop
  JOIN tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
  WHERE po.status IN ('approved','sent','GRN','completed')
)
SELECT DISTINCT r.id AS rfq_id, r.rfq_no, r.title, r.bid_end_date
FROM tbl_rfq r
JOIN tbl_rfq_products rp ON rp.rfq_id = r.id
JOIN vendor_variants vv ON vv.product_variant_id = rp.product_variant_id
JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
JOIN vendor_cats vc ON vc.category_id = pc.category_id
JOIN tbl_rfq_hotel_mappings rhm ON rhm.rfq_id = r.id
JOIN vendor_hotels vh ON vh.hotel_id = rhm.hotel_id
WHERE r.status = 1 AND r.is_published = 1
  AND NULLIF(r.bid_end_date, '')::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
  AND rp.id NOT IN (SELECT rfq_product_id FROM finalized_products)
  AND NOT EXISTS (
    SELECT 1 FROM tbl_rfq_product_vendors rpv
    WHERE rpv.rfq_id = r.id
      AND rpv.product_variant_id = rp.product_variant_id
      AND rpv.variant = rp.variant
      AND rpv.user_id = :vendor_id
  )
ORDER BY r.id DESC;
```

**Expected as of 2026-07-30 (verified read-only against production):**

| Vendor | RFQs | `tbl_rfq_product_vendors` rows the repair will insert |
|---|---|---|
| 832 | 12 | 70 |
| 833 | 1 | 12 |

Vendor 832 matched 15 RFQs at registration but only 12 now — three have since
closed or been awarded. That is expected and correct; do not force the old 15.

If the counts have drifted by the time you run this, that is fine — the
endpoint is the source of truth, not this table. Just record what you got.

---

## 4. The repair — use the HTTP endpoints, NOT raw SQL

> **Do not `INSERT INTO tbl_rfq_product_vendors` by hand.**
> `hospitalityController.joinOpenRfqs` does three things, and a raw INSERT does
> only the first:
> 1. inserts the `tbl_rfq_product_vendors` rows (via `hospitalityModel.addVendorToRfq`),
> 2. mints a `tbl_vendor_rfq_tokens_non_login` row per RFQ — **without this the
>    vendor's no-login RFQ links are dead**,
> 3. emails the vendor a consolidated invitation and each RFQ creator a
>    "vendor auto-added" notice.
>
> A hand-written INSERT produces snapshot rows with no token and no
> notification: the vendor sees RFQs they were never told about and cannot open
> them from email.

Both endpoints are **idempotent**. `addVendorToRfq` has
`NOT EXISTS (…) … ON CONFLICT DO NOTHING`, and `getMatchingOpenRfqs` excludes
RFQs the vendor is already on. Re-running is safe; a second run returns
`joined_count: 0`.

### 4a. Prerequisite

The code fix must be deployed first. Without it, step 4c 500s on RFQ 744 all
over again, and step 4d 500s the moment a stale poison id is in `rfq_ids`.

### 4b. Authenticate as the vendor

Both routes are `passportSignIn` only — a normal vendor JWT is sufficient; no
admin override exists and none should be added for this.

Preferred: **ask the vendor to log in and complete the flow themselves.** The
retry button added to `PostPaymentFlow` does not help here (they are past
signup), but simply having them visit the site does not re-trigger the backfill
either — the backfill only runs post-payment. So one of:

1. **Password reset (cleanest, no credential handling).** Have support trigger
   the standard forgot-password flow for the vendor, then walk them through
   logging in. With their session live, call the two endpoints from their
   browser devtools console, or have an engineer paste the vendor's `Bearer`
   token (from `localStorage.token`) into the curl calls below. Discard the
   token afterwards; it is short-lived but still a live credential.
2. **Mint a short-lived JWT server-side.** Same signing shape the login route
   uses (`app/middleware/passport.js`, strategy `jwtUsr`): payload needs
   `user: true`, `sub = cryptr.encrypt(String(user_id))`,
   `ag = cryptr.encrypt(user_agent)` where `user_agent` **must equal
   `tbl_users.user_agent` for that row**, and a future `exp`. Signed with
   `JWT_SECRET`, `Cryptr` keyed on `CRYPT_SECRET`. Note the `ag` check means
   you must either reuse the vendor's stored user-agent or update the row —
   updating it **logs the vendor out of their real session**, so prefer reading
   the existing value and sending it as the `User-Agent` header.

Do not reuse an engineer's own token — the endpoints derive the vendor id from
`req.user.id`, so you would join the wrong account.

### 4c. Fetch the matching RFQs

```bash
curl -s "$API_BASE/api/v1/hospitality/vendor/matching-open-rfqs" \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -H "User-Agent: $VENDOR_USER_AGENT" | jq .
```

Expect `{"status":1,"data":{"rfqs":[…]}}`. Compare the ids against §3. If this
returns a 400/500, **stop** — the fix is not deployed.

### 4d. Join them

```bash
curl -s -X POST "$API_BASE/api/v1/hospitality/vendor/join-open-rfqs" \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -H "User-Agent: $VENDOR_USER_AGENT" \
  -H "Content-Type: application/json" \
  -d '{"rfq_ids":[<ids from 4c>]}' | jq .
```

Expect `{"status":1,"message":"Successfully joined N RFQ(s)","data":{…}}`.

Emails go out fire-and-forget via `setImmediate` **after** the response —
a 200 does not prove the mail was sent. Check the mail logs separately.

### 4e. Verify

```sql
SELECT rfq_id, count(*) AS rows
FROM tbl_rfq_product_vendors
WHERE user_id = 832   -- then 833
GROUP BY rfq_id ORDER BY rfq_id;

SELECT rfq_no, token
FROM tbl_vendor_rfq_tokens_non_login
WHERE vendor_id = 832;   -- one row per joined RFQ; NONE means step 4d half-ran
```

Then log in as the vendor and confirm the RFQs appear on
`POST /api/v1/rfq/getMyRfq` / the vendor dashboard.

---

## 5. RFQ 536286 needs a real deadline — business input required

RFQ id 744 / `rfq_no` 536286 is published and active with **no bid end date**.
Under the fix it is silently excluded from every vendor backfill, so vendors
will keep not being auto-joined to it.

**Its creator is user 322. Ask them for the intended `bid_end_date`.**
Do not invent one — a fabricated deadline on a live RFQ changes when vendors
can quote and when the buyer can evaluate.

Once they supply it, set it through the normal RFQ edit UI if the edit window
allows, so change history and notifications fire. A direct UPDATE is a last
resort and should be recorded in the incident ticket.

---

## 6. There are 34 more empty-`bid_end_date` rows (latent)

Read-only check against production on 2026-07-30 found **35** rows total with
`bid_end_date IS NULL OR btrim(bid_end_date) = ''`:

```sql
SELECT id, rfq_no, status, is_published, created_by
FROM tbl_rfq
WHERE bid_end_date IS NULL OR btrim(bid_end_date) = ''
ORDER BY id;
```

Only id **744** has `is_published = 1` — which is why it alone detonated this
query. The other 34 are all `status = 1, is_published = 0`. **They arm the
moment any of them is published.** The code fix on this branch neutralises
them for the two WH-67 queries, but they remain a standing hazard for any
future query that casts this column.

Ids: 401, 407, 413, 421, 437, 440, 443, 449, 454, 510, 514, 518, 520, 531,
542, 563, 570, 577, 586, 594, 610, 616, 625, 637, 654, 660, 669, 676, 712,
714, 740, 742, **744**, 748, 749.

---

## 7. Follow-up: the upstream guard (deliberately NOT in this hotfix)

Publishing an RFQ with an empty `bid_end_date` is what armed this. It was
**not** fixed here. Reasons:

1. **There is no single publish site.** At minimum
   `app/helper/cronManager.js:260` (`publishRfq`, used by the scheduler, the
   watchdog and the manual path) and
   `app/controllers/rfq/rfqController.js:3651` (immediate publish when the
   approval lands after the publish date) both flip
   `status = 1, is_published = 1` independently. A guard in one leaves the
   other open.
2. **A DB `CHECK` constraint cannot be applied today.** 35 existing rows
   violate it. It would need `NOT VALID` plus a data cleanup plus a
   `VALIDATE CONSTRAINT` — three ordered steps, one of which needs the business
   input in §5. That ordering hazard does not belong in a P1 hotfix.
3. Both publish files are owned by other workstreams on this branch.

**Recommended follow-up, in order:**

1. Reject empty/blank `bid_end_date` at RFQ **create/update** validation
   (Joi/celebrate layer) — cheapest, catches new rows at the source.
2. Add a pre-publish assertion in `cronManager.publishRfq` and in the
   post-approval immediate-publish branch: refuse to publish and record a
   lifecycle event rather than publishing a deadline-less RFQ.
3. Backfill the 35 rows (each needs its creator's input, per §5).
4. Then migrate the column: `ALTER TABLE tbl_rfq ALTER COLUMN bid_end_date TYPE
   timestamp USING NULLIF(btrim(bid_end_date),'')::timestamp`, or at minimum add
   `CHECK (bid_end_date IS NULL OR btrim(bid_end_date) <> '')`. Storing a
   timestamp as TEXT is the root cause; everything above is containment.

Grep guard for reviewers — every `bid_end_date` cast in `app/` must be preceded
by either `IS NOT NULL AND != ''` or wrapped in `NULLIF(…, '')`:

```bash
grep -rn "bid_end_date" app/ --include="*.js" | grep -E "::(timestamp|date)|DATE\("
```

As of this branch all remaining sites are guarded (verified 2026-07-30):
`rfqModel.js` 4180 / 13105 / 8427 / 8623 / 8674 / 8697,
`vendorDashboardModel.js` 322 / 338 / 343 / 351,
`dashboardModel.js` 162 / 235 / 845 (JOIN-level) / 1375 / 1442 / 2314 / 2330 /
2354.
