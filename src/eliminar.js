// Eliminación por el ADMIN de conteos e importaciones de consumos de Fudo.
// Si ya se aplicaron (generaron un movimiento de stock), se puede revertir ese movimiento antes de eliminar.
module.exports = function registrarEliminar({ route, query, tx, fail, toInt }) {
  const soloAdmin = (user) => { if (user.rol !== 'ADMIN') fail(403, 'Solo el administrador puede eliminar'); };

  // Deshace el efecto de un movimiento en el stock y lo borra. Devuelve avisos si algún producto no tenía stock suficiente para revertir.
  async function revertirMovimiento(client, movId) {
    const { rows: m } = await client.query('SELECT id, tipo, origen_id, destino_id FROM movimientos WHERE id = $1 FOR UPDATE', [movId]);
    if (!m[0]) return { revertido: false, avisos: [] };
    const mov = m[0];
    const { rows: items } = await client.query('SELECT mi.producto_id, mi.cantidad, p.nombre FROM movimiento_items mi JOIN productos p ON p.id = mi.producto_id WHERE mi.movimiento_id = $1', [movId]);
    const avisos = [];
    const sumar = (alm, pid, cant) => client.query(`INSERT INTO stock (almacen_id, producto_id, cantidad) VALUES ($1,$2,$3)
      ON CONFLICT (almacen_id, producto_id) DO UPDATE SET cantidad = stock.cantidad + EXCLUDED.cantidad`, [alm, pid, cant]);
    const restar = async (alm, pid, cant, nombre) => {
      const { rows } = await client.query('SELECT cantidad FROM stock WHERE almacen_id = $1 AND producto_id = $2 FOR UPDATE', [alm, pid]);
      const hay = rows[0] ? Number(rows[0].cantidad) : 0;
      if (hay < cant) avisos.push(`${nombre}: había ${hay} y se debían descontar ${cant}, quedó en 0`);
      await client.query('UPDATE stock SET cantidad = GREATEST(0, cantidad - $3) WHERE almacen_id = $1 AND producto_id = $2', [alm, pid, cant]);
    };
    for (const it of items) {
      const pid = Number(it.producto_id), c = Number(it.cantidad);
      if (mov.tipo === 'CONSUMO') await sumar(mov.origen_id, pid, c);                 // devuelve lo consumido
      else if (mov.tipo === 'AJUSTE') { if (c > 0) await restar(mov.origen_id, pid, c, it.nombre); else await sumar(mov.origen_id, pid, -c); } // deshace la diferencia
      else fail(400, `No se puede revertir un movimiento de tipo ${mov.tipo}`);
    }
    await client.query('UPDATE conteos SET movimiento_id = NULL WHERE movimiento_id = $1', [movId]);
    await client.query('UPDATE consumo_importaciones SET movimiento_id = NULL WHERE movimiento_id = $1', [movId]);
    await client.query('DELETE FROM movimientos WHERE id = $1', [movId]);
    return { revertido: true, productos: items.length, avisos };
  }

  route('DELETE', '/api/conteos/:id', async ({ user, params, url }) => {
    soloAdmin(user);
    const id = toInt(params.id), revertir = url.searchParams.get('revertir') === '1';
    return tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM conteos WHERE id = $1 FOR UPDATE', [id]);
      const c = rows[0]; if (!c) fail(404, 'Conteo inexistente');
      let r = { revertido: false, avisos: [] };
      if (c.movimiento_id && revertir) r = await revertirMovimiento(client, c.movimiento_id);
      await client.query('DELETE FROM conteos WHERE id = $1', [id]);
      console.log(`Eliminar: ${user.nombre} eliminó el conteo #${id} (${c.estado}${r.revertido ? ', stock revertido' : ''})`);
      return { ok: true, ...r };
    });
  });

  route('DELETE', '/api/consumos-fudo/:id', async ({ user, params, url }) => {
    soloAdmin(user);
    const id = toInt(params.id), revertir = url.searchParams.get('revertir') === '1';
    return tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM consumo_importaciones WHERE id = $1 FOR UPDATE', [id]);
      const i = rows[0]; if (!i) fail(404, 'Importación inexistente');
      let r = { revertido: false, avisos: [] };
      if (i.movimiento_id && revertir) r = await revertirMovimiento(client, i.movimiento_id);
      await client.query('DELETE FROM consumo_importaciones WHERE id = $1', [id]);
      console.log(`Eliminar: ${user.nombre} eliminó la importación de Fudo #${id} (${i.estado}${r.revertido ? ', stock devuelto' : ''})`);
      return { ok: true, ...r };
    });
  });
};
