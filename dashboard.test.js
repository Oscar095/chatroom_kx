// Pruebas del calculo de indicadores.
//
//   cd chatroom && node dashboard.test.js
//
// No usa ninguna libreria ni toca la base: dashboard.js es una funcion pura y
// aqui se le pasan conversaciones inventadas con fechas relativas a un `ahora`
// fijo. Existe porque un indicador mal calculado es un error MUDO: no lanza
// excepcion, no rompe la vista, y alguien toma una decision con el.
//
// Si agregas un indicador a dashboard.js, agregale aqui su caso — sobre todo
// los bordes: sin datos, division por cero, y el limite exacto de la ventana.
const d = require('./dashboard');

const ETAPAS = [
    { clave: 'sin_asignar', nombre: 'Sin asignar', terminal: false },
    { clave: 'cotizacion',  nombre: 'En cotizacion', terminal: false },
    { clave: 'produccion',  nombre: 'En produccion', terminal: false },
    { clave: 'despachado',  nombre: 'Despachado', terminal: true },
    { clave: 'desiste',     nombre: 'Desistio', terminal: true }
];

const AHORA = Date.parse('2026-09-06T12:00:00Z');
const hace = dias => new Date(AHORA - dias * 86400000).toISOString();

let fallos = 0;
const ok = (nombre, real, esperado) => {
    const bien = JSON.stringify(real) === JSON.stringify(esperado);
    if (!bien) fallos++;
    console.log((bien ? '  ok   ' : '  FALLA') + '  ' + nombre +
        (bien ? '' : `\n         esperado ${JSON.stringify(esperado)}, dio ${JSON.stringify(real)}`));
};

const chats = [
    // Ganado: entro hace 20 dias, despachado hace 10 -> ciclo 10 dias
    { id:'1', collection:'wa_chats', startedAt: hace(20), etapa:'despachado', etapaDesde: hace(10),
      historial:[{etapa:'cotizacion',en:hace(18)},{etapa:'despachado',en:hace(10)}],
      mensajes:10, delCliente:5, ultimoTipo:'ai' },
    // Ganado y REABIERTO: hoy esta en produccion pero paso por despachado
    { id:'2', collection:'wa_chats', startedAt: hace(30), etapa:'produccion', etapaDesde: hace(2),
      historial:[{etapa:'despachado',en:hace(6)},{etapa:'produccion',en:hace(2)}],
      mensajes:4, delCliente:2, ultimoTipo:'human' },
    // Perdido
    { id:'3', collection:'wa_chats_web', startedAt: hace(15), etapa:'desiste', etapaDesde: hace(3),
      historial:[{etapa:'desiste',en:hace(3)}], mensajes:2, delCliente:2, ultimoTipo:'human' },
    // Abierto y estancado: nadie lo movio nunca (etapaDesde null -> cuenta desde startedAt)
    { id:'4', collection:'wa_chats', startedAt: hace(25), etapa:'sin_asignar', etapaDesde: null,
      historial:[], mensajes:1, delCliente:1, ultimoTipo:'human' },
    // Archivado y sin etapa: NO entra al embudo
    { id:'5', collection:'wa_chats', startedAt: hace(40), etapa:'sin_asignar', etapaDesde: null,
      archivada:true, historial:[], mensajes:3, delCliente:1, ultimoTipo:'ai' },
    // Del periodo ANTERIOR (mas de 30 dias): no cuenta como lead de la ventana
    { id:'6', collection:'wa_chats', startedAt: hace(45), etapa:'cotizacion', etapaDesde: hace(44),
      historial:[{etapa:'cotizacion',en:hace(44)}], mensajes:6, delCliente:3, ultimoTipo:'ai' }
];

console.log('\n== ventana de 30 dias ==');
const r = d.resumen({ chats, etapas: ETAPAS, dias: 30, ahora: AHORA });

ok('leads del periodo (4: quedan fuera los de 40 y 45 dias)', r.leads.total, 4);
ok('leads del periodo anterior (30-60 dias)', r.leads.anterior, 2);
ok('reparto por canal', [r.leads.whatsapp, r.leads.web], [3, 1]);
ok('ganados cuenta el reabierto', r.conversion.ganados, 2);
ok('perdidos', r.conversion.perdidos, 1);
ok('en curso', r.conversion.enCurso, 1);
ok('conversion = 2 ganados / 4 leads', r.conversion.tasa, 50);
ok('tasa de cierre = 2/3', r.conversion.cierre, 66.7);
ok('ciclo mediano (10 y 24 dias -> 17)', r.conversion.cicloDias, 17);
ok('embudo excluye la archivada sin etapa', r.embudo.find(e=>e.clave==='sin_asignar').n, 1);
ok('activas (no terminales, en tablero)', r.activas, 3);
ok('estancadas: solo la #4 (25 d) y la #6 (44 d)', r.estancadas.map(x=>x.id), ['6','4']);
ok('dias de la mas vieja', r.estancadas[0].dias, 44);
ok('esperando respuesta (ultimoTipo human, sin archivar)', r.operacion.esperandoRespuesta, 3);
ok('mensajes totales', r.operacion.mensajes, 26);

console.log('\n== sin ventana (todo) ==');
const t = d.resumen({ chats, etapas: ETAPAS, dias: 0, ahora: AHORA });
ok('todos los leads', t.leads.total, 6);
ok('sin periodo anterior no hay variacion', t.leads.variacion, null);

console.log('\n== huso horario de Bogota ==');
const noche = [
    // 20:00 en Bogota del 11 = 01:00 UTC del 12. Tiene que contar como el 11.
    { id:'n1', collection:'wa_chats', startedAt:'2026-08-12T01:00:00Z', etapa:'sin_asignar', historial:[] },
    { id:'n2', collection:'wa_chats', startedAt:'2026-08-12T16:00:00Z', etapa:'sin_asignar', historial:[] }
];
const s = d.resumen({ chats: noche, etapas: ETAPAS, dias: 0, ahora: Date.parse('2026-08-13T12:00:00Z') }).serie;
ok('la conversacion de las 8 p.m. cuenta el dia 11', s[0], { dia:'2026-08-11', wa:1, web:0 });
ok('la del mediodia cuenta el 12', s[1], { dia:'2026-08-12', wa:1, web:0 });

console.log('\n== embudo vacio (base recien estrenada) ==');
const v = d.resumen({ chats: [], etapas: ETAPAS, dias: 30, ahora: AHORA });
ok('sin datos no inventa porcentajes', [v.conversion.tasa, v.conversion.cierre, v.conversion.cicloDias], [null, null, null]);
ok('serie vacia', v.serie.length, 0);

console.log(fallos ? `\n${fallos} PRUEBAS FALLARON` : '\ntodas las pruebas pasan');
process.exit(fallos ? 1 : 0);
