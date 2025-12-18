
# Workwise Hospitality – RBAC & User Management APIs (Combined Documentation)

## Overview

This document covers all backend APIs created for the Hospitality RBAC system in Workwise.

The system enables:
- Multi-company & multi-hotel user access
- Role Based Access Control (RBAC)
- Custom roles & permissions
- Department-based workflows
- Secure backend permission enforcement

---

## Authentication & Authorization

All APIs require:
- passportSignIn (JWT authentication)
- acl([7]) – Company Admin only

---

## 1. Get Departments
GET /departments

Fetch global departments used for workflow and approvals.

Response:
```json
{
  "status": true,
  "data": [
    { "id": 1, "title": "Procurement" },
    { "id": 2, "title": "Finance" }
  ]
}
```

---

## 2. Get Roles
GET /roles

Fetch all system and custom roles.

---

## 3. Get Permissions for Role
GET /roles/:roleId/permissions

Grouped permissions by resource.

---

## 4. Get All Permissions
GET /permissions

Used for role creation UI.

---

## 5. Create Custom Role
POST /roles

Request:
```json
{
  "title": "Custom Tender Manager",
  "description": "Can manage tenders",
  "permission_ids": [1,2,3]
}
```

---

## 6. Get Hospitality Entities
GET /hospitality/entities

Fetch hospitality companies and hotels.

---

## 7. Create / Update User (RBAC Enabled)

Supports:
- Multiple departments
- Scoped roles (company / hotel / department)

---

## 8. Permission Middleware – can()

Usage:
```js
can("tender.create")
```

---

## Database Tables
- tbl_users
- tbl_roles
- tbl_permissions
- tbl_role_permissions
- tbl_user_role_scopes
- tbl_hospitality_companies
- tbl_hospitality_company_hotels