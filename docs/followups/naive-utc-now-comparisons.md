# Follow-up: naive-UTC columns compared against bare `NOW()`

**Status:** open. Dormant in production, wrong on any non-UTC Postgres session.
**Found:** 2026-08-20, while diagnosing three `arc.negotiation.expiry` failures.
**Do not bundle into a feature or performance branch** — it spans negotiation, RFQ,
quote-comparison, dashboard and ARC queries and wants its own PR and full suite run.

## What is wrong

A set of columns are `timestamp without time zone` holding **UTC** — the contract is
written down in `app/helper/dbTime.js`, and the application reads them back with
`parseAsUTC()`. The columns include `tbl_negotiation_rounds.end_date`, `closed_at`,
`approved_at` and `published_at`.

`NOW()` is a `timestamptz`. Whenever one of these naive columns meets `NOW()`, Postgres
resolves the naive side through the **session timezone**:

| session | `end_date > NOW()` for a round 1h in the future |
|---------|--------------------------------------------------|
| `UTC` (CI + production) | `true` — correct |
| `Asia/Kolkata` (a Homebrew dev box) | `false` — **5h30m wrong, in the releasing direction** |

Reproduce:

```sql
SET timezone='Asia/Kolkata';
WITH t(end_date) AS (VALUES (now() AT TIME ZONE 'UTC' + interval '1 hour'))
SELECT end_date > NOW()                        AS bare_now,     -- false  (wrong)
       end_date > (NOW() AT TIME ZONE 'UTC')   AS fixed          -- true   (right)
FROM t;
```

This affects **writes as well as reads**. `SET closed_at = NOW()` on a naive column
stores session-local digits, so a non-UTC session writes a value that `parseAsUTC()`
will later misread — the row is corrupted at rest, not just misqueried.

## Why it is dormant

Production and CI both run a UTC session (`ci-tests.yml` exports
`PGOPTIONS='-c timezone=UTC'`), where the two forms are provably identical. Local runs
are now pinned to UTC too (`tests/setup/jestEnv.js`), which is why the suite is green.

That pin is a mask, not a fix. The exposure is real the moment anything runs against a
non-UTC session — a psql session, a BI or reporting tool, a restored snapshot on a
developer machine, an RDS parameter-group change, or a future region.

## The fix

Replace bare `NOW()` with `(NOW() AT TIME ZONE 'UTC')` at each site below. It is a
**provable no-op under a UTC session**, so production behaviour cannot change.

Roughly 20 sites already use the correct idiom — this cleanup was started and never
finished, which is why the codebase currently disagrees with itself. `git grep "AT TIME
ZONE 'UTC'"` shows the correct side.

### Do NOT convert

- `tbl_rfq.bid_end_date`, `tender_publish_date`, `vendor_clarification_date` and the ARC
  submission window store **naive IST**, not UTC. They go through `getBidEndMomentIst`
  in `app/helper/quoteVisibility.js`; feeding one to the UTC treatment shifts it 5h30m
  the other way. See `reference_arc_ist_timezone`.
- `tbl_arc` window columns in test seeds — different contract, whole-day offsets.

## How to verify the fix

Run the whole suite under both zones; both must be green:

```bash
npm test                                              # pinned UTC
PGOPTIONS="-c timezone=Asia/Kolkata" npm test         # must also pass
```

`tests/services/arc_v2/arc.negotiation.expiry.test.js` — "Regression guard: RFQ
getRoundsForReschedule does NOT return ARC rounds" — is the canary. It fails today under
the IST override and must pass once this is done.

## Sites (40)

    app/models/vendorDashboardModel.js:522 |         AND nr.end_date > NOW()
    app/models/dashboardModel.js:2181 |          AND nr.end_date > NOW()
    app/models/dashboardModel.js:2262 |             : `(first_round.closed_at IS NULL OR (first_round.closed_at >= NOW() - INTERVAL '${intervalEnd}' AND f
    app/models/generalModel.js:4086 |         SET status = 'CANCELLED', closed_at = NOW()
    app/models/generalModel.js:4100 |         SET status = 'COMPLETED', closed_at = COALESCE(closed_at, NOW())
    app/models/negotiationModel.js:2974 |     const endDateFilter = includeEnded ? '' : `AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())`;
    app/models/negotiationModel.js:3975 |         AND nr.end_date > NOW()
    app/models/negotiationModel.js:3999 |         AND nr.end_date <= NOW()
    app/models/negotiationModel.js:4051 |          AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())
    app/models/negotiationModel.js:4108 |            AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())
    app/models/rfqModel.js:4433 |           AND end_date > NOW()
    app/models/rfqModel.js:7447 |             'status', CASE WHEN NR.status = 'ACTIVE' AND NR.end_date <= NOW() THEN 'ENDED' ELSE NR.status END, 'end_date
    app/models/rfqModel.js:7501 |                   AND (ANR.status != 'ACTIVE' OR ANR.end_date > NOW())
    app/models/rfqModel.js:7505 |                 SELECT json_build_object('round_id', ANR2.id, 'round_number', ANR2.round_number, 'status', CASE WHEN ANR
    app/models/rfqModel.js:14100 |               AND _nr_act.end_date > NOW()
    app/models/rfqModel.js:14236 |                 OR (_nr_exp.status = 'ACTIVE' AND _nr_exp.end_date <= NOW())
    app/models/rfqModel.js:15067 |               closed_at = NOW(),
    app/models/rfqModel.js:15322 |             closed_at = NOW()
    app/models/arc_v2/arcModel.js:287 |                      AND nr.end_date > NOW()
    app/models/arc_v2/arcNegotiationModel.js:150 |             AND nr.end_date > NOW()
    app/models/arc_v2/arcNegotiationModel.js:168 |           AND nr.end_date > NOW()
    app/models/arc_v2/arcNegotiationModel.js:384 |           AND end_date > NOW()
    app/models/arc_v2/arcNegotiationModel.js:396 |           AND end_date <= NOW()
    app/models/arc_v2/arcLifecycleModel.js:501 |         AND end_date > NOW()
    app/models/quoteCompareViewModel.js:1670 |               CASE WHEN status = 'ACTIVE' AND end_date <= NOW() THEN 'ENDED' ELSE status END AS status
    app/models/quoteCompareViewModel.js:2144 |       `SELECT CASE WHEN status = 'ACTIVE' AND end_date <= NOW() THEN 'ENDED' ELSE status END AS status,
    app/controllers/rfq/rfqController.js:5387 |         AND end_date > NOW()`,
    app/controllers/rfq/rfqController.js:9414 |              WHERE nr.rfq_id = $1 AND nr.status = 'ACTIVE' AND nr.end_date > NOW()`,
    app/controllers/rfq/rfqController.js:10087 |                        AND nr.end_date > NOW()
    app/controllers/rfq/rfqController.js:10730 |               SET status = 'CANCELLED', closed_at = NOW()
    app/controllers/rfq/rfqController.js:15088 |              WHERE nr.rfq_id = $1 AND nr.status = 'ACTIVE' AND nr.end_date > NOW()`,
    app/controllers/rfq/rfqController.js:15618 |                  AND nr.end_date > NOW()
    app/controllers/negotiation/negotiationController.js:325 |             approved_at = NOW(),
    app/controllers/negotiation/negotiationController.js:326 |             published_at = NOW(),
    app/controllers/negotiation/negotiationController.js:1198 |              SET status = 'ACTIVE', approved_at = NOW(), published_at = NOW()
    app/controllers/negotiation/negotiationController.js:1935 |                   closed_at = NOW(), updated_at = NOW()
    app/helper/cronManager.js:948 |               SET status = 'EXPIRED', closed_at = NOW(), updated_at = NOW()
    app/helper/cronManager.js:1041 |             SET status = 'ENDED', closed_at = NOW(), updated_at = NOW()
    app/helper/cronManager.js:1284 |           `UPDATE tbl_negotiation_rounds SET status = 'EXPIRED', closed_at = NOW(), updated_at = NOW() WHERE id = $1`
    app/helper/cronManager.js:1325 |           `UPDATE tbl_negotiation_rounds SET status = 'ENDED', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
