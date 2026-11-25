// Sucursales (ABM), asignación de empleados y programación de días de trabajo.
const { TIPOS } = require('./personal');

module.exports = function registrarProgramacion({ route, query, tx, fail, permitir, permitirAlguno, isTrue, toInt, str, fechaOk }) {
  // Vacaciones y licencias (aprobadas y pendientes) que tocan un período
  const licencias = async (desde, hasta, usuarios = null, soloAprobadas = false) => {
    const { rows } = await query(
      `SELECT s.id, s.usuario_id, s.tipo, s.desde, coalesce(s.hasta, s.desde) AS hasta, s.estado FROM solicitudes s
       WHERE s.tipo <> 'ADELANTO' AND s.desde IS NOT NULL AND s.estado IN (${soloAprobadas ? "'APROBADA'" : "'APROBADA','PENDIENTE'"})
         AND s.desde <= $2 AND coalesce(s.hasta, s.desde) >= $1 ${usuarios ? 'AND s.usuario_id = ANY($3::int[])' : ''}
       ORDER BY s.desde`, usuarios ? [desde, hasta, `{${usuarios.join(',')}}`] : [desde, hasta]);
    return rows.map((r) => ({ id: Number(r.id), usuario_id: Number(r.usuario_id), tipo: r.tipo, tipo_nombre: (TIPOS[r.tipo] || {}).nombre || r.tipo,
      desde: r.desde, hasta: r.hasta, estado: r.estado }));
  };
  const deLicencia = (lics, u, f) => lics.find((l) => l.usuario_id === u && l.estado === 'APROBADA' && l.desde <= f && l.hasta >= f);

  const hora = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) fail(400, `Hora inválida: ${v}`);
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  };
  const hhmm = (t) => (t ? String(t).slice(0, 5) : null);
  const turno = (r) => ({
    id: Number(r.id), usuario_id: Number(r.usuario_id), sucursal_id: Number(r.sucursal_id), fecha: r.fecha,
    hora_desde: hhmm(r.hora_desde), hora_hasta: hhmm(r.hora_hasta), nota: r.nota || null, sucursal: r.sucursal,
    evento_id: r.evento_id ? Number(r.evento_id) : null, evento: r.evento || null,
  });
  const evento = (r) => ({
    id: Number(r.id), nombre: r.nombre, sucursal_id: Number(r.sucursal_id), sucursal: r.sucursal, fecha: r.fecha,
    hora_desde: hhmm(r.hora_desde), hora_hasta: hhmm(r.hora_hasta), descripcion: r.descripcion || null,
  });
  const idPos = (v) => { const n = toInt(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const pgArr = (a) => `{${a.join(',')}}`; // literal de array (independiente del driver)
  const idsValidos = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(toInt).filter(Number.isInteger))];

  // ---------- Sucursales ----------
  route('GET', '/api/sucursales', async ({ user }) => {
    permitirAlguno(user, 'sucursales', 'programacion', 'usuarios', 'misHoras', 'solicitudes');
    const { rows } = await query(
      `SELECT s.id, s.nombre, s.direccion, s.activo,
              coalesce(json_agg(json_build_object('id', u.id, 'nombre', u.nombre) ORDER BY u.nombre) FILTER (WHERE u.id IS NOT NULL), '[]') AS empleados
       FROM sucursales s LEFT JOIN usuario_sucursales us ON us.sucursal_id = s.id
       LEFT JOIN usuarios u ON u.id = us.usuario_id AND u.activo
       GROUP BY s.id ORDER BY s.nombre`);
    return rows.map((r) => ({ ...r, id: Number(r.id), activo: isTrue(r.activo),
      empleados: (typeof r.empleados === 'string' ? JSON.parse(r.empleados) : r.empleados).map((e) => ({ id: Number(e.id), nombre: e.nombre })) }));
  });

  const guardarSucursal = async (user, body, id) => {
    permitir(user, 'sucursales');
    const nombre = str(body.nombre, 80);
    if (!nombre) fail(400, 'El nombre es obligatorio');
    try {
      return await tx(async (c) => {
        let sid = id;
        if (id) {
          const { rows: up } = await c.query('UPDATE sucursales SET nombre = $2, direccion = $3, activo = $4 WHERE id = $1 RETURNING id',
            [id, nombre.toUpperCase(), str(body.direccion, 200), body.activo === undefined ? true : !!body.activo]);
          if (!up.length) fail(404, 'Sucursal inexistente');
        } else {
          const { rows } = await c.query('INSERT INTO sucursales (nombre, direccion) VALUES ($1, $2) RETURNING id', [nombre.toUpperCase(), str(body.direccion, 200)]);
          sid = Number(rows[0].id);
        }
        if (Array.isArray(body.empleados)) {
          const ids = idsValidos(body.empleados);
          await c.query('DELETE FROM usuario_sucursales WHERE sucursal_id = $1', [sid]);
          for (const u of ids) await c.query('INSERT INTO usuario_sucursales (usuario_id, sucursal_id) SELECT id, $2 FROM usuarios WHERE id = $1 AND rol <> \'PROVEEDOR\' ON CONFLICT DO NOTHING', [u, sid]);
        }
        return { id: sid };
      });
    } catch (e) {
      if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ya existe una sucursal con ese nombre');
      throw e;
    }
  };
  route('POST', '/api/sucursales', ({ user, body }) => guardarSucursal(user, body, null));
  route('PUT', '/api/sucursales/:id', ({ user, body, params }) => guardarSucursal(user, body, toInt(params.id)));

  // Empleados (usuarios internos activos) para asignar a sucursales
  route('GET', '/api/programacion/empleados', async ({ user }) => {
    permitirAlguno(user, 'sucursales', 'programacion', 'usuarios');
    const { rows } = await query(
      `SELECT u.id, u.nombre, coalesce(r.nombre, u.rol) AS rol_nombre FROM usuarios u LEFT JOIN roles r ON r.codigo = u.rol
       WHERE u.activo AND u.rol <> 'PROVEEDOR' ORDER BY u.nombre`);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });

  // ---------- Programación ----------
  const rango = (url, maxDias = 62) => {
    const desde = fechaOk(url.searchParams.get('desde'));
    const hasta = fechaOk(url.searchParams.get('hasta'));
    if (!desde || !hasta) fail(400, 'Indicá desde y hasta');
    if (hasta < desde) fail(400, 'El "hasta" no puede ser anterior al "desde"');
    if (Date.parse(hasta) - Date.parse(desde) > maxDias * 86400e3) fail(400, `El período no puede superar los ${maxDias} días`);
    return { desde, hasta };
  };

  route('GET', '/api/programacion', async ({ user, url }) => {
    permitir(user, 'programacion');
    const { desde, hasta } = rango(url);
    const suc = idPos(url.searchParams.get('sucursal_id'));
    const { rows: emp } = await query(
      `SELECT u.id, u.nombre, coalesce(r.nombre, u.rol) AS rol_nombre,
              coalesce(array_agg(us.sucursal_id ORDER BY us.sucursal_id) FILTER (WHERE us.sucursal_id IS NOT NULL), '{}') AS sucursales
       FROM usuarios u LEFT JOIN roles r ON r.codigo = u.rol LEFT JOIN usuario_sucursales us ON us.usuario_id = u.id
       WHERE u.activo AND u.rol <> 'PROVEEDOR'
       GROUP BY u.id, r.nombre ORDER BY u.nombre`);
    const { rows: t } = await query(
      `SELECT p.*, s.nombre AS sucursal, ev.nombre AS evento FROM programacion p JOIN sucursales s ON s.id = p.sucursal_id LEFT JOIN eventos ev ON ev.id = p.evento_id
       WHERE p.fecha BETWEEN $1 AND $2 ${(suc !== null) ? 'AND p.sucursal_id = $3' : ''} ORDER BY p.fecha, p.hora_desde NULLS FIRST`,
      (suc !== null) ? [desde, hasta, suc] : [desde, hasta]);
    const turnos = t.map(turno);
    const conTurno = new Set(turnos.map((x) => x.usuario_id));
    const empleados = emp.map((e) => ({ id: Number(e.id), nombre: e.nombre, rol_nombre: e.rol_nombre, sucursales: (Array.isArray(e.sucursales) ? e.sucursales : String(e.sucursales || '').replace(/[{}]/g, '').split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0) }))
      .filter((e) => ((suc !== null) ? e.sucursales.includes(suc) : e.sucursales.length) || conTurno.has(e.id));
    const { rows: ev } = await query(
      `SELECT e.*, s.nombre AS sucursal FROM eventos e JOIN sucursales s ON s.id = e.sucursal_id
       WHERE e.fecha BETWEEN $1 AND $2 ${(suc !== null) ? 'AND e.sucursal_id = $3' : ''} ORDER BY e.fecha, e.hora_desde NULLS FIRST`,
      (suc !== null) ? [desde, hasta, suc] : [desde, hasta]);
    const eventos = ev.map(evento).map((e) => {
      const pers = turnos.filter((t) => t.evento_id === e.id);
      return { ...e, personal: pers.map((t) => t.usuario_id), personal_desde: pers[0] ? pers[0].hora_desde : null, personal_hasta: pers[0] ? pers[0].hora_hasta : null };
    });
    return { desde, hasta, empleados, turnos, eventos, licencias: await licencias(desde, hasta) };
  });

  // ---------- Eventos ----------
  const guardarEvento = async (user, body, id) => {
    permitir(user, 'programacion');
    const nombre = str(body.nombre, 120);
    if (!nombre) fail(400, 'Poné el nombre del evento');
    const fecha = fechaOk(body.fecha);
    if (!fecha) fail(400, 'Indicá la fecha del evento');
    const sucursal = idPos(body.sucursal_id);
    const { rows: s } = await query('SELECT id, nombre, activo FROM sucursales WHERE id = $1', [sucursal]);
    if (!s[0]) fail(400, 'Elegí la sucursal');
    if (!isTrue(s[0].activo)) fail(400, `La sucursal ${s[0].nombre} está inactiva`);
    const desde = hora(body.hora_desde), hasta = hora(body.hora_hasta);
    if ((desde && !hasta) || (!desde && hasta)) fail(400, 'Indicá la hora de inicio y la de fin del evento, o dejá las dos vacías');
    let pDesde = hora(body.personal_desde), pHasta = hora(body.personal_hasta);
    if ((pDesde && !pHasta) || (!pDesde && pHasta)) fail(400, 'Indicá la entrada y la salida del personal, o dejá las dos vacías');
    if (!pDesde) { pDesde = desde; pHasta = hasta; }
    const empleados = idsValidos(body.empleados);
    if (empleados.length) {
      const { rows: a } = await query(
        `SELECT u.id, u.nombre, EXISTS (SELECT 1 FROM usuario_sucursales us WHERE us.usuario_id = u.id AND us.sucursal_id = $2) AS asignado
         FROM usuarios u WHERE u.id = ANY($1::int[]) AND u.activo AND u.rol <> 'PROVEEDOR'`, [pgArr(empleados), sucursal]);
      if (a.length !== empleados.length) fail(400, 'Algún empleado no existe o está inactivo');
      const fuera = a.filter((x) => !isTrue(x.asignado)).map((x) => x.nombre);
      if (fuera.length) fail(400, `${fuera.join(', ')} no ${fuera.length === 1 ? 'está asignado' : 'están asignados'} a ${s[0].nombre}`);
      const lics = await licencias(fecha, fecha, empleados, true);
      const ausentes = a.filter((x) => deLicencia(lics, Number(x.id), fecha)).map((x) => `${x.nombre} (${deLicencia(lics, Number(x.id), fecha).tipo_nombre.toLowerCase()})`);
      if (ausentes.length) fail(409, `Ese día no ${ausentes.length === 1 ? 'trabaja' : 'trabajan'}: ${ausentes.join(', ')}`);
    }
    return tx(async (c) => {
      let eid = id;
      if (id) {
        const { rows } = await c.query('UPDATE eventos SET nombre = $2, sucursal_id = $3, fecha = $4, hora_desde = $5, hora_hasta = $6, descripcion = $7 WHERE id = $1 RETURNING id',
          [id, nombre, sucursal, fecha, desde, hasta, str(body.descripcion, 500)]);
        if (!rows.length) fail(404, 'Evento inexistente');
        await c.query('DELETE FROM programacion WHERE evento_id = $1', [id]);
      } else {
        const { rows } = await c.query('INSERT INTO eventos (nombre, sucursal_id, fecha, hora_desde, hora_hasta, descripcion, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [nombre, sucursal, fecha, desde, hasta, str(body.descripcion, 500), user.id]);
        eid = Number(rows[0].id);
      }
      // El personal queda programado ese día en esa sucursal, vinculado al evento
      for (const u of empleados) {
        await c.query(
          `INSERT INTO programacion (usuario_id, sucursal_id, fecha, hora_desde, hora_hasta, evento_id, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (usuario_id, fecha, sucursal_id) DO UPDATE SET hora_desde = EXCLUDED.hora_desde, hora_hasta = EXCLUDED.hora_hasta, evento_id = EXCLUDED.evento_id`,
          [u, sucursal, fecha, pDesde, pHasta, eid, user.id]);
      }
      return { id: eid, personal: empleados.length };
    });
  };
  route('POST', '/api/eventos', ({ user, body }) => guardarEvento(user, body, null));
  route('PUT', '/api/eventos/:id', ({ user, body, params }) => guardarEvento(user, body, idPos(params.id)));
  route('DELETE', '/api/eventos/:id', async ({ user, params }) => {
    permitir(user, 'programacion');
    const { rows } = await query('DELETE FROM eventos WHERE id = $1 RETURNING id', [idPos(params.id)]);
    if (!rows.length) fail(404, 'Evento inexistente');
    return { ok: true };
  });

  // Programar uno o varios empleados en una o varias fechas (crea o actualiza)
  route('POST', '/api/programacion', async ({ user, body }) => {
    permitir(user, 'programacion');
    const usuarios = idsValidos(body.usuario_ids || (body.usuario_id ? [body.usuario_id] : []));
    const sucursal = toInt(body.sucursal_id);
    const fechas = [...new Set((Array.isArray(body.fechas) ? body.fechas : []).map(fechaOk).filter(Boolean))].sort();
    if (!usuarios.length) fail(400, 'Elegí al menos un empleado');
    if (!fechas.length) fail(400, 'Elegí al menos un día');
    if (usuarios.length * fechas.length > 2000) fail(400, 'Demasiados días de una vez: programá por partes (máximo 2000)');
    const desde = hora(body.hora_desde), hasta = hora(body.hora_hasta);
    if ((desde && !hasta) || (!desde && hasta)) fail(400, 'Indicá la hora de entrada y la de salida, o dejá las dos vacías');
    const nota = str(body.nota, 200);
    const { rows: s } = await query('SELECT id, nombre, activo FROM sucursales WHERE id = $1', [sucursal]);
    if (!s[0]) fail(400, 'Elegí la sucursal');
    if (!isTrue(s[0].activo)) fail(400, `La sucursal ${s[0].nombre} está inactiva`);
    const { rows: asig } = await query(
      `SELECT u.id, u.nombre, EXISTS (SELECT 1 FROM usuario_sucursales us WHERE us.usuario_id = u.id AND us.sucursal_id = $2) AS asignado
       FROM usuarios u WHERE u.id = ANY($1::int[]) AND u.activo AND u.rol <> 'PROVEEDOR'`, [pgArr(usuarios), sucursal]);
    if (asig.length !== usuarios.length) fail(400, 'Algún empleado no existe o está inactivo');
    const fuera = asig.filter((a) => !isTrue(a.asignado)).map((a) => a.nombre);
    if (fuera.length) fail(400, `${fuera.join(', ')} no ${fuera.length === 1 ? 'está asignado' : 'están asignados'} a ${s[0].nombre}. Asignalo en Sucursales o en Usuarios.`);
    const reemplazar = !!body.reemplazar;
    const lics = await licencias(fechas[0], fechas[fechas.length - 1], usuarios, true);
    const nombres = new Map(asig.map((a) => [Number(a.id), a.nombre]));
    if (usuarios.length * fechas.length === 1 && deLicencia(lics, usuarios[0], fechas[0])) {
      const l = deLicencia(lics, usuarios[0], fechas[0]);
      fail(409, `${nombres.get(usuarios[0])} no trabaja ese día: tiene ${l.tipo_nombre.toLowerCase()} con solicitud aprobada`);
    }
    return tx(async (c) => {
      let creados = 0, actualizados = 0, quitados = 0, omitidos = 0;
      for (const u of usuarios) {
        if (reemplazar) {
          const { rows: q } = await c.query('DELETE FROM programacion WHERE usuario_id = $1 AND fecha = ANY($2::date[]) AND sucursal_id <> $3 RETURNING id', [u, pgArr(fechas), sucursal]);
          quitados += q.length;
        }
        for (const f of fechas) {
          if (deLicencia(lics, u, f)) { omitidos++; continue; }
          const { rows } = await c.query(
            `INSERT INTO programacion (usuario_id, sucursal_id, fecha, hora_desde, hora_hasta, nota, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (usuario_id, fecha, sucursal_id) DO UPDATE SET hora_desde = EXCLUDED.hora_desde, hora_hasta = EXCLUDED.hora_hasta, nota = EXCLUDED.nota
             RETURNING (xmax = 0) AS nuevo`, [u, sucursal, f, desde, hasta, nota, user.id]);
          if (rows[0] && (rows[0].nuevo === true || rows[0].nuevo === 't')) creados++; else actualizados++;
        }
      }
      return { creados, actualizados, quitados, omitidos };
    });
  });

  route('PUT', '/api/programacion/:id', async ({ user, body, params }) => {
    permitir(user, 'programacion');
    const id = toInt(params.id);
    const { rows } = await query('SELECT * FROM programacion WHERE id = $1', [id]);
    if (!rows[0]) fail(404, 'Día programado inexistente');
    const sucursal = toInt(body.sucursal_id) || Number(rows[0].sucursal_id);
    const desde = hora(body.hora_desde), hasta = hora(body.hora_hasta);
    if ((desde && !hasta) || (!desde && hasta)) fail(400, 'Indicá la hora de entrada y la de salida, o dejá las dos vacías');
    const { rows: a } = await query('SELECT 1 FROM usuario_sucursales WHERE usuario_id = $1 AND sucursal_id = $2', [rows[0].usuario_id, sucursal]);
    if (!a.length) fail(400, 'El empleado no está asignado a esa sucursal');
    try {
      await query('UPDATE programacion SET sucursal_id = $2, hora_desde = $3, hora_hasta = $4, nota = $5 WHERE id = $1', [id, sucursal, desde, hasta, str(body.nota, 200)]);
    } catch (e) {
      if (e.code === '23505' || /duplicate|unique/i.test(e.message)) fail(409, 'Ese día ya está programado en esa sucursal');
      throw e;
    }
    return { ok: true };
  });

  route('DELETE', '/api/programacion/:id', async ({ user, params }) => {
    permitir(user, 'programacion');
    const { rows } = await query('DELETE FROM programacion WHERE id = $1 RETURNING id', [toInt(params.id)]);
    if (!rows.length) fail(404, 'Día programado inexistente');
    return { ok: true };
  });

  // Quitar varios días (por empleado/s y rango, opcionalmente de una sucursal)
  route('POST', '/api/programacion/quitar', async ({ user, body }) => {
    permitir(user, 'programacion');
    const usuarios = idsValidos(body.usuario_ids);
    const fechas = [...new Set((Array.isArray(body.fechas) ? body.fechas : []).map(fechaOk).filter(Boolean))];
    if (!usuarios.length || !fechas.length) fail(400, 'Elegí empleados y días');
    const suc = idPos(body.sucursal_id);
    const { rows } = await query(
      `DELETE FROM programacion WHERE usuario_id = ANY($1::int[]) AND fecha = ANY($2::date[]) ${(suc !== null) ? 'AND sucursal_id = $3' : ''} RETURNING id`,
      (suc !== null) ? [pgArr(usuarios), pgArr(fechas), suc] : [pgArr(usuarios), pgArr(fechas)]);
    return { quitados: rows.length };
  });

  // Copiar la semana anterior (7 días antes) a la semana que empieza en "desde"
  route('POST', '/api/programacion/copiar-semana', async ({ user, body }) => {
    permitir(user, 'programacion');
    const desde = fechaOk(body.desde);
    if (!desde) fail(400, 'Indicá la semana');
    const suc = idPos(body.sucursal_id);
    const { rows } = await query(
      `INSERT INTO programacion (usuario_id, sucursal_id, fecha, hora_desde, hora_hasta, nota, creado_por)
       SELECT p.usuario_id, p.sucursal_id, p.fecha + 7, p.hora_desde, p.hora_hasta, p.nota, $3
       FROM programacion p JOIN usuarios u ON u.id = p.usuario_id AND u.activo
       JOIN sucursales s ON s.id = p.sucursal_id AND s.activo
       JOIN usuario_sucursales us ON us.usuario_id = p.usuario_id AND us.sucursal_id = p.sucursal_id
       WHERE p.evento_id IS NULL AND p.fecha BETWEEN $1::date - 7 AND $1::date - 1 AND ($2::int IS NULL OR p.sucursal_id = $2::int)
         AND NOT EXISTS (SELECT 1 FROM solicitudes so WHERE so.usuario_id = p.usuario_id AND so.tipo <> 'ADELANTO' AND so.estado = 'APROBADA'
                           AND p.fecha + 7 BETWEEN so.desde AND coalesce(so.hasta, so.desde))
       ON CONFLICT (usuario_id, fecha, sucursal_id) DO NOTHING RETURNING id`, [desde, (suc !== null) ? suc : null, user.id]);
    return { copiados: rows.length };
  });

  // Lo programado para el propio usuario
  route('GET', '/api/programacion/mia', async ({ user, url }) => {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const desde = fechaOk(url.searchParams.get('desde')) || hoy;
    const h = fechaOk(url.searchParams.get('hasta'));
    const hasta = h || new Date(Date.parse(desde) + 20 * 86400e3).toISOString().slice(0, 10);
    if (hasta < desde || Date.parse(hasta) - Date.parse(desde) > 93 * 86400e3) fail(400, 'Período inválido');
    const { rows } = await query(
      `SELECT p.*, s.nombre AS sucursal, ev.nombre AS evento FROM programacion p JOIN sucursales s ON s.id = p.sucursal_id LEFT JOIN eventos ev ON ev.id = p.evento_id
       WHERE p.usuario_id = $1 AND p.fecha BETWEEN $2 AND $3 ORDER BY p.fecha, p.hora_desde NULLS FIRST`, [user.id, desde, hasta]);
    return { desde, hasta, turnos: rows.map(turno), licencias: await licencias(desde, hasta, [user.id]) };
  });
};
