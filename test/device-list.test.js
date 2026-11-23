//import
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLoader } = require('./support/loadModule');

//vars
const entry = require.resolve('../src/functions/database');
const hash = 'a'.repeat(64);
const body = { action: 'device.list', gateway_token_hash: hash };
const context = { error() {} };

//functions
function loadRoute(rows = [], queryError) {
    let route;
    const calls = { connected: 0, closed: 0 };
    const pool = {
        async connect() {
            calls.connected++;
        },
        async close() {
            calls.closed++;
        },
        request() {
            return {
                input(name, type, value) {
                    calls.input = { name, type, value };
                    return this;
                },
                async query(statement) {
                    calls.query = statement;
                    if (queryError) throw queryError;
                    return { recordset: rows };
                }
            };
        }
    };

    const modules = {
        '@azure/functions': {
            app: {
                setup() {},
                http(name, config) { route = { name, ...config }; }
            }
        },
        '@azure/identity': {
            DefaultAzureCredential: function () {
                this.getToken = async () => ({ token: 'fake-sql-token' });
            }
        },
        mssql: {
            Char: (length) => `Char(${length})`,
            ConnectionPool: function () { return pool; },
            connect: async () => pool
        }
    };

    createLoader(entry, modules, {});
    return { route, calls };
}

function post(route, data = body) {
    return route.handler({ method: 'POST', json: async () => data }, context);
}

//tests
test('GET still checks SQL and the Function key stays required', async () => {
    const { route } = loadRoute([{ database_name: 'test' }]);

    assert.equal(route.name, 'database');
    assert.equal(route.route, 'database');
    assert.equal(route.authLevel, 'function');
    assert.deepEqual(route.methods, ['GET', 'POST']);
    const result = await route.handler({ method: 'GET' }, context);
    assert.equal(result.status, 200);
    assert.deepEqual(result.jsonBody, { status: 'connected', database_name: 'test' });
});

test('bad JSON does not reach SQL', async () => {
    const { route, calls } = loadRoute();
    const badRequest = { method: 'POST', json: async () => { throw new SyntaxError('Bad JSON'); } };
    const badJson = await route.handler(badRequest, context);
    assert.equal(badJson.status, 400);
    assert.equal(badJson.jsonBody.code, 'INVALID_JSON');

    for (const data of [null, [], 'test']) {
        const result = await post(route, data);
        assert.equal(result.status, 400);
        assert.equal(result.jsonBody.code, 'INVALID_JSON');
    }
    assert.equal(calls.connected, 0);
});

test('unknown action does not reach SQL', async () => {
    const { route, calls } = loadRoute();
    const result = await post(route, { ...body, action: 'gateway.explode' });
    assert.equal(result.status, 400);
    assert.equal(result.jsonBody.code, 'INVALID_ACTION');
    assert.equal(calls.connected, 0);
});

test('bad gateway hash does not reach SQL', async () => {
    const { route, calls } = loadRoute();
    for (const value of [undefined, 'short', 'z'.repeat(64), `${hash.slice(1)}\n`]) {
        const result = await post(route, { ...body, gateway_token_hash: value });
        assert.equal(result.status, 401);
        assert.equal(result.jsonBody.code, 'UNAUTHORIZED');
    }
    assert.equal(calls.connected, 0);
});

test('no active gateway gets 401', async () => {
    const { route } = loadRoute([]);
    const result = await post(route);
    assert.equal(result.status, 401);
    assert.equal(result.jsonBody.code, 'UNAUTHORIZED');
});

test('a gateway without devices gets an empty list', async () => {
    const { route } = loadRoute([{ id: null }]);
    const result = await post(route);
    assert.equal(result.status, 200);
    assert.deepEqual(result.jsonBody, { status: 'ok', devices: [] });
});

test('device list uses a SQL parameter and stays within the gateway', async () => {
    const device = {
        id: '12345678-1234-4123-8123-123456789abc',
        device_name: 'Pico test',
        last_seen: null,
        is_active: true
    };
    const { route, calls } = loadRoute([{ ...device, gateway_token_hash: hash }]);
    const result = await post(route);

    assert.deepEqual(calls.input, { name: 'gateway_token_hash', type: 'Char(64)', value: hash });
    assert.match(calls.query, /LEFT JOIN dbo\.Devices AS d ON d\.gateway_id = g\.id/);
    assert.match(calls.query, /WHERE g\.gateway_token_hash = @gateway_token_hash\s+AND g\.is_active = 1/);
    assert.ok(!calls.query.includes(hash));
    assert.equal(result.status, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.deepEqual(result.jsonBody, { status: 'ok', devices: [device] });
    assert.equal(calls.closed, 1);
});

test('SQL errors get a JSON 500 without SQL details', async () => {
    const { route, calls } = loadRoute([], new Error('Private SQL error'));
    const result = await post(route);

    assert.equal(result.status, 500);
    assert.deepEqual(result.jsonBody, { status: 'error', code: 'DEVICE_LIST_FAILED', message: 'Failed to list devices.' });
    assert.equal(calls.closed, 1);
});
