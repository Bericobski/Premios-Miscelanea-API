const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // Hosted databases like Aiven only accept encrypted connections; local XAMPP doesn't need it.
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    // Each Vercel instance opens its own pool, so keep it small there (free databases allow few connections).
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
});

module.exports = pool;
