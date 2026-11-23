// HTTP layer for device.list.
// Validates first, connects second: see the note in deviceService.

const { ok, sendError } = require('../utils/responses');
const { validateDeviceListRequest, listDevices } = require('../services/deviceService');
const { withPool } = require('../database/connection');

async function handleDeviceList(context, data) {
    // Phase 1: no I/O. A bad token is rejected without touching Azure SQL.
    const validated = validateDeviceListRequest(data);
    if (validated.status === 401) {
        return sendError(401, 'UNAUTHORIZED', 'A valid gateway token is required.');
    }

    // Phase 2: the caller is valid, so a connection is justified.
    try {
        const result = await withPool((pool) => listDevices(pool, validated.tokenHash));

        if (result.status === 401) {
            return sendError(401, 'UNAUTHORIZED', 'A valid gateway token is required.');
        }

        return ok({ status: 'ok', devices: result.devices });
    } catch (error) {
        // Only the error code is logged: the message can carry SQL details.
        context.error('Device list SQL request failed:', error?.code ?? 'UNKNOWN');
        return sendError(500, 'DEVICE_LIST_FAILED', 'Failed to list devices.');
    }
}

module.exports = {
    handleDeviceList
};
