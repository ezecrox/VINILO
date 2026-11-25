// Tareas pendientes del panel inicial, según los permisos de cada usuario.
const PRIORIDAD = { alta: 0, media: 1, baja: 2 };
const fmt = (d) => new Date(d).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });
const fmtDia = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const n = (v) => Number(v || 0);

async function calcularTareas(user, { query, fudo, sqlAlm }) {
  const p = (x) => user.permisos.includes(x);
  const t = [];
  const add = (x) => { if (x.cantidad > 0 || x.siempre) t.push(x); };

  // ---- Proveedor (portal) ----
  if (p('portalProveedor')) {
    const { rows } = await query(
      `SELECT oc.id, oc.estado, oc.fecha_entrega, a.nombre AS almacen,
              (SELECT count(*)::int FROM oc_archivos f WHERE f.oc_id = oc.id) AS archivos,
              (SELECT coalesce(sum(GREATEST(i.cantidad - i.cantidad_recibida,0)),0)::int FROM oc_items i WHERE i.oc_id = oc.id) AS pendiente
       FROM ordenes_compra oc JOIN almacenes a ON a.id = oc.almacen_id
       WHERE oc.proveedor_id = $1 AND oc.estado IN ('CONFIRMADA','PARCIAL') ORDER BY oc.fecha_entrega NULLS LAST, oc.id`, [user.proveedor_id]);
    const sinDoc = rows.filter((r) => n(r.archivos) === 0);
    add({ id: 'prov-remito', prioridad: 'alta', titulo: 'Subí el remito o la factura', cantidad: sinDoc.length, link: '#/compras',
      accion: 'Ir a mis pedidos', detalle: 'Pedidos confirmados que todavía no tienen documento cargado.',
      items: sinDoc.slice(0, 6).map((r) => ({ texto: `Pedido #${r.id} → ${r.almacen}`, sub: r.fecha_entrega ? `Entrega prevista ${fmtDia(r.fecha_entrega)}` : '', link: `#/compras?id=${r.id}` })) });
    add({ id: 'prov-entregar', prioridad: 'media', titulo: 'Pedidos por entregar', cantidad: rows.length, link: '#/compras', accion: 'Ver pedidos',
      detalle: 'Pedidos confirmados por Vinilo con mercadería pendiente.',
      items: rows.slice(0, 6).map((r) => ({ texto: `Pedido #${r.id} → ${r.almacen}`, sub: `${r.pendiente} unidades pendientes${r.estado === 'PARCIAL' ? ' · entrega parcial' : ''}`, link: `#/compras?id=${r.id}` })) });
    return ordenar(t);
  }

  // ---- Personal ----
  if (p('gestionarSolicitudes')) {
    const { rows } = await query(
      `SELECT s.id, s.tipo, s.desde, s.hasta, s.dias, s.monto, s.creado_en, u.nombre AS empleado FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.estado = 'PENDIENTE' AND s.usuario_id <> $1 ORDER BY coalesce(s.desde, s.creado_en::date), s.creado_en`, [user.id]);
    const NOM = { ADELANTO: 'Adelanto', VACACIONES: 'Vacaciones', EXAMEN: 'Examen', ENFERMEDAD: 'Enfermedad', MATRIMONIO: 'Matrimonio', NACIMIENTO: 'Nacimiento',
      FALLECIMIENTO: 'Fallecimiento', MUDANZA: 'Mudanza', TRAMITE: 'Trámite', OTRO: 'Otro' };
    const pronto = rows.some((r) => r.desde && new Date(r.desde) - Date.now() < 3 * 86400e3);
    add({ id: 'sol-aprobar', prioridad: pronto ? 'alta' : 'media', titulo: 'Solicitudes del personal para responder', cantidad: rows.length, link: '#/solicitudes', accion: 'Revisar solicitudes',
      detalle: 'Adelantos, vacaciones y licencias pendientes de aprobación.',
      items: rows.slice(0, 6).map((r) => ({ texto: `${r.empleado} · ${NOM[r.tipo] || r.tipo}`,
        sub: r.tipo === 'ADELANTO' ? (r.monto === null ? 'Monto a definir' : `$ ${Number(r.monto).toLocaleString('es-AR')}`) : `${fmtDia(r.desde)}${r.hasta && r.hasta !== r.desde ? ' al ' + fmtDia(r.hasta) : ''} · ${r.dias} ${Number(r.dias) === 1 ? 'día' : 'días'}`,
        link: `#/solicitudes?id=${r.id}` })) });
  }
  if (p('solicitudes')) {
    const { rows } = await query(
      `SELECT id, tipo, estado, respuesta, resuelto_en FROM solicitudes WHERE usuario_id = $1 AND estado IN ('APROBADA','RECHAZADA') AND resuelto_en > now() - interval '7 days'
       ORDER BY resuelto_en DESC`, [user.id]);
    add({ id: 'sol-respuestas', prioridad: 'media', titulo: 'Respuestas a tus solicitudes', cantidad: rows.length, link: '#/mis-solicitudes', accion: 'Ver mis solicitudes',
      detalle: 'Solicitudes resueltas en los últimos 7 días.',
      items: rows.slice(0, 6).map((r) => ({ texto: `#${r.id} · ${r.estado === 'APROBADA' ? '✅ Aprobada' : '❌ Rechazada'}`, sub: r.respuesta || '', alerta: r.estado === 'RECHAZADA', link: '#/mis-solicitudes' })) });
    const { rows: pend } = await query("SELECT count(*)::int AS n FROM solicitudes WHERE usuario_id = $1 AND estado = 'PENDIENTE'", [user.id]);
    add({ id: 'sol-pendientes', prioridad: 'baja', titulo: 'Solicitudes en espera de respuesta', cantidad: Number(pend[0].n), link: '#/mis-solicitudes', accion: 'Ver mis solicitudes',
      detalle: 'Todavía no fueron respondidas.', items: [] });
  }

  // ---- Consumos desde Fudo ----
  if (p('consumir')) {
    const { rows: bor } = await query(
      `SELECT ci.id, ci.desde, ci.hasta, a.nombre AS almacen,
              (SELECT count(*)::int FROM consumo_import_items x WHERE x.importacion_id = ci.id AND x.producto_id IS NOT NULL AND x.incluir) AS productos
       FROM consumo_importaciones ci LEFT JOIN almacenes a ON a.id = ci.almacen_id WHERE ci.estado = 'BORRADOR'
       ${user.almacenes ? `AND (ci.almacen_id IS NULL ${sqlAlm(user, 'ci.almacen_id').replace(' AND', ' OR')})` : ''} ORDER BY ci.desde`);
    add({ id: 'cf-borrador', prioridad: 'alta', titulo: 'Consumos de Fudo sin confirmar', cantidad: bor.length, link: '#/consumos-fudo', accion: 'Revisar consumos',
      detalle: 'Ventas importadas en borrador: elegí el almacén y confirmá para descontar el stock.',
      items: bor.slice(0, 6).map((r) => ({ texto: `#${r.id} · ${fmt(r.desde)} → ${fmt(r.hasta)}`, sub: `${r.productos} productos · ${r.almacen || 'almacén a definir'}`, link: '#/consumos-fudo' })) });
    if (fudo.configurado()) {
      const { rows: ult } = await query("SELECT max(hasta) AS hasta FROM consumo_importaciones WHERE estado <> 'ANULADA'");
      const hasta = ult[0] && ult[0].hasta ? new Date(ult[0].hasta) : null;
      const horas = hasta ? (Date.now() - hasta.getTime()) / 3600e3 : null;
      if (!hasta || horas > 24) {
        add({ id: 'cf-importar', prioridad: hasta && horas > 72 ? 'alta' : 'media', titulo: 'Ventas de Fudo sin importar', cantidad: 1, link: '#/consumos-fudo', accion: 'Importar ventas',
          detalle: hasta ? `El último período importado termina el ${fmt(hasta)} (hace ${Math.floor(horas / 24)} días). Importá desde ahí para mantener el stock al día.`
            : 'Todavía no se importó ningún período de ventas.', items: [] });
      }
    }
  }

  // ---- Notas de pedido internas ----
  if (p('atenderPedido')) {
    const { rows } = await query(
      `SELECT pe.id, pe.creado_en, o.nombre AS origen, d.nombre AS destino, s.nombre AS solicitante,
              (SELECT count(*)::int FROM pedido_items i WHERE i.pedido_id = pe.id) AS items
       FROM pedidos pe JOIN almacenes o ON o.id = pe.origen_id JOIN almacenes d ON d.id = pe.destino_id JOIN usuarios s ON s.id = pe.solicitante_id
       WHERE pe.estado = 'PENDIENTE' ${sqlAlm(user, 'pe.origen_id')} ORDER BY pe.creado_en`);
    const viejo = rows.some((r) => Date.now() - new Date(r.creado_en).getTime() > 24 * 3600e3);
    add({ id: 'ped-atender', prioridad: viejo ? 'alta' : 'media', titulo: 'Notas de pedido para atender', cantidad: rows.length, link: '#/pedidos', accion: 'Atender pedidos',
      detalle: 'Pedidos de transferencia entre almacenes esperando respuesta.',
      items: rows.slice(0, 6).map((r) => ({ texto: `#${r.id} · ${r.origen} → ${r.destino}`, sub: `${r.solicitante} · ${r.items} productos · ${fmt(r.creado_en)}`, link: '#/pedidos' })) });
  } else if (p('crearPedido')) {
    const { rows } = await query(
      `SELECT pe.id, pe.estado, pe.motivo_rechazo, o.nombre AS origen, d.nombre AS destino, pe.atendido_en
       FROM pedidos pe JOIN almacenes o ON o.id = pe.origen_id JOIN almacenes d ON d.id = pe.destino_id
       WHERE pe.solicitante_id = $1 AND (pe.estado = 'PENDIENTE' OR (pe.estado = 'RECHAZADO' AND pe.atendido_en > now() - interval '7 days'))
       ORDER BY pe.creado_en DESC`, [user.id]);
    const rech = rows.filter((r) => r.estado === 'RECHAZADO');
    add({ id: 'req-rechazados', prioridad: 'media', titulo: 'Pedidos rechazados', cantidad: rech.length, link: '#/pedidos', accion: 'Ver pedidos',
      detalle: 'Pedidos tuyos rechazados en los últimos 7 días.',
      items: rech.slice(0, 6).map((r) => ({ texto: `#${r.id} · ${r.origen} → ${r.destino}`, sub: r.motivo_rechazo || 'Sin motivo', link: '#/pedidos' })) });
    const pend = rows.filter((r) => r.estado === 'PENDIENTE');
    add({ id: 'req-pendientes', prioridad: 'baja', titulo: 'Tus pedidos en espera', cantidad: pend.length, link: '#/pedidos', accion: 'Ver pedidos',
      detalle: 'Todavía no fueron atendidos.', items: pend.slice(0, 6).map((r) => ({ texto: `#${r.id} · ${r.origen} → ${r.destino}`, sub: '', link: '#/pedidos' })) });
  }

  // ---- Compras ----
  if (p('compras')) {
    const { rows: bor } = await query(
      `SELECT oc.id, oc.creado_en, pr.nombre AS proveedor, (SELECT count(*)::int FROM oc_items i WHERE i.oc_id = oc.id) AS items
       FROM ordenes_compra oc JOIN proveedores pr ON pr.id = oc.proveedor_id WHERE oc.estado = 'BORRADOR' ${sqlAlm(user, 'oc.almacen_id')} ORDER BY oc.creado_en`);
    add({ id: 'oc-borrador', prioridad: 'media', titulo: 'Pedidos a proveedores sin confirmar', cantidad: bor.length, link: '#/compras', accion: 'Revisar y confirmar',
      detalle: 'Borradores que el proveedor todavía no ve.',
      items: bor.slice(0, 6).map((r) => ({ texto: `#${r.id} · ${r.proveedor}`, sub: `${r.items} productos · creado ${fmt(r.creado_en)}`, link: `#/compras?id=${r.id}` })) });
    const { rows: par } = await query(
      `SELECT oc.id, pr.nombre AS proveedor,
              (SELECT coalesce(sum(GREATEST(i.cantidad - i.cantidad_recibida,0)),0)::int FROM oc_items i WHERE i.oc_id = oc.id) AS pendiente
       FROM ordenes_compra oc JOIN proveedores pr ON pr.id = oc.proveedor_id WHERE oc.estado = 'PARCIAL' ${sqlAlm(user, 'oc.almacen_id')} ORDER BY oc.confirmado_en`);
    add({ id: 'oc-faltantes', prioridad: 'media', titulo: 'Pedidos a proveedores con faltantes', cantidad: par.length, link: '#/compras', accion: 'Reclamar o cerrar',
      detalle: 'Se recibieron en parte: reclamá lo que falta al proveedor o cerralos con faltante.',
      items: par.slice(0, 6).map((r) => ({ texto: `#${r.id} · ${r.proveedor}`, sub: `faltan ${r.pendiente} unidades`, link: `#/compras?id=${r.id}` })) });
  }
  if (p('recibir')) {
    const { rows } = await query(
      `SELECT oc.id, oc.estado, oc.fecha_entrega, pr.nombre AS proveedor, a.nombre AS almacen, (oc.fecha_entrega < CURRENT_DATE) AS vencido,
              (SELECT count(*)::int FROM oc_archivos f WHERE f.oc_id = oc.id) AS archivos
       FROM ordenes_compra oc JOIN proveedores pr ON pr.id = oc.proveedor_id JOIN almacenes a ON a.id = oc.almacen_id
       WHERE oc.estado IN ('CONFIRMADA','PARCIAL') ${sqlAlm(user, 'oc.almacen_id')} ORDER BY oc.fecha_entrega NULLS LAST, oc.id`);
    const venc = rows.filter((r) => r.vencido === true || r.vencido === 't');
    add({ id: 'oc-recibir', prioridad: venc.length ? 'alta' : 'media', titulo: 'Mercadería de proveedores por recibir', cantidad: rows.length, link: '#/compras', accion: 'Recibir mercadería',
      detalle: venc.length ? `${venc.length} con fecha de entrega vencida.` : 'Pedidos confirmados a la espera de la entrega.',
      items: rows.slice(0, 6).map((r) => ({ texto: `#${r.id} · ${r.proveedor} → ${r.almacen}`,
        sub: `${r.fecha_entrega ? `${(r.vencido === true || r.vencido === 't') ? 'Vencido: ' : 'Entrega '}${fmtDia(r.fecha_entrega)}` : 'Sin fecha'}${n(r.archivos) ? ' · 📎 remito cargado' : ''}${r.estado === 'PARCIAL' ? ' · parcial' : ''}`,
        alerta: r.vencido === true || r.vencido === 't', link: `#/compras?id=${r.id}` })) });
  }

  // ---- Stock: reposición y vencimientos ----
  if (p('verStock')) {
    const { rows: bajo } = await query(
      `SELECT m.almacen_id, a.nombre AS almacen, m.producto_id, pr.codigo, pr.nombre, m.minimo, coalesce(s.cantidad,0)::int AS cantidad
       FROM stock_minimos m JOIN productos pr ON pr.id = m.producto_id AND pr.activo AND pr.gestion_stock JOIN almacenes a ON a.id = m.almacen_id AND a.activo
       LEFT JOIN stock s ON s.almacen_id = m.almacen_id AND s.producto_id = m.producto_id
       WHERE coalesce(s.cantidad,0) < m.minimo ${sqlAlm(user, 'm.almacen_id')} ORDER BY (coalesce(s.cantidad,0) = 0) DESC, a.id, pr.nombre`);
    if (bajo.length) {
      const ids = [...new Set(bajo.map((b) => Number(b.producto_id)))];
      const { rows: otros } = await query(
        `SELECT s.almacen_id, a.nombre AS almacen, s.producto_id, s.cantidad, coalesce(m.minimo,0) AS minimo
         FROM stock s JOIN almacenes a ON a.id = s.almacen_id AND a.activo LEFT JOIN stock_minimos m ON m.almacen_id = s.almacen_id AND m.producto_id = s.producto_id
         WHERE s.producto_id = ANY($1::int[]) AND s.cantidad > 0`, [`{${ids.join(',')}}`]);
      const items = bajo.map((b) => {
        const falta = n(b.minimo) - n(b.cantidad);
        const fuente = otros.filter((o) => Number(o.producto_id) === Number(b.producto_id) && Number(o.almacen_id) !== Number(b.almacen_id))
          .map((o) => ({ ...o, sobra: n(o.cantidad) - n(o.minimo) })).filter((o) => o.sobra > 0).sort((x, y) => y.sobra - x.sobra)[0];
        return {
          texto: `${b.nombre} · ${b.almacen}`,
          sub: `hay ${b.cantidad}, mínimo ${b.minimo} · faltan ${falta} → ${!fuente ? 'pedir a proveedor'
            : fuente.sobra >= falta ? `transferir ${falta} desde ${fuente.almacen}`
              : `transferir ${fuente.sobra} desde ${fuente.almacen} y pedir ${falta - fuente.sobra} a proveedor`}`,
          alerta: n(b.cantidad) === 0,
          link: fuente ? '#/transferencia' : (p('compras') ? '#/compras' : '#/pedidos'),
        };
      });
      add({ id: 'reponer', prioridad: bajo.some((b) => n(b.cantidad) === 0) ? 'alta' : 'media', titulo: 'Productos para reponer', cantidad: bajo.length,
        link: '#/stock?bajo=1', accion: 'Ver productos bajo mínimo', detalle: 'Por debajo del stock mínimo definido para el almacén.', items: items.slice(0, 8) });
    } else {
      const { rows: hay } = await query('SELECT count(*)::int AS n FROM stock_minimos');
      if (!n(hay[0].n) && p('minimos')) {
        add({ id: 'minimos', prioridad: 'baja', titulo: 'Definí los stocks mínimos', cantidad: 1, link: '#/stock', accion: 'Ir a stock',
          detalle: 'En Stock por almacén, tocá ✎ en cada producto que se repone y cargá su mínimo por almacén: el panel te va a avisar qué reponer.', items: [] });
      }
    }
    const { rows: venc } = await query(
      `SELECT pr.id, pr.nombre, pr.fecha_vencimiento, (pr.fecha_vencimiento - CURRENT_DATE) AS dias,
              (SELECT coalesce(sum(cantidad),0)::int FROM stock s WHERE s.producto_id = pr.id ${sqlAlm(user, 's.almacen_id')}) AS total
       FROM productos pr WHERE pr.activo AND pr.gestion_stock AND pr.alerta_vencimiento AND pr.fecha_vencimiento IS NOT NULL AND pr.fecha_vencimiento <= CURRENT_DATE + 7
       ORDER BY pr.fecha_vencimiento`);
    const conStock = venc.filter((v) => n(v.total) > 0);
    add({ id: 'vencimientos', prioridad: conStock.some((v) => n(v.dias) <= 2) ? 'alta' : 'media', titulo: 'Productos por vencer', cantidad: conStock.length, link: '#/stock', accion: 'Ver stock',
      detalle: 'Con stock y vencimiento en los próximos 7 días.',
      items: conStock.slice(0, 6).map((v) => ({ texto: v.nombre, sub: `${n(v.dias) < 0 ? 'Vencido' : n(v.dias) === 0 ? 'Vence hoy' : `Vence ${fmtDia(v.fecha_vencimiento)}`} · ${v.total} unidades`, alerta: n(v.dias) <= 0, link: '#/stock' })) });
  }

  // ---- Integración Fudo ----
  if (p('compras') || p('productos') || p('proveedores')) {
    if (fudo.configurado()) {
      for (const [ent, link] of [['proveedores', '#/proveedores'], ['productos', '#/productos']]) {
        const { rows } = await query('SELECT ok, detalle, inicio FROM fudo_sync_log WHERE entidad = $1 ORDER BY id DESC LIMIT 1', [ent]);
        if (rows[0] && (rows[0].ok === false || rows[0].ok === 'f')) {
          add({ id: `fudo-${ent}`, prioridad: 'alta', titulo: `Falló la sincronización de ${ent} con Fudo`, cantidad: 1, link, accion: 'Ver detalle',
            detalle: `${fmt(rows[0].inicio)}: ${String(rows[0].detalle || '').slice(0, 220)}`, items: [] });
        }
      }
    } else if (p('usuarios')) {
      add({ id: 'fudo-config', prioridad: 'baja', titulo: 'Conectar con Fudo', cantidad: 1, link: '#/proveedores', accion: 'Ver cómo',
        detalle: 'Cargá FUDO_API_KEY y FUDO_API_SECRET en Render para sincronizar proveedores, productos y ventas.', items: [] });
    }
  }
  return ordenar(t);
}

const ordenar = (t) => t.sort((a, b) => PRIORIDAD[a.prioridad] - PRIORIDAD[b.prioridad]);

module.exports = { calcularTareas };
