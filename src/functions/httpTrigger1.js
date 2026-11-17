//import
const { app } = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const sql = require('mssql');

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

async function listDevices(request, context) {
    let data;
    try {
        data = await request.json();
    } catch {
        return sendError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return sendError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
    }
    if (data.action !== 'device.list') {
        return sendError(400, 'INVALID_ACTION', 'Supported action: device.list.');
    }

    const tokenHash = data.gateway_token_hash;
    if (typeof tokenHash !== 'string' || tokenHash.length !== 64 || /[^0-9a-f]/.test(tokenHash)) {
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

//main
app.http('database', {
    methods: ['GET', 'POST'],
    authLevel: 'function',
    route: 'database',
    handler: async (request, context) => {
        if (request.method === 'POST') {
            return listDevices(request, context);
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
