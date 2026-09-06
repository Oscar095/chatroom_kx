require('dotenv').config();
const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const pedidos = require('./pedidos');
const transportadoras = require('./transportadoras');
const dashboard = require('./dashboard');
const auth = require('./auth');
const auditoria = require('./auditoria');

const app = express();
const PORT = process.env.PORT || 3000;

// En Azure no hay .env: las variables van como Application settings. Sin este
// chequeo, new MongoClient(undefined) revienta con un "Cannot read properties
// of undefined (reading 'startsWith')" que no dice cual falta.
for (const key of ['MONGO_URI', 'MONGO_DB']) {
    if (!process.env[key]) {
        console.error(`Falta la variable de entorno ${key}. En local va en chatroom/.env; en Azure, en Configuration > Application settings.`);
        process.exit(1);
    }
}

const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
    await client.connect();
    db = client.db(process.env.MONGO_DB);
    console.log('Conectado a MongoDB Atlas');

    // Los usuarios y el registro de cambios viven en la misma base. El login
    // depende de Mongo y no de SQL Server a proposito: SQL se conecta de forma
    // perezosa justamente para que pueda estar caido sin tumbar el panel, y si
    // la puerta dependiera de el, esa caida dejaria a todos afuera.
    auth.iniciar(db);
    auditoria.iniciar(db);
    // Crea los cuatro usuarios SOLO si la coleccion esta vacia. Sin esto, un
    // despliegue nuevo en Azure -donde nadie corre los scripts de migracion-
    // quedaria con el panel cerrado y sin forma de abrirlo.
    await auth.asegurarSemilla();
}

// La ventana de servicio al cliente de WhatsApp: Meta solo entrega texto libre
// dentro de las 24 h siguientes al ULTIMO MENSAJE DEL CLIENTE. Pasado ese plazo
// la API no rechaza el envio: responde 200 con un wamid y descarta la entrega en
// silencio (error 131047), que solo se ve por el webhook de estados de mensaje
// — que este panel no escucha. Por eso la ventana se calcula aqui y se bloquea
// antes de mandar: es preferible negar el envio a mostrarle al asesor como
// entregado algo que el cliente nunca recibio.
//
// `contacts.lastSeen` es el reloj porque lo escribe `Guardar Contacto`, que
// cuelga de los tres parsers y por tanto corre en cada mensaje entrante, incluso
// con la conversacion en manual (ahi el agente no corre, pero ese nodo si).
const VENTANA_HORAS = 24;

function ventana24(lastSeen) {
    const t = lastSeen ? new Date(lastSeen).getTime() : NaN;
    // `abierta: null` = no se sabe (contacto sin registro). No se bloquea: hay
    // chats anteriores a la coleccion `contacts` y negarles todo los dejaria
    // inservibles. La UI avisa que el dato falta.
    if (!Number.isFinite(t)) return { abierta: null, horas: null, lastSeen: null };

    const horas = (Date.now() - t) / 36e5;
    return {
        abierta: horas < VENTANA_HORAS,
        horas: Math.round(horas * 10) / 10,
        lastSeen: new Date(t).toISOString()
    };
}

function textoHoras(h) {
    if (h == null) return 'un tiempo que no se conoce';
    return h < 48 ? h.toFixed(1) + ' h' : Math.floor(h / 24) + ' dias';
}

function errorVentana(v, accion) {
    return 'No se puede ' + accion + ': el cliente no escribe hace ' + textoHoras(v.horas) +
        ' y la ventana de 24 h de WhatsApp esta cerrada. Meta aceptaria el mensaje pero no lo ' +
        'entregaria. Hay que esperar a que el cliente escriba, o usar una plantilla aprobada.';
}

// Some historical messages were stored as the raw webhook payload
// (e.g. {"message":"...","sessionId":"...","timestamp":"..."}). Unwrap them.
function cleanContent(raw) {
    if (typeof raw !== 'string') return '';
    const text = raw.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return raw;
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return '';
        if (parsed && typeof parsed === 'object') {
            const value = parsed.message ?? parsed.text ?? parsed.body ?? parsed.content;
            return typeof value === 'string' ? value : '';
        }
    } catch {
        // Not valid JSON - it is real message text that happens to start with a brace
    }
    return raw;
}

// Filter out tool messages and empty AI messages (tool calls)
function filterMessages(messages) {
    return (messages || [])
        .filter(m => m.type !== 'tool')
        .map(m => ({
            type: m.type || 'human',
            // Marcado por /api/send: distingue lo que escribió el asesor de lo
            // que respondió el bot, aunque los dos se guarden como 'ai'.
            sentBy: m.data?.additional_kwargs?.sentBy || null,
            // Y CUAL asesor. Los mensajes anteriores al login no lo traen: ahi
            // queda null y el panel solo dice "asesor", como siempre.
            usuario: m.data?.additional_kwargs?.usuario || null,
            content: cleanContent(m.data?.content)
        }))
        .filter(m => m.content.trim());
}

// phone -> { name, username, email, phoneNumber, lastSeen }
// contacts.phone holds the session identity (see CLAUDE.md), not necessarily a
// phone number - contacts.phoneNumber is the real one, and is empty for the
// Meta contacts that only send a user_id.
async function loadContacts() {
    const map = {};
    try {
        for (const d of await db.collection('contacts').find({}).toArray()) {
            if (d.phone) {
                map[String(d.phone)] = {
                    name: d.name || null,
                    username: d.username || null,
                    email: d.email || null,
                    phoneNumber: d.phoneNumber || null,
                    channel: d.channel || null,
                    lastSeen: d.lastSeen || null
                };
            }
        }
    } catch {}
    return map;
}

// Media the customer sent, oldest first. The base64 payload is deliberately
// excluded - it is served one file at a time by /api/media/:id.
async function loadMedia(sessionId) {
    if (!sessionId) return [];
    try {
        return await db.collection('wa_media')
            .find({ sessionId: String(sessionId) }, { projection: { data: 0 } })
            .sort({ receivedAt: 1 })
            .toArray()
            .then(docs => docs.map(d => ({
                id: d._id.toString(),
                kind: d.kind || 'image',
                mimeType: d.mimeType || 'application/octet-stream',
                fileName: d.fileName || null,
                caption: d.caption || '',
                sizeBytes: d.sizeBytes || 0,
                receivedAt: d.receivedAt || d._id.getTimestamp().toISOString()
            })));
    } catch {
        // Collection does not exist yet on installs that never received an image
        return [];
    }
}

// Las únicas colecciones de chat que las rutas aceptan. Sin esta lista, el
// parámetro ?collection= dejaría leer cualquier colección de la base — entre
// ellas wa_media, que devolvería los base64 completos.
const CHAT_COLLECTIONS = ['wa_chats', 'wa_chats_web'];
function chatCollection(name) {
    return CHAT_COLLECTIONS.includes(name) ? name : CHAT_COLLECTIONS[0];
}

/* --- Pipeline ----------------------------------------------------------
   El embudo de venta. Vive en el MISMO documento del chat, en el subdocumento
   `pipeline`, por la misma razon que `archivedAt` y `mode`: la etapa es un
   estado DE la conversacion, no una entidad aparte. Tres consecuencias que
   son el motivo de la decision:

     1. Toda conversacion nueva entra al tablero sola. Un chat sin `pipeline`
        se lee como `sin_asignar`, asi que no hay nada que sincronizar y no se
        puede perder un cliente por un trabajo que no corrio.
     2. No hay filas huerfanas: si el chat no existe, la tarjeta tampoco.
     3. El tablero sigue en pie aunque SQL Server este caido, a diferencia de
        Pedidos y Transportadoras.

   Como en `archivedAt`, mover una tarjeta NUNCA mueve ni copia el documento:
   escribe campos sueltos con $set. `Guardar Memoria` de n8n sigue haciendo su
   read-modify-write sobre `messages` sin enterarse.

   El orden del arreglo ES el orden de las columnas del tablero. `terminal`
   cierra el ciclo: la tarjeta sale de las columnas activas y se va a su carril
   del extremo. Las claves se guardan en la base, asi que renombrar una obliga
   a migrar los documentos que ya la tengan; el `nombre` en cambio es solo
   rotulo y se puede cambiar sin tocar nada.                                */
const ETAPAS_PIPELINE = [
    { clave: 'sin_asignar', nombre: 'Sin asignar',        terminal: false,
      descripcion: 'Conversaciones que todavia no tomo ningun asesor. Es donde cae todo lo que entra.' },
    { clave: 'en_proceso',  nombre: 'En proceso',         terminal: false,
      descripcion: 'Un asesor la tomo y esta averiguando que necesita el cliente.' },
    { clave: 'cotizacion',  nombre: 'En cotizacion',      terminal: false,
      descripcion: 'Se le paso precio al cliente y se espera su respuesta.' },
    { clave: 'arte',        nombre: 'Aprobacion de arte', terminal: false,
      descripcion: 'El cliente mando el arte o se le envio la prueba; falta el visto bueno.' },
    { clave: 'anticipo',    nombre: 'Anticipo de pago',   terminal: false,
      descripcion: 'Esperando el abono. En personalizados es el 70%.' },
    { clave: 'produccion',  nombre: 'En produccion',      terminal: false,
      descripcion: 'El pedido ya esta en planta.' },
    // `lado` solo aplica a las terminales: dice por que extremo del tablero
    // sale la tarjeta. Lo decide el servidor y no el panel para que la salida
    // no dependa de una clave escrita a mano en index.html.
    { clave: 'despachado',  nombre: 'Despachado',         terminal: true, lado: 'derecha',
      descripcion: 'Entregado al cliente. Cierra el ciclo y sale del tablero.' },
    { clave: 'desiste',     nombre: 'Desistio',           terminal: true, lado: 'izquierda',
      descripcion: 'El cliente no siguio: desistio o rechazo. Cierra el ciclo y sale del tablero.' }
];

const ETAPA_INICIAL = 'sin_asignar';

function etapaDe(clave) {
    return ETAPAS_PIPELINE.find(e => e.clave === clave) || null;
}

// La etapa que se le muestra al panel. Un documento sin `pipeline` y uno con
// `sin_asignar` explicito son lo mismo a proposito: asi entrar al tablero no
// requiere escribir nada, y una etapa que ya no exista en ETAPAS_PIPELINE (porque se
// renombro una clave) no deja la tarjeta invisible, la devuelve al principio.
function pipelineDe(doc) {
    const p = doc.pipeline || {};
    const etapa = etapaDe(p.etapa) ? p.etapa : ETAPA_INICIAL;
    return {
        etapa,
        desde: p.desde || null,
        nota: p.nota || null,
        cerradoEn: etapaDe(etapa).terminal ? (p.cerradoEn || null) : null
    };
}

app.use(express.json());

// Azure sirve el panel por https detras de un proxy y lo anuncia en
// x-forwarded-proto. Sin esto, req.secure siempre seria false y el cookie de
// sesion saldria sin la marca Secure.
app.set('trust proxy', 1);

/* --- La puerta ---------------------------------------------------------
   Hasta aqui el panel estaba abierto para cualquiera que tuviera el enlace.
   Ahora hay dos guardas, y las dos hacen falta:

     1. Esta, sobre los archivos de public/: sin sesion, todo lo que no sea el
        login manda al login. Ademas de la comodidad de no ver el panel vacio
        y despues un error, evita que index.html —con sus 6.000 lineas— llegue
        siquiera al navegador de quien no ha entrado.
     2. La de mas abajo, sobre /api: es la que de verdad protege. Esconder
        botones en el navegador no protege nada, porque la URL de la API se
        puede escribir a mano; el permiso se comprueba en el servidor, ruta
        por ruta, con auth.conModulo().

   La lista es de lo PUBLICO, no de lo protegido, y esa vuelta importa: si
   fuera al reves habria que acordarse de proteger cada archivo nuevo de
   public/, y olvidarlo no da ningun sintoma — el archivo simplemente queda
   servido a cualquiera. Asi, lo que se agregue nace protegido.

   Solo son publicos el login y el logo que muestra: es exactamente lo que ve
   quien todavia no ha entrado.                                              */
const PUBLICOS = new Set(['/login.html', '/logo-kosxpress.jpg', '/favicon.ico']);

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Las de /api tienen su propia guarda mas abajo, con modulos y respuestas
    // JSON; redirigirlas aqui le daria al panel un HTML donde espera datos.
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    // En minusculas porque el sistema de archivos de Windows no distingue
    // mayusculas: sin esto, /INDEX.HTML se serviria sin pasar por aqui.
    if (PUBLICOS.has(req.path.toLowerCase())) return next();

    auth.sesionDe(req)
        .then(u => u ? next() : res.redirect('/login.html'))
        // Con Mongo caido no hay forma de saber quien es: mandar al login es
        // preferible a servir el panel a ciegas.
        .catch(() => res.redirect('/login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

/* --- Entrar y salir ----------------------------------------------------
   Estas cuatro rutas van ANTES de la guarda de /api porque son las unicas que
   tienen que responder sin sesion (o con la sesion a medias de quien todavia
   no ha cambiado la clave temporal). El orden de declaracion es el orden en
   que Express prueba las rutas, asi que moverlas mas abajo las dejaria
   protegidas por la misma guarda que existen para atravesar.               */

// POST /api/auth/login  { usuario, clave }
app.post('/api/auth/login', async (req, res) => {
    try {
        const { usuario, clave } = req.body || {};
        const u = auth.normalizarUsuario(usuario);

        // El mismo mensaje para usuario inexistente y clave errada: decir cual
        // de los dos fallo le regala a quien prueba la mitad del trabajo.
        const negar = () => res.status(401).json({ error: 'Usuario o contrase\u00f1a incorrectos' });
        if (!u || !clave) return negar();

        const espera = auth.bloqueado(u);
        if (espera) {
            return res.status(429).json({
                error: 'Demasiados intentos. Espera ' + espera + ' segundos e intenta de nuevo.'
            });
        }

        const doc = await auth.buscar(u);
        if (!doc || !auth.verificarClave(clave, doc.clave)) {
            auth.fallo(u);
            return negar();
        }
        if (doc.activo === false) {
            return res.status(403).json({
                error: 'Tu usuario est\u00e1 desactivado. P\u00eddele a quien administra el panel que lo active.'
            });
        }

        auth.acierto(u);
        await db.collection('usuarios').updateOne(
            { usuario: u }, { $set: { ultimoIngreso: new Date().toISOString() } });

        auth.ponerCookie(req, res, auth.crearToken(u));
        req.usuario = doc;
        auditoria.registrar(req, 'sesion.entrar', u, {});

        // `debeCambiar` viaja para que el panel abra directo en el cambio de
        // clave. No es solo un aviso: mientras este puesto, la guarda de /api
        // no deja hacer nada mas.
        res.json({ ok: true, usuario: auth.publico(doc), modulos: auth.MODULOS });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/auth/salir
app.post('/api/auth/salir', (req, res) => {
    auth.borrarCookie(req, res);
    res.json({ ok: true });
});

// GET /api/auth/sesion - quien soy y a que tengo acceso.
// La pide el panel al arrancar: es lo que decide que botones se pintan.
app.get('/api/auth/sesion', async (req, res) => {
    try {
        const u = await auth.sesionDe(req);
        if (!u) return res.status(401).json({ error: 'Sesion no iniciada', login: true });
        res.json({ usuario: auth.publico(u), modulos: auth.MODULOS });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/auth/clave  { actual, nueva }
// Cambiar la propia clave. Usa conSesionCruda porque es la unica salida del
// estado `debeCambiar`, y conSesion justamente bloquea ese estado.
app.post('/api/auth/clave', auth.conSesionCruda, async (req, res) => {
    try {
        const { actual, nueva } = req.body || {};
        // Se pide la actual aunque la sesion ya este abierta: sin eso, un equipo
        // que alguien dejo abierto es una cuenta regalada.
        if (!auth.verificarClave(actual, req.usuario.clave)) {
            return res.status(401).json({ error: 'La contrase\u00f1a actual no coincide' });
        }
        const problema = auth.validarClave(nueva);
        if (problema) return res.status(400).json({ error: problema });
        if (auth.verificarClave(nueva, req.usuario.clave)) {
            return res.status(400).json({ error: 'La contrase\u00f1a nueva es igual a la actual' });
        }

        await auth.ponerClave(req.usuario.usuario, nueva, { por: req.usuario.usuario });
        // ponerClave resella `credencialesDesde`, o sea que invalida TODAS las
        // sesiones abiertas - incluida esta. Se emite un cookie nuevo para no
        // echar de la pagina a quien acaba de cambiarla.
        auth.ponerCookie(req, res, auth.crearToken(req.usuario.usuario));
        auditoria.registrar(req, 'sesion.clave', req.usuario.usuario, {});

        const doc = await auth.buscar(req.usuario.usuario);
        res.json({ ok: true, usuario: auth.publico(doc), modulos: auth.MODULOS });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// De aqui en adelante, nada de /api responde sin sesion valida y con la clave
// temporal ya cambiada.
app.use('/api', auth.conSesion);

// GET /api/contacts - phone -> { name, lastSeen }
app.get('/api/contacts', auth.conModulo('conversaciones'), async (req, res) => {
    res.json(await loadContacts());
});

// GET /api/sessions?collection=wa_chats
app.get('/api/sessions', auth.conAlgunModulo(['conversaciones', 'pipeline']), async (req, res) => {
    try {
        const col = chatCollection(req.query.collection);
        const docs = await db.collection(col).find({}).toArray();

        const contacts = await loadContacts();

        const sessions = docs.map(doc => {
            const filtered = filterMessages(doc.messages);
            const lastMsg = filtered.length > 0 ? filtered[filtered.length - 1] : null;
            // sessionId may be null/number/string; the Mongo _id is the only
            // identifier guaranteed to exist and round-trip through the URL.
            const sid = doc.sessionId == null ? null : String(doc.sessionId);
            const contact = sid ? contacts[sid] : null;
            const lastSeen = contact ? contact.lastSeen : null;

            // Archiving is a flag on the chat document, never a move: the
            // LangChain memory node keeps $push-ing into the same doc, so a
            // moved conversation would make the bot lose the customer's history.
            // If the customer writes again after being archived, the chat goes
            // back to the inbox on its own - the conversation clearly did not end.
            const archivedAt = doc.archivedAt || null;
            const reopened = !!(archivedAt && lastSeen &&
                new Date(lastSeen) > new Date(archivedAt));

            return {
                id: doc._id.toString(),
                sessionId: sid,
                name: contact ? contact.name : null,
                username: contact ? contact.username : null,
                collection: col,
                archived: !!archivedAt && !reopened,
                archivedAt,
                reopened,
                mode: doc.mode === 'manual' ? 'manual' : 'auto',
                // The chat memory stores no per-message timestamps. The ObjectId
                // gives the conversation start; contacts.lastSeen the last message.
                startedAt: doc._id.getTimestamp().toISOString(),
                lastSeen,
                messageCount: filtered.length,
                lastMessage: lastMsg ? lastMsg.content : '',
                lastType: lastMsg ? lastMsg.type : '',
                // El tablero del Pipeline se arma con ESTA respuesta y no con
                // una ruta propia: asi comparte el cache y el refresco de la
                // bandeja, y una conversacion nueva aparece en el tablero por
                // el solo hecho de existir, sin ingesta que pueda fallar.
                pipeline: pipelineDe(doc)
            };
        });

        // Most recent activity first
        sessions.sort((a, b) =>
            new Date(b.lastSeen || b.startedAt) - new Date(a.lastSeen || a.startedAt));
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- Latido de la bandeja ----------------------------------------------
   El asesor deja el panel abierto en una pestana de fondo todo el dia, asi
   que el panel tiene que preguntar seguido si entro algo. Preguntarlo con
   /api/sessions seria bajarse las dos colecciones enteras cada vez; esta ruta
   devuelve un pulso de ~50 bytes y el panel solo pide la lista completa
   CUANDO EL PULSO CAMBIA. Esa es la diferencia entre poder preguntar cada 15
   segundos y no poder.

   El pulso sale de `contacts` y no de los chats por dos razones: son
   documentos de ~200 bytes contra conversaciones de ~9 KB, y `lastSeen` lo
   escriben `Guardar Contacto` y `Guardar Contacto Web` en CADA mensaje
   entrante de los dos canales — el mismo reloj que ya usa la ventana de 24 h.
   Una conversacion nueva tambien mueve el pulso, porque agrega un contacto.

   Si `Guardar Contacto` dejara de correr en cada mensaje, este latido se
   congelaria y el aviso dejaria de sonar. La red de seguridad es el refresco
   completo de 5 minutos del panel, que no depende de esta ruta.

   EL PULSO NO ES LA FECHA MAS RECIENTE, ES LA SUMA DE TODAS. Parece rebuscado
   y no lo es: en `contacts` conviven dos formatos de `lastSeen` —45 con
   desfase (`...-05:00`) y 9 en UTC (`...Z`)—, y comparados COMO TEXTO el orden
   no es el cronologico. Con un `$max` de cadenas, un mensaje nuevo guardado
   como `14:00-05:00` no superaria a un `18:00Z` mas viejo, el pulso no se
   moveria y el aviso no sonaria: justo el fallo silencioso que este panel no
   se puede permitir. `$convert` entiende los dos formatos, y como `lastSeen`
   solo avanza, la suma de los milisegundos solo puede crecer. Un contacto
   nuevo mueve ademas el conteo.

   El costo es O(numero de contactos) y hoy son 54, asi que el latido tarda
   ~80 ms y responde 40 bytes. Si algun dia son decenas de miles, esto hay que
   cambiarlo por una marca de agua indexada, no por subir LATIDO_MS.        */
app.get('/api/latido', auth.conAlgunModulo(['conversaciones', 'pipeline']), async (req, res) => {
    try {
        const [r] = await db.collection('contacts').aggregate([
            { $group: {
                _id: null,
                n: { $sum: 1 },
                suma: { $sum: { $toLong: { $ifNull: [
                    { $convert: { input: '$lastSeen', to: 'date', onError: null, onNull: null } },
                    new Date(0)
                ] } } }
            } }
        ]).toArray();
        res.json({ pulso: r ? r.n + '@' + r.suma : '0@0' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/messages?collection=wa_chats&id=<mongo _id>
// Falls back to sessionId lookup for older callers.
app.get('/api/messages', auth.conModulo('conversaciones'), async (req, res) => {
    try {
        const col = chatCollection(req.query.collection);
        const { id, sessionId } = req.query;

        let doc = null;
        if (id && ObjectId.isValid(id)) {
            doc = await db.collection(col).findOne({ _id: new ObjectId(id) });
        } else if (sessionId != null) {
            // sessionId is a number in wa_chats but a string in wa_chats_web
            const query = /^\d+$/.test(sessionId)
                ? { $or: [{ sessionId }, { sessionId: Number(sessionId) }] }
                : { sessionId };
            doc = await db.collection(col).findOne(query);
        }
        if (!doc) return res.json({ sessionId: null, name: null, messages: [] });

        const sid = doc.sessionId == null ? null : String(doc.sessionId);
        const contact = sid ? (await loadContacts())[sid] : null;

        res.json({
            sessionId: sid,
            name: contact ? contact.name : null,
            username: contact ? contact.username : null,
            email: contact ? contact.email : null,
            phoneNumber: contact ? contact.phoneNumber : null,
            startedAt: doc._id.getTimestamp().toISOString(),
            lastSeen: contact ? contact.lastSeen : null,
            // El panel apaga el boton de Manual y el compositor con esto.
            ventana: ventana24(contact ? contact.lastSeen : null),
            archivedAt: doc.archivedAt || null,
            mode: doc.mode === 'manual' ? 'manual' : 'auto',
            messages: filterMessages(doc.messages),
            media: await loadMedia(sid)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/media/:id - the file itself. `?download=1` forces a save dialog
// instead of rendering inline.
app.get('/api/media/:id', auth.conModulo('conversaciones'), async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'id invalido' });

        const doc = await db.collection('wa_media').findOne({ _id: new ObjectId(id) });
        if (!doc || !doc.data) return res.status(404).json({ error: 'No encontrado' });

        // n8n stores the WhatsApp binary base64-encoded inside the document.
        const buffer = Buffer.from(doc.data, 'base64');
        const ext = (doc.mimeType || '').split('/')[1] || 'bin';
        const name = doc.fileName || `arte-${id}.${ext.split(';')[0]}`;

        res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader(
            'Content-Disposition',
            `${req.query.download ? 'attachment' : 'inline'}; filename="${name.replace(/"/g, '')}"`
        );
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/archive  { collection, id, archived }
// Marca la conversación como archivada escribiendo `archivedAt` en el documento.
// Es la única ruta que escribe en Atlas: no mueve ni borra nada, así que se
// puede deshacer y el bot no pierde la memoria de ese cliente.
app.post('/api/archive', auth.conModulo('conversaciones'), async (req, res) => {
    try {
        const { collection, id, archived } = req.body || {};
        if (!CHAT_COLLECTIONS.includes(collection)) {
            return res.status(400).json({ error: 'coleccion invalida' });
        }
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'id invalido' });

        const archivar = archived !== false;
        const result = await db.collection(collection).updateOne(
            { _id: new ObjectId(id) },
            archivar
                // `archivadoPor` es el equivalente en Mongo de la columna
                // `usuario` de las tablas de SQL: quien dejo la conversacion
                // asi. Va como campo suelto con $set, igual que archivedAt, y
                // por la misma razon (ver el comentario de la ruta).
                ? { $set: { archivedAt: new Date().toISOString(), archivadoPor: req.usuario.usuario } }
                : { $unset: { archivedAt: '', archivadoPor: '' } }
        );
        if (!result.matchedCount) return res.status(404).json({ error: 'No encontrado' });

        auditoria.registrar(req, archivar ? 'chat.archivar' : 'chat.desarchivar',
            collection + '/' + id, {});

        res.json({ ok: true, archived: archivar });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/contacts/list - la agenda completa, un registro por contacto con
// todo lo que se sabe de él y el enlace a su conversación.
app.get('/api/contacts/list', auth.conModulo('contactos'), async (req, res) => {
    try {
        const docs = await db.collection('contacts').find({}).toArray();

        // sessionId -> chat, para poder abrir la conversación desde la agenda.
        const chats = {};
        for (const col of CHAT_COLLECTIONS) {
            const found = await db.collection(col)
                .find({}, { projection: { sessionId: 1, messages: 1, archivedAt: 1 } })
                .toArray();
            for (const d of found) {
                const sid = d.sessionId == null ? null : String(d.sessionId);
                if (!sid) continue;
                chats[sid] = {
                    id: d._id.toString(),
                    collection: col,
                    messageCount: filterMessages(d.messages).length,
                    archived: !!d.archivedAt
                };
            }
        }

        // Cuántos archivos mandó cada contacto, para saber de un vistazo quién
        // envió arte sin tener que abrir la conversación.
        const media = {};
        try {
            const grouped = await db.collection('wa_media')
                .aggregate([{ $group: { _id: '$sessionId', n: { $sum: 1 } } }]).toArray();
            for (const g of grouped) media[String(g._id)] = g.n;
        } catch {
            // La colección no existe hasta que llega la primera imagen
        }

        const list = docs.map(d => {
            const phone = String(d.phone);
            const chat = chats[phone] || null;
            return {
                id: d._id.toString(),
                // Ojo: `phone` es la identidad de sesión, no un teléfono.
                // El número real del cliente es phoneNumber (ver CLAUDE.md).
                phone,
                name: d.name || null,
                email: d.email || null,
                phoneNumber: d.phoneNumber || null,
                username: d.username || null,
                businessPhone: d.businessPhone || null,
                // Los contactos guardados antes de que existiera `channel` no
                // lo traen; se deduce de en qué colección está su conversación.
                channel: d.channel ||
                    (chat ? (chat.collection === 'wa_chats_web' ? 'web' : 'whatsapp') : null),
                lastSeen: d.lastSeen || null,
                createdAt: d._id.getTimestamp().toISOString(),
                chat,
                mediaCount: media[phone] || 0
            };
        });

        // Alfabético por nombre; los que aún no tienen nombre, al final.
        list.sort((a, b) =>
            (a.name || '￿').localeCompare(b.name || '￿', 'es', { sensitivity: 'base' }));
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/mode  { collection, id, mode }
// 'manual' hace que el bot deje de responderle a ese cliente; 'auto' lo devuelve.
// Lo lee el nodo "¿Modo Manual?" del workflow teams_chat_bot.
app.post('/api/mode', auth.conModulo('conversaciones'), async (req, res) => {
    try {
        const { collection, id, mode } = req.body || {};
        if (!CHAT_COLLECTIONS.includes(collection)) {
            return res.status(400).json({ error: 'coleccion invalida' });
        }
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'id invalido' });
        if (mode !== 'manual' && mode !== 'auto') {
            return res.status(400).json({ error: 'mode debe ser manual o auto' });
        }
        // El widget web es petición/respuesta: si el bot no contesta, el visitante
        // se queda esperando y no hay forma de escribirle después.
        if (collection === 'wa_chats_web') {
            return res.status(400).json({ error: 'el chat web no admite modo manual' });
        }

        const doc = await db.collection(collection).findOne({ _id: new ObjectId(id) });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });

        // Tomar la conversacion con la ventana vencida no sirve de nada: el bot
        // se calla y el asesor tampoco puede escribir, asi que el cliente se
        // queda sin nadie. Volver a automatico siempre se permite.
        const sid = doc.sessionId == null ? null : String(doc.sessionId);
        const contact = sid ? (await loadContacts())[sid] : null;
        const ventana = ventana24(contact ? contact.lastSeen : null);

        if (mode === 'manual' && ventana.abierta === false) {
            return res.status(409).json({
                error: errorVentana(ventana, 'poner la conversacion en Manual'),
                ventana
            });
        }

        await db.collection(collection).updateOne(
            { _id: new ObjectId(id) },
            mode === 'manual'
                ? { $set: { mode: 'manual', manualSince: new Date().toISOString(),
                            modoPor: req.usuario.usuario } }
                // `modoPor` NO se borra al volver a automatico: la pregunta que
                // responde es "quien movio esto de ultimas", y devolver el chat
                // al bot es tan cambio como quitarselo.
                : { $unset: { mode: '', manualSince: '' },
                    $set: { modoPor: req.usuario.usuario } }
        );

        auditoria.registrar(req, 'chat.modo', collection + '/' + id, { modo: mode });

        res.json({ ok: true, mode, ventana });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/send  { collection, id, text }
// Manda el mensaje del asesor a n8n (que lo entrega por WhatsApp) y solo si
// Meta lo aceptó lo agrega a la memoria del chat. El orden importa: si se
// guardara primero, el panel mostraría mensajes que el cliente nunca recibió.
app.post('/api/send', auth.conModulo('conversaciones'), async (req, res) => {
    try {
        const { collection, id, text } = req.body || {};
        if (!CHAT_COLLECTIONS.includes(collection)) {
            return res.status(400).json({ error: 'coleccion invalida' });
        }
        if (collection === 'wa_chats_web') {
            return res.status(400).json({ error: 'no se puede escribirle al chat web' });
        }
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'id invalido' });

        const cuerpo = String(text || '').trim();
        if (!cuerpo) return res.status(400).json({ error: 'el mensaje esta vacio' });
        // Tope de la API de WhatsApp para mensajes de texto.
        if (cuerpo.length > 4096) return res.status(400).json({ error: 'el mensaje supera 4096 caracteres' });

        if (!process.env.N8N_SEND_URL || !process.env.N8N_SEND_TOKEN) {
            return res.status(503).json({ error: 'falta N8N_SEND_URL o N8N_SEND_TOKEN en el .env' });
        }

        const doc = await db.collection(collection).findOne({ _id: new ObjectId(id) });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        if (doc.sessionId == null) {
            return res.status(400).json({ error: 'esta conversacion no tiene identidad, no se le puede escribir' });
        }
        if (doc.mode !== 'manual') {
            return res.status(409).json({ error: 'pon la conversacion en Manual antes de escribir' });
        }

        // Se revisa aqui tambien, y no solo al activar Manual, porque la ventana
        // puede vencerse con la conversacion ya tomada. Sin esta guarda el
        // mensaje se guardaria como enviado y el cliente nunca lo recibiria.
        const contacto = (await loadContacts())[String(doc.sessionId)];
        const ventana = ventana24(contacto ? contacto.lastSeen : null);
        if (ventana.abierta === false) {
            return res.status(409).json({ error: errorVentana(ventana, 'enviar'), ventana });
        }

        let respuesta;
        try {
            const r = await fetch(process.env.N8N_SEND_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-chatroom-token': process.env.N8N_SEND_TOKEN
                },
                body: JSON.stringify({ to: String(doc.sessionId), text: cuerpo }),
                signal: AbortSignal.timeout(20000)
            });
            respuesta = await r.json().catch(() => ({}));
            if (!r.ok) {
                return res.status(502).json({ error: respuesta.error || 'n8n respondio ' + r.status });
            }
        } catch (err) {
            return res.status(502).json({ error: 'no se pudo contactar n8n: ' + err.message });
        }

        if (!respuesta.ok) {
            // Lo más común aquí es la ventana de 24 h de Meta ya vencida.
            return res.status(502).json({ error: respuesta.error || 'WhatsApp no acepto el mensaje' });
        }

        // Se guarda como 'ai' porque desde el lado del cliente es el negocio
        // quien habla; así el bot lo lee como propio al volver a automático.
        await db.collection(collection).updateOne(
            { _id: new ObjectId(id) },
            {
                $push: {
                    messages: {
                        type: 'ai',
                        data: {
                            content: cuerpo,
                            tool_calls: [],
                            invalid_tool_calls: [],
                            // `usuario` va al lado de `sentBy` y no lo
                            // reemplaza: el bot lee esta memoria y `sentBy`
                            // es lo que ya distingue al asesor del agente.
                            additional_kwargs: { sentBy: 'asesor', usuario: req.usuario.usuario },
                            response_metadata: {}
                        }
                    }
                }
            }
        );

        // Se registra despues del $push, no antes: lo que se audita es el
        // mensaje que quedo guardado, no el que se intento mandar.
        auditoria.registrar(req, 'chat.enviar', collection + '/' + id, {
            wamid: respuesta.id || null,
            // Un extracto alcanza para reconocer el mensaje en el registro sin
            // duplicar la conversacion entera en otra coleccion.
            texto: cuerpo.slice(0, 120)
        });

        res.json({ ok: true, id: respuesta.id || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- Pipeline ----------------------------------------------------------
   Dos rutas de escritura sobre el subdocumento `pipeline` del chat. Las dos
   escriben campos sueltos con $set/$push, nunca el documento entero: el
   documento tambien lo escribe `Guardar Memoria` de n8n.                   */

// GET /api/pipeline/etapas - el catalogo, en el orden de las columnas.
// El panel lo pide una vez y pinta el tablero con lo que venga: la lista
// vive AQUI y no en index.html para que la validacion de /mover y las
// columnas que se dibujan no puedan desincronizarse.
app.get('/api/pipeline/etapas', auth.conModulo('pipeline'), (req, res) => {
    res.json(ETAPAS_PIPELINE);
});

// POST /api/pipeline/mover  { collection, id, etapa }
// Mueve la tarjeta de etapa. `desde` se resella en cada movimiento porque es
// lo que responde "cuanto lleva parada aqui", que es la pregunta que se le
// hace a un embudo; el historial guarda el recorrido completo.
app.post('/api/pipeline/mover', auth.conModulo('pipeline'), async (req, res) => {
    try {
        const { collection, id, etapa } = req.body || {};
        if (!CHAT_COLLECTIONS.includes(collection)) {
            return res.status(400).json({ error: 'coleccion invalida' });
        }
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'id invalido' });

        const destino = etapaDe(etapa);
        if (!destino) {
            return res.status(400).json({
                error: 'etapa desconocida: ' + etapa + '. Las validas son ' +
                    ETAPAS_PIPELINE.map(e => e.clave).join(', ')
            });
        }

        const doc = await db.collection(collection).findOne({ _id: new ObjectId(id) });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });

        const anterior = pipelineDe(doc).etapa;
        if (anterior === destino.clave) {
            // Soltar la tarjeta en su propia columna no es un error, pero
            // tampoco puede resellar `desde`: eso rejuveneceria una tarjeta
            // estancada cada vez que alguien la arrastra sin querer.
            return res.json({ ok: true, etapa: anterior, sinCambio: true });
        }

        const ahora = new Date().toISOString();
        const cambio = {
            $set: {
                'pipeline.etapa': destino.clave,
                'pipeline.desde': ahora,
                'pipeline.actualizadoEn': ahora,
                'pipeline.por': req.usuario.usuario
            },
            // Acotado a los ultimos 50: el historial es para entender una
            // negociacion, no un log, y este documento ya carga la memoria
            // completa del bot.
            $push: {
                'pipeline.historial': {
                    // El usuario entra en cada entrada del historial y no solo
                    // en `pipeline.por`: ese campo dice quien la movio de
                    // ultimas, y lo que se quiere saber de una negociacion es
                    // quien la movio en CADA paso.
                    $each: [{ etapa: destino.clave, desde: anterior, en: ahora,
                              usuario: req.usuario.usuario }],
                    $slice: -50
                }
            }
        };
        // El sello de cierre solo existe en las etapas terminales. Reabrir una
        // tarjeta tiene que borrarlo: si no, quedaria cerrada y viva a la vez.
        if (destino.terminal) cambio.$set['pipeline.cerradoEn'] = ahora;
        else cambio.$unset = { 'pipeline.cerradoEn': '' };

        await db.collection(collection).updateOne({ _id: new ObjectId(id) }, cambio);

        auditoria.registrar(req, 'pipeline.mover', collection + '/' + id,
            { de: anterior, a: destino.clave });

        res.json({
            ok: true,
            etapa: destino.clave,
            anterior,
            desde: ahora,
            terminal: destino.terminal,
            cerradoEn: destino.terminal ? ahora : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/pipeline/nota  { collection, id, nota }
// La unica anotacion del asesor sobre la tarjeta. Sin ella el tablero pierde
// el POR QUE cada vez que algo se mueve: la etapa dice donde esta el cliente,
// la nota dice que se esta esperando. Vacia borra.
app.post('/api/pipeline/nota', auth.conModulo('pipeline'), async (req, res) => {
    try {
        const { collection, id, nota } = req.body || {};
        if (!CHAT_COLLECTIONS.includes(collection)) {
            return res.status(400).json({ error: 'coleccion invalida' });
        }
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'id invalido' });

        const texto = String(nota == null ? '' : nota).trim();
        if (texto.length > 280) {
            return res.status(400).json({ error: 'la nota supera 280 caracteres' });
        }

        const ahora = new Date().toISOString();
        const result = await db.collection(collection).updateOne(
            { _id: new ObjectId(id) },
            texto
                ? { $set: { 'pipeline.nota': texto, 'pipeline.actualizadoEn': ahora,
                            'pipeline.notaPor': req.usuario.usuario } }
                : { $unset: { 'pipeline.nota': '' },
                    $set: { 'pipeline.actualizadoEn': ahora,
                            'pipeline.notaPor': req.usuario.usuario } }
        );
        if (!result.matchedCount) return res.status(404).json({ error: 'No encontrado' });

        auditoria.registrar(req, texto ? 'pipeline.nota' : 'pipeline.nota.borrar',
            collection + '/' + id, { nota: texto.slice(0, 120) });

        res.json({ ok: true, nota: texto || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- Dashboard ---------------------------------------------------------
   Los indicadores. El calculo esta en dashboard.js, que es una funcion pura;
   aqui solo se leen los datos y se le pasan.                               */

// GET /api/dashboard?dias=90   (dias=0 -> todo el historico)
//
// Las conversaciones se leen ENTERAS, como en /api/sessions, porque el conteo
// de mensajes tiene que salir de filterMessages() y no de messages.length: la
// memoria del agente guarda tambien su tracing, y contarlo inflaria cada
// indicador de volumen. Con el tamano actual de la base (decenas de
// conversaciones) es despreciable; si algun dia son miles, lo que hay que
// cambiar es esto — un $project con $filter en Mongo — y no el modulo de
// calculo, que ya recibe solo numeros.
app.get('/api/dashboard', auth.conModulo('dashboard'), async (req, res) => {
    try {
        const dias = Math.min(3650, Math.max(0, Number(req.query.dias) || 0)) || 90;

        const contactos = await loadContacts();

        // Cuantos archivos mando cada sesion. La coleccion no existe hasta que
        // llega la primera imagen, y eso no puede tumbar el dashboard.
        const archivos = {};
        try {
            const g = await db.collection('wa_media')
                .aggregate([{ $group: { _id: '$sessionId', n: { $sum: 1 } } }]).toArray();
            for (const x of g) archivos[String(x._id)] = x.n;
        } catch {}

        const chats = [];
        for (const col of CHAT_COLLECTIONS) {
            for (const doc of await db.collection(col).find({}).toArray()) {
                const sid = doc.sessionId == null ? null : String(doc.sessionId);
                const contacto = sid ? contactos[sid] : null;
                const msgs = filterMessages(doc.messages);
                const p = pipelineDe(doc);
                chats.push({
                    id: doc._id.toString(),
                    collection: col,
                    sessionId: sid,
                    nombre: contacto ? contacto.name : null,
                    // El ObjectId marca cuando entro la conversacion: es la
                    // fecha de nacimiento del lead, y la unica que hay (la
                    // memoria de LangChain no sella los mensajes uno por uno).
                    startedAt: doc._id.getTimestamp().toISOString(),
                    lastSeen: contacto ? contacto.lastSeen : null,
                    archivada: !!doc.archivedAt,
                    modo: doc.mode === 'manual' ? 'manual' : 'auto',
                    etapa: p.etapa,
                    etapaDesde: p.desde,
                    historial: (doc.pipeline && doc.pipeline.historial) || [],
                    mensajes: msgs.length,
                    delCliente: msgs.filter(m => m.type === 'human').length,
                    ultimoTipo: msgs.length ? msgs[msgs.length - 1].type : null,
                    archivos: sid ? (archivos[sid] || 0) : 0
                });
            }
        }

        const datos = dashboard.resumen({ chats, etapas: ETAPAS_PIPELINE, dias });

        // Los pedidos van aparte y en su propio try: SQL Server es perezoso y
        // puede estar caido o con la IP fuera del firewall, y eso no puede
        // dejar sin indicadores a la parte que si vive en Mongo. El panel
        // pinta el bloque de pedidos con el error dentro.
        let pedidosResumen = null, pedidosError = null;
        try {
            pedidosResumen = await pedidos.resumen();
        } catch (err) {
            pedidosError = err.message;
        }

        res.json({ ...datos, pedidos: pedidosResumen, pedidosError });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- Pedidos -----------------------------------------------------------
   Lo único del panel que no vive en MongoDB: los pedidos vienen de la API de
   Siesa y se guardan en SQL Server. La conexión es perezosa, así que si SQL
   está caído el resto del panel sigue funcionando.                        */

// GET /api/pedidos?todos=1&sinDespachar=1
app.get('/api/pedidos', auth.conModulo('pedidos'), async (req, res) => {
    try {
        res.json(await pedidos.listar({
            soloPendientes: req.query.todos !== '1',
            incluirDespachados: req.query.sinDespachar !== '1'
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/pedidos/sincronizar - trae de Siesa y refleja en SQL
app.post('/api/pedidos/sincronizar', auth.conModulo('pedidos'), async (req, res) => {
    try {
        const r = await pedidos.sincronizar();
        auditoria.registrar(req, 'pedidos.sincronizar', null, r);
        res.json({ ok: true, ...r });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// POST /api/pedidos/actualizar
//   { idTipoDocto, consecDocto, impresion, formacion, bodega, despachado, noGuia, contacto }
// Solo toca las columnas del asesor; lo que viene de Siesa no se edita. Las
// etapas se leen desde `pedidos.ETAPAS` para que agregar una sea un solo cambio
// (esa lista, el DDL y la tabla del panel) y no haya que acordarse de esta ruta.
app.post('/api/pedidos/actualizar', auth.conModulo('pedidos'), async (req, res) => {
    try {
        const cuerpo = req.body || {};
        const { idTipoDocto, consecDocto, noGuia, contacto } = cuerpo;
        if (!idTipoDocto || !Number.isFinite(Number(consecDocto))) {
            return res.status(400).json({ error: 'falta idTipoDocto o consecDocto' });
        }

        const cambio = {};
        for (const etapa of pedidos.ETAPAS) {
            if (cuerpo[etapa] !== undefined) cambio[etapa] = !!cuerpo[etapa];
        }

        if (!Object.keys(cambio).length && noGuia === undefined && contacto === undefined) {
            return res.status(400).json({ error: 'no hay nada que actualizar' });
        }
        if (noGuia !== undefined && noGuia !== null && String(noGuia).length > 100) {
            return res.status(400).json({ error: 'el numero de guia supera 100 caracteres' });
        }

        if (noGuia !== undefined) cambio.noGuia = noGuia;

        if (contacto !== undefined) {
            const vacio = contacto === null || String(contacto).trim() === '';
            // Se valida al guardar y no al enviar: un numero mal escrito que
            // solo falla al final deja al asesor creyendo que ya avisó.
            const normalizado = vacio ? null : pedidos.normalizarCelular(contacto);
            if (!vacio && !normalizado) {
                return res.status(400).json({
                    error: 'el celular no es valido: se espera un movil colombiano, como 3235663950'
                });
            }
            cambio.contacto = normalizado;
        }

        const ok = await pedidos.actualizar(String(idTipoDocto), Number(consecDocto), cambio,
            req.usuario.usuario);
        if (!ok) return res.status(404).json({ error: 'pedido no encontrado' });

        auditoria.registrar(req, 'pedidos.actualizar',
            idTipoDocto + '-' + consecDocto, cambio);
        // Se devuelve el celular ya normalizado para que el panel muestre lo que
        // realmente quedó guardado y no lo que el asesor tecleó.
        res.json(contacto !== undefined ? { ok: true, contacto: cambio.contacto } : { ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// La URL de rastreo de TCC es provisional y por eso viaja como PARAMETRO de la
// plantilla, no dentro de ella: cambiarla es tocar el .env, mientras que si
// estuviera en el texto aprobado habria que volver a pasar por revision de Meta.
function urlRastreo(guia) {
    const base = process.env.TCC_RASTREO_URL || 'https://www.tcc.com/rastreo/?{guia}';
    return base.includes('{guia}')
        ? base.replace('{guia}', encodeURIComponent(guia))
        : base + encodeURIComponent(guia);
}

// La plantilla tiene encabezado con imagen, y Meta exige la imagen en CADA
// envio: la que se sube al crear la plantilla es solo la muestra para la
// revision. Sin esto responde 132012 "Parameter format does not match".
// Tiene que ser una URL publica (Meta la descarga), PNG o JPEG, maximo 5 MB, y
// SIN token SAS: un SAS caduca, y el dia que venza todos los avisos fallan.
function imagenEncabezado() {
    return process.env.KOSKI_IMAGEN_URL ||
        'https://datalakekos.blob.core.windows.net/images/products/1786723667985-cbcawm-ICONO%20DESPACHOS.png';
}

// POST /api/pedidos/notificar  { idTipoDocto, consecDocto, reenviar }
// Le avisa al cliente que su pedido salio. Va por PLANTILLA aprobada y no por
// texto libre: el cliente casi nunca tiene conversacion abierta, y fuera de la
// ventana de 24 h Meta acepta el texto y lo descarta sin avisar (ver /api/send).
app.post('/api/pedidos/notificar', auth.conModulo('pedidos'), async (req, res) => {
    try {
        const { idTipoDocto, consecDocto, reenviar } = req.body || {};
        if (!idTipoDocto || !Number.isFinite(Number(consecDocto))) {
            return res.status(400).json({ error: 'falta idTipoDocto o consecDocto' });
        }
        if (!process.env.N8N_DESPACHO_URL || !process.env.N8N_SEND_TOKEN) {
            return res.status(503).json({ error: 'falta N8N_DESPACHO_URL o N8N_SEND_TOKEN en el .env' });
        }

        // Se relee de SQL en vez de confiar en lo que manda el panel: el aviso
        // le cuesta plata a KOS y le llega a un cliente, asi que la guia y el
        // destinatario salen de la base, no del navegador.
        const p = await pedidos.obtener(String(idTipoDocto), Number(consecDocto));
        if (!p) return res.status(404).json({ error: 'pedido no encontrado' });

        if (!p.contacto) {
            return res.status(400).json({ error: 'el pedido no tiene celular de contacto' });
        }
        if (!p.noGuia) {
            return res.status(400).json({ error: 'el pedido no tiene numero de guia' });
        }
        // El mensaje afirma que el pedido va en camino. Si no esta despachado,
        // seria mentira, y una mentira que el cliente puede verificar.
        if (!p.despachado) {
            return res.status(409).json({ error: 'marca el pedido como despachado antes de avisarle al cliente' });
        }
        if (p.notificadoEn && !reenviar) {
            return res.status(409).json({
                error: 'a este pedido ya se le aviso el ' + new Date(p.notificadoEn).toLocaleString('es-CO'),
                yaNotificado: true
            });
        }

        let respuesta;
        try {
            const r = await fetch(process.env.N8N_DESPACHO_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-chatroom-token': process.env.N8N_SEND_TOKEN
                },
                body: JSON.stringify({
                    to: p.contacto,
                    guia: p.noGuia,
                    url: urlRastreo(p.noGuia),
                    imagen: imagenEncabezado(),
                    pedido: p.id
                }),
                signal: AbortSignal.timeout(20000)
            });
            respuesta = await r.json().catch(() => ({}));
            if (!r.ok) {
                return res.status(502).json({ error: respuesta.error || 'n8n respondio ' + r.status });
            }
        } catch (err) {
            return res.status(502).json({ error: 'no se pudo contactar n8n: ' + err.message });
        }

        if (!respuesta.ok) {
            return res.status(502).json({ error: respuesta.error || 'WhatsApp no acepto el aviso' });
        }

        // Se sella solo despues de que Meta acepto, igual que en /api/send.
        await pedidos.marcarNotificado(String(idTipoDocto), Number(consecDocto), respuesta.id,
            req.usuario.usuario);

        auditoria.registrar(req, 'pedidos.notificar', p.id,
            { contacto: p.contacto, guia: p.noGuia, wamid: respuesta.id || null,
              reenvio: !!reenviar });

        res.json({ ok: true, id: respuesta.id, notificadoEn: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- Transportadoras ---------------------------------------------------
   Directorio que llena el asesor a mano: nombre + pagina de rastreo. Vive en
   SQL Server junto a los pedidos y no en Mongo, y comparte su conexion
   perezosa: si SQL esta caido, el resto del panel sigue en pie.

   La URL se guarda tal cual se escribio, con su marcador {guia} si lo lleva.
   Es el mismo convenio de TCC_RASTREO_URL, para que el dia que el aviso de
   despacho deje de estar clavado en TCC pueda salir de esta tabla.         */

// GET /api/transportadoras
app.get('/api/transportadoras', auth.conModulo('transportadoras'), async (req, res) => {
    try {
        res.json(await transportadoras.listar());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/transportadoras/guardar  { id?, nombre, urlRastreo }
// Sin `id` crea; con `id` actualiza solo los campos que lleguen.
app.post('/api/transportadoras/guardar', auth.conModulo('transportadoras'), async (req, res) => {
    try {
        const { id, nombre, urlRastreo } = req.body || {};
        const editar = id !== undefined && id !== null && String(id).trim() !== '';
        if (editar && !Number.isFinite(Number(id))) {
            return res.status(400).json({ error: 'el id no es valido' });
        }

        const cambio = {};
        if (nombre !== undefined) {
            const n = transportadoras.normalizarNombre(nombre);
            if (!n) return res.status(400).json({ error: 'la transportadora necesita un nombre' });
            if (n.length > 120) return res.status(400).json({ error: 'el nombre supera 120 caracteres' });
            cambio.nombre = n;
        }
        if (urlRastreo !== undefined) {
            // Se valida al guardar y no cuando alguien haga clic: una URL rota
            // que solo falla al usarla deja al asesor creyendo que quedo bien.
            const u = transportadoras.normalizarUrl(urlRastreo);
            if (!u) {
                return res.status(400).json({
                    error: 'la URL de rastreo no es valida: debe empezar por http:// o https://'
                });
            }
            if (u.length > 500) return res.status(400).json({ error: 'la URL supera 500 caracteres' });
            cambio.urlRastreo = u;
        }

        if (!editar && (!cambio.nombre || !cambio.urlRastreo)) {
            return res.status(400).json({ error: 'falta el nombre o la URL de rastreo' });
        }
        if (editar && !Object.keys(cambio).length) {
            return res.status(400).json({ error: 'no hay nada que actualizar' });
        }

        const t = editar
            ? await transportadoras.actualizar(Number(id), cambio, req.usuario.usuario)
            : await transportadoras.crear(cambio, req.usuario.usuario);
        if (!t) return res.status(404).json({ error: 'transportadora no encontrada' });

        auditoria.registrar(req, editar ? 'transportadoras.editar' : 'transportadoras.crear',
            t.nombre, cambio);

        // Se devuelve la fila guardada, no lo que mando el panel: asi el id de
        // una recien creada vuelve al navegador y la fila queda editable.
        res.json({ ok: true, transportadora: t });
    } catch (err) {
        if (transportadoras.esNombreDuplicado(err)) {
            return res.status(409).json({ error: 'ya hay una transportadora con ese nombre' });
        }
        res.status(500).json({ error: err.message });
    }
});

// POST /api/transportadoras/eliminar  { id }
app.post('/api/transportadoras/eliminar', auth.conModulo('transportadoras'), async (req, res) => {
    try {
        const { id } = req.body || {};
        if (!Number.isFinite(Number(id))) return res.status(400).json({ error: 'falta el id' });

        const ok = await transportadoras.eliminar(Number(id));
        if (!ok) return res.status(404).json({ error: 'transportadora no encontrada' });

        // Aqui la fila se borra de verdad, asi que el registro de cambios es lo
        // unico que queda de ella: sin esta linea, una transportadora
        // desaparecida no tendria ni fecha ni responsable.
        auditoria.registrar(req, 'transportadoras.eliminar', String(id), {});

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/search?collection=wa_chats&q=hola
app.get('/api/search', auth.conModulo('conversaciones'), async (req, res) => {
    try {
        const col = chatCollection(req.query.collection);
        const q = req.query.q || '';
        if (!q.trim()) return res.json([]);

        const docs = await db.collection(col).find({}).toArray();
        const results = [];

        for (const doc of docs) {
            const sid = doc.sessionId == null ? null : String(doc.sessionId);
            const filtered = filterMessages(doc.messages);
            for (const m of filtered) {
                if (m.content.toLowerCase().includes(q.toLowerCase())) {
                    results.push({ id: doc._id.toString(), sessionId: sid, type: m.type, content: m.content });
                    if (results.length >= 50) break;
                }
            }
            if (results.length >= 50) break;
        }

        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/stats
app.get('/api/stats', auth.conModulo('conversaciones'), async (req, res) => {
    try {
        const stats = {};

        for (const col of CHAT_COLLECTIONS) {
            const docs = await db.collection(col).find({}).toArray();
            const totalMsgs = docs.reduce((sum, d) => sum + filterMessages(d.messages).length, 0);
            stats[col] = { sessions: docs.length, messages: totalMsgs };
        }

        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- Centro de usuarios ------------------------------------------------
   Quien entra al panel y a que secciones. Todo esto vive detras del modulo
   `usuarios`, que es el que se le da a quien administra.

   Dos guardas se repiten, y las dos existen por el mismo motivo: que nadie
   pueda dejar el panel sin administrador. Salir de ese estado obligaria a
   entrar a Atlas a editar documentos a mano.

     1. Nadie se quita a si mismo el modulo `usuarios`.
     2. Nadie se desactiva ni se elimina a si mismo.

   Con esas dos basta, y vale la pena ver por que: quien ejecuta cualquiera de
   estas rutas es, necesariamente, un administrador ACTIVO — se lo exige
   conModulo('usuarios'). Asi que mientras no pueda apagarse a si mismo,
   siempre queda al menos uno. Una tercera guarda del tipo "no dejar sin
   administradores" seria codigo que no se puede alcanzar.                    */

// GET /api/usuarios - la lista, el catalogo de modulos y quien esta mirando.
// `yo` viaja para que el panel pueda deshabilitar las casillas que el propio
// servidor va a rechazar, en vez de dejar hacer clic y responder con un error.
app.get('/api/usuarios', auth.conModulo('usuarios'), async (req, res) => {
    try {
        res.json({
            usuarios: await auth.listar(),
            modulos: auth.MODULOS,
            yo: req.usuario.usuario,
            claveTemporal: auth.CLAVE_TEMPORAL
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/usuarios/guardar  { usuario, nombre, modulos, activo }
// Sin usuario existente crea; con uno existente actualiza. La clave NO se toca
// aqui: crear la pone temporal y cambiarla tiene su propia ruta, para que
// guardar unos permisos no pueda reiniciarle la contraseña a nadie sin querer.
app.post('/api/usuarios/guardar', auth.conModulo('usuarios'), async (req, res) => {
    try {
        const { usuario, nombre, modulos, activo } = req.body || {};

        const u = auth.normalizarUsuario(usuario);
        if (!u) {
            return res.status(400).json({
                error: 'El usuario debe tener entre 3 y 30 caracteres, en minúsculas, sin espacios ni tildes.'
            });
        }

        const existente = await auth.buscar(u);
        const propio = u === req.usuario.usuario;
        const modulosNuevos = auth.normalizarModulos(modulos);
        const quedaActivo = activo === undefined ? true : !!activo;

        if (propio && modulos !== undefined && !modulosNuevos.includes(auth.MODULO_ADMIN)) {
            return res.status(409).json({
                error: 'No puedes quitarte tu propio acceso a Usuarios: te quedarías sin poder volver a entrar aquí.'
            });
        }
        if (propio && activo !== undefined && !quedaActivo) {
            return res.status(409).json({ error: 'No puedes desactivar tu propio usuario.' });
        }

        if (!existente) {
            const n = auth.normalizarNombre(nombre);
            if (!n) return res.status(400).json({ error: 'Escribe el nombre completo de la persona.' });

            const creado = await auth.crear({
                usuario: u, nombre: n, modulos: modulosNuevos,
                clave: auth.CLAVE_TEMPORAL, por: req.usuario.usuario
            });
            auditoria.registrar(req, 'usuarios.crear', u, { nombre: n, modulos: creado.modulos });
            return res.json({ ok: true, creado: true, usuario: creado });
        }

        const cambios = {};
        if (nombre !== undefined) {
            const n = auth.normalizarNombre(nombre);
            if (!n) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
            cambios.nombre = n;
        }
        if (modulos !== undefined) cambios.modulos = modulosNuevos;
        if (activo !== undefined) cambios.activo = quedaActivo;
        if (!Object.keys(cambios).length) {
            return res.status(400).json({ error: 'no hay nada que actualizar' });
        }

        const guardado = await auth.actualizar(u, cambios, req.usuario.usuario);
        auditoria.registrar(req, 'usuarios.editar', u, cambios);
        res.json({ ok: true, creado: false, usuario: guardado });
    } catch (err) {
        // El indice unico sobre `usuario` es lo que impide dos cuentas con el
        // mismo nombre; se traduce a un mensaje legible en vez del de Mongo.
        if (err && err.code === 11000) {
            return res.status(409).json({ error: 'Ya existe un usuario con ese nombre de acceso.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// POST /api/usuarios/clave  { usuario }
// Reinicia la contraseña a la temporal. No devuelve ninguna clave elegida por
// nadie: la temporal es publica y conocida, y el panel obliga a cambiarla en el
// primer ingreso, asi que quien la reinicia no termina sabiendo con que trabaja
// el otro.
app.post('/api/usuarios/clave', auth.conModulo('usuarios'), async (req, res) => {
    try {
        const u = auth.normalizarUsuario((req.body || {}).usuario);
        if (!u) return res.status(400).json({ error: 'falta el usuario' });
        if (!(await auth.buscar(u))) return res.status(404).json({ error: 'usuario no encontrado' });

        // ponerClave resella `credencialesDesde`, o sea que cierra las sesiones
        // que esa persona tenga abiertas. Es lo que se quiere: la razon normal
        // para reiniciar una clave es sospechar que alguien mas la tiene.
        await auth.ponerClave(u, auth.CLAVE_TEMPORAL, { temporal: true, por: req.usuario.usuario });
        auditoria.registrar(req, 'usuarios.clave', u, {});

        res.json({ ok: true, claveTemporal: auth.CLAVE_TEMPORAL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/usuarios/eliminar  { usuario }
// Aqui si se borra de verdad, como en transportadoras: un usuario que ya no
// trabaja aqui no tiene por que seguir en la lista. Lo que hizo mientras estuvo
// sigue en la coleccion `auditoria` y en las columnas `usuario` de las tablas,
// que guardan la cadena y no una referencia — borrar la cuenta no borra el
// rastro.
app.post('/api/usuarios/eliminar', auth.conModulo('usuarios'), async (req, res) => {
    try {
        const u = auth.normalizarUsuario((req.body || {}).usuario);
        if (!u) return res.status(400).json({ error: 'falta el usuario' });
        if (u === req.usuario.usuario) {
            return res.status(409).json({ error: 'No puedes eliminar tu propio usuario.' });
        }

        const doc = await auth.buscar(u);
        if (!doc) return res.status(404).json({ error: 'usuario no encontrado' });

        await auth.eliminar(u);
        auditoria.registrar(req, 'usuarios.eliminar', u, { nombre: doc.nombre || null });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/auditoria?limite=100&usuario=&accion=
// El registro de cambios del portal. Es de solo lectura y no tiene ruta de
// borrado a proposito: un registro que se puede limpiar desde el mismo panel
// que audita no sirve para nada.
app.get('/api/auditoria', auth.conModulo('usuarios'), async (req, res) => {
    try {
        res.json(await auditoria.ultimos({
            limite: req.query.limite,
            usuario: auth.normalizarUsuario(req.query.usuario),
            accion: req.query.accion || null
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`ChatRoom corriendo en http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Error conectando a MongoDB:', err.message);
    process.exit(1);
});
