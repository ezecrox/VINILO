// Producción: recetas (insumos por tanda) y órdenes de producción que descuentan insumos y suman lo producido.
module.exports = function registrarProduccion({ route, query, tx, fail, permitir, permitirAlguno, almacenActivo, exigirAlmacen, isTrue, toInt, str, veAlmacen, sqlProdSuc = () => '' }) {
  async function cargarReceta(productoId, client = { query }) {
    const { rows: r } = await client.query('SELECT rendimiento, instrucciones, actualizado_en FROM recetas WHERE producto_id = $1', [productoId]);
    const { rows: ins } = await client.query(
      `SELECT ri.insumo_id, ri.cantidad, p.codigo, p.nombre, p.unidad, p.gestion_stock, p.activo
       FROM receta_insumos ri JOIN productos p ON p.id = ri.insumo_id WHERE ri.producto_id = $1 ORDER BY p.nombre`, [productoId]);
    return r[0] ? {
      rendimiento: Number(r[0].rendimiento), instrucciones: r[0].instrucciones, actualizado_en: r[0].actualizado_en,
      insumos: ins.map((i) => ({ insumo_id: Number(i.insumo_id), cantidad: Number(i.cantidad), codigo: i.codigo, nombre: i.nombre, unidad: i.unidad,
        gestion_stock: isTrue(i.gestion_stock), activo: isTrue(i.activo) })),
    } : null;
  }

  route('GET', '/api/recetas/:id', async ({ user, params }) => {
    permitirAlguno(user, 'productos', 'producir');
    return (await cargarReceta(toInt(params.id))) || { rendimiento: 1, instrucciones: null, insumos: [] };
  });

  route('PUT', '/api/recetas/:id', async ({ user, body, params }) => {
    permitir(user, 'productos');
    const pid = toInt(params.id);
    const rend = toInt(body.rendimiento);
    if (!Number.isInteger(rend) || rend < 1) fail(400, 'El rendimiento por tanda debe ser un entero mayor a 0');
    const insumos = Array.isArray(body.insumos) ? body.insumos : [];
    if (!insumos.length) fail(400, 'La receta necesita al menos un insumo');
    return tx(async (client) => {
      const { rows: p } = await client.query('SELECT gestion_produccion FROM productos WHERE id = $1', [pid]);
      if (!p[0]) fail(404, 'Producto inexistente');
      if (!isTrue(p[0].gestion_produccion)) fail(400, 'Activá "Gestión de producción" en el producto para cargarle una receta');
      const vistos = new Set();
      for (const i of insumos) {
        const iid = toInt(i.insumo_id), cant = toInt(i.cantidad);
        if (!Number.isInteger(iid) || !Number.isInteger(cant) || cant <= 0) fail(400, 'Cada insumo necesita producto y cantidad entera mayor a 0');
        if (iid === pid) fail(400, 'Un producto no puede ser insumo de sí mismo');
        if (vistos.has(iid)) fail(400, 'Hay un insumo repetido');
        vistos.add(iid);
        const { rows } = await client.query('SELECT nombre, gestion_stock FROM productos WHERE id = $1', [iid]);
        if (!rows[0]) fail(400, 'Insumo inexistente');
        if (!isTrue(rows[0].gestion_stock)) fail(400, `El insumo "${rows[0].nombre}" no tiene gestión de stock`);
      }
      await client.query(
        `INSERT INTO recetas (producto_id, rendimiento, instrucciones) VALUES ($1,$2,$3)
         ON CONFLICT (producto_id) DO UPDATE SET rendimiento = EXCLUDED.rendimiento, instrucciones = EXCLUDED.instrucciones, actualizado_en = now()`,
        [pid, rend, str(body.instrucciones, 2000)]);
      await client.query('DELETE FROM receta_insumos WHERE producto_id = $1', [pid]);
      for (const i of insumos) {
        await client.query('INSERT INTO receta_insumos (producto_id, insumo_id, cantidad) VALUES ($1,$2,$3)', [pid, toInt(i.insumo_id), toInt(i.cantidad)]);
      }
      return { ok: true };
    });
  });

  // Productos que se pueden producir (con receta), con el stock de insumos por almacén visible
  route('GET', '/api/produccion', async ({ user }) => {
    permitir(user, 'producir');
    const { rows } = await query(
      `SELECT p.id, p.codigo, p.nombre, p.categoria, p.unidad, r.rendimiento IS NOT NULL AS con_receta
       FROM productos p LEFT JOIN recetas r ON r.producto_id = p.id
       WHERE p.activo AND p.gestion_produccion AND p.gestion_stock ${sqlProdSuc(user, 'p.id')} ORDER BY p.nombre`);
    const productos = [];
    for (const r of rows) productos.push({ id: Number(r.id), codigo: r.codigo, nombre: r.nombre, categoria: r.categoria, unidad: r.unidad,
      receta: isTrue(r.con_receta) ? await cargarReceta(Number(r.id)) : null });
    const { rows: st } = await query('SELECT almacen_id, producto_id, cantidad FROM stock WHERE cantidad > 0');
    const stock = {};
    for (const s of st) if (veAlmacen(user, s.almacen_id)) (stock[Number(s.producto_id)] = stock[Number(s.producto_id)] || {})[Number(s.almacen_id)] = Number(s.cantidad);
    const { rows: ult } = await query(
      `SELECT m.id, m.fecha, a.nombre AS almacen, u.nombre AS usuario, m.observacion,
              (SELECT p.nombre FROM movimiento_items i JOIN productos p ON p.id = i.producto_id WHERE i.movimiento_id = m.id AND i.cantidad > 0 LIMIT 1) AS producto,
              (SELECT coalesce(sum(i.cantidad),0)::int FROM movimiento_items i WHERE i.movimiento_id = m.id AND i.cantidad > 0) AS producido
       FROM movimientos m JOIN almacenes a ON a.id = m.destino_id JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.tipo = 'PRODUCCION' ${user.almacenes ? `AND m.destino_id = ANY('{${user.almacenes.join(',')}}'::int[])` : ''}
       ORDER BY m.fecha DESC LIMIT 15`);
    return { productos, stock, ultimas: ult.map((u) => ({ ...u, id: Number(u.id), producido: Number(u.producido) })) };
  });

  // Producir: descuenta insumos (cantidades reales editables) y suma tandas × rendimiento del producto
  route('POST', '/api/produccion', async ({ user, body }) => {
    permitir(user, 'producir');
    const pid = toInt(body.producto_id);
    const almId = toInt(body.almacen_id);
    const tandas = toInt(body.tandas);
    if (!Number.isInteger(tandas) || tandas < 1) fail(400, 'Indicá cuántas tandas producir (entero mayor a 0)');
    exigirAlmacen(user, almId);
    return tx(async (client) => {
      const alm = await almacenActivo(client, almId, 'producción');
      const { rows: p } = await client.query('SELECT nombre, activo, gestion_stock, gestion_produccion FROM productos WHERE id = $1', [pid]);
      if (!p[0]) fail(404, 'Producto inexistente');
      if (!isTrue(p[0].gestion_produccion) || !isTrue(p[0].gestion_stock)) fail(400, `"${p[0].nombre}" no tiene gestión de producción`);
      if (!isTrue(p[0].activo)) fail(400, `"${p[0].nombre}" está inactivo`);
      const receta = await cargarReceta(pid, client);
      if (!receta || !receta.insumos.length) fail(400, `"${p[0].nombre}" no tiene receta cargada`);
      // Consumo real: por defecto receta × tandas; se puede corregir por insumo (merma, rendimiento distinto)
      const reales = new Map((Array.isArray(body.insumos) ? body.insumos : []).map((i) => [toInt(i.insumo_id), toInt(i.cantidad)]));
      const consumo = [];
      for (const ins of receta.insumos) {
        const cant = reales.has(ins.insumo_id) ? reales.get(ins.insumo_id) : ins.cantidad * tandas;
        if (!Number.isInteger(cant) || cant < 0) fail(400, 'Las cantidades de insumos deben ser enteros mayores o iguales a 0');
        if (!ins.gestion_stock) fail(400, `El insumo "${ins.nombre}" no tiene gestión de stock`);
        if (cant > 0) consumo.push({ ...ins, real: cant });
      }
      const producido = body.cantidad_producida !== undefined && body.cantidad_producida !== null && body.cantidad_producida !== ''
        ? toInt(body.cantidad_producida) : tandas * receta.rendimiento;
      if (!Number.isInteger(producido) || producido < 1) fail(400, 'La cantidad producida debe ser un entero mayor a 0');
      // Descontar insumos con bloqueo (orden por id para evitar bloqueos cruzados)
      consumo.sort((a, b) => a.insumo_id - b.insumo_id);
      const faltan = [];
      for (const c of consumo) {
        const { rows } = await client.query('SELECT cantidad FROM stock WHERE almacen_id = $1 AND producto_id = $2 FOR UPDATE', [almId, c.insumo_id]);
        const disp = rows[0] ? Number(rows[0].cantidad) : 0;
        if (disp < c.real) faltan.push(`${c.nombre}: necesita ${c.real}, hay ${disp}`);
      }
      if (faltan.length) fail(409, `Faltan insumos en ${alm.nombre}: ${faltan.join(' · ')}`);
      for (const c of consumo) {
        await client.query('UPDATE stock SET cantidad = cantidad - $3 WHERE almacen_id = $1 AND producto_id = $2', [almId, c.insumo_id, c.real]);
      }
      await client.query(
        `INSERT INTO stock (almacen_id, producto_id, cantidad) VALUES ($1, $2, $3)
         ON CONFLICT (almacen_id, producto_id) DO UPDATE SET cantidad = stock.cantidad + EXCLUDED.cantidad`, [almId, pid, producido]);
      const { rows: m } = await client.query(
        `INSERT INTO movimientos (tipo, origen_id, destino_id, usuario_id, referencia, observacion)
         VALUES ('PRODUCCION', $1, $1, $2, $3, $4) RETURNING id`,
        [almId, user.id, `Producción ${p[0].nombre} · ${tandas} ${tandas === 1 ? 'tanda' : 'tandas'}`.slice(0, 120), str(body.observacion, 1000)]);
      const movId = Number(m[0].id);
      await client.query('INSERT INTO movimiento_items (movimiento_id, producto_id, cantidad) VALUES ($1,$2,$3)', [movId, pid, producido]);
      for (const c of consumo) await client.query('INSERT INTO movimiento_items (movimiento_id, producto_id, cantidad) VALUES ($1,$2,$3)', [movId, c.insumo_id, -c.real]);
      return { movimiento_id: movId, producido };
    });
  });
};
