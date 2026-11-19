//import
const { app } = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const sql = require('mssql');

//vars
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MEASUREMENTS = 16;
const MAX_VALUE = 9999999.999; // DECIMAL(10,3)

//functions
async function getSqlConfig() {
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken('https://database.windows.net/.default');

    return {
        server: process.env.SQL_SERVER,
        database: process.env.SQL_DATABASE,
        options: {
            encrypt: true,
            trustServerCertificate: false
        },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token: token.token }
        }
    };
}

function sendError(status, code, message) {
    return {
        status,
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: { status: 'error', code, message }
    };
}

function isValidTokenHash(tokenHash) {
    return typeof tokenHash === 'string' && tokenHash.length === 64 && /^[0-9a-f]+$/.test(tokenHash);
}

async function getGateway(pool, tokenHash) {
    const result = await pool.request()
        .input('gateway_token_hash', sql.Char(64), tokenHash)
        .query(`
            SELECT id
            FROM dbo.Gateways
            WHERE gateway_token_hash = @gateway_token_hash
              AND is_active = 1;
        `);
    return result.recordset[0] ?? null;
}

async function resolveDeviceId(pool, gatewayId, deviceIdInput) {
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

async function getDevices(tokenHash) {
    // Eigen pool. De healthcheck gebruikt de globale pool.
    const pool = new sql.ConnectionPool(await getSqlConfig());
    try {
        await pool.connect();

        // LEFT JOIN geeft ook een rij terug als de gateway geen devices heeft.
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
    } finally {
        await pool.close();
    }
}

async function listDevices(request, context, data) {
    if (!data) {
        try {
            data = await request.json();
        } catch {
            return sendError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
        }

        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            return sendError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
        }
    }

    if (data.action !== 'device.list') {
        return sendError(400, 'INVALID_ACTION', 'Supported action: device.list.');
    }

    const tokenHash = data.gateway_token_hash;
    if (!isValidTokenHash(tokenHash)) {
        return sendError(401, 'UNAUTHORIZED', 'A valid gateway token is required.');
    }

    try {
        const rows = await getDevices(tokenHash);
        if (rows.length === 0) {
            return sendError(401, 'UNAUTHORIZED', 'A valid gateway token is required.');
        }

        const devices = [];
        for (const row of rows) {
            if (row.id === null) continue;
            devices.push({
                id: row.id,
                device_name: row.device_name,
                last_seen: row.last_seen,
                is_active: row.is_active
            });
        }

        return {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
            jsonBody: { status: 'ok', devices }
        };
    } catch (error) {
        context.error('Device list SQL request failed:', error?.code ?? 'UNKNOWN');
        return sendError(500, 'DEVICE_LIST_FAILED', 'Failed to list devices.');
    }
}

function validateMeasurement(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        return { ok: false, status: 400, code: 'INVALID_MESSAGE', message: 'message must be a JSON object.' };
    }

    if (typeof message.request_id !== 'string' || !UUID_PATTERN.test(message.request_id)) {
        return { ok: false, status: 400, code: 'INVALID_REQUEST_ID', message: 'request_id must be a valid UUID.' };
    }

    if (typeof message.timestamp !== 'string' || Number.isNaN(Date.parse(message.timestamp))) {
        return { ok: false, status: 400, code: 'INVALID_TIMESTAMP', message: 'timestamp must be a valid ISO 8601 date.' };
    }

    const device = message.device;
    if (device === null || typeof device !== 'object' || Array.isArray(device) ||
        typeof device.id !== 'string' || device.id.trim().length === 0 || device.id.trim().length > 100) {
        return { ok: false, status: 400, code: 'INVALID_DEVICE', message: 'device.id is required.' };
    }

    const measurements = message.measurements;
    if (!Array.isArray(measurements) || measurements.length === 0 || measurements.length > MAX_MEASUREMENTS) {
        return { ok: false, status: 400, code: 'INVALID_MEASUREMENTS', message: `Provide between 1 and ${MAX_MEASUREMENTS} measurements.` };
    }

    const seen = new Set();
    const cleaned = [];
    for (const entry of measurements) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, status: 400, code: 'INVALID_MEASUREMENT', message: 'Each measurement must be a JSON object.' };
        }

        const sensorKey = typeof entry.sensor_key === 'string' ? entry.sensor_key.trim() : '';
        if (sensorKey.length === 0 || sensorKey.length > 100) {
            return { ok: false, status: 400, code: 'INVALID_SENSOR_KEY', message: 'sensor_key is required.' };
        }
        if (seen.has(sensorKey)) {
            return { ok: false, status: 400, code: 'INVALID_SENSOR_KEY', message: 'sensor_key values must be unique.' };
        }
        seen.add(sensorKey);

        const unit = typeof entry.unit === 'string' ? entry.unit.trim() : '';
        if (unit.length === 0 || unit.length > 20) {
            return { ok: false, status: 400, code: 'INVALID_UNIT', message: `Payload '${sensorKey}' has an invalid unit.` };
        }

        const value = Number(entry.value);
        if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE) {
            return { ok: false, status: 400, code: 'INVALID_VALUE', message: `Payload '${sensorKey}' must be a finite number supported by DECIMAL(10,3).` };
        }

        cleaned.push({ sensor_key: sensorKey, unit, value });
    }

    return {
        ok: true,
        value: {
            request_id: message.request_id,
            recorded_at: new Date(message.timestamp),
            device_id: device.id.trim(),
            measurements: cleaned
        }
    };
}

async function createMeasurement(context, data) {
    const tokenHash = data.gateway_token_hash;
    if (!isValidTokenHash(tokenHash)) {
        return sendError(401, 'UNAUTHORIZED', 'A valid gateway token is required.');
    }

    const validated = validateMeasurement(data.message);
    if (!validated.ok) {
        return sendError(validated.status, validated.code, validated.message);
    }
    const message = validated.value;

    const pool = new sql.ConnectionPool(await getSqlConfig());
    try {
        await pool.connect();

        const gateway = await getGateway(pool, tokenHash);
        if (!gateway) {
            return sendError(401, 'UNAUTHORIZED', 'A valid gateway token is required.');
        }

        const deviceId = await resolveDeviceId(pool, gateway.id, message.device_id);
        if (!deviceId) {
            return sendError(404, 'DEVICE_NOT_FOUND', 'Device not found for this gateway.');
        }

        const sensorResult = await pool.request()
            .input('device_id', sql.UniqueIdentifier, deviceId)
            .query(`
                SELECT id, sensor_key, unit
                FROM dbo.Sensors
                WHERE device_id = @device_id
                  AND is_active = 1;
            `);
        const sensors = new Map(sensorResult.recordset.map((row) => [row.sensor_key, row]));

        for (const measurement of message.measurements) {
            const sensor = sensors.get(measurement.sensor_key);
            if (!sensor) {
                return sendError(400, 'UNKNOWN_SENSOR', `Unknown sensor '${measurement.sensor_key}'.`);
            }
            if (sensor.unit !== measurement.unit) {
                return sendError(400, 'UNIT_MISMATCH', `Unit mismatch for sensor '${measurement.sensor_key}'.`);
            }
        }

        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        let inserted = 0;
        let skipped = 0;
        try {
            for (const measurement of message.measurements) {
                const sensor = sensors.get(measurement.sensor_key);
                const result = await transaction.request()
                    .input('sensor_id', sql.UniqueIdentifier, sensor.id)
                    .input('request_id', sql.UniqueIdentifier, message.request_id)
                    .input('value', sql.Decimal(10, 3), measurement.value)
                    .input('recorded_at', sql.DateTime2, message.recorded_at)
                    .query(`
                        INSERT INTO dbo.Measurements (id, sensor_id, request_id, measurement_value, recorded_at, received_at)
                        SELECT NEWID(), @sensor_id, @request_id, @value, @recorded_at, SYSUTCDATETIME()
                        WHERE NOT EXISTS (
                            SELECT 1 FROM dbo.Measurements
                            WHERE request_id = @request_id AND sensor_id = @sensor_id
                        );
                    `);
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

        return {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
            jsonBody: { status: 'ok', request_id: message.request_id, inserted, skipped }
        };
    } catch (error) {
        context.error('Measurement create SQL request failed:', error?.number ?? error?.code ?? 'UNKNOWN');
        return sendError(500, 'MEASUREMENT_CREATE_FAILED', 'Failed to store measurements.');
    } finally {
        await pool.close();
    }
}

async function listMeasurements(context, data) {
    const tokenHash = data.gateway_token_hash;
    if (!isValidTokenHash(tokenHash)) {
        return sendError(401, 'UNAUTHORIZED', 'A valid gateway token is required.');
    }

    const deviceIdInput = data.device_id;
    if (deviceIdInput !== null && deviceIdInput !== undefined) {
        if (typeof deviceIdInput !== 'string' || deviceIdInput.trim().length === 0 || deviceIdInput.trim().length > 100) {
            return sendError(400, 'INVALID_DEVICE', 'device_id must contain between 1 and 100 characters.');
        }
    }

    const limit = data.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendError(400, 'INVALID_LIMIT', 'limit must be an integer between 1 and 100.');
    }

    const pool = new sql.ConnectionPool(await getSqlConfig());
    try {
        await pool.connect();

        const gateway = await getGateway(pool, tokenHash);
        if (!gateway) {
            return sendError(401, 'UNAUTHORIZED', 'A valid gateway token is required.');
        }

        let deviceId = null;
        if (typeof deviceIdInput === 'string' && deviceIdInput.trim().length > 0) {
            deviceId = await resolveDeviceId(pool, gateway.id, deviceIdInput.trim());
            if (!deviceId) {
                return sendError(404, 'DEVICE_NOT_FOUND', 'Device not found for this gateway.');
            }
        }

        const request = pool.request()
            .input('gateway_id', sql.UniqueIdentifier, gateway.id)
            .input('limit', sql.Int, limit);
        let statement = `
            SELECT m.id, m.request_id, d.device_name, s.sensor_key, m.measurement_value, s.unit, m.recorded_at, m.received_at
            FROM dbo.Measurements AS m
            INNER JOIN dbo.Sensors AS s ON s.id = m.sensor_id
            INNER JOIN dbo.Devices AS d ON d.id = s.device_id
            WHERE d.gateway_id = @gateway_id`;
        if (deviceId) {
            request.input('device_id', sql.UniqueIdentifier, deviceId);
            statement += ' AND d.id = @device_id';
        }
        statement += `
            ORDER BY m.recorded_at DESC, m.received_at DESC
            OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`;

        const result = await request.query(statement);
        const measurements = result.recordset.map((row) => ({
            id: row.id,
            request_id: row.request_id,
            device_name: row.device_name,
            sensor_key: row.sensor_key,
            value: Number(row.measurement_value),
            unit: row.unit,
            recorded_at: row.recorded_at,
            received_at: row.received_at
        }));

        return {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
            jsonBody: { status: 'ok', measurements }
        };
    } catch (error) {
        context.error('Measurement list SQL request failed:', error?.number ?? error?.code ?? 'UNKNOWN');
        return sendError(500, 'MEASUREMENT_LIST_FAILED', 'Failed to list measurements.');
    } finally {
        await pool.close();
    }
}

//main
app.http('database', {
    methods: ['GET', 'POST'],
    authLevel: 'function',
    route: 'database',
    handler: async (request, context) => {
        if (request.method === 'POST') {
            let data;
            try {
                data = await request.json();
            } catch {
                return sendError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
            }
            if (data === null || typeof data !== 'object' || Array.isArray(data)) {
                return sendError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
            }

            if (data.action === 'device.list') {
                return listDevices(request, context, data);
            }
            if (data.action === 'measurement.create') {
                return createMeasurement(context, data);
            }
            if (data.action === 'measurement.list') {
                return listMeasurements(context, data);
            }
            return sendError(400, 'INVALID_ACTION', 'Supported actions: device.list, measurement.create, measurement.list.');
        }

        let pool;
        try {
            pool = await sql.connect(await getSqlConfig());

            const result = await pool.request().query(`
                SELECT
                    DB_NAME() AS database_name,
                    SUSER_SNAME() AS authenticated_identity,
                    SYSUTCDATETIME() AS server_time;
            `);

            return {
                status: 200,
                headers: { 'Cache-Control': 'no-store' },
                jsonBody: {
                    status: 'connected',
                    ...result.recordset[0]
                }
            };
        } catch (error) {
            context.error('Database connection failed:', error);

            return {
                status: 500,
                jsonBody: {
                    status: 'error',
                    message: 'Database connection failed.'
                }
            };
        } finally {
            if (pool) {
                await pool.close();
            }
        }
    }
});
