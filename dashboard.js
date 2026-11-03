// Los indicadores del panel. Este modulo NO habla con ninguna base: recibe las
// conversaciones ya leidas y devuelve numeros. Es a proposito —
//
//   1. server.js ya sabe leer Mongo y aplicar filterMessages()/pipelineDe();
//      duplicar eso aqui seria dos copias de la misma logica que se separan.
//   2. una funcion pura se puede probar con datos inventados, y un indicador
//      mal calculado es de los errores mas caros: nadie lo nota, se toman
//      decisiones con el, y no hay excepcion que avise.
//
// La parte de pedidos NO esta aqui: vive en pedidos.js porque es SQL y porque
// tiene que poder fallar sola (ver /api/dashboard en server.js).

// Cuantos dias sin moverse convierten una tarjeta en "estancada". Una semana
// es el umbral en el que un cliente ya se pregunto si lo olvidaron.
const DIAS_ESTANCADA = 7;
const MS_DIA = 86400000;

// Cuantas tarjetas estancadas se devuelven. La lista es para actuar hoy, no
// para auditar: veinte nombres no se leen.
const TOPE_ESTANCADAS = 10;

function aMs(v) {
    if (!v) return NaN;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : NaN;
}

// El dia al que pertenece un instante, EN HORA DE COLOMBIA. Sin este ajuste
// toda conversacion posterior a las 7 p.m. contaria como del dia siguiente,
// porque toISOString() habla UTC. Colombia no tiene horario de verano, asi que
// el desfase es constante y basta con restarlo.
const TZ_BOGOTA = -5 * 3600000;

function dia(ms) {
    return new Date(ms + TZ_BOGOTA).toISOString().slice(0, 10);
}

// Mediana y no promedio: con pocos datos un solo caso raro —el cliente que
// tardo tres meses en decidirse— mueve el promedio hasta volverlo mentira.
function mediana(nums) {
    const v = nums.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function variacion(ahora, antes) {
    // Sin base de comparacion no se inventa un porcentaje: null lo pinta como
    // "sin comparativo" en vez de como un +100% que no significa nada.
    if (!antes) return null;
    return Math.round(((ahora - antes) / antes) * 1000) / 10;
}

// El recorrido de una tarjeta, empezando por el dia en que llego la
// conversacion. El historial guarda el destino de cada salto (`etapa`) y
// cuando ocurrio (`en`), asi que la duracion de una etapa es la distancia
// hasta el salto siguiente. La ultima esta EN CURSO y por eso no entra en los
// promedios: contarla como si hubiera terminado los subestimaria siempre.
function recorrido(chat) {
    const inicio = aMs(chat.startedAt);
    const pasos = [{ etapa: 'sin_asignar', en: inicio }];
    for (const h of chat.historial || []) {
        const en = aMs(h.en);
        if (Number.isFinite(en) && h.etapa) pasos.push({ etapa: h.etapa, en });
    }
    return pasos;
}

// Una entrada a una etapa terminal que se deshizo antes de esto no fue un
// cierre: fue un arrastre al carril equivocado. El aviso de "Deshacer" dura
// ocho segundos y quien se equivoca suele corregir a mano en uno o dos minutos;
// diez dejan margen sin tragarse una reapertura de verdad (esas llegan dias
// despues, cuando el cliente vuelve a pedir).
const CORRECCION_MS = 10 * 60 * 1000;

/* Los cierres de una tarjeta: cada vez que entro a una etapa terminal, con la
   fecha en que entro. Es la fuente unica de "cuantos se despacharon y cuantos
   desistieron en el mes" —la usan este modulo y, via /api/sessions, el
   tablero—, asi que el Dashboard y el Pipeline no pueden dar dos numeros
   distintos para lo mismo.

   Sale del historial y no de la etapa de hoy, por dos razones:
     1. el mes de un cierre no cambia despues: una venta de septiembre sigue
        siendo de septiembre aunque en octubre se reabra la tarjeta para el
        siguiente pedido del mismo cliente;
     2. ese segundo pedido, si se despacha, es otro cierre, del mes en que
        ocurre.
   `actual` ({ etapa, cerradoEn }) cubre una tarjeta cerrada sin historial,
   que hoy no existe pero no puede quedar fuera de la cuenta si aparece.    */
function cierres(historial, terminales, actual) {
    const esTerminal = k => terminales.includes(k);
    const h = (historial || []).filter(x => x && x.etapa && Number.isFinite(aMs(x.en)));
    const out = [];
    h.forEach((x, i) => {
        if (!esTerminal(x.etapa)) return;
        const sig = h[i + 1];
        if (sig && aMs(sig.en) - aMs(x.en) < CORRECCION_MS) return;
        out.push({ etapa: x.etapa, en: new Date(aMs(x.en)).toISOString() });
    });
    if (!h.length && actual && esTerminal(actual.etapa) && Number.isFinite(aMs(actual.cerradoEn))) {
        out.push({ etapa: actual.etapa, en: new Date(aMs(actual.cerradoEn)).toISOString() });
    }
    return out;
}

/* Como se cuenta una tarjeta en un periodo, a partir de sus cierres. Las dos
   preguntas son independientes, y el orden importa en una sola direccion:

     - se DESPACHO si tiene un despacho en el periodo. Una venta que ocurrio
       no se deshace porque despues el cliente desista de un segundo pedido.
     - DESISTIO si tiene un desistimiento en el periodo que ningun despacho
       POSTERIOR del mismo periodo deja sin efecto. "Desistio el 5 y compro el
       20" fue una venta; "compro el 5 y desistio del siguiente el 25" son una
       venta y una perdida.

   index.html (plMetricasMes) replica estas dos funciones sobre los mismos
   `cierres`: si se cambia una, hay que cambiar la otra, o el Pipeline y el
   Dashboard dan numeros distintos para el mismo mes.                       */
function despachoEn(k, dentro, ganada) {
    return k.some(x => x.etapa === ganada && dentro(aMs(x.en)));
}

function desistioEn(k, dentro, ganada) {
    const enV = k.filter(x => dentro(aMs(x.en)));
    return enV.some(x => x.etapa !== ganada &&
        !enV.some(y => y.etapa === ganada && aMs(y.en) > aMs(x.en)));
}

// Fecha calendario de Bogota de un instante, como Date cuyos getters UTC
// devuelven la hora local. Solo para leer ano/mes/dia, nunca para comparar.
function local(ms) {
    return new Date(ms + TZ_BOGOTA);
}

function esInicioDeMes(ms) {
    const d = local(ms);
    return d.getUTCDate() === 1 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 &&
        d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

// Corre un instante k meses de calendario, en hora de Colombia. El dia se
// recorta al ultimo del mes destino: el 31 de octubre menos un mes es el 30
// de septiembre, no el 1 de octubre.
function sumarMeses(ms, k) {
    const d = local(ms);
    const a = d.getUTCFullYear(), m = d.getUTCMonth() + k;
    const ultimo = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
    return Date.UTC(a, m, Math.min(d.getUTCDate(), ultimo),
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()) - TZ_BOGOTA;
}

/* La ventana contra la que se compara.

   Si el periodo arranca el 1 de un mes, se compara contra los MISMOS dias de
   los meses anteriores: octubre contra septiembre, y "octubre hasta el 27"
   contra "septiembre hasta el 27". Una ventana del mismo largo inmediatamente
   antes daria del 31 de agosto al 30 de septiembre, que no es un mes de nada,
   y comparar un mes a medias contra uno entero haria que todo mes en curso
   pareciera una caida. Cualquier otro rango se compara contra el tramo del
   mismo largo justo antes.                                                 */
function ventanaAnterior(desde, hasta) {
    if (!desde) return null;
    if (esInicioDeMes(desde)) {
        const d = local(desde), h = local(hasta);
        let k = (h.getUTCFullYear() * 12 + h.getUTCMonth()) - (d.getUTCFullYear() * 12 + d.getUTCMonth());
        if (!esInicioDeMes(hasta)) k++;
        k = Math.max(1, k);
        return { desde: sumarMeses(desde, -k), hasta: sumarMeses(hasta, -k) };
    }
    return { desde: desde - (hasta - desde), hasta: desde };
}

// La etapa en la que estaba una tarjeta en el instante `t`, reconstruida del
// historial. Cada entrada guarda de donde salio (`desde`) y a donde fue
// (`etapa`), asi que antes del primer salto registrado estaba en el `desde`
// de ese salto — tambien cuando el historial ya se recorto a los ultimos 50.
function etapaEn(chat, t) {
    const h = (chat.historial || []).filter(x => Number.isFinite(aMs(x.en)) && x.etapa);
    if (!h.length) return chat.etapa;
    let etapa = h[0].desde || 'sin_asignar';
    for (const x of h) {
        if (aMs(x.en) >= t) break;
        etapa = x.etapa;
    }
    return etapa;
}

/* Todos los indicadores en una pasada.

   La ventana se da con `desde`/`hasta` (ms, hasta exclusivo) o, si no vienen,
   con `dias` hacia atras desde `ahora` (0 = todo el historico). Acota lo que
   PASO —leads, conversion, ciclo, la serie y cuanto tarda cada etapa— y se
   compara contra ventanaAnterior().

   El embudo es una FOTO, y una foto no se filtra por fecha: esconder las
   tarjetas viejas taparia justo las que hay que mirar. Lo que hace el periodo
   es mover el instante de la foto: si la ventana termina en el pasado, el
   embudo se reconstruye como estaba al cierre (etapaEn()). Lo que solo existe
   hoy —estancadas, operacion, la ventana de 24 h— no tiene foto historica y
   va siempre con `ahora`. Los grupos van separados en la respuesta para que
   el panel no pueda rotular uno como el otro.                              */
function resumen({ chats = [], etapas = [], dias = 90, desde: d0, hasta: h0, ahora = Date.now() } = {}) {
    const rango = Number.isFinite(d0) && Number.isFinite(h0);
    const desde = rango ? d0 : (dias > 0 ? ahora - dias * MS_DIA : 0);
    // Un periodo que termina en el futuro (el mes en curso) se corta en hoy:
    // si no, la comparacion contra el mes anterior pondria un mes a medias
    // contra uno entero.
    const hasta = rango ? Math.min(h0, ahora) : ahora;
    const anterior = ventanaAnterior(desde, hasta);
    // Si el periodo cierra antes de hoy, el embudo se mira en ese cierre.
    const corte = hasta < ahora ? hasta : null;

    const terminales = new Set(etapas.filter(e => e.terminal).map(e => e.clave));

    const enVentana = t => t >= desde && (rango ? t < hasta : true);
    const enVentanaAnterior = t => !!anterior && t >= anterior.desde && t < anterior.hasta;

    const leads = chats.filter(c => enVentana(aMs(c.startedAt)));
    const leadsAntes = chats.filter(c => enVentanaAnterior(aMs(c.startedAt)));

    /* --- Conversion ----------------------------------------------------
       Leads que LLEGARON en el periodo contra tarjetas que se DESPACHARON en
       el periodo, cada cosa por su propia fecha. Es lo que se mira cada mes:
       "entraron 300, despachamos 5". El despacho de un lead de septiembre
       hecho en octubre es de octubre, y por eso esta tasa puede pasar de 100%
       en un mes flojo de leads tras uno bueno; no es un error.

       Los cierres salen de cierres(): una venta de septiembre sigue siendo de
       septiembre aunque la tarjeta se reabra despues, y un arrastre deshecho
       en minutos no cuenta. "Ganado" es la terminal `despachado` del catalogo;
       las demas terminales son perdidas.                                   */
    const claveGanada = 'despachado';
    const claves = etapas.filter(e => e.terminal).map(e => e.clave);
    const conCierres = chats.map(c => ({
        c, k: cierres(c.historial, claves, { etapa: c.etapa, cerradoEn: c.cerradoEn })
    }));
    const ganados = conCierres.filter(({ k }) => despachoEn(k, enVentana, claveGanada)).length;
    const perdidos = conCierres.filter(({ k }) => desistioEn(k, enVentana, claveGanada)).length;
    const ganadosAntes = conCierres.filter(({ k }) => despachoEn(k, enVentanaAnterior, claveGanada)).length;

    /* Ciclo de venta: del primer mensaje al PRIMER despacho, para las ventas
       cuyo primer despacho cae en el periodo. El segundo pedido de un cliente
       que volvio no entra: mediria desde el primer mensaje de hace meses y no
       cuanto tardo esa venta.                                              */
    const ciclos = conCierres.map(({ c, k }) => {
        const primero = k.find(x => x.etapa === claveGanada);
        const fin = primero ? aMs(primero.en) : NaN;
        const ini = aMs(c.startedAt);
        return enVentana(fin) && Number.isFinite(ini) ? (fin - ini) / MS_DIA : NaN;
    });

    /* --- Serie diaria --------------------------------------------------
       Un punto por dia del periodo, y NUNCA antes del primer lead: doce meses
       fijos llenarian la grafica de barras vacias que solo dicen que el bot no
       existia. El panel agrupa esta misma serie por semana o por mes, asi que
       cambiar de granularidad no vuelve a pedirle nada al servidor.        */
    const inicios = chats.map(c => aMs(c.startedAt)).filter(Number.isFinite);
    const serie = [];
    if (inicios.length) {
        // El recorrido va de dia local a dia local: se avanza sobre la
        // medianoche de Bogota (05:00 UTC), no sobre la de UTC, para que
        // ningun dia salga partido en dos.
        const primero = local(Math.max(Math.min(...inicios), desde));
        primero.setUTCHours(0, 0, 0, 0);
        const dias0 = new Date(primero.getTime() - TZ_BOGOTA);
        const buckets = {};
        for (const c of chats) {
            if (!enVentana(aMs(c.startedAt))) continue;
            const k = dia(aMs(c.startedAt));
            if (!buckets[k]) buckets[k] = { dia: k, wa: 0, web: 0 };
            buckets[k][c.collection === 'wa_chats_web' ? 'web' : 'wa']++;
        }
        for (let t = dias0.getTime(); rango ? t < hasta : t <= ahora; t += MS_DIA) {
            const k = dia(t);
            serie.push(buckets[k] || { dia: k, wa: 0, web: 0 });
        }
    }

    /* --- Embudo de hoy -------------------------------------------------
       Mismo criterio que el tablero (ver plBase() en index.html): lo archivado
       sin etapa no cuenta, porque son conversaciones cerradas a mano que
       inflarian "Sin asignar" con ruido. Si los dos criterios se separan, el
       dashboard y el Pipeline empiezan a dar numeros distintos para lo mismo. */
    const enTablero = chats.filter(c => !(c.archivada && c.etapa === 'sin_asignar'));

    // La foto al cierre del periodo: solo las conversaciones que ya existian,
    // cada una en la etapa en que estaba. Lo archivado se juzga con su estado
    // de hoy, porque `archivedAt` se borra al desarchivar y no deja historia.
    const foto = corte === null ? enTablero : chats
        .filter(c => aMs(c.startedAt) < corte)
        .map(c => ({ ...c, etapa: etapaEn(c, corte) }))
        .filter(c => !(c.archivada && c.etapa === 'sin_asignar'));
    const embudo = etapas.map(e => ({
        clave: e.clave,
        nombre: e.nombre,
        terminal: !!e.terminal,
        n: foto.filter(c => c.etapa === e.clave).length
    }));
    const activas = foto.filter(c => !terminales.has(c.etapa)).length;

    /* --- Cuanto tarda cada etapa ---------------------------------------
       Solo saltos ya ocurridos (ver recorrido()). Es la pregunta de "donde se
       atasca el embudo", que es distinta de "cuantos hay parados ahi ahora".
       Del periodo cuentan los saltos que OCURRIERON en el: una etapa que se
       termino en octubre es de octubre, aunque hubiera empezado en septiembre. */
    const duraciones = {};
    for (const c of chats) {
        const pasos = recorrido(c);
        for (let i = 0; i < pasos.length - 1; i++) {
            const fin = pasos[i + 1].en;
            if (fin < desde || (rango && fin >= hasta)) continue;
            const d = (fin - pasos[i].en) / MS_DIA;
            if (!Number.isFinite(d) || d < 0) continue;
            (duraciones[pasos[i].etapa] = duraciones[pasos[i].etapa] || []).push(d);
        }
    }
    const tiempoPorEtapa = etapas
        .filter(e => !e.terminal)
        .map(e => ({
            clave: e.clave,
            nombre: e.nombre,
            dias: mediana(duraciones[e.clave] || []),
            muestras: (duraciones[e.clave] || []).length
        }));

    /* --- Lo que hay que mirar hoy -------------------------------------- */
    const estancadas = enTablero
        .filter(c => !terminales.has(c.etapa))
        .map(c => {
            // Una tarjeta que nadie movio nunca lleva parada desde que entro
            // la conversacion, no desde una fecha que no existe.
            const desdeMs = aMs(c.etapaDesde) || aMs(c.startedAt);
            return { ...c, diasQuieta: Number.isFinite(desdeMs) ? (ahora - desdeMs) / MS_DIA : null };
        })
        .filter(c => c.diasQuieta !== null && c.diasQuieta >= DIAS_ESTANCADA)
        .sort((a, b) => b.diasQuieta - a.diasQuieta);

    const sinArchivar = chats.filter(c => !c.archivada);

    return {
        periodo: {
            dias: rango ? null : (dias > 0 ? dias : null),
            desde: desde ? new Date(desde).toISOString() : null,
            hasta: new Date(hasta).toISOString(),
            anterior: anterior ? {
                desde: new Date(anterior.desde).toISOString(),
                hasta: new Date(anterior.hasta).toISOString()
            } : null,
            // Instante de la foto del embudo; null = ahora.
            corte: corte === null ? null : new Date(corte).toISOString(),
            // Con esto el panel arma la lista de meses sin ofrecer los que
            // son anteriores al bot.
            primerLead: inicios.length ? new Date(Math.min(...inicios)).toISOString() : null
        },

        // Lo que PASO en la ventana
        leads: {
            total: leads.length,
            anterior: leadsAntes.length,
            variacion: variacion(leads.length, leadsAntes.length),
            whatsapp: leads.filter(c => c.collection !== 'wa_chats_web').length,
            web: leads.filter(c => c.collection === 'wa_chats_web').length
        },
        conversion: {
            // Despachados y desistidos DEL PERIODO, por la fecha del cierre.
            ganados,
            perdidos,
            // Leads del periodo que hoy siguen sin cerrar.
            enCurso: leads.filter(c => !terminales.has(c.etapa)).length,
            // Despachados del periodo por cada 100 leads que llegaron en el.
            tasa: leads.length ? Math.round((ganados / leads.length) * 1000) / 10 : null,
            // De lo que se cerro en el periodo, cuanto se gano. Es la que no se
            // hunde por tener el embudo lleno de conversaciones abiertas.
            cierre: (ganados + perdidos) ? Math.round((ganados / (ganados + perdidos)) * 1000) / 10 : null,
            variacion: variacion(ganados, ganadosAntes),
            cicloDias: mediana(ciclos)
        },
        serie,

        // Lo que ES hoy
        embudo,
        activas,
        sinAsignar: enTablero.filter(c => c.etapa === 'sin_asignar').length,
        tiempoPorEtapa,
        estancadas: estancadas.slice(0, TOPE_ESTANCADAS).map(c => ({
            id: c.id, collection: c.collection, nombre: c.nombre, sessionId: c.sessionId,
            etapa: c.etapa, dias: Math.floor(c.diasQuieta)
        })),
        totalEstancadas: estancadas.length,

        operacion: {
            conversaciones: chats.length,
            // El ultimo que hablo fue el cliente: nadie le ha contestado.
            esperandoRespuesta: sinArchivar.filter(c => c.ultimoTipo === 'human').length,
            enManual: chats.filter(c => c.modo === 'manual').length,
            archivadas: chats.filter(c => c.archivada).length,
            // Solo a estas se les puede escribir texto libre (ver la ventana
            // de 24 h en CLAUDE.md).
            ventanaAbierta: chats.filter(c => {
                const t = aMs(c.lastSeen);
                return Number.isFinite(t) && (ahora - t) < MS_DIA;
            }).length,
            mensajes: chats.reduce((s, c) => s + (c.mensajes || 0), 0),
            mensajesDelCliente: chats.reduce((s, c) => s + (c.delCliente || 0), 0),
            archivos: chats.reduce((s, c) => s + (c.archivos || 0), 0)
        },

        umbrales: { diasEstancada: DIAS_ESTANCADA }
    };
}

module.exports = { resumen, ventanaAnterior, cierres, DIAS_ESTANCADA, CORRECCION_MS, TZ_BOGOTA };
