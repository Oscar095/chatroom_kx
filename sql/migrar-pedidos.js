// Crea kx.pedidos si no existe. Es idempotente: se puede correr las veces que
// sea. No borra ni modifica nada existente.
//
//   cd chatroom && node sql/migrar-pedidos.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

(async () => {
    const ddl = fs.readFileSync(path.join(__dirname, 'pedidos.sql'), 'utf8');
    // GO no es T-SQL, es un separador de lotes del cliente: hay que partir.
    const lotes = ddl.split(/^\s*GO\s*$/mi).map(s => s.trim()).filter(Boolean);

    const pool = await new sql.ConnectionPool({
        server: process.env.SQL_SERVER,
        database: process.env.SQL_DATABASE,
        user: process.env.SQL_USER,
        password: process.env.SQL_PASSWORD,
        options: { encrypt: true, trustServerCertificate: false },
        connectionTimeout: 30000,
        requestTimeout: 60000
    }).connect();

    console.log('conectado a', process.env.SQL_DATABASE);
    for (const [i, lote] of lotes.entries()) {
        await pool.request().batch(lote);
        console.log('  lote ' + (i + 1) + '/' + lotes.length + ' ok');
    }

    const r = await pool.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = 'kx' AND TABLE_NAME = 'pedidos'
         ORDER BY ORDINAL_POSITION;`);

    console.log('\nkx.pedidos:');
    r.recordset.forEach(c => console.log('   ' + c.COLUMN_NAME.padEnd(17) +
        (c.DATA_TYPE + (c.CHARACTER_MAXIMUM_LENGTH ? '(' + c.CHARACTER_MAXIMUM_LENGTH + ')' : '')).padEnd(16) +
        (c.IS_NULLABLE === 'YES' ? 'null' : 'not null')));

    await pool.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
