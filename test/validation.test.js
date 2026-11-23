// Unit tests for the validation modules.
// These load the modules directly with plain require: no stubs are needed
// because nothing here touches Azure, mssql or process.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { isValidTokenHash } = require('../src/validation/deviceValidation');
const {
    validateMeasurement,
    validateDeviceFilter,
    validateLimit,
    MAX_MEASUREMENTS,
    MAX_VALUE
} = require('../src/validation/measurementValidation');

const requestId = '99999999-9999-4999-8999-999999999999';

function message(overrides = {}) {
    return {
        request_id: requestId,
        timestamp: '2026-11-16T12:00:00Z',
        device: { id: 'pico-001' },
        measurements: [{ sensor_key: 'light', value: 1820, unit: 'raw' }],
        ...overrides
    };
}

// deviceValidation
test('a token hash must be exactly 64 lowercase hex characters', () => {
    assert.equal(isValidTokenHash('a'.repeat(64)), true);
    assert.equal(isValidTokenHash('0123456789abcdef'.repeat(4)), true);
    assert.equal(isValidTokenHash('A'.repeat(64)), false, 'uppercase is rejected');
    assert.equal(isValidTokenHash('a'.repeat(63)), false, 'too short');
    assert.equal(isValidTokenHash('a'.repeat(65)), false, 'too long');
    assert.equal(isValidTokenHash(`${'a'.repeat(63)}\n`), false, 'trailing newline');
    assert.equal(isValidTokenHash(undefined), false);
    assert.equal(isValidTokenHash(null), false);
    assert.equal(isValidTokenHash(123), false);
});

// measurementValidation
test('a complete message is normalised and trimmed', () => {
    const result = validateMeasurement(message({ device: { id: '  pico-001  ' } }));

    assert.equal(result.ok, true);
    assert.equal(result.value.request_id, requestId);
    assert.equal(result.value.device_id, 'pico-001', 'device id is trimmed');
    assert.ok(result.value.recorded_at instanceof Date);
    assert.deepEqual(result.value.measurements, [{ sensor_key: 'light', unit: 'raw', value: 1820 }]);
});

test('a numeric string value is accepted and coerced', () => {
    const result = validateMeasurement(message({ measurements: [{ sensor_key: 'light', unit: 'raw', value: '12.5' }] }));
    assert.equal(result.ok, true);
    assert.equal(result.value.measurements[0].value, 12.5);
});

test('each malformed field gets its own error code', () => {
    const cases = [
        [null, 'INVALID_MESSAGE'],
        [[], 'INVALID_MESSAGE'],
        ['message', 'INVALID_MESSAGE'],
        [message({ request_id: 'not-a-uuid' }), 'INVALID_REQUEST_ID'],
        [message({ request_id: undefined }), 'INVALID_REQUEST_ID'],
        [message({ timestamp: 'garbage' }), 'INVALID_TIMESTAMP'],
        [message({ timestamp: 1234 }), 'INVALID_TIMESTAMP'],
        [message({ device: null }), 'INVALID_DEVICE'],
        [message({ device: { id: '   ' } }), 'INVALID_DEVICE'],
        [message({ device: { id: 'x'.repeat(101) } }), 'INVALID_DEVICE'],
        [message({ measurements: [] }), 'INVALID_MEASUREMENTS'],
        [message({ measurements: 'nope' }), 'INVALID_MEASUREMENTS'],
        [message({ measurements: [null] }), 'INVALID_MEASUREMENT'],
        [message({ measurements: [{ sensor_key: '', unit: 'raw', value: 1 }] }), 'INVALID_SENSOR_KEY'],
        [message({ measurements: [{ sensor_key: 'x'.repeat(101), unit: 'raw', value: 1 }] }), 'INVALID_SENSOR_KEY'],
        [message({ measurements: [{ unit: 'raw', value: 1 }] }), 'INVALID_SENSOR_KEY'],
        [message({ measurements: [{ sensor_key: 'light', unit: '', value: 1 }] }), 'INVALID_UNIT'],
        [message({ measurements: [{ sensor_key: 'light', unit: 'u'.repeat(21), value: 1 }] }), 'INVALID_UNIT'],
        [message({ measurements: [{ sensor_key: 'light', unit: 'raw', value: 'NaN' }] }), 'INVALID_VALUE'],
        [message({ measurements: [{ sensor_key: 'light', unit: 'raw', value: Infinity }] }), 'INVALID_VALUE'],
        [message({ measurements: [{ sensor_key: 'light', unit: 'raw', value: MAX_VALUE + 1 }] }), 'INVALID_VALUE']
    ];

    for (const [input, expected] of cases) {
        const result = validateMeasurement(input);
        assert.equal(result.ok, false, `expected failure for ${JSON.stringify(input)}`);
        assert.equal(result.code, expected, `wrong code for ${JSON.stringify(input)}`);
        assert.equal(result.status, 400);
        assert.equal(typeof result.message, 'string');
    }
});

test('duplicate sensor keys inside one message are rejected', () => {
    const result = validateMeasurement(message({
        measurements: [
            { sensor_key: 'light', unit: 'raw', value: 1 },
            { sensor_key: 'light', unit: 'raw', value: 2 }
        ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_SENSOR_KEY');
});

test('the measurement limit is enforced at both ends', () => {
    const make = (count) => Array.from({ length: count }, (_, i) => ({
        sensor_key: `s${i}`, unit: 'raw', value: i
    }));

    assert.equal(validateMeasurement(message({ measurements: make(MAX_MEASUREMENTS) })).ok, true);
    assert.equal(validateMeasurement(message({ measurements: make(MAX_MEASUREMENTS + 1) })).ok, false);
});

test('the largest value that fits DECIMAL(10,3) is accepted', () => {
    const result = validateMeasurement(message({
        measurements: [{ sensor_key: 'light', unit: 'raw', value: MAX_VALUE }]
    }));
    assert.equal(result.ok, true);
});

test('device_id filter is optional but validated when present', () => {
    assert.deepEqual(validateDeviceFilter(undefined), { ok: true, value: null });
    assert.deepEqual(validateDeviceFilter(null), { ok: true, value: null });
    assert.deepEqual(validateDeviceFilter('  pico-001 '), { ok: true, value: 'pico-001' });

    for (const bad of ['', '   ', 'x'.repeat(101), 42, {}]) {
        const result = validateDeviceFilter(bad);
        assert.equal(result.ok, false, `expected failure for ${JSON.stringify(bad)}`);
        assert.equal(result.code, 'INVALID_DEVICE');
    }
});

test('limit must be an integer between 1 and 100', () => {
    assert.deepEqual(validateLimit(1), { ok: true, value: 1 });
    assert.deepEqual(validateLimit(100), { ok: true, value: 100 });

    for (const bad of [0, 101, 1.5, -1, '50', null, undefined, NaN]) {
        const result = validateLimit(bad);
        assert.equal(result.ok, false, `expected failure for ${String(bad)}`);
        assert.equal(result.code, 'INVALID_LIMIT');
    }
});
