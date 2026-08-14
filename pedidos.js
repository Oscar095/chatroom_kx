// Pedidos: los trae la API de Siesa y viven en SQL Server (kos_apps, esquema kx).
// Es la única parte del panel que NO usa MongoDB.
const sql = require('mssql');

let pool = null;

// La cadena BD_AZURE del .env la exporta la extensión de VS Code y llega con
// la contraseña vacía, así que las credenciales van desglosadas en SQL_*.
function config() {
    const faltan = ['SQL_SERVER', 'SQL_DATABASE', 'SQL_USER', 'SQL_PASSWORD']
        .filter(k => !process.env[k]);
    if (faltan.length) throw new Error('faltan en el .env: ' + faltan.join(', '));

    return {
        server: process.env.SQL_SERVER,
        database: process.env.SQL_DATABASE,
        user: process.env.SQL_USER,
        password: process.env.SQL_PASSWORD,
        options: { encrypt: true, trustServerCertificate: false },
        connectionTimeout: Number(process.env.SQL_CONNECT_TIMEOUT || 30) * 1000,
        requestTimeout: Number(process.env.SQL_COMMAND_TIMEOUT || 60) * 1000,
        pool: { max: 4, min: 0, idleTimeoutMillis: 30000 }
    };
}

// Conexión perezosa: el panel sirve conversaciones aunque SQL esté caído, así
// que no se conecta al arrancar sino la primera vez que se piden pedidos.
async function conectar() {
    if (pool && pool.connected) return pool;
    pool = await new sql.ConnectionPool(config()).connect();
    return pool;
}

async function cerrar() {
    if (pool) { await pool.close(); pool = null; }
}

// La consulta guardada en Siesa trae su propio ORDER BY. Cuando se le pasa el
// parámetro `paginacion`, Connekta la envuelve en una subconsulta y SQL Server
// rechaza el ORDER BY con "invalid in views, inline functions, derived tables".
// Por eso se quita el parámetro: sin él la consulta corre bien.
function urlSiesa() {
    const url = new URL(process.env.API_SIESA_PEDIDOS);
    url.searchParams.delete('paginacion');
    return url;
}

async function traerDeSiesa() {
    const r = await fetch(urlSiesa(), {
        headers: { ConniKey: process.env.ConniKey, ConniToken: process.env.ConniToken },
        signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) throw new Error('Siesa respondió ' + r.status + ': ' + (await r.text()).slice(0, 200));

    const cuerpo = await r.json();
    if (cuerpo.codigo !== 0) {
        throw new Error('Siesa: ' + (cuerpo.mensaje || 'error') + ' — ' + JSON.stringify(cuerpo.detalle).slice(0, 200));
    }
    const filas = (cuerpo.detalle && cuerpo.detalle.Table) || [];

    return filas.map(f => ({
        idTipoDocto: String(f.f430_id_tipo_docto || '').trim(),
        consecDocto: Number(f.f430_consec_docto),
        fechaRegistro: f.f430_ts ? new Date(f.f430_ts) : null,
        nombreCliente: f['Nombre Cliente'] || null,
        fechaEntrega: f['Fecha Entrega'] ? new Date(f['Fecha Entrega']) : null
    })).filter(p => p.idTipoDocto && Number.isFinite(p.consecDocto));
}

// Mismo criterio que `Preparar Contacto Web` en n8n: se acepta con o sin
// indicativo y se guarda siempre como 57XXXXXXXXXX. Importa que sea el mismo
// formato del `sessionId` de wa_chats: es lo que permitiría cruzar un pedido
// con su conversación sin adivinar.
function normalizarCelular(valor) {
    const d = String(valor == null ? '' : valor).replace(/\D/g, '');
    if (/^3\d{9}$/.test(d)) return '57' + d;
    if (/^573\d{9}$/.test(d)) return d;
    return null;
}

// Trae de Siesa y refleja el resultado en SQL. El MERGE actualiza SOLO las
// columnas que vienen de la API. `no_guia`, `despachado`, `contacto` y los
// campos de notificación son del asesor: pisarlos le borraría el trabajo, y en
// el caso de `notificado_en` haría que al cliente le llegue el aviso dos veces.
async function sincronizar() {
    const pedidos = await traerDeSiesa();
    const cx = await conectar();
    const tx = new sql.Transaction(cx);
    await tx.begin();

    try {
        let nuevos = 0;
        for (const p of pedidos) {
            const req = new sql.Request(tx);
            req.input('tipo', sql.VarChar(10), p.idTipoDocto);
            req.input('consec', sql.Int, p.consecDocto);
            req.input('registro', sql.DateTime2, p.fechaRegistro);
            req.input('cliente', sql.NVarChar(200), p.nombreCliente);
            req.input('entrega', sql.DateTime2, p.fechaEntrega);

            const res = await req.query(`
                MERGE kx.pedidos WITH (HOLDLOCK) AS d
                USING (SELECT @tipo AS id_tipo_docto, @consec AS consec_docto) AS o
                    ON d.id_tipo_docto = o.id_tipo_docto AND d.consec_docto = o.consec_docto
                WHEN MATCHED THEN UPDATE SET
                    d.fecha_registro  = @registro,
                    d.nombre_cliente  = @cliente,
                    d.fecha_entrega   = @entrega,
                    d.pendiente       = 1,
                    d.actualizado_en  = SYSDATETIME(),
                    d.sincronizado_en = SYSDATETIME()
                WHEN NOT MATCHED THEN INSERT
                    (id_tipo_docto, consec_docto, fecha_registro, nombre_cliente, fecha_entrega, sincronizado_en)
                    VALUES (@tipo, @consec, @registro, @cliente, @entrega, SYSDATETIME())
                OUTPUT $action AS accion;`);

            if (res.recordset[0] && res.recordset[0].accion === 'INSERT') nuevos++;
        }

        // Los que ya no vienen de Siesa dejan de ser pendientes, pero la fila se
        // conserva: si se borrara, se perdería la guía que escribió el asesor.
        const marcar = new sql.Request(tx);
        const vistos = pedidos.map(p => `'${p.idTipoDocto.replace(/'/g, "''")}-${p.consecDocto}'`);
        const cerrados = await marcar.query(`
            UPDATE kx.pedidos
               SET pendiente = 0, actualizado_en = SYSDATETIME()
             WHERE pendiente = 1
               ${vistos.length ? `AND id_tipo_docto + '-' + CAST(consec_docto AS VARCHAR(20)) NOT IN (${vistos.join(',')})` : ''};
            SELECT @@ROWCOUNT AS n;`);

        await tx.commit();
        return {
            recibidos: pedidos.length,
            nuevos,
            actualizados: pedidos.length - nuevos,
            cerrados: cerrados.recordset[0].n
        };
    } catch (err) {
        await tx.rollback();
        throw err;
    }
}

// `soloPendientes` deja fuera los que Siesa ya no reporta.
async function listar({ soloPendientes = true, incluirDespachados = true } = {}) {
    const cx = await conectar();
    const filtros = [];
    if (soloPendientes) filtros.push('pendiente = 1');
    if (!incluirDespachados) filtros.push('despachado = 0');

    const r = await cx.request().query(`
        SELECT ${COLUMNAS}
          FROM kx.pedidos
         ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
         ORDER BY despachado ASC, fecha_entrega DESC, consec_docto DESC;`);

    return r.recordset.map(fila);
}

const COLUMNAS = `id_tipo_docto, consec_docto, fecha_registro, nombre_cliente,
                  fecha_entrega, no_guia, despachado, despachado_en, pendiente,
                  sincronizado_en, contacto, notificado_en, notificacion_wamid`;

function fila(f) {
    return {
        id: f.id_tipo_docto + '-' + f.consec_docto,
        idTipoDocto: f.id_tipo_docto,
        consecDocto: f.consec_docto,
        fechaRegistro: f.fecha_registro,
        nombreCliente: f.nombre_cliente,
        fechaEntrega: f.fecha_entrega,
        noGuia: f.no_guia,
        despachado: !!f.despachado,
        despachadoEn: f.despachado_en,
        pendiente: !!f.pendiente,
        sincronizadoEn: f.sincronizado_en,
        contacto: f.contacto,
        notificadoEn: f.notificado_en,
        notificacionWamid: f.notificacion_wamid
    };
}

// Un solo pedido. Lo usa la ruta de notificación, que necesita releer guía,
// contacto y `notificado_en` del servidor y no fiarse de lo que mande el panel.
async function obtener(idTipoDocto, consecDocto) {
    const cx = await conectar();
    const req = cx.request();
    req.input('tipo', sql.VarChar(10), idTipoDocto);
    req.input('consec', sql.Int, consecDocto);
    const r = await req.query(`
        SELECT ${COLUMNAS} FROM kx.pedidos
         WHERE id_tipo_docto = @tipo AND consec_docto = @consec;`);
    return r.recordset[0] ? fila(r.recordset[0]) : null;
}

// Sella el aviso ya entregado a Meta. Se llama DESPUÉS de que WhatsApp acepta,
// nunca antes: al revés, un fallo dejaría el pedido marcado como notificado y
// el cliente nunca se enteraría de que su pedido salió.
async function marcarNotificado(idTipoDocto, consecDocto, wamid) {
    const cx = await conectar();
    const req = cx.request();
    req.input('tipo', sql.VarChar(10), idTipoDocto);
    req.input('consec', sql.Int, consecDocto);
    req.input('wamid', sql.NVarChar(120), wamid || null);
    const r = await req.query(`
        UPDATE kx.pedidos
           SET notificado_en = SYSDATETIME(), notificacion_wamid = @wamid,
               actualizado_en = SYSDATETIME()
         WHERE id_tipo_docto = @tipo AND consec_docto = @consec;
        SELECT @@ROWCOUNT AS n;`);
    return r.recordset[0].n > 0;
}

// Actualiza lo que el asesor puede tocar. Los tres campos son opcionales por
// separado: se actualiza solo lo que venga.
async function actualizar(idTipoDocto, consecDocto, { despachado, noGuia, contacto }) {
    const cx = await conectar();
    const req = cx.request();
    req.input('tipo', sql.VarChar(10), idTipoDocto);
    req.input('consec', sql.Int, consecDocto);

    const sets = ['actualizado_en = SYSDATETIME()'];
    if (despachado !== undefined) {
        req.input('despachado', sql.Bit, despachado ? 1 : 0);
        sets.push('despachado = @despachado');
        // Se sella cuándo se despachó y se limpia si el asesor se retracta.
        sets.push('despachado_en = CASE WHEN @despachado = 1 THEN SYSDATETIME() ELSE NULL END');
    }
    if (noGuia !== undefined) {
        req.input('noGuia', sql.NVarChar(100), noGuia ? String(noGuia).trim() : null);
        sets.push('no_guia = @noGuia');
    }
    if (contacto !== undefined) {
        // Vacío borra el contacto; con valor ya viene normalizado desde la ruta.
        req.input('contacto', sql.NVarChar(20), contacto || null);
        sets.push('contacto = @contacto');
        // Cambiar de destinatario invalida el aviso anterior: el que lo recibió
        // no era este. Si no se limpiara, el panel diría "notificado" y el
        // contacto nuevo nunca sabría que su pedido salió.
        sets.push('notificado_en = NULL', 'notificacion_wamid = NULL');
    }

    const r = await req.query(`
        UPDATE kx.pedidos SET ${sets.join(', ')}
         WHERE id_tipo_docto = @tipo AND consec_docto = @consec;
        SELECT @@ROWCOUNT AS n;`);

    return r.recordset[0].n > 0;
}

module.exports = {
    conectar, cerrar, sincronizar, listar, obtener, actualizar,
    marcarNotificado, normalizarCelular, traerDeSiesa
};
