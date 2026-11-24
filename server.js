const http = require('http');
const fs = require('fs');
const path = require('path');
const { query, tx, migrate } = require('./src/db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./src/auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROLES = ['ADMIN', 'RECEPTOR', 'ENCARGADO', 'REQUIRENTE', 'PROVEEDOR'];

// Permisos por rol
const PUEDE = {
  parametrizar: ['ADMIN'],
  recibir: ['ADMIN', 'RECEPTOR'],
  transferir: ['ADMIN', 'RECEPTOR'],
  consumir: ['ADMIN', 'RECEPTOR'],
  ajustar: ['ADMIN'],
  verStock: ['ADMIN', 'RECEPTOR', 'ENCARGADO'],
  minimos: ['ADMIN', 'ENCARGADO'],
  verMovimientos: ['ADMIN', 'RECEPTOR', 'ENCARGADO'],
  crearPedido: ['ADMIN', 'REQUIRENTE'],
  atenderPedido: ['ADMIN', 'RECEPTOR'],
  verPedidos: ['ADMIN', 'RECEPTOR', 'ENCARGADO', 'REQUIRENTE'],
  verProductos: ['ADMIN', 'RECEPTOR', 'ENCARGADO', 'REQUIRENTE'],
  // Compras: ADMIN siempre; el resto según el permiso "Compras" del usuario (ver permisosDe)
  compras: ['ADMIN'],
  verCompras: ['ADMIN', 'RECEPTOR', 'ENCARGADO'],
  portalProveedor: ['PROVEEDOR'],
};

function permisosDe(u) {
  const p = Object.keys(PUEDE).filter((k) => PUEDE[k].includes(u.rol));
  if (u.permiso_compras && u.rol !== 'PROVEEDOR') {
    if (!p.includes('compras')) p.push('compras');
    if (!p.includes('verCompras')) p.push('verCompras');
    if (!p.includes('verProductos')) p.push('verProductos');
  }
  return p;
}
const PERMISO_POR_TIPO = { RECEPCION: 'recibir', TRANSFERENCIA: 'transferir', CONSUMO: 'consumir', AJUSTE: 'ajustar' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };
const permitir = (user, accion) => { if (!user.permisos.includes(accion)) fail(403, 'No tenés permiso para esta operación'); };

// ---------- Mini router ----------
const routes = [];
function route(method, pattern, handler, { auth = true } = {}) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, regex, keys, handler, auth });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 15 * 1024 * 1024) { reject(new HttpError(413, 'Cuerpo demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new HttpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function currentUser(req) {
  const h = req.headers.authorization || '';
  const payload = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!payload) return null;
  const { rows } = await query(
    `SELECT u.id, u.username, u.nombre, u.rol, u.activo, u.permiso_compras, u.proveedor_id, p.nombre AS proveedor
     FROM usuarios u LEFT JOIN proveedores p ON p.id = u.proveedor_id WHERE u.id = $1`, [payload.uid]);
  const u = rows[0];
  if (!u || !isTrue(u.activo)) return null;
  if (u.rol === 'PROVEEDOR' && !u.proveedor_id) return null;
  const user = {
    id: Number(u.id), username: u.username, nombre: u.nombre, rol: u.rol,
    permiso_compras: isTrue(u.permiso_compras) || u.rol === 'ADMIN',
    proveedor_id: u.proveedor_id ? Number(u.proveedor_id) : null, proveedor: u.proveedor || null,
  };
  user.permisos = permisosDe(user);
  return user;
}

// ---------- Helpers ----------
const isTrue = (v) => v === true || v === 't' || v === 'true';
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const str = (v, max = 500) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'SI' || v === 'si' || v === 'S' || v === 's' || v === 'x' || v === 'X';
const fechaOk = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

async function almacenActivo(client, id, etiqueta) {
  if (!Number.isInteger(id)) fail(400, `Seleccioná el almacén de ${etiqueta}`);
  const { rows } = await client.query('SELECT id, nombre, activo FROM almacenes WHERE id = $1', [id]);
  if (!rows[0]) fail(400, `Almacén de ${etiqueta} inexistente`);
  if (!isTrue(rows[0].activo)) fail(400, `El almacén ${rows[0].nombre} está inactivo`);
  return rows[0];
}

/**
 * Registra un movimiento y actualiza el stock dentro de una transacción.
 * items: [{ producto_id, cantidad }]  (en AJUSTE: cantidad = cantidad contada final)
 */
async function registrarMovimiento(client, mov) {
  const tipo = mov.tipo;
  if (!PERMISO_POR_TIPO[tipo]) fail(400, 'Tipo de movimiento inválido');
  const origenId = mov.origen_id == null || mov.origen_id === '' ? null : toInt(mov.origen_id);
  const destinoId = mov.destino_id == null || mov.destino_id === '' ? null : toInt(mov.destino_id);

  let origen = null, destino = null;
  if (tipo === 'RECEPCION') destino = await almacenActivo(client, destinoId, 'destino');
  if (tipo === 'TRANSFERENCIA') {
    origen = await almacenActivo(client, origenId, 'origen');
    destino = await almacenActivo(client, destinoId, 'destino');
    if (origenId === destinoId) fail(400, 'El origen y el destino deben ser distintos');
  }
  if (tipo === 'CONSUMO' || tipo === 'AJUSTE') origen = await almacenActivo(client, origenId, tipo === 'AJUSTE' ? 'ajuste' : 'consumo');

  // Consolidar ítems por producto
  if (!Array.isArray(mov.items) || mov.items.length === 0) fail(400, 'Agregá al menos un producto');
  const porProducto = new Map();
  for (const it of mov.items) {
    const pid = toInt(it.producto_id);
    const cant = toInt(it.cantidad);
    if (!Number.isInteger(pid)) fail(400, 'Producto inválido');
    if (!Number.isInteger(cant) || (tipo === 'AJUSTE' ? cant < 0 : cant <= 0)) {
      fail(400, tipo === 'AJUSTE' ? 'La cantidad contada debe ser un entero mayor o igual a 0' : 'Las cantidades deben ser enteros mayores a 0');
    }
    if (tipo === 'AJUSTE') {
      if (porProducto.has(pid)) fail(400, 'Un producto aparece repetido en el ajuste');
      porProducto.set(pid, cant);
    } else {
      porProducto.set(pid, (porProducto.get(pid) || 0) + cant);
    }
  }
  const ids = [...porProducto.keys()].sort((a, b) => a - b);
  const { rows: prods } = await client.query('SELECT id, codigo, nombre, activo FROM productos WHERE id = ANY($1::int[])', [`{${ids.join(',')}}`]);
  const prodMap = new Map(prods.map((p) => [Number(p.id), p]));
  for (const pid of ids) {
    const p = prodMap.get(pid);
    if (!p) fail(400, `Producto ${pid} inexistente`);
    if (!isTrue(p.activo) && tipo === 'RECEPCION') fail(400, `El producto ${p.nombre} está inactivo`);
  }

  const sumar = (almId, pid, cant) => client.query(
    `INSERT INTO stock (almacen_id, producto_id, cantidad) VALUES ($1, $2, $3)
     ON CONFLICT (almacen_id, producto_id) DO UPDATE SET cantidad = stock.cantidad + EXCLUDED.cantidad`,
    [almId, pid, cant]
  );
  const bloquear = async (almId, pid) => {
    const { rows } = await client.query('SELECT cantidad FROM stock WHERE almacen_id = $1 AND producto_id = $2 FOR UPDATE', [almId, pid]);
    return rows[0] ? Number(rows[0].cantidad) : 0;
  };

  const itemsFinales = []; // { pid, cantidad (con signo para AJUSTE) }
  for (const pid of ids) {
    const cant = porProducto.get(pid);
    const p = prodMap.get(pid);
    if (tipo === 'RECEPCION') {
      await sumar(destino.id, pid, cant);
      itemsFinales.push([pid, cant]);
    } else if (tipo === 'TRANSFERENCIA' || tipo === 'CONSUMO') {
      const disp = await bloquear(origen.id, pid);
      if (disp < cant) fail(409, `Stock insuficiente de "${p.nombre}" en ${origen.nombre}: disponible ${disp}, solicitado ${cant}`);
      await client.query('UPDATE stock SET cantidad = cantidad - $3 WHERE almacen_id = $1 AND producto_id = $2', [origen.id, pid, cant]);
      if (tipo === 'TRANSFERENCIA') await sumar(destino.id, pid, cant);
      itemsFinales.push([pid, cant]);
    } else if (tipo === 'AJUSTE') {
      const actual = await bloquear(origen.id, pid);
      const dif = cant - actual;
      if (dif === 0) continue;
      if (dif > 0) await sumar(origen.id, pid, dif);
      else await client.query('UPDATE stock SET cantidad = $3 WHERE almacen_id = $1 AND producto_id = $2', [origen.id, pid, cant]);
      itemsFinales.push([pid, dif]);
    }
  }
  if (itemsFinales.length === 0) fail(400, 'El ajuste no produce cambios: las cantidades contadas coinciden con el stock');

  const { rows: m } = await client.query(
    `INSERT INTO movimientos (tipo, origen_id, destino_id, usuario_id, pedido_id, oc_id, referencia, observacion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [tipo, origen ? origen.id : null, destino ? destino.id : null, mov.usuario_id, mov.pedido_id || null, mov.oc_id || null, str(mov.referencia, 120), str(mov.observacion, 1000)]
  );
  const movId = Number(m[0].id);
  for (const [pid, cant] of itemsFinales) {
    await client.query('INSERT INTO movimiento_items (movimiento_id, producto_id, cantidad) VALUES ($1, $2, $3)', [movId, pid, cant]);
  }
  return movId;
}

// ---------- Auth ----------
route('POST', '/api/login', async ({ body }) => {
  const { rows } = await query('SELECT * FROM usuarios WHERE lower(username) = lower($1)', [String(body.username || '').trim()]);
  const u = rows[0];
  if (!u || !isTrue(u.activo) || !verifyPassword(body.password || '', u.password_hash)) fail(401, 'Usuario o contraseña incorrectos');
  return { token: signToken({ uid: Number(u.id) }), user: { id: Number(u.id), username: u.username, nombre: u.nombre, rol: u.rol } };
}, { auth: false });

route('GET', '/api/me', async ({ user }) => ({ user, permisos: user.permisos }));

route('POST', '/api/me/password', async ({ user, body }) => {
  const { rows } = await query('SELECT password_hash FROM usuarios WHERE id = $1', [user.id]);
  if (!verifyPassword(body.actual || '', rows[0].password_hash)) fail(400, 'La contraseña actual no es correcta');
  if (!body.nueva || String(body.nueva).length < 6) fail(400, 'La nueva contraseña debe tener al menos 6 caracteres');
  await query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [user.id, hashPassword(body.nueva)]);
  return { ok: true };
});

// ---------- Usuarios ----------
route('GET', '/api/usuarios', async ({ user }) => {
  permitir(user, 'parametrizar');
  const { rows } = await query(
    `SELECT u.id, u.username, u.nombre, u.rol, u.activo, u.permiso_compras, u.proveedor_id, p.nombre AS proveedor, u.creado_en
     FROM usuarios u LEFT JOIN proveedores p ON p.id = u.proveedor_id ORDER BY u.nombre`);
  return rows.map((r) => ({ ...r, id: Number(r.id), activo: isTrue(r.activo), permiso_compras: isTrue(r.permiso_compras), proveedor_id: r.proveedor_id ? Number(r.proveedor_id) : null }));
});

// Valida rol / proveedor / permiso de compras
async function datosRolUsuario(body, actual = {}) {
  const rol = body.rol ?? actual.rol;
  if (!ROLES.includes(rol)) fail(400, 'Rol inválido');
  let proveedorId = null;
  let compras = body.permiso_compras === undefined ? isTrue(actual.permiso_compras) : bool(body.permiso_compras);
  if (rol === 'PROVEEDOR') {
    proveedorId = toInt(body.proveedor_id ?? actual.proveedor_id);
    if (!Number.isInteger(proveedorId)) fail(400, 'Un usuario PROVEEDOR debe estar vinculado a un proveedor');
    const { rows } = await query('SELECT id FROM proveedores WHERE id = $1', [proveedorId]);
    if (!rows[0]) fail(400, 'Proveedor inexistente');
    compras = false;
  }
  return { rol, proveedorId, compras };
}

route('POST', '/api/usuarios', async ({ user, body }) => {
  permitir(user, 'parametrizar');
  const username = str(body.username, 60);
  const nombre = str(body.nombre, 120);
  if (!username || !nombre) fail(400, 'Usuario y nombre son obligatorios');
  const { rol, proveedorId, compras } = await datosRolUsuario(body);
  if (!body.password || String(body.password).length < 6) fail(400, 'La contraseña debe tener al menos 6 caracteres');
  try {
    const { rows } = await query(
      `INSERT INTO usuarios (username, nombre, password_hash, rol, proveedor_id, permiso_compras)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [username, nombre, hashPassword(body.password), rol, proveedorId, compras]
    );
    return { id: Number(rows[0].id) };
  } catch (e) {
    if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ese nombre de usuario ya existe');
    throw e;
  }
});

route('PUT', '/api/usuarios/:id', async ({ user, body, params }) => {
  permitir(user, 'parametrizar');
  const id = toInt(params.id);
  const { rows } = await query('SELECT * FROM usuarios WHERE id = $1', [id]);
  const u = rows[0];
  if (!u) fail(404, 'Usuario inexistente');
  const { rol, proveedorId, compras } = await datosRolUsuario(body, u);
  const activo = body.activo === undefined ? isTrue(u.activo) : bool(body.activo);
  if (id === user.id && (!activo || rol !== 'ADMIN')) fail(400, 'No podés quitarte el rol ADMIN ni desactivarte a vos mismo');
  await query('UPDATE usuarios SET nombre = $2, rol = $3, activo = $4, proveedor_id = $5, permiso_compras = $6 WHERE id = $1',
    [id, str(body.nombre, 120) || u.nombre, rol, activo, proveedorId, compras]);
  if (body.password) {
    if (String(body.password).length < 6) fail(400, 'La contraseña debe tener al menos 6 caracteres');
    await query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [id, hashPassword(body.password)]);
  }
  return { ok: true };
});

// ---------- Almacenes ----------
route('GET', '/api/almacenes', async () => {
  const { rows } = await query('SELECT id, nombre, activo FROM almacenes ORDER BY id');
  return rows.map((r) => ({ ...r, id: Number(r.id), activo: isTrue(r.activo) }));
});

route('POST', '/api/almacenes', async ({ user, body }) => {
  permitir(user, 'parametrizar');
  const nombre = str(body.nombre, 80);
  if (!nombre) fail(400, 'El nombre es obligatorio');
  try {
    const { rows } = await query('INSERT INTO almacenes (nombre) VALUES ($1) RETURNING id', [nombre.toUpperCase()]);
    return { id: Number(rows[0].id) };
  } catch (e) {
    if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ya existe un almacén con ese nombre');
    throw e;
  }
});

route('PUT', '/api/almacenes/:id', async ({ user, body, params }) => {
  permitir(user, 'parametrizar');
  const id = toInt(params.id);
  const nombre = str(body.nombre, 80);
  if (!nombre) fail(400, 'El nombre es obligatorio');
  const activo = bool(body.activo);
  if (!activo) {
    const { rows } = await query('SELECT coalesce(sum(cantidad),0)::int AS n FROM stock WHERE almacen_id = $1', [id]);
    if (Number(rows[0].n) > 0) fail(409, 'No se puede desactivar un almacén con stock. Transferí o ajustá primero.');
  }
  await query('UPDATE almacenes SET nombre = $2, activo = $3 WHERE id = $1', [id, nombre.toUpperCase(), activo]);
  return { ok: true };
});

// ---------- Productos ----------
const PRODUCTO_COLS = `id, codigo, nombre, categoria, unidad, alerta_vencimiento, fecha_vencimiento,
  alerta_cuidado, alerta_frio, nota_alerta, activo, fudo_id,
  CASE WHEN fecha_vencimiento IS NULL THEN NULL ELSE (fecha_vencimiento - CURRENT_DATE) END AS dias_venc`;

function normalizarProducto(r) {
  return {
    ...r,
    id: Number(r.id),
    alerta_vencimiento: isTrue(r.alerta_vencimiento),
    alerta_cuidado: isTrue(r.alerta_cuidado),
    alerta_frio: isTrue(r.alerta_frio),
    activo: isTrue(r.activo),
    fecha_vencimiento: r.fecha_vencimiento || null,
    dias_venc: r.dias_venc === null || r.dias_venc === '' || r.dias_venc === undefined ? null : Number(r.dias_venc),
  };
}

route('GET', '/api/productos', async ({ user }) => {
  permitir(user, 'verProductos');
  const { rows } = await query(`SELECT ${PRODUCTO_COLS} FROM productos ORDER BY nombre`);
  return rows.map(normalizarProducto);
});

function datosProducto(body) {
  const codigo = str(body.codigo, 40);
  const nombre = str(body.nombre, 200);
  if (!codigo || !nombre) fail(400, 'Código y nombre son obligatorios');
  return [
    codigo.toUpperCase(), nombre, str(body.categoria, 80), (str(body.unidad, 20) || 'UN').toUpperCase(),
    bool(body.alerta_vencimiento), fechaOk(body.fecha_vencimiento), bool(body.alerta_cuidado), bool(body.alerta_frio),
    str(body.nota_alerta, 500), body.activo === undefined ? true : bool(body.activo),
  ];
}

route('POST', '/api/productos', async ({ user, body }) => {
  permitir(user, 'parametrizar');
  try {
    const { rows } = await query(
      `INSERT INTO productos (codigo, nombre, categoria, unidad, alerta_vencimiento, fecha_vencimiento, alerta_cuidado, alerta_frio, nota_alerta, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, datosProducto(body));
    return { id: Number(rows[0].id) };
  } catch (e) {
    if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ya existe un producto con ese código');
    throw e;
  }
});

route('PUT', '/api/productos/:id', async ({ user, body, params }) => {
  permitir(user, 'parametrizar');
  try {
    await query(
      `UPDATE productos SET codigo=$2, nombre=$3, categoria=$4, unidad=$5, alerta_vencimiento=$6, fecha_vencimiento=$7,
       alerta_cuidado=$8, alerta_frio=$9, nota_alerta=$10, activo=$11, actualizado_en=now() WHERE id=$1`,
      [toInt(params.id), ...datosProducto(body)]);
  } catch (e) {
    if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ya existe un producto con ese código');
    throw e;
  }
  return { ok: true };
});

// Importación del maestro: crea o actualiza por código
route('POST', '/api/productos/importar', async ({ user, body }) => {
  permitir(user, 'parametrizar');
  const filas = Array.isArray(body.productos) ? body.productos : [];
  if (!filas.length) fail(400, 'No hay filas para importar');
  return tx(async (client) => {
    let creados = 0, actualizados = 0;
    const errores = [];
    for (let i = 0; i < filas.length; i++) {
      let datos;
      try { datos = datosProducto(filas[i]); } catch (e) { errores.push(`Fila ${i + 2}: ${e.message}`); continue; }
      const { rows } = await client.query(
        `INSERT INTO productos (codigo, nombre, categoria, unidad, alerta_vencimiento, fecha_vencimiento, alerta_cuidado, alerta_frio, nota_alerta, activo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre, categoria=EXCLUDED.categoria, unidad=EXCLUDED.unidad,
           alerta_vencimiento=EXCLUDED.alerta_vencimiento, fecha_vencimiento=EXCLUDED.fecha_vencimiento,
           alerta_cuidado=EXCLUDED.alerta_cuidado, alerta_frio=EXCLUDED.alerta_frio, nota_alerta=EXCLUDED.nota_alerta,
           activo=EXCLUDED.activo, actualizado_en=now()
         RETURNING (xmax = 0) AS insertado`, datos);
      if (isTrue(rows[0].insertado)) creados++; else actualizados++;
    }
    return { creados, actualizados, errores };
  });
});

// ---------- Stock ----------
route('GET', '/api/stock', async ({ user }) => {
  permitir(user, 'verStock');
  const [alm, prods, st, mins] = await Promise.all([
    query('SELECT id, nombre, activo FROM almacenes ORDER BY id'),
    query(`SELECT ${PRODUCTO_COLS} FROM productos ORDER BY nombre`),
    query('SELECT almacen_id, producto_id, cantidad FROM stock WHERE cantidad <> 0'),
    query('SELECT almacen_id, producto_id, minimo FROM stock_minimos'),
  ]);
  const stockMap = {};
  for (const r of st.rows) (stockMap[Number(r.producto_id)] = stockMap[Number(r.producto_id)] || {})[Number(r.almacen_id)] = Number(r.cantidad);
  const minMap = {};
  for (const r of mins.rows) (minMap[Number(r.producto_id)] = minMap[Number(r.producto_id)] || {})[Number(r.almacen_id)] = Number(r.minimo);
  return {
    almacenes: alm.rows.map((a) => ({ id: Number(a.id), nombre: a.nombre, activo: isTrue(a.activo) })),
    productos: prods.rows.map(normalizarProducto).map((p) => {
      const porAlmacen = stockMap[p.id] || {};
      return { ...p, stock: porAlmacen, minimos: minMap[p.id] || {}, total: Object.values(porAlmacen).reduce((x, y) => x + y, 0) };
    }),
  };
});

// Stock mínimo por almacén de un producto
route('GET', '/api/productos/:id/minimos', async ({ user, params }) => {
  if (!user.permisos.includes('verStock') && !user.permisos.includes('parametrizar')) fail(403, 'No tenés permiso para esta operación');
  const { rows } = await query('SELECT almacen_id, minimo FROM stock_minimos WHERE producto_id = $1', [toInt(params.id)]);
  return Object.fromEntries(rows.map((r) => [Number(r.almacen_id), Number(r.minimo)]));
});

route('PUT', '/api/productos/:id/minimos', async ({ user, body, params }) => {
  permitir(user, 'minimos');
  const pid = toInt(params.id);
  const mins = body && typeof body.minimos === 'object' ? body.minimos : {};
  return tx(async (client) => {
    const { rows } = await client.query('SELECT 1 FROM productos WHERE id = $1', [pid]);
    if (!rows[0]) fail(404, 'Producto inexistente');
    for (const [alm, v] of Object.entries(mins)) {
      const almId = toInt(alm);
      const min = v === '' || v === null || v === undefined ? 0 : toInt(v);
      if (!Number.isInteger(almId) || !Number.isInteger(min) || min < 0) fail(400, 'Los mínimos deben ser enteros mayores o iguales a 0');
      if (min === 0) await client.query('DELETE FROM stock_minimos WHERE almacen_id = $1 AND producto_id = $2', [almId, pid]);
      else await client.query(
        `INSERT INTO stock_minimos (almacen_id, producto_id, minimo) VALUES ($1,$2,$3)
         ON CONFLICT (almacen_id, producto_id) DO UPDATE SET minimo = EXCLUDED.minimo`, [almId, pid, min]);
    }
    return { ok: true };
  });
});

// ---------- Movimientos ----------
route('POST', '/api/movimientos', async ({ user, body }) => {
  const accion = PERMISO_POR_TIPO[body.tipo];
  if (!accion) fail(400, 'Tipo de movimiento inválido');
  permitir(user, accion);
  const id = await tx((client) => registrarMovimiento(client, { ...body, usuario_id: user.id, pedido_id: null, oc_id: null }));
  return { id };
});

route('GET', '/api/movimientos', async ({ user, url }) => {
  permitir(user, 'verMovimientos');
  const q = url.searchParams;
  const where = [];
  const params = [];
  const add = (cond, val) => { params.push(val); where.push(cond.replace('?', `$${params.length}`)); };
  if (q.get('tipo')) add('m.tipo = ?', q.get('tipo'));
  if (q.get('almacen_id')) { params.push(toInt(q.get('almacen_id'))); where.push(`(m.origen_id = $${params.length} OR m.destino_id = $${params.length})`); }
  if (fechaOk(q.get('desde'))) add("m.fecha >= (?::date)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires'", q.get('desde'));
  if (fechaOk(q.get('hasta'))) add("m.fecha < ((?::date) + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires'", q.get('hasta'));
  if (q.get('producto_id')) add('EXISTS (SELECT 1 FROM movimiento_items x WHERE x.movimiento_id = m.id AND x.producto_id = ?)', toInt(q.get('producto_id')));
  const { rows } = await query(
    `SELECT m.id, m.tipo, m.fecha, m.referencia, m.observacion, m.pedido_id,
            o.nombre AS origen, d.nombre AS destino, u.nombre AS usuario,
            (SELECT count(*)::int FROM movimiento_items i WHERE i.movimiento_id = m.id) AS items,
            (SELECT coalesce(sum(i.cantidad),0)::int FROM movimiento_items i WHERE i.movimiento_id = m.id) AS unidades
     FROM movimientos m
     LEFT JOIN almacenes o ON o.id = m.origen_id
     LEFT JOIN almacenes d ON d.id = m.destino_id
     JOIN usuarios u ON u.id = m.usuario_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY m.fecha DESC, m.id DESC LIMIT 500`, params);
  return rows.map((r) => ({ ...r, id: Number(r.id), items: Number(r.items), unidades: Number(r.unidades) }));
});

route('GET', '/api/movimientos/:id', async ({ user, params }) => {
  permitir(user, 'verMovimientos');
  const id = toInt(params.id);
  const { rows } = await query(
    `SELECT m.*, o.nombre AS origen, d.nombre AS destino, u.nombre AS usuario
     FROM movimientos m LEFT JOIN almacenes o ON o.id = m.origen_id LEFT JOIN almacenes d ON d.id = m.destino_id
     JOIN usuarios u ON u.id = m.usuario_id WHERE m.id = $1`, [id]);
  if (!rows[0]) fail(404, 'Movimiento inexistente');
  const { rows: items } = await query(
    `SELECT i.cantidad, p.codigo, p.nombre, p.unidad FROM movimiento_items i JOIN productos p ON p.id = i.producto_id
     WHERE i.movimiento_id = $1 ORDER BY p.nombre`, [id]);
  return { ...rows[0], items: items.map((i) => ({ ...i, cantidad: Number(i.cantidad) })) };
});

// ---------- Notas de pedido ----------
async function cargarPedidos(whereSql, params) {
  const { rows } = await query(
    `SELECT pe.id, pe.estado, pe.observacion, pe.motivo_rechazo, pe.creado_en, pe.atendido_en,
            pe.origen_id, pe.destino_id, pe.solicitante_id,
            o.nombre AS origen, d.nombre AS destino, s.nombre AS solicitante, a.nombre AS atendido_por
     FROM pedidos pe JOIN almacenes o ON o.id = pe.origen_id JOIN almacenes d ON d.id = pe.destino_id
     JOIN usuarios s ON s.id = pe.solicitante_id LEFT JOIN usuarios a ON a.id = pe.atendido_por
     ${whereSql} ORDER BY (pe.estado = 'PENDIENTE') DESC, pe.creado_en DESC LIMIT 300`, params);
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const { rows: items } = await query(
    `SELECT pi.id, pi.pedido_id, pi.producto_id, pi.cantidad, pi.cantidad_entregada, p.codigo, p.nombre, p.unidad,
            coalesce(st.cantidad, 0) AS disponible_origen
     FROM pedido_items pi JOIN productos p ON p.id = pi.producto_id
     JOIN pedidos pe ON pe.id = pi.pedido_id
     LEFT JOIN stock st ON st.almacen_id = pe.origen_id AND st.producto_id = pi.producto_id
     WHERE pi.pedido_id = ANY($1::int[]) ORDER BY p.nombre`, [`{${ids.join(',')}}`]);
  const porPedido = {};
  for (const it of items) {
    (porPedido[Number(it.pedido_id)] = porPedido[Number(it.pedido_id)] || []).push({
      id: Number(it.id), producto_id: Number(it.producto_id), codigo: it.codigo, nombre: it.nombre, unidad: it.unidad,
      cantidad: Number(it.cantidad), cantidad_entregada: Number(it.cantidad_entregada), disponible_origen: Number(it.disponible_origen),
    });
  }
  return rows.map((r) => ({ ...r, id: Number(r.id), origen_id: Number(r.origen_id), destino_id: Number(r.destino_id), solicitante_id: Number(r.solicitante_id), items: porPedido[Number(r.id)] || [] }));
}

route('GET', '/api/pedidos', async ({ user, url }) => {
  permitir(user, 'verPedidos');
  const estado = url.searchParams.get('estado');
  const where = [];
  const params = [];
  if (user.rol === 'REQUIRENTE') { params.push(user.id); where.push(`pe.solicitante_id = $${params.length}`); }
  if (estado) { params.push(estado); where.push(`pe.estado = $${params.length}`); }
  return cargarPedidos(where.length ? 'WHERE ' + where.join(' AND ') : '', params);
});

route('POST', '/api/pedidos', async ({ user, body }) => {
  permitir(user, 'crearPedido');
  return tx(async (client) => {
    const origenId = toInt(body.origen_id);
    const destinoId = toInt(body.destino_id);
    await almacenActivo(client, origenId, 'origen');
    await almacenActivo(client, destinoId, 'destino');
    if (origenId === destinoId) fail(400, 'El origen y el destino deben ser distintos');
    if (!Array.isArray(body.items) || !body.items.length) fail(400, 'Agregá al menos un producto');
    const consolidados = new Map();
    for (const it of body.items) {
      const pid = toInt(it.producto_id);
      const cant = toInt(it.cantidad);
      if (!Number.isInteger(pid) || !Number.isInteger(cant) || cant <= 0) fail(400, 'Cada ítem necesita producto y cantidad entera mayor a 0');
      consolidados.set(pid, (consolidados.get(pid) || 0) + cant);
    }
    const { rows } = await client.query(
      'INSERT INTO pedidos (solicitante_id, origen_id, destino_id, observacion) VALUES ($1, $2, $3, $4) RETURNING id',
      [user.id, origenId, destinoId, str(body.observacion, 1000)]);
    const pedidoId = Number(rows[0].id);
    for (const [pid, cant] of consolidados) {
      const { rows: p } = await client.query('SELECT activo FROM productos WHERE id = $1', [pid]);
      if (!p[0] || !isTrue(p[0].activo)) fail(400, 'Hay un producto inexistente o inactivo en el pedido');
      await client.query('INSERT INTO pedido_items (pedido_id, producto_id, cantidad) VALUES ($1, $2, $3)', [pedidoId, pid, cant]);
    }
    return { id: pedidoId };
  });
});

async function pedidoPendiente(client, id) {
  const { rows } = await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) fail(404, 'Pedido inexistente');
  if (rows[0].estado !== 'PENDIENTE') fail(409, `El pedido ya está ${rows[0].estado}`);
  return rows[0];
}

// Atender: genera la transferencia (permite entregas parciales)
route('POST', '/api/pedidos/:id/atender', async ({ user, body, params }) => {
  permitir(user, 'atenderPedido');
  const id = toInt(params.id);
  return tx(async (client) => {
    const pe = await pedidoPendiente(client, id);
    const { rows: items } = await client.query('SELECT id, producto_id, cantidad FROM pedido_items WHERE pedido_id = $1', [id]);
    const entregas = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [toInt(i.item_id), toInt(i.cantidad)]));
    const movItems = [];
    for (const it of items) {
      const itemId = Number(it.id);
      const cant = entregas.has(itemId) ? entregas.get(itemId) : Number(it.cantidad);
      if (!Number.isInteger(cant) || cant < 0) fail(400, 'Cantidades a entregar inválidas');
      await client.query('UPDATE pedido_items SET cantidad_entregada = $2 WHERE id = $1', [itemId, cant]);
      if (cant > 0) movItems.push({ producto_id: Number(it.producto_id), cantidad: cant });
    }
    if (!movItems.length) fail(400, 'No hay cantidades a entregar. Si no se puede atender, rechazá el pedido.');
    const movId = await registrarMovimiento(client, {
      tipo: 'TRANSFERENCIA', origen_id: Number(pe.origen_id), destino_id: Number(pe.destino_id), items: movItems,
      usuario_id: user.id, pedido_id: id, referencia: `Nota de pedido #${id}`, observacion: str(body.observacion, 1000),
    });
    await client.query("UPDATE pedidos SET estado = 'COMPLETADO', atendido_por = $2, atendido_en = now() WHERE id = $1", [id, user.id]);
    return { movimiento_id: movId };
  });
});

route('POST', '/api/pedidos/:id/rechazar', async ({ user, body, params }) => {
  permitir(user, 'atenderPedido');
  const id = toInt(params.id);
  return tx(async (client) => {
    await pedidoPendiente(client, id);
    await client.query("UPDATE pedidos SET estado = 'RECHAZADO', motivo_rechazo = $2, atendido_por = $3, atendido_en = now() WHERE id = $1",
      [id, str(body.motivo, 500), user.id]);
    return { ok: true };
  });
});

route('POST', '/api/pedidos/:id/cancelar', async ({ user, params }) => {
  permitir(user, 'verPedidos');
  const id = toInt(params.id);
  return tx(async (client) => {
    const pe = await pedidoPendiente(client, id);
    if (Number(pe.solicitante_id) !== user.id && user.rol !== 'ADMIN') fail(403, 'Solo quien hizo el pedido puede cancelarlo');
    await client.query("UPDATE pedidos SET estado = 'CANCELADO', atendido_en = now() WHERE id = $1", [id]);
    return { ok: true };
  });
});

// ---------- Compras a proveedores ----------
require('./src/compras')({ route, query, tx, fail, permitir, registrarMovimiento, almacenActivo, isTrue, toInt, str, fechaOk });

// ---------- Integración Fudo ----------
const fudo = require('./src/fudo');
const { pool } = require('./src/db');
route('GET', '/api/fudo/estado', async ({ user }) => {
  if (!user.permisos.includes('compras') && !user.permisos.includes('parametrizar')) fail(403, 'No tenés permiso para esta operación');
  const ultimo = {};
  for (const e of ['proveedores', 'productos']) {
    const { rows } = await query('SELECT * FROM fudo_sync_log WHERE entidad = $1 ORDER BY id DESC LIMIT 1', [e]);
    ultimo[e] = rows[0] || null;
  }
  const { rows: v } = await query(`SELECT (SELECT count(*)::int FROM proveedores WHERE fudo_id IS NOT NULL) AS prov,
    (SELECT count(*)::int FROM productos WHERE fudo_id IS NOT NULL) AS prod`);
  return {
    configurado: fudo.configurado(), minutos: Number(process.env.FUDO_SYNC_MINUTES ?? 30),
    ultimo: ultimo.proveedores, ultimo_productos: ultimo.productos, ultimos: ultimo,
    vinculados: Number(v[0].prov), vinculados_productos: Number(v[0].prod),
  };
});
route('POST', '/api/fudo/sincronizar', async ({ user, url }) => {
  if (!user.permisos.includes('compras') && !user.permisos.includes('parametrizar')) fail(403, 'No tenés permiso para esta operación');
  if (!fudo.configurado()) fail(400, 'La integración con Fudo no está configurada: cargá FUDO_API_KEY y FUDO_API_SECRET en Render.');
  const entidad = url.searchParams.get('entidad') || 'proveedores';
  const fn = entidad === 'productos' ? fudo.sincronizarProductos : fudo.sincronizarProveedores;
  try { return await fn(pool, 'MANUAL'); } catch (e) { fail(502, e.message); }
});

// ---------- Consumos desde ventas de Fudo ----------
require('./src/consumos')({ route, query, tx, fail, permitir, registrarMovimiento, almacenActivo, isTrue, toInt, str, pool });

const { calcularTareas } = require('./src/tareas');

// ---------- Panel ----------
route('GET', '/api/dashboard', async ({ user }) => {
  const res = { rol: user.rol, pedidos_pendientes: 0, tareas: await calcularTareas(user, { query, fudo }) };
  if (user.permisos.includes('verCompras') || user.permisos.includes('portalProveedor')) {
    const prov = user.rol === 'PROVEEDOR';
    const { rows } = await query(
      `SELECT estado, count(*)::int AS n FROM ordenes_compra ${prov ? "WHERE proveedor_id = $1 AND estado <> 'BORRADOR'" : ''} GROUP BY estado`,
      prov ? [user.proveedor_id] : []);
    res.oc = Object.fromEntries(rows.map((r) => [r.estado, Number(r.n)]));
  }
  if (!user.permisos.includes('verPedidos')) return res;
  const pend = await query(
    user.rol === 'REQUIRENTE'
      ? "SELECT count(*)::int AS n FROM pedidos WHERE estado = 'PENDIENTE' AND solicitante_id = $1"
      : "SELECT count(*)::int AS n FROM pedidos WHERE estado = 'PENDIENTE'",
    user.rol === 'REQUIRENTE' ? [user.id] : []);
  res.pedidos_pendientes = Number(pend.rows[0].n);
  if (user.permisos.includes('verStock')) {
    const { rows: alm } = await query(
      `SELECT a.id, a.nombre, a.activo,
              count(s.producto_id) FILTER (WHERE s.cantidad > 0)::int AS productos,
              coalesce(sum(s.cantidad), 0)::int AS unidades
       FROM almacenes a LEFT JOIN stock s ON s.almacen_id = a.id GROUP BY a.id ORDER BY a.id`);
    res.almacenes = alm.map((a) => ({ id: Number(a.id), nombre: a.nombre, activo: isTrue(a.activo), productos: Number(a.productos), unidades: Number(a.unidades) }));
    const { rows: alertas } = await query(
      `SELECT ${PRODUCTO_COLS}, (SELECT coalesce(sum(cantidad),0)::int FROM stock s WHERE s.producto_id = productos.id) AS total
       FROM productos WHERE activo AND (alerta_vencimiento OR alerta_cuidado OR alerta_frio)
       ORDER BY alerta_vencimiento DESC, fecha_vencimiento NULLS LAST, nombre`);
    res.alertas = alertas.map((a) => ({ ...normalizarProducto(a), total: Number(a.total) }));
    const { rows: ult } = await query(
      `SELECT m.id, m.tipo, m.fecha, o.nombre AS origen, d.nombre AS destino, u.nombre AS usuario
       FROM movimientos m LEFT JOIN almacenes o ON o.id = m.origen_id LEFT JOIN almacenes d ON d.id = m.destino_id
       JOIN usuarios u ON u.id = m.usuario_id ORDER BY m.fecha DESC, m.id DESC LIMIT 8`);
    res.ultimos = ult.map((m) => ({ ...m, id: Number(m.id) }));
  }
  return res;
});

route('GET', '/healthz', async () => ({ ok: true }), { auth: false });

// ---------- Servidor ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  }
  try {
    let match = null;
    let methodMismatch = false;
    for (const r of routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      if (r.method !== req.method) { methodMismatch = true; continue; }
      match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!match) fail(methodMismatch ? 405 : 404, 'Ruta no encontrada');
    let user = null;
    if (match.r.auth) {
      user = await currentUser(req);
      if (!user) fail(401, 'Sesión vencida o inválida. Ingresá nuevamente.');
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const data = await match.r.handler({ req, url, params: match.params, body, user });
    if (data && data.__raw) { res.writeHead(200, data.__raw.headers); return res.end(data.__raw.body); }
    sendJson(res, 200, data);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    if (err && err.code === '23514') return sendJson(res, 409, { error: 'La operación dejaría stock negativo o datos inválidos' });
    console.error(err);
    sendJson(res, 500, { error: 'Error interno del servidor' });
  }
});

console.log(`Iniciando Vinilo Almacén (Node ${process.version})…`);
migrate()
  .then(() => server.listen(PORT, '0.0.0.0', () => {
    console.log(`Vinilo Almacén escuchando en puerto ${PORT}`);
    fudo.iniciarSincronizacionAutomatica(pool);
  }))
  .catch((err) => { console.error('Error al inicializar la base de datos:', err.message || err); process.exit(1); });
