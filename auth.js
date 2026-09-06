// Quien entra al panel y que puede ver.
//
// Los usuarios viven en MongoDB y NO en SQL Server, a proposito: la conexion a
// SQL es perezosa justamente para que el panel siga sirviendo conversaciones
// con SQL caido (ver CLAUDE.md). Si el login dependiera de SQL, esa caida ya no
// dejaria el panel a medias: lo dejaria cerrado. Mongo en cambio es requisito
// de arranque — sin el, server.js ni levanta —, asi que un login que depende de
// Mongo no agrega ningun modo de fallo nuevo.
//
// La sesion es un cookie FIRMADO, sin estado en el servidor. Es lo que permite
// que Azure reinicie el contenedor —o levante una segunda instancia— sin echar
// a nadie, cosa que una tabla de sesiones en memoria no aguanta. El cookie solo
// carga el usuario y la hora de emision: los permisos se releen de Mongo en
// CADA peticion, para que quitarle un modulo a alguien tenga efecto de
// inmediato y no cuando se le venza el token.
const crypto = require('crypto');

const COLECCION = 'usuarios';
const COOKIE = 'kx_sesion';

// Cuanto dura una sesion sin volver a escribir la clave. Doce horas cubre un
// turno completo sin dejar el panel abierto toda la noche en un equipo
// compartido.
const HORAS_SESION = 12;

/* --- Los modulos --------------------------------------------------------
   La lista es la fuente unica: el centro de usuarios pinta una casilla por
   cada uno, el rail esconde los botones que no estan y las rutas se protegen
   con estas mismas claves. Mismo criterio que ETAPAS_PIPELINE en server.js —
   si estuviera copiada en index.html, un modulo nuevo se veria en el menu sin
   proteger su ruta, o al reves.

   La granularidad es la del rail: un modulo = una seccion del panel. No se
   parte mas fino (por ejemplo "puede enviar" aparte de "puede leer") porque
   nadie lo pidio y cada casilla de mas es una decision que alguien tiene que
   tomar por cada persona que entra.

   `clave` se guarda en el documento del usuario, asi que renombrarla obliga a
   migrar; `nombre` y `descripcion` son rotulo y se cambian sin tocar la base. */
const MODULOS = [
    { clave: 'conversaciones', nombre: 'Conversaciones',
      descripcion: 'Bandeja de WhatsApp y Chat Web, el historial completo, archivar y responderle al cliente.' },
    { clave: 'dashboard', nombre: 'Dashboard',
      descripcion: 'Los indicadores del panel: volumen de conversaciones, embudo y pedidos.' },
    { clave: 'pipeline', nombre: 'Pipeline',
      descripcion: 'El tablero del embudo de venta: mover tarjetas de etapa y escribir notas.' },
    { clave: 'pedidos', nombre: 'Pedidos',
      descripcion: 'Pedidos de Siesa, etapas de produccion, guias y el aviso de despacho al cliente.' },
    { clave: 'transportadoras', nombre: 'Transportadoras',
      descripcion: 'El directorio de transportadoras y sus paginas de rastreo.' },
    { clave: 'contactos', nombre: 'Contactos',
      descripcion: 'La agenda: todo lo que se sabe de cada cliente que ha escrito.' },
    { clave: 'usuarios', nombre: 'Usuarios',
      descripcion: 'Crear usuarios, decidir a que accede cada uno y ver el registro de cambios.' }
];

const CLAVES_MODULOS = MODULOS.map(m => m.clave);

// El modulo que abre la puerta a todos los demas: quien lo tiene puede repartir
// el resto. Se nombra aparte porque las guardas del centro de usuarios giran
// alrededor de el — nadie puede quitarselo a si mismo, que es lo que garantiza
// que siempre quede un administrador activo.
const MODULO_ADMIN = 'usuarios';

/* --- Los cuatro usuarios de arranque ------------------------------------
   Se crean solos la primera vez que el panel arranca contra una base sin
   usuarios (ver asegurarSemilla). Esta aqui y no solo en el script de
   migracion porque en Azure nadie corre scripts: si la coleccion llegara
   vacia, el panel quedaria cerrado para todos y sin forma de abrirlo.        */
const CLAVE_TEMPORAL = '1234';

const USUARIOS_INICIALES = [
    { usuario: 'dianan',   nombre: 'Diana Nieto' },
    { usuario: 'karolc',   nombre: 'Karol Chaparro' },
    { usuario: 'nicolasr', nombre: 'Nicolas Rivas' },
    { usuario: 'oscaro',   nombre: 'Oscar Orozco' }
];

let db = null;

function iniciar(base) {
    db = base;
}

function coleccion() {
    if (!db) throw new Error('auth.iniciar(db) no se ha llamado');
    return db.collection(COLECCION);
}

/* --- Claves -------------------------------------------------------------
   scrypt viene en el `crypto` de Node, asi que no agrega ninguna dependencia
   — y toda dependencia que use chatroom/ tiene que estar en su package.json o
   el panel muere al arrancar en Azure (ver CLAUDE.md). Es de la misma familia
   que bcrypt: lento a proposito y con sal por usuario, para que la lista de
   hashes no sirva de nada si algun dia se filtra.                            */
const SCRYPT = { N: 16384, r: 8, p: 1, largo: 64 };

function hashClave(clave) {
    const sal = crypto.randomBytes(16);
    const h = crypto.scryptSync(String(clave), sal, SCRYPT.largo,
        { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
            sal.toString('base64'), h.toString('base64')].join('$');
}

// Devuelve false ante cualquier formato raro en vez de reventar: un documento
// de usuario a medio escribir tiene que negar el acceso, no tumbar el login.
function verificarClave(clave, guardado) {
    try {
        const p = String(guardado || '').split('$');
        if (p.length !== 6 || p[0] !== 'scrypt') return false;
        const sal = Buffer.from(p[4], 'base64');
        const esperado = Buffer.from(p[5], 'base64');
        const h = crypto.scryptSync(String(clave), sal, esperado.length,
            { N: Number(p[1]), r: Number(p[2]), p: Number(p[3]) });
        // timingSafeEqual y no ===: comparar byte a byte filtra por el tiempo
        // cuantos coinciden.
        return h.length === esperado.length && crypto.timingSafeEqual(h, esperado);
    } catch {
        return false;
    }
}

/* --- El cookie firmado --------------------------------------------------
   SESSION_SECRET sale del .env (en Azure, de Application settings). Si falta,
   se genera uno al vuelo: el panel arranca igual y lo unico que se pierde es
   que las sesiones no sobreviven a un reinicio ni se comparten entre
   instancias. Preferimos eso a que el contenedor no levante por una variable
   que nadie configuro todavia — pero se avisa fuerte en el log, porque en
   Azure el sintoma seria "me saca cada rato" y no dice por que.              */
let secretoCache = null;

function secreto() {
    if (secretoCache) return secretoCache;
    if (process.env.SESSION_SECRET) {
        secretoCache = Buffer.from(process.env.SESSION_SECRET, 'utf8');
    } else {
        console.warn('[auth] Falta SESSION_SECRET: se genera uno temporal. ' +
            'Las sesiones se cierran en cada reinicio y no sirven con mas de una ' +
            'instancia. Ponlo en chatroom/.env o en Application settings.');
        secretoCache = crypto.randomBytes(48);
    }
    return secretoCache;
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function firmar(texto) {
    return b64url(crypto.createHmac('sha256', secreto()).update(texto).digest());
}

function crearToken(usuario) {
    const cuerpo = b64url(JSON.stringify({ u: usuario, t: Date.now() }));
    return cuerpo + '.' + firmar(cuerpo);
}

function leerToken(token) {
    if (!token || typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i < 1) return null;
    const cuerpo = token.slice(0, i);
    const firma = token.slice(i + 1);

    const esperada = firmar(cuerpo);
    // Las dos cadenas son base64url de 32 bytes: si difieren en largo, la firma
    // ya es invalida y timingSafeEqual reventaria.
    if (firma.length !== esperada.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;

    try {
        const datos = JSON.parse(Buffer.from(cuerpo, 'base64').toString('utf8'));
        if (!datos || typeof datos.u !== 'string' || !Number.isFinite(datos.t)) return null;
        if (Date.now() - datos.t > HORAS_SESION * 36e5) return null;
        return datos;
    } catch {
        return null;
    }
}

/* --- Cookies ------------------------------------------------------------ */

function leerCookie(req, nombre) {
    const crudo = req.headers.cookie;
    if (!crudo) return null;
    for (const parte of crudo.split(';')) {
        const i = parte.indexOf('=');
        if (i < 0) continue;
        if (parte.slice(0, i).trim() === nombre) {
            return decodeURIComponent(parte.slice(i + 1).trim());
        }
    }
    return null;
}

// `secure` se decide por peticion y no por una variable: en local el panel es
// http y un cookie Secure no viajaria nunca; en Azure llega por https detras
// del proxy, que lo anuncia en x-forwarded-proto.
function esHttps(req) {
    return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function ponerCookie(req, res, token) {
    const partes = [
        COOKIE + '=' + encodeURIComponent(token),
        'Path=/',
        'HttpOnly',              // que ningun script de la pagina pueda leerlo
        'SameSite=Lax',
        'Max-Age=' + (HORAS_SESION * 3600)
    ];
    if (esHttps(req)) partes.push('Secure');
    res.setHeader('Set-Cookie', partes.join('; '));
}

function borrarCookie(req, res) {
    const partes = [COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (esHttps(req)) partes.push('Secure');
    res.setHeader('Set-Cookie', partes.join('; '));
}

/* --- Usuarios ----------------------------------------------------------- */

// El usuario es la identidad y se guarda SIEMPRE en minusculas: "Oscaro" y
// "oscaro" tienen que ser la misma persona, o se crearian dos cuentas con el
// mismo nombre y permisos distintos.
function normalizarUsuario(valor) {
    const v = String(valor == null ? '' : valor).trim().toLowerCase();
    return /^[a-z0-9._-]{3,30}$/.test(v) ? v : null;
}

function normalizarNombre(valor) {
    const v = String(valor == null ? '' : valor).trim().replace(/\s+/g, ' ');
    return v && v.length <= 80 ? v : null;
}

// Se descarta lo que no este en el catalogo en vez de rechazar la peticion: un
// modulo que ya no existe (porque se renombro la clave) no puede impedir
// guardar los permisos de una persona.
function normalizarModulos(lista) {
    if (!Array.isArray(lista)) return [];
    return CLAVES_MODULOS.filter(c => lista.includes(c));
}

// La clave temporal "1234" no pasa esta regla, y esta bien: la pone un
// administrador y el panel obliga a cambiarla en el primer ingreso. Lo que se
// valida aqui es lo que una persona elige para si misma.
const LARGO_MINIMO = 8;

function validarClave(valor) {
    const v = String(valor == null ? '' : valor);
    if (v.length < LARGO_MINIMO) {
        return 'La contraseña debe tener al menos ' + LARGO_MINIMO + ' caracteres.';
    }
    if (v.length > 200) return 'La contraseña es demasiado larga.';
    if (v === CLAVE_TEMPORAL) return 'Esa es la contraseña temporal: elige una nueva.';
    if (!/[^0-9]/.test(v)) return 'La contraseña no puede ser solo números.';
    return null;
}

async function buscar(usuario) {
    const u = normalizarUsuario(usuario);
    if (!u) return null;
    return await coleccion().findOne({ usuario: u });
}

// Lo que se le puede mandar al navegador. El hash de la clave NO sale de aqui
// nunca: esta funcion es la unica puerta por la que un usuario viaja al panel.
function publico(u) {
    if (!u) return null;
    return {
        usuario: u.usuario,
        nombre: u.nombre || u.usuario,
        modulos: normalizarModulos(u.modulos),
        activo: u.activo !== false,
        debeCambiar: !!u.debeCambiar,
        ultimoIngreso: u.ultimoIngreso || null,
        creadoEn: u.creadoEn || null,
        actualizadoEn: u.actualizadoEn || null,
        actualizadoPor: u.actualizadoPor || null
    };
}

function puede(u, modulo) {
    if (!u) return false;
    if (u.activo === false) return false;
    return normalizarModulos(u.modulos).includes(modulo);
}

async function listar() {
    const docs = await coleccion().find({}).toArray();
    return docs.map(publico)
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
}

async function crear({ usuario, nombre, modulos, clave, por }) {
    const ahora = new Date().toISOString();
    const doc = {
        usuario,
        nombre,
        modulos: normalizarModulos(modulos),
        activo: true,
        clave: hashClave(clave || CLAVE_TEMPORAL),
        // Con la clave temporal puesta por otro, el primer ingreso obliga a
        // cambiarla: nadie mas puede saber la clave con la que se trabaja.
        debeCambiar: true,
        // Marca desde cuando valen las sesiones. Cambiar la clave la resella y
        // eso invalida los cookies emitidos antes.
        credencialesDesde: ahora,
        creadoEn: ahora,
        creadoPor: por || null,
        actualizadoEn: ahora,
        actualizadoPor: por || null,
        ultimoIngreso: null
    };
    await coleccion().insertOne(doc);
    return publico(doc);
}

async function actualizar(usuario, cambios, por) {
    const set = { actualizadoEn: new Date().toISOString(), actualizadoPor: por || null };
    if (cambios.nombre !== undefined) set.nombre = cambios.nombre;
    if (cambios.modulos !== undefined) set.modulos = normalizarModulos(cambios.modulos);
    if (cambios.activo !== undefined) set.activo = !!cambios.activo;

    const r = await coleccion().findOneAndUpdate(
        { usuario },
        { $set: set },
        { returnDocument: 'after' }
    );
    // El driver 7 devuelve el documento; versiones viejas lo envuelven en
    // { value }. Se aceptan las dos formas para no atarse a una.
    const doc = r && (r.value !== undefined ? r.value : r);
    return publico(doc);
}

// Pone una clave y decide si hay que cambiarla al entrar. `credencialesDesde`
// se resella siempre: cambiar la clave tiene que cerrar las sesiones abiertas
// con la anterior, que es justo lo que se quiere cuando alguien la reinicia
// porque sospecha que se la vieron.
async function ponerClave(usuario, clave, { temporal = false, por = null } = {}) {
    const ahora = new Date().toISOString();
    const r = await coleccion().updateOne(
        { usuario },
        { $set: {
            clave: hashClave(clave),
            debeCambiar: !!temporal,
            credencialesDesde: ahora,
            actualizadoEn: ahora,
            actualizadoPor: por
        } }
    );
    return r.matchedCount > 0;
}

async function eliminar(usuario) {
    const r = await coleccion().deleteOne({ usuario });
    return r.deletedCount > 0;
}

/* --- Intentos fallidos --------------------------------------------------
   Freno simple y en memoria: cinco intentos seguidos y la cuenta descansa un
   minuto. No pretende ser un WAF — solo que probar claves de cuatro digitos a
   ciegas deje de ser gratis. Se pierde al reiniciar, y no importa: el ataque
   que frena dura segundos.                                                   */
const TOPE_INTENTOS = 5;
const ESPERA_MS = 60000;
const intentos = new Map();

function bloqueado(usuario) {
    const x = intentos.get(usuario);
    if (!x || x.hasta < Date.now()) return 0;
    return Math.ceil((x.hasta - Date.now()) / 1000);
}

function fallo(usuario) {
    const x = intentos.get(usuario) || { n: 0, hasta: 0 };
    x.n++;
    if (x.n >= TOPE_INTENTOS) { x.hasta = Date.now() + ESPERA_MS; x.n = 0; }
    intentos.set(usuario, x);
}

function acierto(usuario) {
    intentos.delete(usuario);
}

/* --- Sesion ------------------------------------------------------------- */

// Devuelve el usuario COMPLETO de Mongo, no lo que dice el cookie: los modulos
// se releen en cada peticion para que un permiso quitado valga de inmediato.
async function sesionDe(req) {
    const datos = leerToken(leerCookie(req, COOKIE));
    if (!datos) return null;

    const u = await buscar(datos.u);
    if (!u || u.activo === false) return null;

    // El token se emitio antes del ultimo cambio de clave: es de una sesion que
    // ya se cerro a proposito.
    const desde = new Date(u.credencialesDesde || 0).getTime();
    if (Number.isFinite(desde) && datos.t < desde) return null;

    return u;
}

// Guarda de todas las rutas /api. Deja pasar solo con sesion valida y con la
// clave temporal ya cambiada: mientras `debeCambiar` este puesto, la unica
// parte del panel que responde es la de cambiar la clave.
function conSesion(req, res, next) {
    sesionDe(req).then(u => {
        if (!u) return res.status(401).json({ error: 'Sesion no iniciada', login: true });
        if (u.debeCambiar) {
            return res.status(403).json({
                error: 'Tienes que cambiar la contraseña temporal antes de usar el panel.',
                debeCambiar: true
            });
        }
        req.usuario = u;
        next();
    }).catch(err => res.status(500).json({ error: err.message }));
}

// Igual que conSesion pero sin exigir la clave ya cambiada: lo usan las rutas
// de /api/auth, que son justamente por donde se sale de ese estado.
function conSesionCruda(req, res, next) {
    sesionDe(req).then(u => {
        if (!u) return res.status(401).json({ error: 'Sesion no iniciada', login: true });
        req.usuario = u;
        next();
    }).catch(err => res.status(500).json({ error: err.message }));
}

// El permiso se comprueba en el SERVIDOR y no solo escondiendo botones: el rail
// oculta lo que no corresponde por comodidad, pero la ruta es la que manda —
// si no, bastaria con escribir la URL de la API a mano.
function conModulo(clave) {
    return conAlgunModulo([clave]);
}

// Para las rutas que alimentan a mas de una seccion. Hoy la unica es
// /api/sessions: el tablero del Pipeline no tiene fuente propia, se arma con
// las mismas conversaciones que la bandeja (ver CLAUDE.md). Sin esto, quien
// tuviera el embudo pero no la bandeja veria el tablero vacio con un 403
// detras — y separar la lectura en dos rutas gemelas seria peor.
function conAlgunModulo(claves) {
    return (req, res, next) => {
        if (claves.some(c => puede(req.usuario, c))) return next();
        const nombres = claves.map(c => {
            const m = MODULOS.find(x => x.clave === c);
            return m ? m.nombre : c;
        });
        res.status(403).json({
            error: 'No tienes acceso a ' + nombres.join(' ni a ') +
                '. Pídeselo a quien administra el panel.',
            modulo: claves[0]
        });
    };
}

/* --- Semilla ------------------------------------------------------------
   Crea los cuatro usuarios la PRIMERA vez, y solo si la coleccion esta vacia.
   Nunca toca una base que ya tenga usuarios: si lo hiciera, cada reinicio
   devolveria a la vida una cuenta borrada o le devolveria la clave "1234" a
   quien ya la cambio.                                                        */
async function asegurarSemilla() {
    await coleccion().createIndex({ usuario: 1 }, { unique: true });

    if (await coleccion().countDocuments({}, { limit: 1 })) return { creados: 0 };

    const ahora = new Date().toISOString();
    const docs = USUARIOS_INICIALES.map(u => ({
        usuario: u.usuario,
        nombre: u.nombre,
        // Todos con todo por ahora; el centro de usuarios es donde se recorta.
        modulos: [...CLAVES_MODULOS],
        activo: true,
        clave: hashClave(CLAVE_TEMPORAL),
        debeCambiar: true,
        credencialesDesde: ahora,
        creadoEn: ahora,
        creadoPor: 'sistema',
        actualizadoEn: ahora,
        actualizadoPor: 'sistema',
        ultimoIngreso: null
    }));

    await coleccion().insertMany(docs);
    console.log('[auth] Creados ' + docs.length + ' usuarios con la clave temporal "' +
        CLAVE_TEMPORAL + '": ' + docs.map(d => d.usuario).join(', '));
    return { creados: docs.length };
}

module.exports = {
    MODULOS, CLAVES_MODULOS, MODULO_ADMIN, CLAVE_TEMPORAL, USUARIOS_INICIALES,
    COOKIE, HORAS_SESION,
    iniciar, asegurarSemilla,
    hashClave, verificarClave, validarClave,
    normalizarUsuario, normalizarNombre, normalizarModulos,
    buscar, listar, crear, actualizar, ponerClave, eliminar,
    publico, puede,
    crearToken, ponerCookie, borrarCookie,
    sesionDe, conSesion, conSesionCruda, conModulo, conAlgunModulo,
    bloqueado, fallo, acierto
};
