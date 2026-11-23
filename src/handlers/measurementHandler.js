// HTTP layer for measurement.create and measurement.list.
// Validation runs before any connection is opened, so a rejected payload never
// costs an Azure AD token request or a SQL pool.

const { ok, sendError } = require('../utils/responses');
const {
    validateMeasurementCreateRequest,
    validateMeasurementListRequest,
    createMeasurement,
    listMeasurementsForGateway
} = require('../services/measurementService');
const { withPool } = require('../database/connection');

const UNAUTHORIZED_MESSAGE = 'A valid gateway token is required.';
const DEVICE_NOT_FOUND_MESSAGE = 'Device not found for this gateway.';

// Service failures carry a code; the wording of the two shared ones lives here
// so it is defined once. Everything else already has a specific message.
function sendFailure(result) {
    const message = result.message
        ?? (result.code === 'UNAUTHORIZED'
            ? UNAUTHORIZED_MESSAGE
            : DEVICE_NOT_FOUND_MESSAGE);

    return sendError(result.status, result.code, message);
}

async function handleMeasurementCreate(context, data) {
    const validated = validateMeasurementCreateRequest(data);
    if (!validated.ok) {
        return sendFailure(validated);
    }

    try {
        const result = await withPool((pool) => createMeasurement(pool, validated));

        if (result.status !== 200) {
            return sendFailure(result);
        }

        return ok({
            status: 'ok',
            request_id: result.request_id,
            inserted: result.inserted,
            skipped: result.skipped
        });
    } catch (error) {
        context.error('Measurement create SQL request failed:', error?.number ?? error?.code ?? 'UNKNOWN');
        return sendError(500, 'MEASUREMENT_CREATE_FAILED', 'Failed to store measurements.');
    }
}

async function handleMeasurementList(context, data) {
    const validated = validateMeasurementListRequest(data);
    if (!validated.ok) {
        return sendFailure(validated);
    }

    try {
        const result = await withPool((pool) => listMeasurementsForGateway(pool, validated));

        if (result.status !== 200) {
            return sendFailure(result);
        }

        return ok({ status: 'ok', measurements: result.measurements });
    } catch (error) {
        context.error('Measurement list SQL request failed:', error?.number ?? error?.code ?? 'UNKNOWN');
        return sendError(500, 'MEASUREMENT_LIST_FAILED', 'Failed to list measurements.');
    }
}

module.exports = {
    handleMeasurementCreate,
    handleMeasurementList
};
