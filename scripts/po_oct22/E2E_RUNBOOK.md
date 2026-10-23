# PO Oct-22 tickets: local E2E runbook (T1, T2, T3)

Everything is local: Postgres on loopback, S3 and mail sunk to files. Nothing touches stage.
Never use `npm run dev` for this (stage AWS + real SMTP).

Ports: backend **8125**, frontend **3105**. DB: `hospitality_test_e2e_po22`.

## 1. Prerequisites

- Local Postgres (Homebrew), role = your OS user, no password.
- `npm install` done in `backend/` and `frontend/` of the `.worktrees/po-oct22` worktree.

## 2. Prepare the DB (drops and rebuilds it)

```bash
cd backend
E2E_RUN_ID=e2e_po22 node scripts/vendor_networks/e2e_prepare_db.mjs     # -> READY hospitality_test_e2e_po22
```

## 3. Start the server (foreground, own terminal)

```bash
cd backend
E2E_DB_NAME=hospitality_test_e2e_po22 E2E_PORT=8125 \
E2E_MAIL_DIR=/tmp/po22-mail E2E_AWS_SINK_DIR=/tmp/po22-sink \
E2E_FRONTEND_URL=http://localhost:3105 \
scripts/vendor_networks/e2e_server.sh
```

`E2E_FRONTEND_URL` makes the links in mails and notifications point at port 3105.

## 4. Seed (needs the server up)

```bash
cd backend
node scripts/po_oct22/e2e_seed.mjs
```

Not re-runnable: it refuses if the `[PO22]` RFQs exist. To start over, redo step 2, restart the
server, and seed again. Overrides: `--db= --host= --port= --api= --fe=`.

The seed prints logins, ids and start URLs. Password for every login: `E2e@12345`. Buyers log in with
**employee code**, vendors with email.

| Who | Login | Role in the world |
|---|---|---|
| Rhea, RFQ creator | `PO22CRT` | no awarding permission: cannot initiate |
| Eva, commercial evaluator | `PO22EVL` | raises awards, re-finalizes |
| Arun, award approver | `PO22AWD` | approves awards (flow prerequisite) |
| Cara, PO initiator (CA) | `PO22INI` | Company CEO, can initiate |
| Priya P1 | `PO22AP1` | PO step 1 |
| Pavan P2a | `PO22A2A` | PO step 2 (ANY of P2a/P2b) |
| Pooja P2b | `PO22A2B` | PO step 2 |
| Param P3 | `PO22AP3` | PO step 3 |
| V-A Alpha | `po22.alpha@example.com` | vendor |
| V-B Beta | `po22.beta@example.com` | vendor |

The ids differ per DB build; take them from the seed output.

Role notes: the fixture's Commercial Evaluator role (8) has no `rfq.read`, so the seed also gives the creator and
the evaluator RFQ Observer (17), as every role-8 holder on prod has `rfq.read` through another role. The PO approvers
(P1-P3) have no `rfq.read`, so they can't open the RFQ page; they work from the PO pages.

## 5. Start the frontend

`NEXT_PUBLIC_API_URL` (read from `.env.development`, `http://localhost:8002/api/v1`) sets the API base.
A variable already in the shell wins over the `.env` file, but `npm run dev` wraps `env-cmd`, which
overrides it. So call next directly. Use webpack (no `--turbopack`): Turbopack refuses a symlinked
`node_modules`, which worktrees have.

```bash
cd frontend
NEXT_PUBLIC_API_URL=http://localhost:8125/api/v1 npx next dev -p 3105
```

Logging in: open `/?conform=true`, click "Log in", enter the login and password, press "Sign In". If a
"Continue on This Device" prompt appears, accept it (the session is single-device). In-app notifications are at
`/dashboard/notifications`.

Use a separate browser profile (or incognito window) per user, since the session is a single login.

## 6. Mail sink and S3 sink

- Mail: one JSON file per message in `/tmp/po22-mail/`.
  ```bash
  for f in /tmp/po22-mail/*.json; do node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(m.to[0].address,"|",m.subject)' "$f"; done
  ```
- S3: uploads (PO PDFs, hold attachments) are files under `/tmp/po22-sink/vn-e2e-local.localhost/`.
  The stored URL is a real-looking amazonaws URL, so clicking a download link in the UI fails. That is
  expected; check the file on disk instead.

## 7. Scripts

World recap: RFQ A = full award, DRAFT PO. RFQ B = 3 products: product 1 to V-A and product 2 to V-B (two DRAFT POs), product 3 not awarded.
RFQ C and D = split by product (product 1 to V-A, product 2 to V-B), both POs initiated; V-A's PO at step 2 (P1 already approved), V-B's at step 1.
RFQ E (extra) = V-A PO fully approved, waiting for vendor acceptance. Call-off PO `CO-PO22-0001`
(ARC-PO22-0001, V-A) waiting for acceptance.

### T1: initiate guide (RFQ B)

1. Log in as `PO22INI`. Open `/dashboard/buyer/rfq-management-details?id=<RFQ B>&stage=purchase-order`.
2. Expect the amber guide on the PO stage naming what to do, with an "Open PO <no>" button.
3. Click it: PO detail opens with an Initiate button. Click Initiate.
4. Expect success, the PO now pending approval, and (if more drafts exist) a "Next draft: PO ..." link.
   RFQ B has two drafts (V-A's and V-B's), so "Next draft" walks to the sibling draft on the same RFQ.
5. Log in as `PO22CRT` (no permission). Open RFQ B the same way. Expect the guide to show the **names** of the
   people who can initiate and **no** Initiate button. On PO detail, also no button.
6. Phone view: devtools, 390px wide, as `PO22INI` on a draft PO (RFQ A's, or B's second draft). Expect a sticky Initiate bar at the bottom.

### T3 hold (RFQ C, V-A PO)

1. As `PO22A2A` open `/dashboard/buyer/purchase-orders/<C V-A PO>` (step 2 is waiting). Use "Ask for information",
   pick the RFQ creator (Rhea) and reason "Photos or documents missing", add a comment, send.
2. Expect the PO shown as on hold, with the request in its thread.
3. As `PO22A2B` open the same PO. Expect Approve/Reject blocked with a hold notice (no way to approve).
4. Mail: `/tmp/po22-mail` has a message to Rhea's address. In-app: log in as `PO22CRT`, the notification bell has the request.
5. As `PO22CRT` open the PO (link in the notice) and answer with **2 images**.
6. As `PO22A2A` approve. Expect step 3 pending, **same PO number**, hold closed.
7. As `PO22AP3` approve to finish (optional). The hold files exist under `/tmp/po22-sink/`.

### T3 reject (RFQ D, V-A PO)

1. As `PO22A2A` open the D V-A PO. Reject with reason **"Re-negotiate or change the vendor"** and a comment.
2. Expect V-A's PO rejected; V-B's PO (step 1) untouched and still pending.
3. As `PO22EVL` open RFQ D (`stage=purchase-order`). Expect the rejected PO with its reason, and a link to Create Round
   (`/dashboard/buyer/negotiation/<RFQ D>/create`).
4. The rejection notification (bell, as `PO22EVL`) opens Create Round with only the rejected product available.
   Either run a round, or re-award directly on Quote Comparison (`/dashboard/buyer/quote-comparison?rfq=<RFQ D>`):
   pick V-B for the rejected product, Finalise, then approve as `PO22AWD` (same page, Approve → Review & confirm).
   Expect a new draft PO whose detail shows **"Replaces PO #<old>, rejected: <reason>. “<comment>”"**.
5. Cancel path: on RFQ C's V-B PO (or any pending PO) reject as the step approver with **"Not needed any more"**.
   Expect the PO cancelled with no re-negotiate prompt. Do this on RFQ C V-B only if the hold script is already done.

### T2: vendor reference

1. Log in as `po22.alpha@example.com`. Open `/dashboard/vendor/purchase-orders/orders`.
2. Expect an RFQ / Contract column. RFQ POs show the RFQ number + title; the call-off shows the ARC number + title (and MR).
3. In the Orders search box ("Search PO #, RFQ #, title, ARC, buyer…", not the sidebar's "Search…"), search
   `#<rfq_no>` of a PO the vendor can see (for example RFQ E's `#8000005`). Expect only that RFQ's POs. The ARC
   number, contract title and MR number also find the call-off. A PO still in internal approval is not listed for
   the vendor at all, so `#8000003` finds nothing while RFQ C's PO is in approval.
4. Open the RFQ E PO (acceptance pending), press Accept. Expect the dialog to name the RFQ. Repeat on the call-off: it names the contract.
5. While RFQ C's V-A PO is on hold (after T3 hold step 1), sign in as V-A. The PO is not in the vendor's list (it is
   still in internal approval). `GET /po/<id>` as the vendor carries no hold, send-back, reason or comment, and the
   send-back routes answer 403. Same after the reject script.

## 8. Teardown

- Stop the server by PID only, never `pkill -f` (it kills other engineers' servers): `kill $(lsof -ti tcp:8125)`; the frontend: `kill $(lsof -ti tcp:3105)`.
- `psql -c 'DROP DATABASE hospitality_test_e2e_po22'`; `rm -rf /tmp/po22-mail /tmp/po22-sink`.

## Notes on how the seed builds the world

Over HTTP: login, award submission (`POST /negotiation/quotes/submit-for-approval`), award approval
(`/negotiation/quotes/:id/approve`, which finalizes the vendor and drafts POs), initiate (`/po/initiate/:id`),
step-1 approval (`/po/approve/:id`). Direct SQL only for: fixture users' names and passwords, extra role scopes,
the 3-step PO policy rewrite, the RFQ and vendor quotes, and the ARC/MR/call-off rows. Each is commented in `e2e_seed.mjs`.
