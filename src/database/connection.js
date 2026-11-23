// Azure SQL connection management.
//
// Authentication is Azure AD only: DefaultAzureCredential resolves to the
// developer's az login locally and to the Function App's managed identity in
// Azure. No password is ever stored, so there is nothing to rotate or leak.

const { DefaultAzureCredential } = require('@azure/identity');
const sql = require('mssql');

const SQL_SCOPE = 'https://database.windows.net/.default';
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

let credential = null;
let cachedToken = null;

// The credential object is reused so its token cache survives between calls.
function getCredential() {
    if (!credential) {
        credential = new DefaultAzureCredential();
    }
    return credential;
}

async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresOnTimestamp - TOKEN_REFRESH_WINDOW_MS > now) {
        return cachedToken.token;
    }

    cachedToken = await getCredential().getToken(SQL_SCOPE);
    return cachedToken.token;
}

function buildSqlConfig(token) {
    return {
        server: process.env.SQL_SERVER,
        database: process.env.SQL_DATABASE,
        options: {
            encrypt: true,
            trustServerCertificate: false
        },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token }
        }
    };
}

async function getSqlConfig() {
    return buildSqlConfig(await getAccessToken());
}

// Opens a pool, runs the work, always closes the pool. Each request gets its
// own pool: a pool that fails can never poison a later invocation.
async function withPool(work) {
    const pool = new sql.ConnectionPool(await getSqlConfig());
    try {
        await pool.connect();
        return await work(pool);
    } finally {
        await pool.close();
    }
}

// The health check uses the module-level pool so it can prove a plain
// sql.connect() works, which is the same path the runtime uses elsewhere.
async function withSharedConnection(work) {
    const pool = await sql.connect(await getSqlConfig());
    try {
        return await work(pool);
    } finally {
        if (pool) {
            await pool.close();
        }
    }
}

// Test seam: drops the cached token and credential.
function resetCredentialCache() {
    credential = null;
    cachedToken = null;
}

module.exports = {
    getAccessToken,
    getSqlConfig,
    withPool,
    withSharedConnection,
    resetCredentialCache
};
