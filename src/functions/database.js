// HTTP trigger registration and action dispatch.
// This is the only place the 'database' route is registered.

// Loading index.js applies the app-level setup (HTTP streaming).
require('../index');

const { app } = require('@azure/functions');
const { readJsonObject, sendError } = require('../utils/responses');
const { withSharedConnection } = require('../database/connection');
const { handleDeviceList } = require('../handlers/deviceHandler');
const {
    handleMeasurementCreate,
    handleMeasurementList
} = require('../handlers/measurementHandler');

const ACTIONS = {
    'device.list': handleDeviceList,
    'measurement.create': handleMeasurementCreate,
    'measurement.list': handleMeasurementList
};

const SUPPORTED_ACTIONS = Object.keys(ACTIONS).join(', ');

// GET is a health check. It reports what the connection actually sees, which
// makes a missing database user or a wrong SQL_SERVER visible immediately.
async function healthCheck(context) {
    try {
        const row = await withSharedConnection(async (pool) => {
            const result = await pool.request().query(`
                SELECT
                    DB_NAME() AS database_name,
                    SUSER_SNAME() AS authenticated_identity,
                    SYSUTCDATETIME() AS server_time;
            `);
            return result.recordset[0];
        });

        return {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
            jsonBody: {
                status: 'connected',
                ...row
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
    }
}

async function dispatch(request, context) {
    if (request.method !== 'POST') {
        return healthCheck(context);
    }

    const body = await readJsonObject(request);
    if (!body.ok) {
        return body.response;
    }

    const data = body.value;
    const handler = ACTIONS[data.action];

    if (!handler) {
        return sendError(400, 'INVALID_ACTION', `Supported actions: ${SUPPORTED_ACTIONS}.`);
    }

    return handler(context, data);
}

app.http('database', {
    methods: ['GET', 'POST'],
    authLevel: 'function',
    route: 'database',
    handler: dispatch
});

module.exports = {
    dispatch,
    SUPPORTED_ACTIONS
};
