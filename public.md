# **Workwise Public API Documentation**

Welcome to the **Workwise Public APIs**.
These APIs allow external systems to fetch **Products** and the **Vendors** selling those products in the Workwise marketplace.

Base URL example (production/staging may differ):

```
https://letsworkwise.com/
```

---

# **1. Get Products**

Fetch a list of products matching a search term.
Supports **fuzzy search**, so even incomplete spellings like `FLNS` will match `FLANGES`.

### **Endpoint**

```
GET /api/v1/public/products?search_key={product_name}
```

### **Query Parameters**

| Parameter    | Type   | Required | Description                                                  |
| ------------ | ------ | -------- | ------------------------------------------------------------ |
| `search_key` | string | Yes      | Text to search for in product names. Fuzzy search supported. |

---

## **Example Request**

```
GET /api/v1/public/products?search_key=flns
```

---

## **Sample Response**

```json
{
  "success": true,
  "count": 1,
  "data": [
    {
      "product_id": 6068,
      "product_name": "FLANGES",
      "description": null,
      "slug": "flanges",
      "category_name": "Mechanical",
      "category_id": 3212,
      "parent_category_id": 0,
      "similarity_score": 1,
      "rank": 0.1
    }
  ]
}
```

---

## **Response Fields Explained**

| Field                | Description                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| `variant_id`         | Unique ID of the product variant.                                           |
| `variant_name`       | Name of the variant.                                                        |
| `product_id`         | Identifier for the product (same as variant ID if single-variant products). |
| `product_name`       | Standard product name.                                                      |
| `description`        | Short product description (nullable).                                       |
| `slug`               | Unique slug used internally.                                                |
| `category_name`      | Category under which the product is listed.                                 |
| `category_id`        | Category ID.                                                                |
| `parent_category_id` | Parent category identifier.                                                 |
| `similarity_score`   | Fuzzy-matching score (higher = better match).                               |
| `rank`               | Full-text search rank.                                                      |

---

# **2. Get Vendors for a Product**

Fetch vendors who sell a given product.

### **Endpoint**

```
GET /api/v1/public/vendors?product_id={product_id}
```

### **Query Parameters**

| Parameter    | Type   | Required | Description                                 |
| ------------ | ------ | -------- | ------------------------------------------- |
| `product_id` | number | Yes      | Product or variant ID from `/products` API. |

---

## **Example Request**

```
GET /api/v1/public/vendors?product_id=6068
```

---

## **Sample Response**

```json
{
  "success": true,
  "count": 1,
  "data": [
    {
      "id": 14699,
      "name": "Elemy Ltd",
      "email": "b2bportal+vendor14613@gmail.com",
      "mobile": "+91-1234567890",
      "organization_name": null,
      "subscription_plan_id": null,
      "company_id": 14602,
      "company_name": "Elemy Ltd",
      "profile": "Elemy Ltd specialise in the design, manufacture, supply and delivery of Glass Reinforced Polymer (GRP) and Composite products and services.",
      "location": null,
      "website": "www.elemy.net",
      "group_rand": 0.1654971555727618
    }
  ]
}
```

---

## **Response Fields Explained**

| Field                  | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `id`                   | Vendor ID.                                                 |
| `name`                 | Vendor’s registered name.                                  |
| `email`                | Contact email.                                             |
| `mobile`               | Contact number.                                            |
| `organization_name`    | Vendor company name (nullable).                            |
| `subscription_plan_id` | Subscription tier (if any).                                |
| `company_id`           | ID of the vendor’s company profile.                        |
| `company_name`         | Display company name.                                      |
| `profile`              | Company profile/description.                               |
| `location`             | Company location (nullable).                               |
| `website`              | Company website.                                           |
| `group_rand`           | Random weight used for internal load balancing of vendors. |

---

# **How to Call These APIs**

### **Using cURL**

#### Get Products

```bash
curl "https://yourdomain.com/api/v1/public/products?search_key=flanges"
```

#### Get Vendors

```bash
curl "https://yourdomain.com/api/v1/public/vendors?product_id=6068"
```

---

### **Using JavaScript (Fetch)**

```js
// Get Products
fetch("/api/v1/public/products?search_key=flns")
  .then(res => res.json())
  .then(console.log);

// Get Vendors
fetch("/api/v1/public/vendors?product_id=6068")
  .then(res => res.json())
  .then(console.log);
```

---

### **Using Postman**

1. Open Postman → New Request
2. Set method → **GET**
3. Paste the endpoint URL
4. Hit **Send**
5. View formatted JSON response




# **3. Manage Public Users**

These APIs allow you to register and retrieve public users who interact with the Workwise platform.

## **3.1 Add a Public User**

Register a new public user who has shown interest in Workwise products or vendors.

### **Endpoint**

```
POST /api/v1/public/add-public-users
```

### **Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | Yes | Name of the public user |
| `email` | string | Yes | Email address of the user |
| `mobile` | string | Yes | Mobile/contact number |
| `company_name` | string | Yes | Company/organization name |
| `platform` | string | Yes | Platform where the user came from (e.g., "website", "mobile_app") |
| `element` | string | Yes | Element/feature the user interacted with |

---

### **Example Request**

```json
POST /api/v1/public/add-public-users
Content-Type: application/json

{
  "username": "John Doe",
  "email": "john.doe@example.com",
  "mobile": "+1-555-0123",
  "company_name": "TechCorp Inc.",
  "platform": "website",
  "element": "product_search"
}
```

---

### **Success Response (200)**

```json
{
  "status": 1,
  "message": "Public user added successfully"
}
```

---

### **Error Response (500)**

```json
{
  "status": 0,
  "message": "An error occurred while adding public user",
  "error": "Detailed error message"
}
```

---

## **3.2 Get Public Users**

Retrieve a paginated list of registered public users with optional date filtering.

### **Endpoint**

```
GET /api/v1/public/get-public-users
```

### **Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default: 1) |
| `limit` | integer | No | Items per page (default: 10) |
| `start_date` | string (ISO date) | No | Start date for filtering records (e.g., "2024-01-01") |
| `end_date` | string (ISO date) | No | End date for filtering records (e.g., "2024-12-31") |
| `search` | string | No | Search term to filter by username, email, or company name |

---

### **Example Request**

```
GET /api/v1/public/get-public-users?page=1&limit=20&start_date=2024-01-01&end_date=2024-12-31
```

---

### **Success Response (200)**

```json
{
  "status": 1,
  "message": "Public users fetched successfully",
  "data": {
    "data": [
      {
        "id": 1,
        "username": "John Doe",
        "email": "john.doe@example.com",
        "mobile": "+1-555-0123",
        "company_name": "TechCorp Inc.",
        "platform": "website",
        "element": "product_search",
        "created_at": "2024-03-15T10:30:00.000Z"
      }
    ],
    "pagination": {
      "current_page": 1,
      "items_per_page": 20,
      "total_items": 150,
      "total_pages": 8,
      "has_next": true,
      "has_prev": false
    }
  }
}
```

---

### **Error Responses**

#### **Invalid Pagination (400)**

```json
{
  "status": 0,
  "message": "Invalid page number"
}
```

#### **Invalid Date Format (400)**

```json
{
  "status": 0,
  "message": "Invalid date format provided"
}
```

#### **Server Error (500)**

```json
{
  "status": 0,
  "message": "An error occurred while fetching public users",
  "error": "Detailed error message"
}
```

---

## **Response Fields Explained**

### **User Object**

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique identifier for the public user |
| `username` | string | Name of the public user |
| `email` | string | Email address |
| `mobile` | string | Contact number |
| `company_name` | string | Company/organization name |
| `platform` | string | Source platform |
| `element` | string | Element/feature interacted with |
| `created_at` | string (ISO) | Timestamp when the user was registered |

### **Pagination Object**

| Field | Type | Description |
|-------|------|-------------|
| `current_page` | integer | Current page number |
| `items_per_page` | integer | Number of items per page |
| `total_items` | integer | Total number of items available |
| `total_pages` | integer | Total number of pages |
| `has_next` | boolean | Whether a next page exists |
| `has_prev` | boolean | Whether a previous page exists |

---

# **How to Call These APIs**

### **Using cURL**

#### **Add Public User**

```bash
curl -X POST "https://yourdomain.com/api/v1/public/add-public-users" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "John Doe",
    "email": "john.doe@example.com",
    "mobile": "+1-555-0123",
    "company_name": "TechCorp Inc.",
    "platform": "website",
    "element": "product_search"
  }'
```

#### **Get Public Users**

```bash
curl "https://yourdomain.com/api/v1/public/get-public-users?page=1&limit=20&start_date=2024-01-01&end_date=2024-12-31"
```

---

### **Using JavaScript (Fetch)**

```javascript
// Add Public User
fetch("/api/v1/public/add-public-users", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "John Doe",
    email: "john.doe@example.com",
    mobile: "+1-555-0123",
    company_name: "TechCorp Inc.",
    platform: "website",
    element: "product_search"
  })
})
.then(res => res.json())
.then(console.log);

// Get Public Users
fetch("/api/v1/public/get-public-users?page=1&limit=20&start_date=2024-01-01")
  .then(res => res.json())
  .then(console.log);
```

---

### **Using Python (requests)**

```python
import requests

# Add Public User
response = requests.post(
    "https://yourdomain.com/api/v1/public/add-public-users",
    json={
        "username": "John Doe",
        "email": "john.doe@example.com",
        "mobile": "+1-555-0123",
        "company_name": "TechCorp Inc.",
        "platform": "website",
        "element": "product_search"
    }
)
print(response.json())

# Get Public Users
response = requests.get(
    "https://yourdomain.com/api/v1/public/get-public-users",
    params={
        "page": 1,
        "limit": 20,
        "start_date": "2024-01-01",
        "end_date": "2024-12-31"
    }
)
print(response.json())
```

---

### **Using Postman**

#### **For POST (Add Public User):**
1. Open Postman → New Request
2. Set method → **POST**
3. URL: `https://yourdomain.com/api/v1/public/add-public-users`
4. Go to **Body** tab → Select **raw** → Choose **JSON**
5. Paste the JSON payload
6. Hit **Send**

#### **For GET (Get Public Users):**
1. Open Postman → New Request
2. Set method → **GET**
3. URL: `https://yourdomain.com/api/v1/public/get-public-users`
4. Go to **Params** tab → Add query parameters
5. Hit **Send**

---

## **Notes**

1. **Authentication**: These endpoints are public and do not require authentication.
2. **Rate Limiting**: Be mindful of request rates to avoid being throttled.
3. **Data Privacy**: Ensure you have proper consent before storing user data.
4. **Validation**: All fields in the POST request are required. Missing fields will result in an error.
5. **Date Format**: Use ISO 8601 format (`YYYY-MM-DD`) for date parameters.
6. **Search**: The search parameter performs case-insensitive search across username, email, and company_name fields.