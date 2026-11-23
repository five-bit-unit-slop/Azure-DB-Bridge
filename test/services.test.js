// Unit tests for the service layer.
//
// The whole module graph is loaded with stubbed '@azure/functions',
// '@azure/identity' and 'mssql', then individual services are pulled out of the
// same graph with loader.get(). That keeps one stub set and one module cache per
// test, so module-level state cannot leak between cases.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLoader } = require('./support/loadModule');

const entryPath = require.resolve('../src/functions/database');
const deviceServicePath = require.resolve('../src/services/deviceService');
const measurementServicePath = require.resolve('../src/services/measurementService');

const hash = 'a'.repeat(64);
const gatewayId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const sensorId = '33333333-3333-4333-8333-333333333333';
const requestId = '99999999-9999-4999-8999-999999999999';

const validMessage = {
    request_id: requestId,
    timestamp: '2026-11-16T12:00:00Z',
    device: { id: 'pico-001' },
    measurements: [{ sensor_key: 'light', value: 1820, unit: 'raw' }]
};

// Builds a stub mssql module whose queries are answered by queryHandler.
// Every statement issued is recorded, so a test can assert on what ran and in
// which order.
function buildStubs(queryHandler = () => ({ recordset: [] })) {
    const statements = [];
    const transactionCalls = { begin: 0, commit: 0, rollback: 0 };

    const makeRequest = () => ({
        input() { return this; },
        async query(statement) {
            statements.push(statement);
            return queryHandler(statement);
        }
    });

    const pool = {
        connected: 0,
        closed: 0,
        async connect() { this.connected++; },
        async close() { this.closed++; },
        request: makeRequest
    };

    const transaction = {
        async begin() { transactionCalls.begin++; },
        async commit() { transactionCalls.commit++; },
        async rollback() { transactionCalls.rollback++; },
        request: makeRequest
    };

    const stubs = {
        '@azure/functions': { app: { setup() {}, http() {} } },
        '@azure/identity': {
            DefaultAzureCredential: function () {
                this.getToken = async () => ({ token: 'fake', expiresOnTimestamp: Date.now() + 3600_000 });
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

    return { stubs, statements, transactionCalls, pool };
}

function loadServices(queryHandler) {
    const built = buildStubs(queryHandler);
    const loader = createLoader(entryPath, built.stubs);

    return {
        ...built,
        deviceService: loader.get(deviceServicePath),
        measurementService: loader.get(measurementServicePath)
    };
}

// deviceService: the pure validation phase
test('device.list validation phase rejects a bad hash without touching SQL', () => {
    const { deviceService, statements } = loadServices();

    for (const bad of [undefined, 'short', 'z'.repeat(64), null]) {
        const result = deviceService.validateDeviceListRequest({ gateway_token_hash: bad });
        assert.equal(result.status, 401, `hash=${String(bad)}`);
    }

    assert.equal(statements.length, 0);
});

test('device.list validation phase accepts a well formed hash', () => {
    const { deviceService } = loadServices();
    const result = deviceService.validateDeviceListRequest({ gateway_token_hash: hash });

    assert.equal(result.ok, true);
    assert.equal(result.tokenHash, hash);
});

// deviceService: execution phase
test('device.list returns 401 when the hash matches no active gateway', async () => {
    const { deviceService, pool } = loadServices(() => ({ recordset: [] }));
    const result = await deviceService.listDevices(pool, hash);

    assert.equal(result.status, 401);
    assert.equal(result.code, 'UNAUTHORIZED');
});

test('device.list drops the join placeholder for a gateway with no devices', async () => {
    const { deviceService, pool } = loadServices(() => ({
        recordset: [{ id: null, device_name: null, last_seen: null, is_active: null }]
    }));

    const result = await deviceService.listDevices(pool, hash);

    assert.equal(result.status, 200);
    assert.deepEqual(result.devices, []);
});

test('device.list maps rows to the documented device shape', async () => {
    const row = { id: deviceId, device_name: 'pico-001', last_seen: null, is_active: true };
    const { deviceService, pool } = loadServices(() => ({ recordset: [row] }));

    const result = await deviceService.listDevices(pool, hash);

    assert.deepEqual(result.devices, [{ id: deviceId, device_name: 'pico-001', last_seen: null, is_active: true }]);
    assert.deepEqual(Object.keys(result.devices[0]), ['id', 'device_name', 'last_seen', 'is_active']);
});

// measurementService: the pure validation phase
test('measurement.create validation phase rejects before any SQL runs', () => {
    const { measurementService, statements } = loadServices();

    assert.equal(
        measurementService.validateMeasurementCreateRequest({ gateway_token_hash: 'nope', message: validMessage }).status,
        401
    );

    const badBody = measurementService.validateMeasurementCreateRequest({
        gateway_token_hash: hash,
        message: { request_id: 'not-a-uuid' }
    });
    assert.equal(badBody.status, 400);
    assert.equal(badBody.code, 'INVALID_REQUEST_ID');
    assert.equal(statements.length, 0);
});

test('measurement.create validation phase normalises the message', () => {
    const { measurementService } = loadServices();
    const result = measurementService.validateMeasurementCreateRequest({
        gateway_token_hash: hash,
        message: { ...validMessage, device: { id: '  pico-001  ' } }
    });

    assert.equal(result.ok, true);
    assert.equal(result.tokenHash, hash);
    assert.equal(result.message.device_id, 'pico-001');
    assert.ok(result.message.recorded_at instanceof Date);
});

test('measurement.list validation phase rejects limit and device_id before SQL', () => {
    const { measurementService, statements } = loadServices();

    for (const limit of [0, 101, 1.5, '50', undefined]) {
        const result = measurementService.validateMeasurementListRequest({ gateway_token_hash: hash, limit });
        assert.equal(result.code, 'INVALID_LIMIT', `limit=${String(limit)}`);
    }

    const blankDevice = measurementService.validateMeasurementListRequest({
        gateway_token_hash: hash, limit: 5, device_id: '   '
    });
    assert.equal(blankDevice.code, 'INVALID_DEVICE');

    const good = measurementService.validateMeasurementListRequest({
        gateway_token_hash: hash, limit: 5, device_id: null
    });
    assert.equal(good.ok, true);
    assert.equal(good.limit, 5);
    assert.equal(good.deviceFilter, null);
    assert.equal(statements.length, 0);
});

// measurementService: execution phase ordering
test('measurement.create stops at an unknown gateway and never resolves a device', async () => {
    const { measurementService, pool, statements } = loadServices(() => ({ recordset: [] }));

    const result = await measurementService.createMeasurement(pool, {
        tokenHash: hash,
        message: {
            request_id: requestId,
            device_id: 'pico-001',
            recorded_at: new Date('2026-11-16T12:00:00Z'),
            measurements: [{ sensor_key: 'light', unit: 'raw', value: 1 }]
        }
    });

    assert.equal(result.status, 401);
    assert.equal(statements.length, 1, 'only the gateway lookup ran');
    assert.match(statements[0], /FROM dbo\.Gateways/);
});

test('measurement.create checks the device before reading sensors', async () => {
    const { measurementService, pool, statements } = loadServices((statement) => {
        if (/FROM dbo\.Gateways/.test(statement)) return { recordset: [{ id: gatewayId }] };
        return { recordset: [] };
    });

    const result = await measurementService.createMeasurement(pool, {
        tokenHash: hash,
        message: {
            request_id: requestId,
            device_id: 'pico-001',
            recorded_at: new Date('2026-11-16T12:00:00Z'),
            measurements: [{ sensor_key: 'light', unit: 'raw', value: 1 }]
        }
    });

    assert.equal(result.status, 404);
    assert.equal(result.code, 'DEVICE_NOT_FOUND');
    assert.ok(!statements.some((s) => /FROM dbo\.Sensors/.test(s)), 'sensors were never read');
});

test('measurement.create maps errors and counts into a payload', async () => {
    const { measurementService, pool, transactionCalls } = loadServices((statement) => {
        if (/FROM dbo\.Gateways/.test(statement)) return { recordset: [{ id: gatewayId }] };
        if (/FROM dbo\.Devices/.test(statement)) return { recordset: [{ id: deviceId }] };
        if (/FROM dbo\.Sensors/.test(statement)) return { recordset: [{ id: sensorId, sensor_key: 'light', unit: 'raw' }] };
        if (/INSERT INTO dbo\.Measurements/.test(statement)) return { recordset: [], rowsAffected: [1] };
        return { recordset: [] };
    });

    const result = await measurementService.createMeasurement(pool, {
        tokenHash: hash,
        message: {
            request_id: requestId,
            device_id: 'pico-001',
            recorded_at: new Date('2026-11-16T12:00:00Z'),
            measurements: [{ sensor_key: 'light', unit: 'raw', value: 1820 }]
        }
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result, { status: 200, request_id: requestId, inserted: 1, skipped: 0 });
    assert.equal(transactionCalls.commit, 1);
    assert.equal(transactionCalls.rollback, 0);
});

test('measurement.list skips the device lookup when no filter is given', async () => {
    const { measurementService, pool, statements } = loadServices((statement) => {
        if (/FROM dbo\.Gateways/.test(statement)) return { recordset: [{ id: gatewayId }] };
        if (/FROM dbo\.Measurements/.test(statement)) return { recordset: [] };
        return { recordset: [] };
    });

    const result = await measurementService.listMeasurementsForGateway(pool, {
        tokenHash: hash,
        deviceFilter: null,
        limit: 10
    });

    assert.equal(result.status, 200);
    assert.ok(!statements.some((s) => /FROM dbo\.Devices/.test(s)), 'no device lookup for an unfiltered list');
});
