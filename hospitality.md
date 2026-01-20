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

## 7.1. Get My Departments

**GET** `/users/me/departments`

Fetch departments assigned to the currently logged-in user.

### Authentication

* Requires `passportSignIn` (JWT authentication)
* No admin role required (any authenticated user)

### Response

```json
{
  "status": true,
  "data": [
    { "id": 1, "title": "department 1" },
    { "id": 3, "title": "department 2" }
  ]
}
```

### Use Case

Used to filter department dropdowns in role scope selectors to only show departments the user is assigned to.

---

## 7.2. Get User Departments

**GET** `/rbac/users/:userId/departments`

Fetch departments assigned to a specific user (admin only).

### Authentication

* Requires `passportSignIn` (JWT authentication)
* Requires `acl([7])` – Company Admin only

### Response

```json
{
  "status": true,
  "data": [
    { "id": 1, "title": "Department 1" },
    { "id": 3, "title": "Department 2" }
  ]
}
```

### Use Case

Used in edit user modals to filter department options based on the user's current department assignments.

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

## Hospitality Approval Engine

The Hospitality Approval Engine provides a flexible, multi-step approval workflow system for hospitality entities (RFQ, PO, INDENT, etc.). It supports hierarchical policy matching based on company, hotel, and department scope.

### Key Concepts

- **Policy**: Defines approval workflow rules for a specific scope (company/hotel/department)
- **Policy Steps**: Individual approval steps within a policy with approver assignments
- **Instance**: A runtime approval request for a specific entity
- **Decision Rules**: `ALL` (all approvers must approve) or `ANY` (one approver is sufficient)
- **Approver Source Types**: `USER`, `ROLE`, or `DEPARTMENT`

### Policy Hierarchy (Deepest Match Wins)

1. Company + Hotel + Department (most specific)
2. Company + Hotel
3. Company only (least specific)

---

## Approval Policy Management

### 1. Create/Update Approval Policy

**POST** `/general/hospitality/approval/policies`

Create a new approval policy or update an existing one with its steps.

#### Authentication

- Requires `passportSignIn` (JWT authentication)
- Requires `acl([7])` – Company Admin only

#### Request Body

```json
{
  "id": null,
  "entity_type": "RFQ",
  "hospitality_company_id": 1,
  "hotel_id": 5,
  "department_id": 2,
  "is_active": true,
  "steps": [
    {
      "step_order": 1,
      "approval_type": "STANDARD",
      "decision_rule": "ANY",
      "approver_source_type": "ROLE",
      "approver_source_id": 10
    },
    {
      "step_order": 2,
      "approval_type": "STANDARD",
      "decision_rule": "ALL",
      "approver_source_type": "USER",
      "approver_source_id": 25
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | number | No | Policy ID for update (omit for create) |
| `entity_type` | string | Yes | Entity type: `RFQ`, `PO`, `INDENT`, etc. |
| `hospitality_company_id` | number | Yes | Hospitality company ID |
| `hotel_id` | number | No | Hotel ID for hotel-specific policy |
| `department_id` | number | No | Department ID for dept-specific policy |
| `is_active` | boolean | No | Policy active status (default: true) |
| `steps` | array | No | Array of policy steps |
| `steps[].step_order` | number | No | Step execution order (auto-assigned if omitted) |
| `steps[].approval_type` | string | No | Step type (default: `STANDARD`) |
| `steps[].decision_rule` | string | No | `ALL` or `ANY` (default: `ANY`) |
| `steps[].approver_source_type` | string | Yes | `USER`, `ROLE`, or `DEPARTMENT` |
| `steps[].approver_source_id` | number | Yes | ID of user/role/department |

#### Response (201 Created / 200 OK)

```json
{
  "status": 1,
  "data": {
    "id": 15,
    "entity_type": "RFQ",
    "hospitality_company_id": 1,
    "hotel_id": 5,
    "department_id": 2,
    "is_active": true,
    "created_by": 10,
    "created_at": "2025-01-15T10:00:00Z",
    "company_name": "Grand Hotels",
    "hotel_name": "Grand Hotel Downtown",
    "department_name": "Procurement",
    "created_by_name": "John Admin",
    "steps": [
      {
        "id": 101,
        "approval_policy_id": 15,
        "step_order": 1,
        "approval_type": "STANDARD",
        "decision_rule": "ANY",
        "approver_source_type": "ROLE",
        "approver_source_id": 10,
        "approver_source_name": "Procurement Manager"
      }
    ]
  }
}
```

#### Error Response

```json
{
  "status": 3,
  "message": "An active policy already exists for this scope. Policy ID: 12"
}
```

---

### 2. Get Approval Policies

**GET** `/general/hospitality/approval/policies`

Fetch approval policies with optional filtering.

#### Authentication

- Requires `passportSignIn` (JWT authentication)
- Requires `acl([7])` – Company Admin only

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `hospitality_company_id` | number | Filter by company |
| `hotel_id` | number | Filter by hotel |
| `department_id` | number | Filter by department |
| `entity_type` | string | Filter by entity type |
| `include_inactive` | boolean | Include inactive policies (default: false) |

#### Response

```json
{
  "status": 1,
  "data": [
    {
      "id": 15,
      "entity_type": "RFQ",
      "hospitality_company_id": 1,
      "hotel_id": 5,
      "department_id": 2,
      "is_active": true,
      "created_by": 10,
      "created_at": "2025-01-15T10:00:00Z",
      "company_name": "Grand Hotels",
      "hotel_name": "Grand Hotel Downtown",
      "department_name": "Procurement",
      "created_by_name": "John Admin",
      "specificity_score": 3
    }
  ]
}
```

---

### 3. Get Single Approval Policy

**GET** `/general/hospitality/approval/policies/:id`

Fetch a single policy with all its steps.

#### Authentication

- Requires `passportSignIn` (JWT authentication)
- Requires `acl([7])` – Company Admin only

#### Response

```json
{
  "status": 1,
  "data": {
    "id": 15,
    "entity_type": "RFQ",
    "hospitality_company_id": 1,
    "hotel_id": 5,
    "department_id": 2,
    "is_active": true,
    "company_name": "Grand Hotels",
    "hotel_name": "Grand Hotel Downtown",
    "department_name": "Procurement",
    "created_by_name": "John Admin",
    "steps": [
      {
        "id": 101,
        "approval_policy_id": 15,
        "step_order": 1,
        "approval_type": "STANDARD",
        "decision_rule": "ANY",
        "approver_source_type": "ROLE",
        "approver_source_id": 10,
        "approver_source_name": "Procurement Manager"
      },
      {
        "id": 102,
        "approval_policy_id": 15,
        "step_order": 2,
        "approval_type": "STANDARD",
        "decision_rule": "ALL",
        "approver_source_type": "USER",
        "approver_source_id": 25,
        "approver_source_name": "Jane Finance"
      }
    ]
  }
}
```

---

### 4. Delete Approval Policy

**DELETE** `/general/hospitality/approval/policies/:id`

Soft delete (deactivate) an approval policy.

#### Authentication

- Requires `passportSignIn` (JWT authentication)
- Requires `acl([7])` – Company Admin only

#### Response

```json
{
  "status": 1,
  "message": "Policy deactivated successfully"
}
```

#### Error Response

```json
{
  "status": 3,
  "message": "Cannot delete policy: 5 pending approval(s) exist"
}
```

---

### 5. Find Matching Policy

**GET** `/general/hospitality/approval/policies/match`

Find the best matching policy for a given scope (deepest match wins).

#### Authentication

- Requires `passportSignIn` (JWT authentication)

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | Yes | Entity type: `RFQ`, `PO`, etc. |
| `hospitality_company_id` | number | Yes | Company ID |
| `hotel_id` | number | No | Hotel ID |
| `department_id` | number | No | Department ID |

#### Response

```json
{
  "status": 1,
  "data": {
    "id": 15,
    "entity_type": "RFQ",
    "hospitality_company_id": 1,
    "hotel_id": 5,
    "department_id": 2,
    "steps": [...]
  }
}
```

#### No Match Response (404)

```json
{
  "status": 2,
  "message": "No matching policy found"
}
```

---

## Approval Instance Management

### 6. Submit for Approval

**POST** `/general/hospitality/approval/submit`

Submit an entity for approval. Auto-detects the best matching policy if not specified.

#### Authentication

- Requires `passportSignIn` (JWT authentication)
- Requires `noAcl([3])` – Excludes guest users

#### Request Body

```json
{
  "entity_type": "RFQ",
  "entity_id": 1234,
  "hospitality_company_id": 1,
  "hotel_id": 5,
  "department_id": 2,
  "approval_policy_id": null,
  "metadata": {
    "rfq_number": "RFQ-2025-001",
    "total_value": 50000,
    "description": "Kitchen equipment procurement"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `entity_type` | string | Yes | Type of entity |
| `entity_id` | number | Yes | ID of the entity |
| `hospitality_company_id` | number | Yes | Company ID |
| `hotel_id` | number | No | Hotel ID |
| `department_id` | number | No | Department ID |
| `approval_policy_id` | number | No | Specific policy to use (auto-detect if null) |
| `metadata` | object | No | Additional data to store with the instance |

#### Response (201 Created)

```json
{
  "status": 1,
  "data": {
    "instance": {
      "id": 500,
      "entity_type": "RFQ",
      "entity_id": 1234,
      "approval_policy_id": 15,
      "status": "PENDING",
      "current_step": 1,
      "initiated_by": 10,
      "hospitality_company_id": 1,
      "hotel_id": 5,
      "department_id": 2,
      "metadata": {...},
      "created_at": "2025-01-15T10:00:00Z"
    },
    "policy": {
      "id": 15,
      "entity_type": "RFQ"
    },
    "steps": [
      {
        "id": 1001,
        "step_order": 1,
        "decision_rule": "ANY",
        "status": "PENDING",
        "approverCount": 3
      },
      {
        "id": 1002,
        "step_order": 2,
        "decision_rule": "ALL",
        "status": "PENDING",
        "approverCount": 1
      }
    ],
    "totalSteps": 2
  }
}
```

#### Error Responses

```json
{
  "status": 3,
  "message": "A pending approval instance already exists. Instance ID: 499"
}
```

```json
{
  "status": 3,
  "message": "No approval policy found for RFQ in this scope"
}
```

---

### 7. Get Pending Approvals

**GET** `/general/hospitality/approval/pending`

Get all pending approvals where the current user is an approver.

#### Authentication

- Requires `passportSignIn` (JWT authentication)

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `hospitality_company_id` | number | Filter by company |
| `hotel_id` | number | Filter by hotel |
| `entity_type` | string | Filter by entity type |

#### Response

```json
{
  "status": 1,
  "data": [
    {
      "instance_id": 500,
      "entity_type": "RFQ",
      "entity_id": 1234,
      "current_step": 1,
      "created_at": "2025-01-15T10:00:00Z",
      "metadata": {
        "rfq_number": "RFQ-2025-001",
        "total_value": 50000
      },
      "step_id": 1001,
      "decision_rule": "ANY",
      "hospitality_company_id": 1,
      "policy_hotel_id": 5,
      "company_name": "Grand Hotels",
      "hotel_name": "Grand Hotel Downtown",
      "initiated_by_name": "John Requester"
    }
  ]
}
```

---

### 8. Get Approval Instance Details

**GET** `/general/hospitality/approval/instance/:id`

Get detailed information about an approval instance including all steps, approvers, and action history.

#### Authentication

- Requires `passportSignIn` (JWT authentication)

#### Response

```json
{
  "status": 1,
  "data": {
    "id": 500,
    "entity_type": "RFQ",
    "entity_id": 1234,
    "status": "PENDING",
    "current_step": 1,
    "total_steps": 2,
    "initiated_by": {
      "user_id": 10,
      "name": "John Requester",
      "email": "john@example.com"
    },
    "policy": {
      "id": 15,
      "hospitality_company_id": 1,
      "hotel_id": 5,
      "department_id": 2
    },
    "scope": {
      "hospitality_company_id": 1,
      "company_name": "Grand Hotels",
      "hotel_id": 5,
      "hotel_name": "Grand Hotel Downtown",
      "department_id": 2,
      "department_name": "Procurement"
    },
    "metadata": {
      "rfq_number": "RFQ-2025-001",
      "total_value": 50000
    },
    "created_at": "2025-01-15T10:00:00Z",
    "completed_at": null,
    "can_user_approve": true,
    "user_approval_step_id": 1001,
    "steps": [
      {
        "id": 1001,
        "step_order": 1,
        "decision_rule": "ANY",
        "status": "PENDING",
        "approval_type": "STANDARD",
        "completed_at": null,
        "approvers": [
          {
            "user_id": 20,
            "user_name": "Manager A",
            "user_email": "manager.a@example.com",
            "status": "PENDING",
            "acted_at": null,
            "comment": null
          },
          {
            "user_id": 21,
            "user_name": "Manager B",
            "user_email": "manager.b@example.com",
            "status": "PENDING",
            "acted_at": null,
            "comment": null
          }
        ]
      },
      {
        "id": 1002,
        "step_order": 2,
        "decision_rule": "ALL",
        "status": "PENDING",
        "approval_type": "STANDARD",
        "completed_at": null,
        "approvers": [
          {
            "user_id": 25,
            "user_name": "Finance Director",
            "user_email": "finance@example.com",
            "status": "PENDING",
            "acted_at": null,
            "comment": null
          }
        ]
      }
    ],
    "action_history": []
  }
}
```

---

### 9. Get Entity Approvals

**GET** `/general/hospitality/approval/entity/:entity_type/:entity_id`

Get all approval instances for a specific entity.

#### Authentication

- Requires `passportSignIn` (JWT authentication)

#### Response

```json
{
  "status": 1,
  "data": [
    {
      "id": 500,
      "entity_type": "RFQ",
      "entity_id": 1234,
      "approval_policy_id": 15,
      "status": "PENDING",
      "current_step": 1,
      "initiated_by": 10,
      "created_at": "2025-01-15T10:00:00Z",
      "company_name": "Grand Hotels",
      "hotel_name": "Grand Hotel Downtown",
      "initiated_by_name": "John Requester"
    }
  ]
}
```

---

### 10. Submit Approval Action

**POST** `/general/hospitality/approval/action`

Submit an approval or rejection action.

#### Authentication

- Requires `passportSignIn` (JWT authentication)

#### Request Body

```json
{
  "approval_instance_id": 500,
  "approval_instance_step_id": 1001,
  "action": "APPROVE",
  "comment": "Approved. Budget looks appropriate."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `approval_instance_id` | number | Yes | Instance ID |
| `approval_instance_step_id` | number | No | Step ID (auto-detected if omitted) |
| `action` | string | Yes | `APPROVE` or `REJECT` |
| `comment` | string | No | Optional comment |

#### Response - Approval Recorded, Waiting for Others

```json
{
  "status": 1,
  "data": {
    "status": "APPROVED",
    "instance_status": "PENDING",
    "step_status": "PENDING",
    "message": "Approval recorded. Waiting for all approvers."
  }
}
```

#### Response - Step Complete, Moving to Next

```json
{
  "status": 1,
  "data": {
    "status": "APPROVED",
    "instance_status": "PENDING",
    "step_status": "APPROVED",
    "next_step": 2,
    "next_step_id": 1002,
    "message": "Step 1 approved. Moving to step 2."
  }
}
```

#### Response - Fully Approved

```json
{
  "status": 1,
  "data": {
    "status": "APPROVED",
    "instance_status": "APPROVED",
    "step_status": "APPROVED",
    "message": "All steps completed. Approval request has been fully approved."
  }
}
```

#### Response - Rejected

```json
{
  "status": 1,
  "data": {
    "status": "REJECTED",
    "instance_status": "REJECTED",
    "message": "Approval request has been rejected"
  }
}
```

#### Error Responses

```json
{
  "status": 3,
  "message": "User is not an approver for this step"
}
```

```json
{
  "status": 3,
  "message": "Cannot act on instance with status: APPROVED"
}
```

---

### 11. Cancel Approval

**POST** `/general/hospitality/approval/cancel`

Cancel a pending approval instance.

#### Authentication

- Requires `passportSignIn` (JWT authentication)

#### Request Body

```json
{
  "instance_id": 500,
  "reason": "RFQ requirements changed, needs re-submission"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instance_id` | number | Yes | Instance ID to cancel |
| `reason` | string | No | Cancellation reason |

#### Response

```json
{
  "status": 1,
  "data": {
    "status": "CANCELLED",
    "message": "Approval instance cancelled"
  }
}
```

#### Error Response

```json
{
  "status": 3,
  "message": "Cannot cancel instance with status: APPROVED"
}
```

---

## Approval Engine Database Tables

| Table | Purpose |
|-------|---------|
| `tbl_approval_policies` | Policy definitions with scope |
| `tbl_approval_policy_steps` | Steps within a policy |
| `tbl_approval_instances` | Runtime approval instances |
| `tbl_approval_instance_steps` | Runtime steps for an instance |
| `tbl_approval_step_approvers` | Approvers assigned to each step |
| `tbl_approval_actions` | Audit log of all actions |

---

## Instance Status Values

| Status | Description |
|--------|-------------|
| `PENDING` | Awaiting approval actions |
| `APPROVED` | All steps completed successfully |
| `REJECTED` | Rejected by an approver |
| `CANCELLED` | Cancelled by requester |

---

## Step Status Values

| Status | Description |
|--------|-------------|
| `PENDING` | Awaiting approver actions |
| `APPROVED` | Step completed successfully |
| `REJECTED` | Step rejected |
| `CANCELLED` | Step cancelled |

---

## Approver Status Values

| Status | Description |
|--------|-------------|
| `PENDING` | Approver hasn't acted |
| `APPROVED` | Approver approved |
| `REJECTED` | Approver rejected |

---

## Tender Clarification Chat/Ticket System

The Tender Clarification System allows vendors to raise clarifications on tenders, with a chat/ticket-style conversation where both parties can send multiple messages until the issue is resolved.

### Key Concepts

- **One-at-a-Time Rule**: Only one clarification can be OPEN per tender at any time
- **Chat System**: Both vendor (who raised) and buyer (tender creator) can send multiple messages
- **Manual Close**: Tender creator manually closes the clarification when satisfied
- **Private Visibility**: Clarifications are private between the vendor who raised it and the tender creator
  - **Buyer (tender creator)**: Sees ALL clarifications with all messages
  - **Vendor who raised**: Sees only their OWN clarifications with all messages
  - **Other vendors**: Only see `has_open: true` to know a clarification is in progress (no details)
- **Quote Blocking**: ALL vendors cannot submit/update quotes while ANY clarification is OPEN
- **Clarification Period**: Vendors can only raise clarifications between `tender_publish_date` and `vendor_clarification_date`

### Status Values

| Status | Description |
|--------|-------------|
| `OPEN` | Clarification raised, conversation ongoing |
| `CLOSED` | Buyer has closed the clarification, vendors can submit quotes |

---

### Quick Reference (Frontend)

#### Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/rfq/clarification/raise` | Vendor | Raise new clarification (starts thread) |
| POST | `/rfq/clarification/message` | Both | Send message in thread |
| POST | `/rfq/clarification/resolve` | Buyer (ACL 2,8) | Close clarification (optional final message) |
| GET | `/rfq/clarifications/:rfq_id` | Both | List clarifications with messages |
| GET | `/rfq/clarification/active/:rfq_id` | Both | Check active clarification with messages |

#### Clarification Object (with Messages)

```typescript
{
  id: number,
  rfq_id: number,
  raised_by_vendor_id: number,
  raised_by_vendor_name: string,
  subject: string,
  status: 'OPEN' | 'CLOSED',
  created_at: datetime,
  closed_at: datetime | null,
  closed_by: number | null,
  messages: [
    {
      id: number,
      sender_id: number,
      sender_type: 'VENDOR' | 'BUYER',
      sender_name: string,
      message: string,
      files: { file_url: string, file_name: string }[],
      created_at: datetime
    }
  ]
}
```

#### Privacy Matrix

| User Type | `clarifications` | `open_clarification` / `data` | `has_open` |
|-----------|------------------|-------------------------------|------------|
| Buyer | All with messages | Full details with messages | true/false |
| Own Vendor | Own only with messages | Full details with messages | true/false |
| Other Vendor | `[]` | `null` | true/false |

> `has_open: true` always indicates quote submission is blocked, regardless of who raised it.

---

### 1. Raise Clarification (Vendor)

**POST** `/rfq/clarification/raise`

Vendor raises a new clarification for a tender. The initial question becomes the first message in the conversation thread.

#### Authentication

- Requires vendor authentication (`noLogin.customer_auth`)
- Vendor must have access to the RFQ

#### Request Body (multipart/form-data)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `rfq_id` | number | Yes | Tender ID |
| `subject` | string | Yes | Brief subject (5-200 chars) |
| `question` | string | Yes | Initial question message (10-5000 chars) |
| `files` | File[] | No | Supporting documents (max 10 files, 100MB each) |

#### Response (200 OK)

```json
{
  "status": 1,
  "message": "Clarification raised successfully",
  "data": {
    "id": 123,
    "rfq_id": 456,
    "raised_by_vendor_id": 789,
    "raised_by_vendor_name": "ABC Vendor Corp",
    "subject": "Delivery timeline query",
    "status": "OPEN",
    "created_at": "2026-01-15T10:00:00Z",
    "closed_at": null,
    "closed_by": null,
    "messages": [
      {
        "id": 1,
        "sender_id": 789,
        "sender_type": "VENDOR",
        "sender_name": "ABC Vendor Corp",
        "message": "Please clarify the delivery timeline requirements for bulk orders...",
        "files": [
          { "file_url": "https://s3.../file.pdf", "file_name": "specifications.pdf" }
        ],
        "created_at": "2026-01-15T10:00:00Z"
      }
    ]
  }
}
```

#### Error Responses

```json
{
  "status": 0,
  "message": "Another clarification is already open. Please wait for it to be closed before raising a new one."
}
```

> **Note**: Due to private visibility, details of the other vendor's clarification are not exposed.

```json
{ "status": 0, "message": "Clarification period has ended" }
```

```json
{ "status": 0, "message": "Clarifications are only allowed for tenders" }
```

---

### 2. Send Message in Clarification Thread (Both Parties)

**POST** `/rfq/clarification/message`

Send a message within an open clarification thread. Both the vendor who raised it and the tender creator (buyer) can send messages.

#### Authentication

- Both vendor (`noLogin.customer_auth`) and buyer can access
- Must be either the vendor who raised OR the tender creator

#### Request Body (multipart/form-data)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `clarification_id` | number | Yes | ID of the clarification |
| `message` | string | Yes | Message content (1-5000 chars) |
| `files` | File[] | No | Attachments (max 10 files, 100MB each) |

#### Response (200 OK)

```json
{
  "status": 1,
  "message": "Message sent successfully",
  "data": {
    "id": 123,
    "rfq_id": 456,
    "raised_by_vendor_id": 789,
    "raised_by_vendor_name": "ABC Vendor Corp",
    "subject": "Delivery timeline query",
    "status": "OPEN",
    "created_at": "2026-01-15T10:00:00Z",
    "closed_at": null,
    "closed_by": null,
    "messages": [
      {
        "id": 1,
        "sender_id": 789,
        "sender_type": "VENDOR",
        "sender_name": "ABC Vendor Corp",
        "message": "Please clarify the delivery timeline requirements...",
        "files": [],
        "created_at": "2026-01-15T10:00:00Z"
      },
      {
        "id": 2,
        "sender_id": 100,
        "sender_type": "BUYER",
        "sender_name": "John Doe",
        "message": "The delivery timeline is 30 days from PO date. Please refer to the attached diagram.",
        "files": [
          { "file_url": "https://s3.../diagram.pdf", "file_name": "delivery_diagram.pdf" }
        ],
        "created_at": "2026-01-15T10:30:00Z"
      },
      {
        "id": 3,
        "sender_id": 789,
        "sender_type": "VENDOR",
        "sender_name": "ABC Vendor Corp",
        "message": "Thank you for the clarification. This is clear now.",
        "files": [],
        "created_at": "2026-01-15T11:00:00Z"
      }
    ]
  }
}
```

#### Error Responses

```json
{ "status": 0, "message": "Clarification not found" }
```

```json
{ "status": 0, "message": "This clarification has been closed" }
```

```json
{ "status": 0, "message": "You are not authorized to send messages in this clarification" }
```

---

### 3. Close Clarification (Buyer Only)

**POST** `/rfq/clarification/resolve`

Buyer closes the clarification ticket. Can optionally include a final response message.

#### Authentication

- Requires `passportSignIn` (JWT authentication)
- Requires `acl([2, 8])` – Buyer roles only
- Only the tender creator can close

#### Request Body (multipart/form-data)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `clarification_id` | number | Yes | Clarification ID to close |
| `response` | string | No | Optional final response message (max 5000 chars) |
| `files` | File[] | No | Optional files with final response |

#### Response (200 OK)

```json
{
  "status": 1,
  "message": "Clarification closed successfully",
  "data": {
    "id": 123,
    "rfq_id": 456,
    "raised_by_vendor_id": 789,
    "raised_by_vendor_name": "ABC Vendor Corp",
    "subject": "Delivery timeline query",
    "status": "CLOSED",
    "created_at": "2026-01-15T10:00:00Z",
    "closed_at": "2026-01-15T12:00:00Z",
    "closed_by": 100,
    "messages": [
      // ... all messages in thread
    ]
  }
}
```

#### Error Responses

```json
{ "status": 0, "message": "Clarification not found" }
```

```json
{ "status": 0, "message": "This clarification has already been closed" }
```

```json
{ "status": 0, "message": "Only the tender creator can close clarifications" }
```

---

### 4. List Clarifications with Messages (Private Visibility)

**GET** `/rfq/clarifications/:rfq_id`

Get all clarifications for a tender with their message threads.

#### Authentication

- Requires authentication (`noLogin.customer_auth`)

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `rfq_id` | number | Tender ID |

#### Privacy Rules

| User Type | Sees |
|-----------|------|
| Buyer (tender creator) | ALL clarifications with all messages |
| Vendor who raised | Only their OWN clarifications with all messages |
| Other vendors | Only `has_open: true` (no clarification details) |

#### Response - Buyer View (200 OK)

```json
{
  "status": 1,
  "data": {
    "clarifications": [
      {
        "id": 123,
        "rfq_id": 456,
        "raised_by_vendor_id": 789,
        "raised_by_vendor_name": "ABC Vendor Corp",
        "subject": "Delivery timeline query",
        "status": "CLOSED",
        "created_at": "2026-01-15T10:00:00Z",
        "closed_at": "2026-01-15T12:00:00Z",
        "closed_by": 100,
        "messages": [
          {
            "id": 1,
            "sender_id": 789,
            "sender_type": "VENDOR",
            "sender_name": "ABC Vendor Corp",
            "message": "Please clarify the delivery timeline...",
            "files": [],
            "created_at": "2026-01-15T10:00:00Z"
          },
          {
            "id": 2,
            "sender_id": 100,
            "sender_type": "BUYER",
            "sender_name": "John Doe",
            "message": "The delivery timeline is 30 days...",
            "files": [],
            "created_at": "2026-01-15T10:30:00Z"
          }
        ]
      },
      {
        "id": 124,
        "rfq_id": 456,
        "raised_by_vendor_id": 790,
        "raised_by_vendor_name": "XYZ Supplies",
        "subject": "Payment terms",
        "status": "OPEN",
        "created_at": "2026-01-16T09:00:00Z",
        "closed_at": null,
        "closed_by": null,
        "messages": [...]
      }
    ],
    "open_clarification": { "id": 124, "...": "..." },
    "has_open": true,
    "is_own_clarification": false,
    "is_buyer": true
  }
}
```

#### Response - Other Vendor (200 OK)

When another vendor has an open clarification:

```json
{
  "status": 1,
  "data": {
    "clarifications": [],
    "open_clarification": null,
    "has_open": true,
    "is_own_clarification": false,
    "is_buyer": false
  }
}
```

#### Error Responses

```json
{ "status": 0, "message": "RFQ not found" }
```

```json
{ "status": 0, "message": "Clarifications are only available for tenders" }
```

---

### 5. Check Active Clarification with Messages (Private Visibility)

**GET** `/rfq/clarification/active/:rfq_id`

Check if there's an open clarification blocking quote submission, including its message thread.

#### Authentication

- Requires authentication (`noLogin.customer_auth`)

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `rfq_id` | number | Tender ID |

#### Privacy Rules

| User Type | Sees |
|-----------|------|
| Buyer (tender creator) | Full clarification details with messages |
| Vendor who raised | Full details with messages |
| Other vendors | Only `has_open: true`, `data: null` |

#### Response - Buyer / Own Clarification

```json
{
  "status": 1,
  "has_open": true,
  "is_own_clarification": true,
  "is_buyer": false,
  "data": {
    "id": 124,
    "rfq_id": 456,
    "raised_by_vendor_id": 790,
    "raised_by_vendor_name": "XYZ Supplies",
    "subject": "Payment terms",
    "status": "OPEN",
    "created_at": "2026-01-16T09:00:00Z",
    "closed_at": null,
    "closed_by": null,
    "messages": [
      {
        "id": 1,
        "sender_id": 790,
        "sender_type": "VENDOR",
        "sender_name": "XYZ Supplies",
        "message": "What are the payment terms?",
        "files": [],
        "created_at": "2026-01-16T09:00:00Z"
      }
    ]
  }
}
```

#### Response - Other Vendor

```json
{
  "status": 1,
  "has_open": true,
  "is_own_clarification": false,
  "is_buyer": false,
  "data": null
}
```

#### Response - No Open Clarification

```json
{
  "status": 1,
  "has_open": false,
  "is_own_clarification": false,
  "is_buyer": false,
  "data": null
}
```

---

### Quote Blocking Behavior

When a vendor attempts to submit or update a quote while a clarification is OPEN:

**POST** `/rfq/quote/create` or **PUT** `/rfq/quote/update/:quoteId`

#### Blocked Response (400)

```json
{
  "status": 3,
  "message": "Quote submission is blocked. There is an open clarification pending response.",
  "data": {
    "clarification_id": 124,
    "raised_by_vendor_name": "XYZ Supplies",
    "subject": "Payment terms",
    "created_at": "2026-01-16T09:00:00Z"
  }
}
```

---

### Clarification Database Tables

| Table | Purpose |
|-------|---------|
| `tbl_rfq_clarifications` | Main clarification records |
| `tbl_rfq_clarification_files` | Legacy file attachments (backward compatibility) |
| `tbl_rfq_clarification_messages` | Chat messages in clarification threads |
| `tbl_rfq_clarification_message_files` | File attachments for messages |

#### tbl_rfq_clarifications

```sql
CREATE TABLE tbl_rfq_clarifications (
  id SERIAL PRIMARY KEY,
  rfq_id INTEGER NOT NULL REFERENCES tbl_rfq(id),
  raised_by INTEGER NOT NULL REFERENCES tbl_users(id),
  vendor_company_id INTEGER,
  subject VARCHAR(200) NOT NULL,
  question TEXT NOT NULL,
  response TEXT,                                      -- Legacy: kept for backward compatibility
  responded_by INTEGER REFERENCES tbl_users(id),     -- Legacy
  closed_by INTEGER REFERENCES tbl_users(id),        -- NEW: who closed the clarification
  status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  responded_at TIMESTAMP,
  closed_at TIMESTAMP
);

-- Ensures only ONE open clarification per tender
CREATE UNIQUE INDEX idx_one_open_clarification_per_rfq
ON tbl_rfq_clarifications (rfq_id)
WHERE status = 'OPEN';
```

#### tbl_rfq_clarification_messages (NEW)

```sql
CREATE TABLE tbl_rfq_clarification_messages (
  id SERIAL PRIMARY KEY,
  clarification_id INTEGER NOT NULL REFERENCES tbl_rfq_clarifications(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES tbl_users(id),
  sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('VENDOR', 'BUYER')),
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_clarification_messages_clarification_id
ON tbl_rfq_clarification_messages(clarification_id);
```

#### tbl_rfq_clarification_message_files (NEW)

```sql
CREATE TABLE tbl_rfq_clarification_message_files (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES tbl_rfq_clarification_messages(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  file_type VARCHAR(100),
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

### Frontend Usage Notes

1. **Before submitting quote**: Call `GET /rfq/clarification/active/:rfq_id` to check if blocked
2. **Clarification period**: Only show "Raise Clarification" button between `tender_publish_date` and `vendor_clarification_date`
3. **Status badges**:
   - `OPEN` → Yellow/Orange badge, "Pending"
   - `CLOSED` → Green badge, "Resolved"
4. **File uploads**: Use `FormData` with field name `files`
5. **Real-time updates**: Poll `/rfq/clarifications/:rfq_id` every 30 seconds or use WebSocket
6. **Chat UI**: Display messages in chronological order with sender type badges (VENDOR/BUYER)
7. **Close button**: Only show "Close Clarification" button for buyers

#### Chat UI Example

```
┌─────────────────────────────────────────────┐
│ Subject: Clarification about specifications │
│ Status: OPEN                                │
├─────────────────────────────────────────────┤
│ ┌─────────────────────────────────┐        │
│ │ VENDOR (10:00 AM)               │        │
│ │ Can you clarify the dimensions? │        │
│ │ 📎 specs_query.pdf              │        │
│ └─────────────────────────────────┘        │
│                                             │
│        ┌─────────────────────────────────┐ │
│        │ BUYER (10:30 AM)                │ │
│        │ The dimensions are 100x50x25 cm │ │
│        │ 📎 diagram.pdf                  │ │
│        └─────────────────────────────────┘ │
│                                             │
│ ┌─────────────────────────────────┐        │
│ │ VENDOR (11:00 AM)               │        │
│ │ Thank you, this is clear now.  │        │
│ └─────────────────────────────────┘        │
├─────────────────────────────────────────────┤
│ [Message input...          ] [📎] [Send]   │
└─────────────────────────────────────────────┘
│ [Close Clarification] (Buyer only)         │
└─────────────────────────────────────────────┘
```

---

**End of Document**