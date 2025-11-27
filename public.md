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
      "variant_id": 6068,
      "variant_name": "FLANGES",
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

