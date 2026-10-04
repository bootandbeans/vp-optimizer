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
export ADMIN_PASSWORD='choose-a-long-unique-password'
export SESSION_SECRET="$(node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")"
```

### 2. Install and run the app/API

```bash
npm install
npm start
```

Then open `http://localhost:8080/` and sign in with `ADMIN_PASSWORD`.

`ADMIN_PASSWORD` is required on every start. `SESSION_SECRET` should be a unique random value for each deployed environment; it signs the HTTP-only login session cookie.

The Express server serves both the app and the API, so there is no CORS configuration or second frontend server to manage. `npm run dev` starts the same service with Node's file watcher.

> Copy `.env.example` as a reference for the supported settings. This intentionally uses normal shell environment variables rather than adding a dotenv dependency.

## Deploy free with MongoDB Atlas + Render

1. Create a free MongoDB Atlas M0 cluster and a dedicated database user with only the `readWrite` role for the `vp_optimizer` database.
2. Copy the Atlas Node.js connection string and replace its password placeholder with the URL-encoded database-user password.
3. For a simple free Render deployment, add `0.0.0.0/0` to Atlas **Network Access**. Render's free service does not provide a fixed outbound IP. Do not use this broad rule for a sensitive production database; move to fixed-egress hosting when needed.
4. Push this repository to GitHub. `.env` is ignored — do not commit the connection string.
5. In Render, create a **Blueprint** from the repository. The included `render.yaml` supplies `npm ci`, `npm start`, the free web-service plan, and the health endpoint.
6. Set Render's secret `MONGODB_URI` to the copied Atlas URI, choose an `ADMIN_PASSWORD`, and set `SESSION_SECRET` to a long random value. `MONGODB_DB` is already set to `vp_optimizer`.
7. Deploy. Open the generated `*.onrender.com` URL, sign in with `ADMIN_PASSWORD`, and verify `/api/health` returns `{ "ok": true, ... }`.

Render's free web services sleep after idle time, so the first request can take roughly a minute to wake the app. Atlas M0 and Render Free are appropriate for demos, learning, and small internal tools.


## One-time browser-data migration

On its first successful API connection, the app copies any catalogue and session preferences previously stored in this browser's `localStorage` into MongoDB. Afterwards, catalogue CRUD and CSV import/export use MongoDB through the API. Existing users therefore do not lose their current sample or custom catalogue when switching to the backend.

## Accounts, roles, and privacy-aware traffic storage

The sign-in screen supports three paths:

- **Create account** — regular users register with email and a password of at least 10 characters.
- **Sign in** — regular users return using their email/password.
- **Admin** — click the **Admin** tab and enter the environment-only `ADMIN_PASSWORD`. No administrator email is required.

Password hashes use Node's `scrypt` with a unique random salt per user. Neither admin nor user passwords are stored in frontend code, browser storage, or MongoDB plaintext. An 8-hour signed, `HttpOnly`, `SameSite=Strict` session cookie protects authenticated requests. Login attempts are limited to five failed attempts per IP in ten minutes.

| Role | Catalogue | Optimizer / Calculator | Traffic overview |
| --- | --- | --- | --- |
| `admin` | Full add/edit/delete/import/export | Yes | Yes |
| `user` | Read-only/export | Yes | No |

MongoDB now contains these additional collections:

- `users` — email, password salt/hash, account dates, and analytics consent only.
- `user_activities` — signed-in optimizer runs and user-saved calculator baskets.
- `traffic_events` — consent-based anonymous page/feature activity. Raw IP addresses are not stored; the server stores a one-way short HMAC instead.

The first time a signed-in visitor opens the app, they can explicitly allow or decline anonymous analytics. Activity required for their own signed-in workflow is stored separately. Change both `ADMIN_PASSWORD` and `SESSION_SECRET` in the host dashboard to revoke administrator access and all active sessions, then redeploy.

## API

All API routes are served from the same origin:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Connection check; deliberately public |
| `GET` | `/api/auth/session` | Check current session |
| `POST` | `/api/auth/register` | Create a regular user account |
| `POST` | `/api/auth/login` | Sign in a regular user with email/password |
| `POST` | `/api/auth/admin-login` | Sign in with `ADMIN_PASSWORD` |
| `POST` | `/api/auth/logout` | Clear the active session |
| `POST` | `/api/telemetry` | Consent-based anonymous page/feature event |
| `POST` | `/api/activity` | Save optimizer or calculator activity for the signed-in user |
| `GET` | `/api/products` | List products; any signed-in user |
| `GET` | `/api/products/:id` | Get one product; any signed-in user |
| `POST` / `PUT` / `DELETE` | `/api/products…` | Product changes; administrator only |
| `POST` | `/api/products/bulk` | Import non-duplicate products; administrator only |
| `GET` / `PATCH` | `/api/products/prefs` | Persist per-user theme and session context |
| `GET` | `/api/admin/traffic-summary` | 30-day user/traffic totals; administrator only |

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

## Google Sign-In

Google Sign-In is optional. The app continues to support email/password user accounts and the environment-only administrator password when Google credentials are absent.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Configure the OAuth consent screen. For a testing app, add your test Google accounts.
3. Create **OAuth client ID → Web application** credentials.
4. Add these exact redirect URLs:

```text
http://localhost:8080/api/auth/google/callback
https://YOUR-RENDER-SERVICE.onrender.com/api/auth/google/callback
```

5. Set these server-only environment variables. Never put the client secret in browser JavaScript:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:8080/api/auth/google/callback
```

For Render, set `GOOGLE_CALLBACK_URL` to the HTTPS `onrender.com` callback URL instead. Restart/redeploy the server; the **Continue with Google** button appears automatically when all three settings are present.

## Saved baskets, history, and administration

- Any signed-in user can save a calculator basket or an optimizer result, then reopen it from **My History**.
- Optimizer runs and saved calculator activities are stored per account in `user_activities`.
- The **Admin** navigation item appears only for the environment-password administrator. It shows recent traffic totals, user accounts, saved activities, and lets the admin disable or re-enable an account.
- Disabling an account blocks that user from protected API routes immediately, even if their browser still has a session cookie.
