
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

## 4. Get All Permissions (Grouped)
GET /permissions

Fetch all permissions grouped by resource, used for custom role creation UI.

Response:
```json
{
  "status": true,
  "data": {
    "tender": [
      { "id": 1, "action": "read" },
      { "id": 2, "action": "create" }
    ],
    "project": [
      { "id": 3, "action": "read" }
    ]
  }
}
```

---

## 5. Create Custom Role
POST /roles

Create a custom role and assign permissions in a single request.

Request:
```json
{
  "title": "Custom Tender Manager",
  "description": "Can manage tenders",
  "permission_ids": [1, 2, 3]
}
```

Response:
```json
{
  "status": true,
  "message": "Role created successfully",
  "data": {
    "role_id": 10
  }
}
```

---

## 6. Get User Role Scopes
GET /users/:userId/roles

Fetch all role scopes (company / hotel / department) assigned to a user.

Response:
```json
{
  "status": true,
  "data": [
    {
      "id": 1,
      "user_id": 5,
      "role_id": 10,
      "role_title": "Custom Tender Manager",
      "company_id": 3,
      "hotel_id": null,
      "department_id": 1
    }
  ]
}
```

---

## 7. Get Hospitality Entities
GET /hospitality/entities

Fetch hospitality companies and hotels.

---

## 8. Create / Update User (RBAC Enabled)

Supports:
- Multiple departments
- Scoped roles (company / hotel / department)

---

## 9. Permission Middleware – can()

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