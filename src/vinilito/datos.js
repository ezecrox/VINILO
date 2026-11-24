// Consultas de datos para Vinilito. Todas respetan los permisos y almacenes visibles del usuario.
const STOP = new Set(['cuantas', 'cuantos', 'cuanta', 'cuanto', 'tengo', 'tenemos', 'tiene', 'tienen', 'hay', 'queda', 'quedan', 'en', 'de', 'del', 'la', 'el',
  'los', 'las', 'que', 'stock', 'unidades', 'unidad', 'me', 'nos', 'un', 'una', 'y', 'o', 'a', 'al', 'por', 'para', 'con', 'mi', 'mis', 'hoy', 'ahora',
  'decime', 'dime', 'sabes', 'saber', 'quiero', 'cual', 'cuales', 'es', 'son', 'esta', 'estan', 'deposito', 'almacen', 'vinilito', 'hola', 'che',
  'consulta', 'ver', 'mostrar', 'mostrame', 'total', 'todos', 'todas', 'existencia', 'existencias', 'botellas', 'botella', 'latas', 'lata']);

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim();
const singular = (t) => (t.length > 4 && t.endsWith('es') && !t.endsWith('ces') ? t.slice(0, -2) : t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
const tokens = (s) => norm(s).split(' ').filter(Boolean).map(singular);

module.exports = function crearDatos({ query, user, calcularTareas, fudo, sqlAlm }) {
  const p = (x) => user.permisos.includes(x);
  const ve = (id) => !user.almacenes || user.almacenes.includes(Number(id));
  const sinPermiso = (que) => ({ error: `Tu usuario no tiene acceso a ${que}.` });

  async function almacenes() {
    const { rows } = await query('SELECT id, nombre FROM almacenes WHERE activo ORDER BY id');
    return rows.map((r) => ({ id: Number(r.id), nombre: r.nombre })).filter((a) => ve(a.id));
  }

  // Detecta un almacén mencionado en el texto (por coincidencia de palabras y alias)
  async function detectarAlmacen(texto) {
    const { rows } = await query('SELECT id, nombre FROM almacenes WHERE activo ORDER BY id');
    const tq = new Set(tokens(texto));
    let mejor = null;
    for (const a of rows) {
      const ta = tokens(a.nombre).filter((t) => !['el', 'la', 'los', 'las', 'de'].includes(t));
      const alias = [];
      if (ta.includes('galpon')) alias.push('galpon');
      if (ta.includes('bar')) alias.push('bar');
      if (ta.includes('central')) alias.push('central', 'centro');
      const hits = ta.filter((t) => tq.has(t)).length + alias.filter((t) => tq.has(t) && !ta.includes(t)).length;
      const distintivo = ta.some((t) => tq.has(t) && rows.filter((o) => tokens(o.nombre).includes(t)).length === 1);
      const score = hits + (distintivo ? 2 : 0);
      if (hits && (!mejor || score > mejor.score)) mejor = { id: Number(a.id), nombre: a.nombre, score, toks: [...ta, ...alias] };
    }
    return mejor;
  }

  // Busca productos por texto libre; devuelve los de mejor coincidencia
  async function buscarProductos(texto, { excluir = [] } = {}) {
    const q = tokens(texto).filter((t) => !STOP.has(t) && !excluir.includes(t));
    if (!q.length) return [];
    const { rows } = await query('SELECT id, codigo, nombre, categoria, unidad, activo FROM productos WHERE gestion_stock');
    const res = [];
    for (const r of rows) {
      const tp = tokens(`${r.nombre}`);
      const hits = q.filter((t) => tp.some((x) => x === t || (t.length >= 3 && x.startsWith(t)))).length;
      const codigo = norm(r.codigo) === norm(texto) || q.includes(norm(r.codigo));
      if (!hits && !codigo) continue;
      const score = codigo ? 2 : hits / q.length;
      res.push({ id: Number(r.id), codigo: r.codigo, nombre: r.nombre, categoria: r.categoria, unidad: r.unidad,
        activo: r.activo === true || r.activo === 't', score, extra: tp.length - hits });
    }
    if (!res.length) return [];
    const max = Math.max(...res.map((r) => r.score));
    if (max < 0.5) return [];
    return res.filter((r) => r.score === max).sort((a, b) => (b.activo - a.activo) || (a.extra - b.extra) || a.nombre.localeCompare(b.nombre)).slice(0, 8);
  }

  async function stock({ producto, almacen, productos: dados } = {}) {
    if (!p('verStock')) return sinPermiso('ver el stock');
    let alm = null;
    if (almacen) {
      alm = typeof almacen === 'number' ? { id: almacen } : await detectarAlmacen(almacen);
      if (!alm) return { error: `No encontré el almacén "${almacen}".` };
      if (!ve(alm.id)) return { error: `No tenés acceso al almacén ${alm.nombre || ''}.` };
    }
    const prods = dados && dados.length ? dados : producto ? await buscarProductos(producto) : [];
    if (producto && !prods.length) return { error: `No encontré productos que coincidan con "${producto}".` };
    const vis = await almacenes();
    const ids = prods.map((x) => x.id);
    const { rows } = await query(
      `SELECT s.producto_id, s.almacen_id, s.cantidad FROM stock s WHERE s.cantidad <> 0 ${ids.length ? `AND s.producto_id = ANY('{${ids.join(',')}}'::int[])` : ''}`);
    const { rows: mins } = await query(`SELECT almacen_id, producto_id, minimo FROM stock_minimos ${ids.length ? `WHERE producto_id = ANY('{${ids.join(',')}}'::int[])` : ''}`);
    const almsConsulta = alm ? vis.filter((a) => a.id === alm.id) : vis;
    const out = (prods.length ? prods : []).map((pr) => ({
      producto: pr.nombre, codigo: pr.codigo, activo: pr.activo,
      por_almacen: almsConsulta.map((a) => {
        const c = rows.find((r) => Number(r.producto_id) === pr.id && Number(r.almacen_id) === a.id);
        const m = mins.find((r) => Number(r.producto_id) === pr.id && Number(r.almacen_id) === a.id);
        return { almacen: a.nombre, cantidad: c ? Number(c.cantidad) : 0, minimo: m ? Number(m.minimo) : null };
      }),
    }));
    out.forEach((o) => { o.total = o.por_almacen.reduce((s, x) => s + x.cantidad, 0); });
    return { almacen: alm ? (vis.find((a) => a.id === alm.id) || {}).nombre : null, productos: out };
  }

  async function bajoMinimo({ almacen } = {}) {
    if (!p('verStock')) return sinPermiso('ver el stock');
    let almId = null;
    if (almacen) { const a = await detectarAlmacen(almacen); if (a) almId = a.id; }
    const { rows } = await query(
      `SELECT a.nombre AS almacen, pr.nombre AS producto, m.minimo, coalesce(s.cantidad,0)::int AS cantidad
       FROM stock_minimos m JOIN productos pr ON pr.id = m.producto_id AND pr.activo AND pr.gestion_stock JOIN almacenes a ON a.id = m.almacen_id AND a.activo
       LEFT JOIN stock s ON s.almacen_id = m.almacen_id AND s.producto_id = m.producto_id
       WHERE coalesce(s.cantidad,0) < m.minimo ${sqlAlm(user, 'm.almacen_id')} ${almId ? `AND m.almacen_id = ${Number(almId)}` : ''}
       ORDER BY a.id, pr.nombre`);
    const { rows: hay } = await query('SELECT count(*)::int AS n FROM stock_minimos');
    return { definidos: Number(hay[0].n) > 0, productos: rows.map((r) => ({ ...r, minimo: Number(r.minimo), cantidad: Number(r.cantidad), faltan: Number(r.minimo) - Number(r.cantidad) })) };
  }

  async function tareas() {
    const t = await calcularTareas(user, { query, fudo, sqlAlm });
    return t.map((x) => ({ titulo: x.titulo, prioridad: x.prioridad, cantidad: x.cantidad, detalle: x.detalle, link: x.link,
      ejemplos: x.items.slice(0, 5).map((i) => `${i.texto}${i.sub ? ' — ' + i.sub : ''}`) }));
  }

  async function vencimientos({ dias = 15 } = {}) {
    if (!p('verStock')) return sinPermiso('ver el stock');
    const d = Math.min(Math.max(Number(dias) || 15, 1), 120);
    const { rows } = await query(
      `SELECT pr.nombre, pr.fecha_vencimiento, (pr.fecha_vencimiento - CURRENT_DATE) AS dias,
              (SELECT coalesce(sum(cantidad),0)::int FROM stock s WHERE s.producto_id = pr.id ${sqlAlm(user, 's.almacen_id')}) AS total
       FROM productos pr WHERE pr.activo AND pr.gestion_stock AND pr.alerta_vencimiento AND pr.fecha_vencimiento IS NOT NULL AND pr.fecha_vencimiento <= CURRENT_DATE + ${d}
       ORDER BY pr.fecha_vencimiento`);
    return { dias: d, productos: rows.map((r) => ({ producto: r.nombre, vence: String(r.fecha_vencimiento).slice(0, 10), dias: Number(r.dias), stock: Number(r.total) })) };
  }

  async function pedidosProveedores({ estado } = {}) {
    if (!p('verCompras') && !p('compras')) return sinPermiso('los pedidos a proveedores');
    const est = estado && ['BORRADOR', 'CONFIRMADA', 'PARCIAL', 'RECIBIDA', 'CERRADA', 'ANULADA'].includes(String(estado).toUpperCase()) ? String(estado).toUpperCase() : null;
    const { rows } = await query(
      `SELECT oc.id, oc.estado, oc.fecha_entrega, pr.nombre AS proveedor, a.nombre AS almacen,
              (SELECT coalesce(sum(GREATEST(i.cantidad - i.cantidad_recibida,0)),0)::int FROM oc_items i WHERE i.oc_id = oc.id) AS pendiente
       FROM ordenes_compra oc JOIN proveedores pr ON pr.id = oc.proveedor_id JOIN almacenes a ON a.id = oc.almacen_id
       WHERE ${est ? `oc.estado = '${est}'` : "oc.estado IN ('BORRADOR','CONFIRMADA','PARCIAL')"} ${p('compras') ? '' : "AND oc.estado <> 'BORRADOR'"} ${sqlAlm(user, 'oc.almacen_id')}
       ORDER BY oc.fecha_entrega NULLS LAST, oc.id LIMIT 30`);
    return { pedidos: rows.map((r) => ({ numero: Number(r.id), estado: r.estado, proveedor: r.proveedor, almacen: r.almacen, entrega: r.fecha_entrega ? String(r.fecha_entrega).slice(0, 10) : null, unidades_pendientes: Number(r.pendiente) })) };
  }

  async function notasPedido({ estado = 'PENDIENTE' } = {}) {
    if (!p('verPedidos')) return sinPermiso('las notas de pedido');
    const est = ['PENDIENTE', 'COMPLETADO', 'RECHAZADO', 'CANCELADO'].includes(String(estado).toUpperCase()) ? String(estado).toUpperCase() : 'PENDIENTE';
    const propio = user.rol === 'REQUIRENTE' ? `AND pe.solicitante_id = ${Number(user.id)}` : '';
    const vis = user.almacenes && !propio ? `AND (pe.origen_id = ANY('{${user.almacenes.join(',')}}'::int[]) OR pe.destino_id = ANY('{${user.almacenes.join(',')}}'::int[]))` : '';
    const { rows } = await query(
      `SELECT pe.id, pe.creado_en, o.nombre AS origen, d.nombre AS destino, s.nombre AS solicitante,
              (SELECT count(*)::int FROM pedido_items i WHERE i.pedido_id = pe.id) AS items
       FROM pedidos pe JOIN almacenes o ON o.id = pe.origen_id JOIN almacenes d ON d.id = pe.destino_id JOIN usuarios s ON s.id = pe.solicitante_id
       WHERE pe.estado = '${est}' ${propio} ${vis} ORDER BY pe.creado_en DESC LIMIT 30`);
    return { estado: est, notas: rows.map((r) => ({ numero: Number(r.id), origen: r.origen, destino: r.destino, solicitante: r.solicitante, productos: Number(r.items), fecha: r.creado_en })) };
  }

  // Resumen de unidades por producto en movimientos (p. ej. consumos de la semana)
  async function movimientos({ tipo = 'CONSUMO', producto, almacen, desde, hasta } = {}) {
    if (!p('verMovimientos') && !p('consumir')) return sinPermiso('los movimientos');
    const t = String(tipo || 'CONSUMO').toUpperCase();
    if (!['RECEPCION', 'TRANSFERENCIA', 'CONSUMO', 'AJUSTE'].includes(t)) return { error: 'Tipo inválido' };
    const d = desde ? new Date(desde) : new Date(Date.now() - 7 * 86400e3);
    const h = hasta ? new Date(hasta) : new Date();
    if (Number.isNaN(d.getTime()) || Number.isNaN(h.getTime())) return { error: 'Fechas inválidas' };
    let almFiltro = '';
    if (almacen) {
      const a = await detectarAlmacen(almacen);
      if (!a) return { error: `No encontré el almacén "${almacen}".` };
      if (!ve(a.id)) return { error: `No tenés acceso al almacén ${a.nombre}.` };
      almFiltro = `AND (m.origen_id = ${a.id} OR m.destino_id = ${a.id})`;
    } else if (user.almacenes) {
      almFiltro = `AND (m.origen_id = ANY('{${user.almacenes.join(',')}}'::int[]) OR m.destino_id = ANY('{${user.almacenes.join(',')}}'::int[]))`;
    }
    let prodFiltro = '';
    if (producto) {
      const ps = await buscarProductos(producto);
      if (!ps.length) return { error: `No encontré productos que coincidan con "${producto}".` };
      prodFiltro = `AND i.producto_id = ANY('{${ps.map((x) => x.id).join(',')}}'::int[])`;
    }
    const { rows } = await query(
      `SELECT pr.nombre AS producto, sum(i.cantidad)::int AS unidades, count(DISTINCT m.id)::int AS movimientos
       FROM movimientos m JOIN movimiento_items i ON i.movimiento_id = m.id JOIN productos pr ON pr.id = i.producto_id
       WHERE m.tipo = $1 AND m.fecha >= $2 AND m.fecha < $3 ${almFiltro} ${prodFiltro}
       GROUP BY pr.nombre ORDER BY sum(i.cantidad) DESC LIMIT 25`, [t, d.toISOString(), h.toISOString()]);
    return { tipo: t, desde: d.toISOString(), hasta: h.toISOString(), productos: rows.map((r) => ({ producto: r.producto, unidades: Number(r.unidades), movimientos: Number(r.movimientos) })) };
  }

  return { almacenes, detectarAlmacen, buscarProductos, stock, bajoMinimo, tareas, vencimientos, pedidosProveedores, notasPedido, movimientos, norm, tokens };
};
