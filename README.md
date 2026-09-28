# Kid Zone + Restaurant API

REST API for a business in Bangladesh running an indoor children's play area and a restaurant under one roof. Built with NestJS, PostgreSQL and Prisma, and designed to be consumed by a separate React frontend.

- **Swagger UI:** `http://localhost:3000/api/docs`
- **OpenAPI JSON:** `http://localhost:3000/api/docs-json`
- **API root:** `http://localhost:3000/api/v1`

---

## Contents

1. [Quick start](#quick-start)
2. [Environment variables](#environment-variables)
3. [Commands](#commands)
4. [API conventions](#api-conventions)
5. [Roles and permissions](#roles-and-permissions)
6. [API overview](#api-overview)
7. [Business rules worth knowing](#business-rules-worth-knowing)
8. [Testing](#testing)
9. [Backup and restore](#backup-and-restore)
10. [Decisions](#decisions)

---

## Quick start

### With Docker (everything included)

```bash
cp .env.example .env
# Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET to two different random strings
# of at least 32 characters, e.g. openssl rand -base64 48

docker compose up -d
docker compose exec api npm run seed
docker compose exec api npm run seed:demo   # optional: 90 days of demo data
```

Open <http://localhost:3000/api/docs>.

### Locally, with only the databases in Docker

```bash
cp .env.example .env          # then set the two JWT secrets
docker compose up -d postgres redis
npm install
npx prisma generate
npx prisma migrate deploy
npm run seed
npm run start:dev
```

Requires **Node.js 20 or newer** and, for the backup job, the `pg_dump` / `pg_restore` client binaries on `PATH` (the Docker image includes them).

### Seeded accounts

`npm run seed` creates these three accounts. **Change the passwords before going live.**

| Role | Phone | Email | Password |
|---|---|---|---|
| `ADMIN` | `01711000001` | admin@kidzone.test | `Admin#2026` |
| `KIDZONE_MANAGER` | `01711000002` | manager@kidzone.test | `Manager#2026` |
| `RESTAURANT_CASHIER` | `01711000003` | cashier@kidzone.test | `Cashier#2026` |

It also creates the four default Kid Zone plans, 5 menu categories with 27 items, and the default settings. It is idempotent, and deliberately does **not** reset a password or a price that has since been changed.

---

## Environment variables

Validated at startup with Zod. A missing or malformed variable aborts the boot with every problem listed at once, rather than failing later on some unrelated request.

### Application

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | |
| `API_PREFIX` | `api/v1` | Applies to every route except `/health` and the docs |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allow-list. Requests from any other origin get no CORS headers. |

### Database and Redis

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** `postgresql://user:pass@host:5432/db?schema=public` |
| `TEST_DATABASE_URL` | — | Used by `npm run test:e2e`. Must not be the development database. |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` | `localhost` / `6379` / — / `0` | BullMQ and the health check |

### Auth

| Variable | Default | Notes |
|---|---|---|
| `JWT_ACCESS_SECRET` | — | **Required**, at least 32 characters |
| `JWT_REFRESH_SECRET` | — | **Required**, at least 32 characters, different from the access secret |
| `JWT_ACCESS_TTL` | `15m` | |
| `JWT_REFRESH_TTL` | `7d` | |
| `REFRESH_COOKIE_NAME` | `kz_refresh` | |
| `COOKIE_SECURE` | `false` | Forced to `true` in production; boot fails otherwise |
| `COOKIE_SAME_SITE` | `lax` | `lax` \| `strict` \| `none` |
| `COOKIE_DOMAIN` | — | Leave blank for a host-only cookie |

### Business defaults

These seed the `settings` table on first boot. Once a setting row exists, the **stored setting wins** and the environment variable is ignored — change it through `PATCH /settings`.

| Variable | Default | Notes |
|---|---|---|
| `BUSINESS_TIMEZONE` | `Asia/Dhaka` | IANA name |
| `BUSINESS_DAY_START_HOUR` | `0` | Set to e.g. `4` if you trade past midnight |
| `WEEK_START_DAY` | `6` (Saturday) | `0` = Sunday … `6` = Saturday |
| `MAX_STAFF_DISCOUNT_PERCENT` | `10` | Admins are not limited |

### Rate limiting

| Variable | Default | Notes |
|---|---|---|
| `THROTTLE_ENABLED` | `true` | `false` disables all limiting; used by the test suite |
| `THROTTLE_TTL_SECONDS` | `60` | |
| `THROTTLE_LIMIT` | `120` | Global per-IP limit. Login and OTP have their own, stricter limits. |

### SMS

| Variable | Default | Notes |
|---|---|---|
| `SMS_PROVIDER` | `console` | `console` logs the message; `http` calls a real gateway |
| `SMS_HTTP_URL` | — | Required when `SMS_PROVIDER=http` |
| `SMS_HTTP_METHOD` | `POST` | `GET` \| `POST` |
| `SMS_HTTP_API_KEY` / `SMS_HTTP_SENDER_ID` | — | Your gateway credentials |
| `SMS_PARAM_API_KEY` | `api_key` | The **name** your gateway expects for each parameter |
| `SMS_PARAM_SENDER_ID` | `senderid` | |
| `SMS_PARAM_PHONE` | `msisdn` | |
| `SMS_PARAM_MESSAGE` | `sms` | |
| `SMS_EXTRA_PARAMS` | `{}` | JSON object of extra static parameters, e.g. `{"type":"text"}` |
| `SMS_TIMEOUT_MS` | `15000` | |

The parameter names are configuration rather than code, so moving between SSL Wireless, Alpha SMS, BulkSMSBD and similar gateways is an `.env` change, not a new class.

### Jobs and backups

| Variable | Default | Notes |
|---|---|---|
| `ENABLE_CRON` | `true` | Scheduled jobs check this at fire time |
| `ENABLE_QUEUE` | `true` | `false` delivers SMS inline instead of through BullMQ (no Redis needed) |
| `BACKUP_ENABLED` | `false` | Enables the 03:00 job |
| `BACKUP_DIR` | `./backups` | |
| `BACKUP_PG_DUMP_PATH` / `BACKUP_PG_RESTORE_PATH` | `pg_dump` / `pg_restore` | Full paths if not on `PATH` |
| `BACKUP_KEEP_DAILY` | `30` | |
| `BACKUP_KEEP_MONTHLY` | `12` | |
| `BACKUP_S3_ENABLED` | `false` | |
| `BACKUP_S3_ENDPOINT` / `_REGION` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_PREFIX` | — | Cloudflare R2, Backblaze B2, MinIO or AWS S3 |

---

## Commands

| Command | What it does |
|---|---|
| `npm run start:dev` | Development server with hot reload |
| `npm run build` | Compile to `dist/` (and rewrite path aliases) |
| `npm run start:prod` | Run the compiled build |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint with `--fix` |
| `npm test` | Unit tests |
| `npm run test:e2e` | End-to-end tests against `TEST_DATABASE_URL` |
| `npm run test:cov` | Unit tests with coverage |
| `npx prisma migrate dev` | Create and apply a migration |
| `npx prisma migrate deploy` | Apply committed migrations (production) |
| `npm run seed` | Staff accounts, plans, menu, settings. Idempotent. |
| `npm run seed:demo` | 90 days of demo trade. Requires an empty ledger. |
| `npm run db:backup` | Take a backup now |
| `npm run db:restore -- <file>` | Restore a backup |

---

## API conventions

### Response envelope

Every successful response is:

```json
{
  "data": { },
  "meta": { "timestamp": "2026-09-22T09:15:00.000Z" }
}
```

List endpoints add pagination to `meta`:

```json
{
  "data": [ ],
  "meta": {
    "page": 1, "limit": 25, "total": 137, "totalPages": 6,
    "hasNextPage": true, "hasPreviousPage": false,
    "timestamp": "2026-09-22T09:15:00.000Z"
  }
}
```

Report endpoints put the resolved period in `meta.period`. File downloads (`?format=pdf`, `?export=xlsx`) return the raw file, not the envelope.

### Errors

```json
{
  "statusCode": 409,
  "error": "MEMBERSHIP_EXPIRED",
  "message": "This membership expired on 2026-09-21. Please renew it to check in.",
  "details": { "membershipId": "…", "endDate": "2026-09-21" }
}
```

`error` is a **stable machine-readable code** — branch on it rather than on the message text. Some codes you will want to handle:

| Code | Meaning |
|---|---|
| `VALIDATION_FAILED` | Body or query failed validation; `details.errors` lists the problems |
| `PAYMENT_TOTAL_MISMATCH` | Payments do not add up to the amount due |
| `DISCOUNT_LIMIT_EXCEEDED` | Staff discount above the configured cap |
| `DISCOUNT_REASON_REQUIRED` | A discount was applied without a reason |
| `MEMBERSHIP_EXPIRED` / `_NOT_STARTED` / `_CANCELLED` | Check-in refused; `details` carries the dates |
| `CHILD_ALREADY_CHECKED_IN` | That child is already inside |
| `OTP_INCORRECT` / `_EXPIRED` / `_TOO_MANY_ATTEMPTS` / `_RESEND_TOO_SOON` | OTP flow |
| `OVERTIME_PAYMENT_REQUIRED` | Check-out needs payment for the overtime owed (HTTP 402) |
| `MENU_ITEM_UNAVAILABLE` | An ordered item is out of stock or retired |
| `DAY_ALREADY_CLOSED` | The business date is locked; an admin must reopen it |
| `TOO_MANY_LOGIN_ATTEMPTS` | Login rate limit (HTTP 429) |

### Money

**Every amount in this API is an integer number of poisha** (1 BDT = 100 poisha). ৳250.00 is sent and returned as `25000`. There are no floating-point amounts anywhere — not in the API, not in the database.

### Dates and the business day

Timestamps are ISO-8601 UTC. A `businessDate` is a `YYYY-MM-DD` calendar date computed in the business timezone, honouring `businessDayStartHour`: with a start hour of `4`, a sale rung up at 02:30 counts toward the previous day. Weekly report boundaries use `weekStartDay` (Saturday by default).

### Phone numbers

Accepted as `01XXXXXXXXX`, `8801XXXXXXXXX`, `+8801XXXXXXXXX`, with or without spaces and dashes. Always **stored and returned as E.164** (`+8801XXXXXXXXX`). Only Bangladeshi mobile prefixes (`013`–`019`) are valid.

### Pagination and filtering

List endpoints accept `page`, `limit` (max 100), `sort`, `order` (`asc`/`desc`), `search`, and endpoint-specific filters. `sort` is checked against a per-endpoint allow-list, so the query string cannot reach an arbitrary column.

### Authentication

`POST /auth/login` returns a 15-minute access token in the body and sets a rotating 7-day refresh token in an `httpOnly` cookie scoped to `/api/v1/auth`. Send the access token as `Authorization: Bearer <token>`; call `POST /auth/refresh` with the cookie to rotate.

The frontend must send `credentials: 'include'` on refresh and logout, and its origin must be in `CORS_ORIGINS`.

---

## Roles and permissions

| Capability | ADMIN | KIDZONE_MANAGER | RESTAURANT_CASHIER |
|---|:---:|:---:|:---:|
| Manage users | ✅ | ❌ | ❌ |
| Manage settings | ✅ | ❌ | ❌ |
| Create/edit Kid Zone plans and prices | ✅ | ❌ | ❌ |
| Sell Kid Zone plans, check in/out, view members | ✅ | ✅ | ❌ |
| View child and guardian personal data | ✅ | ✅ | ❌ |
| Create/edit menu items and prices | ✅ | ❌ | ❌ |
| Toggle menu item availability | ✅ | ❌ | ✅ |
| Create restaurant orders | ✅ | ❌ | ✅ |
| Discount up to `maxStaffDiscountPercent` | ✅ | ✅ (Kid Zone) | ✅ (Restaurant) |
| Discount above that limit | ✅ | ❌ | ❌ |
| Void a sale or order | ✅ | ❌ | ❌ |
| Manual check-in override | ✅ | ❌ | ❌ |
| Day-end closing for own section | ✅ | ✅ | ✅ |
| Own-section reports | ✅ | ✅ (Kid Zone, today only) | ✅ (Restaurant, today only) |
| All reports, combined dashboard, exports | ✅ | ❌ | ❌ |
| View audit log | ✅ | ❌ | ❌ |

Two guards run globally. `JwtAuthGuard` requires a valid access token unless a route is explicitly `@Public()`. `RolesGuard` is **fail-closed**: an authenticated route with no `@Roles()` decorator is denied, so a new endpoint cannot ship without an access decision.

**A cashier never receives Kid Zone revenue or child data**, including through search or a relation. `GET /customers` returns a cashier the guardian and a child *count* only; `GET /customers/:id` omits the entire `kidZone` block and does not load child rows at all.

---

## API overview

Full detail, with every DTO and error response, is in [Swagger](http://localhost:3000/api/docs).

### Auth
`POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` · `PATCH /auth/change-password`

### Administration
`GET|POST /users` · `GET|PATCH|DELETE /users/:id` · `POST /users/:id/reset-password`
`GET|PATCH /settings` · `GET /settings/schema`
`GET /audit-logs`
`GET /jobs/sms-log` · `POST /jobs/run/{expire-memberships|expiry-reminders|cleanup|backup}`

### Customers
`GET|POST /customers` · `GET|PATCH|DELETE /customers/:id`
`GET|POST /customers/:id/children` · `PATCH|DELETE /customers/:id/children/:childId`

### Kid Zone
`GET|POST /kidzone/plans` · `GET|PATCH|DELETE /kidzone/plans/:id`
`POST|GET /kidzone/sales` · `GET /kidzone/sales/:id` · `POST /kidzone/sales/:id/void`
`GET /kidzone/memberships` · `GET /kidzone/memberships/:id` · `GET /kidzone/memberships/:id/qr` · `POST /kidzone/memberships/:id/qr/reissue` · `POST /kidzone/memberships/:id/renew`
`POST /kidzone/checkin/lookup` · `POST /kidzone/checkin/otp/send` · `POST /kidzone/checkin/otp/verify` · `POST /kidzone/checkin/qr` · `POST /kidzone/checkin/manual`
`GET /kidzone/visits` · `GET /kidzone/visits/active` · `GET /kidzone/visits/:id` · `POST /kidzone/visits/:id/checkout`

### Restaurant
`GET /restaurant/menu`
`GET|POST /restaurant/categories` · `PATCH|DELETE /restaurant/categories/:id`
`GET|POST /restaurant/menu-items` · `GET|PATCH|DELETE /restaurant/menu-items/:id` · `PATCH /restaurant/menu-items/:id/availability`
`POST|GET /restaurant/orders` · `GET /restaurant/orders/:id` · `POST /restaurant/orders/:id/void`

### Receipts
`GET /receipts/kidzone/:saleId` · `GET /receipts/restaurant/:orderId` · `GET /receipts/gatepass/:visitId`
Each accepts `?format=pdf` for an 80mm thermal-width PDF.

### Day-end closing
`GET /closing/:section/preview` · `POST /closing/:section` · `POST /closing/:id/reopen` · `GET /closing`

### Reports
`/reports/kidzone/{summary,revenue-trend,by-plan,visits,peak-hours,membership-utilization,members}`
`/reports/restaurant/{summary,revenue-trend,top-items,by-category,hourly,cashier-performance}`
`/reports/{payment-methods,discounts-voids,cross-section}`
`/dashboard/combined`

Every report accepts `range=today|yesterday|this_week|last_week|this_month|last_month|this_year|custom` (with `from`/`to`), and `?export=xlsx` or `?export=pdf`.

### Health
`GET /health` — PostgreSQL and Redis, unauthenticated.

---

## Business rules worth knowing

**Prices are snapshotted, never joined.** A sale stores the plan name and price as they were; an order line stores the item name, unit price and category name, and the order stores the VAT and service charge *percentages*. Reprinting a six-month-old receipt reproduces it exactly, and reports group on the snapshots — a dish that was renamed is still reported under the name it was sold under.

**Restaurant bill order of operations:** subtotal → discount → service charge → VAT. The discount reduces the service charge and the VAT as well as the food, and VAT is charged on the service charge. Each derived amount is rounded once, half away from zero, to whole poisha.

**Overtime** is `max(0, elapsed − sessionMinutes − gracePeriodMinutes)`, billed as whole *started* blocks. One minute into a 30-minute block costs a full block. If anything is owed, check-out requires payments covering exactly that amount. Membership visits are open-ended and are never charged overtime.

**Memberships** run inclusive of both ends: 90 days from the 22nd ends on day 90, not 91. Renewing **early** starts the new term the day after the current end date, so the customer keeps the days they already paid for; renewing after a lapse restarts today.

**Payments must settle the bill exactly.** Split payments are supported, but the sum must equal the total — an over- or under-tendered bill would quietly corrupt the day-end cash reconciliation, so it is rejected rather than rounded. Digital methods (bKash, Nagad, card) require a transaction reference.

**Financial records are never deleted.** A void marks the row, records who and why, and excludes it from revenue while still reporting it separately. Voiding a membership sale also cancels the membership, so a refunded customer cannot keep using the gate.

**Closing a day locks it.** After `POST /closing/:section`, new sales, voids, check-ins and overtime charges dated to that business date are refused with `DAY_ALREADY_CLOSED`. Only an admin can reopen. The expected figures are built from **payment rows**, not sale totals — that is what reconciles against a physical drawer when a sale is split cash/bKash.

**Receipt numbers** (`KZ-20260922-0001`, `RS-20260922-0001`, `GP-20260922-0001`) restart each business day and are allocated by a single atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the sale transaction, so two tills ringing up at the same instant cannot be handed the same number.

---

## Testing

```bash
npm test          # 124 unit tests
npm run test:e2e  # 185 end-to-end tests
```

E2E tests need PostgreSQL and Redis running and `TEST_DATABASE_URL` set to a **separate** database — the harness refuses to run if it points at the development database, and truncates every table between tests.

Unit tests cover the parts where a mistake costs money: the restaurant pricing function (discount, service charge, VAT, rounding), overtime calculation, business-date and report-range computation (including a non-zero business day start hour and each week-start setting), membership term and renewal arithmetic, discount permission checks, phone normalisation and connection-string parsing.

E2E tests cover login/refresh/logout including refresh-token replay detection, RBAC denials in both directions, selling and checking in by OTP and by QR, rejection of expired memberships, overtime check-out, the price snapshot surviving a menu price change, voiding with its audit entry, day closing and the resulting lock, the scheduled jobs' idempotency, and report totals against a fixture with known exact figures.

---

## Backup and restore

The 03:00 Asia/Dhaka job runs `pg_dump --format=custom`, writes to `BACKUP_DIR`, optionally uploads to S3-compatible storage, then prunes. Retention keeps the most recent `BACKUP_KEEP_DAILY` dumps plus the earliest dump of each of the last `BACKUP_KEEP_MONTHLY` months. Success and failure are both written to the audit log.

Take one by hand:

```bash
npm run db:backup
# or, as an admin over the API:
curl -X POST http://localhost:3000/api/v1/jobs/run/backup -H "Authorization: Bearer <token>"
```

Restore:

```bash
npm run db:restore -- ./backups/kidzone-2026-09-22-030001.dump
```

The restore script prints the target database and requires you to type its name to continue. `--yes` skips the prompt; a target whose URL looks like production refuses to run without it. `--url=` restores somewhere other than `DATABASE_URL`, which is how you should rehearse a restore:

```bash
createdb kidzone_restore_test
npm run db:restore -- ./backups/latest.dump --url=postgresql://user:pass@localhost:5432/kidzone_restore_test --yes
```

The restore uses `--clean --if-exists --single-transaction`, so it is all-or-nothing: a failure part way through leaves the target as it was rather than half restored. If the dump predates the current migrations, run `npx prisma migrate deploy` afterwards.

**An untested backup is not a backup.** Rehearse a restore into a scratch database before you need it.

---

## Decisions

Where the specification was silent, these are the choices made and why.

**Money as integer poisha, enforced in the database.** `CHECK` constraints reject negative amounts and non-positive payments, so a bug cannot write impossible money even if it bypasses the service layer.

**Refresh tokens are JWTs whose SHA-256 is stored.** The JWT carries the user and a `jti` so it can be parsed without a database hit; storing only the hash means a database leak does not hand out usable tokens. SHA-256 rather than argon2 because the token is already 256 bits of entropy — there is nothing to brute force — and rotation needs a hash lookup. Presenting an already-rotated token is treated as theft and revokes every session for that user.

**Deactivation takes effect immediately.** The JWT strategy loads the user on every request rather than trusting the token's claims. That is an extra read per request, and it is what makes "deactivate a user and they lose access now" true instead of true in fifteen minutes. The role carried by a request is always the role in the database.

**OTP codes are SHA-256, not argon2.** A six-digit code is low entropy, but it is also short-lived and attempt-limited. Hashing stops a database dump handing out live codes; argon2's 100 ms per verification would be felt at a queue of parents.

**`RolesGuard` is fail-closed.** An authenticated route with no `@Roles()` is denied and logged as an error, so a forgotten decorator surfaces as an immediate 403 in development rather than as a silently unguarded endpoint in production.

**The membership QR token is treated as a bearer credential, not as a field.** Whoever holds `qrToken` can check that child in, so it is stripped from every list, detail and customer read. Exactly one endpoint returns it — `GET /kidzone/memberships/:id/qr` — and every call is audited as `MEMBERSHIP_QR_ISSUED`. The token itself is deliberately kept *out* of the audit row: the log is readable by every admin and would otherwise become a list of working gate credentials. `POST /kidzone/memberships/:id/qr/reissue` rotates it for a lost card, which revokes the printed one immediately, so it requires a written reason.

**The printed QR encodes the raw token, with no URL or JSON wrapper.** A cheap handheld scanner types exactly what it reads, so the value in the square is the value `POST /kidzone/checkin/qr` expects. Wrapping it in a deep link would mean the two input paths no longer agreed.

**Child data is shaped by a serialiser, not by each query.** Rather than trusting every endpoint to remember what a cashier may see, all child and customer output goes through one role-aware serialiser.

**Settings are cached in memory for 5 seconds.** Every sale reads several settings. A write clears the cache immediately, so a change is instant on the instance that made it and takes at most 5 seconds to reach others. VAT rates do not need sub-second propagation, and the snapshot on each order means a late change cannot corrupt a bill in flight.

**Business dates are stored, not derived.** Every sale, order, visit and payment stores its `businessDate`. Reports filter on an indexed `DATE` column instead of converting timestamps at query time, which keeps them fast and makes `businessDayStartHour` meaningful after the fact.

**Report ranges compare like with like.** "This month" is compared against the same *stretch* of last month, not a full month — comparing 22 days against 31 would show a fake decline every month. In-progress periods are clipped at today, and the comparison window is clamped to a shorter previous month (31 March compares against 1–28 February).

**A voided sale's visit does not count as attendance.** The visit row is kept — the visit log records what happened at the gate — but `visits`, `peak-hours` and the summary exclude it. If a session is rung up by mistake and voided, the child never came in, and counting it would inflate footfall.

**The gatepass QR carries the gatepass number, not the membership token.** A printed slip can be dropped on the floor; it must not be a credential that lets someone check a child in. The membership `qrToken` is never returned by a list or a customer read.

**Aggregation happens in SQL.** Reports use Prisma `groupBy` or parameterised `$queryRaw`, never a `findMany` reduced in Node. Hour-of-day extraction converts to the business timezone inside the query, so a 9pm Dhaka arrival lands in the 21:00 bucket rather than 15:00 UTC.

**Trend series are zero-filled.** A day with no trade is returned as zero rather than omitted, so a chart does not silently close the gap and make a quiet week look like a short one.

**Excel money columns are numbers in taka, not poisha integers or formatted strings.** The point of a spreadsheet is that the recipient can sum and pivot it. Amounts and counts are split across separate sheets, because one column carries one number format.

**PDFs use the standard-14 fonts.** No font files are shipped, and there are no licensing questions. The trade-off is no Bengali glyphs, so receipts render Latin text and `BDT` rather than `৳`. Registering a Unicode TTF in `PdfService` is the only change needed.

**S3 upload is hand-rolled SigV4.** One PUT of one file per night did not justify the AWS SDK as a dependency. The body streams rather than being buffered to hash it.

**`pg_dump` receives host/port/user/database as flags with the password in `PGPASSWORD`.** A connection URI on the command line would put the database password in the process list. (`PGDATABASE` does not accept a URI — libpq treats it as a plain database name.)

**The seed never overwrites a password or a price.** Re-running it on a live environment must not silently revert an operator's admin password, or bypass the price history that the application maintains for every real price change.

**Node 20 in Docker.** The image pins Node 20 LTS as specified; the code runs on 20 or newer, and was developed on 24.

**Path aliases are rewritten at build time** by `tsc-alias`, because the Nest CLI's `tsc` build leaves `@common/...` specifiers that Node cannot resolve at runtime.

### Known gaps

- **Refresh-token rotation is not hardened against concurrent refreshes.** Two tabs refreshing at the same instant will have one succeed and one trip the replay detection, logging the user out. A production frontend should serialise refreshes through a single in-flight promise.
- **The SMS queue has no dead-letter handling beyond the SmsLog row.** A message that fails all three attempts is marked `FAILED` and visible at `GET /jobs/sms-log`, but nothing retries it later or alerts anyone.
- **Report exports are generated synchronously.** A multi-year export on a large database will hold a request open. If that becomes a problem, move it to the existing BullMQ setup and return a job id.
