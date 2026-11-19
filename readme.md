# Azure DB Bridge

The Azure DB Bridge connects the Smart System to an Azure database, enabling the application to communicate with and access its data.

## api

- `GET /api/database`: check the SQL connection.
- `POST /api/database`: actions from the Worker. The Worker calls this for `GET /device` and `GET|POST /measurements`.

Supported actions:

- `device.list`: an active gateway gets its own `devices` list. An invalid or inactive gateway gets `401`. Does not change any SQL rows.
- `measurement.create`: `{ action, gateway_token_hash, message: { request_id, timestamp, device: { id }, measurements: [{ sensor_key, value, unit }] } }`. The device is resolved by `device_name` (or `id`) inside the calling gateway; sensors are resolved by `(device_id, sensor_key)` and `unit` must match `dbo.Sensors.unit`. Inserts into `dbo.Measurements` with `recorded_at` from the payload and `received_at` server-side. Duplicate `(request_id, sensor_id)` pairs are skipped (see the unique index below). Returns `{ status: "ok", request_id, inserted, skipped }`.
- `measurement.list`: `{ action, gateway_token_hash, device_id, limit }`. Returns up to `limit` (1-100) measurements across the gateway's devices, newest first. `device_id` may be `null` (all devices) or a `device_name`/`id` within the gateway.

Run `npm test` for the offline checks. The live bridge needs read/write access to `dbo.Gateways`, `dbo.Devices`, `dbo.Sensors` and `dbo.Measurements` via the Function App's managed identity.

One-time SQL for idempotent measurement ingestion (if not already present):

```sql
CREATE UNIQUE INDEX ux_measurements_request_sensor
ON dbo.Measurements (request_id, sensor_id);
```

AI: the `device.list` change and tests were drafted with Arena.ai.
