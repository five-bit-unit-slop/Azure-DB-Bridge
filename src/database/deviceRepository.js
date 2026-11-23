// Queries for dbo.Devices.
// Every query is scoped by gateway_id so a caller can never resolve a device
// that belongs to someone else.

const sql = require('mssql');

// Device identifiers arrive as either a device_name or a UUID. A single query
// accepts both, so the caller does not have to know which one it has.
async function findActiveDeviceId(pool, gatewayId, deviceIdInput) {
    const result = await pool.request()
        .input('gateway_id', sql.UniqueIdentifier, gatewayId)
        .input('device_id', sql.NVarChar(100), deviceIdInput)
        .query(`
            SELECT id
            FROM dbo.Devices
            WHERE gateway_id = @gateway_id
              AND is_active = 1
              AND (device_name = @device_id
                   OR (TRY_CAST(@device_id AS uniqueidentifier) IS NOT NULL
                       AND id = TRY_CAST(@device_id AS uniqueidentifier)));
        `);

    return result.recordset[0]?.id ?? null;
}

// LEFT JOIN keeps a row for a gateway that has no devices yet, which is what
// lets the handler answer 200 with an empty list instead of 401.
async function listDevicesForGateway(pool, tokenHash) {
    const result = await pool.request()
        .input('gateway_token_hash', sql.Char(64), tokenHash)
        .query(`
            SELECT d.id, d.device_name, d.last_seen, d.is_active
            FROM dbo.Gateways AS g
            LEFT JOIN dbo.Devices AS d ON d.gateway_id = g.id
            WHERE g.gateway_token_hash = @gateway_token_hash
              AND g.is_active = 1
            ORDER BY d.device_name, d.id;
        `);

    return result.recordset;
}

module.exports = {
    findActiveDeviceId,
    listDevicesForGateway
};
