// Personal: solicitudes de empleados (adelantos de sueldo, vacaciones y licencias) y su aprobación.
const TIPOS = {
  ADELANTO: { nombre: 'Adelanto de sueldo', fechas: false, monto: true },
  VACACIONES: { nombre: 'Vacaciones', fechas: true },
  EXAMEN: { nombre: 'Día por examen', fechas: true },
  ENFERMEDAD: { nombre: 'Enfermedad', fechas: true },
  MATRIMONIO: { nombre: 'Matrimonio', fechas: true },
  NACIMIENTO: { nombre: 'Nacimiento de hijo/a', fechas: true },
  FALLECIMIENTO: { nombre: 'Fallecimiento de familiar', fechas: true },
  MUDANZA: { nombre: 'Mudanza', fechas: true },
  TRAMITE: { nombre: 'Trámite personal', fechas: true },
  OTRO: { nombre: 'Otro', fechas: true },
};
const MAX_ARCHIVO = 8 * 1024 * 1024;
const MIMES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

module.exports = function registrarPersonal({ route, query, tx, fail, permitir, permitirAlguno, isTrue, toInt, str, fechaOk }) {
  const puede = (u, p) => u.permisos.includes(p);
  const dias = (d, h) => Math.round((Date.parse(h) - Date.parse(d)) / 86400e3) + 1;

  const normal = (r) => ({
    ...r, id: Number(r.id), usuario_id: Number(r.usuario_id), dias: r.dias === null || r.dias === undefined ? null : Number(r.dias),
    monto: r.monto === null || r.monto === undefined ? null : Number(r.monto),
    monto_aprobado: r.monto_aprobado === null || r.monto_aprobado === undefined ? null : Number(r.monto_aprobado),
    desde: r.desde ? String(r.desde).slice(0, 10) : null, hasta: r.hasta ? String(r.hasta).slice(0, 10) : null,
    archivos: r.archivos === undefined ? undefined : Number(r.archivos), tipo_nombre: (TIPOS[r.tipo] || {}).nombre || r.tipo,
  });

  const SELECT = `SELECT s.*, u.nombre AS empleado, u.username, ur.nombre AS resuelto_por_nombre,
      (SELECT count(*)::int FROM solicitud_archivos a WHERE a.solicitud_id = s.id) AS archivos
    FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id LEFT JOIN usuarios ur ON ur.id = s.resuelto_por`;

  async function cargar(id, user) {
    const { rows } = await query(`${SELECT} WHERE s.id = $1`, [id]);
    const s = rows[0];
    if (!s) fail(404, 'Solicitud inexistente');
    if (Number(s.usuario_id) !== user.id && !puede(user, 'gestionarSolicitudes')) fail(404, 'Solicitud inexistente');
    return s;
  }

  route('GET', '/api/solicitudes/tipos', async ({ user }) => {
    permitirAlguno(user, 'solicitudes', 'gestionarSolicitudes');
    return Object.entries(TIPOS).map(([k, v]) => ({ codigo: k, ...v }));
  });

  // Mis solicitudes (empleado) o todas (quien gestiona: ?todas=1)
  route('GET', '/api/solicitudes', async ({ user, url }) => {
    permitirAlguno(user, 'solicitudes', 'gestionarSolicitudes');
    const q = url.searchParams;
    const todas = q.get('todas') === '1' && puede(user, 'gestionarSolicitudes');
    const where = [];
    const params = [];
    const add = (c, v) => { params.push(v); where.push(c.replace('?', `$${params.length}`)); };
    if (!todas) add('s.usuario_id = ?', user.id);
    if (q.get('estado')) add('s.estado = ?', q.get('estado'));
    if (q.get('tipo')) add('s.tipo = ?', q.get('tipo'));
    if (q.get('usuario_id') && todas) add('s.usuario_id = ?', toInt(q.get('usuario_id')));
    const { rows } = await query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (s.estado = 'PENDIENTE') DESC, s.creado_en DESC LIMIT 300`, params);
    // Resumen del año para el empleado (o el filtrado)
    const uid = todas ? (q.get('usuario_id') ? toInt(q.get('usuario_id')) : null) : user.id;
    let resumen = null;
    if (uid) {
      const { rows: r } = await query(
        `SELECT coalesce(sum(dias) FILTER (WHERE tipo = 'VACACIONES' AND estado = 'APROBADA' AND date_part('year', desde) = date_part('year', CURRENT_DATE)),0)::int AS vacaciones,
                coalesce(sum(dias) FILTER (WHERE tipo NOT IN ('VACACIONES','ADELANTO') AND estado = 'APROBADA' AND date_part('year', desde) = date_part('year', CURRENT_DATE)),0)::int AS licencias,
                coalesce(sum(monto_aprobado) FILTER (WHERE tipo = 'ADELANTO' AND estado = 'APROBADA' AND date_trunc('month', resuelto_en) = date_trunc('month', now())),0) AS adelantos_mes,
                count(*) FILTER (WHERE estado = 'PENDIENTE')::int AS pendientes
         FROM solicitudes WHERE usuario_id = $1`, [uid]);
      resumen = { vacaciones: Number(r[0].vacaciones), licencias: Number(r[0].licencias), adelantos_mes: Number(r[0].adelantos_mes), pendientes: Number(r[0].pendientes) };
    }
    return { solicitudes: rows.map(normal), resumen };
  });

  route('GET', '/api/solicitudes/:id', async ({ user, params }) => {
    permitirAlguno(user, 'solicitudes', 'gestionarSolicitudes');
    const s = normal(await cargar(toInt(params.id), user));
    const { rows: arch } = await query(
      'SELECT id, nombre_archivo, mime, tamano, subido_en FROM solicitud_archivos WHERE solicitud_id = $1 ORDER BY id', [s.id]);
    s.adjuntos = arch.map((a) => ({ ...a, id: Number(a.id), tamano: Number(a.tamano) }));
    // Superposición con otras ausencias aprobadas o pendientes (para quien aprueba)
    if (s.desde && puede(user, 'gestionarSolicitudes')) {
      const { rows: sup } = await query(
        `SELECT s.id, s.tipo, s.desde, s.hasta, s.estado, u.nombre AS empleado FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.id <> $1 AND s.tipo <> 'ADELANTO' AND s.estado IN ('APROBADA','PENDIENTE') AND s.desde <= $3 AND s.hasta >= $2
         ORDER BY s.desde`, [s.id, s.desde, s.hasta || s.desde]);
      s.superpuestas = sup.map((x) => ({ ...normal(x), empleado: x.empleado }));
    }
    return s;
  });

  route('POST', '/api/solicitudes', async ({ user, body }) => {
    permitir(user, 'solicitudes');
    const tipo = String(body.tipo || '').toUpperCase();
    const def = TIPOS[tipo];
    if (!def) fail(400, 'Tipo de solicitud inválido');
    let desde = null, hasta = null, n = null, monto = null;
    if (def.fechas) {
      desde = fechaOk(body.desde);
      hasta = fechaOk(body.hasta) || desde;
      if (!desde) fail(400, 'Indicá desde qué fecha');
      if (hasta < desde) fail(400, 'La fecha "hasta" no puede ser anterior a "desde"');
      n = dias(desde, hasta);
      if (n > 120) fail(400, 'El período no puede superar los 120 días');
      if (tipo === 'VACACIONES' && desde < new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)) fail(400, 'Las vacaciones se piden para fechas futuras');
      const { rows: sol } = await query(
        `SELECT id FROM solicitudes WHERE usuario_id = $1 AND tipo <> 'ADELANTO' AND estado IN ('PENDIENTE','APROBADA') AND desde <= $3 AND hasta >= $2 LIMIT 1`,
        [user.id, desde, hasta]);
      if (sol.length) fail(409, `Ya tenés la solicitud #${sol[0].id} en esas fechas`);
    }
    if (def.monto) {
      // El monto es opcional y no se valida: si no es un número, queda vacío
      const n2 = Number(String(body.monto ?? '').replace(',', '.'));
      monto = body.monto === undefined || body.monto === null || body.monto === '' || !Number.isFinite(n2) ? null : Math.round(n2 * 100) / 100;
    }
    const motivo = str(body.motivo, 1000);
    if ((tipo === 'OTRO' || tipo === 'ADELANTO') && !motivo) fail(400, 'Contá brevemente el motivo');
    const { rows } = await query(
      'INSERT INTO solicitudes (usuario_id, tipo, desde, hasta, dias, monto, motivo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [user.id, tipo, desde, hasta, n, monto, motivo]);
    return { id: Number(rows[0].id) };
  });

  route('POST', '/api/solicitudes/:id/cancelar', async ({ user, params }) => {
    permitir(user, 'solicitudes');
    const s = await cargar(toInt(params.id), user);
    if (Number(s.usuario_id) !== user.id) fail(403, 'Solo podés cancelar tus solicitudes');
    if (s.estado !== 'PENDIENTE') fail(409, 'Solo se cancelan solicitudes pendientes');
    await query("UPDATE solicitudes SET estado = 'CANCELADA', resuelto_en = now() WHERE id = $1", [s.id]);
    return { ok: true };
  });

  route('POST', '/api/solicitudes/:id/resolver', async ({ user, body, params }) => {
    permitir(user, 'gestionarSolicitudes');
    const id = toInt(params.id);
    return tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM solicitudes WHERE id = $1 FOR UPDATE', [id]);
      const s = rows[0];
      if (!s) fail(404, 'Solicitud inexistente');
      if (s.estado !== 'PENDIENTE') fail(409, `La solicitud ya está ${s.estado}`);
      if (Number(s.usuario_id) === user.id) fail(403, 'No podés resolver tu propia solicitud');
      const aprobar = body.decision === 'APROBAR';
      if (!aprobar && body.decision !== 'RECHAZAR') fail(400, 'Decisión inválida');
      const respuesta = str(body.respuesta, 1000);
      if (!aprobar && !respuesta) fail(400, 'Indicá el motivo del rechazo');
      let montoAp = null;
      if (aprobar && s.tipo === 'ADELANTO') {
        // Sin validación de monto: se toma lo indicado al aprobar o, si no se indica, lo pedido
        const v = Number(String(body.monto_aprobado ?? '').replace(',', '.'));
        montoAp = body.monto_aprobado === undefined || body.monto_aprobado === null || body.monto_aprobado === '' || !Number.isFinite(v)
          ? (s.monto === null ? null : Number(s.monto)) : Math.round(v * 100) / 100;
      }
      await client.query('UPDATE solicitudes SET estado = $2, respuesta = $3, monto_aprobado = $4, resuelto_por = $5, resuelto_en = now() WHERE id = $1',
        [id, aprobar ? 'APROBADA' : 'RECHAZADA', respuesta, montoAp, user.id]);
      // Licencia aprobada: se quitan de la programación los días en que no va a trabajar
      let quitados = 0;
      if (aprobar && s.tipo !== 'ADELANTO' && s.desde) {
        const { rows: q } = await client.query('DELETE FROM programacion WHERE usuario_id = $1 AND fecha BETWEEN $2 AND $3 RETURNING id', [s.usuario_id, s.desde, s.hasta || s.desde]);
        quitados = q.length;
      }
      return { ok: true, programacion_quitada: quitados };
    });
  });

  // Adjuntos (certificados): el empleado en sus solicitudes, quien gestiona en cualquiera
  route('POST', '/api/solicitudes/:id/archivos', async ({ user, body, params }) => {
    permitirAlguno(user, 'solicitudes', 'gestionarSolicitudes');
    const s = await cargar(toInt(params.id), user);
    if (s.estado === 'CANCELADA') fail(409, 'La solicitud está cancelada');
    const nombre = str(body.nombre, 200);
    if (!nombre) fail(400, 'Falta el archivo');
    const mime = MIMES[(nombre.split('.').pop() || '').toLowerCase()];
    if (!mime) fail(400, 'Formato no admitido: subí PDF o foto (JPG/PNG)');
    const data = Buffer.from(String(body.data || ''), 'base64');
    if (!data.length) fail(400, 'El archivo está vacío');
    if (data.length > MAX_ARCHIVO) fail(413, 'El archivo supera los 8 MB');
    const { rows } = await query(
      `INSERT INTO solicitud_archivos (solicitud_id, nombre_archivo, mime, tamano, contenido, subido_por) VALUES ($1,$2,$3,$4,decode($5,'base64'),$6) RETURNING id`,
      [s.id, nombre, mime, data.length, data.toString('base64'), user.id]);
    return { id: Number(rows[0].id) };
  });

  route('GET', '/api/solicitudes/:id/archivos/:aid', async ({ user, params }) => {
    permitirAlguno(user, 'solicitudes', 'gestionarSolicitudes');
    const s = await cargar(toInt(params.id), user);
    const { rows } = await query("SELECT nombre_archivo, mime, encode(contenido,'base64') AS b64 FROM solicitud_archivos WHERE id = $1 AND solicitud_id = $2",
      [toInt(params.aid), s.id]);
    if (!rows[0]) fail(404, 'Archivo inexistente');
    return { __raw: { body: Buffer.from(rows[0].b64, 'base64'), headers: {
      'Content-Type': rows[0].mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].nombre_archivo)}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } } };
  });

  // Ausencias aprobadas próximas (para quien gestiona)
  route('GET', '/api/solicitudes-ausencias', async ({ user }) => {
    permitir(user, 'gestionarSolicitudes');
    const { rows } = await query(
      `SELECT s.id, s.tipo, s.desde, s.hasta, s.dias, u.nombre AS empleado FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.estado = 'APROBADA' AND s.tipo <> 'ADELANTO' AND s.hasta >= CURRENT_DATE AND s.desde <= CURRENT_DATE + 60 ORDER BY s.desde`);
    return rows.map((r) => ({ ...normal(r), empleado: r.empleado }));
  });
};

module.exports.TIPOS = TIPOS;
