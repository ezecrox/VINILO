// Consumo del personal: cada empleado tiene su cliente de Fudo (cuenta corriente) en cada cuenta (GALPON / BAR).
// Al importar consumos desde Fudo, lo vendido a esos clientes queda separado como "Consumo del personal"
// y cada empleado lo ve en "Mis consumos".
const fudo = require('./fudo');

const { leerItemsFudo, esCancelado } = require('./consumos');

module.exports = function registrarConsumoPersonal({ route, query, fail, permitir, toInt, str, isTrue }) {
  const nrm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Carga inicial: trae de Fudo lo vendido a los clientes de los empleados en un período, sin tocar el stock.
  // Reemplaza la carga inicial previa del mismo período y no pisa lo que ya vino con una importación de consumos.
  async function cargaInicial(desde, hasta, origen = 'MANUAL') {
    const res = [];
    for (const cta of fudo.cuentasTablero()) {
      const { rows: mapa } = await query('SELECT usuario_id, cliente_id, cliente_nombre FROM usuario_fudo_clientes WHERE cuenta = $1', [cta.id]);
      if (!mapa.length) { res.push({ cuenta: cta.id, nombre: cta.nombre, empleados: 0, items: 0, nota: 'sin empleados vinculados' }); continue; }
      const porId = new Map(mapa.map((r) => [String(r.cliente_id), Number(r.usuario_id)]));
      const porNom = new Map(mapa.filter((r) => r.cliente_nombre).map((r) => [nrm(r.cliente_nombre), Number(r.usuario_id)]));
      const { rows: cubiertos } = await query(
        `SELECT ci.desde, ci.hasta FROM consumo_importaciones ci WHERE ci.cuenta = $1 AND ci.estado <> 'ANULADA'
         AND EXISTS (SELECT 1 FROM consumos_personal cp WHERE cp.importacion_id = ci.id)`, [cta.id]);
      const cubierto = (f) => cubiertos.some((c) => f >= new Date(c.desde) && f < new Date(c.hasta));
      const leido = await leerItemsFudo(desde, hasta, cta.get);
      const colFudo = cta.principal ? 'fudo_id' : 'fudo_bar_id';
      const filas = [];
      let conCliente = 0;
      for (const it of leido.items) {
        if (esCancelado(it, leido.ventas)) continue;
        const sr = it.relationships && it.relationships.sale && it.relationships.sale.data;
        const cli = sr && leido.clientes.get(String(sr.id));
        if (cli) conCliente++;
        const uid = cli && ((cli.id && porId.get(cli.id)) || (cli.nombre && porNom.get(nrm(cli.nombre))));
        if (!uid) continue;
        const a = it.attributes || {};
        const f = new Date(a.createdAt);
        if (cubierto(f)) continue;
        const rel = it.relationships && it.relationships.product && it.relationships.product.data;
        const cant = Number(a.quantity ?? a.amount ?? 1);
        if (!rel || !Number.isFinite(cant) || cant <= 0) continue;
        const precio = Number(a.price ?? a.unitPrice);
        filas.push({ uid, venta: String(sr.id), fecha: a.createdAt, fid: String(rel.id), nombre: a.name || a.productName || null, cant,
          importe: Number.isFinite(precio) ? Math.round(precio * cant * 100) / 100 : null });
      }
      await query('DELETE FROM consumos_personal WHERE importacion_id IS NULL AND cuenta = $1 AND fecha >= $2 AND fecha < $3', [cta.id, desde.toISOString(), hasta.toISOString()]);
      for (const x of filas) {
        const { rows: p } = await query(`SELECT id, nombre FROM productos WHERE ${colFudo} = $1`, [x.fid]);
        await query(`INSERT INTO consumos_personal (importacion_id, usuario_id, cuenta, venta_id, fecha, fudo_product_id, producto_id, nombre, cantidad, importe)
          VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9)`, [x.uid, cta.id, x.venta, x.fecha, x.fid, p[0] ? Number(p[0].id) : null, (p[0] ? p[0].nombre : x.nombre) || `Producto Fudo ${x.fid}`, x.cant, x.importe]);
      }
      const r = { cuenta: cta.id, nombre: cta.nombre, items_leidos: leido.items.length, ventas_con_cliente: leido.clientes.size, items_con_cliente: conCliente,
        items: filas.length, empleados: new Set(filas.map((x) => x.uid)).size, importe: filas.reduce((t, x) => t + (x.importe || 0), 0) };
      console.log(`Consumo del personal · carga inicial ${origen} (${cta.nombre}) ${desde.toISOString()} → ${hasta.toISOString()}: ${JSON.stringify(r)}`);
      res.push(r);
    }
    return res;
  }
  // Carga inicial de noviembre 2026 (una sola vez, en segundo plano al arrancar)
  setTimeout(async () => {
    try {
      const { rows } = await query("SELECT 1 FROM app_config WHERE clave = 'carga_personal_2026_11'");
      if (rows.length || !fudo.cuentasTablero().length) return;
      const r = await cargaInicial(new Date('2026-11-01T00:00:00-03:00'), new Date(), 'ARRANQUE');
      await query("INSERT INTO app_config (clave, valor) VALUES ('carga_personal_2026_11', $1) ON CONFLICT (clave) DO NOTHING", [JSON.stringify(r)]);
    } catch (e) { console.warn('Consumo del personal · carga inicial falló:', e.message); }
  }, 20000);

  route('POST', '/api/consumos-personal/carga-inicial', async ({ user, body }) => {
    if (user.rol !== 'ADMIN') fail(403, 'Solo el administrador');
    const desde = new Date(body.desde), hasta = body.hasta ? new Date(body.hasta) : new Date();
    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || hasta <= desde) fail(400, 'Período inválido');
    if (hasta - desde > 93 * 24 * 3600e3) fail(400, 'El período no puede superar los 3 meses');
    try { return { cuentas: await cargaInicial(desde, hasta, 'MANUAL') }; } catch (e) { fail(502, e.message); }
  });

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
       FROM consumos_personal cp LEFT JOIN consumo_importaciones ci ON ci.id = cp.importacion_id JOIN usuarios u ON u.id = cp.usuario_id
       WHERE (cp.importacion_id IS NULL OR ci.estado <> 'ANULADA') AND cp.fecha >= $1 AND cp.fecha < $2 ${uid ? 'AND cp.usuario_id = $3' : ''}
       ORDER BY u.nombre, cp.fecha DESC, cp.id`, uid ? [r.desde, r.hasta, uid] : [r.desde, r.hasta]);
    const cuentas = Object.fromEntries(fudo.cuentasTablero().map((c) => [c.id, c.nombre]));
    return rows.map((x) => ({ ...x, id: Number(x.id), usuario_id: Number(x.usuario_id), importacion_id: x.importacion_id ? Number(x.importacion_id) : null, estado: x.estado || 'CARGA_INICIAL', cantidad: Number(x.cantidad),
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
