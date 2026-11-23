// Queries for dbo.Gateways.
// The token hash is compared in SQL, not in JavaScript, so an unknown gateway
// is simply a query that returns no rows.

const sql = require('mssql');

async function findActiveGateway(pool, tokenHash) {
    const result = await pool.request()
        .input('gateway_token_hash', sql.Char(64), tokenHash)
        .query(`
            SELECT id
            FROM dbo.Gateways
            WHERE gateway_token_hash = @gateway_token_hash
              AND is_active = 1;
        `);

    return result.recordset[0] ?? null;
}

module.exports = {
    findActiveGateway
};
