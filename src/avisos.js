// Avisos del administrador en el Panel: aparecen arriba de todo para los usuarios elegidos hasta que los marcan como leídos.
const push = require('./push');
const TIPOS = ['INFO', 'IMPORTANTE', 'URGENTE'];
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const si = (v) => v === true || v === 't' || v === 'true' || v === 1;
const vigente = (a, ahora = new Date()) => si(a.activo) && new Date(a.desde) <= ahora && (!a.hasta || new Date(a.hasta) > ahora);

module.exports = function registrarAvisos({ route, query, fail, permitir }) {
  // Usuarios activos (sin proveedores) con sus sucursales
  async function usuarios() {
    const { rows } = await query(`SELECT u.id, u.nombre, u.username, u.rol, u.activo,
        COALESCE((SELECT string_agg(us.sucursal_id::text, ',') FROM usuario_sucursales us WHERE us.usuario_id = u.id), '') AS sucs
      FROM usuarios u WHERE u.activo AND u.rol <> 'PROVEEDOR' ORDER BY u.nombre`);
    return rows.map((u) => ({ ...u, id: Number(u.id), sucs: csv(u.sucs) }));
  }
  const corresponde = (a, u) => {
    const rs = csv(a.roles), ss = csv(a.sucursales);
    return (!rs.length || rs.includes(u.rol)) && (!ss.length || u.sucs.some((s) => ss.includes(s)));
  };
  const leerBody = (body) => {
    const titulo = String((body && body.titulo) || '').trim().slice(0, 120), mensaje = String((body && body.mensaje) || '').trim().slice(0, 2000);
    if (!titulo) fail(400, 'Poné un título'); if (!mensaje) fail(400, 'Escribí el mensaje');
    const tipo = TIPOS.includes(body.tipo) ? body.tipo : 'INFO';
    const roles = (Array.isArray(body.roles) ? body.roles : []).map(String).filter((x) => /^[A-Z0-9_]{1,40}$/.test(x)).join(',');
    const sucursales = (Array.isArray(body.sucursales) ? body.sucursales : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).join(',');
    let hasta = null;
    if (body.hasta) { const d = String(body.hasta); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(400, 'Fecha de vencimiento inválida'); hasta = `${d}T23:59:59-03:00`; if (new Date(hasta) < new Date()) fail(400, 'La fecha de vencimiento ya pasó'); }
    return { titulo, mensaje, tipo, roles, sucursales, hasta, push: !!body.push };
  };
  async function enviarPush(a, usuarioId) {
    const us = (await usuarios()).filter((u) => corresponde(a, u));
    const icono = a.tipo === 'URGENTE' ? '🚨 ' : a.tipo === 'IMPORTANTE' ? '⚠️ ' : '📢 ';
    const r = await push.enviarAUsuarios(us.map((u) => u.id), { title: icono + a.titulo, body: a.mensaje.slice(0, 180), url: '/#/panel', tag: `vinilo-aviso-${a.id}` });
    await query(`INSERT INTO push_envios (programada_id, origen, titulo, mensaje, roles, usuarios, dispositivos, enviados, fallidos, sin_activar, enviado_por)
      VALUES (NULL,'MANUAL',$1,$2,$3,$4,$5,$6,$7,$8,$9)`, [a.titulo, a.mensaje.slice(0, 300), a.roles || '', r.usuarios, r.dispositivos, r.enviados, r.fallidos, r.sin_activar, usuarioId]).catch(() => {});
    return r;
  }

  // ---- Para cada usuario: sus avisos vigentes ----
  route('GET', '/api/avisos/mios', async ({ user }) => {
    const { rows } = await query(`SELECT a.*, u.nombre AS autor, l.leido_en FROM avisos a LEFT JOIN usuarios u ON u.id = a.creado_por
      LEFT JOIN avisos_leidos l ON l.aviso_id = a.id AND l.usuario_id = $1 ORDER BY a.creado_en DESC`, [user.id]);
    const yo = (await usuarios()).find((u) => u.id === user.id) || { id: user.id, rol: user.rol, sucs: [] };
    const orden = { URGENTE: 0, IMPORTANTE: 1, INFO: 2 };
    return rows.filter((a) => vigente(a) && (corresponde(a, yo) || Number(a.creado_por) === user.id))
      .map((a) => ({ id: Number(a.id), titulo: a.titulo, mensaje: a.mensaje, tipo: a.tipo, autor: a.autor, creado_en: a.creado_en, hasta: a.hasta, leido: !!a.leido_en }))
      .sort((x, y) => (x.leido - y.leido) || (orden[x.tipo] - orden[y.tipo]) || String(y.creado_en).localeCompare(String(x.creado_en)));
  });
  route('POST', '/api/avisos/:id/leido', async ({ user, params }) => {
    await query('INSERT INTO avisos_leidos (aviso_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [Number(params.id), user.id]);
    return { ok: true };
  });

  // ---- Administración ----
  route('GET', '/api/avisos', async ({ user }) => {
    permitir(user, 'avisos');
    const [{ rows }, { rows: leidos }, us] = await Promise.all([
      query('SELECT a.*, u.nombre AS autor FROM avisos a LEFT JOIN usuarios u ON u.id = a.creado_por ORDER BY a.creado_en DESC LIMIT 100'),
      query('SELECT aviso_id, usuario_id FROM avisos_leidos'), usuarios()]);
    return rows.map((a) => {
      const dest = us.filter((u) => corresponde(a, u)); const ids = new Set(dest.map((u) => u.id));
      const leyeron = leidos.filter((l) => Number(l.aviso_id) === Number(a.id) && ids.has(Number(l.usuario_id))).length;
      return { ...a, activo: si(a.activo), push: si(a.push), id: Number(a.id), roles: csv(a.roles), sucursales: csv(a.sucursales).map(Number), vigente: vigente(a), destinatarios: dest.length, leyeron };
    });
  });
  route('GET', '/api/avisos/:id/lecturas', async ({ user, params }) => {
    permitir(user, 'avisos');
    const a = (await query('SELECT * FROM avisos WHERE id = $1', [Number(params.id)])).rows[0]; if (!a) fail(404, 'Aviso inexistente');
    const { rows } = await query('SELECT usuario_id, leido_en FROM avisos_leidos WHERE aviso_id = $1', [a.id]);
    const lm = new Map(rows.map((r) => [Number(r.usuario_id), r.leido_en]));
    return (await usuarios()).filter((u) => corresponde(a, u)).map((u) => ({ id: u.id, nombre: u.nombre, rol: u.rol, leido_en: lm.get(u.id) || null }))
      .sort((x, y) => (!!y.leido_en - !!x.leido_en) || x.nombre.localeCompare(y.nombre));
  });
  route('POST', '/api/avisos', async ({ user, body }) => {
    permitir(user, 'avisos');
    const v = leerBody(body || {});
    const a = (await query(`INSERT INTO avisos (titulo, mensaje, tipo, roles, sucursales, hasta, push, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [v.titulo, v.mensaje, v.tipo, v.roles, v.sucursales, v.hasta, v.push, user.id])).rows[0];
    await query('INSERT INTO avisos_leidos (aviso_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a.id, user.id]); // quien lo publica ya lo leyó
    let envio = null; if (v.push) envio = await enviarPush(a, user.id).catch((e) => ({ error: e.message }));
    return { ok: true, id: Number(a.id), push: envio };
  });
  route('PUT', '/api/avisos/:id', async ({ user, params, body }) => {
    permitir(user, 'avisos');
    const id = Number(params.id);
    if (body && Object.keys(body).length === 1 && 'activo' in body) { await query('UPDATE avisos SET activo = $2 WHERE id = $1', [id, !!body.activo]); return { ok: true }; }
    const v = leerBody(body || {});
    const r = await query('UPDATE avisos SET titulo=$2, mensaje=$3, tipo=$4, roles=$5, sucursales=$6, hasta=$7 WHERE id=$1 RETURNING id', [id, v.titulo, v.mensaje, v.tipo, v.roles, v.sucursales, v.hasta]);
    if (!r.rows.length) fail(404, 'Aviso inexistente');
    if (body.volver_a_mostrar) await query('DELETE FROM avisos_leidos WHERE aviso_id = $1 AND usuario_id <> $2', [id, user.id]);
    return { ok: true };
  });
  route('POST', '/api/avisos/:id/push', async ({ user, params }) => {
    permitir(user, 'avisos');
    const a = (await query('SELECT * FROM avisos WHERE id = $1', [Number(params.id)])).rows[0]; if (!a) fail(404, 'Aviso inexistente');
    return enviarPush(a, user.id);
  });
  route('DELETE', '/api/avisos/:id', async ({ user, params }) => {
    permitir(user, 'avisos');
    await query('DELETE FROM avisos WHERE id = $1', [Number(params.id)]); return { ok: true };
  });
};
