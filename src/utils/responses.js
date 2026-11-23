// Reusable HTTP response helpers.
// Every response disables caching: this API is gateway-scoped, so a cached
// body could otherwise be served to a different caller.

const NO_STORE = { 'Cache-Control': 'no-store' };

function ok(jsonBody) {
    return {
        status: 200,
        headers: { ...NO_STORE },
        jsonBody
    };
}

function sendError(status, code, message) {
    return {
        status,
        headers: { ...NO_STORE },
        jsonBody: { status: 'error', code, message }
    };
}

// A JSON body must be a plain object. Arrays, null and scalars are rejected so
// that a caller can never reach dispatch logic with an unexpected shape.
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Parses the request body. The Functions host throws on a malformed payload,
// so that throw is converted into the same INVALID_JSON error a wrong shape gets.
async function readJsonObject(request) {
    let data;
    try {
        data = await request.json();
    } catch {
        return { ok: false, response: sendError(400, 'INVALID_JSON', 'Request body must be a JSON object.') };
    }

    if (!isPlainObject(data)) {
        return { ok: false, response: sendError(400, 'INVALID_JSON', 'Request body must be a JSON object.') };
    }

    return { ok: true, value: data };
}

module.exports = {
    ok,
    sendError,
    isPlainObject,
    readJsonObject
};
