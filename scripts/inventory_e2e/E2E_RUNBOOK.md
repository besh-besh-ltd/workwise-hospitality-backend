# Inventory module: local E2E runbook

A seeded, fully local environment for clicking through the inventory module end to end:
receiving against a delivery plan, vendor dispatch, RTV, short-close, mark-out, adjustments,
counts, batches and expiry, reorder to an MR draft, the low-stock digest, reports, the site-rep
link and the vendor view.

Everything runs on this machine. Nothing reaches the stage database, Brevo or S3.

| Piece | Where it really goes |
|---|---|
| Database | `hospitality_test_e2e_inventory` on `127.0.0.1:5432`. The launcher, the test harness and the seed each refuse any other host. The harness also requires the `hospitality_test_` prefix, so the name cannot be `hospitality_e2e_inventory`. |
| Mail | `nodemailer` is replaced in-process, so each mail becomes one JSON file in `/tmp/inv-e2e/mail/`. The Brevo host is hard-coded in `app/config/app.config.js`, so swapping credentials alone would not stop it. |
| S3, Scheduler, Lambda | A loopback stand-in on `:9592`. Uploaded PDFs land in `/tmp/inv-e2e/aws-sink/`. |
| Everything else | An egress guard refuses any TCP/TLS connection that is not loopback and logs it as `BLOCKED` in `/tmp/inv-e2e/egress.log`. AI, WhatsApp, OTP and Razorpay point at `127.0.0.1:9`. OTel points at `127.0.0.1:4317` (nothing listens there). |
| Secrets | Throwaway literals set by the launcher. No value is read from any `.env`. If a `.env` sits next to `server.js`, the launcher refuses to start unless every key in it is overridden. |

Files in `scripts/inventory_e2e/`:

| File | What it does |
|---|---|
| `e2e_server.sh` | The launcher: rebuilds the DB, seeds, then serves on port 8092. |
| `e2e_env.sh` | The environment every local process runs under, and its guards. Sourced by the launcher and the digest script, never run directly. |
| `seed.mjs` | The idempotent seed. It writes `/tmp/inv-e2e/seed.json`. |
| `api_scenario.mjs` | Runs the whole scenario below through the API and asserts every number in this runbook (80 checks). Needs a freshly seeded world. |
| `low_stock_digest.sh` | Runs the daily low-stock digest now, instead of waiting for the 07:30 IST cron. |
| `e2e_egress_guard.mjs` | Loopback-only network guard. |

The launcher also reuses `scripts/vendor_networks/e2e_mail_sink.mjs`, `e2e_aws_sink.mjs` and `e2e_prepare_db.mjs` unchanged.

---

## 1. Start the backend

```bash
cd .worktrees/inventory/be-e3        # any backend checkout with the inventory migrations
scripts/inventory_e2e/e2e_server.sh  # rebuild DB + seed + serve (about 30 s)
```

| `E2E_RESET` | Effect |
|---|---|
| `full` (default) | Drops and rebuilds the database from `schema.sql`, reference data, every pending migration (including the 6 inventory ones) and the fixtures, then seeds. |
| `seed` | Keeps the schema and re-seeds the inventory world. This wipes everything an earlier run built on it: plans, dispatches, GRNs, RTVs, the ledger, counts, MRs, mails. |
| `none` | Restarts on the existing data. |

The banner prints the API base (`http://localhost:8092/api/v1`), the mail-sink dir, the logins, the site-rep link and the backend PID. Stop the backend with Ctrl-C, or `kill <pid>`. Stop it before running the seed on its own, because the seed takes a table lock on the ledger.

Run the seed by itself, against an already-built DB, with `node scripts/inventory_e2e/seed.mjs`. It is safe to rerun.

**API run.** With the backend up on a fresh seed, `node scripts/inventory_e2e/api_scenario.mjs` plays steps 1–13 (including 9b and 10) through the API and prints PASS/FAIL per check. It exits 1 on any failure, and refuses to start if PO 96801 already has a plan or receipts. It changes the seeded world, so re-seed before a browser run: stop the backend, then `E2E_RESET=seed scripts/inventory_e2e/e2e_server.sh`.

## 2. Start the frontend

```bash
cd .worktrees/inventory/frontend
NEXT_PUBLIC_API_URL=http://localhost:8092/api/v1 npx next dev --turbopack   # http://localhost:3000
```

The worktree has no `.env.development`, so `npm run dev` fails. Use the command above. Do not copy the main checkout's `.env.development` here: it points at the stage API and turns PostHog on. With no env file, PostHog is off and browser OTel targets `localhost:4318`.

## 3. Logins

Every password is `E2e@12345`. On the login form, type the **employee code** in the email/code box (text without `@` is treated as a code).

| Code | Who | Scope |
|---|---|---|
| `INVE2E-STORE` | Sunita Rao, Storekeeper | Storekeeper at **A1 only** (grn read/create/update, inventory read/create/update) |
| `INVE2E-CTRL` | Vikram Shah, Inventory Controller | Inventory Controller at A1 and A2 (approves adjustments and counts), plus MR Raiser at A1 and A2 |
| `INVE2E-BUYER` | Priya Nair, Purchase Manager | Company A, all hotels: Final Awarding P1 (`awarding.create`, so this is the PO initiator), RFQ Observer, MR Raiser, MR Approver |
| `INVE2E-BBUYER` | Arjun Desai, buyer at company B | Final Awarding P1 + Inventory Controller at company B. Use it for isolation checks. |
| `INVE2E-VENDOR` | FreshKart Foods & Supplies | Hospitality vendor with an active subscription. Admin-assigned, so there is no payment. |

The vendor's email is `vendor.freshkart@inv-e2e.example.invalid`. The login route validates emails with Joi `.email()`, which rejects the `.invalid` TLD (HTTP 400 "Email must be a valid email"). So the vendor also logs in by its employee code. Every seeded email is undeliverable by design.

## 4. The seeded world

**Companies and hotels**

| Company | Hotel | Id | Inventory doc code |
|---|---|---|---|
| Company A, "Saffron Hotels (E2E)", hospitality company 96801 | Saffron Grand Mumbai | 96801 | `A1` |
| | Saffron Residency Pune | 96802 | `A2` |
| Company B, "Indigo Resorts (E2E)", hospitality company 96802 | Indigo Bay Goa | 96803 | `B1` |

Departments are the global fixtures: Procurement 10201, Engineering 10202, F&B 10203, Housekeeping 10204.

**Stock** is not started at any hotel and there are no movements or batches. Receiving (step 3) puts stock in. Approving a FULL count, or an opening import, stamps `stock_started_at`. Step 9 is a FULL count, so it starts stock at A1, and the low-stock digest only looks at hotels whose stock has started. Until then, the overview lists both hotels under "stock not started", which is expected. The reorder worklist does not need stock started.

**Company A settings:** over-receipt tolerance 0%, no negative stock, GST not in cost, an auto-approve limit of 0 (so every adjustment needs approval), no count freeze.

**Items (company A), barcodes and levels.** Type these barcodes into any "Scan or type a code" box and press Enter, as a keyboard-wedge scanner would.

| Item | Stock unit | Barcode | One scan adds | Levels A1 (min / reorder / max, bin) | Levels A2 |
|---|---|---|---|---|---|
| Paneer `PNR-001` (expiry-tracked, min shelf life 3 d) | kg | `8901234500019` | opens the weigh pad (kg is a weighed unit) | 5 / 10 / 30, Cold room C1 | 4 / 8 / 20, Chiller 2 |
| Basmati Rice `RICE-001` (UOM Bag = 25 kg) | kg | `8901234500026` (25 kg bag) | 1 Bag on the PO line = 25 kg of stock | 50 / 100 / 300, Dry store R2 | 25 / 50 / 150, Dry store 1 |
| | | `8901234500033` (1 kg pack) | 1 kg | | |
| Shower Cap `HK-CAP-001` (UOM Carton = 100 pc) | pc | `8901234500040` (each) | 1 pc | 100 / 200 / 600, HK store S3 | 50 / 100 / 300, HK store 1 |
| | | `8901234500057` (carton) | 100 pc | | |

The GS1 form of paneer carries a batch and an expiry date. Scanning it on receive fills both fields: `(01)08901234500019(17)<YYMMDD>(10)PNR-E2E-01`. The seed prints the exact string with an expiry of today + 10, and it is also in `seed.json` under `gs1Paneer`.

Company B has its own "Paneer (Indigo)" item (96811) carrying the **same** barcode `8901234500019`. A scan resolves inside the caller's company only, so a company A user gets item 96801 and a company B user gets 96811.

**Purchase orders.** Both are vendor-accepted: status `approved`, `vendor_action_at` = yesterday.

| PO | What | Lines (PO unit, rate, GST) | Total |
|---|---|---|---|
| **96801 `E2E-INV-PO-1001`** | Multi-hotel RFQ PO (RFQ 96801, delivers to A1 + A2). It has no delivery plan yet: the first read creates one unallocated delivery, due vendor acceptance + 3 days. | Paneer 40 kg @ ₹380 (5%); Rice 10 Bag @ ₹2,250 (5%); Caps 500 pc @ ₹4 (18%). Line ids 96801–96803. | ₹41,945 |
| **96802 `E2E-INV-CO-1002`** | Call-off PO for **A1** only, from the active ARC `ARC-E2E-INV-0001` (contract 96801, F&B) via MR `MR-E2E-INV-0001`. Its due date is the MR's required-by date, today + 2. | Paneer 15 kg @ ₹360 (5%); Caps 300 pc @ ₹3.80 (18%). Line ids 96811–96812. | ₹7,015.20 |

**Rate contract.** ARC `ARC-E2E-INV-0001` (96801) is active, single-hotel A1, department F&B (contract 96801). Reorder's MR draft matches against its lines. Remaining = committed − what the call-off PO 96802 already consumed.

| Item | Contract line | Rate (what the MR stores) | Unit | Committed | Remaining |
|---|---|---|---|---|---|
| Paneer | 96801 | ₹360 | kg | 600 | 585 |
| Basmati Rice | 96802 | ₹2,200 | Bag (= 25 kg) | 120 | 120 |
| Shower Cap | 96803 | ₹3.80 | pc | 10,000 | 9,700 |

There is no contract in any other department, so a reorder MR draft for Housekeeping is refused as NOT_CONTRACTED.

**Site-rep link.** One live link exists, for PO 96802 at A1, and it lasts 14 days:

```
http://localhost:3000/receive/token#t=DfLUwzb2t53bWyHuSGKl4MG80SA965zxjSjE2yvAtpk
```

The token is fixed: base64url of sha256("inventory-e2e/site-rep/call-off-po/A1"). Only its sha256 is stored, the same way the app stores real tokens.

To mint another link, use the buyer's PO page → Deliveries → Site representatives → **Add site rep**. Or call the API: `POST /api/v1/po/addSiteRepresentative {po_id, hotel_id, name, email, phone}` as `INVE2E-BUYER`. The link arrives as a mail file in `/tmp/inv-e2e/mail/`; open it and copy the `/receive/token#t=…` URL. Adding a rep at a hotel revokes that hotel's previous link.

---

## 5. Scenario

Dates below are relative to the day you run it. "P1" means today + 2 and "P2" means today + 9.

Every expected number below comes from `api_scenario.mjs` on a fresh seed: 80 of 80 checks passed on 2026-10-25, against backend integration with D3. In the examples, today is 2026-10-25, so the paneer batch `PNR-E2E-01` expires 2026-11-04 (today + 10) and the expired lot `PNR-E2E-OLD` expired 2026-10-24 (yesterday).

The UI steps have not been run in a browser against D1 and D3 yet. The frontend integration branch now has D1 (`9a927aba`) and a Reorder page, so the page names and button labels below may need small corrections after that run. The API equivalents are verified.

Routes (frontend):

| Page | Route |
|---|---|
| Buyer PO | `/dashboard/buyer/purchase-orders/96801?tab=deliveries` |
| Vendor PO | `/dashboard/vendor/purchase-orders/96801` |
| Inventory | `/dashboard/buyer/inventory/...` (left nav "Inventory": Overview, Receive, Stock, Mark out, Counts, Adjustments, Reorder, GRNs, Setup, Labels) |
| Reports | Insights → Reports |

### 1. Split the multi-hotel PO into hotel × 2 phases (`INVE2E-BUYER`)

1. Go to Requisition & Orders → Purchase Orders → Dashboard → `E2E-INV-PO-1001`, then the **Deliveries** tab (or open the route directly).
2. The banner reads **"Split this PO by hotel"**: it delivers to 2 hotels and nothing says how much goes where. Click **Split by hotel**. The editor opens with an equal split already applied.
3. In each hotel group, click **Add phase** to get Phase 1 and Phase 2. Set the due dates (P1, P2) and the quantities:

   | Item | A1 P1 | A1 P2 | A2 P1 | A2 P2 |
   |---|---|---|---|---|
   | Paneer (kg) | 12 | 12 | 8 | 8 |
   | Rice (Bag) | 3 | 3 | 2 | 2 |
   | Caps (pc) | 150 | 150 | 100 | 100 |

4. The allocation strip should read "Planned in full" for every item. Click **Save plan**.

Expected:
- Four phases are listed, each "Open".
- The vendor gets the mail "Delivery schedule updated for PO E2E-INV-PO-1001".
- The PO PDF is re-rendered into `/tmp/inv-e2e/aws-sink/`.

### 2. Vendor dispatch note for P1 at A1 (`INVE2E-VENDOR`)

1. Go to Orders → Purchase Orders → `E2E-INV-PO-1001`. In the **Deliveries** section, on the "Saffron Grand Mumbai (A1) · Phase 1" card, click **Dispatch**.
2. In the **Dispatch note** modal:
   - Hotel: A1. Phase: 1.
   - Under "What is on the truck", set Dispatch now to 12 / 3 / 150.
   - Challan `FK-DC-1001`, today; vehicle `MH04 AB 1234`; expected delivery P1.
3. Click **Record dispatch**.

Expected:
- `DSP/A1/<FY>/00001` shows "On the road".
- The buyer gets the mail "Dispatch Update: PO #E2E-INV-PO-1001 marked as Dispatched".
- The buyer's plan now shows "Plan locked", and only due dates can move.

### 3. Receive at A1 by scan, with a rejection (`INVE2E-STORE`)

1. Go to Inventory → Receive. Under **Awaiting deliveries**, find the row `E2E-INV-PO-1001` · A1 and click **Receive**. The storekeeper only has A1, so there is no hotel choice.
2. Scan into "Scan or type a code" (press Enter after each):
   - `(01)08901234500019(17)<YYMMDD>(10)PNR-E2E-01`, the GS1 paneer code from the seed output. The weigh pad opens because kg is weighed. Enter `12` and Add. Batch and expiry fill from the code.
     - Scanning the plain `8901234500019` also works, but then you type the expiry yourself. It is required for an expiry-tracked item, and must be at least 3 days out or you get a warning.
   - `8901234500026` three times. Each scan adds 1 Bag (25 kg).
   - `8901234500057` once (+100 pc), then `8901234500040` fifty times, or type 150 into Received.
3. On the paneer line, open "Reject, batch and expiry" (on mobile) or the line details (on desktop). Set Rejected qty `2` and reason **Quality**. Accepted becomes 10.
4. Under Delivery documents → **Against dispatch**, pick `DSP/A1/… · challan FK-DC-1001`. It fills the challan, and fills quantities only for lines you have not already scanned.
5. Click **Post receipt** → check the summary → **Confirm and post**.

Expected:
- `GRN/A1/<FY>/00001` is posted.
- Stock at A1, on Inventory → Stock (A1 value ₹11,150) or with `GET /inventory/stock?hotelId=96801`:

  | Item | Qty | Avg cost | Value |
  |---|---|---|---|
  | Paneer | 10 kg | ₹380 | ₹3,800 |
  | Rice | 75 kg | ₹90 | ₹6,750 |
  | Caps | 150 pc | ₹4 | ₹600 |

  All three are below their reorder level. Cost excludes GST.
- The paneer item card (Inventory → Stock → Paneer, or `GET /inventory/stock/96801/items/96801`) lists one batch: `PNR-E2E-01`, expiry today + 10, 10 kg.
- The A1 P1 phase is "Partly received": paneer has 2 open, because a rejected quantity stays owed.
- The dispatch shows as "received".
- The mail "GRN/A1/…: goods received against PO E2E-INV-PO-1001" goes to the buyer and to the vendor. The vendor's copy names the rejection.

### 4. Short-close P2 at A2 (`INVE2E-BUYER`)

1. On the PO's Deliveries tab, click **Short-close**.
2. Under "What to close", choose **One phase** → Saffron Residency Pune (A2) · Phase 2. Reason **No longer needed**, remarks "Pune banquet cancelled".
3. Click **Short-close**.

Expected:
- A2 P2 shows "Short-closed" (8 kg, 2 Bag, 100 pc closed).
- PO receipt status is "Partly received".
- The vendor gets the mail "PO E2E-INV-PO-1001: quantities short-closed".
- Short-close history lists the three rows.

### 5. RTV with Replacement (`INVE2E-CTRL`; RTV needs `grn.approve`, which the Storekeeper lacks)

1. Go to Inventory → GRNs → `GRN/A1/…/00001` → **Return to vendor**.
2. Choose **Replacement**. On Shower Cap, set Return `10` with reason Damaged. Click **Create return**.
3. Then **Dispatch now**, with return challan `RTV-DC-01`.

Expected:
- `RTV/A1/<FY>/00001` is dispatched, and caps at A1 drop to **140** pc (₹560).
- On the plan, caps show "Returned 10" and 10 open again at A1 P1 (the vendor owes the replacement).
- The vendor gets the mail "RTV/A1/…: goods returned".
- The RTV PDF lands in the AWS sink.

### 6. Mark out paneer to F&B by scan (`INVE2E-STORE`)

1. Go to Inventory → Mark out, choose department **F&B**, scan `8901234500019`, enter `6` kg, then post.
2. Expected:
   - `OUT/A1/<FY>/00001`, ₹2,280; paneer goes to **4** kg.
   - FEFO takes the 6 kg from `PNR-E2E-01`, which drops to 4 kg.
3. API equivalent (`POST /inventory/out`):

   ```json
   {"hotelId":96801,"docType":"OUT","departmentId":10203,"requestedByName":"Chef Arun","clientEventId":"<uuid>","lines":[{"invItemId":96801,"qty":6}]}
   ```

### 7. Return 2 kg (`INVE2E-STORE`)

1. Same page, choose Return, F&B, paneer `2` kg.
2. Expected:
   - `RET/A1/<FY>/00001`, ₹760; paneer goes to **6** kg.
   - A return with no batch goes to the **undated bucket**. The paneer card now lists two rows: undated 2 kg first (FEFO treats an unknown expiry as the soonest), then `PNR-E2E-01` 4 kg.
3. API: as step 6 with `"docType":"RETURN"` and qty 2.

### 8. Wastage adjustment, then approve

1. As `INVE2E-STORE`: go to Inventory → Adjustments → new. Reason **Wastage**, paneer `-0.5` kg, remarks "Paneer soured in chiller". Submit.
   - It goes to "pending approval", because the auto-approve limit is 0.
   - The Storekeeper cannot approve it (HTTP 403 "You don't have permission to do this at this hotel").
2. As `INVE2E-CTRL`: approve it.
3. Expected:
   - `ADJ/A1/<FY>/00001` is posted, −₹190; paneer goes to **5.5** kg.
   - FEFO draws the undated bucket: undated 1.5 kg, `PNR-E2E-01` 4 kg.
4. API:
   - `POST /inventory/adjustments` with `{"hotelId":96801,"reasonCode":"WASTAGE","remarks":"…","submit":true,"clientEventId":"<uuid>","lines":[{"invItemId":96801,"qty":-0.5}]}`
   - then `POST /inventory/adjustments/<id>/approve` as the Controller.

### 9. FULL count with a variance, then approve (starts stock at A1)

1. As `INVE2E-STORE`: go to Inventory → Counts → **Start count**.
   - Hotel A1; **Full count** (all 3 items).
   - Leave **Blind count** on.
2. Enter Paneer `5`, Basmati Rice `75`, Shower Cap `140`. A FULL count needs every line counted before it can be submitted. Click **Submit for approval**. The blind count hides the system quantity from the storekeeper.
3. As `INVE2E-CTRL`: open `CNT/A1/<FY>/00001`.
   - Expected review: Paneer counted 5, system 5.5, variance −0.5, value −₹190, "Reason needed". Rice and caps have no variance.
   - Enter a reason on paneer (e.g. "Trim loss while portioning") → **Approve and post**.
4. Expected:
   - Paneer at A1 is **5** kg (₹1,900).
   - A1 stock total is ₹9,210 (rice ₹6,750 + caps ₹560 + paneer ₹1,900).
   - **Stock is started at A1** (`stockStartedAt` is set on `GET /inventory/stock?hotelId=96801`). A2 stays not started.
   - The count loss also draws FEFO, from the undated bucket: undated 1 kg, `PNR-E2E-01` 4 kg.
5. API:
   - `POST /inventory/counts {"hotelId":96801,"scope":"FULL","isBlind":true}`
   - `PUT /inventory/counts/<id>/lines {"lines":[{"invItemId":96801,"countedQty":5,"clientEventId":"<uuid>"}, …one per item, each with its own uuid]}`
   - `POST /inventory/counts/<id>/submit`
   - then, as the Controller, `POST /inventory/counts/<id>/approve {"reasons":{"<paneer line id>":"Trim loss while portioning"}}`

### 9b. An already-expired lot, written off as EXPIRY (expired lots go first)

This shows the one exception to FEFO. An adjustment with reason **Expiry** draws expired lots first, earliest expiry first. Every other outbound movement takes the undated bucket first, then the earliest expiry.

1. As `INVE2E-STORE`: Inventory → Receive → `E2E-INV-PO-1001` · A1. Receive paneer only: received 3, accepted 3, batch `PNR-E2E-OLD`, expiry **yesterday**, challan `FK-DC-1009`. Post it.
   - Expected: the GRN posts, with an **EXPIRED** warning ("Paneer expired on <yesterday>; consider rejecting it (short shelf life)"). An expired date warns but does not block.
   - The paneer card, in FEFO order: undated 1 kg; `PNR-E2E-OLD` (yesterday) 3 kg; `PNR-E2E-01` (today + 10) 4 kg. Paneer is 8 kg.
2. Reports → **7.7 Near expiry**, business unit A1:

   | Batch | Days to expiry | Status | Qty |
   |---|---|---|---|
   | PNR-E2E-OLD | −1 | Expired | 3 |
   | PNR-E2E-01 | 10 | Expiring | 4 |

   The report lists batches expiring within 30 days, expired ones included. The undated bucket never appears.
3. As `INVE2E-STORE`: Inventory → Adjustments → new. Reason **Expiry**, paneer `-3` kg, remarks "Expired lot PNR-E2E-OLD". Submit. Then, as `INVE2E-CTRL`, approve it.
4. Expected:
   - The second adjustment is posted, −₹1,140; paneer goes back to **5** kg.
   - The ledger (`GET /inventory/stock/96801/items/96801/ledger`) has **one** ADJUST_OUT row for it: batch `PNR-E2E-OLD`, expiry yesterday, −3 kg, −₹1,140.
   - The card: undated 1 kg, `PNR-E2E-01` 4 kg. `PNR-E2E-OLD` is gone and the undated bucket is untouched. Plain FEFO would have taken the undated 1 kg first and then 2 kg of the old lot.
5. API:
   - `POST /inventory/grn {"poId":96801,"hotelId":96801,"receivedAt":"<today YYYY-MM-DD>","vendorChallanNo":"FK-DC-1009","post":true,"clientEventId":"<uuid>","lines":[{"poLineId":96801,"receivedQty":3,"acceptedQty":3,"rejectedQty":0,"batchNo":"PNR-E2E-OLD","expiryDate":"<yesterday>"}]}`
   - `POST /inventory/adjustments {"hotelId":96801,"reasonCode":"EXPIRY","remarks":"Expired lot PNR-E2E-OLD","submit":true,"clientEventId":"<uuid>","lines":[{"invItemId":96801,"qty":-3}]}`, then approve as the Controller.

This receipt also counts against the plan: A1's open paneer on PO 96801 drops from 14 kg (2 still owed on P1 + 12 on P2) to 11 kg, which is part of step 10's "on order".

### 10. Reorder to an MR draft (`INVE2E-CTRL`)

The Controller can create the draft: user type buyer, `inventory.update` at A1 (Inventory Controller), and a role scope covering A1 / F&B (MR Raiser, any department). Those three are what `can.createMrDraft` and the server-side gate check.

1. Go to Inventory → Reorder, hotel A1. Expected worklist (after steps 1–9b):

   | Item | On hand | Reorder at | Max | On order | Suggested | Contract |
   |---|---|---|---|---|---|---|
   | Basmati Rice | 75 kg | 100 | 300 | 75 | **150** | line 96802, ₹2,200/Bag, 120 Bag left |
   | Paneer | 5 kg | 10 | 30 | 26 | 0 | line 96801, ₹360/kg, 585 kg left |
   | Shower Cap | 140 pc | 200 | 600 | 460 | 0 | line 96803, ₹3.80/pc, 9,700 pc left |

   How the numbers come out:
   - **On order** is the open quantity on A1's plan rows of live POs, plus approved MRs, in stock units:
     - rice: 3 Bag on A1 P2 = 75 kg;
     - paneer: 11 kg open on PO 96801 plus 15 kg on the call-off PO 96802 = 26;
     - caps: 10 (the RTV replacement still owed on P1) + 150 on P2 + 300 on PO 96802 = 460.
   - **Suggested** = max − on hand − on order, rounded up to the smallest pack above 1. Rice: 300 − 75 − 75 = 150, already a multiple of the 25 kg bag. Paneer and caps are covered by what is on order, so they get 0.
   - Unallocated group orders: none, because step 1 split PO 96801 by hotel.
2. Department (MR): **F&B**. Select Basmati Rice (order qty 150, the suggestion) and Paneer, and type order qty `10` for Paneer. Click **Create MR draft (2)**.
3. Expected:
   - "Draft requisition MR-… created with 2 items".
   - The MR is a draft at A1 / F&B, raised by the Controller. The lines are in the **contract's unit** at the contract rate: rice **6 Bag** @ ₹2,200 (150 kg ÷ 25), paneer **10 kg** @ ₹360.
   - Reload: rice now shows open MR 150 kg and paneer 10 kg (drafts and pending MRs count as "open MR").
4. API, with the checks `api_scenario.mjs` makes:

   | Request | Expected |
   |---|---|
   | `GET /inventory/reorder?hotelId=96801` | 200, the rows above, `can.createMrDraft: true`, F&B among `departments` |
   | `POST /inventory/reorder/mr-draft {"hotelId":96801,"departmentId":10203,"clientEventId":"<uuid>","items":[{"invItemId":96802,"qty":150},{"invItemId":96801,"qty":10}]}` | **201** `status: "draft"`, items `[96802, 6, "Bag", 2200]` and `[96801, 10, "kg", 360]` (line, quantity, unit, rate) |
   | The same body again, same `clientEventId` | **200** `replayed: true, no_op: true`, the same `mrId`. No second MR. |
   | rice `qty: 3100` (124 Bag), new `clientEventId` | **400** VALIDATION "Basmati Rice: 124 Bag is more than the contract has left (120 Bag)", `details.reason: "EXCEEDS_CONTRACT_REMAINING"`, `quantity: 124`, `remaining: 120` |
   | caps in department Housekeeping (10204) | **400** `details.reason: "NOT_CONTRACTED"` |
   | `INVE2E-BBUYER` (company B), `GET /inventory/reorder?hotelId=96801` | **404** |

   `items[].qty` is in **stock units**. The server converts it to the contract's unit with the item's UOM factor and rounds up to 0.01. `arcContractLineId` per item is optional: without it, the cheapest eligible line is used.

Note: the **Storekeeper** gets `can.createMrDraft: true` too, with all 4 departments, and can create a reorder MR draft at A1 / F&B (201), even though the Storekeeper role has no `mr.*` permission at all. The gate is `inventory.update` plus any role scope at the hotel and department, not `mr.create`. This was observed on the run and is reported to the D3 owner. It is not changed here.

### 11. Reports (`INVE2E-CTRL`, or the buyer)

1. Go to Insights → Reports. The Inventory family (7.1–7.7) and Receiving & Deliveries (8.1–8.3) are all ready.
2. Run with FY 2026-27, business unit A1:

   | Report | Expected after steps 1–10 |
   |---|---|
   | 7.1 Stock on Hand | Basmati Rice 75 kg ₹6,750; Paneer 5 kg ₹1,900; Shower Cap 140 pc ₹560 |
   | 7.3 Consumption by Department | F&B / PANEER: out ₹2,280, returns ₹760, net ₹1,520 |
   | 7.4 Wastage & Adjustments | Wastage −0.5 kg, −₹190; Expiry −3 kg, −₹1,140 |
   | 7.5 Count Variance | Paneer −0.5 kg, −₹190 |
   | 7.7 Near expiry | One row: `PNR-E2E-01`, 10 days, Expiring, 4 kg. The expired lot was written off in 9b. |
   | 8.1 GRN register | |
   | 8.2 Pending deliveries | |

   API: `POST /reports/<key>/preview {"filters":{"fy":"2026-27","hotel_ids":[96801]}}`. Keys: `stock_on_hand`, `consumption_by_department`, `stock_adjustments`, `count_variance`, `near_expiry`. Near expiry takes `hotel_ids` only.

### 12. Token receive page, prices hidden (no login)

1. Open the seeded link in a private window: `http://localhost:3000/receive/token#t=DfLUwzb2t53bWyHuSGKl4MG80SA965zxjSjE2yvAtpk`.
   - Expected: "Receive goods" for `E2E-INV-CO-1002` at Saffron Grand Mumbai (A1), Call-off. Paneer 15 kg and caps 300 pc are open.
   - **No price, rate or value anywhere.** The API omits them; this was checked on the context and on the posted GRN.
2. Scan `(01)…PNR-E2E-01` → `15`. Scan `8901234500057` ×3 (300 pc). Attach a photo if you want. Click **Post receipt**.
3. Expected:
   - `GRN/A1/<FY>/0000n` is posted.
   - The GS1 code carries the same batch and expiry as step 3, so the 15 kg join that batch: the paneer card shows undated 1 kg and `PNR-E2E-01` **19** kg (paneer 20 kg).
   - Mails go to the buyer and the vendor.
   - The link keeps working until it expires or is revoked: Deliveries → Site representatives → **Revoke** on the buyer's call-off PO.
   - An unknown or garbled token gets HTTP 401.

### 13. Vendor deliveries view (`INVE2E-VENDOR`)

1. Open `/dashboard/vendor/purchase-orders/96801` → **Deliveries**.
2. Expected:
   - The plan shows four phases with accepted / rejected / returned / short-closed / open columns.
   - **Dispatch notes**: `DSP/A1/…` received.
   - **Received at the hotel**: two GRNs. `GRN/A1/…/00001`: paneer 10 accepted / 2 rejected, reason quality. The 9b receipt: paneer 3 accepted.
   - **Returned to you**: `RTV/A1/…` Replacement, dispatched, challan RTV-DC-01.
   - **Short-closed**: three rows at A2 P2, "No longer needed".
   - No prices in this section.

### Isolation spot checks (curl or the browser)

| Who | Request | Expected |
|---|---|---|
| `INVE2E-STORE` | `GET /inventory/receive/po/96801?hotelId=96802` (A2) | 403 "You don't have permission to do this at this hotel" |
| `INVE2E-BBUYER` | `GET /inventory/po/96801/deliveries` | 404 |
| `INVE2E-BBUYER` | `GET /inventory/receive/po/96801?hotelId=96801` | 404 "Hotel not found" |
| `INVE2E-BBUYER` | scans `8901234500019` (hotel B1) | resolves to Paneer (Indigo) 96811, never company A's item |

---

## 5b. Low-stock digest (in-app, daily)

Every day at 07:30 IST a cron (`startLowStockSweeper`, registered in `server.js`) runs the low-stock sweep. To run it now instead of waiting, with the backend up or down:

```bash
scripts/inventory_e2e/low_stock_digest.sh                              # today (IST)
E2E_DIGEST_DATE=2026-10-26 scripts/inventory_e2e/low_stock_digest.sh   # as if it were another day
```

It calls the app's own `runLowStockSweep()` in a separate node process, under `e2e_env.sh` and with the egress guard and the mail sink preloaded. It refuses to run unless it is connected to the local E2E database on loopback. It prints the sweep result and one `bell -> <employee code>` line per notification written.

What it does, and what to expect after step 12:
- Only hotels whose **stock has started** are swept. On a fresh seed that is none, so the digest is empty until step 9's FULL count is approved.
- Per hotel, the active items at or below their reorder level become **one** notification per user who holds `inventory.update` there, vendors excluded.
- After step 12: `{"hotels":1,"digests":1,"alreadyDigested":0}`. A1 has one item below reorder: "1 item at or below reorder level at Saffron Grand Mumbai (A1) | Basmati Rice (75 of 100 kg)", linking to `/dashboard/buyer/inventory/reorder?hotelId=96801`. Paneer (20) and caps (440) were topped up by the call-off receipt. The bells go to `INVE2E-STORE` and `INVE2E-CTRL`.
- Once per hotel per IST day: a second run the same day returns `{"digests":0,"alreadyDigested":1}`.
- **It is not an email.** The digest goes through `notificationService.dispatch`: an in-app bell row (`tbl_notifications`, type `inventory_low_stock_digest`), a socket event and web push. Nothing lands in the mail sink; the run checks the mail count is unchanged. To see it in the UI, log in as `INVE2E-STORE` or `INVE2E-CTRL` and open the bell.

---

## 6. Desktop and mobile

- **Desktop:** Chrome at 1440×900 or wider. On Receive, the scan box keeps focus after each scan, so a USB keyboard-wedge scanner (or typing the code plus Enter) works anywhere on the page. The camera button needs HTTPS or localhost; localhost is fine.
- **Mobile emulation:** DevTools → device toolbar → 375×812 (iPhone X class), touch on.
  - Receive switches to cards ("Reject, batch and expiry" opens per line), and the weigh pad is a bottom sheet with a numeric keypad.
  - RTV, labels and the receive confirmation are sheets as well.
  - Check that "Post receipt" stays reachable above the fold after scanning.
  - Do the token page (step 12) at 375×812 too: a site rep will use it on a phone.
- Weighed units (kg, g, l, ml, m, …) always open the weigh pad on scan. Counted units add one pack per scan: Bag = 25 kg, Carton = 100 pc.

## 7. Proving nothing left the machine

While the backend runs, and after you stop it:

```bash
cat /tmp/inv-e2e/egress.log                 # START, then ALLOW lines only; BLOCKED = something tried to leave
grep -c BLOCKED /tmp/inv-e2e/egress.log     # expect 0
lsof -nP -a -p <pid> -iTCP | grep -- '->' | grep -vE -- '->(127\.0\.0\.1|\[::1\])'   # expect nothing
ls /tmp/inv-e2e/mail/                       # every mail the app "sent"
find /tmp/inv-e2e/aws-sink -type f          # every object it "uploaded"
```

Expected `ALLOW` destinations:

| Destination | What it is |
|---|---|
| `127.0.0.1:5432` | Postgres |
| `127.0.0.1:4317` | OTel, refused locally |
| `inv-e2e-local.localhost:9592` | The S3 stand-in |
| A high `127.0.0.1` port | Puppeteer's DevTools socket to its own Chromium |

Three caveats:
- **Web push.** The app sends web push to a browser subscription, if one is registered. The push service is on the internet (for Chrome, `fcm.googleapis.com`), so the egress guard refuses it and logs a `BLOCKED` line. That BLOCKED line means the guard worked, not that something leaked. It only happens after you allow notifications in the browser; the API run registers no subscription and has no BLOCKED lines.
- Log lines may mention `https://inv-e2e-local.s3.ap-south-1.amazonaws.com/...`. That is only the URL string the app stores for an uploaded PDF; the upload itself went to the sink. **Do not click PDF links in the UI.** Open the file under `/tmp/inv-e2e/aws-sink/` instead, because a click would make the *browser* fetch from real S3.
- Chromium (puppeteer, used for PDFs) is a child process outside the guard. The templates are self-contained, and puppeteer starts it with background networking disabled.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `ABORT: port 8092 is already in use` | Another E2E backend is still running: `lsof -nP -iTCP:8092 -sTCP:LISTEN`, then kill it. |
| The seed hangs | The backend is running and holds a lock on `tbl_inv_movement`. Stop it first. |
| `SEED FAILED …` after manual SQL | `E2E_RESET=full scripts/inventory_e2e/e2e_server.sh` rebuilds from scratch. |
| Login 400 "Email must be a valid email" | Use the employee code, not the `.invalid` email. |
| Mark out / Adjustments / Stock / Stock item / Setup / Labels / Scan pages say "Coming soon" | The frontend checkout does not have D1. It is in the frontend integration branch from `9a927aba`. Use the API calls in steps 6–9b meanwhile. |
| `GET /inventory/reorder` returns 501 | The backend does not have D3 (in backend integration from `88a6db42`). |
| Reorder shows no "Create MR draft" button | The user lacks `inventory.update` at the hotel, or has no role scope at any department there. |
| `api_scenario.mjs` says "ABORT: the world is not freshly seeded" | It ran before, or you clicked through. Stop the backend and start it with `E2E_RESET=seed`. |
| `low_stock_digest.sh` prints "no digest rows for that date" | Stock has not started at any hotel (approve step 9's FULL count), or nothing is at or below its reorder level. |
| The digest prints `alreadyDigested: 1` | It already ran today for that hotel. Use `E2E_DIGEST_DATE=<another day>`, or re-seed. |
