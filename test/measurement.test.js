//import
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { compileFunction } = require('node:vm');

//vars
const file = require.resolve('../src/functions/httpTrigger1');
const loadFunction = compileFunction(readFileSync(file, 'utf8'), ['require', 'process'], { filename: file });
const hash = 'a'.repeat(64);
const gatewayId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const sensorId = '33333333-3333-4333-8333-333333333333';
const requestId = '99999999-9999-4999-8999-999999999999';
const context = { error() {} };

const validMessage = {
    request_id: requestId,
    timestamp: '2026-11-16T12:00:00Z',
    device: { id: 'pico-001' },
    measurements: [
        { sensor_key: 'light', value: 1820, unit: 'raw' },
        { sensor_key: 'draaiknop', value: 32768, unit: 'raw' }
    ]
};

const gatewayRow = { id: gatewayId };
const deviceRow = { id: deviceId };
const sensorRows = [
    { id: sensorId, sensor_key: 'light', unit: 'raw' },
    { id: '44444444-4444-4444-8444-444444444444', sensor_key: 'draaiknop', unit: 'raw' }
];

//functions
function loadRoute(queryHandler) {
    let route;
    const queries = [];
    const transactionCalls = { begin: 0, commit: 0, rollback: 0 };

    const makeRequest = (recorder) => ({
        inputs: {},
        input(name, type, value) {
            this.inputs[name] = { type, value };
            return this;
        },
        async query(statement) {
            const record = { statement, inputs: { ...this.inputs } };
            queries.push(record);
            return recorder(statement, record.inputs);
        }
    });

    const pool = {
        async connect() {},
        async close() {},
        request() {
            return makeRequest(async (statement, inputs) => queryHandler(statement, inputs));
        }
    };

    const transaction = {
        async begin() { transactionCalls.begin++; },
        async commit() { transactionCalls.commit++; },
        async rollback() { transactionCalls.rollback++; },
        request() {
            return makeRequest(async (statement, inputs) => queryHandler(statement, inputs));
        }
    };

    const modules = {
        '@azure/functions': { app: { http(name, config) { route = { name, ...config }; } } },
        '@azure/identity': {
            DefaultAzureCredential: function () {
                this.getToken = async () => ({ token: 'fake-sql-token' });
            }
        },
        mssql: {
            Char: (length) => `Char(${length})`,
            NVarChar: (length) => `NVarChar(${length})`,
            Int: 'Int',
            UniqueIdentifier: 'UniqueIdentifier',
            Decimal: (precision, scale) => `Decimal(${precision},${scale})`,
            DateTime2: 'DateTime2',
            ConnectionPool: function () { return pool; },
            connect: async () => pool,
            Transaction: function () { return transaction; }
        }
    };

    loadFunction((name) => modules[name], { env: {} });
    return { route, queries, transactionCalls };
}

function defaultHandler(statement) {
    if (/FROM dbo\.Gateways/.test(statement)) return { recordset: [gatewayRow] };
    if (/FROM dbo\.Devices/.test(statement)) return { recordset: [deviceRow] };
    if (/FROM dbo\.Sensors/.test(statement)) return { recordset: sensorRows };
    if (/^\s*INSERT INTO dbo\.Measurements/.test(statement)) return { recordset: [], rowsAffected: [1] };
    if (/FROM dbo\.Measurements/.test(statement)) {
        return {
            recordset: [{
                id: '55555555-5555-4555-8555-555555555555',
                request_id: requestId,
                device_name: 'pico-001',
                sensor_key: 'light',
                measurement_value: '1820.000',
                unit: 'raw',
                recorded_at: new Date('2026-11-16T12:00:00Z'),
                received_at: new Date('2026-11-16T12:00:01Z')
            }]
        };
    }
    return { recordset: [] };
}

function post(route, data) {
    return route.handler({ method: 'POST', json: async () => data }, context);
}

function createBody(overrides = {}) {
    return { action: 'measurement.create', gateway_token_hash: hash, message: validMessage, ...overrides };
}

//tests
test('measurement.create stores a measurement per sensor in one transaction', async () => {
    const { route, queries, transactionCalls } = loadRoute(defaultHandler);
    const result = await post(route, createBody());

    assert.equal(result.status, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.deepEqual(result.jsonBody, { status: 'ok', request_id: requestId, inserted: 2, skipped: 0 });
    assert.equal(transactionCalls.begin, 1);
    assert.equal(transactionCalls.commit, 1);
    assert.equal(transactionCalls.rollback, 0);

    const inserts = queries.filter((q) => q.statement.includes('INSERT INTO dbo.Measurements'));
    assert.equal(inserts.length, 2);
    assert.deepEqual(inserts[0].inputs.request_id, { type: 'UniqueIdentifier', value: requestId });
    assert.deepEqual(inserts[0].inputs.value, { type: 'Decimal(10,3)', value: 1820 });
    assert.ok(!queries.some((q) => q.statement.includes(hash)));
});

test('measurement.create dedupes on (request_id, sensor_id)', async () => {
    const handler = (statement, inputs) => {
        if (/^\s*INSERT INTO dbo\.Measurements/.test(statement)) {
            return { recordset: [], rowsAffected: [0] }; // already exists
        }
        return defaultHandler(statement);
    };
    const { route } = loadRoute(handler);
    const result = await post(route, createBody());

    assert.equal(result.status, 200);
    assert.deepEqual(result.jsonBody, { status: 'ok', request_id: requestId, inserted: 0, skipped: 2 });
});

test('measurement.create rejects invalid bodies before touching SQL', async () => {
    const { route, queries } = loadRoute(defaultHandler);
    const invalidMessages = [
        null,
        { ...validMessage, request_id: 'not-a-uuid' },
        { ...validMessage, timestamp: 'no-timezone-or-garbage' },
        { ...validMessage, device: { id: '' } },
        { ...validMessage, measurements: [] },
        { ...validMessage, measurements: [{ sensor_key: 'light', value: 1 }] }, // unit missing
        { ...validMessage, measurements: [{ sensor_key: 'light', unit: 'raw', value: 'NaN' }] },
        { ...validMessage, measurements: [{ sensor_key: 'light', unit: 'raw', value: 1 }, { sensor_key: 'light', unit: 'raw', value: 2 }] } // duplicate key
    ];

    for (const message of invalidMessages) {
        const result = await post(route, createBody({ message }));
        assert.equal(result.status, 400, JSON.stringify(message));
    }
    assert.equal(queries.length, 0);
});

test('measurement.create returns 401 for a bad hash without touching SQL', async () => {
    const { route, queries } = loadRoute(defaultHandler);
    for (const value of [undefined, 'short', 'z'.repeat(64)]) {
        const result = await post(route, createBody({ gateway_token_hash: value }));
        assert.equal(result.status, 401);
    }
    assert.equal(queries.length, 0);
});

test('measurement.create returns 401 when no active gateway matches', async () => {
    const handler = (statement) => {
        if (/FROM dbo\.Gateways/.test(statement)) return { recordset: [] };
        return defaultHandler(statement);
    };
    const { route } = loadRoute(handler);
    const result = await post(route, createBody());

    assert.equal(result.status, 401);
    assert.equal(result.jsonBody.code, 'UNAUTHORIZED');
});

test('measurement.create scopes devices to the gateway', async () => {
    const { route, queries } = loadRoute(defaultHandler);
    const result = await post(route, createBody());

    assert.equal(result.status, 200);
    const deviceQuery = queries.find((q) => /FROM dbo\.Devices/.test(q.statement));
    assert.ok(deviceQuery, 'device resolution query expected');
    assert.match(deviceQuery.statement, /gateway_id = @gateway_id/);
    assert.deepEqual(deviceQuery.inputs.gateway_id, { type: 'UniqueIdentifier', value: gatewayId });
});

test('measurement.create returns 404 when the device is not in this gateway', async () => {
    const handler = (statement) => {
        if (/FROM dbo\.Devices/.test(statement)) return { recordset: [] };
        return defaultHandler(statement);
    };
    const { route } = loadRoute(handler);
    const result = await post(route, createBody());

    assert.equal(result.status, 404);
    assert.equal(result.jsonBody.code, 'DEVICE_NOT_FOUND');
});

test('measurement.create rejects unknown sensors and unit mismatches before inserting', async () => {
    const noLight = sensorRows.filter((s) => s.sensor_key !== 'light');
    const handler = (statement) => {
        if (/FROM dbo\.Sensors/.test(statement)) return { recordset: noLight };
        return defaultHandler(statement);
    };
    const { route, queries } = loadRoute(handler);
    const result = await post(route, createBody());

    assert.equal(result.status, 400);
    assert.equal(result.jsonBody.code, 'UNKNOWN_SENSOR');
    assert.ok(!queries.some((q) => q.statement.includes('INSERT INTO dbo.Measurements')));

    const wrongUnit = sensorRows.map((s) => (s.sensor_key === 'light' ? { ...s, unit: 'lux' } : s));
    const handler2 = (statement) => {
        if (/FROM dbo\.Sensors/.test(statement)) return { recordset: wrongUnit };
        return defaultHandler(statement);
    };
    const route2 = loadRoute(handler2).route;
    const result2 = await post(route2, createBody());
    assert.equal(result2.status, 400);
    assert.equal(result2.jsonBody.code, 'UNIT_MISMATCH');
});

test('measurement.create rolls back on insert failure and hides SQL details', async () => {
    const handler = (statement) => {
        if (/^\s*INSERT INTO dbo\.Measurements/.test(statement)) throw new Error('Private SQL error');
        return defaultHandler(statement);
    };
    const { route, transactionCalls } = loadRoute(handler);
    const result = await post(route, createBody());

    assert.equal(result.status, 500);
    assert.deepEqual(result.jsonBody, { status: 'error', code: 'MEASUREMENT_CREATE_FAILED', message: 'Failed to store measurements.' });
    assert.equal(transactionCalls.rollback, 1);
    assert.equal(transactionCalls.commit, 0);
});

test('measurement.list returns measurements scoped to the gateway', async () => {
    const { route, queries } = loadRoute(defaultHandler);
    const result = await post(route, { action: 'measurement.list', gateway_token_hash: hash, device_id: null, limit: 50 });

    assert.equal(result.status, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.jsonBody.status, 'ok');
    assert.equal(result.jsonBody.measurements.length, 1);
    assert.equal(result.jsonBody.measurements[0].value, 1820);
    assert.equal(result.jsonBody.measurements[0].sensor_key, 'light');

    const listQuery = queries.find((q) => /FROM dbo\.Measurements/.test(q.statement));
    assert.match(listQuery.statement, /d\.gateway_id = @gateway_id/);
    assert.deepEqual(listQuery.inputs.limit, { type: 'Int', value: 50 });
});

test('measurement.list validates limit and device_id before touching SQL', async () => {
    const { route, queries } = loadRoute(defaultHandler);
    for (const limit of [0, 101, 1.5, '50']) {
        const result = await post(route, { action: 'measurement.list', gateway_token_hash: hash, device_id: null, limit });
        assert.equal(result.status, 400, `limit=${limit}`);
    }
    const result = await post(route, { action: 'measurement.list', gateway_token_hash: hash, device_id: '  ', limit: 5 });
    assert.equal(result.status, 400);
    assert.equal(queries.length, 0);
});

test('measurement.list returns 404 when the device is not in this gateway', async () => {
    const handler = (statement) => {
        if (/FROM dbo\.Devices/.test(statement)) return { recordset: [] };
        return defaultHandler(statement);
    };
    const { route } = loadRoute(handler);
    const result = await post(route, { action: 'measurement.list', gateway_token_hash: hash, device_id: 'pico-001', limit: 10 });

    assert.equal(result.status, 404);
    assert.equal(result.jsonBody.code, 'DEVICE_NOT_FOUND');
});
