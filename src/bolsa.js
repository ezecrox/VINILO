// Juegos → Bolsa de tragos: una "bolsa de valores" simulada con los tragos que se venden en Fudo.
// El precio de cada trago se mueve cada 5 minutos según lo que se vende: si se pide sube, si no se pide baja de a poco
// y siempre tiende a volver a su precio de carta. Es un juego de pantalla: los precios de Fudo no se tocan.
const fudo = require('./fudo');
const { inicioJornada, leerItems } = require('./tablero');

const PASO_MIN = 5;
const IMPACTO = 0.045;     // ventas en 5 min: +4,5 % por 1 unidad, +9 % por 4 (raíz cuadrada: rinde menos cada unidad extra)
const REVERSION = 0.85;    // cada 5 min conserva el 85 % del desvío respecto del precio de carta
const CAIDA = 0.008;       // 5 min sin ventas: baja 0,8 % (sin pedidos se estabiliza ~5 % abajo)
const PISO = 0.7, TECHO = 1.6;
const CACHE_MS = 30000;
const CATEGORIA_RE = /trago|c[oó]ctel|cocktail|coctel/i;

const cache = {}, cacheProd = {};

async function listar(get, path) {
  const out = [];
  for (let p = 1; p <= 20; p++) { const d = await get(path, { 'page[size]': 500, 'page[number]': p, sort: 'id' }); const l = d.data || []; out.push(...l); if (l.length < 500) break; }
  return out;
}
// Tragos de la cuenta: productos de Fudo cuya categoría (o categoría madre) dice "Tragos". Caché 1 h.
async function tragos(cta) {
  const c = cacheProd[cta.id]; if (c && Date.now() - c.t < 3600e3) return c.m;
  const [prods, cats] = await Promise.all([listar(cta.get, '/products'), listar(cta.get, '/product-categories').catch(() => [])]);
  const cat = new Map(cats.map((x) => [String(x.id), { nombre: (x.attributes || {}).name || '', padre: x.relationships && x.relationships.parentCategory && x.relationships.parentCategory.data ? String(x.relationships.parentCategory.data.id) : null }]));
  const esTrago = (cid) => { for (let k = 0, id = cid; id && k < 4; k++) { const c2 = cat.get(String(id)); if (!c2) return false; if (CATEGORIA_RE.test(c2.nombre)) return true; id = c2.padre; } return false; };
  const m = new Map();
  for (const p of prods) {
    const a = p.attributes || {}; const rel = p.relationships && p.relationships.productCategory && p.relationships.productCategory.data;
    if (!rel || !esTrago(rel.id)) continue;
    const precio = Number(a.price); if (!(precio > 0)) continue;
    m.set(String(p.id), { id: String(p.id), nombre: String(a.name || '').trim(), base: precio, activo: a.active !== false });
  }
  cacheProd[cta.id] = { t: Date.now(), m }; return m;
}

const redondeo = (n) => Math.max(100, Math.round(n / 100) * 100);

function simular(prods, items, desde, ahora) {
  const ventas = items.filter((i) => prods.has(String(i.producto)));
  if (!ventas.length) return null;
  // El mercado abre a las 18 h o con la primera venta de tragos si fue antes
  const primera = Math.min(...ventas.map((v) => v.creado.getTime()));
  const apertura18 = new Date(desde.getTime() + 12 * 3600e3).getTime();
  const inicio = Math.floor(Math.min(primera, apertura18) / (PASO_MIN * 60e3)) * PASO_MIN * 60e3;
  const nB = Math.max(1, Math.ceil((ahora.getTime() - inicio) / (PASO_MIN * 60e3)));
  const cant = new Map();
  for (const v of ventas) { const b = Math.min(nB - 1, Math.floor((v.creado.getTime() - inicio) / (PASO_MIN * 60e3))); const id = String(v.producto);
    if (!cant.has(id)) cant.set(id, new Float64Array(nB)); cant.get(id)[b] += v.cantidad || 1; }
  const res = [];
  for (const [id, p] of prods) {
    const q = cant.get(id); if (!q && !p.activo) continue;
    let r = 1; const serie = new Array(nB); let max = 1, min = 1;
    for (let b = 0; b < nB; b++) { const u = q ? q[b] : 0; r = 1 + (r - 1) * REVERSION + IMPACTO * Math.sqrt(u) - (u ? 0 : CAIDA); r = Math.min(TECHO, Math.max(PISO, r)); serie[b] = r; max = Math.max(max, r); min = Math.min(min, r); }
    const hace = (min_) => serie[Math.max(0, nB - 1 - Math.round(min_ / PASO_MIN))];
    const vendidos = q ? q.reduce((s, x) => s + x, 0) : 0, ultHora = q ? q.slice(-12).reduce((s, x) => s + x, 0) : 0;
    res.push({ id, nombre: p.nombre, base: p.base, precio: redondeo(p.base * r), ratio: +r.toFixed(4),
      var_dia: +((r - 1) * 100).toFixed(1), var_30: +((r / hace(30) - 1) * 100).toFixed(1),
      maximo: redondeo(p.base * max), minimo: redondeo(p.base * min), vendidos, ultima_hora: ultHora,
      serie: serie.slice(-36).map((x) => +x.toFixed(4)) });
  }
  // Índice VINILO: promedio de los tragos que operaron hoy, base 1000 a la apertura
  const op = res.filter((x) => x.vendidos > 0);
  const idxSerie = []; for (let b = 0; b < nB; b++) idxSerie.push(0);
  const series = op.map((x) => { const s = []; let r = 1; const q = cant.get(x.id); for (let b = 0; b < nB; b++) { const u = q[b]; r = Math.min(TECHO, Math.max(PISO, 1 + (r - 1) * REVERSION + IMPACTO * Math.sqrt(u) - (u ? 0 : CAIDA))); s.push(r); } return s; });
  for (let b = 0; b < nB; b++) idxSerie[b] = series.length ? (1000 * series.reduce((s, x) => s + x[b], 0)) / series.length : 1000;
  const hora = (b) => new Date(inicio + (b + 1) * PASO_MIN * 60e3).toISOString();
  // Cinta: lo que se pidió en los últimos 15 minutos
  const recientes = new Map();
  for (const v of ventas) if (ahora - v.creado < 15 * 60e3) recientes.set(String(v.producto), (recientes.get(String(v.producto)) || 0) + (v.cantidad || 1));
  return {
    apertura: new Date(inicio).toISOString(),
    indice: { valor: +idxSerie[nB - 1].toFixed(1), var_dia: +((idxSerie[nB - 1] / 1000 - 1) * 100).toFixed(2), var_30: +((idxSerie[nB - 1] / idxSerie[Math.max(0, nB - 7)] - 1) * 100).toFixed(2),
      serie: idxSerie.map((v, b) => ({ t: hora(b), v: +v.toFixed(1) })) },
    tragos: res,
    unidades: ventas.reduce((s, v) => s + (v.cantidad || 1), 0),
    recientes: [...recientes].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n),
  };
}

async function armar(cta, ocultos) {
  const ahora = new Date(); const { desde, fecha } = inicioJornada(ahora);
  const [prods, items] = await Promise.all([tragos(cta), leerItems(cta.get, desde, 10)]);
  const visibles = new Map([...prods].filter(([id]) => !ocultos.has(id)));
  const sim = simular(visibles, items, desde, ahora);
  const base = { jornada: fecha, generado: ahora.toISOString(), cuenta: cta.id, sucursal: cta.nombre, total_tragos: visibles.size };
  if (!sim) return { ...base, abierto: false, tragos: [...visibles.values()].filter((p) => p.activo).map((p) => ({ id: p.id, nombre: p.nombre, base: p.base, precio: redondeo(p.base), ratio: 1, var_dia: 0, var_30: 0, vendidos: 0, ultima_hora: 0, serie: [] })) };
  return { ...base, abierto: true, ...sim };
}

module.exports = function registrarBolsa({ route, query, fail, permitir }) {
  const cuenta = (url) => { const cs = fudo.cuentasTablero(); if (!cs.length) fail(400, 'Fudo no está configurado.'); const id = url.searchParams.get('cuenta'); return cs.find((x) => x.id === id) || cs[0]; };
  const leerOcultos = async (cta) => { const r = (await query('SELECT valor FROM app_config WHERE clave = $1', ['bolsa_ocultos_' + cta.id])).rows[0]; try { return new Set(JSON.parse(r ? r.valor : '[]')); } catch (_) { return new Set(); } };

  route('GET', '/api/bolsa/cuentas', async ({ user }) => { permitir(user, 'juegos'); return fudo.cuentasTablero().map(({ id, nombre }) => ({ id, nombre })); });
  route('GET', '/api/bolsa', async ({ user, url }) => {
    permitir(user, 'juegos');
    const cta = cuenta(url); const ch = cache[cta.id];
    if (ch && Date.now() - ch.t < CACHE_MS) return ch.datos;
    try { const datos = await armar(cta, await leerOcultos(cta)); cache[cta.id] = { t: Date.now(), datos }; return datos; }
    catch (e) { if (ch) return { ...ch.datos, desactualizado: true }; fail(502, `No se pudieron leer las ventas de Fudo de ${cta.nombre}: ${e.message}`); }
  });
  // Configuración: qué tragos no se muestran (solo ADMIN)
  route('GET', '/api/bolsa/config', async ({ user, url }) => {
    if (user.rol !== 'ADMIN') fail(403, 'Solo el administrador configura la bolsa');
    const cta = cuenta(url); const ocultos = await leerOcultos(cta);
    return [...(await tragos(cta)).values()].sort((a, b) => a.nombre.localeCompare(b.nombre)).map((p) => ({ ...p, oculto: ocultos.has(p.id) }));
  });
  route('PUT', '/api/bolsa/config', async ({ user, url, body }) => {
    if (user.rol !== 'ADMIN') fail(403, 'Solo el administrador configura la bolsa');
    const cta = cuenta(url); const ids = Array.isArray(body && body.ocultos) ? body.ocultos.map(String).slice(0, 1000) : [];
    await query('INSERT INTO app_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor', ['bolsa_ocultos_' + cta.id, JSON.stringify(ids)]);
    delete cache[cta.id]; return { ok: true, ocultos: ids.length };
  });
};
module.exports.simular = simular;
