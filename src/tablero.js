// Tablero en vivo del bar con datos de Fudo: mesas, comensales, ventas de la jornada, evolución y top de productos.
// Lectura tolerante: Fudo (JSON:API v1alpha1) puede variar nombres de atributos; se prueban alternativas.
const fudo = require('./fudo');
const TZ = 'America/Argentina/Buenos_Aires';
const CORTE = 6;          // la jornada arranca a las 6 h (el cierre de madrugada cuenta para el día anterior)
const PASO_MIN = 15;      // resolución de la curva
const CACHE_MS = 30e3;

const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const relId = (x, rel) => { const r = x.relationships && x.relationships[rel]; const d = r && r.data; return d && !Array.isArray(d) ? String(d.id) : null; };
const relIds = (x, rel) => { const r = x.relationships && x.relationships[rel]; const d = r && r.data; return Array.isArray(d) ? d.map((y) => String(y.id)) : d ? [String(d.id)] : []; };

function inicioJornada(ahora = new Date()) {
  const hoy = ahora.toLocaleDateString('en-CA', { timeZone: TZ });
  const h = Number(ahora.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
  const fecha = h >= CORTE ? hoy : new Date(Date.parse(hoy + 'T12:00:00Z') - 86400e3).toISOString().slice(0, 10);
  return { fecha, desde: new Date(`${fecha}T0${CORTE}:00:00-03:00`) };
}

// ---- Normalización de una venta ----
function venta(s) {
  const a = s.attributes || {};
  const estado = String(pick(a, 'saleState', 'state', 'status') || '').toUpperCase();
  const tipo = String(pick(a, 'saleType', 'type', 'kind') || '').toUpperCase();
  const creada = new Date(pick(a, 'createdAt', 'openedAt', 'created_at'));
  const cerrada = pick(a, 'closedAt', 'closed_at') ? new Date(pick(a, 'closedAt', 'closed_at')) : null;
  return {
    id: String(s.id), estado, tipo,
    cerrada_ok: /CLOSE/.test(estado), anulada: /CANCEL/.test(estado),
    abierta: !/CLOSE|CANCEL/.test(estado) && !cerrada,
    total: num(pick(a, 'total', 'totalAmount', 'amount')),
    personas: num(pick(a, 'people', 'guests', 'diners', 'covers', 'peopleCount')),
    creada: Number.isNaN(creada.getTime()) ? null : creada, cerrada: cerrada && !Number.isNaN(cerrada.getTime()) ? cerrada : null,
    mesa: relId(s, 'table'), mozo: relId(s, 'waiter'), cliente: pick(a, 'customerName', 'anonymousCustomerName') || null,
  };
}
const esSalon = (v) => !!v.mesa || /EAT|SALON|IN_SITE|TABLE|MESA/.test(v.tipo) || !v.tipo;
const tipoNombre = (t) => (/DELIVER/.test(t) ? 'Delivery' : /TAKE|AWAY|LLEVAR|COUNTER|MOSTRADOR/.test(t) ? 'Para llevar' : /EAT|SALON|TABLE|MESA|IN/.test(t) || !t ? 'Salón' : t);

// ---- Lecturas a Fudo ----
async function leerMesas() {
  let data;
  try { data = await fudo.fudoGet('/tables', { 'page[size]': 500, include: 'activeSales,room' }); }
  catch (e) { if (/HTTP 400/.test(e.message)) data = await fudo.fudoGet('/tables', { 'page[size]': 500, include: 'room' }); else throw e; }
  const inc = data.included || [];
  const salas = new Map(inc.filter((x) => x.type === 'Room').map((r) => [String(r.id), (r.attributes || {}).name || `Salón ${r.id}`]));
  const activas = new Map(inc.filter((x) => x.type === 'Sale').map((s) => [String(s.id), s]));
  const mesas = (data.data || []).map((t) => {
    const a = t.attributes || {};
    const ids = relIds(t, 'activeSales');
    return { id: String(t.id), numero: pick(a, 'number', 'name') ?? t.id, sala_id: relId(t, 'room'), fila: num(a.row), columna: num(a.column),
      forma: String(a.shape ?? '0'), tam: a.size || 's', ventas: ids.map((i) => activas.get(i)).filter(Boolean) };
  });
  // Si Fudo no vincula activeSales en la mesa, se asocian por la relación table de la venta
  for (const s of activas.values()) { const m = relId(s, 'table'); const mesa = mesas.find((x) => x.id === m); if (mesa && !mesa.ventas.includes(s)) mesa.ventas.push(s); }
  return { mesas, salas: [...salas].map(([id, nombre]) => ({ id, nombre })), activas: [...activas.values()] };
}

async function leerVentas(desde, hasta = null, maxPag = 12) {
  const out = [];
  for (let p = 1; p <= maxPag; p++) {
    const d = await fudo.fudoGet('/sales', { 'page[size]': 500, 'page[number]': p, sort: '-createdAt' });
    const lote = d.data || [];
    let viejo = null;
    for (const s of lote) { const v = venta(s); if (!v.creada) continue; viejo = v.creada; if (v.creada >= desde && (!hasta || v.creada < hasta)) out.push(v); }
    if (lote.length < 500 || (viejo && viejo < desde)) break;
  }
  return out;
}

async function leerItems(desde, maxPag = 6) {
  const out = [];
  for (let p = 1; p <= maxPag; p++) {
    const d = await fudo.fudoGet('/items', { 'page[size]': 500, 'page[number]': p, sort: '-createdAt' });
    const lote = d.data || [];
    let viejo = null;
    for (const it of lote) {
      const a = it.attributes || {}; const f = new Date(a.createdAt); if (Number.isNaN(f.getTime())) continue; viejo = f;
      if (f >= desde && !(a.canceled === true || a.cancelled === true)) out.push({ producto: relId(it, 'product'), venta: relId(it, 'sale'), cantidad: num(pick(a, 'quantity', 'qty') ?? 1), precio: num(pick(a, 'price', 'unitPrice')), creado: f });
    }
    if (lote.length < 500 || (viejo && viejo < desde)) break;
  }
  return out;
}

// ---- Cálculos ----
function serie(ventas, desde, hasta) {
  const pts = [];
  const inicio = new Date(Math.ceil(desde.getTime() / (PASO_MIN * 60e3)) * PASO_MIN * 60e3);
  for (let t = inicio.getTime(); t <= hasta.getTime(); t += PASO_MIN * 60e3) {
    const abiertas = ventas.filter((v) => !v.anulada && esSalon(v) && v.creada && v.creada.getTime() <= t && (!v.cerrada || v.cerrada.getTime() > t) && (v.cerrada || v.abierta));
    pts.push({ t: new Date(t).toISOString(), comensales: abiertas.reduce((s, v) => s + v.personas, 0), mesas: new Set(abiertas.map((v) => v.mesa || v.id)).size });
  }
  return pts;
}
function porHora(ventas, desde, hasta) {
  const h = new Map();
  for (let t = new Date(desde); t <= hasta; t = new Date(t.getTime() + 3600e3)) {
    const k = Number(t.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24; h.set(k, { hora: k, ventas: 0, tickets: 0, comensales: 0 });
  }
  for (const v of ventas) {
    if (v.anulada || !v.creada) continue;
    const k = Number(v.creada.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
    const x = h.get(k); if (!x) continue;
    x.ventas += v.total; x.tickets++; x.comensales += v.personas;
  }
  return [...h.values()];
}

let cache = { t: 0, datos: null, err: null };
let cacheComp = { fecha: null, datos: null };
const nombresProd = async (query) => {
  const { rows } = await query("SELECT fudo_id, nombre FROM productos WHERE fudo_id IS NOT NULL");
  return new Map(rows.map((r) => [String(r.fudo_id), r.nombre]));
};

async function armar(query) {
  const ahora = new Date();
  const { fecha, desde } = inicioJornada(ahora);
  const [m, ventas, items, prods] = await Promise.all([leerMesas(), leerVentas(desde), leerItems(desde).catch(() => []), nombresProd(query)]);
  // ventas abiertas que empezaron antes de la jornada (mesa de la noche anterior) también cuentan como activas
  const activasNorm = m.activas.map(venta);
  for (const a of activasNorm) if (!ventas.some((v) => v.id === a.id)) ventas.push(a);
  const validas = ventas.filter((v) => !v.anulada);
  const abiertas = validas.filter((v) => v.abierta);
  const cerradas = validas.filter((v) => v.cerrada_ok || (v.cerrada && !v.abierta));
  const salon = validas.filter(esSalon);
  const mesasOcup = m.mesas.filter((t) => t.ventas.some((s) => venta(s).abierta || !venta(s).cerrada));
  const ocupIds = new Set(mesasOcup.map((t) => t.id));
  // comensales: de las ventas activas en salón
  const comensalesAhora = abiertas.filter(esSalon).reduce((s, v) => s + v.personas, 0);
  const totCerradas = cerradas.reduce((s, v) => s + v.total, 0), totAbiertas = abiertas.reduce((s, v) => s + v.total, 0);
  const persCerradas = cerradas.filter(esSalon).reduce((s, v) => s + v.personas, 0);
  const permanencias = cerradas.filter((v) => esSalon(v) && v.creada && v.cerrada).map((v) => (v.cerrada - v.creada) / 60e3).filter((x) => x > 2 && x < 600);
  const mix = {};
  for (const v of validas) { const k = tipoNombre(v.tipo); mix[k] = mix[k] || { tipo: k, tickets: 0, total: 0 }; mix[k].tickets++; mix[k].total += v.total; }
  const top = new Map();
  for (const it of items) { const k = it.producto || '?'; const x = top.get(k) || { producto: prods.get(k) || `Producto Fudo #${k}`, cantidad: 0, importe: 0 }; x.cantidad += it.cantidad; x.importe += it.cantidad * it.precio; top.set(k, x); }
  const mapa = m.mesas.map((t) => {
    const vs = t.ventas.map(venta).filter((v) => !v.anulada);
    const v0 = vs.sort((a, b) => (a.creada || 0) - (b.creada || 0))[0];
    return { id: t.id, numero: t.numero, sala_id: t.sala_id, fila: t.fila, columna: t.columna, forma: t.forma, tam: t.tam, ocupada: ocupIds.has(t.id),
      personas: vs.reduce((s, v) => s + v.personas, 0), total: vs.reduce((s, v) => s + v.total, 0), desde: v0 && v0.creada ? v0.creada.toISOString() : null,
      minutos: v0 && v0.creada ? Math.round((ahora - v0.creada) / 60e3) : null };
  });
  const largas = mapa.filter((x) => x.ocupada && x.minutos >= 150).sort((a, b) => b.minutos - a.minutos);
  const ser = serie(validas, new Date(Math.max(desde.getTime(), Math.min(...validas.map((v) => (v.creada ? v.creada.getTime() : Infinity)), ahora.getTime()) - PASO_MIN * 60e3)), ahora);
  const pico = ser.reduce((b, p) => (p.comensales > b.comensales ? p : b), { comensales: 0, t: null });
  return {
    jornada: fecha, desde: desde.toISOString(), actualizado: ahora.toISOString(),
    kpi: {
      mesas_ocupadas: mesasOcup.length, mesas_total: m.mesas.length, comensales: comensalesAhora,
      ventas_cerradas: Math.round(totCerradas), ventas_abiertas: Math.round(totAbiertas), tickets_cerrados: cerradas.length, tickets_abiertos: abiertas.length,
      ticket_promedio: cerradas.length ? Math.round(totCerradas / cerradas.length) : 0,
      por_comensal: persCerradas ? Math.round(cerradas.filter(esSalon).reduce((s, v) => s + v.total, 0) / persCerradas) : 0,
      comensales_jornada: salon.reduce((s, v) => s + v.personas, 0), permanencia_min: permanencias.length ? Math.round(permanencias.reduce((a, b) => a + b, 0) / permanencias.length) : null,
      pico_comensales: pico.comensales, pico_hora: pico.t,
    },
    salas: m.salas, mapa, largas: largas.slice(0, 6),
    serie: ser,
    por_hora: porHora(validas, desde, ahora).filter((x, i, arr) => arr.slice(0, i + 1).some((y) => y.tickets) || x.tickets),
    mix: Object.values(mix).sort((a, b) => b.total - a.total),
    top: [...top.values()].sort((a, b) => b.cantidad - a.cantidad).slice(0, 8),
    personas_informadas: validas.some((v) => v.personas > 0),
  };
}

// Comparación con el mismo día de la semana anterior, hasta la misma hora (se cachea por jornada)
async function comparacion() {
  const ahora = new Date();
  const { fecha, desde } = inicioJornada(ahora);
  const d0 = new Date(desde.getTime() - 7 * 86400e3), hasta = new Date(ahora.getTime() - 7 * 86400e3);
  if (!cacheComp.datos || cacheComp.fecha !== fecha) {
    const vs = (await leerVentas(d0, new Date(d0.getTime() + 24 * 3600e3), 30)).filter((v) => !v.anulada);
    cacheComp = { fecha, datos: vs };
  }
  const vs = cacheComp.datos;
  const hastaAhora = vs.filter((v) => v.creada && v.creada <= hasta);
  return {
    fecha: d0.toISOString().slice(0, 10),
    ventas_a_esta_hora: Math.round(hastaAhora.reduce((s, v) => s + v.total, 0)), tickets_a_esta_hora: hastaAhora.length,
    comensales_a_esta_hora: hastaAhora.filter(esSalon).reduce((s, v) => s + v.personas, 0),
    ventas_total_dia: Math.round(vs.reduce((s, v) => s + v.total, 0)),
    serie: serie(vs, d0, new Date(d0.getTime() + 24 * 3600e3 - 1)).map((p) => ({ ...p, t: new Date(new Date(p.t).getTime() + 7 * 86400e3).toISOString() })),
  };
}

// Diagnóstico al arrancar: registra qué atributos devuelve Fudo (solo nombres y valores de estado, sin datos personales)
async function diagnostico() {
  try {
    const s = await fudo.fudoGet('/sales', { 'page[size]': 5, sort: '-createdAt' });
    const x = (s.data || [])[0];
    const t = await fudo.fudoGet('/tables', { 'page[size]': 3, include: 'activeSales,room' }).catch((e) => ({ error: e.message }));
    console.log('Tablero/Fudo diagnóstico:', JSON.stringify({
      venta_atributos: x ? Object.keys(x.attributes || {}) : [], venta_relaciones: x ? Object.keys(x.relationships || {}) : [],
      estados: [...new Set((s.data || []).map((v) => (v.attributes || {}).saleState))], tipos: [...new Set((s.data || []).map((v) => (v.attributes || {}).saleType))],
      personas_ej: (s.data || []).map((v) => (v.attributes || {}).people),
      mesa_atributos: t.data && t.data[0] ? Object.keys(t.data[0].attributes || {}) : t.error, mesa_relaciones: t.data && t.data[0] ? Object.keys(t.data[0].relationships || {}) : null,
      mesas: t.data ? t.data.length : null, incluidos: t.included ? [...new Set(t.included.map((i) => i.type))] : null,
    }));
  } catch (e) { console.warn('Tablero/Fudo diagnóstico falló:', e.message); }
}

module.exports = function registrarTablero({ route, query, fail, permitir }) {
  if (fudo.configurado()) setTimeout(diagnostico, 8000);
  route('GET', '/api/tablero', async ({ user }) => {
    permitir(user, 'tablero');
    if (!fudo.configurado()) fail(400, 'Fudo no está configurado: cargá FUDO_API_KEY y FUDO_API_SECRET.');
    if (cache.datos && Date.now() - cache.t < CACHE_MS) return { ...cache.datos, cache: true };
    try { const datos = await armar(query); cache = { t: Date.now(), datos }; return datos; }
    catch (e) {
      if (cache.datos) return { ...cache.datos, desactualizado: true, error_fudo: e.message };
      fail(502, 'No se pudieron leer los datos de Fudo: ' + e.message);
    }
  });
  route('GET', '/api/tablero/comparacion', async ({ user }) => {
    permitir(user, 'tablero');
    if (!fudo.configurado()) fail(400, 'Fudo no está configurado');
    try { return await comparacion(); } catch (e) { fail(502, 'No se pudo leer la semana anterior: ' + e.message); }
  });
};
module.exports.inicioJornada = inicioJornada;
