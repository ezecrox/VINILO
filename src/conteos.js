// Conteo de inventario desde el celular: varios usuarios cuentan a la vez, se guarda cada producto al instante
// y quien tiene "Ajuste de inventario" revisa diferencias y aplica (genera un movimiento de AJUSTE).
module.exports = function registrarConteos({ route, query, tx, fail, permitir, permitirAlguno, registrarMovimiento, almacenActivo, isTrue, toInt, str, veAlmacen, exigirAlmacen, sqlAlm }) {
  const puede = (u, p) => u.permisos.includes(p);
  const puedeCerrar = (u) => puede(u, 'cerrarConteo') || puede(u, 'ajustar');
  const idPos = (v) => { const n = toInt(v); return Number.isInteger(n) && n > 0 ? n : null; };

  async function cargar(id, user) {
    const { rows } = await query(
      `SELECT c.*, a.nombre AS almacen, u.nombre AS creado_por_nombre, uc.nombre AS cerrado_por_nombre
       FROM conteos c JOIN almacenes a ON a.id = c.almacen_id JOIN usuarios u ON u.id = c.creado_por LEFT JOIN usuarios uc ON uc.id = c.cerrado_por WHERE c.id = $1`, [id]);
    const c = rows[0];
    if (!c || !veAlmacen(user, c.almacen_id)) fail(404, 'Conteo inexistente');
    return c;
  }
  const cab = (c, extra = {}) => ({
    id: Number(c.id), almacen_id: Number(c.almacen_id), almacen: c.almacen, estado: c.estado, categoria: c.categoria, ciego: isTrue(c.ciego),
    observacion: c.observacion, creado_por: c.creado_por_nombre, creado_en: c.creado_en, cerrado_por: c.cerrado_por_nombre || null, cerrado_en: c.cerrado_en,
    no_contados: c.no_contados, movimiento_id: c.movimiento_id ? Number(c.movimiento_id) : null, ...extra,
  });

  route('GET', '/api/conteos', async ({ user }) => {
    permitirAlguno(user, 'contar', 'ajustar');
    const { rows } = await query(
      `SELECT c.*, a.nombre AS almacen, u.nombre AS creado_por_nombre, uc.nombre AS cerrado_por_nombre,
              (SELECT count(*)::int FROM conteo_items i WHERE i.conteo_id = c.id) AS contados,
              (SELECT count(*)::int FROM productos p WHERE p.activo AND p.gestion_stock AND (c.categoria IS NULL OR p.categoria = c.categoria)) AS total,
              (SELECT count(DISTINCT i.contado_por)::int FROM conteo_items i WHERE i.conteo_id = c.id) AS personas
       FROM conteos c JOIN almacenes a ON a.id = c.almacen_id JOIN usuarios u ON u.id = c.creado_por LEFT JOIN usuarios uc ON uc.id = c.cerrado_por
       WHERE (c.estado = 'EN_CURSO' OR c.creado_en > now() - interval '120 days') ${sqlAlm(user, 'c.almacen_id')}
       ORDER BY (c.estado = 'EN_CURSO') DESC, c.id DESC LIMIT 60`);
    return rows.map((c) => cab(c, { contados: Number(c.contados), total: Number(c.total), personas: Number(c.personas) }));
  });

  route('POST', '/api/conteos', async ({ user, body }) => {
    permitir(user, 'contar');
    const alm = idPos(body.almacen_id);
    exigirAlmacen(user, alm, 'conteo');
    await almacenActivo({ query }, alm, 'conteo');
    // Ciego (no muestra el stock del sistema) salvo que quien lo crea pueda ajustar y elija verlo
    const ciego = body.ciego === undefined ? true : (!!body.ciego || !puede(user, 'ajustar'));
    // Se permiten varios conteos en curso en el mismo almacén si son de rubros distintos.
    // No se permite el mismo rubro dos veces, ni "todos los rubros" junto con otro (contarían los mismos productos).
    const rubro = str(body.categoria, 80) || null;
    const { rows: abiertos } = await query("SELECT id, categoria FROM conteos WHERE almacen_id = $1 AND estado = 'EN_CURSO'", [alm]);
    const mismo = abiertos.find((x) => (x.categoria || null) === rubro);
    if (mismo) fail(409, rubro ? `Ya hay un conteo en curso de ${rubro} en ese almacén (#${mismo.id}): sumate a ese o terminalo antes de abrir otro` : `Ya hay un conteo de todos los rubros en curso en ese almacén (#${mismo.id})`);
    if (!rubro && abiertos.length) fail(409, `No se puede contar todos los rubros mientras haya conteos en curso de: ${abiertos.map((x) => x.categoria).join(', ')}. Terminalos o elegí un rubro.`);
    if (rubro && abiertos.some((x) => !x.categoria)) fail(409, `Hay un conteo de todos los rubros en curso en ese almacén (#${abiertos.find((x) => !x.categoria).id}): terminalo antes de abrir uno por rubro`);
    try {
      const { rows } = await query('INSERT INTO conteos (almacen_id, categoria, ciego, observacion, creado_por) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [alm, rubro, ciego, str(body.observacion, 500), user.id]);
      return { id: Number(rows[0].id) };
    } catch (e) {
      if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ya hay un conteo en curso de ese rubro en ese almacén: sumate a ese o terminalo antes de abrir otro');
      throw e;
    }
  });

  route('GET', '/api/conteos/:id', async ({ user, params }) => {
    permitirAlguno(user, 'contar', 'ajustar');
    const c = await cargar(idPos(params.id), user);
    const verSistema = !isTrue(c.ciego) || puedeCerrar(user) || c.estado !== 'EN_CURSO';
    const { rows } = await query(
      `SELECT p.id, p.codigo, p.codigo_barras, p.nombre, p.categoria, p.unidad,
              coalesce(s.cantidad, 0) AS sistema, i.cantidad AS contado, i.contado_en, uc.nombre AS contado_por,
              (c.categoria IS NULL OR p.categoria = c.categoria) AS en_alcance
       FROM conteos c JOIN productos p ON p.gestion_stock AND (p.activo OR EXISTS (SELECT 1 FROM conteo_items x WHERE x.conteo_id = c.id AND x.producto_id = p.id))
       LEFT JOIN stock s ON s.almacen_id = c.almacen_id AND s.producto_id = p.id
       LEFT JOIN conteo_items i ON i.conteo_id = c.id AND i.producto_id = p.id
       LEFT JOIN usuarios uc ON uc.id = i.contado_por
       WHERE c.id = $1 AND ((c.categoria IS NULL OR p.categoria = c.categoria) OR i.producto_id IS NOT NULL)
       ORDER BY p.categoria NULLS LAST, p.nombre`, [c.id]);
    const productos = rows.map((r) => ({
      id: Number(r.id), codigo: r.codigo, codigo_barras: r.codigo_barras, nombre: r.nombre, categoria: r.categoria, unidad: r.unidad,
      contado: r.contado === null || r.contado === undefined ? null : Number(r.contado), contado_por: r.contado_por || null, contado_en: r.contado_en || null,
      sistema: verSistema ? Number(r.sistema) : null, en_alcance: isTrue(r.en_alcance),
    }));
    const contados = productos.filter((p) => p.contado !== null).length;
    return cab(c, { productos, contados, total: productos.filter((p) => p.en_alcance).length, ve_sistema: verSistema, puede_aplicar: puedeCerrar(user), puede_anular: puedeCerrar(user) || Number(c.creado_por) === user.id });
  });

  // Guardar el conteo de un producto (cantidad final, o sumar a lo ya contado)
  route('PUT', '/api/conteos/:id/items', async ({ user, body, params }) => {
    permitir(user, 'contar');
    const c = await cargar(idPos(params.id), user);
    if (c.estado !== 'EN_CURSO') fail(409, 'El conteo ya está cerrado');
    const pid = idPos(body.producto_id);
    const cant = toInt(body.cantidad);
    if (!Number.isInteger(cant) || cant < 0 || cant > 1000000) fail(400, 'La cantidad debe ser un número entero de 0 en adelante');
    const { rows: p } = await query('SELECT id, nombre, gestion_stock FROM productos WHERE id = $1', [pid]);
    if (!p[0]) fail(400, 'Producto inexistente');
    if (!isTrue(p[0].gestion_stock)) fail(400, `"${p[0].nombre}" no tiene gestión de stock`);
    const sumar = !!body.sumar;
    const { rows } = await query(
      `INSERT INTO conteo_items (conteo_id, producto_id, cantidad, contado_por) VALUES ($1,$2,$3,$4)
       ON CONFLICT (conteo_id, producto_id) DO UPDATE SET cantidad = ${sumar ? 'conteo_items.cantidad + EXCLUDED.cantidad' : 'EXCLUDED.cantidad'}, contado_por = EXCLUDED.contado_por, contado_en = now()
       RETURNING cantidad`, [c.id, pid, cant, user.id]);
    return { producto_id: pid, cantidad: Number(rows[0].cantidad) };
  });

  route('DELETE', '/api/conteos/:id/items/:pid', async ({ user, params }) => {
    permitir(user, 'contar');
    const c = await cargar(idPos(params.id), user);
    if (c.estado !== 'EN_CURSO') fail(409, 'El conteo ya está cerrado');
    await query('DELETE FROM conteo_items WHERE conteo_id = $1 AND producto_id = $2', [c.id, idPos(params.pid)]);
    return { ok: true };
  });

  // Aplicar: el stock del almacén pasa a ser lo contado (movimiento de AJUSTE)
  route('POST', '/api/conteos/:id/aplicar', async ({ user, body, params }) => {
    if (!puedeCerrar(user)) fail(403, 'No tenés permiso para cerrar conteos');
    const id = idPos(params.id);
    const noContados = body.no_contados === 'CERO' ? 'CERO' : 'MANTENER';
    return tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM conteos WHERE id = $1 FOR UPDATE', [id]);
      const c = rows[0];
      if (!c || !veAlmacen(user, c.almacen_id)) fail(404, 'Conteo inexistente');
      if (c.estado !== 'EN_CURSO') fail(409, `El conteo ya está ${c.estado === 'APLICADO' ? 'aplicado' : 'anulado'}`);
      if (!veAlmacen(user, c.almacen_id)) fail(403, 'No tenés acceso a ese almacén');
      const { rows: it } = await client.query('SELECT producto_id, cantidad FROM conteo_items WHERE conteo_id = $1', [id]);
      const items = it.map((r) => ({ producto_id: Number(r.producto_id), cantidad: Number(r.cantidad) }));
      if (noContados === 'CERO') {
        const { rows: z } = await client.query(
          `SELECT s.producto_id FROM stock s JOIN productos p ON p.id = s.producto_id
           WHERE s.almacen_id = $1 AND s.cantidad > 0 AND p.gestion_stock AND ($2::text IS NULL OR p.categoria = $2)
             AND NOT EXISTS (SELECT 1 FROM conteo_items i WHERE i.conteo_id = $3 AND i.producto_id = s.producto_id)`, [c.almacen_id, c.categoria, id]);
        z.forEach((r) => items.push({ producto_id: Number(r.producto_id), cantidad: 0 }));
      }
      if (!items.length) fail(400, 'No hay nada contado todavía');
      let movId = null;
      try {
        movId = await registrarMovimiento(client, { tipo: 'AJUSTE', origen_id: c.almacen_id, usuario_id: user.id, items,
          referencia: `Conteo #${id}`, observacion: `Conteo de inventario #${id}${c.categoria ? ` (${c.categoria})` : ''}${noContados === 'CERO' ? ' · no contados en 0' : ' · no contados omitidos'}` });
      } catch (e) {
        if (!/no produce cambios/.test(e.message)) throw e; // todo coincidía: se cierra igual, sin movimiento
      }
      await client.query("UPDATE conteos SET estado = 'APLICADO', cerrado_por = $2, cerrado_en = now(), no_contados = $3, movimiento_id = $4 WHERE id = $1", [id, user.id, noContados, movId]);
      const { rows: d } = movId ? await client.query('SELECT count(*)::int AS n, coalesce(sum(cantidad),0)::int AS neto FROM movimiento_items WHERE movimiento_id = $1', [movId]) : { rows: [{ n: 0, neto: 0 }] };
      return { ok: true, movimiento_id: movId, productos_ajustados: Number(d[0].n), diferencia_neta: Number(d[0].neto) };
    });
  });

  route('POST', '/api/conteos/:id/anular', async ({ user, params }) => {
    permitirAlguno(user, 'contar', 'ajustar');
    const c = await cargar(idPos(params.id), user);
    if (c.estado !== 'EN_CURSO') fail(409, 'El conteo ya está cerrado');
    if (!puedeCerrar(user) && Number(c.creado_por) !== user.id) fail(403, 'Solo quien lo empezó o quien tiene permiso para cerrar conteos lo puede anular');
    await query("UPDATE conteos SET estado = 'ANULADO', cerrado_por = $2, cerrado_en = now() WHERE id = $1", [c.id, user.id]);
    return { ok: true };
  });

  // Códigos de barras: buscar y asociar a un producto
  route('GET', '/api/productos/barras/:codigo', async ({ user, params }) => {
    permitirAlguno(user, 'contar', 'productos', 'ajustar');
    const cod = String(decodeURIComponent(params.codigo || '')).trim();
    const { rows } = await query('SELECT id, codigo, nombre, categoria FROM productos WHERE codigo_barras = $1 OR upper(codigo) = upper($1) LIMIT 1', [cod]);
    return rows[0] ? { encontrado: true, producto: { ...rows[0], id: Number(rows[0].id) } } : { encontrado: false, codigo: cod };
  });
  route('PUT', '/api/productos/:id/barras', async ({ user, body, params }) => {
    permitirAlguno(user, 'contar', 'productos');
    const cod = str(body.codigo_barras, 40);
    try {
      const { rows } = await query('UPDATE productos SET codigo_barras = $2 WHERE id = $1 RETURNING id, nombre', [idPos(params.id), cod]);
      if (!rows.length) fail(404, 'Producto inexistente');
      return { ok: true, nombre: rows[0].nombre };
    } catch (e) {
      if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ese código de barras ya está asociado a otro producto');
      throw e;
    }
  });
};
