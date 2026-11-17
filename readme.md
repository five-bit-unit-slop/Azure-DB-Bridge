# Azure DB Bridge

The Azure DB Bridge connects the Smart System to an Azure database, enabling the application to communicate with and access its data.

## api

- `GET /api/database`: check the SQL connection.
- `POST /api/database`: `device.list` from the Worker. The Worker calls this for `GET /device`.

The bridge requires a Function key. The gateway only sends its Bearer token to the Worker. An active gateway gets its own `devices` list. An invalid or inactive gateway gets `401`. This action does not change any SQL rows.

Run `npm test` for the offline checks. The live bridge needs read access to `dbo.Gateways` and `dbo.Devices`.

AI: the `device.list` change and tests were drafted with Arena.ai.
