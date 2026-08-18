// Directorio de transportadoras: nombre + pagina de rastreo.
//
// Vive en SQL Server (kos_apps, esquema kx) al lado de kx.pedidos, y reusa su
// pool a proposito: es la MISMA base y abrir un segundo pool duplicaria las
// conexiones sin ganar nada. Al reusarlo hereda tambien la conexion perezosa,
// asi que el panel sigue sirviendo conversaciones aunque SQL este caido.
//
// A diferencia de los pedidos, aqui no hay ninguna API detras: estos datos los
// escribe el asesor y nada los sobreescribe.
const sql = require('mssql');
const { conectar } = require('./pedidos');

const COLUMNAS = 'id, nombre, url_rastreo, creado_en, actualizado_en';
// Para los OUTPUT: devolver la fila ya guardada evita que el panel muestre lo
// que el asesor tecleo en vez de lo que quedo en la base.
const INSERTADAS = COLUMNAS.split(',').map(c => 'INSERTED.' + c.trim()).join(', ');

function fila(f) {
    return {
        id: f.id,
        nombre: f.nombre,
        urlRastreo: f.url_rastreo,
        creadoEn: f.creado_en,
        actualizadoEn: f.actualizado_en
    };
}

// La URL se valida pero NO se normaliza: se devuelve la cadena tal como se
// tecleo. `new URL(...).href` percent-codifica las llaves y convertiria el
// marcador {guia} en %7Bguia%7D, que ninguna sustitucion volveria a encontrar.
function normalizarUrl(valor) {
    const v = String(valor == null ? '' : valor).trim();
    if (!v) return null;
    let u;
    try { u = new URL(v); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return v;
}

function normalizarNombre(valor) {
    const v = String(valor == null ? '' : valor).trim().replace(/\s+/g, ' ');
    return v || null;
}

// El indice unico sobre `nombre` es lo que impide dos "TCC" con URL distintas.
// SQL lo reporta como 2601 (indice unico) o 2627 (constraint).
function esNombreDuplicado(err) {
    return err && (err.number === 2601 || err.number === 2627);
}

async function listar() {
    const cx = await conectar();
    const r = await cx.request().query(`
        SELECT ${COLUMNAS} FROM kx.transportadoras ORDER BY nombre ASC;`);
    return r.recordset.map(fila);
}

async function crear({ nombre, urlRastreo }) {
    const cx = await conectar();
    const req = cx.request();
    req.input('nombre', sql.NVarChar(120), nombre);
    req.input('url', sql.NVarChar(500), urlRastreo);
    const r = await req.query(`
        INSERT INTO kx.transportadoras (nombre, url_rastreo)
        OUTPUT ${INSERTADAS}
        VALUES (@nombre, @url);`);
    return fila(r.recordset[0]);
}

// Los dos campos son opcionales por separado: se actualiza solo lo que venga,
// igual que en pedidos.actualizar().
async function actualizar(id, { nombre, urlRastreo }) {
    const cx = await conectar();
    const req = cx.request();
    req.input('id', sql.Int, id);

    const sets = ['actualizado_en = SYSDATETIME()'];
    if (nombre !== undefined) {
        req.input('nombre', sql.NVarChar(120), nombre);
        sets.push('nombre = @nombre');
    }
    if (urlRastreo !== undefined) {
        req.input('url', sql.NVarChar(500), urlRastreo);
        sets.push('url_rastreo = @url');
    }

    const r = await req.query(`
        UPDATE kx.transportadoras SET ${sets.join(', ')}
        OUTPUT ${INSERTADAS}
         WHERE id = @id;`);

    return r.recordset[0] ? fila(r.recordset[0]) : null;
}

// Se borra de verdad. Aqui no aplica el `pendiente = 0` de los pedidos: no hay
// nada que se pierda al quitar una transportadora que ya no se usa, y una
// lista con transportadoras muertas es peor que una lista corta.
async function eliminar(id) {
    const cx = await conectar();
    const req = cx.request();
    req.input('id', sql.Int, id);
    const r = await req.query(`
        DELETE FROM kx.transportadoras WHERE id = @id;
        SELECT @@ROWCOUNT AS n;`);
    return r.recordset[0].n > 0;
}

module.exports = {
    listar, crear, actualizar, eliminar,
    normalizarUrl, normalizarNombre, esNombreDuplicado
};
