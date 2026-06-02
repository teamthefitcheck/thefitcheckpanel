# Fit Check · Store Operations Panel
**Powered by Arqontiq**

A complete Shopify order management panel with email automation, shipping integration, and warehouse staff access.

---

## Setup

### 1. Clone & Install
```bash
cd fitcheck-admin
npm install
```

### 2. Environment Variables
```bash
cp .env.example .env
```
Fill in `.env`:
| Variable | Description |
|---|---|
| `SHOP_NAME` | Your store name (before `.myshopify.com`) |
| `SHOPIFY_CLIENT_ID` | From Shopify Partners → Your App |
| `SHOPIFY_CLIENT_SECRET` | From Shopify Partners → Your App |
| `MONGO_URI` | MongoDB connection string |
| `SERVER_URL` | Your public URL (e.g. `https://admin.fitcheck.com`) |
| `ADMIN_PASSWORD` | Admin panel password |
| `BRAND_NAME` | Brand name displayed in panel & emails |

### 3. Shopify App Setup
In your Shopify Partners dashboard → Your App → Configuration, add this **Allowed redirect URL**:
```
https://your-server-url.com/shopify/callback
```

### 4. Connect Your Store
Start the server, then visit:
```
https://your-server-url.com/install
```
This runs OAuth and stores your access token automatically.

### 5. Run Locally
```bash
npm start
# or for dev with auto-restart:
npm run dev
```

---

## Deploy on Render

1. Create a new **Web Service** on [render.com](https://render.com)
2. Connect your GitHub repo
3. **Build command:** `npm install`
4. **Start command:** `node server.js`
5. Add all env vars from `.env.example` in the Render dashboard
6. Deploy → visit `/install` to connect Shopify

---

## URLs

| URL | Description |
|---|---|
| `/admin.html` | Admin panel (full access) |
| `/staff` | Warehouse staff panel |
| `/install` | Connect/reconnect Shopify store |
| `/health` | Health check |

---

## Features

- 📦 **Order Management** — full order list, search, filters, stage tracking
- 📧 **Email Automation** — shipped, in-transit, OFD, delivered templates
- 🚚 **Shipping** — Delhivery & Shiprocket integration, auto AWB creation
- ↩ **Returns & Exchanges** — manage requests, create reverse/forward shipments
- 👥 **Staff Accounts** — warehouse team login with limited access
- 🔒 **Secure** — MongoDB session auth, webhook HMAC verification

---

*Fit Check Store Operations Panel — © Arqontiq*
