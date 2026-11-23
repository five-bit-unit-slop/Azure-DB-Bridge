// Queries for dbo.Measurements.
//
// Inserts are idempotent on (request_id, sensor_id). The NOT EXISTS guard makes
// a retried message a no-op instead of a duplicate row. Rows for one message go
// in through a single transaction so a partial write can never happen.

const sql = require('mssql');

const INSERT_STATEMENT = `
    INSERT INTO dbo.Measurements (id, sensor_id, request_id, measurement_value, recorded_at, received_at)
    SELECT NEWID(), @sensor_id, @request_id, @value, @recorded_at, SYSUTCDATETIME()
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.Measurements
        WHERE request_id = @request_id AND sensor_id = @sensor_id
    );
`;

const LIST_BASE_STATEMENT = `
    SELECT m.id, m.request_id, d.device_name, s.sensor_key, m.measurement_value, s.unit, m.recorded_at, m.received_at
    FROM dbo.Measurements AS m
    INNER JOIN dbo.Sensors AS s ON s.id = m.sensor_id
    INNER JOIN dbo.Devices AS d ON d.id = s.device_id
    WHERE d.gateway_id = @gateway_id`;

const LIST_ORDER_STATEMENT = `
    ORDER BY m.recorded_at DESC, m.received_at DESC
    OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`;

// Inserts one row per measurement inside a transaction. Returns how many rows
// were actually written and how many were already present.
async function insertMeasurements(pool, rows) {
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    let inserted = 0;
    let skipped = 0;

    try {
        for (const row of rows) {
            const result = await transaction.request()
                .input('sensor_id', sql.UniqueIdentifier, row.sensor_id)
                .input('request_id', sql.UniqueIdentifier, row.request_id)
                .input('value', sql.Decimal(10, 3), row.value)
                .input('recorded_at', sql.DateTime2, row.recorded_at)
                .query(INSERT_STATEMENT);

            if ((result.rowsAffected?.[0] ?? 0) > 0) {
                inserted++;
            } else {
                skipped++;
            }
        }

        await transaction.commit();
    } catch (error) {
        await transaction.rollback();
        throw error;
    }

    return { inserted, skipped };
}

async function listMeasurements(pool, { gatewayId, deviceId, limit }) {
    const request = pool.request()
        .input('gateway_id', sql.UniqueIdentifier, gatewayId)
        .input('limit', sql.Int, limit);

    let statement = LIST_BASE_STATEMENT;

    if (deviceId) {
        request.input('device_id', sql.UniqueIdentifier, deviceId);
        statement += ' AND d.id = @device_id';
    }

    statement += LIST_ORDER_STATEMENT;

    const result = await request.query(statement);

    return result.recordset.map((row) => ({
        id: row.id,
        request_id: row.request_id,
        device_name: row.device_name,
        sensor_key: row.sensor_key,
        value: Number(row.measurement_value),
        unit: row.unit,
        recorded_at: row.recorded_at,
        received_at: row.received_at
    }));
}

module.exports = {
    INSERT_STATEMENT,
    insertMeasurements,
    listMeasurements
};
