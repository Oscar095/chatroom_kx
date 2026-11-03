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
ok('en curso: leads del periodo que hoy no estan cerrados (#2 reabierta y #4)', r.conversion.enCurso, 2);
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

// Un dia de calendario de Bogota, como lo convierte /api/dashboard.
const diaBog = s => Date.parse(s + 'T00:00:00-05:00');

console.log('\n== mes cerrado: agosto 2026 ==');
const ago = d.resumen({ chats, etapas: ETAPAS, desde: diaBog('2026-08-01'), hasta: diaBog('2026-09-01'), ahora: AHORA });
ok('leads de agosto (quedan fuera los de julio)', ago.leads.total, 4);
ok('se compara contra julio entero', ago.periodo.anterior,
    { desde: '2026-07-01T05:00:00.000Z', hasta: '2026-08-01T05:00:00.000Z' });
ok('leads de julio', ago.leads.anterior, 2);
ok('ganados de agosto', ago.conversion.ganados, 2);
ok('la serie cubre solo agosto', [ago.serie.length, ago.serie[0].dia, ago.serie[30].dia], [31, '2026-08-01', '2026-08-31']);
ok('la serie suma los leads del mes', ago.serie.reduce((s, x) => s + x.wa + x.web, 0), 4);
ok('el embudo es la foto del 31 de agosto', ago.periodo.corte, '2026-09-01T05:00:00.000Z');
ok('foto: la #2 seguia despachada y la #3 aun no desistia',
    ago.embudo.map(e => [e.clave, e.n]),
    [['sin_asignar', 2], ['cotizacion', 1], ['produccion', 0], ['despachado', 2], ['desiste', 0]]);
ok('foto: activas al cierre', ago.activas, 3);
ok('etapas: solo saltos ocurridos en agosto (2 y 24 d -> 13; 8 d)',
    ago.tiempoPorEtapa.map(e => [e.clave, e.dias, e.muestras]),
    [['sin_asignar', 13, 2], ['cotizacion', 8, 1], ['produccion', null, 0]]);
ok('estancadas siguen siendo de hoy', ago.totalEstancadas, 2);

console.log('\n== mes en curso: septiembre hasta hoy ==');
const sep = d.resumen({ chats, etapas: ETAPAS, desde: diaBog('2026-09-01'), hasta: diaBog('2026-10-01'), ahora: AHORA });
ok('el periodo se corta en hoy', sep.periodo.hasta, new Date(AHORA).toISOString());
ok('se compara contra los mismos dias de agosto', sep.periodo.anterior,
    { desde: '2026-08-01T05:00:00.000Z', hasta: '2026-08-06T12:00:00.000Z' });
ok('sin corte: el embudo es el de hoy', sep.periodo.corte, null);
ok('la serie no pasa de hoy', sep.serie[sep.serie.length - 1].dia, '2026-09-06');

console.log('\n== ventana anterior ==');
const va = (a, b) => { const v = d.ventanaAnterior(diaBog(a), diaBog(b)); return [new Date(v.desde).toISOString().slice(0, 10), new Date(v.hasta).toISOString().slice(0, 10)]; };
ok('trimestre contra trimestre (jul-sep vs abr-jun)', va('2026-07-01', '2026-10-01'), ['2026-04-01', '2026-07-01']);
ok('31 de marzo menos un mes es el 28 de febrero', va('2026-03-01', '2026-03-31'), ['2026-02-01', '2026-02-28']);
ok('rango suelto: el mismo largo justo antes', va('2026-08-10', '2026-08-20'), ['2026-07-31', '2026-08-10']);

console.log('\n== cierres(): de donde salen despachados y desistidos ==');
const TERM = ['despachado', 'desiste'];
const en = iso => ({ en: iso });
ok('una entrada terminal es un cierre',
    d.cierres([{ etapa: 'despachado', ...en('2026-10-05T15:00:00Z') }], TERM),
    [{ etapa: 'despachado', en: '2026-10-05T15:00:00.000Z' }]);
ok('las etapas activas no son cierres',
    d.cierres([{ etapa: 'cotizacion', ...en('2026-10-01T15:00:00Z') }], TERM), []);
ok('un arrastre deshecho a los 2 minutos no cuenta',
    d.cierres([{ etapa: 'despachado', ...en('2026-10-05T15:00:00Z') },
               { etapa: 'produccion', ...en('2026-10-05T15:02:00Z') }], TERM), []);
ok('a los 10 minutos exactos ya cuenta (el limite es estricto)',
    d.cierres([{ etapa: 'desiste', ...en('2026-10-05T15:00:00Z') },
               { etapa: 'arte', ...en('2026-10-05T15:10:00Z') }], TERM).length, 1);
ok('la entrada actual nunca es correccion, aunque sea de hace un segundo',
    d.cierres([{ etapa: 'cotizacion', ...en('2026-10-05T15:00:00Z') },
               { etapa: 'despachado', ...en('2026-10-05T15:00:30Z') }], TERM).length, 1);
ok('cliente que vuelve: dos despachos son dos cierres',
    d.cierres([{ etapa: 'despachado', ...en('2026-09-10T15:00:00Z') },
               { etapa: 'cotizacion', ...en('2026-10-02T15:00:00Z') },
               { etapa: 'despachado', ...en('2026-10-20T15:00:00Z') }], TERM).map(x => x.en.slice(0, 10)),
    ['2026-09-10', '2026-10-20']);
ok('sin historial, una tarjeta cerrada usa su cerradoEn',
    d.cierres([], TERM, { etapa: 'desiste', cerradoEn: '2026-10-07T15:00:00Z' }),
    [{ etapa: 'desiste', en: '2026-10-07T15:00:00.000Z' }]);
ok('sin historial y abierta: nada', d.cierres(null, TERM, { etapa: 'cotizacion', cerradoEn: null }), []);

console.log('\n== conversion del mes: leads que llegaron vs despachados en el mes ==');
// AHORA = 6 sep 12:00Z. Agosto y septiembre en hora de Bogota.
const AGO = [diaBog('2026-08-01'), diaBog('2026-09-01')];
const SEP = [diaBog('2026-09-01'), diaBog('2026-10-01')];
const at = iso => iso;   // fechas absolutas, para no depender de `hace()`
const mes = [
    // Lead de julio despachado en agosto: cuenta en AGOSTO, no en julio.
    { id: 'm1', collection: 'wa_chats', startedAt: at('2026-07-20T15:00:00Z'), etapa: 'despachado',
      historial: [{ etapa: 'despachado', desde: 'sin_asignar', en: at('2026-08-10T15:00:00Z') }] },
    // Lead de agosto vendido en agosto y reabierto en septiembre para otro pedido:
    // la venta sigue siendo de agosto.
    { id: 'm2', collection: 'wa_chats', startedAt: at('2026-08-02T15:00:00Z'), etapa: 'cotizacion',
      historial: [{ etapa: 'despachado', desde: 'sin_asignar', en: at('2026-08-12T15:00:00Z') },
                  { etapa: 'cotizacion', desde: 'despachado', en: at('2026-09-02T15:00:00Z') }] },
    // Lead de agosto arrastrado a Despachado por error y deshecho al minuto: no es venta.
    { id: 'm3', collection: 'wa_chats_web', startedAt: at('2026-08-05T15:00:00Z'), etapa: 'cotizacion',
      historial: [{ etapa: 'despachado', desde: 'cotizacion', en: at('2026-08-20T15:00:00Z') },
                  { etapa: 'cotizacion', desde: 'despachado', en: at('2026-08-20T15:01:00Z') }] },
    // Lead de agosto que desistio en agosto.
    { id: 'm4', collection: 'wa_chats', startedAt: at('2026-08-06T15:00:00Z'), etapa: 'desiste',
      historial: [{ etapa: 'desiste', desde: 'sin_asignar', en: at('2026-08-25T15:00:00Z') }] },
    // Lead de agosto que desistio y despues se vendio, todo en agosto: es venta, no las dos cosas.
    { id: 'm5', collection: 'wa_chats', startedAt: at('2026-08-07T15:00:00Z'), etapa: 'despachado',
      historial: [{ etapa: 'desiste', desde: 'sin_asignar', en: at('2026-08-15T15:00:00Z') },
                  { etapa: 'despachado', desde: 'desiste', en: at('2026-08-28T15:00:00Z') }] },
    // Despachado el 31 de agosto a las 8 p.m. de Bogota (1 sep en UTC): es de AGOSTO.
    { id: 'm6', collection: 'wa_chats', startedAt: at('2026-08-30T15:00:00Z'), etapa: 'despachado',
      historial: [{ etapa: 'despachado', desde: 'sin_asignar', en: at('2026-09-01T01:00:00Z') }] }
];
const ma = d.resumen({ chats: mes, etapas: ETAPAS, desde: AGO[0], hasta: AGO[1], ahora: AHORA });
ok('leads de agosto (m1 es de julio)', ma.leads.total, 5);
ok('despachados en agosto: m1, m2, m5, m6 (m3 fue un error)', ma.conversion.ganados, 4);
ok('desistidos en agosto: solo m4 (m5 termino vendido)', ma.conversion.perdidos, 1);
ok('conversion = 4 despachados / 5 leads', ma.conversion.tasa, 80);
ok('tasa de cierre = 4 / (4 + 1)', ma.conversion.cierre, 80);
ok('en curso: leads de agosto abiertos hoy (m2 reabierta y m3)', ma.conversion.enCurso, 2);
// Ciclos: m1 21 d, m2 10 d, m5 21 d, m6 ~1.4 d -> mediana (10 + 21) / 2
ok('ciclo: mediana del primer mensaje al primer despacho', ma.conversion.cicloDias, 15.5);

const ms = d.resumen({ chats: mes, etapas: ETAPAS, desde: SEP[0], hasta: SEP[1], ahora: AHORA });
ok('septiembre arranca en cero: el mes nuevo reinicia los cierres', [ms.conversion.ganados, ms.conversion.perdidos], [0, 0]);
ok('del 1 al 6 de agosto no hubo despachos: sin comparativo, no un -100% inventado', ms.conversion.variacion, null);
ok('sin leads en septiembre no hay tasa', ms.conversion.tasa, null);

console.log('\n== un mes flojo tras uno bueno puede pasar de 100% ==');
const flojo = d.resumen({ chats: [
    { id: 'f1', collection: 'wa_chats', startedAt: at('2026-07-05T15:00:00Z'), etapa: 'despachado',
      historial: [{ etapa: 'despachado', en: at('2026-08-03T15:00:00Z') }] },
    { id: 'f2', collection: 'wa_chats', startedAt: at('2026-07-06T15:00:00Z'), etapa: 'despachado',
      historial: [{ etapa: 'despachado', en: at('2026-08-04T15:00:00Z') }] },
    { id: 'f3', collection: 'wa_chats', startedAt: at('2026-08-10T15:00:00Z'), etapa: 'sin_asignar', historial: [] }
], etapas: ETAPAS, desde: AGO[0], hasta: AGO[1], ahora: AHORA });
ok('2 despachados / 1 lead = 200%', flojo.conversion.tasa, 200);
ok('el ciclo de un lead de julio despachado en agosto es de agosto', flojo.conversion.cicloDias, 29);

console.log('\n== el segundo pedido no entra al ciclo ==');
const vuelve = d.resumen({ chats: [
    { id: 'v1', collection: 'wa_chats', startedAt: at('2026-06-01T15:00:00Z'), etapa: 'despachado',
      historial: [{ etapa: 'despachado', en: at('2026-06-11T15:00:00Z') },
                  { etapa: 'cotizacion', en: at('2026-08-01T15:00:00Z') },
                  { etapa: 'despachado', en: at('2026-08-20T15:00:00Z') }] }
], etapas: ETAPAS, desde: AGO[0], hasta: AGO[1], ahora: AHORA });
ok('el re-despacho cuenta como venta de agosto', vuelve.conversion.ganados, 1);
ok('pero no mide un ciclo de 80 dias', vuelve.conversion.cicloDias, null);

console.log('\n== el orden importa en una sola direccion ==');
const OCT = [diaBog('2026-10-01'), diaBog('2026-11-01')];
const NOV15 = Date.parse('2026-11-15T12:00:00Z');
const orden = h => d.resumen({ chats: [{ id: 'o', collection: 'wa_chats', startedAt: '2026-10-01T15:00:00Z',
    etapa: h[h.length - 1].etapa, historial: h }], etapas: ETAPAS, desde: OCT[0], hasta: OCT[1], ahora: NOV15 }).conversion;
const o1 = orden([{ etapa: 'despachado', en: '2026-10-05T15:00:00Z' },
                  { etapa: 'cotizacion', en: '2026-10-10T15:00:00Z' },
                  { etapa: 'desiste',    en: '2026-10-25T15:00:00Z' }]);
ok('compro el 5 y desistio del siguiente el 25: una venta Y una perdida', [o1.ganados, o1.perdidos, o1.cierre], [1, 1, 50]);
const o2 = orden([{ etapa: 'desiste',    en: '2026-10-05T15:00:00Z' },
                  { etapa: 'despachado', en: '2026-10-20T15:00:00Z' },
                  { etapa: 'desiste',    en: '2026-10-28T15:00:00Z' }]);
ok('desistio, compro y volvio a desistir: el ultimo desistimiento si cuenta', [o2.ganados, o2.perdidos], [1, 1]);

console.log('\n== el Pipeline y el Dashboard dan el mismo numero ==');
// plMetricasMes() vive en index.html y replica despachoEn()/desistioEn(). Se
// saca del propio archivo y se corre aqui: si alguien cambia una copia y no la
// otra, esta prueba falla en vez de que las dos pantallas se contradigan.
{
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
    const fuente = nombre => {
        const i = html.indexOf('function ' + nombre + '(');
        if (i < 0) throw new Error('no esta ' + nombre + ' en index.html');
        let j = html.indexOf('{', i), prof = 0;
        for (; j < html.length; j++) {
            if (html[j] === '{') prof++;
            else if (html[j] === '}' && --prof === 0) break;
        }
        return html.slice(i, j + 1);
    };
    const metricasPanel = (sesiones, mes) => new Function('sesiones', 'mes', `
        const sessionsByCol = { todas: sesiones };
        const plCanal = 'all';
        const plMes = mes;
        const porCanal = l => l;
        ${fuente('mesBogota')} ${fuente('plMesHoy')} ${fuente('plMesVisto')} ${fuente('plMetricasMes')}
        return plMetricasMes();`)(sesiones, mes);

    // Tarjetas al azar, pero reproducibles (LCG con semilla fija).
    let semilla = 20261030;
    const azar = () => (semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648;
    const CLAVES = ['en_proceso', 'cotizacion', 'produccion', 'despachado', 'desiste'];
    const base = Date.parse('2026-08-25T05:00:00Z'), ventana = 75 * 86400000;
    const chats = [], sesiones = [];
    for (let i = 0; i < 2000; i++) {
        const ini = base + azar() * ventana;
        const historial = [];
        let t = ini, previa = 'sin_asignar';
        for (let n = Math.floor(azar() * 5); n > 0; n--) {
            // Saltos de minutos a semanas, para ejercer tambien la correccion.
            t += azar() < 0.15 ? azar() * 20 * 60000 : azar() * 20 * 86400000;
            const etapa = CLAVES[Math.floor(azar() * CLAVES.length)];
            if (etapa === previa) continue;
            historial.push({ etapa, desde: previa, en: new Date(t).toISOString() });
            previa = etapa;
        }
        const startedAt = new Date(ini).toISOString();
        const ultimo = historial[historial.length - 1];
        const terminal = ['despachado', 'desiste'].includes(previa);
        const cerradoEn = terminal ? ultimo.en : null;
        chats.push({ id: 'r' + i, collection: 'wa_chats', startedAt, etapa: previa, cerradoEn, historial });
        sesiones.push({ id: 'r' + i, collection: 'wa_chats', startedAt,
            pipeline: { etapa: previa, cerradoEn, cierres: d.cierres(historial, TERM, { etapa: previa, cerradoEn }) } });
    }
    const ahoraLejos = Date.parse('2027-01-15T12:00:00Z');
    let iguales = true, detalle = '';
    for (const [mesK, a, b] of [['2026-08', '2026-08-01', '2026-09-01'], ['2026-09', '2026-09-01', '2026-10-01'],
                                ['2026-10', '2026-10-01', '2026-11-01'], ['2026-11', '2026-11-01', '2026-12-01']]) {
        const srv = d.resumen({ chats, etapas: ETAPAS, desde: diaBog(a), hasta: diaBog(b), ahora: ahoraLejos });
        const pan = metricasPanel(sesiones, mesK);
        const s = [srv.leads.total, srv.conversion.ganados, srv.conversion.perdidos, srv.conversion.tasa];
        const p = [pan.leads, pan.despachados, pan.desistidos, pan.conversion];
        if (JSON.stringify(s) !== JSON.stringify(p)) { iguales = false; detalle += ` ${mesK}: dashboard ${s} / pipeline ${p}`; }
    }
    ok('mismos leads, despachados, desistidos y conversion en 4 meses' + detalle, iguales, true);
    const huboDeTodo = d.resumen({ chats, etapas: ETAPAS, desde: diaBog('2026-10-01'), hasta: diaBog('2026-11-01'), ahora: ahoraLejos }).conversion;
    ok('la muestra ejerce los dos tipos de cierre', huboDeTodo.ganados > 20 && huboDeTodo.perdidos > 20, true);
}

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
