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
    await asegurarColumnas();
    return pool;
}

/* Las columnas que el codigo da por hechas, creadas al vuelo la primera vez
   que se abre la conexion.

   Esta aqui y no solo en sql/migrar-*.js por la misma razon que la semilla de
   usuarios esta en auth.js: en Azure nadie corre scripts. Sin esto, el dia que
   se despliega una columna nueva, la seccion Pedidos revienta con "Invalid
   column name" — o sea que el asesor pierde el trabajo de digitar una guia por
   una columna que falta. Ya paso con `bodega` y `bodega_en`: el codigo se
   desplego, la migracion no se corrio, y tanto Pedidos como el Dashboard
   quedaron mostrando un error de SQL en crudo.

   Las etapas salen de ETAPAS y no de una lista escrita aqui: agregar una
   quinta etapa manana no puede volver a romper esto. `despachado` ya existe
   desde el CREATE TABLE y el COL_LENGTH lo deja pasar sin hacer nada.

   Es idempotente y de metadatos: `ADD <col> NULL` no reescribe la tabla, y
   `ADD <col> BIT NOT NULL DEFAULT (0)` tampoco en SQL Server moderno. Corre una
   vez por proceso; si falla (por permisos, por ejemplo) se avisa y se sigue,
   porque quedarse sin conexion seria peor que quedarse sin la columna.

   Los nombres de columna se concatenan en el SQL a proposito: son literales del
   codigo, no vienen de ninguna peticion — el mismo criterio de actualizar().  */
let columnasListas = false;

async function asegurarColumnas() {
    if (columnasListas) return;

    // Cada etapa: su bandera y su sello de fecha, con el mismo nombre de
    // constraint que usa sql/pedidos.sql para que las dos vias dejen la tabla
    // igual y correr la migracion despues no encuentre nada raro.
    const etapas = ETAPAS.map(e => `
        IF COL_LENGTH('kx.pedidos', '${e}') IS NULL
            ALTER TABLE kx.pedidos ADD ${e} BIT NOT NULL CONSTRAINT DF_kx_pedidos_${e} DEFAULT (0);
        IF COL_LENGTH('kx.pedidos', '${e}_en') IS NULL
            ALTER TABLE kx.pedidos ADD ${e}_en DATETIME2(3) NULL;`).join('\n');

    try {
        await pool.request().batch(`
            IF OBJECT_ID('kx.pedidos', 'U') IS NOT NULL
            BEGIN
                ${etapas}
                IF COL_LENGTH('kx.pedidos', 'contacto') IS NULL
                    ALTER TABLE kx.pedidos ADD contacto NVARCHAR(20) NULL;
                IF COL_LENGTH('kx.pedidos', 'notificado_en') IS NULL
                    ALTER TABLE kx.pedidos ADD notificado_en DATETIME2(3) NULL;
                IF COL_LENGTH('kx.pedidos', 'notificacion_wamid') IS NULL
                    ALTER TABLE kx.pedidos ADD notificacion_wamid NVARCHAR(120) NULL;
                IF COL_LENGTH('kx.pedidos', 'usuario') IS NULL
                    ALTER TABLE kx.pedidos ADD usuario NVARCHAR(60) NULL;
            END
            IF OBJECT_ID('kx.transportadoras', 'U') IS NOT NULL AND COL_LENGTH('kx.transportadoras', 'usuario') IS NULL
                ALTER TABLE kx.transportadoras ADD usuario NVARCHAR(60) NULL;`);
        columnasListas = true;
    } catch (err) {
        console.warn('[pedidos] no se pudieron asegurar las columnas: ' + err.message +
            '. Corre sql/migrar-pedidos.js y sql/migrar-transportadoras.js, o revisa que el ' +
            'usuario de SQL pueda hacer ALTER TABLE.');
    }
}

// SQL Server reporta una columna que no existe con el error 207. El mensaje
// crudo ("Invalid column name 'bodega'") no le dice nada al asesor que lo ve en
// pantalla, asi que las rutas lo traducen a algo que se pueda accionar.
function esColumnaFaltante(err) {
    return !!err && err.number === 207;
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
// columnas que vienen de la API. `no_guia`, `contacto`, las cuatro etapas
// (`impresion`, `formacion`, `bodega`, `despachado`) con sus sellos y los
// campos de notificación son del asesor: pisarlos le borraría el trabajo, y en
// el caso de `notificado_en` haría que al cliente le llegue el aviso dos veces.
// El panel sincroniza solo al abrir la sección, así que esto corre muchas más
// veces que antes y la regla importa más, no menos.
//
// Por lo mismo hay una sola sincronización a la vez: varios asesores abriendo
// Pedidos casi al tiempo dispararían cada uno la suya, y serían dos consultas a
// Siesa y dos MERGE peleando por las mismas filas para llegar al mismo
// resultado. El segundo se cuelga del primero y recibe su respuesta.
let enCurso = null;

function sincronizar() {
    if (enCurso) return enCurso;
    enCurso = sincronizarAhora().finally(() => { enCurso = null; });
    return enCurso;
}

async function sincronizarAhora() {
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
                  sincronizado_en, contacto, notificado_en, notificacion_wamid,
                  impresion, impresion_en, formacion, formacion_en, bodega, bodega_en,
                  usuario`;

// Las etapas por las que pasa un pedido, en el orden en que ocurren. Las cuatro
// se guardan igual —bandera `x` + sello `x_en`— y ninguna viene de Siesa: las
// marca el asesor, así que el MERGE de `sincronizar()` no puede tocarlas.
//
// La lista es la única fuente del nombre de estas columnas: `actualizar()` arma
// el UPDATE desde aquí y el panel pinta una casilla por cada una. Agregar una
// etapa nueva es agregarla aquí, en el DDL y en la tabla del panel.
const ETAPAS = ['impresion', 'formacion', 'bodega', 'despachado'];

function fila(f) {
    return {
        id: f.id_tipo_docto + '-' + f.consec_docto,
        idTipoDocto: f.id_tipo_docto,
        consecDocto: f.consec_docto,
        fechaRegistro: f.fecha_registro,
        nombreCliente: f.nombre_cliente,
        fechaEntrega: f.fecha_entrega,
        noGuia: f.no_guia,
        impresion: !!f.impresion,
        impresionEn: f.impresion_en,
        formacion: !!f.formacion,
        formacionEn: f.formacion_en,
        bodega: !!f.bodega,
        bodegaEn: f.bodega_en,
        despachado: !!f.despachado,
        despachadoEn: f.despachado_en,
        pendiente: !!f.pendiente,
        sincronizadoEn: f.sincronizado_en,
        contacto: f.contacto,
        notificadoEn: f.notificado_en,
        notificacionWamid: f.notificacion_wamid,
        // Quien dejo la fila asi. Va al panel para que el asesor vea de quien
        // es la guia que esta leyendo sin tener que abrir el registro de
        // cambios. Es null en las filas anteriores al login.
        usuario: f.usuario || null
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
async function marcarNotificado(idTipoDocto, consecDocto, wamid, usuario = null) {
    const cx = await conectar();
    const req = cx.request();
    req.input('tipo', sql.VarChar(10), idTipoDocto);
    req.input('consec', sql.Int, consecDocto);
    req.input('wamid', sql.NVarChar(120), wamid || null);
    // El aviso le llega a un cliente y le cuesta plata a KOS: de todos los
    // cambios de esta tabla, este es el que mas importa poder atribuir.
    req.input('usuario', sql.NVarChar(60), usuario || null);
    const r = await req.query(`
        UPDATE kx.pedidos
           SET notificado_en = SYSDATETIME(), notificacion_wamid = @wamid,
               usuario = COALESCE(@usuario, usuario),
               actualizado_en = SYSDATETIME()
         WHERE id_tipo_docto = @tipo AND consec_docto = @consec;
        SELECT @@ROWCOUNT AS n;`);
    return r.recordset[0].n > 0;
}

// Actualiza lo que el asesor puede tocar: las cuatro etapas, la guía y el
// contacto. Todos los campos son opcionales por separado, así que marcar una
// casilla no pisa lo que otro asesor acabe de escribir en la misma fila.
async function actualizar(idTipoDocto, consecDocto, cambios = {}, usuario = null) {
    const { noGuia, contacto } = cambios;
    const cx = await conectar();
    const req = cx.request();
    req.input('tipo', sql.VarChar(10), idTipoDocto);
    req.input('consec', sql.Int, consecDocto);
    // `usuario` va aparte de `cambios` y no dentro: no es un campo que el panel
    // pueda mandar, es quien esta escribiendo. Mezclarlo con lo editable dejaria
    // que una peticion se atribuyera el cambio a otra persona.
    req.input('usuario', sql.NVarChar(60), usuario || null);

    const sets = ['actualizado_en = SYSDATETIME()', 'usuario = COALESCE(@usuario, usuario)'];
    // Los nombres salen de ETAPAS, no del cuerpo de la petición: son literales
    // del código y por eso pueden ir concatenados en el SQL. El valor sí viaja
    // como parámetro.
    for (const etapa of ETAPAS) {
        if (cambios[etapa] === undefined) continue;
        req.input(etapa, sql.Bit, cambios[etapa] ? 1 : 0);
        sets.push(`${etapa} = @${etapa}`);
        // Se sella cuándo se marcó y se limpia si el asesor se retracta: una
        // fecha sobre una casilla desmarcada solo confundiría al que la lea.
        sets.push(`${etapa}_en = CASE WHEN @${etapa} = 1 THEN SYSDATETIME() ELSE NULL END`);
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

/* Los numeros de pedidos para el dashboard.

   Se cuenta EN SQL y no trayendo las filas a Node: es una sola ida a la base
   y no crece con la tabla, a diferencia de listar(), que trae todo porque la
   seccion Pedidos necesita cada fila para pintarla.

   "En produccion" es `pendiente = 1 AND despachado = 0`: sigue vivo en Siesa y
   todavia no sale. No se define por las tres primeras banderas porque entre
   ellas NO hay orden obligatorio (ver CLAUDE.md) y un pedido puede estar en
   bodega sin que nadie marcara impresion.                                   */
async function resumen() {
    const cx = await conectar();

    const r = await cx.request().query(`
        SELECT
            COUNT(*)                                                          AS total,
            SUM(CASE WHEN pendiente = 1 THEN 1 ELSE 0 END)                    AS pendientes,
            SUM(CASE WHEN pendiente = 1 AND despachado = 0 THEN 1 ELSE 0 END) AS activos,
            SUM(CASE WHEN pendiente = 1 AND despachado = 1 THEN 1 ELSE 0 END) AS despachados,
            SUM(CASE WHEN pendiente = 1 AND despachado = 0 AND impresion = 1 THEN 1 ELSE 0 END) AS impresion,
            SUM(CASE WHEN pendiente = 1 AND despachado = 0 AND formacion = 1 THEN 1 ELSE 0 END) AS formacion,
            SUM(CASE WHEN pendiente = 1 AND despachado = 0 AND bodega    = 1 THEN 1 ELSE 0 END) AS bodega,
            SUM(CASE WHEN pendiente = 1 AND despachado = 0
                      AND impresion = 0 AND formacion = 0 AND bodega = 0 THEN 1 ELSE 0 END)     AS sin_empezar,
            -- Alertas: cada una es trabajo que quedo a medias, no estadistica.
            SUM(CASE WHEN pendiente = 1 AND despachado = 1 AND notificado_en IS NULL
                     THEN 1 ELSE 0 END)                                       AS sin_avisar,
            SUM(CASE WHEN pendiente = 1 AND despachado = 1 AND no_guia IS NULL
                     THEN 1 ELSE 0 END)                                       AS sin_guia,
            SUM(CASE WHEN pendiente = 1 AND despachado = 1 AND contacto IS NULL
                     THEN 1 ELSE 0 END)                                       AS sin_contacto,
            SUM(CASE WHEN pendiente = 1 AND despachado = 0
                      AND fecha_entrega IS NOT NULL AND fecha_entrega < CAST(GETDATE() AS DATE)
                     THEN 1 ELSE 0 END)                                       AS vencidos,
            MAX(sincronizado_en)                                              AS sincronizado_en
          FROM kx.pedidos;`);

    // Un punto por mes de registro, para poder cruzar a ojo la curva de
    // pedidos con la de leads. Doce meses es lo que cabe legible en la tarjeta.
    const s = await cx.request().query(`
        SELECT TOP 12 FORMAT(fecha_registro, 'yyyy-MM') AS mes, COUNT(*) AS n
          FROM kx.pedidos
         WHERE fecha_registro IS NOT NULL
         GROUP BY FORMAT(fecha_registro, 'yyyy-MM')
         ORDER BY mes DESC;`);

    const f = r.recordset[0];
    return {
        total: f.total || 0,
        pendientes: f.pendientes || 0,
        activos: f.activos || 0,
        despachados: f.despachados || 0,
        etapas: {
            impresion: f.impresion || 0,
            formacion: f.formacion || 0,
            bodega: f.bodega || 0,
            sinEmpezar: f.sin_empezar || 0
        },
        alertas: {
            sinAvisar: f.sin_avisar || 0,
            sinGuia: f.sin_guia || 0,
            sinContacto: f.sin_contacto || 0,
            vencidos: f.vencidos || 0
        },
        sincronizadoEn: f.sincronizado_en || null,
        serieMensual: s.recordset.map(x => ({ mes: x.mes, n: x.n })).reverse()
    };
}

module.exports = {
    conectar, cerrar, sincronizar, listar, obtener, actualizar,
    marcarNotificado, normalizarCelular, traerDeSiesa, ETAPAS, resumen,
    esColumnaFaltante
};
