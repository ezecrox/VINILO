// Fusión de productos (ADMIN): une un producto del Fudo del GALPON con su equivalente del Fudo del BAR.
// Queda un solo producto con los dos IDs de Fudo (fudo_id y fudo_bar_id): los consumos de cada sucursal se siguen
// identificando por el ID de su cuenta. Stock, mínimos, movimientos, conteos, recetas y pedidos pasan al producto que queda.
const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'y', 'x', 'en', 'al', 'a']);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t));

// Similitud entre dos nombres: 1 = mismas palabras (ignorando "de", "la", etc.)
function similitud(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  const jac = inter / (A.size + B.size - inter);
  const contenido = inter / Math.min(A.size, B.size); // uno contenido en el otro
  return Math.max(jac, contenido >= 1 && Math.min(A.size, B.size) >= 2 ? 0.8 + 0.2 * jac : 0);
}

module.exports = function registrarFusion({ route, query, tx, fail, toInt }) {
  const soloAdmin = (user) => { if (user.rol !== 'ADMIN') fail(403, 'Solo el administrador puede fusionar productos'); };

  // Pares sugeridos: producto solo del GALPON + producto solo del BAR con nombre parecido
  route('GET', '/api/productos/fusion/sugerencias', async ({ user }) => {
    soloAdmin(user);
    const { rows } = await query(`SELECT id, codigo, nombre, categoria, fudo_id, fudo_bar_id, activo FROM productos
      WHERE (fudo_id IS NULL) <> (fudo_bar_id IS NULL)`);
    const gal = rows.filter((r) => r.fudo_id), bar = rows.filter((r) => r.fudo_bar_id);
    const pares = [];
    for (const g of gal) {
      let mejor = null;
      for (const b of bar) {
        const s = similitud(g.nombre, b.nombre);
        if (s >= 0.6 && (!mejor || s > mejor.s)) mejor = { b, s };
      }
      if (mejor) pares.push({ similitud: Math.round(mejor.s * 100), galpon: { ...g, id: Number(g.id) }, bar: { ...mejor.b, id: Number(mejor.b.id) } });
    }
    pares.sort((x, y) => y.similitud - x.similitud || x.galpon.nombre.localeCompare(y.galpon.nombre));
    return pares;
  });

  // Fusiona "otro" dentro de "principal" (el principal conserva código, nombre y categoría)
  route('POST', '/api/productos/fusionar', async ({ user, body }) => {
    soloAdmin(user);
    const pid = toInt(body.principal_id), oid = toInt(body.otro_id);
    if (!Number.isInteger(pid) || !Number.isInteger(oid) || pid === oid) fail(400, 'Elegí dos productos distintos');
    return tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM productos WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [`{${pid},${oid}}`]);
      const P = rows.find((r) => Number(r.id) === pid), O = rows.find((r) => Number(r.id) === oid);
      if (!P || !O) fail(404, 'Producto inexistente');
      if (P.fudo_id && O.fudo_id) fail(409, `Los dos productos ya tienen ID del Fudo del GALPON (${P.fudo_id} y ${O.fudo_id}): no se pueden fusionar`);
      if (P.fudo_bar_id && O.fudo_bar_id) fail(409, `Los dos productos ya tienen ID del Fudo del BAR (${P.fudo_bar_id} y ${O.fudo_bar_id}): no se pueden fusionar`);
      const q = (sql, extra = []) => c.query(sql, [pid, oid, ...extra]);
      // Stock y mínimos: se suman / se toma el mayor
      await q(`INSERT INTO stock (almacen_id, producto_id, cantidad) SELECT almacen_id, $1, cantidad FROM stock WHERE producto_id = $2
               ON CONFLICT (almacen_id, producto_id) DO UPDATE SET cantidad = stock.cantidad + EXCLUDED.cantidad`);
      await c.query('DELETE FROM stock WHERE producto_id = $1', [oid]);
      await q(`INSERT INTO stock_minimos (almacen_id, producto_id, minimo) SELECT almacen_id, $1, minimo FROM stock_minimos WHERE producto_id = $2
               ON CONFLICT (almacen_id, producto_id) DO UPDATE SET minimo = GREATEST(stock_minimos.minimo, EXCLUDED.minimo)`);
      await c.query('DELETE FROM stock_minimos WHERE producto_id = $1', [oid]);
      // Sucursales: la unión de ambas
      await q('INSERT INTO producto_sucursales (producto_id, sucursal_id) SELECT $1, sucursal_id FROM producto_sucursales WHERE producto_id = $2 ON CONFLICT DO NOTHING');
      // Conteos: si el mismo conteo tiene los dos, se suman las cantidades contadas
      await q(`UPDATE conteo_items ci SET cantidad = CASE WHEN ci.cantidad IS NULL AND o.cantidad IS NULL THEN NULL ELSE coalesce(ci.cantidad,0) + coalesce(o.cantidad,0) END
               FROM conteo_items o WHERE ci.producto_id = $1 AND o.producto_id = $2 AND o.conteo_id = ci.conteo_id`);
      await q('DELETE FROM conteo_items o WHERE o.producto_id = $2 AND EXISTS (SELECT 1 FROM conteo_items x WHERE x.conteo_id = o.conteo_id AND x.producto_id = $1)');
      await q('UPDATE conteo_items SET producto_id = $1 WHERE producto_id = $2');
      // Recetas: como insumo; y la receta propia si el principal no tiene
      await q(`UPDATE receta_insumos r SET cantidad = r.cantidad + o.cantidad FROM receta_insumos o
               WHERE r.insumo_id = $1 AND o.insumo_id = $2 AND o.producto_id = r.producto_id`);
      await q('DELETE FROM receta_insumos o WHERE o.insumo_id = $2 AND EXISTS (SELECT 1 FROM receta_insumos x WHERE x.producto_id = o.producto_id AND x.insumo_id = $1)');
      await q('UPDATE receta_insumos SET insumo_id = $1 WHERE insumo_id = $2');
      await c.query('DELETE FROM receta_insumos WHERE producto_id = $1 AND insumo_id = $1', [pid]); // por si quedó como insumo de sí mismo
      const { rows: rp } = await c.query('SELECT 1 FROM recetas WHERE producto_id = $1', [pid]);
      if (!rp.length) {
        const { rows: ro } = await c.query('SELECT 1 FROM recetas WHERE producto_id = $1', [oid]);
        if (ro.length) {
          await q('INSERT INTO recetas (producto_id, rendimiento, instrucciones, actualizado_en) SELECT $1, rendimiento, instrucciones, actualizado_en FROM recetas WHERE producto_id = $2');
          await q('UPDATE receta_insumos SET producto_id = $1 WHERE producto_id = $2');
        }
      }
      // Historial: movimientos, pedidos, órdenes de compra e importaciones de Fudo
      const historial = {};
      for (const t of ['movimiento_items', 'pedido_items', 'oc_items', 'consumo_import_items', 'consumos_personal']) {
        const r = await q(`UPDATE ${t} SET producto_id = $1 WHERE producto_id = $2 RETURNING 1`);
        historial[t] = r.rows.length;
      }
      // Datos del producto: IDs de Fudo de las dos cuentas, alertas y gestión combinadas
      const fudoId = P.fudo_id || O.fudo_id, fudoBar = P.fudo_bar_id || O.fudo_bar_id, barras = P.codigo_barras || O.codigo_barras;
      await c.query('UPDATE productos SET fudo_id = NULL, fudo_bar_id = NULL, codigo_barras = NULL WHERE id = $1', [oid]);
      await c.query(`UPDATE productos p SET fudo_id = $2, fudo_bar_id = $3, codigo_barras = $4,
          categoria = coalesce(p.categoria, o.categoria),
          gestion_stock = p.gestion_stock OR o.gestion_stock, gestion_produccion = p.gestion_produccion OR o.gestion_produccion,
          alerta_vencimiento = p.alerta_vencimiento OR o.alerta_vencimiento, alerta_cuidado = p.alerta_cuidado OR o.alerta_cuidado, alerta_frio = p.alerta_frio OR o.alerta_frio,
          fecha_vencimiento = coalesce(p.fecha_vencimiento, o.fecha_vencimiento), nota_alerta = coalesce(nullif(p.nota_alerta, ''), o.nota_alerta),
          activo = p.activo OR o.activo
        FROM productos o WHERE p.id = $1 AND o.id = $5`, [pid, fudoId, fudoBar, barras, oid]);
      await c.query('DELETE FROM productos WHERE id = $1', [oid]);
      console.log(`Fusión de productos por ${user.username}: #${oid} "${O.nombre}" → #${pid} "${P.nombre}" (Fudo GALPON ${fudoId || '-'}, BAR ${fudoBar || '-'})`);
      return { ok: true, id: pid, nombre: P.nombre, eliminado: O.nombre, fudo_id: fudoId, fudo_bar_id: fudoBar, historial };
    });
  });
};
module.exports.similitud = similitud;
