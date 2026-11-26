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
const CACHE_MS = 20000;
const MERCADOS = { tragos: { nombre: 'Tragos', re: /trago|c[oó]ctel|cocktail|coctel/i }, pizzas: { nombre: 'Pizzas', re: /pizza/i } };
const mercadoDe = (m) => (MERCADOS[m] ? m : 'tragos');

const cache = {}, cacheProd = {};

async function listar(get, path) {
  const out = [];
  for (let p = 1; p <= 20; p++) { const d = await get(path, { 'page[size]': 500, 'page[number]': p, sort: 'id' }); const l = d.data || []; out.push(...l); if (l.length < 500) break; }
  return out;
}
// Productos de la cuenta que entran en algún mercado según su categoría (o categoría madre) de Fudo. Caché 1 h.
async function productosMercado(cta) {
  const c = cacheProd[cta.id]; if (c && Date.now() - c.t < 3600e3) return c.m;
  const [prods, cats] = await Promise.all([listar(cta.get, '/products'), listar(cta.get, '/product-categories').catch(() => [])]);
  const cat = new Map(cats.map((x) => [String(x.id), { nombre: (x.attributes || {}).name || '', padre: x.relationships && x.relationships.parentCategory && x.relationships.parentCategory.data ? String(x.relationships.parentCategory.data.id) : null }]));
  const mercadoCat = (cid) => { for (let k = 0, id = cid; id && k < 4; k++) { const c2 = cat.get(String(id)); if (!c2) return null; for (const [m, def] of Object.entries(MERCADOS)) if (def.re.test(c2.nombre)) return m; id = c2.padre; } return null; };
  const m = new Map();
  for (const p of prods) {
    const a = p.attributes || {}; const rel = p.relationships && p.relationships.productCategory && p.relationships.productCategory.data;
    const merc = rel ? mercadoCat(rel.id) : null; if (!merc) continue;
    const precio = Number(a.price); if (!(precio > 0)) continue;
    m.set(String(p.id), { id: String(p.id), nombre: String(a.name || '').trim(), base: precio, activo: a.active !== false, mercado: merc });
  }
  cacheProd[cta.id] = { t: Date.now(), m }; return m;
}
const deMercado = (todos, merc) => new Map([...todos].filter(([, p]) => p.mercado === merc));

// CRASH: factor que multiplica todos los precios. Cae de golpe, se mantiene y se recupera en 10 minutos al terminar.
function factorCrash(crash, t) {
  if (!crash) return 1;
  const d = new Date(crash.desde).getTime(), h = new Date(crash.hasta).getTime(), k = crash.caida / 100;
  const bajada = (x) => (x < d ? 1 : 1 - k);
  if (t <= h) return bajada(t);
  // Recuperación desde donde quedó al terminar (si se cortó antes de tocar fondo, se recupera desde ahí)
  if (t < h + 10 * 60e3) return 1 - (1 - bajada(h)) * (1 - (t - h) / (10 * 60e3));
  return 1;
}

const redondeo = (n) => Math.max(100, Math.round(n / 100) * 100);

function simular(prods, items, desde, ahora, crash = null) {
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
    for (let b = 0; b < nB; b++) { serie[b] *= factorCrash(crash, Math.min(ahora.getTime(), inicio + (b + 1) * PASO_MIN * 60e3)); max = Math.max(max, serie[b]); min = Math.min(min, serie[b]); }
    r = serie[nB - 1];
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
  const series = op.map((x) => { const s = []; let r = 1; const q = cant.get(x.id); for (let b = 0; b < nB; b++) { const u = q[b]; r = Math.min(TECHO, Math.max(PISO, 1 + (r - 1) * REVERSION + IMPACTO * Math.sqrt(u) - (u ? 0 : CAIDA))); s.push(r * factorCrash(crash, Math.min(ahora.getTime(), inicio + (b + 1) * PASO_MIN * 60e3))); } return s; });
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

// ---- Modo demo: ventas inventadas (siempre las mismas para cada momento) sobre los productos reales de Fudo ----
function hashTxt(t) { let h = 2166136261; for (const c of String(t)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rngDe(sem) { let x = sem >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
function ventasDemo(todos, ahora) {
  const SLOT = 12e3, HORAS = 4, fin = Math.floor(ahora.getTime() / SLOT), ini = fin - (HORAS * 3600e3) / SLOT;
  const lista = [...todos.values()].filter((p) => p.activo);
  // Popularidad fija por producto (unos pocos muy pedidos, el resto poco)
  const peso = lista.map((p) => { const r = rngDe(hashTxt(p.id + 'pop'))(); return p.mercado === 'pizzas' ? 0.4 + r * 1.2 : Math.pow(r, 3) * 6 + 0.15; });
  const total = peso.reduce((a, b) => a + b, 0);
  const elegir = (r) => { let x = r * total; for (let i = 0; i < lista.length; i++) { x -= peso[i]; if (x <= 0) return lista[i]; } return lista[lista.length - 1]; };
  const out = [];
  for (let k = ini; k < fin; k++) {
    const t = k * SLOT, p = (k - ini) / (fin - ini), r = rngDe(hashTxt('s' + k));
    const carga = 0.3 + 0.7 * Math.min(1, p * 1.6);       // la noche se va llenando y ahora está en el pico
    const caliente = lista.length ? lista[rngDe(hashTxt('h' + Math.floor(k / 45)))() * lista.length | 0] : null; // un "boom" distinto cada 15 min
    const n = r() < carga * 0.85 ? (r() < 0.25 ? 2 : 1) : 0;
    for (let j = 0; j < n; j++) {
      const prod = caliente && caliente.mercado === 'tragos' && r() < 0.22 ? caliente : elegir(r());
      out.push({ id: `demo-${k}-${j}`, producto: prod.id, venta: 'demo', cantidad: r() < 0.15 ? 2 : 1, precio: prod.base, creado: new Date(t + r() * SLOT) });
    }
  }
  return out;
}

async function armar(cta, merc, ocultos, crash, demo = false) {
  const ahora = new Date(); const { desde, fecha } = inicioJornada(ahora);
  const todos = await productosMercado(cta);
  const items = demo ? ventasDemo(todos, ahora).filter((i) => i.creado <= ahora) : await leerItems(cta.get, desde, 10);
  const desdeSim = demo ? new Date(ahora.getTime() - 4 * 3600e3 - 12 * 3600e3) : desde; // en demo la "noche" empezó hace 4 h
  const visibles = new Map([...deMercado(todos, merc)].filter(([id]) => !ocultos.has(id)));
  const crashVivo = crash && ahora.getTime() < new Date(crash.hasta).getTime() + 10 * 60e3 ? crash : null;
  const sim = simular(visibles, items, desdeSim, ahora, crashVivo);
  // Ventas de los últimos 10 minutos de cualquier mercado (para las animaciones de la pantalla)
  const recientes = items.filter((i) => ahora - i.creado < 10 * 60e3 && todos.has(String(i.producto)))
    .map((i) => { const p = todos.get(String(i.producto)); return { id: i.id || `${i.venta}-${i.producto}-${i.creado.getTime()}`, mercado: p.mercado, nombre: p.nombre, cantidad: i.cantidad || 1, t: i.creado.toISOString() }; })
    .sort((x, y) => x.t.localeCompare(y.t)).slice(-40);
  const enCrash = crashVivo && ahora.getTime() <= new Date(crashVivo.hasta).getTime() ? crashVivo : null;
  const base = { demo, jornada: fecha, generado: ahora.toISOString(), cuenta: cta.id, sucursal: cta.nombre, mercado: merc, mercado_nombre: MERCADOS[merc].nombre,
    mercados: Object.entries(MERCADOS).map(([id, d]) => ({ id, nombre: d.nombre, productos: deMercado(todos, id).size })), total: visibles.size, ventas_recientes: recientes,
    crash: enCrash ? { ...enCrash, factor: +factorCrash(enCrash, ahora.getTime()).toFixed(3) } : null };
  if (!sim) { const f = factorCrash(crashVivo, ahora.getTime());
    return { ...base, abierto: false, tragos: [...visibles.values()].filter((p) => p.activo).map((p) => ({ id: p.id, nombre: p.nombre, base: p.base, precio: redondeo(p.base * f), ratio: f, var_dia: +((f - 1) * 100).toFixed(1), var_30: 0, vendidos: 0, ultima_hora: 0, serie: [] })) }; }
  return { ...base, abierto: true, ...sim };
}

module.exports = function registrarBolsa({ route, query, fail, permitir }) {
  const cuenta = (url) => { const cs = fudo.cuentasTablero(); if (!cs.length) fail(400, 'Fudo no está configurado.'); const id = url.searchParams.get('cuenta'); return cs.find((x) => x.id === id) || cs[0]; };
  const cfg = async (clave, def) => { const r = (await query('SELECT valor FROM app_config WHERE clave = $1', [clave])).rows[0]; try { return r ? JSON.parse(r.valor) : def; } catch (_) { return def; } };
  const setCfg = (clave, v) => query('INSERT INTO app_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor', [clave, JSON.stringify(v)]);
  const claveOcultos = (cta, merc) => (merc === 'tragos' ? 'bolsa_ocultos_' + cta.id : `bolsa_ocultos_${merc}_${cta.id}`);
  const esAdmin = (user) => { if (user.rol !== 'ADMIN') fail(403, 'Solo el administrador configura la bolsa'); };

  route('GET', '/api/bolsa/cuentas', async ({ user }) => { permitir(user, 'juegos'); return fudo.cuentasTablero().map(({ id, nombre }) => ({ id, nombre })); });
  route('GET', '/api/bolsa', async ({ user, url }) => {
    permitir(user, 'juegos');
    const cta = cuenta(url); const merc = mercadoDe(url.searchParams.get('mercado')); const demo = url.searchParams.get('demo') === '1';
    const k = cta.id + ':' + merc + (demo ? ':demo' : ''); const ch = cache[k];
    if (ch && Date.now() - ch.t < (demo ? 5000 : CACHE_MS)) return ch.datos;
    try { const datos = await armar(cta, merc, new Set(await cfg(claveOcultos(cta, merc), [])), await cfg('bolsa_crash_' + cta.id + (demo ? '_demo' : ''), null), demo); cache[k] = { t: Date.now(), datos }; return datos; }
    catch (e) { if (ch) return { ...ch.datos, desactualizado: true }; fail(502, `No se pudieron leer las ventas de Fudo de ${cta.nombre}: ${e.message}`); }
  });
  route('GET', '/api/bolsa/config', async ({ user, url }) => {
    esAdmin(user); const cta = cuenta(url); const merc = mercadoDe(url.searchParams.get('mercado')); const ocultos = new Set(await cfg(claveOcultos(cta, merc), []));
    return [...deMercado(await productosMercado(cta), merc).values()].sort((a, b) => a.nombre.localeCompare(b.nombre)).map((p) => ({ ...p, oculto: ocultos.has(p.id) }));
  });
  route('PUT', '/api/bolsa/config', async ({ user, url, body }) => {
    esAdmin(user); const cta = cuenta(url); const merc = mercadoDe(url.searchParams.get('mercado'));
    const ids = Array.isArray(body && body.ocultos) ? body.ocultos.map(String).slice(0, 1000) : [];
    await setCfg(claveOcultos(cta, merc), ids); delete cache[cta.id + ':' + merc]; return { ok: true, ocultos: ids.length };
  });
  // CRASH: baja todos los precios de la sucursal un % durante unos minutos (permiso juegosCrash)
  route('POST', '/api/bolsa/crash', async ({ user, url, body }) => {
    permitir(user, 'juegosCrash'); const cta = cuenta(url); const sfx = url.searchParams.get('demo') === '1' ? '_demo' : '';
    const minutos = Math.min(60, Math.max(1, Math.round(Number(body && body.minutos) || 10)));
    const caida = Math.min(60, Math.max(5, Math.round(Number(body && body.caida) || 30)));
    const desde = new Date(); const crash = { desde: desde.toISOString(), hasta: new Date(desde.getTime() + minutos * 60e3).toISOString(), caida, minutos, por: user.nombre };
    await setCfg('bolsa_crash_' + cta.id + sfx, crash);
    for (const k of Object.keys(cache)) if (k.startsWith(cta.id + ':')) delete cache[k];
    return crash;
  });
  route('DELETE', '/api/bolsa/crash', async ({ user, url }) => {
    permitir(user, 'juegosCrash'); const cta = cuenta(url); const sfx = url.searchParams.get('demo') === '1' ? '_demo' : '';
    const c = await cfg('bolsa_crash_' + cta.id + sfx, null);
    if (c && new Date(c.hasta) > new Date()) { c.hasta = new Date().toISOString(); await setCfg('bolsa_crash_' + cta.id + sfx, c); }
    for (const k of Object.keys(cache)) if (k.startsWith(cta.id + ':')) delete cache[k];
    return { ok: true };
  });
};
module.exports.simular = simular;
module.exports.ventasDemo = ventasDemo;
