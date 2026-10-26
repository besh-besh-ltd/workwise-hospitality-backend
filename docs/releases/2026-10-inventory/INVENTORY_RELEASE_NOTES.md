# Inventory module: release notes (October 2026)

Backend and frontend branch `feat/inventory-management`. The design
(`2026-10-23-inventory-management-design.md`) and plan
(`2026-10-24-inventory-management.md`) are in the workspace's
`docs/superpowers/`, not in this repository.

## What it does

The module covers what happens after a PO is issued. It is not a full ERP.

- **Delivery plan.** A PO is split across hotels and phases on its
  Deliveries tab. Each hotel receives its own share. A multi-hotel PO has no
  per-hotel quantity until the buyer splits it.
- **Vendor dispatch notes.** The vendor records what is on the truck, for
  which hotel and phase, with the challan, e-way bill and vehicle. A retry
  with the same key never creates a second note.
- **Receiving (GRN), by scan.** Supported codes are GS1-128, EAN/UPC, our
  printed item QR and dispatch-note QR. Quantities are line-level, with
  accepted/rejected split, a reason, batch and expiry. Partial deliveries
  keep the balance open. The buyer short-closes it with a reason, and can
  reopen it.
- **Site-rep link.** A no-login receiving page for one PO at one hotel. It
  shows no prices.
- **Offline.** Receipts, mark-outs and count saves queue on the device and
  send in order when the connection returns.
- **Stock per hotel.** One pool per hotel, valued at weighted-average cost
  (4 dp). The ledger is append-only.
- **Mark-out to a department.** Scan, enter the qty, pick the department
  ("kitchen asks for 100 kg paneer").
- **Returns.** Returns to vendor (replacement or credit) and GRN reversals.
- **Stock tools.** Adjustments (with approval), stock counts (full or spot,
  optionally blind), reorder worklist → MR draft, and labels.
- **Ten inventory reports.** They are listed under Reports, permission
  `reports.<key>`.
- **Who can do what.** Two new system roles, **Storekeeper** and **Inventory
  Controller**, plus resources `grn` and `inventory` in the role editor. It
  is available to every company through roles, with no entitlement flag.

## Deploy order: MIGRATE BEFORE DEPLOY

The new PO PDF and approval code reads `tbl_po_delivery`. Deploying the
backend before the migrations breaks PO approvals.

1. **Pre-checks**, read-only, on the target database:
   - `docs/releases/2026-10-inventory/sec1-predeploy-checks.sql`. Queries
     1–6 must return 0 rows. On prod, gate 6 is expected to list the demo13
     seed's PENDING TECHNICAL instances (`metadata.seeded_by = 'demo13'`).
     Cancel them (the demo13 `99_unseed`, or the operator block) and re-run
     until it is empty. Do not widen the resolver to make them pass.
   - `SELECT pid, state, now() - xact_start AS age, query FROM pg_stat_activity
     WHERE state <> 'idle' ORDER BY age DESC;`. Nothing should be long-running
     or `idle in transaction` on the PO tables.
   - The roles that will receive `grn.read` + `grn.create` through
     `awarding.create` (100400 step 4). Share the list with the client so they
     can narrow it.
2. **Back up**: `pg_dump -Fc` to
   `~/workwise-db-backups/<db>-inventory-<timestamp>.dump`.
3. **Apply the six migrations in order**, at a quiet hour:

   | File | What it does |
   |---|---|
   | `20261024100100_inventory_core` | Items, variants, units, barcodes, hotel settings, doc sequences and doc-code history, the ledger (`tbl_inv_movement`, immutable), balances and batches |
   | `20261024100200_po_delivery_receiving` | Delivery plan, dispatch notes (with `client_event_id`), GRN and lines, RTV, short-close. Receipt columns on PO and PO lines. Hashed site-rep tokens |
   | `20261024100300_inventory_stock_ops` | Mark-out, adjustments, counts, reorder settings |
   | `20261024100400_inventory_permissions` | `grn.*`, `inventory.*` and ten `reports.*` keys. The Storekeeper and Inventory Controller roles. Grants to Company Administrator and to `awarding.create` holders |
   | `20261024100500_po_receipt_backfill` | Flags POs that predate line-level receiving (`receipt_legacy`). Received ones read "Received (before line-level receiving)" |

   - Each file is one transaction with `SET LOCAL lock_timeout = '5s'`.
     A blocked lock aborts the file cleanly. Every statement is idempotent,
     so re-run it.
   - The 100500 backfill writes one audit row per PO it flags.
   - `/tmp/inv-stage/apply_inventory_migrations.sh` (`CONFIRM_DB=<db>`)
     applies them and writes each `pgmigrations` row inside the file's own
     transaction.
4. **Deploy** the backend, then the frontend.
5. **Right after the new backend is healthy**, run the `-- backfill` block
   of 100500 once more. Between step 3 and step 4, the old code may have
   moved a PO to `GRN`; without this re-run it would be received a second
   time. Do not re-run it later: by then a new PO whose plan creation failed
   would be wrongly flagged legacy.

Rollback: the down files run newest first. The 100400 down refuses while an
approval policy step names the two roles. It reports how many role
assignments, grants and roles it removes.

## Behaviour changes outside inventory

- **Security fixes in existing code:**
  - `POST /rfq/finalize` now checks the RFQ tenant, the same way
    quote-compare does.
  - `existing_po_id` (merge into a draft PO) must be a draft on the same RFQ,
    for the same vendor.
  - Approval actions refuse a target that belongs to another company, or
    that cannot be resolved (404, fail-closed). `dispatchPostApprovalAction`
    is the single dispatcher.
  - Awards parked for approval must bind to a real quote line of the RFQ, by
    the vendor named.
- **Report periods:** a custom period's "to" date is now inclusive. This
  also changes the existing procurement reports, and fixes a long-standing
  off-by-one.
- **Deleting a catalogue variant** that has been received into inventory,
  or mapped to a stock item, is refused by the database (FK). An admin
  re-upload that re-creates variants for such a product fails the same way.
  This is deliberate: stock records must not lose their item.
- **PO PDF and PO detail** show the delivery plan once one exists.
- **The old "Mark dispatched" and old GRN token links:**
  - Old GRN links (`?token=`) redirect to the new site-rep page.
  - The vendor's one-click "Mark dispatched" stays as a fallback when the
    plan cannot load.
- **Session expiry (frontend `lib/axios`):** a 401 on a request that sets
  `settleOn401: true` now rejects. The inventory outbox uses this; every
  other caller keeps the old dialog-and-wait behaviour.

## Known limitations

- **Plan edits:** two buyers editing the same delivery plan at once: the
  last save wins. There is no version check yet.
- **Blind counts** hide system quantities on the count screens only.
  `GET /stock` still shows them to anyone with `inventory.read`.
- **Call-off POs** released from an MR have no delivery plan or due date, so
  Receive lists them as "Not scheduled". The MR's required-by date is not
  used as a due date. This is a product decision to take.
- **Dispatch-note dialog:** the "Open" column is the hotel-wide open qty,
  which is the server's cap. The default "Dispatch now" qty is the phase's.
- **Scanning on the site-rep page:** site reps scan barcodes (EAN/UPC/GS1)
  or Workwise item labels. Typed item codes and SKUs are not matched there.
  Manual entry is always available.
- **OTIF and short-close:** OTIF counts only vendor-attributable
  short-close reasons. Confirm with the client how "substituted" and "price
  dispute" should count.
- **Past-date report values:** a past-date stock value can differ from the
  current balance by paise, because there is no stored value-after column.
- **S3 objects:** discarded GRN drafts and deleted attachments stay in S3.
- **Token page third-party loads:** the token page loads Google Fonts and
  Google Sign-In scripts, as every page does.

## Follow-ups (found during this work, not fixed here)

- MR module: `POST /mr` has no `mr.create` check. (The inventory
  reorder→MR path does check it.)
- ARC v2 `saveAllocation` trusts the snapshot rate sent by the client.
- MR lines store the base rate rather than a call-off amendment's rate.
- `submitVendorQuote` does not update the quote line.
- `logArcEvent` swallows errors inside a caller's transaction, which can
  silently roll it back. Fix: run it in a savepoint.
- The notification sweeper's dedupe scans `tbl_notifications`. Add
  `CREATE INDEX CONCURRENTLY ix_notifications_type_created ON
  tbl_notifications (type, created_at)` in a separate, non-transactional
  migration.
- Only the general and RFQ approval routes answer 404 for a refused
  instance; other routes answer 400.
