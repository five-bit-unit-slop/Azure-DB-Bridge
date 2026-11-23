// Business logic for device.list.
//
// The work is split in two phases on purpose:
//   validateDeviceListRequest()  pure, no I/O, decides 400/401 before any
//                                database connection is opened
//   listDevices()               runs only once the caller is known to be valid
// A rejected caller therefore never costs an Azure AD token request or a pool.

const { findActiveGateway } = require('../database/gatewayRepository');
const { listDevicesForGateway } = require('../database/deviceRepository');
const { isValidTokenHash } = require('../validation/deviceValidation');

const UNAUTHORIZED = { status: 401, code: 'UNAUTHORIZED' };

function validateDeviceListRequest(data) {
    if (!isValidTokenHash(data.gateway_token_hash)) {
        return UNAUTHORIZED;
    }

    return { ok: true, tokenHash: data.gateway_token_hash };
}

// Maps stored rows to the API shape. The LEFT JOIN emits a row with a null
// device id for a gateway that owns no devices, and that placeholder is dropped
// so the caller sees an empty array rather than a phantom device.
function toDevice(row) {
    return {
        id: row.id,
        device_name: row.device_name,
        last_seen: row.last_seen,
        is_active: row.is_active
    };
}

// Returns { status: 200, devices } or { status: 401, code }.
async function listDevices(pool, tokenHash) {
    const rows = await listDevicesForGateway(pool, tokenHash);

    // No rows at all means the hash did not match an active gateway.
    if (rows.length === 0) {
        return UNAUTHORIZED;
    }

    return {
        status: 200,
        devices: rows.filter((row) => row.id !== null).map(toDevice)
    };
}

// Shared by the measurement flows: an invalid or unknown hash resolves to null.
async function resolveGateway(pool, tokenHash) {
    if (!isValidTokenHash(tokenHash)) {
        return null;
    }

    return findActiveGateway(pool, tokenHash);
}

module.exports = {
    validateDeviceListRequest,
    listDevices,
    resolveGateway
};
