require('dotenv').config();
const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
    await client.connect();
    db = client.db(process.env.MONGO_DB);
    console.log('Conectado a MongoDB Atlas');
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

app.use(express.static(path.join(__dirname, 'public')));

// GET /api/contacts - phone -> { name, lastSeen }
app.get('/api/contacts', async (req, res) => {
    res.json(await loadContacts());
});

// GET /api/sessions?collection=wa_chats
app.get('/api/sessions', async (req, res) => {
    try {
        const col = req.query.collection || 'wa_chats';
        const docs = await db.collection(col).find({}).toArray();

        const contacts = await loadContacts();

        const sessions = docs.map(doc => {
            const filtered = filterMessages(doc.messages);
            const lastMsg = filtered.length > 0 ? filtered[filtered.length - 1] : null;
            // sessionId may be null/number/string; the Mongo _id is the only
            // identifier guaranteed to exist and round-trip through the URL.
            const sid = doc.sessionId == null ? null : String(doc.sessionId);
            const contact = sid ? contacts[sid] : null;
            return {
                id: doc._id.toString(),
                sessionId: sid,
                name: contact ? contact.name : null,
                username: contact ? contact.username : null,
                // The chat memory stores no per-message timestamps. The ObjectId
                // gives the conversation start; contacts.lastSeen the last message.
                startedAt: doc._id.getTimestamp().toISOString(),
                lastSeen: contact ? contact.lastSeen : null,
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
        const col = req.query.collection || 'wa_chats';
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

// GET /api/search?collection=wa_chats&q=hola
app.get('/api/search', async (req, res) => {
    try {
        const col = req.query.collection || 'wa_chats';
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
        const collections = ['wa_chats', 'wa_chats_web'];
        const stats = {};

        for (const col of collections) {
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
