// Notificaciones push al celular: suscripciones por usuario, envíos manuales y programados por rol (días + hora).
const wp = require('./webpush');
const TZ = 'America/Argentina/Buenos_Aires';
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
let query = null, vapid = null;

async function claves() {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return (vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY });
  const { rows } = await query("SELECT valor FROM app_config WHERE clave = 'vapid'");
  if (rows[0]) return (vapid = JSON.parse(rows[0].valor));
  const nuevas = wp.generarClavesVapid();
  await query("INSERT INTO app_config (clave, valor) VALUES ('vapid', $1) ON CONFLICT (clave) DO NOTHING", [JSON.stringify(nuevas)]);
  const { rows: r2 } = await query("SELECT valor FROM app_config WHERE clave = 'vapid'");
  return (vapid = JSON.parse(r2[0].valor));
}
const SUBJECT = () => process.env.VAPID_SUBJECT || 'mailto:admin@vinilo.app';

// Envía a una lista de usuarios; devuelve contadores
async function enviarAUsuarios(usuarioIds, datos) {
  const ids = [...new Set(usuarioIds.map(Number).filter(Number.isInteger))];
  if (!ids.length) return { usuarios: 0, dispositivos: 0, enviados: 0, fallidos: 0, sin_activar: 0 };
  const { rows: subs } = await query(`SELECT * FROM push_suscripciones WHERE usuario_id = ANY($1::int[])`, [`{${ids.join(',')}}`]);
  const k = await claves();
  let enviados = 0, fallidos = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await wp.enviar({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, datos, k, { subject: SUBJECT() });
      if (r.ok) { enviados++; await query('UPDATE push_suscripciones SET ultimo_ok = now(), fallos = 0 WHERE id = $1', [s.id]); }
      else {
        fallidos++;
        if (r.expirada) await query('DELETE FROM push_suscripciones WHERE id = $1', [s.id]);
        else await query('UPDATE push_suscripciones SET fallos = fallos + 1 WHERE id = $1', [s.id]);
        console.warn(`Push: falló el envío a la suscripción ${s.id} (${r.status}) ${r.detalle || ''}`);
      }
    } catch (e) { fallidos++; await query('UPDATE push_suscripciones SET fallos = fallos + 1 WHERE id = $1', [s.id]); console.warn('Push:', e.message); }
  }));
  const conSub = new Set(subs.map((s) => Number(s.usuario_id)));
  return { usuarios: ids.length, dispositivos: subs.length, enviados, fallidos, sin_activar: ids.filter((i) => !conSub.has(i)).length };
}

const rolesDe = (txt) => String(txt || '').split(',').map((x) => x.trim()).filter(Boolean);
async function usuariosDeRoles(roles) {
  const { rows } = roles.length
    ? await query(`SELECT id FROM usuarios WHERE activo AND rol = ANY($1::text[])`, [`{${roles.map((r) => `"${r.replace(/"/g, '')}"`).join(',')}}`])
    : await query(`SELECT id FROM usuarios WHERE activo AND rol <> 'PROVEEDOR'`);
  return rows.map((r) => Number(r.id));
}

async function enviarProgramada(p, origen, usuarioId = null) {
  const roles = rolesDe(p.roles);
  const datos = { title: p.titulo, body: p.mensaje, url: p.link || '/', tag: `vinilo-${p.id || 'manual'}` };
  const r = await enviarAUsuarios(await usuariosDeRoles(roles), datos);
  await query(`INSERT INTO push_envios (programada_id, origen, titulo, mensaje, roles, usuarios, dispositivos, enviados, fallidos, sin_activar, enviado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [p.id || null, origen, p.titulo, p.mensaje, p.roles || '', r.usuarios, r.dispositivos, r.enviados, r.fallidos, r.sin_activar, usuarioId]);
  return r;
}

// Revisa cada 30 s las notificaciones del día. Si el servidor estuvo dormido, envía las de los últimos 20 minutos.
async function revisarProgramadas() {
  const ahora = new Date();
  const hoy = ahora.toLocaleDateString('en-CA', { timeZone: TZ });
  const dow = new Date(hoy + 'T12:00:00Z').getUTCDay();
  const { rows } = await query(
    `UPDATE push_programadas p SET ultimo_envio = now()
     WHERE p.activo AND (',' || p.dias || ',') LIKE $1
       AND (($2 || ' ' || p.hora)::timestamp AT TIME ZONE '${TZ}') BETWEEN now() - interval '20 minutes' AND now()
       AND (p.ultimo_envio IS NULL OR p.ultimo_envio < (($2 || ' ' || p.hora)::timestamp AT TIME ZONE '${TZ}'))
     RETURNING p.*`, [`%,${dow},%`, hoy]);
  for (const p of rows) {
    try { const r = await enviarProgramada(p, 'PROGRAMADA'); console.log(`Push programada "${p.titulo}": ${r.enviados} enviadas, ${r.sin_activar} sin activar`); }
    catch (e) { console.warn('Push programada:', e.message); }
  }
}
function iniciarProgramador() {
  setTimeout(() => revisarProgramadas().catch((e) => console.warn('Push:', e.message)), 5000);
  setInterval(() => revisarProgramadas().catch((e) => console.warn('Push:', e.message)), 30000);
}

const prog = (r) => ({ id: Number(r.id), titulo: r.titulo, mensaje: r.mensaje, link: r.link, roles: rolesDe(r.roles), dias: String(r.dias).split(',').map(Number),
  hora: r.hora, activo: r.activo === true || r.activo === 't', ultimo_envio: r.ultimo_envio, creado_en: r.creado_en });

function registrar({ route, fail, permitir, str, toInt }) {
  route('GET', '/api/push/clave', async () => ({ publicKey: (await claves()).publicKey }));
  route('POST', '/api/push/suscribir', async ({ user, body, req }) => {
    const ep = String(body.endpoint || ''), k = body.keys || {};
    if (!(/^https:\/\//.test(ep) || (process.env.PUSH_TEST === '1' && /^http:\/\/localhost/.test(ep))) || !k.p256dh || !k.auth) fail(400, 'Suscripción inválida');
    await query(`INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth, dispositivo) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (endpoint) DO UPDATE SET usuario_id = EXCLUDED.usuario_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, dispositivo = EXCLUDED.dispositivo, fallos = 0`,
      [user.id, ep, str(k.p256dh, 200), str(k.auth, 100), str(body.dispositivo || (req && req.headers['user-agent']), 200)]);
    return { ok: true };
  });
  route('POST', '/api/push/desuscribir', async ({ user, body }) => {
    await query('DELETE FROM push_suscripciones WHERE endpoint = $1 AND usuario_id = $2', [String(body.endpoint || ''), user.id]);
    return { ok: true };
  });
  route('POST', '/api/push/prueba', async ({ user }) => {
    const r = await enviarAUsuarios([user.id], { title: '🔔 Vinilo', body: `¡Listo, ${user.nombre.split(' ')[0]}! Las notificaciones están funcionando.`, url: '/' });
    await query(`INSERT INTO push_envios (origen, titulo, mensaje, usuarios, dispositivos, enviados, fallidos, sin_activar, enviado_por) VALUES ('PRUEBA','Prueba',$1,1,$2,$3,$4,$5,$6)`,
      [user.nombre, r.dispositivos, r.enviados, r.fallidos, r.sin_activar, user.id]);
    if (!r.dispositivos) fail(400, 'Este usuario no tiene las notificaciones activadas en ningún dispositivo');
    return r;
  });

  // ---- Programadas (permiso notificaciones) ----
  const validar = (body) => {
    const titulo = str(body.titulo, 80), mensaje = str(body.mensaje, 300);
    if (!titulo) fail(400, 'Poné un título'); if (!mensaje) fail(400, 'Escribí el mensaje');
    const dias = [...new Set((Array.isArray(body.dias) ? body.dias : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    if (!dias.length) fail(400, 'Elegí al menos un día');
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(body.hora || ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) fail(400, 'Hora inválida');
    const roles = (Array.isArray(body.roles) ? body.roles : []).map((r) => String(r).trim()).filter(Boolean);
    const link = str(body.link, 120);
    if (link && !/^(#\/|\/)/.test(link)) fail(400, 'El link tiene que ser una pantalla de la app (empieza con #/)');
    return [titulo, mensaje, link, roles.join(','), dias.join(','), `${m[1].padStart(2, '0')}:${m[2]}`, body.activo === undefined ? true : !!body.activo];
  };
  route('GET', '/api/push/programadas', async ({ user }) => {
    permitir(user, 'notificaciones');
    const { rows } = await query('SELECT * FROM push_programadas ORDER BY activo DESC, hora, id');
    const { rows: env } = await query(`SELECT e.*, u.nombre AS enviado_por_nombre FROM push_envios e LEFT JOIN usuarios u ON u.id = e.enviado_por ORDER BY e.id DESC LIMIT 40`);
    const { rows: subs } = await query(
      `SELECT u.rol, count(DISTINCT u.id)::int AS usuarios, count(DISTINCT s.usuario_id)::int AS activados
       FROM usuarios u LEFT JOIN push_suscripciones s ON s.usuario_id = u.id WHERE u.activo AND u.rol <> 'PROVEEDOR' GROUP BY u.rol`);
    return { programadas: rows.map(prog), envios: env.map((e) => ({ ...e, id: Number(e.id) })), por_rol: subs.map((s) => ({ rol: s.rol, usuarios: Number(s.usuarios), activados: Number(s.activados) })) };
  });
  route('POST', '/api/push/programadas', async ({ user, body }) => {
    permitir(user, 'notificaciones');
    const v = validar(body);
    const { rows } = await query('INSERT INTO push_programadas (titulo, mensaje, link, roles, dias, hora, activo, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [...v, user.id]);
    return { id: Number(rows[0].id) };
  });
  route('PUT', '/api/push/programadas/:id', async ({ user, body, params }) => {
    permitir(user, 'notificaciones');
    const v = validar(body);
    const { rows } = await query('UPDATE push_programadas SET titulo=$2, mensaje=$3, link=$4, roles=$5, dias=$6, hora=$7, activo=$8 WHERE id=$1 RETURNING id', [toInt(params.id), ...v]);
    if (!rows.length) fail(404, 'Notificación inexistente');
    return { ok: true };
  });
  route('DELETE', '/api/push/programadas/:id', async ({ user, params }) => {
    permitir(user, 'notificaciones');
    await query('DELETE FROM push_programadas WHERE id = $1', [toInt(params.id)]);
    return { ok: true };
  });
  route('POST', '/api/push/programadas/:id/enviar', async ({ user, params }) => {
    permitir(user, 'notificaciones');
    const { rows } = await query('SELECT * FROM push_programadas WHERE id = $1', [toInt(params.id)]);
    if (!rows[0]) fail(404, 'Notificación inexistente');
    return enviarProgramada(rows[0], 'MANUAL', user.id);
  });
  // Envío inmediato sin guardar
  route('POST', '/api/push/enviar', async ({ user, body }) => {
    permitir(user, 'notificaciones');
    const titulo = str(body.titulo, 80), mensaje = str(body.mensaje, 300);
    if (!titulo || !mensaje) fail(400, 'Completá título y mensaje');
    const roles = (Array.isArray(body.roles) ? body.roles : []).join(',');
    return enviarProgramada({ id: null, titulo, mensaje, link: str(body.link, 120), roles }, 'MANUAL', user.id);
  });
}

module.exports = { init: (d) => { query = d.query; }, registrar, iniciarProgramador, revisarProgramadas, enviarAUsuarios, DIAS };
