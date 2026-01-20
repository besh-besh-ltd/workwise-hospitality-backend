# CLAUDE.md - Hospitality Procurement SaaS Backend

## Project Overview

**Project:** DeshTechnicos (Workwise Backend) - Hospitality Procurement SaaS
**Repository:** https://github.com/letsworkwise/workwise-backend
**Type:** Backend API Server
**Runtime:** Node.js (>=16.0.0) with ES Modules
**Port:** 8002

A multi-tenant hospitality procurement platform enabling companies and hotels to manage the complete procurement lifecycle: RFQ/Tender creation → Vendor bidding → Negotiation → Purchase Orders → Goods Receipt.

---

## Technology Stack

| Category | Technology |
|----------|------------|
| **Runtime** | Node.js 16+ (ES Modules) |
| **Framework** | Express.js 4.21.2 |
| **Database** | PostgreSQL (pg-promise 11.13.0) |
| **Authentication** | Passport.js + JWT (jsonwebtoken) |
| **Password Hashing** | bcryptjs 3.0.2 |
| **Validation** | Joi 17.13.3 + Celebrate 15.0.3 |
| **File Storage** | AWS S3 (@aws-sdk/client-s3 v3) |
| **File Upload** | Multer + multer-s3 |
| **PDF Generation** | Puppeteer 24.4.0 |
| **Templating** | Handlebars 4.7.8 |
| **Email** | Nodemailer 6.10.0 (SMTP) |
| **Real-time** | Socket.io 4.8.1 |
| **Push Notifications** | web-push 3.6.7 |
| **Payments** | Razorpay 2.9.6 |
| **Logging** | Winston 3.17.0 + daily rotation |
| **Error Tracking** | Sentry (@sentry/node 10.11.0) |
| **APM** | New Relic 12.22.0 |
| **Scheduling** | node-cron 3.0.3 |
| **Excel Export** | exceljs 4.4.0, xlsx 0.18.5 |

---

## Project Structure

```
/backend
├── server.js                    # Express app entry point
├── instrument.mjs               # Sentry instrumentation
├── newrelic.cjs                 # New Relic configuration
├── package.json                 # Dependencies & scripts
├── app/
│   ├── config/                  # Configuration files
│   │   ├── database.js          # PostgreSQL connection (pg-promise)
│   │   ├── passport.js          # Passport strategies
│   │   └── s3config.js          # AWS S3 client setup
│   ├── controllers/             # Route handlers (business logic)
│   │   ├── rfq/                 # RFQ/Tender management
│   │   ├── negotiation/         # Negotiation workflows
│   │   ├── po/                  # Purchase order management
│   │   ├── arc/                 # Award document generation
│   │   ├── rbac/                # Role & permission management
│   │   ├── general/             # Approval engine, hierarchy, geography
│   │   ├── users/               # User & hospitality company management
│   │   ├── products/            # Product catalog
│   │   └── ...
│   ├── models/                  # Database access layer (SQL queries)
│   │   ├── rfqModel.js          # RFQ/Quote queries
│   │   ├── negotiationModel.js  # Negotiation queries
│   │   ├── purchaseOrderModel.js# PO queries
│   │   ├── generalModel.js      # Approval & hierarchy queries
│   │   ├── rbacModel.js         # RBAC queries
│   │   ├── userModel.js         # User queries
│   │   └── ...
│   ├── routes/                  # API endpoint definitions
│   │   ├── rfq/                 # /api/v1/rfq/*
│   │   ├── negotiation/         # /api/v1/negotiation/*
│   │   ├── purchase_order/      # /api/v1/po/*
│   │   ├── arc/                 # /api/v1/arc/*
│   │   ├── rbac/                # /api/v1/rbac/*
│   │   ├── hospitality/         # /api/v1/hospitality/*
│   │   └── ...
│   ├── middleware/              # Auth, ACL, request processing
│   │   ├── acl.js               # Role-based access control
│   │   ├── can.js               # Fine-grained permission checks
│   │   └── ...
│   ├── services/                # External service integrations
│   │   └── notificationService.js
│   ├── helper/                  # Utilities & email templates
│   │   ├── common.js            # sendMail, utilities
│   │   ├── cronManager.js       # Scheduled task management
│   │   ├── jwtHelper.js         # JWT utilities
│   │   └── notificationEmailLayout.js
│   ├── validations/             # Joi validation schemas
│   ├── storage/                 # File storage handling
│   └── util/                    # Constants, logger, error handling
│       ├── constants.js         # Status codes, enums
│       ├── logger.js            # Winston logger setup
│       ├── error.js             # Error handler middleware
│       └── socket.js            # Socket.io configuration
├── tests/                       # Jest test files
└── public.md, hospitality.md    # API documentation
```

---

## Core Modules

### 1. RFQ/Tender Management
**Location:** `app/controllers/rfq/`, `app/models/rfqModel.js`

**Features:**
- Create, publish, and manage RFQs and Tenders (`is_tender` flag)
- Multi-vendor bidding with quote submission
- Vendor clarification system (one active clarification at a time)
- Quote blocking during open clarifications
- AI-based BOQ processing
- Draft auto-save functionality
- Quote evaluation and finalization

**Key Tables:** `tbl_rfq`, `tbl_rfq_products`, `tbl_rfq_products_specs`, `tbl_quote`, `tbl_quote_items`, `tbl_quote_activity`, `tbl_quote_finalization`, `tbl_rfq_clarifications`

### 2. Negotiation Module
**Location:** `app/controllers/negotiation/`, `app/models/negotiationModel.js`

**Features:**
- Multi-round negotiation workflows
- Select winning vendors from finalized quotes
- Approval-based quote finalization
- Post-approval: ARC document generation for tenders
- Negotiation lifecycle tracking

**Key Tables:** `tbl_negotiation_rounds`, `tbl_negotiation_round_vendors`, `tbl_negotiation_round_quotes`

### 3. Purchase Order (PO) Module
**Location:** `app/controllers/po/`, `app/models/purchaseOrderModel.js`

**Status Workflow:**
```
draft → pending_approval → approved → sent → GRN → completed
                                           ↘ cancelled
```

**Features:**
- PO creation from finalized quotes
- Milestone management (delivery, payment)
- GRN (Goods Receipt Note) tracking
- Invoice raising
- GST & HSN code management
- Vendor email notifications

**Key Tables:** `tbl_purchase_orders`, `tbl_po_items`, `tbl_po_milestones`, `tbl_po_tasks`, `tbl_grn`, `tbl_vendor_invoices`

### 4. Award & Recognition (ARC)
**Location:** `app/controllers/arc/`

**Features:**
- PDF document generation via Puppeteer (headless Chrome)
- Handlebars template rendering
- S3 upload with metadata logging
- Applicable only for tenders (`is_tender = 1`)

**Process:** Fetch RFQ data → Render Handlebars template → Generate PDF → Upload to S3 → Store metadata

### 5. Approval Engine
**Location:** `app/controllers/general/hospitalityApprovalController.js`, `app/models/generalModel.js`

**Supported Entity Types:**
- `RFQ`, `PO`, `INDENT`, `ARC`, `NEGOTIATION`, `NEGOTIATION_QUOTE`, `TECHNICAL`

**Policy Hierarchy (most specific wins):**
```
Company + Hotel + Department > Company + Hotel > Company only
```

**Decision Rules:**
- `ANY` - One approver approval is sufficient
- `ALL` - All approvers must approve

**Approver Sources:** `USER`, `ROLE`, `DEPARTMENT`

**Instance Status:** `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`

**Post-Approval Actions:**
- **ARC:** Generate award PDF, upload to S3
- **NEGOTIATION:** Add selected quotes to finalization
- **NEGOTIATION_QUOTE:** Move quotes to finalization
- **PO:** Update status to approved
- **TECHNICAL:** Update RFQ status

**Key Tables:** `tbl_approval_policies`, `tbl_approval_policy_steps`, `tbl_approval_instances`, `tbl_approval_instance_steps`, `tbl_approval_step_approvers`, `tbl_approval_actions`

### 6. RBAC (Role-Based Access Control)
**Location:** `app/controllers/rbac/`, `app/models/rbacModel.js`

**Permission Model:** `resource.action` (e.g., `tender.create`, `po.read`)

**Role Types:**
- **System Roles:** Read-only (`created_by = null`)
- **Custom Roles:** User-created, editable by creator

**Scope Levels:** Company → Hotel → Department

**Multi-Hotel Support:** Via `x-hotel-ids` header (comma-separated)

**Key Tables:** `tbl_roles`, `tbl_permissions`, `tbl_role_permissions`, `tbl_user_role_scopes`, `tbl_user_department`, `tbl_department`

### 7. Hospitality Companies & Hotels
**Location:** `app/controllers/users/hospitalityController.js`

**Features:**
- Multi-company and multi-hotel management
- Company/hotel registration with documents
- User-to-company/hotel mapping
- Project-to-company/hotel mapping
- Hospitality vendor profiles (`is_hospitality` flag)

**Key Tables:** `tbl_hospitality_companies`, `tbl_hospitality_company_hotels`, `tbl_hospitality_company_users`, `tbl_hospitality_company_projects`

---

## API Conventions

### Route Prefix
All API routes are prefixed with `/api/v1/`

### Response Format
```javascript
// Success (status: 1)
{
  "status": 1,
  "message": "Success message",
  "data": { /* payload */ }
}

// Not Found (status: 2)
{
  "status": 2,
  "message": "Resource not found"
}

// Error (status: 3)
{
  "status": 3,
  "message": "Error description"
}

// Business Logic Error (status: 0)
{
  "status": 0,
  "message": "Validation or business rule failure"
}
```

### Common Headers
```
Authorization: Bearer <jwt_token>
x-company-id: <company_id>
x-hotel-id: <hotel_id>
x-hotel-ids: <comma_separated_hotel_ids>  # For multi-hotel operations
```

---

## Authentication & Authorization

### Authentication Strategies (Passport.js)
- `localUsr` - User email/password login
- `localAdm` - Admin username/password login
- `jwtUsr` - JWT token validation

### Authorization Middleware

```javascript
// JWT authentication (required for protected routes)
passportSignIn

// Role-based access (whitelist)
acl([2, 8])  // Only roles 2 (Buyer) and 8 (Super Admin)

// Role-based access (blacklist)
noAcl([3])   // All except role 3 (Guest)

// Fine-grained permission check (OR logic - at least one)
can('tender.create')
can(['rfq.create', 'tender.create'])

// Fine-grained permission check (AND logic - all required)
can(['rfq.create', 'tender.create'], true)
```

### Permission Check Flow
1. Extract user ID from `req.user`
2. Get company ID from header or user profile
3. Get hotel ID(s) from header
4. Query `tbl_user_role_scopes` for user's roles
5. Join with `tbl_role_permissions` → `tbl_permissions`
6. Check if required permission exists

---

## Database Patterns

### Query Execution (pg-promise)
```javascript
const db = require('./config/database');

// Multiple rows
const rows = await db.any('SELECT * FROM tbl_rfq WHERE company_id = $1', [companyId]);

// Single row (throws if not found)
const row = await db.one('SELECT * FROM tbl_rfq WHERE id = $1', [id]);

// Single row or null
const row = await db.oneOrNone('SELECT * FROM tbl_rfq WHERE id = $1', [id]);

// Execute without return
await db.none('UPDATE tbl_rfq SET status = $1 WHERE id = $2', [status, id]);

// Get result with rowCount
const result = await db.result('DELETE FROM tbl_rfq WHERE id = $1', [id]);
console.log(result.rowCount); // Number of affected rows
```

### Transaction Pattern
```javascript
await db.tx(async t => {
  const rfq = await t.one('INSERT INTO tbl_rfq (...) VALUES (...) RETURNING *', [...]);
  await t.none('INSERT INTO tbl_rfq_products (...) VALUES (...)', [rfq.id, ...]);
  await t.none('INSERT INTO tbl_approval_instances (...) VALUES (...)', [rfq.id, ...]);
  return rfq;
});
```

---

## Key Integrations

### AWS S3
**Config:** `app/config/s3config.js`
```javascript
// Upload file
const { PutObjectCommand } = require('@aws-sdk/client-s3');
await s3Client.send(new PutObjectCommand({ Bucket, Key, Body }));

// Generate signed URL for download
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
```

### Email (Nodemailer)
**Helper:** `app/helper/common.js`
```javascript
const { sendMail } = require('../helper/common');
await sendMail({
  to: 'user@example.com',
  subject: 'Subject',
  html: '<p>Email content</p>'
});
```

### PDF Generation (Puppeteer)
```javascript
const puppeteer = require('puppeteer');
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(htmlContent);
const pdfBuffer = await page.pdf({ format: 'A4', margin: { top: '1cm', ... } });
await browser.close();
```

---

## Environment Variables

```bash
# Server
NODE_ENV=production|development
PORT=3200

# Database
DATABASE_USERNAME=
DATABASE_PASSWORD=
DATABASE_NAME=
HOST=
DATABASE_PORT=

# AWS S3
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=

# Security
JWT_SECRET=
CRYPT_SECRET=

# Email (SMTP)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
FROM_EMAIL=

# Monitoring
SENTRY_DSN=
NEW_RELIC_LICENSE_KEY=

# Payments
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=

# Push Notifications
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
```

---

## Common Commands

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Start production server
npm start

# Run tests
npm test
```

---

## Important Notes

1. **Multi-Tenancy:** The system supports multiple companies, each with multiple hotels and departments. Always consider scope (company/hotel/department) when querying data.

2. **Tender vs RFQ:** Tenders (`is_tender = 1`) have additional features like ARC document generation and specialized approval flows.

3. **Clarification Rules:** Only one clarification can be open at a time per RFQ. Quote submission is blocked while clarification is pending.

4. **Approval Hierarchy:** When matching approval policies, the most specific match wins (Company+Hotel+Department > Company+Hotel > Company).

5. **Post-Approval Actions:** After approval completion, entity-specific actions are triggered (e.g., ARC generation for tenders, PO status update).

6. **Parameterized Queries:** All database queries use pg-promise parameterized syntax (`$1`, `$2`, etc.) to prevent SQL injection.

7. **File Storage:** All file uploads go to AWS S3. Signed URLs are generated for secure downloads.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Express Server (Port 3200)                  │
├─────────────────────────────────────────────────────────────────┤
│  Middleware: Helmet │ CORS │ Compression │ Winston │ Passport   │
├─────────────────────────────────────────────────────────────────┤
│                      Routes (/api/v1/*)                         │
│  /rfq │ /negotiation │ /po │ /arc │ /rbac │ /hospitality │ ... │
├─────────────────────────────────────────────────────────────────┤
│                       Controllers                               │
│            (Business logic, validation, responses)              │
├─────────────────────────────────────────────────────────────────┤
│                         Models                                  │
│              (pg-promise SQL queries, transactions)             │
├─────────────────────────────────────────────────────────────────┤
│                       PostgreSQL                                │
└─────────────────────────────────────────────────────────────────┘
        │                    │                    │
   ┌────┴────┐         ┌─────┴─────┐       ┌─────┴─────┐
   │  AWS S3  │         │ Nodemailer │       │ Socket.io │
   │ Storage  │         │   Email    │       │ Real-time │
   └──────────┘         └───────────┘       └───────────┘
```

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `server.js` | Application entry point |
| `app/config/database.js` | PostgreSQL connection |
| `app/config/passport.js` | Authentication strategies |
| `app/middleware/can.js` | RBAC permission middleware |
| `app/controllers/general/hospitalityApprovalController.js` | Approval engine |
| `app/controllers/rfq/rfqController.js` | RFQ/Tender operations |
| `app/controllers/negotiation/negotiationController.js` | Negotiation workflows |
| `app/controllers/po/purchaseOrderController.js` | PO management |
| `app/controllers/arc/arcDocumentController.js` | ARC PDF generation |
| `app/models/generalModel.js` | Approval & hierarchy queries |
| `app/util/constants.js` | Status codes & enums |
