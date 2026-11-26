// Juego QR "Pizzaiolo de la Noche": los comensales escanean el QR de la pantalla del bar y juegan en el celular con su nombre (sin usuario).
// El puntaje lo calcula el servidor; el ranking de la jornada se ve en VINILO APP (Juegos → Pizzaiolo de la Noche).
const crypto = require('crypto');
const qr = require('./qr');
const { inicioJornada } = require('./tablero');

const PREGUNTAS_BASE = [
  { p: '¿A qué temperatura trabaja un horno napoletano?', ok: '450 a 485 °C', mal: ['250 °C', '320 °C', '180 °C'] },
  { p: '¿Cuánto tarda en cocinarse una pizza napoletana?', ok: '60 a 90 segundos', mal: ['5 minutos', '12 minutos', '20 segundos'] },
  { p: '¿Cómo se llama el borde inflado de la napoletana?', ok: 'Cornicione', mal: ['Fugazza', 'Calzone', 'Focaccia'] },
  { p: '¿Qué lleva un Negroni?', ok: 'Gin, Campari y vermut rosso', mal: ['Ron, lima y menta', 'Fernet y cola', 'Aperol y prosecco'] },
  { p: '¿En qué ciudad nació la pizza Margherita?', ok: 'Nápoles', mal: ['Roma', 'Milán', 'Génova'] },
  { p: '¿Qué bebida es la base de un Aperol Spritz?', ok: 'Prosecco', mal: ['Cerveza', 'Tequila', 'Whisky'] },
  { p: '¿Con qué madera se suele alimentar un horno napoletano?', ok: 'Haya o roble, bien seca', mal: ['Pino con resina', 'Carbón de parrilla', 'Madera pintada'] },
  { p: '¿Qué queso lleva la Margherita tradicional?', ok: 'Mozzarella (fior di latte o de búfala)', mal: ['Roquefort', 'Cheddar', 'Parmesano solo'] },
];
const DEF = { activo: true, premio: 'El mejor de la noche gana un trago de la casa', preguntas: PREGUNTAS_BASE };
const DURACION_MIN = 30e3;    // una partida real dura más de ~45 s; menos de 30 s es trampa
const intentosIp = new Map(); // anti-spam simple en memoria

const limpiarNombre = (n) => String(n || '').replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const mezclar = (a) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60);
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/$/, '');
const puntosHorno = (p) => { const x = Number(p); if (!Number.isFinite(x) || x < 0) return 0; return x > 104 ? 0 : Math.max(0, Math.round(100 - Math.abs(x - 92) * 4.5)); };

module.exports = function registrarJuego({ route, query, fail, permitir }) {
  const config = async () => { const r = (await query("SELECT valor FROM app_config WHERE clave = 'juego_config'")).rows[0]; try { return { ...DEF, ...(r ? JSON.parse(r.valor) : {}) }; } catch (_) { return DEF; } };
  const sucursal = async (id) => (await query('SELECT id, nombre FROM sucursales WHERE id = $1 AND activo', [Number(id) || 0])).rows[0];
  async function ranking(sucId, fecha, limite = 10) {
    const { rows } = await query(`SELECT id, nombre, mesa, puntos, r1, r2, r3, terminado_en FROM juego_partidas WHERE sucursal_id = $1 AND jornada = $2 AND estado = 'TERMINADA'
      ORDER BY puntos DESC, terminado_en ASC LIMIT $3`, [sucId, fecha, limite]);
    return rows.map((r) => ({ ...r, id: Number(r.id), mesa: r.mesa == null ? null : Number(r.mesa), puntos: Number(r.puntos) }));
  }

  // ---------- Público (comensales, sin usuario) ----------
  route('GET', '/api/juego/info', async ({ url }) => {
    const s = await sucursal(url.searchParams.get('s')); if (!s) fail(404, 'No encontramos este local. Escaneá de nuevo el QR de la mesa.');
    const c = await config();
    return { sucursal: { id: Number(s.id), nombre: s.nombre }, activo: !!c.activo, premio: c.premio || '' };
  }, { auth: false });

  route('POST', '/api/juego/iniciar', async ({ req, body }) => {
    const c = await config(); if (!c.activo) fail(403, 'El juego no está disponible en este momento.');
    const s = await sucursal(body && body.s); if (!s) fail(404, 'Local inválido');
    const nombre = limpiarNombre(body.nombre); if (nombre.length < 2) fail(400, 'Poné tu nombre (al menos 2 letras)');
    const mesaOk = null; // un único QR para todo el local: sin número de mesa
    const ip = ipDe(req), ahora = Date.now(); const h = (intentosIp.get(ip) || []).filter((t) => ahora - t < 3600e3);
    if (h.length >= 25) fail(429, 'Jugaste muchas veces seguidas. Probá de nuevo en un rato.');
    h.push(ahora); intentosIp.set(ip, h);
    const pool = (Array.isArray(c.preguntas) && c.preguntas.length >= 4 ? c.preguntas : PREGUNTAS_BASE).filter((q) => q && q.p && q.ok && Array.isArray(q.mal) && q.mal.length >= 1);
    const elegidas = mezclar(pool).slice(0, 4).map((q) => { const ops = mezclar([q.ok, ...q.mal.slice(0, 3)]); return { texto: q.p, opciones: ops, ok: ops.indexOf(q.ok) }; });
    const token = crypto.randomBytes(18).toString('base64url');
    await query(`INSERT INTO juego_partidas (token, sucursal_id, mesa, nombre, jornada, preguntas, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [token, s.id, mesaOk, nombre, inicioJornada().fecha, JSON.stringify(elegidas.map((q) => q.ok)), ip]);
    return { token, preguntas: elegidas.map(({ texto, opciones }) => ({ texto, opciones })) };
  }, { auth: false });

  route('POST', '/api/juego/terminar', async ({ body }) => {
    const p = (await query("SELECT * FROM juego_partidas WHERE token = $1", [String((body && body.token) || '')])).rows[0];
    if (!p) fail(404, 'Partida inexistente'); if (p.estado !== 'JUGANDO') fail(409, 'Esta partida ya terminó');
    if (Date.now() - new Date(p.creado_en).getTime() < DURACION_MIN) fail(400, 'Partida inválida');
    // Ronda 1: punto de cocción de las 3 pizzas (0–112)
    const hornos = (Array.isArray(body.r1) ? body.r1 : []).slice(0, 3);
    const r1 = hornos.reduce((a, x) => a + puntosHorno(x), 0);
    // Ronda 2: ingredientes tocados (con topes de lo físicamente posible en 15 s)
    const buenos = Math.min(24, Math.max(0, Math.floor(Number(body.r2 && body.r2.buenos) || 0))), malos = Math.min(30, Math.max(0, Math.floor(Number(body.r2 && body.r2.malos) || 0)));
    const r2 = Math.max(0, buenos * 15 - malos * 20);
    // Ronda 3: trivia, la corrige el servidor
    let okIdx = []; try { okIdx = JSON.parse(p.preguntas); } catch (_) { okIdx = []; }
    const resp = Array.isArray(body.r3) ? body.r3.slice(0, okIdx.length) : [];
    const r3 = resp.reduce((a, x, i) => { if (!x || Number(x.op) !== okIdx[i]) return a; const ms = Math.min(10000, Math.max(600, Number(x.ms) || 10000)); return a + 50 + Math.round(((10000 - ms) / 1000) * 5); }, 0);
    const puntos = r1 + r2 + r3;
    await query("UPDATE juego_partidas SET estado = 'TERMINADA', r1 = $2, r2 = $3, r3 = $4, puntos = $5, terminado_en = now() WHERE id = $1", [p.id, r1, r2, r3, puntos]);
    const { rows } = await query("SELECT count(*)::int AS de, count(*) FILTER (WHERE puntos > $3)::int AS arriba FROM juego_partidas WHERE sucursal_id = $1 AND jornada = $2 AND estado = 'TERMINADA'", [p.sucursal_id, p.jornada, puntos]);
    return { puntos, r1, r2, r3, puesto: Number(rows[0].arriba) + 1, de: Number(rows[0].de), correctas: resp.filter((x, i) => x && Number(x.op) === okIdx[i]).length, ok: okIdx };
  }, { auth: false });

  route('GET', '/api/juego/top', async ({ url }) => {
    const s = await sucursal(url.searchParams.get('s')); if (!s) fail(404, 'Local inválido');
    return (await ranking(s.id, inicioJornada().fecha, 10)).map(({ nombre, mesa, puntos }) => ({ nombre, mesa, puntos }));
  }, { auth: false });

  // ---------- VINILO APP (permiso juegos) ----------
  route('GET', '/api/juego/tablero', async ({ user, url, req }) => {
    permitir(user, 'juegos');
    const s = await sucursal(url.searchParams.get('s')); if (!s) fail(404, 'Sucursal inválida');
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('fecha') || '') ? url.searchParams.get('fecha') : inicioJornada().fecha;
    const [top, est, c] = await Promise.all([ranking(s.id, fecha, 15),
      query(`SELECT count(*) FILTER (WHERE estado = 'TERMINADA')::int AS partidas, count(*) FILTER (WHERE estado = 'JUGANDO' AND creado_en > now() - interval '3 minutes')::int AS jugando,
        count(DISTINCT mesa) FILTER (WHERE estado = 'TERMINADA')::int AS mesas FROM juego_partidas WHERE sucursal_id = $1 AND jornada = $2`, [s.id, fecha]), config()]);
    const ult = (await query(`SELECT id, nombre, mesa, puntos, terminado_en FROM juego_partidas WHERE sucursal_id = $1 AND jornada = $2 AND estado = 'TERMINADA' ORDER BY terminado_en DESC LIMIT 1`, [s.id, fecha])).rows[0] || null;
    const link = `${baseUrl(req)}/jugar?s=${s.id}`;
    return { sucursal: { id: Number(s.id), nombre: s.nombre }, fecha, top, ultimo: ult ? { ...ult, id: Number(ult.id), puntos: Number(ult.puntos) } : null,
      ...est.rows[0], activo: !!c.activo, premio: c.premio, link, qr: qr.svg(link, { color: '#1a1010' }) };
  });
  // Reiniciar: archiva las partidas terminadas de la jornada (el ranking vuelve a cero; las que están en juego siguen y entran al nuevo)
  route('POST', '/api/juego/reiniciar', async ({ user, body }) => {
    permitir(user, 'juegosControl');
    const s = await sucursal(body && body.s); if (!s) fail(404, 'Sucursal inválida');
    const r = await query("UPDATE juego_partidas SET estado = 'REINICIADA' WHERE sucursal_id = $1 AND jornada = $2 AND estado = 'TERMINADA' RETURNING id", [s.id, inicioJornada().fecha]);
    console.log(`Pizzaiolo: ${user.nombre} reinició el ranking de ${s.nombre} (${r.rows.length} partidas archivadas)`);
    return { ok: true, archivadas: r.rows.length };
  });
  route('GET', '/api/juego/config', async ({ user }) => { permitir(user, 'juegos'); return config(); });
  route('PUT', '/api/juego/config', async ({ user, body }) => {
    if (user.rol !== 'ADMIN') fail(403, 'Solo el administrador configura el juego');
    const pregs = (Array.isArray(body.preguntas) ? body.preguntas : []).map((q) => ({ p: String(q.p || '').trim().slice(0, 140), ok: String(q.ok || '').trim().slice(0, 60),
      mal: (Array.isArray(q.mal) ? q.mal : []).map((x) => String(x || '').trim().slice(0, 60)).filter(Boolean).slice(0, 3) })).filter((q) => q.p && q.ok && q.mal.length);
    if (pregs.length < 4) fail(400, 'Cargá al menos 4 preguntas completas (pregunta, respuesta correcta y al menos una incorrecta)');
    const c = { activo: !!body.activo, premio: String(body.premio || '').trim().slice(0, 120), preguntas: pregs.slice(0, 40) };
    await query("INSERT INTO app_config (clave, valor) VALUES ('juego_config', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor", [JSON.stringify(c)]);
    return c;
  });
  route('DELETE', '/api/juego/partidas/:id', async ({ user, params }) => {
    if (user.rol !== 'ADMIN') fail(403, 'Solo el administrador puede borrar partidas');
    await query('DELETE FROM juego_partidas WHERE id = $1', [Number(params.id)]); return { ok: true };
  });
};
module.exports.puntosHorno = puntosHorno;
