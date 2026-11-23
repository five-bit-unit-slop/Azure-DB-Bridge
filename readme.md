# Azure DB Bridge

> documentation made with ai cus I am too lazy :)

A single Azure Function that lets field hardware (Raspberry Pi Pico gateways) talk to
**Azure SQL** over HTTPS. Devices authenticate with a gateway token, the bridge resolves
what that gateway is actually allowed to see, and all SQL access stays server-side.

Two things it does:

- **Devices**: list the devices belonging to a gateway.
- **Measurements**: insert sensor readings idempotently, and read them back.

Everything is scoped: a gateway token can only ever see its own devices, sensors and
measurements. SQL errors are logged, never returned to the caller.

---

## Contents

- [TL;DR](#tldr)
- [API](#api)
- [How a request is processed](#how-a-request-is-processed)
- [Data model](#data-model)
- [Configuration](#configuration)
- [Run locally](#run-locally)
- [Testing](#testing)
- [Deployment](#deployment)
- [Design notes](#design-notes)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Hardware side](#hardware-side)
- [License](#license)

---

## TL;DR

Local development against a real database:

```bash
npm install
func start                       # needs Azure Functions Core Tools v4, Node 20+
npm test                         # 20 tests, no Azure account needed
```

Call it:

```bash
curl -X POST "http://localhost:7071/api/database?code=<function-key>" \
  -H "Content-Type: application/json" \
  -d '{"action":"device.list","gateway_token_hash":"<64 hex chars>"}'
```

Deployment is automatic: pushing to `main` builds, tests and deploys to the
`smartsystem-db-bridge` Function App via GitHub Actions + OIDC. No publish profile.

---

## API

One endpoint, **one route**: `GET|POST /api/database`.

- `authLevel: function`, the Function **key** (`?code=...` or `x-functions-key`) is
  required for every call. It identifies *the application*, not the gateway.
- `POST` bodies are JSON objects and are dispatched on `action`.
- `GET` (no body) is a health check against the database.

### Which credential does what

There are two separate auth layers, and mixing them up is the most common mistake:

| Layer | Credential | Purpose |
| --- | --- | --- |
| Function key | `?code=` / `x-functions-key` | App-level access. Stops anonymous traffic. |
| Gateway | `gateway_token_hash` in the body | Tenant-level access. Decides *whose* data you get. |

The gateway credential is the **SHA-256 hash** of the gateway token, as a 64-character
lowercase hex string. The bridge compares it to `dbo.Gateways.gateway_token_hash`. The raw
token never travels to Azure.

### `device.list`

```json
{ "action": "device.list", "gateway_token_hash": "<64 hex>" }
```

Returns every active device for the gateway. A gateway with no devices still returns
`200` with an empty array, that proves the token worked.

```json
{
  "status": "ok",
  "devices": [
    { "id": "2222...", "device_name": "pico-001", "last_seen": "...", "is_active": true }
  ]
}
```

### `measurement.create`

```json
{
  "action": "measurement.create",
  "gateway_token_hash": "<64 hex>",
  "message": {
    "request_id": "99999999-9999-4999-8999-999999999999",
    "timestamp": "2026-11-16T12:00:00Z",
    "device": { "id": "pico-001" },
    "measurements": [
      { "sensor_key": "light",     "value": 1820,  "unit": "raw" },
      { "sensor_key": "draaiknop", "value": 32768, "unit": "raw" }
    ]
  }
}
```

```json
{ "status": "ok", "request_id": "9999...", "inserted": 2, "skipped": 0 }
```

Rules enforced before anything is written:

- `request_id` must be a UUID, it is the **idempotency key**.
- `timestamp` must parse as a date and is stored as `recorded_at`.
- `device.id` is either a `device_name` **or** a device UUID, and must belong to the
  calling gateway (`404` otherwise).
- 1 to 16 measurements per message.
- `sensor_key` must exist and be active for that device, unique within the message.
- `unit` must match the sensor's configured unit exactly.
- `value` must be a finite number representable as `DECIMAL(10,3)`, max `9999999.999`.

**Idempotency:** inserts are guarded by
`WHERE NOT EXISTS (SELECT 1 ... WHERE request_id = @request_id AND sensor_id = @sensor_id)`.
Replaying the same message is safe, every row becomes `skipped` instead of duplicated.
All rows for one message go in via a single transaction, rolled back on any failure.

### `measurement.list`

```json
{ "action": "measurement.list", "gateway_token_hash": "<64 hex>", "limit": 25, "device_id": "pico-001" }
```

- `limit` is **required**: integer `1` to `100`.
- `device_id` is optional; accepts a device name or UUID, must belong to the gateway.

Results are gateway-scoped, newest first (`recorded_at DESC, received_at DESC`).
Each row flattens the joins into `id, request_id, device_name, sensor_key, value, unit,
recorded_at, received_at`.

### Health check (`GET`)

No body. Connects to SQL and reports what it sees:

```json
{ "status": "connected", "database_name": "...", "authenticated_identity": "...", "server_time": "..." }
```

Useful for confirming that the Function's managed identity actually has a database user.

### Error format

Every failure returns the same JSON shape, with `Cache-Control: no-store`:

```json
{ "status": "error", "code": "DEVICE_NOT_FOUND", "message": "Device not found for this gateway." }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `INVALID_JSON` | 400 | Body is not a JSON object |
| `INVALID_ACTION` | 400 | Unknown or missing `action` |
| `INVALID_REQUEST_ID` | 400 | `request_id` is not a UUID |
| `INVALID_TIMESTAMP` | 400 | `timestamp` unparseable |
| `INVALID_DEVICE` | 400 | Bad/missing `device.id` or `device_id` |
| `INVALID_MEASUREMENTS` | 400 | Not 1 to 16 measurements |
| `INVALID_SENSOR_KEY` | 400 | Missing, too long, or duplicated key |
| `INVALID_UNIT` | 400 | Missing or too long unit |
| `INVALID_VALUE` | 400 | Non-finite or out of `DECIMAL(10,3)` range |
| `INVALID_LIMIT` | 400 | `limit` not an integer 1 to 100 |
| `UNKNOWN_SENSOR` | 400 | Sensor not configured for the device |
| `UNIT_MISMATCH` | 400 | Unit differs from the sensor's unit |
| `UNAUTHORIZED` | 401 | Missing/invalid hash, or no active gateway |
| `DEVICE_NOT_FOUND` | 404 | Device not in this gateway |
| `DEVICE_LIST_FAILED` | 500 | SQL error while listing devices |
| `MEASUREMENT_CREATE_FAILED` | 500 | SQL error while inserting |
| `MEASUREMENT_LIST_FAILED` | 500 | SQL error while reading |

`500` bodies are deliberately generic. The SQL error number/code is written to the
Function log, never to the response.

---

## How a request is processed

```text
POST /api/database?code=...
        |
        v
Function key valid?           -- no --> 401 (handled by the Functions host)
        |
        v
body is a JSON object?        -- no --> 400 INVALID_JSON
        |
        v
dispatch on action
        |
        +-- device.list ---------+
        +-- measurement.create --+
        +-- measurement.list ---+
        |
        v
gateway_token_hash is 64 hex?      -- no --> 401 UNAUTHORIZED
        |
        v
gateway exists and is_active?      -- no --> 401 UNAUTHORIZED
        |
        v
resolve device inside gateway      -- no --> 404 DEVICE_NOT_FOUND
        |
        v
validate payload (create only)     -- no --> 400 with a specific code
        |
        v
Azure SQL (parameterised, always)
        |
        v
200 ok   --or--   500 with a generic message + logged SQL code
```

Validation is ordered deliberately: cheap checks happen before any database connection is
opened, and the gateway is resolved before any device lookup, so an invalid caller can
never probe which device names exist.

---

## Data model

The bridge expects these tables in Azure SQL. It only ever reads and inserts; nothing in
this repo creates schema.

```text
dbo.Gateways
  id                  uniqueidentifier  PK
  gateway_token_hash  char(64)          <- SHA-256 of the gateway token
  is_active           bit

dbo.Devices
  id                  uniqueidentifier  PK
  gateway_id          uniqueidentifier  -> Gateways.id
  device_name         nvarchar(100)
  last_seen           datetime2
  is_active           bit

dbo.Sensors
  id                  uniqueidentifier  PK
  device_id           uniqueidentifier  -> Devices.id
  sensor_key          nvarchar(100)     <- e.g. 'light', 'draaiknop'
  unit                nvarchar(20)      <- must match payload exactly
  is_active           bit

dbo.Measurements
  id                  uniqueidentifier  PK  (NEWID())
  sensor_id           uniqueidentifier  -> Sensors.id
  request_id          uniqueidentifier     <- idempotency key
  measurement_value   decimal(10,3)
  recorded_at         datetime2            <- device timestamp
  received_at         datetime2            <- SYSUTCDATETIME()
```

`(request_id, sensor_id)` is the effective uniqueness constraint that the insert guard
relies on. Adding a real unique index on that pair is on the roadmap. Right now the
`NOT EXISTS` check is the only thing preventing duplicates under concurrency.

---

## Configuration

Set these as **application settings** on the Function App (or in `local.settings.json`
locally). Nothing is read from a committed file.

| Setting | Example | Notes |
| --- | --- | --- |
| `SQL_SERVER` | `smartsystem.database.windows.net` | Host name only, no `tcp:` prefix |
| `SQL_DATABASE` | `smartsystem` | Target database |
| `AZURE_CLIENT_ID` | `...` | Only needed if the identity is user-assigned |

Authentication to SQL is **Azure AD only**: via `DefaultAzureCredential`:

- Locally: whatever `az login` gives you.
- In Azure: the Function App's managed identity.

The identity needs a database user with `SELECT` on `Gateways`, `Devices`, `Sensors` and
`SELECT`/`INSERT` on `Measurements`. There is no SQL password anywhere in this project.

---

## Run locally

```bash
npm install
cp local.settings.json.example local.settings.json   # not committed; see .funcignore
npm start                                            # func start
```

`npm start` runs `func start`, so [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
must be installed. Node 20+ works; CI builds on Node 24.

If you just want to check the tests, `npm test` needs no Functions runtime, no Azure
login and no database, the SQL layer is stubbed.

---

## Testing

```bash
npm test        # node --test test/*.test.js
npm run lint    # node --check over src/ and test/
```

41 tests across four files:

| File | What it covers |
| --- | --- |
| `test/device-list.test.js` | the whole HTTP path for `device.list`, through the route |
| `test/measurement.test.js` | create and list, through the route, including rollback |
| `test/validation.test.js` | pure validators, no stubs needed at all |
| `test/services.test.js` | service orchestration against a fake pool |

The loader in `test/support/loadModule.js` compiles the CommonJS source through
`node:vm` and follows relative `require` calls, injecting fake `@azure/functions`,
`@azure/identity` and `mssql` into every module in the graph. So the same stubs reach the
handler, the service and the repository, and each test gets its own module cache and
therefore a clean module state.

What is actually covered:

- the route stays `database`, `authLevel: function`, `GET|POST`
- the `GET` health check still reaches SQL
- bad JSON, unknown actions and malformed gateway hashes never reach SQL
- an inactive or unknown gateway returns `401`
- a gateway with no devices returns `200` with `[]`, not an error
- queries are parameterised and scoped to the gateway
- invalid bodies are rejected before any connection is opened
- a bad token costs zero pooled connections and zero token requests
- devices and sensors are scoped to the calling gateway
- the device is resolved before sensors are read
- unknown sensors and unit mismatches are rejected before inserting
- a failed insert rolls the transaction back and leaks no SQL detail
- insert dedupe on `(request_id, sensor_id)`, with `inserted`/`skipped` counts
- `measurement.list` applies `limit` and rejects bad `device_id`/`limit` early
- an unfiltered list never issues a device lookup
- SQL errors surface as JSON `500`s without SQL text

**Not covered:** a real SQL Server, concurrency, and the schema itself. The suite proves
the shape of the generated SQL, not that SQL Server enforces it. That is why the
unique-index item is on the roadmap.

---

## Deployment

`.github/workflows/main_smartsystem-db-bridge.yml` is the only deploy pipeline:

```text
push to main
    |
    v
build: checkout -> Node 24 -> npm install -> npm run build (if present) -> npm test
    |
    v
zip release artifact
    |
    v
deploy: download -> unzip -> azure/login (OIDC, no stored credential) -> functions-action
```

Deployment target: Function App `smartsystem-db-bridge`, slot `Production`. The pipeline
authenticates with GitHub OIDC and per-workflow `AZUREAPPSERVICE_*` secrets, so **no
publish profile is stored**. Running tests in the build job means a red test blocks the
deploy. Keep it that way.

`test/` and `local.settings.json` are excluded from the deployed package by `.funcignore`,
so tests never ship and local secrets never leave the machine.

---

## Design notes

Why the code looks the way it does, in case you are tempted to "simplify" it:

- **`DefaultAzureCredential` + AAD token auth, not a connection string.** No password to
  rotate, leak or accidentally commit, and the same code path works locally and in Azure.
- **Hash comparison in SQL, not in JavaScript.** The gateway token hash is passed as a
  `CHAR(64)` parameter and matched in the `WHERE` clause, so a wrong hash is a query that
  returns zero rows rather than a code path that can be bypassed.
- **Every query is parameterised** (`sql.UniqueIdentifier`, `sql.NVarChar`, `sql.Decimal`,
  `sql.Char`). No string-built SQL anywhere; `measurement.list` assembles its statement
  from fixed fragments only, with `@limit`/`@device_id` bound as parameters.
- **Per-request connection pools.** Each call opens its own `ConnectionPool` and closes it
  in `finally`. Slightly wasteful, but it avoids leaking a stale pool between
  invocations. A shared pool is on the roadmap.
- **`OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`** requires `ORDER BY`, which is why the
  ordering clause is non-optional, paging cannot be added later without changing it.
- **Errors are coded, not narrated.** Each failure has a stable `code` the Pi can branch
  on without string-matching English prose.
- **Rollback, not best-effort.** A partially stored message would leave a device unable to
  retry safely, so the whole message either lands or none of it does.

---

## Known limitations

- **`limit` is mandatory** on `measurement.list`, and capped at 100. There is no paging
  or cursor, so reading history means repeated calls with no "older than" filter.
- **No time-range filter**: you cannot ask for "since `recorded_at`" yet, only the newest N.
- **Idempotency depends on a query, not a constraint.** Under true concurrency two
  identical inserts can both see `NOT EXISTS` and both write. A unique index on
  `(request_id, sensor_id)` is the real fix and is on the roadmap.
- **`last_seen` is never updated** by this bridge. Devices appear in `device.list` with
  whatever value the Pi last wrote (or `null` if nothing writes it).
- **No `device.register` / sensor provisioning actions**: devices and sensors must be
  seeded out-of-band.
- **One device per measurement message.** Batching several devices into one message is not
  supported; `MAX_MEASUREMENTS = 16` is per device.
- **Function key is not per-device.** Any holder of the shared Function key can reach the
  route; the gateway hash is what actually separates tenants, so rotate leaked keys.
- **`GET` health check leaks identity details** (`SUSER_SNAME()`), fine behind a function
  key, but do not expose it publicly.
- **No coverage reporting.** Tests load source through `node:vm`, so `--experimental-test-coverage`
  cannot instrument it, and the HTTP-path tests assert on SQL strings, so changing a query
  breaks a test by design.
- **The access token is cached for the life of the worker.** It is refreshed five minutes
  before expiry, but a revoked identity keeps working until then.

---

## Roadmap

Section headings carry the status. No glyphs are used, so everything stays plain markdown.

### Done

- [x] Azure SQL connection via AAD token (`DefaultAzureCredential`), no stored password
- [x] Function-key auth plus per-gateway token hash scoping
- [x] `device.list`, gateway-scoped, empty list is not an error
- [x] `measurement.create` with full pre-SQL validation, transaction, rollback
- [x] Idempotent inserts on `(request_id, sensor_id)`, with `inserted`/`skipped` counts
- [x] `measurement.list`, gateway-scoped, `limit` + optional `device_id`
- [x] `GET` health check (database, identity, server time)
- [x] Stable error codes; SQL details logged, never returned
- [x] 20 tests over routes, validation, scoping and rollback
- [x] CI: test in build, OIDC deploy, single pipeline
- [x] All queries parameterised; gateway scoping enforced in SQL

### Done after the module split

- [x] `utils/responses.js`: `ok`, `sendError`, `readJsonObject`, `isPlainObject`
- [x] `database/connection.js`: AAD token with a cached token, `withPool`, `withSharedConnection`
- [x] `validation/deviceValidation.js`: the 64-hex gateway hash check
- [x] `validation/measurementValidation.js`: message, device filter and limit validators
- [x] `database/gatewayRepository.js`: `findActiveGateway`
- [x] `database/deviceRepository.js`: `findActiveDeviceId`, `listDevicesForGateway`
- [x] `database/sensorRepository.js`: active sensors, keyed as a Map
- [x] `database/measurementRepository.js`: insert with dedupe in a transaction, list query
- [x] `services/deviceService.js`: validation phase plus gateway resolution
- [x] `services/measurementService.js`: validation phase plus create and list orchestration
- [x] `handlers/deviceHandler.js`, `handlers/measurementHandler.js`: request to service to response
- [x] `functions/database.js`: the one and only `database` registration, dispatching on `action`
- [x] `httpTrigger1.js` deleted, no references left
- [x] Tests follow the new entry point and gained unit coverage (41 tests, up from 20)
- [x] Every request validates before it opens a connection

### Fixed alongside the split

- [x] `package.json` `main` used `src/{index.js,functions/*.js}`, a brace pattern the v4
  model does not understand, so the host could not find the registrations
- [x] `src/index.js` was never loaded, so `app.setup()` never ran
- [x] The deploy job packaged the source tree instead of the built artifact, and never ran
  `npm install`, so `node_modules` was missing from the deployment
- [x] Artifact now excludes `test/`, `.github/`, `local.settings.json` and patches
- [x] `setup-node@v3` to `@v4`
- [x] `local.settings.json.example` added, and kept out of the deployed package

### Planned

- [ ] **Unique index on `Measurement(request_id, sensor_id)`** and treat duplicate-key as
      `skipped`, closes the concurrency gap in idempotency
- [ ] **`measurement.list` time-range filter** (`since`/`until`, or a cursor) next to `limit`
- [ ] **Paging for `measurement.list`**: keyset on `(recorded_at, id)` rather than
      deepening `OFFSET`
- [ ] **Shared SQL connection pool** across invocations instead of one per request (the
      token is already cached, the pool is not)
- [ ] **`device.last_seen` update** on a successful `measurement.create`
- [ ] **`device.register` / sensor provisioning** so devices can self-enrol
- [ ] **Per-device credentials** so one leaked token does not expose a whole gateway
- [ ] **Schema migrations** as versioned SQL in the repo instead of out-of-band setup
- [ ] **Integration tests** against a real (or containerised) SQL Server, including a
      concurrent duplicate-insert case

### Under consideration

- [ ] **REST paths** (`/api/devices`, `/api/measurements`) instead of a single `action`
      route: nicer for tooling, but breaks every deployed Pi, so it needs a versioned
      route (`/api/v2/...`) and a deprecation window
- [ ] **`limit` defaults to 25** when omitted, with an optional header to opt into strict
- [ ] **API version in the route** (`/api/v1/database`)
- [ ] **ESLint + coverage** in CI, and a `README`-linked OpenAPI description

---

## Repository layout

```text
Azure-DB-Bridge/
|-- host.json
|-- package.json                    main: src/functions/*.js
|-- local.settings.json.example     copy to local.settings.json
|-- src/
|   |-- index.js                    app.setup(), HTTP streaming
|   |-- functions/
|   |   `-- database.js             the only route registration, dispatches on action
|   |-- handlers/
|   |   |-- deviceHandler.js
|   |   `-- measurementHandler.js
|   |-- services/
|   |   |-- deviceService.js
|   |   `-- measurementService.js
|   |-- database/
|   |   |-- connection.js           AAD token, pools
|   |   |-- gatewayRepository.js
|   |   |-- deviceRepository.js
|   |   |-- sensorRepository.js
|   |   `-- measurementRepository.js
|   |-- validation/
|   |   |-- deviceValidation.js
|   |   `-- measurementValidation.js
|   `-- utils/
|       `-- responses.js
|-- test/
|   |-- support/loadModule.js       node:vm loader with stubbed modules
|   |-- device-list.test.js
|   |-- measurement.test.js
|   |-- services.test.js
|   `-- validation.test.js
`-- .github/workflows/main_smartsystem-db-bridge.yml
```

Dependencies point one way: `functions` to `handlers` to `services` to `database` and
`validation`. Nothing in `database/` knows about HTTP, and nothing in `validation/` knows
about SQL, which is what makes both testable without Azure.

---

## Hardware side

The intended clients are Raspberry Pi Pico W gateways. A typical flow:

1. Gateway boots, hashes its token (SHA-256, lowercase hex), the same hash stored in
   `dbo.Gateways.gateway_token_hash`.
2. `POST {"action":"device.list"}` to learn which devices it owns.
3. Each device's readings are posted as one `measurement.create` per message, with a
   fresh `request_id` (UUIDv4) and an ISO 8601 `timestamp`.
4. On a timeout or a `500`, the gateway simply retries the same message, the bridge
   de-duplicates it.

Send the Function key as `x-functions-key` rather than `?code=` if the request log keeps
the query string.

---

## License

Not specified in this repository yet. Add one (MIT matches the sibling
`azure-vm-bootstrap` project) before reusing this code outside the course.
