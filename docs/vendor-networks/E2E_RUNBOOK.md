# Vendor Networks: local E2E runbook

How to stand up a local backend, with seeded data, for the Vendor Networks E2E scenarios
(Task 17). Everything runs on this machine. The database, AWS and mail stay on loopback;
nothing connects to stage or production. The few integrations that can still reach the
internet with dummy keys, all off the scenarios, are listed in the
[integration table](#integrations).

## Safety model

`backend/.env` points at the shared **stage** RDS database and holds real stage credentials:
AWS (S3 bucket, EventBridge, Lambda), SMTP, WhatsApp and Razorpay. The E2E setup never edits
`.env`. It relies on one rule: `dotenv.config()` does **not** override a variable that is
already set in the environment. The launcher exports every value it needs to replace before
the app loads `.env`.

| Piece | Guard |
|---|---|
| `e2e_prepare_db.mjs` | Uses the test harness (`tests/setup/prepareTestDb.js`), so the harness guards apply: `NODE_ENV=test`, the DB name must match `^hospitality_test_…`, and the host comes from `.env.test` (local Postgres). It also refuses a non-local host. |
| `e2e_seed.mjs` | Never reads any `.env` file. It refuses unless the DB name matches `/^hospitality_test_\|local\|dev/` and contains none of `prod`, `stage`, `staging` or `main` (any case), and the host is `localhost`, `127.0.0.1` or `::1`. Once connected it also asserts that `inet_server_addr()` is loopback. |
| `e2e_server.sh` | Applies the same DB-name (case-insensitive) and host checks. It then exports the DB, AWS, secrets and the other integrations (see below), and preloads the mail and AWS sinks before `node server.js` starts. |

## 1. Prepare the database

```bash
cd backend
node scripts/vendor_networks/e2e_prepare_db.mjs      # -> hospitality_test_e2e
```

This builds `hospitality_test_e2e` exactly the way the test database is built:
`schema.sql` → `seed_reference.sql` → `pendingMigrations.json` → the test fixtures. The
fixtures include companies A/B, hotels 10101–10105 and users 80001+. The script **drops and
recreates** the database. Run the seed again afterwards.

> Why not `TEST_RUN_ID=e2e npm run test:setup`? The harness loads `.env.test` with
> `override: true`, so the `TEST_RUN_ID` in `.env.test` (for example `vnet`) wins over the
> command line. That command would silently drop and rebuild this worktree's **test**
> database. The wrapper re-applies the run id after each dotenv load.
> Use `E2E_RUN_ID=<x>` to build `hospitality_test_<x>` instead.

The E2E database is kept between runs. Nothing drops it automatically.

## 2. Seed

```bash
node scripts/vendor_networks/e2e_seed.mjs            # hospitality_test_e2e @ 127.0.0.1
# options: --db=  --host=  --port=  --user=   (or E2E_DB_NAME / E2E_DB_HOST / E2E_DB_PORT / E2E_DB_USER / E2E_DB_PASSWORD)
```

The seed is idempotent. A re-run first deletes the seed's world, then seeds it again. The
world is everything **owned** by the seed, plus what an E2E run built on top of it (quotes,
routing assignments, POs, MRs, call-offs, notifications).

- **Owned logins:** ids **95801–95899**, plus any login whose email matches
  `e2e.%@example.com`. When the E2E run creates entities or persons through the API
  (`POST /entities`, `POST /members`), use emails like `e2e.<something>@example.com` so a
  re-seed removes them.
- **Any other login linked into the seed org** loses only its org edges: entity, member,
  seat and invite rows (and coverage rules the seed org's admin authored). Its user,
  company, subscriptions, mappings, contracts, POs and RFQs are never touched. If a run leaves rows the cleanup does not
know about, the seed fails, rolls back, and says so. Rebuild the database with step 1.

The seed prints every login and id. Rows that use the sequence (RFQ id, ARC id, contract id,
contract line ids) change on every run.

**Logins.** Every login uses the password `E2e@12345` and goes through
`POST /api/v1/users/login?conform=true`.

| Who | Login | User id | Notes |
|---|---|---|---|
| Buyer "Priya" | `employee_code=E2EBUY01` | 95801 | user_type 2. Buyers can only log in with an employee code. |
| Daikin HQ | `e2e.daikin.hq@example.com` | 95811 | Principal, ORG_ADMIN, MH GSTIN `27AADCD1234F1ZW` |
| Person "Ravi" | `e2e.daikin.person@example.com` | 95821 | user_type 11, ENTITY_MEMBER of Daikin UP. The token resolves to HQ until he switches entity. |
| Daikin Goa | `e2e.daikin.goa@example.com` | 95813 | Stand-alone vendor in no network (Goa GSTIN), for the link-invite flow |
| Daikin UP | none | 95812 | BRANCH, ACTIVE, seat active. Passwordless, network-managed. UP GSTIN `09AADCD1234F1Z3` |

**Buyer side.**

| What | Value |
|---|---|
| Buyer parent company | `tbl_company` 95801 |
| Hospitality company | 95801, "E2E Westwind Hotels" |
| Hotel Mumbai | 95801. MH, `state_id` 116, `city_id` 1056, GST `27…` |
| Hotel Lucknow | 95802. UP, `state_id` 108, `city_id` 745, GST `09…` |
| Hotel Panaji | 95803. Goa, `state_id` 115, `city_id` 1051, GST `30…` |
| Department | 10201 (Procurement) |
| Approval process | 95801 |
| Buyer roles | 1, 13, 16, 17, 21, 22, 26, 27, 28 at company scope (every hotel, department and process). These cover the RFQ chain, awarding, ARC view and admin, MR raise and MR approve. |
| Approval policies | Company-wide, one `ANY` step that names the buyer, for RFQ, TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE, PO and MR. Because the buyer is the sole approver, MRs and POs the buyer submits **approve on submission**. |

**Vendor side.**
- Daikin HQ:
  - holds an active category subscription (237 ENGINEERING), a subcategory subscription
    (288 AIR CONDITIONING ITEMS) and hotel subscriptions for all 3 hotels;
  - is mapped to variants 3178 (AC INDOOR COOLING UNIT) and 3176 (AC CONDENSOR UNIT).
- Org 95811 "Daikin Network (E2E)" runs in `ADMIN_ROUTES` mode. Its entities are HQ
  (PRINCIPAL) and Daikin UP (BRANCH).
- **No coverage rules are seeded.** Scenario 2 creates "Daikin UP covers UP". Until then the
  routing queue shows the RFQ with no suggested candidate.

**RFQ.**
- Published, at the Lucknow hotel, with two products (3178 × 12 NOS and 3176 × 6 NOS).
- `tbl_rfq_product_vendors` rows invite **Daikin HQ** only.
- `bid_end_date` is set 4 days ahead as naive IST text.

**Group ARC** `ARC-E2E-VN-0001`:
- ARC status: `awaiting_vendor_acceptance`. Category 288. Hotels: Mumbai (lead) + Lucknow.
  The contract window opened yesterday.
- Daikin HQ's contract: `awaiting_acceptance`, two lines at 18% GST:
  - 3178: 100 @ 42,000, split Mumbai 60 / Lucknow 40;
  - 3176: 50 @ 18,000, split Mumbai 30 / Lucknow 20.
- `tbl_arc_contract_line_hotel` rows exist for both hotels, so the fulfilment panel and the
  OTP sign both run.

## 3. Start the backend

```bash
cd backend
scripts/vendor_networks/e2e_server.sh                          # foreground, port 8122
# background, with a log and a PID:
nohup scripts/vendor_networks/e2e_server.sh > /tmp/vn-e2e/backend-8122.log 2>&1 &
echo $!                                                       # the node PID (the script execs node)
```

- **Port:** `E2E_PORT`, default **8122**. The API base is `http://localhost:8122/api/v1`.
  Socket.io runs on the same origin.
- **Stop:** `kill <pid>`.
- **What it exports** (all of it wins over `.env`):

| Area | Values |
|---|---|
| Database | `HOST=127.0.0.1`, `DATABASE_NAME=hospitality_test_e2e`, `DATABASE_USERNAME=$(whoami)`, `DATABASE_PASSWORD=` (empty), `DATABASE_PORT=5432`, `TEST_DB_NO_SSL=1`. Override with `E2E_DB_NAME`, `E2E_DB_HOST`, `E2E_DB_USER`, `E2E_DB_PASSWORD`, `E2E_DB_PORT`. |
| Node env | `NODE_ENV=development`. Not `production`, so `POST …/contracts/:id/request-otp` returns the signing OTP as `data.dev_code`. Not `test`, so the real code paths run: PDFs render and crons start. |
| AWS | Fake keys, plus `AWS_ENDPOINT_URL` / `AWS_ENDPOINT_URL_S3=http://localhost:9555`. That port is `scripts/vendor_networks/e2e_aws_sink.mjs`, loaded in the same process with `--import`, listening on loopback only (`[::1]` and `127.0.0.1`). It stores PUT objects under `/tmp/vn-e2e-aws-sink/` and answers any other AWS call with 200 `{}`. This matters because PO approval is strict about the PO document: render, upload, store. Without a reachable "S3" no PO can be approved. The URL stored on the PO is the usual `https://vn-e2e-local.s3…amazonaws.com/…`, so clicking "download" in the UI fails. The PDF itself is in `/tmp/vn-e2e-aws-sink/vn-e2e-local.localhost/`. Override the port with `E2E_AWS_SINK_PORT`. |
| Mail | `scripts/vendor_networks/e2e_mail_sink.mjs`, preloaded with `--import`, replaces `nodemailer.createTransport` on the shared export. Every transport the app creates writes the message as a JSON file to `/tmp/vn-e2e-mail/<epoch-ms>-<n>.json` (override with `E2E_MAIL_DIR`). No SMTP connection is made. That matters because the SMTP host `smtp-relay.brevo.com` is hard-coded in `app/config/app.config.js`, so swapping the credentials alone still dials out. The app logs `[MAIL] Email sent successfully`. To read who got what: `for f in /tmp/vn-e2e-mail/*.json; do node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(m.to[0].address, "|", m.subject)' "$f"; done` |
| Secrets | Throwaway fixed literals for `JWT_SECRET`, `REFRESH_TOKEN_SECRET`, `CRYPT_SECRET`, `SCHEDULER_SECRET` and `WEBHOOK_SECRET`; the stage values in `.env` are never used. A throwaway VAPID pair is generated once with `web-push` into `/tmp/vn-e2e/vapid.json`. `WEB_PUSH_CONTACT` is `mailto:vn-e2e@localhost.invalid`. The seed depends on none of these: it stores bcrypt password hashes only, and `CRYPT_SECRET` only encrypts ids in responses and token claims. Tokens survive a server restart. |
| Other integrations | See the integration table below. |
| Links | `FRONT_END_WEBSITE=http://localhost:3000`, `APP_BASE_PATH=http://localhost:8122` |

- **Check it is local.** The startup log shows `[e2e-server] db=hospitality_test_e2e@127.0.0.1…`.
  `lsof -nP -p <pid> -iTCP -a` should list only `127.0.0.1:5432` connections.
- **Why not `npm run dev`?** It would work with the same exports, but it runs `nodemon`,
  which restarts on every file edit in the worktree, and pipes through `pino-pretty`, so
  `$!` is not the node PID. It also does not load the mail and AWS sinks. The launcher is
  the supported path.

### Integrations

These are the scenarios' exposure to every outbound integration the backend has. **Neutralised** means no
packet leaves the machine.

| Integration | Where it is called | Status on the E2E run |
|---|---|---|
| Postgres | everywhere | **Neutralised.** `127.0.0.1:5432`, `hospitality_test_e2e` |
| S3 upload (PO, call-off, contract and addendum PDFs) | `uploadToS3`, `generateContractPdf` | **Neutralised.** Goes to the loopback AWS sink |
| EventBridge Scheduler, Lambda | RFQ publish scheduling (`app/helper/createSchedule.js`) | **Neutralised.** `AWS_ENDPOINT_URL` points at the sink. Not on the scenarios: the RFQ is seeded already published. |
| Email (nodemailer) | `sendMail` / `notificationMail` in `app/helper/common.js` | **Neutralised.** JSON files in `/tmp/vn-e2e-mail`. No SMTP. |
| WhatsApp / AiSensy, OTP SMS, Flux chat, `AI_BASE_URL` | notification and OTP helpers, AI chat | **Neutralised.** `127.0.0.1:9` refuses the connection, and the callers log and carry on. |
| OpenTelemetry export | `otel-instrument.mjs` | **Neutralised.** `127.0.0.1:4317` |
| Gemini (`generativelanguage.googleapis.com`) | `app/helper/processBOQWithAI.js`, the AI BOQ upload in RFQ create | **Not neutralised.** It would call Google with the dummy key `vn-e2e` and get rejected. Not on the scenarios: no RFQ is created from a BOQ. |
| Server-side fetches of stored S3 URLs | `axios.get(file_url)` in `arcVendorController` / `arcEvaluationController` (tech-envelope evidence), and `arcContractController` vendor-documents bundle | **Not neutralised.** The stored URLs are `https://vn-e2e-local.s3…amazonaws.com/…`, a bucket that does not exist, so they would reach AWS's public endpoint and fail. That is not stage. Not on the scenarios: no evidence or vendor documents are uploaded. |
| PO PDF company-logo fetch | `getBase64FromUrl` in `app/controllers/seo/seoController.js` (5 s timeout; on failure the PDF renders without a logo) | **Neutralised on the scenarios.** It runs only when the buyer company has a logo URL, and the seed sets none. Chromium itself renders self-contained HTML; see `app/util/pdfRenderer.js`. |
| Razorpay | seat payments (`/vendor-network/seats/pay`), hospitality subscriptions, paid RFQs | **Not neutralised.** Throwaway test-style keys (`rzp_test_vn_e2e`), so `api.razorpay.com` rejects them. Not on the scenarios: `NETWORK_SEAT_FEE_INR` defaults to 0, so no order is created, and the seeded subscriptions are already active. |
| Web push | `webpush.sendNotification` to subscriptions stored on `tbl_users` | **Not neutralised** if the browser subscribes: pushes would go to the browser vendor's push service, signed with the throwaway VAPID pair. Seeded users have no subscription. |

## 4. Point the frontend at it

The frontend reads the API base from `NEXT_PUBLIC_API_URL`; see `frontend/lib/axios.js`.
`frontend/lib/realtimeSocket.js` derives the socket origin from the same variable. The
frontend's `npm run dev` is `env-cmd -f .env.development next dev --turbopack`, and env-cmd
**does** override existing variables by default. So the override has to go through
`--no-override`:

```bash
cd frontend
NEXT_PUBLIC_API_URL=http://localhost:8122/api/v1 \
  npx env-cmd --no-override -f .env.development next dev --turbopack     # http://localhost:3000
```

The alternative is to run the backend on 8002 (`E2E_PORT=8002`), which is what
`.env.development` already points at. Do not do this if another backend is on 8002. CORS
is open because `CORS_ORIGINS` is unset.

## 5. Smoke test

```bash
B=http://localhost:8122/api/v1; UA='Mozilla/5.0 e2e'
login() { curl -s -A "$UA" -H 'Content-Type: application/json' -X POST "$B/users/login?conform=true" -d "$1"; }
HQ=$(login '{"email":"e2e.daikin.hq@example.com","password":"E2e@12345"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -A "$UA" -H "Authorization: Bearer $HQ" "$B/vendor-network/org"           # 200, org 95811 with HQ + Daikin UP
login '{"email":"e2e.daikin.person@example.com","password":"E2e@12345"}'          # status 1, user_type 11
login '{"employee_code":"E2EBUY01","password":"E2e@12345"}'                       # status 1, user_type 2
```

## 6. Scenario helpers

- **Close bidding so the buyer can finalize (scenario 5).** Finalization opens only after
  `bid_end_date`:
  ```sql
  UPDATE tbl_rfq
     SET bid_end_date = to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 hour', 'YYYY-MM-DD HH24:MI:SS')
   WHERE hotel_id = 95802 AND title LIKE '[E2E-VN]%';
  ```
  Run it with `psql -h 127.0.0.1 -d hospitality_test_e2e`.
- **ARC signing OTP (scenario 6).** The response of `request-otp` carries `data.dev_code`.
- **Expected tax on the UP call-off (scenario 8).** The supplier is Daikin UP (09) and the
  buyer is the Lucknow hotel (09). That is the same state, so the call-off shows CGST + SGST,
  not IGST, even though the contract principal is in MH.
- **Fresh start.** Re-run the seed. If that fails, run step 1 and then the seed.
