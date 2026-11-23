// Queries for dbo.Sensors.
// A keyed Map is returned because the handler needs to look sensors up by
// sensor_key and also compare each sensor's configured unit.

const sql = require('mssql');

async function listActiveSensorsForDevice(pool, deviceId) {
    const result = await pool.request()
        .input('device_id', sql.UniqueIdentifier, deviceId)
        .query(`
            SELECT id, sensor_key, unit
            FROM dbo.Sensors
            WHERE device_id = @device_id
              AND is_active = 1;
        `);

    return result.recordset;
}

function toSensorMap(rows) {
    return new Map(rows.map((row) => [row.sensor_key, row]));
}

module.exports = {
    listActiveSensorsForDevice,
    toSensorMap
};
