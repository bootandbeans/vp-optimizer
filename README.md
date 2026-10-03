# VP Optimizer

A responsive VP basket planner with a small **Express + MongoDB** backend. The browser UI is framework-free; the API is the only component that reads or writes catalogue data.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| UI | Plain HTML, CSS, ES modules | No frontend build step or framework |
| API | Express | Small, familiar HTTP server |
| Database | MongoDB official driver | Product records already fit a document shape; no ORM required |
| Storage boundary | `js/repository.js` | UI never talks to a database or `localStorage` directly |

## Quick start

### 1. Start MongoDB

The quickest local option, if you have Docker, is included:

```bash
docker compose up -d mongo
```

Or use a local MongoDB installation:

```bash
mongod --dbpath ./mongodb-data
```

Or put a MongoDB Atlas connection string in your environment:

```bash
export MONGODB_URI='mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority'
export MONGODB_DB='vp_optimizer'
```

### 2. Install and run the app/API

```bash
npm install
npm start
```

Then open `http://localhost:8080/`.

The Express server serves both the app and the API, so there is no CORS configuration or second frontend server to manage. `npm run dev` starts the same service with Node's file watcher.

> Copy `.env.example` as a reference for the supported settings. This intentionally uses normal shell environment variables rather than adding a dotenv dependency.

## Deploy free with MongoDB Atlas + Render

1. Create a free MongoDB Atlas M0 cluster and a dedicated database user with only the `readWrite` role for the `vp_optimizer` database.
2. Copy the Atlas Node.js connection string and replace its password placeholder with the URL-encoded database-user password.
3. For a simple free Render deployment, add `0.0.0.0/0` to Atlas **Network Access**. Render's free service does not provide a fixed outbound IP. Do not use this broad rule for a sensitive production database; move to fixed-egress hosting when needed.
4. Push this repository to GitHub. `.env` is ignored — do not commit the connection string.
5. In Render, create a **Blueprint** from the repository. The included `render.yaml` supplies `npm ci`, `npm start`, the free web-service plan, and the health endpoint.
6. Set Render's secret `MONGODB_URI` to the copied Atlas URI. `MONGODB_DB` is already set to `vp_optimizer`.
7. Deploy. Open the generated `*.onrender.com` URL; `/api/health` should return `{ "ok": true, ... }`.

Render's free web services sleep after idle time, so the first request can take roughly a minute to wake the app. Atlas M0 and Render Free are appropriate for demos, learning, and small internal tools.


## One-time browser-data migration

On its first successful API connection, the app copies any catalogue and session preferences previously stored in this browser's `localStorage` into MongoDB. Afterwards, catalogue CRUD and CSV import/export use MongoDB through the API. Existing users therefore do not lose their current sample or custom catalogue when switching to the backend.

## API

All API routes are served from the same origin:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Connection check |
| `GET` | `/api/products` | List products |
| `GET` | `/api/products/:id` | Get one product |
| `POST` | `/api/products` | Create product |
| `PUT` | `/api/products/:id` | Update/upsert product |
| `DELETE` | `/api/products/:id` | Delete product |
| `DELETE` | `/api/products` | Clear catalogue |
| `POST` | `/api/products/bulk` | Import non-duplicate products |
| `GET` / `PATCH` | `/api/products/prefs` | Persist theme and session context |

Products remain the same simple JSON document used by the UI:

```js
{
  id, name, mrp, vp, category?, sku?, min?, max?, active, rates?, profit?
}
```

`mrp` is integer paise. Product data is validated again by the API: text is cleaned, VP is rounded to two decimals, MRP/VP cannot be negative, and min/max quantity rules are enforced.

## Frontend modules

- `js/pricing.js` — integer-paise pricing / GST calculation
- `js/engine.js` — pure bounded-knapsack VP optimization
- `js/repository.js` — local repository implementation plus the active HTTP repository
- `js/validation.js`, `js/csv.js`, `js/pdf.js` — helpers
- `js/ui/*` — rendering only; no storage calls
- `js/main.js` — async repository bridge, one-time migration, and engine bridge

## Tests

The browser-only checks remain available at:

```text
http://localhost:8080/tests/tests.html
```

They exercise pricing, GST rounding, validation, CSV, repository behavior, and the pure optimization engine.
