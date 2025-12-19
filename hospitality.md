# Workwise Hospitality – RBAC & User Management APIs (Combined Documentation)

## Overview

This document covers **all backend APIs** created for the **Hospitality RBAC system** in Workwise.

The system enables:

* Multi-company & multi-hotel user access
* Role Based Access Control (RBAC)
* Custom roles & permissions
* Department-based workflows
* Secure backend permission enforcement

This RBAC model is **enterprise-grade**, backend-authoritative, and future-ready.

---

## Authentication & Authorization

All APIs require:

* `passportSignIn` (JWT authentication)
* `acl([7])` – Company Admin only

| Scenario                | Response         |
| ----------------------- | ---------------- |
| Not logged in           | 401 Unauthorized |
| Logged in but not admin | 403 Forbidden    |

---

## 1. Get Departments

**GET** `/departments`

Fetch global departments used for workflow and approvals.

### Response

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

**GET** `/roles`

Fetch **all system roles and custom roles** available for assignment.

### Notes

* Roles with `created_by = null` → **System roles**
* Roles with `created_by != null` → **User-created custom roles**

---

## 3. Get Permissions for Role

**GET** `/roles/:roleId/permissions`

Fetch permissions assigned to a role, grouped by resource.

### Response

```json
{
  "status": true,
  "data": {
    "tender": ["read", "create", "approve"],
    "po": ["read"]
  }
}
```

---

## 4. Get All Permissions (Grouped)

**GET** `/permissions`

Fetch **all available permissions**, grouped by resource.
Used for **custom role creation and editing UI**.

### Response

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

### 4.1. Get My Permissions (Grouped)

**GET** `/me/permissions`

Fetch **all my permissions**, grouped by resource.

### Response

```json
{
  "status": true,
  "data": {
    "tender": ["read", "create", "update", "delete", "approve"],
    "rfq": ["read", "create", "delete"]
  }
}
```

---

## 5. Create Custom Role

**POST** `/roles`

Create a custom role and assign permissions in a single request.

### Request

```json
{
  "title": "Custom Tender Manager",
  "description": "Can manage tenders",
  "permission_ids": [1, 2, 3]
}
```

### Response

```json
{
  "status": true,
  "message": "Role created successfully",
  "data": {
    "role_id": 10
  }
}
```

### Notes

* Role will have `created_by = logged_in_user_id`
* Custom roles are editable by their creator

---

## 6. Update Custom Role (NEW)

**PUT** `/roles/:roleId`

Edit an **existing custom role** and replace its permissions.

### Rules (Very Important)

* ✅ Only roles with `created_by != null` can be edited
* ✅ Only the **creator of the role** can edit it
* ❌ System roles (`created_by = null`) **cannot be modified**

---

### Request

```json
{
  "title": "Custom Tender Manager v2",
  "description": "Updated tender permissions",
  "permission_ids": [1, 2, 5]
}
```

### Response

```json
{
  "status": true,
  "message": "Role updated successfully"
}
```

### Error Scenarios

**System Role**

```json
{
  "status": false,
  "message": "System roles cannot be modified"
}
```

**Not Role Owner**

```json
{
  "status": false,
  "message": "You are not allowed to edit this role"
}
```

---

## 7. Get User Role Scopes

**GET** `/users/:userId/roles`

Fetch all role scopes (company / hotel / department) assigned to a user.

### Response

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

## 8. Get Hospitality Entities

**GET** `/hospitality/entities`

Fetch hospitality companies and hotels used for **RBAC scope selection**.

---

## 9. Create / Update User (RBAC Enabled)

User management APIs support:

* Multiple departments per user
* Multiple roles per user
* Role scopes:

  * Company-level
  * Hotel-level
  * Department-level

### RBAC Payload Example

```json
{
  "department_ids": [1, 3],
  "roles": [
    {
      "role_id": 10,
      "company_id": 3,
      "hotel_id": 12,
      "department_id": 1
    }
  ]
}
```

---

## 10. Permission Middleware – `can()`

Backend authorization middleware enforcing RBAC.

### Usage

```js
can("tender.create")
can("po.read")
```

### What It Does

* Extracts user from `req.user`
* Resolves company & hotel context
* Validates role → permission mapping
* Allows or blocks request

### Enforcement

* Backend-authoritative
* UI permissions alone do **not** grant access

---

## Database Tables

| Table                          | Purpose                 |
| ------------------------------ | ----------------------- |
| tbl_users                      | User master             |
| tbl_department                 | Global departments      |
| tbl_user_department            | User-department mapping |
| tbl_roles                      | System & custom roles   |
| tbl_permissions                | Atomic permissions      |
| tbl_role_permissions           | Role-permission mapping |
| tbl_user_role_scopes           | User-role scoped access |
| tbl_hospitality_companies      | Hospitality companies   |
| tbl_hospitality_company_hotels | Hotels                  |

---

## Design Principles

* Roles define **capability**
* Permissions define **actions**
* Scope defines **where access applies**
* Backend is the **single source of truth**
* Customization without compromising security

---

## Final Summary

✔ Multi-tenant hospitality-ready RBAC
✔ Custom roles with ownership protection
✔ Fine-grained permission enforcement
✔ Secure backend-first design
✔ Scales for enterprise clients

---

**End of Document**