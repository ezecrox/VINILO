// Importación de consumos desde las ventas de Fudo (ítems vendidos por producto en un período).
// Flujo: importar período -> BORRADOR (elegir almacén, revisar cantidades) -> CONFIRMADA (movimiento CONSUMO).
const fudo = require('./fudo');

const PAGE = 500;

const esCancelado = (it, ventas) => {
  const a = it.attributes || {};
  if (a.canceled === true || a.cancelled === true) return true;
  const st = String(a.status || a.state || '').toUpperCase();
  if (st.includes('CANCEL')) return true;
  const saleRel = it.relationships && it.relationships.sale && it.relationships.sale.data;
  const venta = saleRel && ventas.get(String(saleRel.id));
  if (venta) {
    const vs = String(venta.saleState || venta.state || venta.status || '').toUpperCase();
    if (vs.includes('CANCEL')) return true;
  }
  return false;
};

/** Lee de Fudo los ítems vendidos entre desde y hasta (Date). Recorre de lo más nuevo hacia atrás. */
async function leerItemsFudo(desde, hasta, get = fudo.fudoGet) {
  const items = [];
  const ventas = new Map();
  const clientes = new Map(); // venta → { id, nombre } del cliente de Fudo
  let incluirVenta = true;
  for (let page = 1; page <= 2000; page++) {
    const params = { 'page[size]': PAGE, 'page[number]': page, sort: '-createdAt' };
    if (incluirVenta) params.include = 'sale';
    let data;
    try {
      data = await get('/items', params);
    } catch (e) {
      // Si la API no acepta include=sale, se reintenta sin él
      if (incluirVenta && /HTTP 400/.test(e.message)) { incluirVenta = false; page--; continue; }
      throw e;
    }
    for (const inc of data.included || []) {
      if (inc.type === 'Sale') {
        ventas.set(String(inc.id), inc.attributes || {});
        const c = inc.relationships && inc.relationships.customer && inc.relationships.customer.data;
        const nom = inc.attributes && (inc.attributes.customerName || null);
        if (c || nom) clientes.set(String(inc.id), { id: c ? String(c.id) : null, nombre: nom });
      }
    }
    const lote = Array.isArray(data.data) ? data.data : [];
    let masViejo = null;
    for (const it of lote) {
      const f = new Date((it.attributes || {}).createdAt);
      if (Number.isNaN(f.getTime())) continue;
      masViejo = f;
      if (f >= desde && f < hasta) items.push(it);
    }
    if (lote.length < PAGE || (masViejo && masViejo < desde)) break;
  }
  return { items, ventas, clientes };
}

module.exports = function registrarConsumos({ route, query, tx, fail, permitir, registrarMovimiento, almacenActivo, isTrue, toInt, str, pool, veAlmacen, exigirAlmacen }) {
  const puede = (u, p) => u.permisos.includes(p);
  const verPermiso = (u) => { if (!puede(u, 'consumir') && !puede(u, 'verMovimientos')) fail(403, 'No tenés permiso para esta operación'); };

  // Cuentas de Fudo: galpon (principal) y bar (si está configurada)
  // Solo las cuentas de Fudo de las sucursales del usuario
  const cuentasU = async (user) => (await fudo.cuentasDeUsuario(pool, user)).map(({ id, nombre }) => ({ id, nombre }));
  const cuentaDe = async (v, user) => {
    if (!fudo.cuentasTablero().length) fail(400, 'La integración con Fudo no está configurada');
    const cs = await fudo.cuentasDeUsuario(pool, user);
    if (!cs.length) fail(403, 'Tu sucursal no tiene una cuenta de Fudo asociada');
    const c = cs.find((x) => x.id === v); if (!c) fail(403, 'No tenés acceso a los consumos de esa sucursal'); return c;
  };
  async function verCuentaImp(user, id) {
    if (!user.sucursales) return;
    const { rows } = await query('SELECT cuenta FROM consumo_importaciones WHERE id = $1', [id]);
    if (rows[0] && !(await cuentasU(user)).some((c) => c.id === rows[0].cuenta)) fail(403, 'No tenés acceso a los consumos de esa sucursal');
  }
  async function ultimoPeriodo(cuenta = 'galpon') {
    const { rows } = await query(
      "SELECT id, desde, hasta, estado FROM consumo_importaciones WHERE estado <> 'ANULADA' AND cuenta = $1 ORDER BY hasta DESC LIMIT 1", [cuenta]);
    return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
  }

  route('GET', '/api/consumos-fudo', async ({ user }) => {
    verPermiso(user);
    const ctas = await cuentasU(user);
    const { rows } = await query(
      `SELECT ci.id, ci.cuenta, ci.desde, ci.hasta, ci.estado, ci.items_leidos, ci.items_cancelados, ci.movimiento_id, ci.creado_en, ci.confirmado_en,
              a.nombre AS almacen, u.nombre AS creado_por, uc.nombre AS confirmado_por,
              (SELECT count(*)::int FROM consumo_import_items x WHERE x.importacion_id = ci.id) AS lineas,
              (SELECT coalesce(sum(x.cantidad),0)::int FROM consumo_import_items x WHERE x.importacion_id = ci.id AND x.incluir AND x.producto_id IS NOT NULL) AS unidades,
              (SELECT count(*)::int FROM consumo_import_items x WHERE x.importacion_id = ci.id AND x.producto_id IS NULL) AS sin_vincular
       FROM consumo_importaciones ci LEFT JOIN almacenes a ON a.id = ci.almacen_id JOIN usuarios u ON u.id = ci.creado_por
       LEFT JOIN usuarios uc ON uc.id = ci.confirmado_por
       WHERE ci.cuenta = ANY($1::text[]) ${user.almacenes ? `AND (ci.almacen_id IS NULL OR ci.almacen_id = ANY('{${user.almacenes.join(',')}}'::int[]))` : ''}
       ORDER BY ci.hasta DESC, ci.id DESC LIMIT 200`, [`{${ctas.map((c) => c.id).join(',')}}`]);
    return {
      configurado: fudo.configurado(),
      cuentas: ctas,
      ultimo: ctas[0] ? await ultimoPeriodo(ctas[0].id) : null,
      ultimos: Object.fromEntries(await Promise.all(ctas.map(async (c) => [c.id, await ultimoPeriodo(c.id)]))),
      importaciones: rows.map((r) => ({ ...r, id: Number(r.id), lineas: Number(r.lineas), unidades: Number(r.unidades), sin_vincular: Number(r.sin_vincular),
        items_leidos: Number(r.items_leidos), items_cancelados: Number(r.items_cancelados) })),
    };
  });

  route('GET', '/api/consumos-fudo/:id', async ({ user, params }) => {
    verPermiso(user);
    const id = toInt(params.id);
    await verCuentaImp(user, id);
    const { rows } = await query(
      `SELECT ci.*, a.nombre AS almacen, u.nombre AS creado_por_nombre, uc.nombre AS confirmado_por_nombre
       FROM consumo_importaciones ci LEFT JOIN almacenes a ON a.id = ci.almacen_id JOIN usuarios u ON u.id = ci.creado_por
       LEFT JOIN usuarios uc ON uc.id = ci.confirmado_por WHERE ci.id = $1`, [id]);
    if (!rows[0]) fail(404, 'Importación inexistente');
    const { rows: items } = await query(
      `SELECT x.id, x.fudo_product_id, x.producto_id, x.nombre_fudo, x.cantidad_vendida, x.cantidad, x.incluir, x.usuario_id, ue.nombre AS empleado,
              p.codigo, p.nombre, p.categoria, p.unidad, p.alerta_vencimiento, p.alerta_cuidado, p.alerta_frio, p.fecha_vencimiento, p.gestion_stock
       FROM consumo_import_items x LEFT JOIN productos p ON p.id = x.producto_id LEFT JOIN usuarios ue ON ue.id = x.usuario_id
       WHERE x.importacion_id = $1 ORDER BY (x.usuario_id IS NOT NULL), ue.nombre NULLS FIRST, (x.producto_id IS NULL), p.categoria NULLS LAST, coalesce(p.nombre, x.nombre_fudo)`, [id]);
    const { rows: st } = await query('SELECT almacen_id, producto_id, cantidad FROM stock WHERE cantidad > 0');
    const stock = {};
    for (const s of st) (stock[Number(s.producto_id)] = stock[Number(s.producto_id)] || {})[Number(s.almacen_id)] = Number(s.cantidad);
    return {
      ...rows[0], id: Number(rows[0].id), almacen_id: rows[0].almacen_id ? Number(rows[0].almacen_id) : null,
      items: items.map((i) => ({
        ...i, id: Number(i.id), producto_id: i.producto_id ? Number(i.producto_id) : null, usuario_id: i.usuario_id ? Number(i.usuario_id) : null, cantidad: Number(i.cantidad),
        cantidad_vendida: Number(i.cantidad_vendida), incluir: isTrue(i.incluir), gestion_stock: i.producto_id ? isTrue(i.gestion_stock) : false,
        alerta_vencimiento: isTrue(i.alerta_vencimiento), alerta_cuidado: isTrue(i.alerta_cuidado), alerta_frio: isTrue(i.alerta_frio), dias_venc: null,
        stock: i.producto_id ? stock[Number(i.producto_id)] || {} : {},
      })),
    };
  });

  // Importar un período desde Fudo -> BORRADOR
  route('POST', '/api/consumos-fudo/importar', async ({ user, body }) => {
    permitir(user, 'consumir');
    if (!fudo.configurado()) fail(400, 'La integración con Fudo no está configurada: cargá FUDO_API_KEY y FUDO_API_SECRET en Render.');
    const desde = new Date(body.desde);
    const hasta = new Date(body.hasta);
    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) fail(400, 'Indicá fecha y hora de inicio y fin del período');
    if (hasta <= desde) fail(400, 'El fin del período debe ser posterior al inicio');
    if (hasta > new Date(Date.now() + 5 * 60 * 1000)) fail(400, 'El período no puede terminar en el futuro');
    if (hasta - desde > 93 * 24 * 3600 * 1000) fail(400, 'El período no puede superar los 3 meses');
    const cta = await cuentaDe(body.cuenta === 'bar' ? 'bar' : 'galpon', user);
    const { rows: solapa } = await query(
      "SELECT id, desde, hasta FROM consumo_importaciones WHERE estado <> 'ANULADA' AND cuenta = $3 AND desde < $2 AND hasta > $1 ORDER BY desde LIMIT 1",
      [desde.toISOString(), hasta.toISOString(), cta.id]);
    if (solapa.length) {
      const f = (d) => new Date(d).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });
      fail(409, `En ${cta.nombre} el período se superpone con la importación #${solapa[0].id} (${f(solapa[0].desde)} a ${f(solapa[0].hasta)}). Empezá desde ${f(solapa[0].hasta)} o anulá esa importación.`);
    }
    // Productos al día antes de vincular
    try { if (cta.id === 'bar') await fudo.sincronizarProductosBar(pool, 'MANUAL'); else await fudo.sincronizarProductos(pool, 'MANUAL'); } catch (_) { /* se informa al vincular */ }

    let leido;
    try { leido = await leerItemsFudo(desde, hasta, cta.get); } catch (e) { fail(502, e.message); }
    const colFudo = cta.id === 'bar' ? 'fudo_bar_id' : 'fudo_id';
    // Almacén sugerido: el que se llama como la sucursal (VINILO BAR / EL GALPON VINILO)
    const { rows: almSug } = await query("SELECT id FROM almacenes WHERE activo AND nombre ILIKE $1 ORDER BY id LIMIT 1", [cta.id === 'bar' ? '%BAR%' : '%GALP%']);
    // Clientes de Fudo (cuenta corriente) vinculados a empleados en esta cuenta
    const { rows: mapa } = await query('SELECT usuario_id, cliente_id, cliente_nombre FROM usuario_fudo_clientes WHERE cuenta = $1', [cta.id]);
    const porCliente = new Map(mapa.map((r) => [String(r.cliente_id), Number(r.usuario_id)]));
    const nrm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const porNombreCli = new Map(mapa.filter((r) => r.cliente_nombre).map((r) => [nrm(r.cliente_nombre), Number(r.usuario_id)]));
    const empleadoDe = (it) => {
      const sr = it.relationships && it.relationships.sale && it.relationships.sale.data;
      const cli = sr && leido.clientes.get(String(sr.id));
      if (!cli) return null;
      return (cli.id && porCliente.get(cli.id)) || (cli.nombre && porNombreCli.get(nrm(cli.nombre))) || null;
    };
    const porProducto = new Map(); // clave: producto de Fudo + empleado (vacío = venta común)
    const personal = [];
    let cancelados = 0;
    for (const it of leido.items) {
      if (esCancelado(it, leido.ventas)) { cancelados++; continue; }
      const a = it.attributes || {};
      const rel = it.relationships && it.relationships.product && it.relationships.product.data;
      const pid = rel ? String(rel.id) : null;
      if (!pid) continue;
      const cant = Number(a.quantity ?? a.amount ?? 1);
      if (!Number.isFinite(cant) || cant <= 0) continue;
      const uid = empleadoDe(it);
      const clave = pid + '|' + (uid || '');
      const acc = porProducto.get(clave) || { fid: pid, usuario_id: uid, cantidad: 0, nombre: a.name || a.productName || null };
      acc.cantidad += cant;
      porProducto.set(clave, acc);
      if (uid) {
        const sr = it.relationships && it.relationships.sale && it.relationships.sale.data;
        const precio = Number(a.price ?? a.unitPrice);
        personal.push({ uid, venta: sr ? String(sr.id) : null, fecha: a.createdAt, fid: pid, nombre: a.name || a.productName || null, cant,
          importe: Number.isFinite(precio) ? Math.round(precio * cant * 100) / 100 : null });
      }
    }
    if (!porProducto.size) fail(404, `No hay ventas en el Fudo de ${cta.nombre} para ese período (${leido.items.length} ítems leídos, ${cancelados} cancelados).`);

    return tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO consumo_importaciones (desde, hasta, items_leidos, items_cancelados, creado_por, cuenta, almacen_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [desde.toISOString(), hasta.toISOString(), leido.items.length, cancelados, user.id, cta.id, almSug[0] && (!user.almacenes || user.almacenes.includes(Number(almSug[0].id))) ? Number(almSug[0].id) : null]);
      const impId = Number(rows[0].id);
      let sinVincular = 0;
      const prodDe = new Map();
      const buscarProd = async (fid) => {
        if (!prodDe.has(fid)) { const { rows: p } = await client.query(`SELECT id, nombre, gestion_stock FROM productos WHERE ${colFudo} = $1`, [fid]); prodDe.set(fid, p[0] || null); }
        return prodDe.get(fid);
      };
      for (const v of porProducto.values()) {
        const fid = v.fid;
        const prod = await buscarProd(fid);
        if (!prod) sinVincular++;
        const gestiona = prod && isTrue(prod.gestion_stock);
        await client.query(
          `INSERT INTO consumo_import_items (importacion_id, fudo_product_id, producto_id, nombre_fudo, cantidad_vendida, cantidad, incluir, usuario_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [impId, fid, prod ? Number(prod.id) : null, (prod ? prod.nombre : v.nombre) || `Producto Fudo ${fid}`, v.cantidad, Math.round(v.cantidad), !!gestiona, v.usuario_id || null]);
      }
      for (const x of personal) {
        const prod = await buscarProd(x.fid);
        await client.query(
          `INSERT INTO consumos_personal (importacion_id, usuario_id, cuenta, venta_id, fecha, fudo_product_id, producto_id, nombre, cantidad, importe)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [impId, x.uid, cta.id, x.venta, x.fecha, x.fid, prod ? Number(prod.id) : null, (prod ? prod.nombre : x.nombre) || `Producto Fudo ${x.fid}`, x.cant, x.importe]);
      }
      return { id: impId, cuenta: cta.id, productos: porProducto.size, sin_vincular: sinVincular, items_leidos: leido.items.length, cancelados,
        personal: { items: personal.length, empleados: new Set(personal.map((x) => x.uid)).size } };
    });
  });

  async function borrador(client, id) {
    const { rows } = await client.query('SELECT * FROM consumo_importaciones WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) fail(404, 'Importación inexistente');
    if (rows[0].estado !== 'BORRADOR') fail(409, `La importación ya está ${rows[0].estado}`);
    return rows[0];
  }

  // Guardar borrador: almacén, cantidades e inclusión por línea
  route('PUT', '/api/consumos-fudo/:id', async ({ user, body, params }) => {
    permitir(user, 'consumir');
    const id = toInt(params.id);
    await verCuentaImp(user, id);
    return tx(async (client) => {
      await borrador(client, id);
      const almId = body.almacen_id ? toInt(body.almacen_id) : null;
      if (almId) { exigirAlmacen(user, almId); await almacenActivo(client, almId, 'consumo'); }
      await client.query('UPDATE consumo_importaciones SET almacen_id = $2, observacion = $3 WHERE id = $1', [id, almId, str(body.observacion, 1000)]);
      for (const l of Array.isArray(body.items) ? body.items : []) {
        const cant = toInt(l.cantidad);
        if (!Number.isInteger(cant) || cant < 0) fail(400, 'Las cantidades deben ser enteros mayores o iguales a 0');
        await client.query(`UPDATE consumo_import_items SET cantidad = $3, incluir = $4 WHERE id = $1 AND importacion_id = $2
           AND producto_id IN (SELECT id FROM productos WHERE gestion_stock)`,
          [toInt(l.id), id, cant, !!l.incluir]);
      }
      return { ok: true };
    });
  });

  // Confirmar: genera el movimiento CONSUMO en el almacén elegido
  route('POST', '/api/consumos-fudo/:id/confirmar', async ({ user, body, params }) => {
    permitir(user, 'consumir');
    const id = toInt(params.id);
    await verCuentaImp(user, id);
    return tx(async (client) => {
      const imp = await borrador(client, id);
      const almId = toInt(body.almacen_id || imp.almacen_id);
      exigirAlmacen(user, almId);
      const alm = await almacenActivo(client, almId, 'consumo');
      const { rows: lineas } = await client.query(
        `SELECT x.producto_id, sum(x.cantidad)::int AS cantidad, min(p.nombre) AS nombre FROM consumo_import_items x JOIN productos p ON p.id = x.producto_id
         WHERE x.importacion_id = $1 AND x.incluir AND x.cantidad > 0 AND p.gestion_stock GROUP BY x.producto_id`, [id]);
      if (!lineas.length) fail(400, 'No hay líneas para consumir: incluí al menos un producto con cantidad mayor a 0');
      const items = [];
      const faltantes = [];
      for (const l of lineas) {
        let cant = Number(l.cantidad);
        if (body.limitar_a_stock) {
          const { rows: s } = await client.query('SELECT cantidad FROM stock WHERE almacen_id = $1 AND producto_id = $2', [almId, l.producto_id]);
          const disp = s[0] ? Number(s[0].cantidad) : 0;
          if (disp < cant) { faltantes.push(`${l.nombre}: vendido ${cant}, en stock ${disp}`); cant = disp; }
        }
        if (cant > 0) items.push({ producto_id: Number(l.producto_id), cantidad: cant });
      }
      if (!items.length) fail(409, `No hay stock en ${alm.nombre} para ninguno de los productos vendidos.`);
      const f = (d) => new Date(d).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });
      const obs = [str(imp.observacion, 600), faltantes.length ? `Sin stock suficiente (se consumió lo disponible): ${faltantes.join('; ')}` : null].filter(Boolean).join(' | ');
      const movId = await registrarMovimiento(client, {
        tipo: 'CONSUMO', origen_id: almId, items, usuario_id: user.id,
        referencia: `Ventas Fudo ${f(imp.desde)} a ${f(imp.hasta)}`.slice(0, 120), observacion: obs || null,
      });
      await client.query(
        "UPDATE consumo_importaciones SET estado = 'CONFIRMADA', almacen_id = $2, movimiento_id = $3, confirmado_por = $4, confirmado_en = now() WHERE id = $1",
        [id, almId, movId, user.id]);
      return { movimiento_id: movId, faltantes };
    });
  });

  route('POST', '/api/consumos-fudo/:id/anular', async ({ user, params }) => {
    permitir(user, 'consumir');
    const id = toInt(params.id);
    await verCuentaImp(user, id);
    return tx(async (client) => {
      await borrador(client, id);
      await client.query("UPDATE consumo_importaciones SET estado = 'ANULADA' WHERE id = $1", [id]);
      return { ok: true };
    });
  });
};
