// Estructura del Pipeline en MongoDB. Es idempotente: se puede correr las
// veces que sea y no modifica ninguna conversacion.
//
//   cd chatroom && node mongo/migrar-pipeline.js
//
// Mongo no tiene DDL, asi que "la estructura" del pipeline son dos cosas:
//
//   1. El subdocumento `pipeline` dentro de CADA documento de chat, que
//      escriben /api/pipeline/mover y /api/pipeline/nota:
//
//        pipeline: {
//          etapa:         'cotizacion',        // clave de ETAPAS_PIPELINE en server.js
//          desde:         '2026-09-05T14:00Z', // entrada a la etapa ACTUAL
//          cerradoEn:     null,                // solo en etapas terminales
//          nota:          'espera visto bueno del arte',
//          actualizadoEn: '2026-09-05T14:00Z',
//          historial:     [ { etapa, desde, en } ]   // ultimos 50
//        }
//
//   2. Los indices que crea este script.
//
// Lo que este script NO hace, a proposito: rellenar `pipeline` en los chats
// que no lo tienen. Un documento sin el campo se lee como `sin_asignar` (ver
// pipelineDe() en server.js), asi que el relleno escribiria en todas las
// conversaciones de la base para dejarlas exactamente como ya se leen. Ese
// mismo criterio es el que hace que una conversacion nueva entre al tablero
// sola, sin que nadie tenga que ingestarla.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { MongoClient } = require('mongodb');

const COLECCIONES = ['wa_chats', 'wa_chats_web'];

(async () => {
    for (const k of ['MONGO_URI', 'MONGO_DB']) {
        if (!process.env[k]) throw new Error(`falta ${k} en chatroom/.env`);
    }

    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db(process.env.MONGO_DB);
    console.log('conectado a', process.env.MONGO_DB);

    for (const nombre of COLECCIONES) {
        const col = db.collection(nombre);

        // El tablero hoy lee las conversaciones completas y agrupa en el
        // navegador, asi que estos indices no los usa el panel todavia. Estan
        // para lo que si consulta por etapa: un reporte del embudo, un tablero
        // paginado el dia que la base crezca, o un vistazo desde Atlas.
        await col.createIndex({ 'pipeline.etapa': 1 }, { name: 'ix_pipeline_etapa' });
        // Las tarjetas cerradas se listan de la mas reciente hacia atras.
        await col.createIndex({ 'pipeline.cerradoEn': -1 },
            { name: 'ix_pipeline_cerrado', sparse: true });

        const total = await col.countDocuments({});
        const conEtapa = await col.aggregate([
            { $group: { _id: '$pipeline.etapa', n: { $sum: 1 } } },
            { $sort: { n: -1 } }
        ]).toArray();

        console.log(`\n${nombre}: ${total} conversaciones`);
        for (const g of conEtapa) {
            const clave = g._id == null ? 'sin_asignar (sin el campo)' : g._id;
            console.log('   ' + String(clave).padEnd(28) + g.n);
        }
    }

    console.log('\nindices listos: ix_pipeline_etapa, ix_pipeline_cerrado');
    await client.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
