// Validation for incoming measurement messages.
//
// Everything here runs before a database connection is opened, so a malformed
// or oversized message costs one function invocation and nothing more.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_MEASUREMENTS = 16;
const MAX_SENSOR_KEY_LENGTH = 100;
const MAX_DEVICE_ID_LENGTH = 100;
const MAX_UNIT_LENGTH = 20;
const MAX_VALUE = 9999999.999; // largest value that fits DECIMAL(10,3)
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(status, code, message) {
    return { ok: false, status, code, message };
}

function validateMeasurement(message) {
    if (!isPlainObject(message)) {
        return invalid(400, 'INVALID_MESSAGE', 'message must be a JSON object.');
    }

    if (typeof message.request_id !== 'string' || !UUID_PATTERN.test(message.request_id)) {
        return invalid(400, 'INVALID_REQUEST_ID', 'request_id must be a valid UUID.');
    }

    if (typeof message.timestamp !== 'string' || Number.isNaN(Date.parse(message.timestamp))) {
        return invalid(400, 'INVALID_TIMESTAMP', 'timestamp must be a valid ISO 8601 date.');
    }

    const device = message.device;
    if (!isPlainObject(device)
        || typeof device.id !== 'string'
        || device.id.trim().length === 0
        || device.id.trim().length > MAX_DEVICE_ID_LENGTH) {
        return invalid(400, 'INVALID_DEVICE', 'device.id is required.');
    }

    const measurements = message.measurements;
    if (!Array.isArray(measurements) || measurements.length === 0 || measurements.length > MAX_MEASUREMENTS) {
        return invalid(400, 'INVALID_MEASUREMENTS', `Provide between 1 and ${MAX_MEASUREMENTS} measurements.`);
    }

    const seen = new Set();
    const cleaned = [];

    for (const entry of measurements) {
        if (!isPlainObject(entry)) {
            return invalid(400, 'INVALID_MEASUREMENT', 'Each measurement must be a JSON object.');
        }

        const sensorKey = typeof entry.sensor_key === 'string' ? entry.sensor_key.trim() : '';
        if (sensorKey.length === 0 || sensorKey.length > MAX_SENSOR_KEY_LENGTH) {
            return invalid(400, 'INVALID_SENSOR_KEY', 'sensor_key is required.');
        }
        if (seen.has(sensorKey)) {
            return invalid(400, 'INVALID_SENSOR_KEY', 'sensor_key values must be unique.');
        }
        seen.add(sensorKey);

        const unit = typeof entry.unit === 'string' ? entry.unit.trim() : '';
        if (unit.length === 0 || unit.length > MAX_UNIT_LENGTH) {
            return invalid(400, 'INVALID_UNIT', `Payload '${sensorKey}' has an invalid unit.`);
        }

        const value = Number(entry.value);
        if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE) {
            return invalid(400, 'INVALID_VALUE', `Payload '${sensorKey}' must be a finite number supported by DECIMAL(10,3).`);
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

// device_id is optional on measurement.list, but when present it must be usable
// as a lookup key before any query is issued.
function validateDeviceFilter(deviceIdInput) {
    if (deviceIdInput === null || deviceIdInput === undefined) {
        return { ok: true, value: null };
    }

    if (typeof deviceIdInput !== 'string'
        || deviceIdInput.trim().length === 0
        || deviceIdInput.trim().length > MAX_DEVICE_ID_LENGTH) {
        return invalid(400, 'INVALID_DEVICE', `device_id must contain between 1 and ${MAX_DEVICE_ID_LENGTH} characters.`);
    }

    return { ok: true, value: deviceIdInput.trim() };
}

function validateLimit(limit) {
    if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
        return invalid(400, 'INVALID_LIMIT', `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}.`);
    }

    return { ok: true, value: limit };
}

module.exports = {
    UUID_PATTERN,
    MAX_MEASUREMENTS,
    MAX_VALUE,
    MIN_LIMIT,
    MAX_LIMIT,
    validateMeasurement,
    validateDeviceFilter,
    validateLimit
};
