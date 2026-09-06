// Los usuarios del panel. Es idempotente: se puede correr las veces que sea.
//
//   cd chatroom && node mongo/migrar-usuarios.js
//
// Crea la coleccion `usuarios` con los cuatro asesores, el indice unico sobre
// `usuario` y el indice por fecha de la coleccion `auditoria`. Todos entran con
// la clave temporal "1234" y con TODOS los modulos; el panel los obliga a
// cambiarla en el primer ingreso.
//
// A quien ya existe NO se le toca nada — ni la clave, ni los modulos, ni el
// nombre. Volver a correr esto despues de recortarle permisos a alguien no se
// los devuelve, y a quien ya cambio su clave no se la reinicia. Para eso estan
// el centro de usuarios del panel y su boton de reiniciar contraseña.
//
// Correrlo no es obligatorio: server.js crea estos mismos cuatro usuarios al
// arrancar si la coleccion esta vacia (asegurarSemilla en auth.js), porque en
// Azure nadie ejecuta scripts y una coleccion vacia dejaria el panel cerrado
// para todos. Este script sirve para hacerlo a mano y ver el resultado.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { MongoClient } = require('mongodb');
const auth = require('../auth');

(async () => {
    for (const k of ['MONGO_URI', 'MONGO_DB']) {
        if (!process.env[k]) throw new Error(`falta ${k} en chatroom/.env`);
    }

    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db(process.env.MONGO_DB);
    auth.iniciar(db);
    console.log('conectado a', process.env.MONGO_DB);

    const col = db.collection('usuarios');
    await col.createIndex({ usuario: 1 }, { unique: true });
    await db.collection('auditoria').createIndex({ en: -1 });

    let creados = 0;
    for (const u of auth.USUARIOS_INICIALES) {
        if (await col.findOne({ usuario: u.usuario })) {
            console.log('   ya existe, sin tocar:  ' + u.usuario);
            continue;
        }
        await auth.crear({
            usuario: u.usuario,
            nombre: u.nombre,
            modulos: auth.CLAVES_MODULOS,
            clave: auth.CLAVE_TEMPORAL,
            por: 'migracion'
        });
        creados++;
        console.log('   creado:                ' + u.usuario + '  (' + u.nombre + ')');
    }

    console.log('\nusuarios en la base:');
    for (const u of await auth.listar()) {
        console.log('   ' + u.usuario.padEnd(12) +
            (u.activo ? 'activo  ' : 'inactivo') +
            (u.debeCambiar ? '  clave temporal' : '  clave propia ') +
            '  ' + u.modulos.length + '/' + auth.CLAVES_MODULOS.length + ' modulos');
    }

    if (creados) {
        console.log('\n' + creados + ' usuario(s) nuevo(s) con la clave temporal "' +
            auth.CLAVE_TEMPORAL + '". El panel la hace cambiar al entrar.');
    }
    if (!process.env.SESSION_SECRET) {
        console.log('\nOJO: falta SESSION_SECRET en el .env. Sin el, las sesiones se ' +
            'cierran en cada reinicio del servidor.');
    }

    await client.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
