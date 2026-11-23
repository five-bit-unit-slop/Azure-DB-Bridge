// Business logic for measurement.create and measurement.list.
//
// Same two-phase shape as deviceService:
//   validate*Request()  pure, no I/O, rejects 400/401 before any connection
//   create*/list*       runs against an open pool, decides 404 and the rest
// The payload checks run before the gateway lookup, so an invalid body cannot
// be used to probe which gateway hashes exist.

const { listActiveSensorsForDevice, toSensorMap } = require('../database/sensorRepository');
const { findActiveDeviceId } = require('../database/deviceRepository');
const { insertMeasurements, listMeasurements } = require('../database/measurementRepository');
const { resolveGateway } = require('./deviceService');
const {
    validateMeasurement,
    validateDeviceFilter,
    validateLimit
} = require('../validation/measurementValidation');
const { isValidTokenHash } = require('../validation/deviceValidation');

const UNAUTHORIZED = { status: 401, code: 'UNAUTHORIZED' };
const DEVICE_NOT_FOUND = { status: 404, code: 'DEVICE_NOT_FOUND' };

function invalid(result) {
    return { status: result.status, code: result.code, message: result.message };
}

// Returns { ok: true, tokenHash, message } or { status, code, message }.
function validateMeasurementCreateRequest(data) {
    if (!isValidTokenHash(data.gateway_token_hash)) {
        return UNAUTHORIZED;
    }

    const validated = validateMeasurement(data.message);
    if (!validated.ok) {
        return invalid(validated);
    }

    return {
        ok: true,
        tokenHash: data.gateway_token_hash,
        message: validated.value
    };
}

// Returns { ok: true, tokenHash, deviceFilter, limit } or { status, code, message }.
function validateMeasurementListRequest(data) {
    if (!isValidTokenHash(data.gateway_token_hash)) {
        return UNAUTHORIZED;
    }

    const deviceFilter = validateDeviceFilter(data.device_id);
    if (!deviceFilter.ok) {
        return invalid(deviceFilter);
    }

    const limit = validateLimit(data.limit);
    if (!limit.ok) {
        return invalid(limit);
    }

    return {
        ok: true,
        tokenHash: data.gateway_token_hash,
        deviceFilter: deviceFilter.value,
        limit: limit.value
    };
}

// Returns { status: 200, request_id, inserted, skipped }
//      or { status: 400|401|404, code, message }.
async function createMeasurement(pool, { tokenHash, message }) {
    const gateway = await resolveGateway(pool, tokenHash);
    if (!gateway) {
        return UNAUTHORIZED;
    }

    // Resolving the device before reading its sensors means a caller cannot
    // learn which sensor keys exist on a device that is not theirs.
    const deviceId = await findActiveDeviceId(pool, gateway.id, message.device_id);
    if (!deviceId) {
        return DEVICE_NOT_FOUND;
    }

    const sensors = toSensorMap(await listActiveSensorsForDevice(pool, deviceId));

    for (const measurement of message.measurements) {
        const sensor = sensors.get(measurement.sensor_key);
        if (!sensor) {
            return {
                status: 400,
                code: 'UNKNOWN_SENSOR',
                message: `Unknown sensor '${measurement.sensor_key}'.`
            };
        }
        if (sensor.unit !== measurement.unit) {
            return {
                status: 400,
                code: 'UNIT_MISMATCH',
                message: `Unit mismatch for sensor '${measurement.sensor_key}'.`
            };
        }
    }

    const rows = message.measurements.map((measurement) => ({
        sensor_id: sensors.get(measurement.sensor_key).id,
        request_id: message.request_id,
        value: measurement.value,
        recorded_at: message.recorded_at
    }));

    const { inserted, skipped } = await insertMeasurements(pool, rows);

    return { status: 200, request_id: message.request_id, inserted, skipped };
}

// Returns { status: 200, measurements } or { status: 401|404, code }.
async function listMeasurementsForGateway(pool, { tokenHash, deviceFilter, limit }) {
    const gateway = await resolveGateway(pool, tokenHash);
    if (!gateway) {
        return UNAUTHORIZED;
    }

    let deviceId = null;
    if (deviceFilter !== null) {
        deviceId = await findActiveDeviceId(pool, gateway.id, deviceFilter);
        if (!deviceId) {
            return DEVICE_NOT_FOUND;
        }
    }

    const measurements = await listMeasurements(pool, {
        gatewayId: gateway.id,
        deviceId,
        limit
    });

    return { status: 200, measurements };
}

module.exports = {
    validateMeasurementCreateRequest,
    validateMeasurementListRequest,
    createMeasurement,
    listMeasurementsForGateway
};
