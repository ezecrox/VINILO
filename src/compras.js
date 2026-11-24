// Notas de pedido a proveedores (órdenes de compra), archivos de remito/factura y recepción validada.
const MAX_ARCHIVO = 8 * 1024 * 1024; // 8 MB
const TIPOS_ARCHIVO = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', csv: 'text/csv', txt: 'text/plain',
};
const ABIERTAS = ['CONFIRMADA', 'PARCIAL'];

module.exports = function registrarCompras({ route, query, tx, fail, permitir, registrarMovimiento, almacenActivo, isTrue, toInt, str, fechaOk, veAlmacen, exigirAlmacen }) {
  const puede = (user, p) => user.permisos.includes(p);
  const permitirAlguno = (user, ...ps) => { if (!ps.some((p) => puede(user, p))) fail(403, 'No tenés permiso para esta operación'); };
  const esProveedor = (user) => user.rol === 'PROVEEDOR';

  // ---------- Proveedores ----------
  const normProv = (r) => ({ ...r, id: Number(r.id), activo: isTrue(r.activo), usuarios: r.usuarios === undefined ? undefined : Number(r.usuarios) });

  route('GET', '/api/proveedores', async ({ user }) => {
    permitirAlguno(user, 'compras', 'verCompras', 'proveedores', 'usuarios', 'recibir');
    const { rows } = await query(
      `SELECT p.*, (SELECT count(*)::int FROM usuarios u WHERE u.proveedor_id = p.id) AS usuarios
       FROM proveedores p ORDER BY p.nombre`);
    return rows.map(normProv);
  });

  function datosProveedor(body) {
    const nombre = str(body.nombre, 150);
    if (!nombre) fail(400, 'El nombre del proveedor es obligatorio');
    return [nombre, str(body.cuit, 20), str(body.email, 150), str(body.telefono, 50), str(body.contacto, 120), str(body.direccion, 200), str(body.comentario, 1000)];
  }
  const dup = (e) => { if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ya existe un proveedor con ese nombre'); throw e; };

  route('POST', '/api/proveedores', async ({ user, body }) => {
    permitir(user, 'proveedores');
    try {
      const { rows } = await query('INSERT INTO proveedores (nombre, cuit, email, telefono, contacto, direccion, comentario) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', datosProveedor(body));
      return { id: Number(rows[0].id) };
    } catch (e) { return dup(e); }
  });

  route('PUT', '/api/proveedores/:id', async ({ user, body, params }) => {
    permitir(user, 'proveedores');
    try {
      await query('UPDATE proveedores SET nombre=$2, cuit=$3, email=$4, telefono=$5, contacto=$6, direccion=$7, comentario=$8, activo=$9 WHERE id=$1',
        [toInt(params.id), ...datosProveedor(body), body.activo === undefined ? true : !!body.activo]);
    } catch (e) { return dup(e); }
    return { ok: true };
  });

  // ---------- Órdenes de compra ----------
  async function cargarOC(id, user, client = { query }) {
    const { rows } = await client.query(
      `SELECT oc.*, p.nombre AS proveedor, p.email AS proveedor_email, p.telefono AS proveedor_telefono, p.cuit AS proveedor_cuit,
              a.nombre AS almacen, uc.nombre AS creado_por_nombre, uf.nombre AS confirmado_por_nombre, ux.nombre AS cerrado_por_nombre
       FROM ordenes_compra oc JOIN proveedores p ON p.id = oc.proveedor_id JOIN almacenes a ON a.id = oc.almacen_id
       JOIN usuarios uc ON uc.id = oc.creado_por LEFT JOIN usuarios uf ON uf.id = oc.confirmado_por LEFT JOIN usuarios ux ON ux.id = oc.cerrado_por
       WHERE oc.id = $1`, [id]);
    const oc = rows[0];
    if (!oc) fail(404, 'Pedido a proveedor inexistente');
    if (esProveedor(user)) {
      if (Number(oc.proveedor_id) !== user.proveedor_id || oc.estado === 'BORRADOR') fail(404, 'Pedido a proveedor inexistente');
    } else {
      permitirAlguno(user, 'compras', 'verCompras');
      if (oc.estado === 'BORRADOR' && !puede(user, 'compras')) fail(404, 'Pedido a proveedor inexistente');
      if (!veAlmacen(user, oc.almacen_id)) fail(404, 'Pedido a proveedor inexistente');
    }
    return { ...oc, id: Number(oc.id), proveedor_id: Number(oc.proveedor_id), almacen_id: Number(oc.almacen_id) };
  }

  async function detalleOC(id, user) {
    const oc = await cargarOC(id, user);
    const { rows: items } = await query(
      `SELECT i.id, i.producto_id, i.cantidad, i.cantidad_recibida, p.codigo, p.nombre, p.unidad, p.categoria,
              p.alerta_vencimiento, p.alerta_cuidado, p.alerta_frio, p.fecha_vencimiento, p.nota_alerta
       FROM oc_items i JOIN productos p ON p.id = i.producto_id WHERE i.oc_id = $1 ORDER BY p.nombre`, [id]);
    const { rows: archivos } = await query(
      `SELECT a.id, a.tipo, a.numero, a.nombre_archivo, a.mime, a.tamano, a.subido_en, a.subido_por, u.nombre AS subido_por_nombre, u.rol AS subido_por_rol
       FROM oc_archivos a JOIN usuarios u ON u.id = a.subido_por WHERE a.oc_id = $1 ORDER BY a.subido_en`, [id]);
    const { rows: recs } = await query(
      `SELECT m.id, m.fecha, m.referencia, m.observacion, u.nombre AS usuario
       FROM movimientos m JOIN usuarios u ON u.id = m.usuario_id WHERE m.oc_id = $1 ORDER BY m.fecha, m.id`, [id]);
    const recItems = recs.length ? (await query(
      `SELECT mi.movimiento_id, mi.cantidad, p.nombre, p.codigo FROM movimiento_items mi JOIN productos p ON p.id = mi.producto_id
       WHERE mi.movimiento_id = ANY($1::int[]) ORDER BY p.nombre`, [`{${recs.map((r) => Number(r.id)).join(',')}}`])).rows : [];
    const its = items.map((i) => {
      const cantidad = Number(i.cantidad), recibida = Number(i.cantidad_recibida);
      return {
        id: Number(i.id), producto_id: Number(i.producto_id), codigo: i.codigo, nombre: i.nombre, unidad: i.unidad, categoria: i.categoria,
        alerta_vencimiento: isTrue(i.alerta_vencimiento), alerta_cuidado: isTrue(i.alerta_cuidado), alerta_frio: isTrue(i.alerta_frio),
        fecha_vencimiento: i.fecha_vencimiento || null, nota_alerta: i.nota_alerta, dias_venc: null,
        cantidad, cantidad_recibida: recibida, pendiente: Math.max(cantidad - recibida, 0), excedente: Math.max(recibida - cantidad, 0),
      };
    });
    return {
      ...oc,
      items: its,
      resumen: {
        pedido: its.reduce((s, i) => s + i.cantidad, 0),
        recibido: its.reduce((s, i) => s + i.cantidad_recibida, 0),
        pendiente: its.reduce((s, i) => s + i.pendiente, 0),
        excedente: its.reduce((s, i) => s + i.excedente, 0),
        items_completos: its.filter((i) => i.pendiente === 0).length,
        items_total: its.length,
      },
      archivos: archivos.map((a) => ({ ...a, id: Number(a.id), tamano: Number(a.tamano), subido_por: Number(a.subido_por) })),
      recepciones: recs.map((r) => ({ ...r, id: Number(r.id), items: recItems.filter((x) => Number(x.movimiento_id) === Number(r.id)).map((x) => ({ ...x, cantidad: Number(x.cantidad) })) })),
    };
  }

  route('GET', '/api/oc', async ({ user, url }) => {
    const where = [];
    const params = [];
    const add = (cond, v) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (esProveedor(user)) {
      add('oc.proveedor_id = ?', user.proveedor_id);
      where.push("oc.estado <> 'BORRADOR'");
    } else {
      permitirAlguno(user, 'compras', 'verCompras');
      if (!puede(user, 'compras')) where.push("oc.estado <> 'BORRADOR'");
      if (url.searchParams.get('proveedor_id')) add('oc.proveedor_id = ?', toInt(url.searchParams.get('proveedor_id')));
      if (user.almacenes) where.push(`oc.almacen_id = ANY('{${user.almacenes.join(',')}}'::int[])`);
    }
    const est = url.searchParams.get('estado');
    if (est === 'ABIERTAS') where.push("oc.estado IN ('BORRADOR','CONFIRMADA','PARCIAL')");
    else if (est) add('oc.estado = ?', est);
    const { rows } = await query(
      `SELECT oc.id, oc.estado, oc.fecha_entrega, oc.creado_en, oc.confirmado_en, oc.proveedor_id, p.nombre AS proveedor, a.nombre AS almacen,
              (SELECT count(*)::int FROM oc_items i WHERE i.oc_id = oc.id) AS items,
              (SELECT coalesce(sum(i.cantidad),0)::int FROM oc_items i WHERE i.oc_id = oc.id) AS pedido,
              (SELECT coalesce(sum(i.cantidad_recibida),0)::int FROM oc_items i WHERE i.oc_id = oc.id) AS recibido,
              (SELECT coalesce(sum(GREATEST(i.cantidad - i.cantidad_recibida, 0)),0)::int FROM oc_items i WHERE i.oc_id = oc.id) AS pendiente,
              (SELECT count(*)::int FROM oc_archivos f WHERE f.oc_id = oc.id) AS archivos
       FROM ordenes_compra oc JOIN proveedores p ON p.id = oc.proveedor_id JOIN almacenes a ON a.id = oc.almacen_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE oc.estado WHEN 'BORRADOR' THEN 0 WHEN 'CONFIRMADA' THEN 1 WHEN 'PARCIAL' THEN 2 ELSE 3 END, oc.creado_en DESC
       LIMIT 300`, params);
    return rows.map((r) => ({ ...r, id: Number(r.id), proveedor_id: Number(r.proveedor_id), items: Number(r.items), pedido: Number(r.pedido), recibido: Number(r.recibido), pendiente: Number(r.pendiente), archivos: Number(r.archivos) }));
  });

  route('GET', '/api/oc/:id', async ({ user, params }) => detalleOC(toInt(params.id), user));

  async function guardarItems(client, ocId, items) {
    if (!Array.isArray(items) || !items.length) fail(400, 'Agregá al menos un producto');
    const consolidados = new Map();
    for (const it of items) {
      const pid = toInt(it.producto_id), cant = toInt(it.cantidad);
      if (!Number.isInteger(pid) || !Number.isInteger(cant) || cant <= 0) fail(400, 'Cada ítem necesita producto y cantidad entera mayor a 0');
      consolidados.set(pid, (consolidados.get(pid) || 0) + cant);
    }
    await client.query('DELETE FROM oc_items WHERE oc_id = $1', [ocId]);
    for (const [pid, cant] of consolidados) {
      const { rows } = await client.query('SELECT activo, gestion_stock, nombre FROM productos WHERE id = $1', [pid]);
      if (!rows[0] || !isTrue(rows[0].activo)) fail(400, 'Hay un producto inexistente o inactivo en el pedido');
      if (!isTrue(rows[0].gestion_stock)) fail(400, `"${rows[0].nombre}" no tiene gestión de stock`);
      await client.query('INSERT INTO oc_items (oc_id, producto_id, cantidad) VALUES ($1, $2, $3)', [ocId, pid, cant]);
    }
  }

  async function validarCabecera(client, body) {
    const provId = toInt(body.proveedor_id);
    if (!Number.isInteger(provId)) fail(400, 'Seleccioná el proveedor');
    const { rows } = await client.query('SELECT activo FROM proveedores WHERE id = $1', [provId]);
    if (!rows[0]) fail(400, 'Proveedor inexistente');
    if (!isTrue(rows[0].activo)) fail(400, 'El proveedor está inactivo');
    const almId = toInt(body.almacen_id);
    await almacenActivo(client, almId, 'entrega');
    return [provId, almId, fechaOk(body.fecha_entrega), str(body.observacion, 2000)];
  }

  route('POST', '/api/oc', async ({ user, body }) => {
    permitir(user, 'compras');
    return tx(async (client) => {
      const cab = await validarCabecera(client, body);
      exigirAlmacen(user, cab[1], 'entrega');
      const { rows } = await client.query(
        'INSERT INTO ordenes_compra (proveedor_id, almacen_id, fecha_entrega, observacion, creado_por) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [...cab, user.id]);
      const id = Number(rows[0].id);
      await guardarItems(client, id, body.items);
      if (body.confirmar) {
        await client.query("UPDATE ordenes_compra SET estado = 'CONFIRMADA', confirmado_por = $2, confirmado_en = now() WHERE id = $1", [id, user.id]);
      }
      return { id };
    });
  });

  async function ocBloqueada(client, id, estados, user) {
    const { rows } = await client.query('SELECT * FROM ordenes_compra WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) fail(404, 'Pedido a proveedor inexistente');
    const oc = rows[0];
    if (esProveedor(user) && Number(oc.proveedor_id) !== user.proveedor_id) fail(404, 'Pedido a proveedor inexistente');
    if (!esProveedor(user) && !veAlmacen(user, oc.almacen_id)) fail(404, 'Pedido a proveedor inexistente');
    if (estados && !estados.includes(oc.estado)) fail(409, `El pedido está ${oc.estado} y no admite esta operación`);
    return oc;
  }

  route('PUT', '/api/oc/:id', async ({ user, body, params }) => {
    permitir(user, 'compras');
    const id = toInt(params.id);
    return tx(async (client) => {
      const actual = await ocBloqueada(client, id, ['BORRADOR'], user);
      exigirAlmacen(user, actual.almacen_id, 'entrega');
      const cab = await validarCabecera(client, body);
      exigirAlmacen(user, cab[1], 'entrega');
      await client.query('UPDATE ordenes_compra SET proveedor_id=$2, almacen_id=$3, fecha_entrega=$4, observacion=$5 WHERE id=$1', [id, ...cab]);
      await guardarItems(client, id, body.items);
      return { ok: true };
    });
  });

  route('POST', '/api/oc/:id/confirmar', async ({ user, params }) => {
    permitir(user, 'compras');
    const id = toInt(params.id);
    return tx(async (client) => {
      await ocBloqueada(client, id, ['BORRADOR'], user);
      const { rows } = await client.query('SELECT count(*)::int AS n FROM oc_items WHERE oc_id = $1', [id]);
      if (!Number(rows[0].n)) fail(400, 'El pedido no tiene productos');
      await client.query("UPDATE ordenes_compra SET estado = 'CONFIRMADA', confirmado_por = $2, confirmado_en = now() WHERE id = $1", [id, user.id]);
      return { ok: true };
    });
  });

  route('POST', '/api/oc/:id/anular', async ({ user, body, params }) => {
    permitir(user, 'compras');
    const id = toInt(params.id);
    return tx(async (client) => {
      await ocBloqueada(client, id, ['BORRADOR', 'CONFIRMADA'], user);
      const { rows } = await client.query('SELECT coalesce(sum(cantidad_recibida),0)::int AS n FROM oc_items WHERE oc_id = $1', [id]);
      if (Number(rows[0].n) > 0) fail(409, 'El pedido ya tiene mercadería recibida: cerralo en lugar de anularlo');
      await client.query("UPDATE ordenes_compra SET estado = 'ANULADA', cerrado_por = $2, cerrado_en = now(), motivo_cierre = $3 WHERE id = $1",
        [id, user.id, str(body.motivo, 500)]);
      return { ok: true };
    });
  });

  // Cierre con faltantes (el proveedor no entregará el resto)
  route('POST', '/api/oc/:id/cerrar', async ({ user, body, params }) => {
    permitir(user, 'compras');
    const id = toInt(params.id);
    return tx(async (client) => {
      await ocBloqueada(client, id, ABIERTAS, user);
      const motivo = str(body.motivo, 500);
      if (!motivo) fail(400, 'Indicá el motivo del cierre');
      await client.query("UPDATE ordenes_compra SET estado = 'CERRADA', cerrado_por = $2, cerrado_en = now(), motivo_cierre = $3 WHERE id = $1", [id, user.id, motivo]);
      return { ok: true };
    });
  });

  // Recepción validada contra lo pedido
  route('POST', '/api/oc/:id/recibir', async ({ user, body, params }) => {
    permitir(user, 'recibir');
    const id = toInt(params.id);
    return tx(async (client) => {
      const oc = await ocBloqueada(client, id, ABIERTAS, user);
      exigirAlmacen(user, oc.almacen_id, 'entrega');
      const { rows: items } = await client.query(
        `SELECT i.id, i.producto_id, i.cantidad, i.cantidad_recibida, p.nombre FROM oc_items i JOIN productos p ON p.id = i.producto_id
         WHERE i.oc_id = $1 FOR UPDATE OF i`, [id]);
      const entregas = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [toInt(i.item_id), toInt(i.cantidad)]));
      for (const [itemId, cant] of entregas) {
        if (!items.some((i) => Number(i.id) === itemId)) fail(400, 'Hay un ítem que no pertenece a este pedido');
        if (!Number.isInteger(cant) || cant < 0) fail(400, 'Las cantidades recibidas deben ser enteros mayores o iguales a 0');
      }
      const excedentes = [];
      const movItems = [];
      for (const it of items) {
        const cant = entregas.get(Number(it.id)) || 0;
        if (!cant) continue;
        const total = Number(it.cantidad_recibida) + cant;
        if (total > Number(it.cantidad)) excedentes.push(`${it.nombre}: pedido ${it.cantidad}, recibido en total ${total}`);
        movItems.push({ producto_id: Number(it.producto_id), cantidad: cant });
        await client.query('UPDATE oc_items SET cantidad_recibida = $2 WHERE id = $1', [Number(it.id), total]);
      }
      if (!movItems.length) fail(400, 'Ingresá al menos una cantidad recibida mayor a 0');
      if (excedentes.length && !body.aceptar_excedente) {
        fail(409, `Se recibe más de lo pedido. ${excedentes.join(' · ')}. Confirmá para aceptar el excedente.`);
      }
      const ref = str(body.referencia, 90);
      const movId = await registrarMovimiento(client, {
        tipo: 'RECEPCION', destino_id: Number(oc.almacen_id), items: movItems, usuario_id: user.id, oc_id: id, proveedor_id: Number(oc.proveedor_id),
        referencia: `Pedido proveedor #${id}${ref ? ' · ' + ref : ''}`, observacion: str(body.observacion, 1000),
      });
      const { rows: tot } = await client.query(
        'SELECT count(*) FILTER (WHERE cantidad_recibida < cantidad)::int AS pendientes FROM oc_items WHERE oc_id = $1', [id]);
      const estado = Number(tot[0].pendientes) === 0 ? 'RECIBIDA' : 'PARCIAL';
      await client.query(
        `UPDATE ordenes_compra SET estado = $2${estado === 'RECIBIDA' ? ', cerrado_por = $3, cerrado_en = now()' : ''} WHERE id = $1`,
        estado === 'RECIBIDA' ? [id, estado, user.id] : [id, estado]);
      return { movimiento_id: movId, estado, excedentes };
    });
  });

  // ---------- Archivos (remito / factura) ----------
  route('POST', '/api/oc/:id/archivos', async ({ user, body, params }) => {
    const id = toInt(params.id);
    if (!esProveedor(user)) permitirAlguno(user, 'compras', 'recibir');
    return tx(async (client) => {
      await ocBloqueada(client, id, ['CONFIRMADA', 'PARCIAL', 'RECIBIDA', 'CERRADA'], user);
      const tipo = ['REMITO', 'FACTURA', 'OTRO'].includes(body.tipo) ? body.tipo : fail(400, 'Indicá si es remito, factura u otro');
      const nombre = str(body.nombre, 200);
      if (!nombre) fail(400, 'Falta el archivo');
      const ext = (nombre.split('.').pop() || '').toLowerCase();
      const mime = TIPOS_ARCHIVO[ext];
      if (!mime) fail(400, 'Formato no admitido. Subí PDF, imagen (JPG/PNG), Excel, Word, CSV o TXT.');
      const data = Buffer.from(String(body.data || ''), 'base64');
      if (!data.length) fail(400, 'El archivo está vacío');
      if (data.length > MAX_ARCHIVO) fail(413, 'El archivo supera los 8 MB');
      const { rows } = await client.query(
        `INSERT INTO oc_archivos (oc_id, tipo, numero, nombre_archivo, mime, tamano, contenido, subido_por)
         VALUES ($1, $2, $3, $4, $5, $6, decode($7, 'base64'), $8) RETURNING id`,
        [id, tipo, str(body.numero, 60), nombre, mime, data.length, data.toString('base64'), user.id]);
      return { id: Number(rows[0].id) };
    });
  });

  route('GET', '/api/oc/:id/archivos/:aid', async ({ user, params }) => {
    const id = toInt(params.id);
    await cargarOC(id, user);
    const { rows } = await query(
      "SELECT nombre_archivo, mime, encode(contenido, 'base64') AS b64 FROM oc_archivos WHERE id = $1 AND oc_id = $2", [toInt(params.aid), id]);
    if (!rows[0]) fail(404, 'Archivo inexistente');
    const nombre = rows[0].nombre_archivo.replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_');
    return {
      __raw: {
        body: Buffer.from(rows[0].b64, 'base64'),
        headers: {
          'Content-Type': rows[0].mime,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(nombre)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        },
      },
    };
  });

  route('DELETE', '/api/oc/:id/archivos/:aid', async ({ user, params }) => {
    const id = toInt(params.id);
    return tx(async (client) => {
      await ocBloqueada(client, id, ABIERTAS, user);
      const { rows } = await client.query('SELECT subido_por FROM oc_archivos WHERE id = $1 AND oc_id = $2', [toInt(params.aid), id]);
      if (!rows[0]) fail(404, 'Archivo inexistente');
      if (Number(rows[0].subido_por) !== user.id && !puede(user, 'compras')) fail(403, 'Solo quien subió el archivo o Compras puede eliminarlo');
      await client.query('DELETE FROM oc_archivos WHERE id = $1', [toInt(params.aid)]);
      return { ok: true };
    });
  });
};
