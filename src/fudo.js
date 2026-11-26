// Integración con Fudo (https://dev.fu.do/api/): sincroniza proveedores y productos Fudo -> Vinilo.
// Variables de entorno: FUDO_API_KEY, FUDO_API_SECRET (obligatorias para activar),
// FUDO_SYNC_MINUTES (default 30, 0 = solo manual), FUDO_AUTH_URL y FUDO_API_URL (opcionales).
const AUTH_URL = process.env.FUDO_AUTH_URL || 'https://auth.fu.do/api';
const API_URL = (process.env.FUDO_API_URL || 'https://api.fu.do/v1alpha1').replace(/\/$/, '');
const PAGE_SIZE = 100;

const configurado = () => !!(process.env.FUDO_API_KEY && process.env.FUDO_API_SECRET);

let tokenCache = null; // { token, exp }
const enCurso = {};

async function obtenerToken() {
  const ahora = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 300 > ahora) return tokenCache.token;
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey: process.env.FUDO_API_KEY, apiSecret: process.env.FUDO_API_SECRET }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Fudo rechazó las credenciales (HTTP ${res.status}). Revisá FUDO_API_KEY y FUDO_API_SECRET.`);
  const data = await res.json();
  if (!data.token) throw new Error('Fudo no devolvió un token');
  tokenCache = { token: data.token, exp: Number(data.exp) || ahora + 23 * 3600 };
  return tokenCache.token;
}

async function fudoGet(path, params, reintento = true) {
  const token = await obtenerToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_URL}${path}${qs ? '?' + qs : ''}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 && reintento) { tokenCache = null; return fudoGet(path, params, false); }
  if (res.status === 403) {
    const que = path.includes('provider') ? 'Proveedores' : 'Productos';
    throw new Error(`Fudo denegó el acceso (403): el usuario de Fudo dueño de la apiKey no tiene permiso para ver ${que}. `
      + `En Fudo, asignale un rol con acceso a ${que} (por ejemplo Administrador) y volvé a sincronizar.`);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Fudo respondió HTTP ${res.status} en ${path}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function listarTodo(path, extra = {}) {
  const todos = [];
  for (let page = 1; page <= 500; page++) {
    const data = await fudoGet(path, { 'page[size]': PAGE_SIZE, 'page[number]': page, sort: 'id', ...extra });
    const lote = Array.isArray(data.data) ? data.data : [];
    todos.push(...lote);
    if (lote.length < PAGE_SIZE) break;
  }
  return todos;
}
const listarProveedoresFudo = () => listarTodo('/providers');

// Fudo guarda la dirección como JSON ["calle","número","piso","ciudad"] o como texto
function direccionLegible(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      const p = JSON.parse(s).filter((x) => x !== null && String(x).trim() !== '').map(String);
      if (!p.length) return null;
      return [p.slice(0, 2).join(' '), ...p.slice(2)].join(', ').slice(0, 200);
    } catch (_) { /* texto común */ }
  }
  return s.slice(0, 200) || null;
}

const limpio = (v, max) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const IGNORAR = new Set(['cash_count', 'proveedor ejemplo']); // registros técnicos / de ejemplo de Fudo

/** Sincroniza proveedores. Devuelve el resumen y lo registra en fudo_sync_log. */
async function sincronizarProveedores(pool, origen = 'MANUAL') {
  if (!configurado()) throw new Error('La integración con Fudo no está configurada (faltan FUDO_API_KEY y FUDO_API_SECRET en Render).');
  if (enCurso.proveedores) return enCurso.proveedores; // evita dos sincronizaciones simultáneas
  enCurso.proveedores = (async () => {
    const { rows: lg } = await pool.query("INSERT INTO fudo_sync_log (entidad, origen) VALUES ('proveedores', $1) RETURNING id", [origen]);
    const logId = lg[0].id;
    const r = { leidos: 0, creados: 0, actualizados: 0, desactivados: 0, avisos: [] };
    try {
      const remotos = await listarProveedoresFudo();
      r.leidos = remotos.length;
      const vistos = new Set();
      for (const item of remotos) {
        const fid = String(item.id);
        const a = item.attributes || {};
        const nombre = limpio(a.name, 150);
        if (!nombre || IGNORAR.has(nombre.toLowerCase())) continue;
        vistos.add(fid);
        let telefono = limpio(a.phone, 50);
        let cuit = limpio(a.fiscalNumber, 20);
        // Algunos proveedores tienen el teléfono (236…) cargado como Nro. fiscal en Fudo
        if (cuit && /^236\d{7}$/.test(cuit.replace(/\D/g, '')) && !telefono) { telefono = cuit; cuit = null; }
        const comentario = a.comment ? limpio(String(a.comment).split(/\s*\n\s*/).filter(Boolean).join(' / '), 1000) : null;
        const datos = {
          nombre, email: limpio(a.email, 150), telefono, direccion: direccionLegible(a.address),
          cuit, comentario, activo: a.active !== false,
        };
        // 1) por fudo_id  2) por nombre (sin vínculo previo)
        let { rows } = await pool.query('SELECT * FROM proveedores WHERE fudo_id = $1', [fid]);
        if (!rows.length) {
          ({ rows } = await pool.query('SELECT * FROM proveedores WHERE fudo_id IS NULL AND lower(trim(nombre)) = lower($1)', [nombre]));
        }
        try {
          if (rows.length) {
            const p = rows[0];
            const cambia = p.fudo_id !== fid || p.nombre !== datos.nombre || (p.email || null) !== datos.email || (p.telefono || null) !== datos.telefono
              || (p.direccion || null) !== datos.direccion || (p.cuit || null) !== datos.cuit || (p.comentario || null) !== datos.comentario
              || (p.activo === true || p.activo === 't') !== datos.activo;
            if (cambia) {
              await pool.query(
                `UPDATE proveedores SET fudo_id=$2, nombre=$3, email=$4, telefono=$5, direccion=$6, cuit=$7, comentario=$8, activo=$9, fudo_sync_en=now()
                 WHERE id=$1`, [p.id, fid, datos.nombre, datos.email, datos.telefono, datos.direccion, datos.cuit, datos.comentario, datos.activo]);
              r.actualizados++;
            }
          } else {
            await pool.query(
              `INSERT INTO proveedores (fudo_id, nombre, email, telefono, direccion, cuit, comentario, activo, fudo_sync_en)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
              [fid, datos.nombre, datos.email, datos.telefono, datos.direccion, datos.cuit, datos.comentario, datos.activo]);
            r.creados++;
          }
        } catch (e) {
          if (e.code === '23505' || /duplicate|unique/i.test(e.message)) r.avisos.push(`"${nombre}" (Fudo ${fid}): ya existe otro proveedor con ese nombre`);
          else throw e;
        }
      }
      // Borrados en Fudo -> inactivos (solo si la lectura vino completa)
      if (remotos.length) {
        const { rows: locales } = await pool.query('SELECT id, fudo_id FROM proveedores WHERE fudo_id IS NOT NULL AND activo');
        for (const p of locales) {
          if (!vistos.has(String(p.fudo_id))) {
            await pool.query('UPDATE proveedores SET activo = FALSE, fudo_sync_en = now() WHERE id = $1', [p.id]);
            r.desactivados++;
          }
        }
      }
      await pool.query(
        'UPDATE fudo_sync_log SET fin=now(), ok=TRUE, leidos=$2, creados=$3, actualizados=$4, desactivados=$5, detalle=$6 WHERE id=$1',
        [logId, r.leidos, r.creados, r.actualizados, r.desactivados, r.avisos.join('\n') || null]);
      console.log(`Fudo proveedores (${origen}): ${r.leidos} leídos, ${r.creados} nuevos, ${r.actualizados} actualizados, ${r.desactivados} desactivados`);
      return r;
    } catch (e) {
      await pool.query('UPDATE fudo_sync_log SET fin=now(), ok=FALSE, detalle=$2 WHERE id=$1', [logId, String(e.message).slice(0, 1000)]).catch(() => {});
      console.error('Error sincronizando con Fudo:', e.message);
      throw e;
    }
  })();
  try { return await enCurso.proveedores; } finally { enCurso.proveedores = null; }
}

// ---------- Productos ----------
async function categoriasFudo() {
  const cats = await listarTodo('/product-categories');
  const porId = new Map(cats.map((c) => [String(c.id), {
    nombre: limpio(c.attributes && c.attributes.name, 90),
    padre: c.relationships && c.relationships.parentCategory && c.relationships.parentCategory.data ? String(c.relationships.parentCategory.data.id) : null,
  }]));
  const etiqueta = (id) => {
    const c = porId.get(String(id));
    if (!c) return null;
    const padre = c.padre && porId.get(c.padre);
    return (padre && padre.nombre ? `${padre.nombre} / ${c.nombre}` : c.nombre || '').slice(0, 80) || null;
  };
  return etiqueta;
}

/** Sincroniza productos Fudo -> Vinilo: nombre, categoría y activo. No toca stock, unidad ni alertas. */
async function sincronizarProductos(pool, origen = 'MANUAL') {
  if (!configurado()) throw new Error('La integración con Fudo no está configurada (faltan FUDO_API_KEY y FUDO_API_SECRET en Render).');
  if (enCurso.productos) return enCurso.productos;
  enCurso.productos = (async () => {
    const { rows: lg } = await pool.query("INSERT INTO fudo_sync_log (entidad, origen) VALUES ('productos', $1) RETURNING id", [origen]);
    const logId = lg[0].id;
    const r = { leidos: 0, creados: 0, actualizados: 0, desactivados: 0, avisos: [] };
    try {
      let etiqueta = () => null;
      try { etiqueta = await categoriasFudo(); } catch (e) { r.avisos.push(`Categorías no disponibles: ${e.message}`); }
      const remotos = await listarTodo('/products');
      r.leidos = remotos.length;
      const vistos = new Set();
      for (const item of remotos) {
        const fid = String(item.id);
        const a = item.attributes || {};
        const nombre = limpio(a.name, 200);
        if (!nombre) continue;
        vistos.add(fid);
        const rel = item.relationships && item.relationships.productCategory && item.relationships.productCategory.data;
        const categoria = rel ? etiqueta(rel.id) : null;
        const activo = a.active !== false;
        // 1) por fudo_id  2) producto sin vínculo cuyo código es el ID de Fudo
        let { rows } = await pool.query('SELECT * FROM productos WHERE fudo_id = $1', [fid]);
        if (!rows.length) ({ rows } = await pool.query('SELECT * FROM productos WHERE fudo_id IS NULL AND codigo = $1', [fid]));
        if (rows.length) {
          const p = rows[0];
          const nuevaCat = categoria || p.categoria; // si Fudo no informa categoría, se conserva
          const cambia = p.fudo_id !== fid || p.nombre !== nombre || (p.categoria || null) !== (nuevaCat || null)
            || (p.activo === true || p.activo === 't') !== activo;
          if (cambia) {
            await pool.query('UPDATE productos SET fudo_id=$2, nombre=$3, categoria=$4, activo=$5, fudo_sync_en=now(), actualizado_en=now() WHERE id=$1',
              [p.id, fid, nombre, nuevaCat, activo]);
            r.actualizados++;
          }
        } else {
          // Código interno = ID de Fudo (como el maestro inicial); si está ocupado por un producto propio, se usa F<ID>
          const { rows: ocupado } = await pool.query('SELECT 1 FROM productos WHERE codigo = $1', [fid]);
          const codigo = ocupado.length ? `F${fid}` : fid;
          try {
            await pool.query(
              `INSERT INTO productos (codigo, nombre, categoria, unidad, activo, fudo_id, fudo_sync_en) VALUES ($1,$2,$3,'UN',$4,$5,now())`,
              [codigo, nombre, categoria, activo, fid]);
            r.creados++;
          } catch (e) {
            if (e.code === '23505' || /duplicate|unique/i.test(e.message)) r.avisos.push(`"${nombre}" (Fudo ${fid}): código ${codigo} en uso`);
            else throw e;
          }
        }
      }
      if (remotos.length) {
        const { rows: locales } = await pool.query('SELECT id, fudo_id FROM productos WHERE fudo_id IS NOT NULL AND activo');
        for (const p of locales) {
          if (!vistos.has(String(p.fudo_id))) {
            await pool.query('UPDATE productos SET activo = FALSE, fudo_sync_en = now(), actualizado_en = now() WHERE id = $1', [p.id]);
            r.desactivados++;
          }
        }
      }
      await pool.query(
        'UPDATE fudo_sync_log SET fin=now(), ok=TRUE, leidos=$2, creados=$3, actualizados=$4, desactivados=$5, detalle=$6 WHERE id=$1',
        [logId, r.leidos, r.creados, r.actualizados, r.desactivados, r.avisos.join('\n') || null]);
      console.log(`Fudo productos (${origen}): ${r.leidos} leídos, ${r.creados} nuevos, ${r.actualizados} actualizados, ${r.desactivados} desactivados`);
      return r;
    } catch (e) {
      await pool.query('UPDATE fudo_sync_log SET fin=now(), ok=FALSE, detalle=$2 WHERE id=$1', [logId, String(e.message).slice(0, 1000)]).catch(() => {});
      console.error('Error sincronizando productos con Fudo:', e.message);
      throw e;
    }
  })();
  try { return await enCurso.productos; } finally { enCurso.productos = null; }
}

/** Sincroniza ambas entidades; un error en una no frena la otra. */
async function sincronizarTodo(pool, origen = 'MANUAL') {
  const out = {};
  for (const [k, fn] of [['proveedores', sincronizarProveedores], ['productos', sincronizarProductos]]) {
    try { out[k] = await fn(pool, origen); } catch (e) { out[k] = { error: e.message }; }
  }
  return out;
}

function iniciarSincronizacionAutomatica(pool) {
  if (!configurado()) { console.log('Fudo: integración no configurada (sin FUDO_API_KEY/FUDO_API_SECRET)'); return; }
  const minutos = Number(process.env.FUDO_SYNC_MINUTES ?? 30);
  setTimeout(() => sincronizarTodo(pool, 'ARRANQUE'), 5000);
  if (minutos > 0) {
    setInterval(() => sincronizarTodo(pool, 'AUTO'), minutos * 60 * 1000).unref();
    console.log(`Fudo: sincronización de proveedores y productos cada ${minutos} min`);
  }
}

// Escritura en Fudo (JSON:API). Devuelve { status, body } sin lanzar error, para poder diagnosticar.
async function fudoEnviar(metodo, path, cuerpo, tipo = 'application/json') {
  const token = await obtenerToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: metodo, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': tipo },
    body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(30000),
  });
  const txt = await res.text().catch(() => '');
  let body = txt; try { body = JSON.parse(txt); } catch (_) { /* texto */ }
  return { status: res.status, ok: res.ok, body };
}
// Cambia el precio de un producto en Fudo. Prueba el formato JSON:API y, si Fudo lo rechaza por formato, variantes.
async function cambiarPrecioFudo(fudoId, precio) {
  const id = String(fudoId); const intentos = [];
  const variantes = [
    [{ data: { type: 'Product', id, attributes: { price: precio } } }, 'application/json'],
    [{ data: { type: 'Product', id, attributes: { price: precio } } }, 'application/vnd.api+json'],
    [{ data: { type: 'Product', id, attributes: { price: String(precio) } } }, 'application/json'],
    [{ price: precio }, 'application/json'],
  ];
  for (const [cuerpo, tipo] of variantes) {
    const r = await fudoEnviar('PATCH', `/products/${id}`, cuerpo, tipo);
    intentos.push({ tipo, cuerpo, status: r.status, respuesta: typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 300) });
    if (r.ok) { const a = (r.body && r.body.data && r.body.data.attributes) || {}; return { ok: true, precio_nuevo: a.price, intentos }; }
    if ([401, 403, 404].includes(r.status)) break; // permiso o producto: no tiene sentido probar otros formatos
  }
  return { ok: false, intentos };
}

// Cliente de lectura para otra cuenta de Fudo (otra sucursal), con su propio token. Solo lo usa el tablero.
function crearCliente(key, secret) {
  let tk = null;
  async function token() {
    const ahora = Math.floor(Date.now() / 1000);
    if (tk && tk.exp - 300 > ahora) return tk.token;
    const res = await fetch(AUTH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ apiKey: key, apiSecret: secret }), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Fudo rechazó las credenciales de esta sucursal (HTTP ${res.status}).`);
    const data = await res.json(); if (!data.token) throw new Error('Fudo no devolvió un token');
    tk = { token: data.token, exp: Number(data.exp) || ahora + 23 * 3600 }; return tk.token;
  }
  return async function get(path, params, reintento = true) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API_URL}${path}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (res.status === 401 && reintento) { tk = null; return get(path, params, false); }
    if (!res.ok) { const txt = await res.text().catch(() => ''); throw new Error(`Fudo respondió HTTP ${res.status} en ${path}: ${txt.slice(0, 200)}`); }
    return res.json();
  };
}
// Cuentas de Fudo para el tablero: la principal (FUDO_API_KEY) y la del bar (FUDO_BAR_API_KEY), cada una con su nombre.
let cuentasCache = null;
function cuentasTablero() {
  if (cuentasCache) return cuentasCache;
  const c = [];
  if (configurado()) c.push({ id: 'galpon', nombre: process.env.FUDO_NOMBRE || 'VINILO GALPON', principal: true, get: fudoGet });
  if (process.env.FUDO_BAR_API_KEY && process.env.FUDO_BAR_API_SECRET) c.push({ id: 'bar', nombre: process.env.FUDO_BAR_NOMBRE || 'VINILO BAR', principal: false, get: crearCliente(process.env.FUDO_BAR_API_KEY, process.env.FUDO_BAR_API_SECRET) });
  return (cuentasCache = c);
}

module.exports = { cambiarPrecioFudo, fudoEnviar, cuentasTablero, crearCliente, fudoGet, configurado, sincronizarProveedores, sincronizarProductos, sincronizarTodo, iniciarSincronizacionAutomatica, direccionLegible };
