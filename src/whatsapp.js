// Avisos por WhatsApp con la WhatsApp Cloud API de Meta (mensajes de plantilla aprobada).
// Configuración (Render → Environment): WHATSAPP_TOKEN, WHATSAPP_PHONE_ID; opcionales WHATSAPP_LANG (es_AR),
// WHATSAPP_API_VERSION (v26.0), WHATSAPP_API_URL (para pruebas) y APP_URL (link a la app en los mensajes).
const TZ = 'America/Argentina/Buenos_Aires';
const TOKEN = () => process.env.WHATSAPP_TOKEN || '';
const PHONE_ID = () => process.env.WHATSAPP_PHONE_ID || '';
const LANG = () => process.env.WHATSAPP_LANG || 'es_AR';
const API = () => (process.env.WHATSAPP_API_URL || `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v26.0'}`).replace(/\/$/, '');
const APP_URL = () => (process.env.APP_URL || 'https://vinilo-almacen.onrender.com').replace(/\/$/, '');
const configurado = () => !!(TOKEN() && PHONE_ID());

// Plantillas a crear en WhatsApp Manager (categoría Utilidad, idioma español de Argentina)
const PLANTILLAS = {
  solicitud_nueva: {
    nombre: 'vinilo_solicitud_nueva', para: 'Quien aprueba solicitudes del personal',
    texto: 'Hola {{1}}, {{2}} pidió {{3}}: {{4}}.\n\nPodés revisarla y responderla en la app de Vinilo: {{5}}',
    ejemplo: ['Mariano', 'Juan Pérez', 'vacaciones', 'del 11/01 al 24/01 (14 días)', 'https://vinilo-almacen.onrender.com/#/solicitudes'],
  },
  solicitud_resuelta: {
    nombre: 'vinilo_solicitud_resuelta', para: 'El empleado que pidió',
    texto: 'Hola {{1}}, tu solicitud de {{2}} ({{3}}) fue {{4}}.\n\nComentario: {{5}}\n\nMás detalles en la app de Vinilo: {{6}}',
    ejemplo: ['Juan', 'vacaciones', 'del 11/01 al 24/01', 'APROBADA', '¡Que las disfrutes!', 'https://vinilo-almacen.onrender.com/#/mis-solicitudes'],
  },
  pedido_proveedor: {
    nombre: 'vinilo_pedido_proveedor', para: 'El proveedor (teléfono del proveedor y usuarios de su portal)',
    texto: 'Hola {{1}}, Vinilo te envió el pedido N° {{2}} para entregar en {{3}}.\n\nFecha de entrega: {{4}}\nProductos: {{5}}\n\nVer el detalle y subir el remito o la factura: {{6}}',
    ejemplo: ['Distribuidora Sur', '125', 'CENTRAL', '28/11/2026', '3 productos (Coca Cola 2,25 L x 24, …)', 'https://vinilo-almacen.onrender.com/#/compras'],
  },
};

let query = null;
const init = (deps) => { query = deps.query; };

// Celular argentino → formato internacional de WhatsApp (549 + área + número, sin 0 ni 15)
function normTel(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('549') && d.length === 13) return d;
  if (d.startsWith('54') && d.length === 12) return '549' + d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === 12 && /^\d{2,4}15/.test(d)) { // 0236 15 4123456 → quitar el 15 después del código de área
    for (const n of [2, 3, 4]) if (d.slice(n, n + 2) === '15' && d.length - 2 === 10) return '549' + d.slice(0, n) + d.slice(n + 2);
  }
  if (d.length === 10) return '549' + d;
  if (d.length >= 11 && d.length <= 15 && !d.startsWith('54')) return d; // número de otro país ya con su código
  return null;
}
// Los parámetros no admiten saltos de línea, tabs ni más de 4 espacios seguidos, ni estar vacíos
const limpio = (s, max = 300) => {
  const v = String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return (v.length > max ? v.slice(0, max - 1) + '…' : v) || '—';
};
const render = (texto, params) => texto.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');

async function llamarApi(telefono, plantilla, params, idioma) {
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: telefono, type: 'template',
    template: { name: plantilla, language: { code: idioma } } };
  if (params && params.length) body.template.components = [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }];
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${API()}/${PHONE_ID()}/messages`, {
      method: 'POST', signal: ctrl.signal, headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const e = j.error || {};
      throw new Error(`${e.message || 'HTTP ' + r.status}${e.code ? ` (código ${e.code})` : ''}${e.error_data && e.error_data.details ? ': ' + e.error_data.details : ''}`);
    }
    return (j.messages && j.messages[0] && j.messages[0].id) || null;
  } finally { clearTimeout(to); }
}

// Envía (en segundo plano) una notificación ya registrada
async function procesar(id) {
  const { rows } = await query('SELECT * FROM notificaciones WHERE id = $1', [id]);
  const n = rows[0];
  if (!n || n.estado === 'ENVIADA') return n;
  if (!configurado()) {
    await query("UPDATE notificaciones SET estado = 'OMITIDA', detalle = 'WhatsApp no configurado (faltan WHATSAPP_TOKEN y WHATSAPP_PHONE_ID)' WHERE id = $1", [id]);
    return null;
  }
  try {
    const params = n.parametros ? JSON.parse(n.parametros) : [];
    const idioma = n.plantilla === 'hello_world' ? 'en_US' : LANG();
    const mid = await llamarApi(n.telefono, n.plantilla, params, idioma);
    await query("UPDATE notificaciones SET estado = 'ENVIADA', mensaje_id = $2, detalle = NULL, intentos = intentos + 1, enviado_en = now() WHERE id = $1", [id, mid]);
  } catch (e) {
    await query("UPDATE notificaciones SET estado = 'ERROR', detalle = $2, intentos = intentos + 1 WHERE id = $1", [id, String(e.message).slice(0, 500)]);
    console.warn(`WhatsApp: no se pudo enviar el aviso #${id}: ${e.message}`);
  }
  const { rows: r2 } = await query('SELECT * FROM notificaciones WHERE id = $1', [id]);
  return r2[0];
}

// Registra y envía a varios destinatarios: [{ nombre, telefono, usuario_id?, proveedor_id?, params }]
async function avisar(evento, clave, referencia, destinos) {
  if (!query) return;
  const pl = PLANTILLAS[clave];
  const vistos = new Set();
  for (const d of destinos) {
    const tel = normTel(d.telefono);
    if (tel && vistos.has(tel)) continue;
    if (tel) vistos.add(tel);
    const params = d.params.map((p) => limpio(p));
    const { rows } = await query(
      `INSERT INTO notificaciones (evento, referencia, usuario_id, proveedor_id, destinatario, telefono, plantilla, parametros, texto, estado, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [evento, referencia, d.usuario_id || null, d.proveedor_id || null, d.nombre, tel || String(d.telefono || '').slice(0, 30) || null, pl.nombre,
        JSON.stringify(params), render(pl.texto, params), tel ? 'PENDIENTE' : 'OMITIDA', tel ? null : 'Teléfono inválido o vacío']);
    if (tel) procesar(Number(rows[0].id)).catch((e) => console.warn('WhatsApp:', e.message));
  }
}
const seguro = (fn) => (...a) => { Promise.resolve().then(() => fn(...a)).catch((e) => console.warn('WhatsApp (aviso):', e.message)); };

const fmtD = (f) => (f ? String(f).slice(0, 10).split('-').reverse().join('/') : '');
const primerNombre = (n) => String(n || '').trim().split(/\s+/)[0] || 'Hola';
const periodo = (s) => (s.tipo === 'ADELANTO'
  ? (s.monto === null || s.monto === undefined ? 'adelanto de sueldo, monto a definir' : `adelanto de sueldo por $ ${Number(s.monto).toLocaleString('es-AR')}`)
  : `del ${fmtD(s.desde).slice(0, 5)} al ${fmtD(s.hasta || s.desde).slice(0, 5)} (${s.dias} ${Number(s.dias) === 1 ? 'día' : 'días'})`);

const montoTxt = (m) => (m === null || m === undefined ? 'monto a definir' : `$ ${Number(m).toLocaleString('es-AR')}`);

// ---- Eventos ----
const solicitudNueva = seguro(async (solId) => {
  const { TIPOS } = require('./personal');
  const { rows } = await query('SELECT s.*, u.nombre AS empleado FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.id = $1', [solId]);
  const s = rows[0]; if (!s) return;
  const { rows: gest } = await query(
    `SELECT u.id, u.nombre, u.telefono FROM usuarios u LEFT JOIN roles r ON r.codigo = u.rol
     WHERE u.activo AND u.whatsapp_ok AND coalesce(u.telefono, '') <> '' AND u.id <> $1
       AND (u.rol = 'ADMIN' OR (',' || coalesce(r.permisos, '') || ',') LIKE '%,gestionarSolicitudes,%')`, [s.usuario_id]);
  const tipo = ((TIPOS[s.tipo] || {}).nombre || s.tipo).toLowerCase();
  await avisar('SOLICITUD_NUEVA', 'solicitud_nueva', `solicitud:${solId}`, gest.map((g) => ({
    nombre: g.nombre, telefono: g.telefono, usuario_id: g.id,
    params: [primerNombre(g.nombre), s.empleado, tipo, s.tipo === 'ADELANTO' ? `${montoTxt(s.monto)}${s.motivo ? ` – motivo: ${s.motivo}` : ''}` : periodo(s), `${APP_URL()}/#/solicitudes`] })));
});

const solicitudResuelta = seguro(async (solId) => {
  const { TIPOS } = require('./personal');
  const { rows } = await query('SELECT s.*, u.nombre AS empleado, u.telefono, u.whatsapp_ok, u.activo FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.id = $1', [solId]);
  const s = rows[0]; if (!s || !s.telefono || s.whatsapp_ok === false || s.whatsapp_ok === 'f') return;
  const tipo = ((TIPOS[s.tipo] || {}).nombre || s.tipo).toLowerCase();
  const detalle = s.tipo === 'ADELANTO' ? montoTxt(s.estado === 'APROBADA' && s.monto_aprobado !== null && s.monto_aprobado !== undefined ? s.monto_aprobado : s.monto)
    : `del ${fmtD(s.desde).slice(0, 5)} al ${fmtD(s.hasta || s.desde).slice(0, 5)}`;
  await avisar('SOLICITUD_RESUELTA', 'solicitud_resuelta', `solicitud:${solId}`, [{
    nombre: s.empleado, telefono: s.telefono, usuario_id: Number(s.usuario_id),
    params: [primerNombre(s.empleado), tipo, detalle, s.estado === 'APROBADA' ? 'APROBADA' : 'RECHAZADA', s.respuesta || 'sin comentarios', `${APP_URL()}/#/mis-solicitudes`] }]);
});

const pedidoConfirmado = seguro(async (ocId) => {
  const { rows } = await query(
    `SELECT oc.*, p.nombre AS proveedor, p.telefono AS prov_tel, p.whatsapp_ok AS prov_ok, a.nombre AS almacen
     FROM ordenes_compra oc JOIN proveedores p ON p.id = oc.proveedor_id JOIN almacenes a ON a.id = oc.almacen_id WHERE oc.id = $1`, [ocId]);
  const oc = rows[0]; if (!oc) return;
  const { rows: it } = await query('SELECT pr.nombre, i.cantidad FROM oc_items i JOIN productos pr ON pr.id = i.producto_id WHERE i.oc_id = $1 ORDER BY pr.nombre', [ocId]);
  const resumen = `${it.length} ${it.length === 1 ? 'producto' : 'productos'} (${it.slice(0, 4).map((x) => `${x.nombre} x ${x.cantidad}`).join(', ')}${it.length > 4 ? ', …' : ''})`;
  const destinos = [];
  if (oc.prov_tel && oc.prov_ok !== false && oc.prov_ok !== 'f') destinos.push({ nombre: oc.proveedor, telefono: oc.prov_tel, proveedor_id: Number(oc.proveedor_id) });
  const { rows: us } = await query("SELECT id, nombre, telefono FROM usuarios WHERE rol = 'PROVEEDOR' AND proveedor_id = $1 AND activo AND whatsapp_ok AND coalesce(telefono, '') <> ''", [oc.proveedor_id]);
  us.forEach((u) => destinos.push({ nombre: u.nombre, telefono: u.telefono, usuario_id: Number(u.id), proveedor_id: Number(oc.proveedor_id) }));
  await avisar('PEDIDO_CONFIRMADO', 'pedido_proveedor', `oc:${ocId}`, destinos.map((d) => ({ ...d,
    params: [d.usuario_id ? primerNombre(d.nombre) : oc.proveedor, String(ocId), oc.almacen, oc.fecha_entrega ? fmtD(oc.fecha_entrega) : 'a coordinar', resumen, `${APP_URL()}/#/compras`] })));
});

// ---- Rutas ----
function registrar({ route, fail, permitir, isTrue, toInt, str }) {
  route('GET', '/api/whatsapp', async ({ user, url }) => {
    permitir(user, 'usuarios');
    const est = url.searchParams.get('estado');
    const { rows } = await query(
      `SELECT n.id, n.evento, n.referencia, n.destinatario, n.telefono, n.plantilla, n.texto, n.estado, n.detalle, n.intentos, n.creado_en, n.enviado_en
       FROM notificaciones n ${est ? 'WHERE n.estado = $1' : ''} ORDER BY n.id DESC LIMIT 150`, est ? [est] : []);
    const { rows: c } = await query("SELECT estado, count(*)::int AS n FROM notificaciones WHERE creado_en > now() - interval '30 days' GROUP BY estado");
    const { rows: sinTel } = await query(
      `SELECT count(*)::int AS n FROM usuarios WHERE activo AND rol <> 'PROVEEDOR' AND coalesce(telefono, '') = ''`);
    return {
      configurado: configurado(), phone_id: PHONE_ID() ? '…' + PHONE_ID().slice(-4) : null, idioma: LANG(), app_url: APP_URL(),
      plantillas: Object.values(PLANTILLAS).map((p) => ({ nombre: p.nombre, para: p.para, texto: p.texto, ejemplo: p.ejemplo, ejemplo_texto: render(p.texto, p.ejemplo) })),
      contadores: Object.fromEntries(c.map((x) => [x.estado, Number(x.n)])), usuarios_sin_telefono: Number(sinTel[0].n),
      notificaciones: rows.map((r) => ({ ...r, id: Number(r.id), intentos: Number(r.intentos) })),
    };
  });

  // Prueba de conexión con la plantilla hello_world (viene creada en toda cuenta nueva, en inglés)
  route('POST', '/api/whatsapp/prueba', async ({ user, body }) => {
    permitir(user, 'usuarios');
    if (!configurado()) fail(400, 'WhatsApp no está configurado: cargá WHATSAPP_TOKEN y WHATSAPP_PHONE_ID en Render.');
    const tel = normTel(body.telefono);
    if (!tel) fail(400, 'Teléfono inválido. Escribilo con código de área, sin 0 ni 15 (ej.: 236 4123456).');
    const plantilla = body.plantilla && PLANTILLAS[body.plantilla] ? PLANTILLAS[body.plantilla] : null;
    const params = plantilla ? plantilla.ejemplo.map((p) => limpio(p)) : [];
    const { rows } = await query(
      `INSERT INTO notificaciones (evento, destinatario, telefono, plantilla, parametros, texto, usuario_id) VALUES ('PRUEBA', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [user.nombre, tel, plantilla ? plantilla.nombre : 'hello_world', JSON.stringify(params), plantilla ? render(plantilla.texto, params) : 'Hello World (plantilla de prueba de Meta)', user.id]);
    const n = await procesar(Number(rows[0].id));
    if (!n || n.estado !== 'ENVIADA') fail(502, `No se pudo enviar: ${(n && n.detalle) || 'error desconocido'}`);
    return { ok: true, telefono: tel };
  });

  route('POST', '/api/whatsapp/:id/reintentar', async ({ user, params }) => {
    permitir(user, 'usuarios');
    const id = toInt(params.id);
    const { rows } = await query("UPDATE notificaciones SET estado = 'PENDIENTE' WHERE id = $1 AND estado IN ('ERROR','OMITIDA') AND telefono ~ '^[0-9]{10,15}$' RETURNING id", [id]);
    if (!rows.length) fail(409, 'Ese aviso no se puede reintentar (ya se envió o no tiene un teléfono válido)');
    const n = await procesar(id);
    return { estado: n ? n.estado : 'OMITIDA', detalle: n ? n.detalle : null };
  });

  // El propio usuario carga su celular y si quiere avisos
  route('PUT', '/api/me/whatsapp', async ({ user, body }) => {
    const t = str(body.telefono, 30);
    if (t && !normTel(t)) fail(400, 'Celular inválido. Escribilo con código de área, sin 0 ni 15 (ej.: 236 4123456).');
    await query('UPDATE usuarios SET telefono = $2, whatsapp_ok = $3 WHERE id = $1', [user.id, t, body.whatsapp_ok === undefined ? true : !!body.whatsapp_ok]);
    return { ok: true, telefono: t ? normTel(t) : null };
  });
  route('GET', '/api/me/whatsapp', async ({ user }) => {
    const { rows } = await query('SELECT telefono, whatsapp_ok FROM usuarios WHERE id = $1', [user.id]);
    return { telefono: rows[0].telefono, whatsapp_ok: isTrue(rows[0].whatsapp_ok), configurado: configurado() };
  });
}

module.exports = { init, registrar, normTel, configurado, solicitudNueva, solicitudResuelta, pedidoConfirmado, PLANTILLAS };
