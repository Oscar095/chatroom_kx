require('dotenv').config();
const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const pedidos = require('./pedidos');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/contacts - phone -> { name, lastSeen }
app.get('/api/contacts', async (req, res) => {
    res.json(await loadContacts());
});

// GET /api/sessions?collection=wa_chats
app.get('/api/sessions', async (req, res) => {
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
                lastType: lastMsg ? lastMsg.type : ''
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

// GET /api/messages?collection=wa_chats&id=<mongo _id>
// Falls back to sessionId lookup for older callers.
app.get('/api/messages', async (req, res) => {
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
app.get('/api/media/:id', async (req, res) => {
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
app.post('/api/archive', async (req, res) => {
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
                ? { $set: { archivedAt: new Date().toISOString() } }
                : { $unset: { archivedAt: '' } }
        );
        if (!result.matchedCount) return res.status(404).json({ error: 'No encontrado' });

        res.json({ ok: true, archived: archivar });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/contacts/list - la agenda completa, un registro por contacto con
// todo lo que se sabe de él y el enlace a su conversación.
app.get('/api/contacts/list', async (req, res) => {
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
app.post('/api/mode', async (req, res) => {
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
                ? { $set: { mode: 'manual', manualSince: new Date().toISOString() } }
                : { $unset: { mode: '', manualSince: '' } }
        );

        res.json({ ok: true, mode, ventana });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/send  { collection, id, text }
// Manda el mensaje del asesor a n8n (que lo entrega por WhatsApp) y solo si
// Meta lo aceptó lo agrega a la memoria del chat. El orden importa: si se
// guardara primero, el panel mostraría mensajes que el cliente nunca recibió.
app.post('/api/send', async (req, res) => {
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
                            additional_kwargs: { sentBy: 'asesor' },
                            response_metadata: {}
                        }
                    }
                }
            }
        );

        res.json({ ok: true, id: respuesta.id || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- Pedidos -----------------------------------------------------------
   Lo único del panel que no vive en MongoDB: los pedidos vienen de la API de
   Siesa y se guardan en SQL Server. La conexión es perezosa, así que si SQL
   está caído el resto del panel sigue funcionando.                        */

// GET /api/pedidos?todos=1&sinDespachar=1
app.get('/api/pedidos', async (req, res) => {
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
app.post('/api/pedidos/sincronizar', async (req, res) => {
    try {
        res.json({ ok: true, ...(await pedidos.sincronizar()) });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// POST /api/pedidos/actualizar  { idTipoDocto, consecDocto, despachado, noGuia, contacto }
// Solo toca las columnas del asesor; lo que viene de Siesa no se edita.
app.post('/api/pedidos/actualizar', async (req, res) => {
    try {
        const { idTipoDocto, consecDocto, despachado, noGuia, contacto } = req.body || {};
        if (!idTipoDocto || !Number.isFinite(Number(consecDocto))) {
            return res.status(400).json({ error: 'falta idTipoDocto o consecDocto' });
        }
        if (despachado === undefined && noGuia === undefined && contacto === undefined) {
            return res.status(400).json({ error: 'no hay nada que actualizar' });
        }
        if (noGuia !== undefined && noGuia !== null && String(noGuia).length > 100) {
            return res.status(400).json({ error: 'el numero de guia supera 100 caracteres' });
        }

        const cambio = {};
        if (despachado !== undefined) cambio.despachado = !!despachado;
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

        const ok = await pedidos.actualizar(String(idTipoDocto), Number(consecDocto), cambio);
        if (!ok) return res.status(404).json({ error: 'pedido no encontrado' });
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
app.post('/api/pedidos/notificar', async (req, res) => {
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
        await pedidos.marcarNotificado(String(idTipoDocto), Number(consecDocto), respuesta.id);
        res.json({ ok: true, id: respuesta.id, notificadoEn: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/search?collection=wa_chats&q=hola
app.get('/api/search', async (req, res) => {
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
app.get('/api/stats', async (req, res) => {
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

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`ChatRoom corriendo en http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Error conectando a MongoDB:', err.message);
    process.exit(1);
});
