// Consumo del personal: cada empleado tiene su cliente de Fudo (cuenta corriente) en cada cuenta (GALPON / BAR).
// Al importar consumos desde Fudo, lo vendido a esos clientes queda separado como "Consumo del personal"
// y cada empleado lo ve en "Mis consumos".
const fudo = require('./fudo');

module.exports = function registrarConsumoPersonal({ route, query, fail, permitir, toInt, str, isTrue }) {
  const cache = {};
  const nombreCli = (a = {}) => String(a.name || [a.firstName, a.lastName].filter(Boolean).join(' ') || a.fullName || a.businessName || '').trim();
  async function clientesDe(cta) {
    const c = cache[cta.id];
    if (c && Date.now() - c.t < 10 * 60 * 1000) return c.lista;
    const raw = await fudo.listarCon(cta.get, '/customers');
    const lista = raw.map((x) => {
      const a = x.attributes || {};
      const cc = Object.keys(a).find((k) => /house|account|corriente|credit/i.test(k));
      return { id: String(x.id), nombre: nombreCli(a) || `Cliente ${x.id}`, detalle: [a.email, a.phone, a.vatId || a.documentNumber].filter(Boolean).join(' · '),
        cuenta_corriente: cc ? a[cc] : null };
    }).sort((p, q) => p.nombre.localeCompare(q.nombre, 'es'));
    cache[cta.id] = { t: Date.now(), lista };
    return lista;
  }
  const cuenta = (id) => { const c = fudo.cuentasTablero().find((x) => x.id === id); if (!c) fail(400, 'Cuenta de Fudo no configurada'); return c; };
  const puedeVerTodos = (u) => u.rol === 'ADMIN' || ['usuarios', 'verHoras', 'consumir'].some((p) => u.permisos.includes(p));

  // Clientes de Fudo de una cuenta (para elegir el de cada empleado)
  route('GET', '/api/fudo/clientes', async ({ user, url }) => {
    permitir(user, 'usuarios');
    const cta = cuenta(url.searchParams.get('cuenta') || 'galpon');
    try { return { cuenta: cta.id, nombre: cta.nombre, clientes: await clientesDe(cta) }; } catch (e) { fail(502, `No se pudieron leer los clientes del Fudo de ${cta.nombre}: ${e.message}`); }
  });

  route('GET', '/api/usuarios/:id/fudo-clientes', async ({ user, params }) => {
    permitir(user, 'usuarios');
    const { rows } = await query('SELECT cuenta, cliente_id, cliente_nombre FROM usuario_fudo_clientes WHERE usuario_id = $1 ORDER BY cuenta', [toInt(params.id)]);
    return { cuentas: fudo.cuentasTablero().map(({ id, nombre }) => ({ id, nombre })), clientes: rows };
  });

  // Reemplaza los clientes de Fudo del empleado: [{ cuenta, cliente_id, cliente_nombre }]
  route('PUT', '/api/usuarios/:id/fudo-clientes', async ({ user, params, body }) => {
    permitir(user, 'usuarios');
    const uid = toInt(params.id);
    const lista = (Array.isArray(body.clientes) ? body.clientes : []).map((c) => ({ cuenta: c.cuenta === 'bar' ? 'bar' : 'galpon', cliente_id: str(c.cliente_id, 20), cliente_nombre: str(c.cliente_nombre, 200) }))
      .filter((c) => c.cliente_id);
    for (const c of lista) {
      const { rows } = await query('SELECT u.nombre FROM usuario_fudo_clientes f JOIN usuarios u ON u.id = f.usuario_id WHERE f.cuenta = $1 AND f.cliente_id = $2 AND f.usuario_id <> $3', [c.cuenta, c.cliente_id, uid]);
      if (rows[0]) fail(409, `El cliente "${c.cliente_nombre || c.cliente_id}" ya está asignado a ${rows[0].nombre}`);
    }
    await query('DELETE FROM usuario_fudo_clientes WHERE usuario_id = $1', [uid]);
    for (const c of lista) {
      await query('INSERT INTO usuario_fudo_clientes (usuario_id, cuenta, cliente_id, cliente_nombre) VALUES ($1,$2,$3,$4) ON CONFLICT (cuenta, cliente_id) DO UPDATE SET usuario_id = EXCLUDED.usuario_id, cliente_nombre = EXCLUDED.cliente_nombre',
        [uid, c.cuenta, c.cliente_id, c.cliente_nombre]);
    }
    return { ok: true, clientes: lista.length };
  });

  const rango = (url) => {
    const mes = /^\d{4}-\d{2}$/.test(url.searchParams.get('mes') || '') ? url.searchParams.get('mes') : null;
    const ahora = new Date(Date.now() - 3 * 3600e3);
    const m = mes || `${ahora.getUTCFullYear()}-${String(ahora.getUTCMonth() + 1).padStart(2, '0')}`;
    const [y, mm] = m.split('-').map(Number);
    const desde = `${m}-01T00:00:00-03:00`;
    const hasta = `${mm === 12 ? y + 1 : y}-${String(mm === 12 ? 1 : mm + 1).padStart(2, '0')}-01T00:00:00-03:00`;
    return { mes: m, desde, hasta };
  };
  const filas = async (r, uid) => {
    const { rows } = await query(
      `SELECT cp.id, cp.usuario_id, u.nombre AS empleado, cp.cuenta, cp.venta_id, cp.fecha, cp.nombre, cp.cantidad, cp.importe, ci.estado, ci.id AS importacion_id
       FROM consumos_personal cp JOIN consumo_importaciones ci ON ci.id = cp.importacion_id JOIN usuarios u ON u.id = cp.usuario_id
       WHERE ci.estado <> 'ANULADA' AND cp.fecha >= $1 AND cp.fecha < $2 ${uid ? 'AND cp.usuario_id = $3' : ''}
       ORDER BY u.nombre, cp.fecha DESC, cp.id`, uid ? [r.desde, r.hasta, uid] : [r.desde, r.hasta]);
    const cuentas = Object.fromEntries(fudo.cuentasTablero().map((c) => [c.id, c.nombre]));
    return rows.map((x) => ({ ...x, id: Number(x.id), usuario_id: Number(x.usuario_id), importacion_id: Number(x.importacion_id), cantidad: Number(x.cantidad),
      importe: x.importe === null ? null : Number(x.importe), sucursal: cuentas[x.cuenta] || x.cuenta }));
  };

  // Portal del personal: lo consumido por el usuario (por mes)
  route('GET', '/api/mis-consumos', async ({ user, url }) => {
    const r = rango(url);
    const { rows: vinc } = await query('SELECT count(*)::int AS n FROM usuario_fudo_clientes WHERE usuario_id = $1', [user.id]);
    const items = await filas(r, user.id);
    return { mes: r.mes, vinculado: Number(vinc[0].n) > 0, items, total: items.reduce((s, x) => s + (x.importe || 0), 0), unidades: items.reduce((s, x) => s + x.cantidad, 0) };
  });

  // Resumen por empleado (para liquidar / descontar)
  route('GET', '/api/consumos-personal', async ({ user, url }) => {
    if (!puedeVerTodos(user)) fail(403, 'No tenés permiso para esta operación');
    const r = rango(url);
    const items = await filas(r, null);
    const por = new Map();
    for (const x of items) {
      const e = por.get(x.usuario_id) || { usuario_id: x.usuario_id, empleado: x.empleado, total: 0, unidades: 0, sin_precio: 0, items: [] };
      e.total += x.importe || 0; e.unidades += x.cantidad; if (x.importe === null) e.sin_precio++; e.items.push(x);
      por.set(x.usuario_id, e);
    }
    return { mes: r.mes, empleados: [...por.values()], total: items.reduce((s, x) => s + (x.importe || 0), 0) };
  });
};
