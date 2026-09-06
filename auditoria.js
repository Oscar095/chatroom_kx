// El registro de cambios del portal: quien toco que, y cuando.
//
// Cada tabla guarda ADEMAS su propia columna `usuario` con el ultimo que la
// escribio (kx.pedidos, kx.transportadoras y las banderas del chat en Mongo).
// Esas dos cosas responden preguntas distintas y por eso existen las dos:
//
//   - la columna dice "asi quedo esta fila, y la dejo asi fulano";
//   - este registro dice "que paso hoy en el panel", que es lo que se necesita
//     cuando un cliente reclama que le llego un aviso o cuando una guia
//     aparece cambiada.
//
// Vive en MongoDB aunque audite tambien lo que se escribe en SQL Server: es un
// solo lugar donde mirar, y sobre todo sigue en pie con SQL caido — que es
// justo cuando mas raro se pone el panel y mas hace falta saber que se hizo.
//
// Regla de oro: registrar NUNCA puede tumbar la accion que audita. Si el log
// falla, la guia igual se guarda y el mensaje igual sale; el fallo se queda en
// la consola del servidor.

const COLECCION = 'auditoria';

// Cuantas entradas devuelve la vista de actividad. Es para revisar lo de hoy,
// no para auditar el año: mas de esto no se lee, se filtra.
const TOPE = 200;

let db = null;

function iniciar(base) {
    db = base;
    // El indice es por fecha descendente porque la unica consulta que existe
    // es "lo ultimo que paso".
    base.collection(COLECCION).createIndex({ en: -1 })
        .catch(err => console.warn('[auditoria] no se pudo crear el indice:', err.message));
}

// La IP real detras del proxy de Azure. Solo informativa: sirve para distinguir
// "lo hizo desde la oficina" de "lo hizo desde la casa", no para autenticar.
function ipDe(req) {
    const fw = req && req.headers && req.headers['x-forwarded-for'];
    if (fw) return String(fw).split(',')[0].trim();
    return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || null;
}

/**
 * @param {object} req      la peticion, para sacar el usuario y la IP
 * @param {string} accion   'pedidos.actualizar', 'pipeline.mover', …
 * @param {string} objetivo que fila o conversacion se toco
 * @param {object} detalle  lo minimo para entender el cambio
 */
function registrar(req, accion, objetivo, detalle = {}) {
    if (!db) return;
    const u = (req && req.usuario) || null;
    db.collection(COLECCION).insertOne({
        en: new Date().toISOString(),
        usuario: u ? u.usuario : null,
        nombre: u ? (u.nombre || u.usuario) : null,
        accion,
        objetivo: objetivo == null ? null : String(objetivo),
        detalle,
        ip: ipDe(req)
    }).catch(err => {
        // Se traga el error a proposito: perder una linea del log es mucho
        // menos grave que deshacerle al asesor lo que acaba de guardar.
        console.warn('[auditoria] no se pudo registrar ' + accion + ':', err.message);
    });
}

async function ultimos({ limite = 100, usuario = null, accion = null } = {}) {
    if (!db) return [];
    const filtro = {};
    if (usuario) filtro.usuario = usuario;
    if (accion) filtro.accion = accion;

    const docs = await db.collection(COLECCION)
        .find(filtro)
        .sort({ en: -1 })
        .limit(Math.min(TOPE, Math.max(1, Number(limite) || 100)))
        .toArray();

    return docs.map(d => ({
        id: d._id.toString(),
        en: d.en,
        usuario: d.usuario,
        nombre: d.nombre,
        accion: d.accion,
        objetivo: d.objetivo,
        detalle: d.detalle || {},
        ip: d.ip || null
    }));
}

module.exports = { iniciar, registrar, ultimos, TOPE };
