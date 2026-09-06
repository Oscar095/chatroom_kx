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

function alcanzo(chat, clave) {
    if (chat.etapa === clave) return true;
    return (chat.historial || []).some(h => h.etapa === clave);
}

// Cuando la tarjeta llego por primera vez a esa etapa.
function primeraVezEn(chat, clave) {
    const h = (chat.historial || []).find(x => x.etapa === clave);
    return h ? aMs(h.en) : NaN;
}

/* Todos los indicadores en una pasada.

   `dias` acota la ventana de lo que PASO (leads, conversion, ciclo) y se
   compara contra la ventana inmediatamente anterior del mismo tamano. Lo que
   ES hoy —el embudo, lo estancado, lo que espera respuesta— no se acota: un
   embudo filtrado por fecha esconderia justo las tarjetas viejas, que son las
   que hay que mirar. Los dos grupos van separados en la respuesta para que el
   panel no pueda rotular uno como el otro.                                  */
function resumen({ chats = [], etapas = [], dias = 90, ahora = Date.now() } = {}) {
    const ventana = dias > 0 ? dias * MS_DIA : null;
    const desde = ventana ? ahora - ventana : 0;
    const desdeAnterior = ventana ? desde - ventana : 0;

    const terminales = new Set(etapas.filter(e => e.terminal).map(e => e.clave));

    const enPeriodo = c => aMs(c.startedAt) >= desde;
    const enAnterior = c => {
        const t = aMs(c.startedAt);
        return t >= desdeAnterior && t < desde;
    };

    const leads = chats.filter(enPeriodo);
    const leadsAntes = chats.filter(enAnterior);

    /* --- Conversion ----------------------------------------------------
       Se mide sobre los leads del PERIODO y con el historial, no con la etapa
       de hoy: una tarjeta despachada que alguien reabrio siguio siendo una
       venta. "Ganado" es haber llegado a una etapa terminal de exito, que es
       la que el catalogo marca como tal y no una clave escrita aqui.       */
    const ganadores = etapas.filter(e => e.terminal && e.clave === 'despachado').map(e => e.clave);
    const perdedores = etapas.filter(e => e.terminal && e.clave !== 'despachado').map(e => e.clave);

    const gano = c => ganadores.some(k => alcanzo(c, k));
    const perdio = c => !gano(c) && perdedores.some(k => alcanzo(c, k));

    const ganados = leads.filter(gano).length;
    const perdidos = leads.filter(perdio).length;
    const ganadosAntes = leadsAntes.filter(gano).length;

    // Dias entre el primer mensaje del cliente y el cierre en ganado.
    const ciclos = leads.filter(gano).map(c => {
        const fin = ganadores.map(k => primeraVezEn(c, k)).filter(Number.isFinite).sort()[0];
        const ini = aMs(c.startedAt);
        return Number.isFinite(fin) && Number.isFinite(ini) ? (fin - ini) / MS_DIA : NaN;
    });

    /* --- Serie diaria --------------------------------------------------
       Un punto por dia, del primer lead a hoy, y NUNCA antes: doce meses fijos
       llenarian la grafica de barras vacias que solo dicen que el bot no
       existia. El panel agrupa esta misma serie por semana o por mes, asi que
       cambiar de granularidad no vuelve a pedirle nada al servidor.        */
    const inicios = chats.map(c => aMs(c.startedAt)).filter(Number.isFinite);
    const serie = [];
    if (inicios.length) {
        // El recorrido va de dia local a dia local: se avanza sobre la
        // medianoche de Bogota (05:00 UTC), no sobre la de UTC, para que
        // ningun dia salga partido en dos.
        const primero = new Date(Math.min(...inicios) + TZ_BOGOTA);
        primero.setUTCHours(0, 0, 0, 0);
        const dias0 = new Date(primero.getTime() - TZ_BOGOTA);
        const buckets = {};
        for (const c of chats) {
            const t = aMs(c.startedAt);
            if (!Number.isFinite(t)) continue;
            const k = dia(t);
            if (!buckets[k]) buckets[k] = { dia: k, wa: 0, web: 0 };
            buckets[k][c.collection === 'wa_chats_web' ? 'web' : 'wa']++;
        }
        for (let t = dias0.getTime(); t <= ahora; t += MS_DIA) {
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
    const embudo = etapas.map(e => ({
        clave: e.clave,
        nombre: e.nombre,
        terminal: !!e.terminal,
        n: enTablero.filter(c => c.etapa === e.clave).length
    }));
    const activas = enTablero.filter(c => !terminales.has(c.etapa)).length;

    /* --- Cuanto tarda cada etapa ---------------------------------------
       Solo saltos ya ocurridos (ver recorrido()). Es la pregunta de "donde se
       atasca el embudo", que es distinta de "cuantos hay parados ahi ahora". */
    const duraciones = {};
    for (const c of chats) {
        const pasos = recorrido(c);
        for (let i = 0; i < pasos.length - 1; i++) {
            const d = (pasos[i + 1].en - pasos[i].en) / MS_DIA;
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
            dias: dias > 0 ? dias : null,
            desde: ventana ? new Date(desde).toISOString() : null,
            hasta: new Date(ahora).toISOString()
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
            ganados,
            perdidos,
            enCurso: leads.length - ganados - perdidos,
            // De cada 100 que escribieron, cuantos terminaron en pedido.
            tasa: leads.length ? Math.round((ganados / leads.length) * 1000) / 10 : null,
            // De los que YA se definieron, cuantos se ganaron. Es la que no se
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

module.exports = { resumen, DIAS_ESTANCADA };
