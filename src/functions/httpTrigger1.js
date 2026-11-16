const { app } = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const sql = require('mssql');

app.http('database', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'database',
    handler: async (request, context) => {
        let pool;

        try {
            const credential = new DefaultAzureCredential();

            const token = await credential.getToken(
                'https://database.windows.net/.default'
            );

            pool = await sql.connect({
                server: process.env.SQL_SERVER,
                database: process.env.SQL_DATABASE,
                options: {
                    encrypt: true,
                    trustServerCertificate: false
                },
                authentication: {
                    type: 'azure-active-directory-access-token',
                    options: {
                        token: token.token
                    }
                }
            });

            const result = await pool.request().query(`
                SELECT
                    DB_NAME() AS database_name,
                    SUSER_SNAME() AS authenticated_identity,
                    SYSUTCDATETIME() AS server_time;
            `);

            return {
                status: 200,
                jsonBody: {
                    status: 'connected',
                    ...result.recordset[0]
                }
            };
        } catch (error) {
            context.error('Database connection failed:', error);

            return {
                status: 500,
                jsonBody: {
                    status: 'error',
                    message: 'Database connection failed.'
                }
            };
        } finally {
            if (pool) {
                await pool.close();
            }
        }
    }
});