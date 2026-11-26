// Juegos → Pong Pizza: la cancha se ve en la pantalla del bar (VINILO APP) y dos personas juegan con el celular como control.
// Salas en memoria: la pantalla crea una sala con un código de 4 letras; los celulares se unen escaneando el QR (/pong?sala=CODIGO).
const crypto = require('crypto');
const { aceptar } = require('./ws');
const qr = require('./qr');

const salas = new Map(); // codigo -> { codigo, tv, jugadores: { izq, der }, creada, sucursal }
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const nuevoCodigo = () => { let c; do { c = Array.from({ length: 4 }, () => LETRAS[crypto.randomInt(LETRAS.length)]).join(''); } while (salas.has(c)); return c; };
const limpiarNombre = (n) => String(n || '').replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/$/, '');
const publico = (j) => (j ? { nombre: j.nombre, conectado: !!(j.ws && j.ws.abierto) } : null);
function avisarTv(s) { if (s.tv && s.tv.abierto) s.tv.enviar({ t: 'jugadores', izq: publico(s.jugadores.izq), der: publico(s.jugadores.der) }); }

// Borra salas abandonadas (sin pantalla por más de 30 min)
setInterval(() => { const ahora = Date.now(); for (const [c, s] of salas) if (!(s.tv && s.tv.abierto) && ahora - s.visto > 30 * 60e3) salas.delete(c); }, 5 * 60e3).unref();

function conectarTv(ws, codigo) {
  let s = codigo && salas.get(codigo);
  if (!s) { s = { codigo: nuevoCodigo(), tv: null, jugadores: { izq: null, der: null }, creada: Date.now(), visto: Date.now() }; salas.set(s.codigo, s); }
  if (s.tv && s.tv !== ws && s.tv.abierto) s.tv.cerrar();
  s.tv = ws; s.visto = Date.now();
  ws.enviar({ t: 'sala', codigo: s.codigo }); avisarTv(s);
  ws.onmensaje = (m) => {
    s.visto = Date.now();
    if (m.t === 'estado') { for (const lado of ['izq', 'der']) { const j = s.jugadores[lado]; if (j && j.ws) j.ws.enviar({ ...m, lado }); } }
    else if (m.t === 'vibrar') { const j = s.jugadores[m.lado]; if (j && j.ws) j.ws.enviar({ t: 'vibrar', ms: Math.min(400, Number(m.ms) || 60) }); }
    else if (m.t === 'liberar') { for (const lado of ['izq', 'der']) { const j = s.jugadores[lado]; if (j && j.ws) j.ws.enviar({ t: 'liberado' }); if (j && j.ws) j.ws.cerrar(); s.jugadores[lado] = null; } avisarTv(s); }
    else if (m.t === 'expulsar' && s.jugadores[m.lado]) { const j = s.jugadores[m.lado]; if (j.ws) { j.ws.enviar({ t: 'liberado' }); j.ws.cerrar(); } s.jugadores[m.lado] = null; avisarTv(s); }
  };
  ws.oncierre = () => { s.visto = Date.now(); for (const lado of ['izq', 'der']) { const j = s.jugadores[lado]; if (j && j.ws) j.ws.enviar({ t: 'pantalla', conectada: false }); } };
  for (const lado of ['izq', 'der']) { const j = s.jugadores[lado]; if (j && j.ws) j.ws.enviar({ t: 'pantalla', conectada: true }); }
}

function conectarJugador(ws, codigo) {
  const s = salas.get(String(codigo || '').toUpperCase());
  if (!s) { ws.enviar({ t: 'error', msg: 'Esta sala ya no existe. Escaneá de nuevo el QR de la pantalla.' }); setTimeout(() => ws.cerrar(), 300); return; }
  let lado = null;
  ws.onmensaje = (m) => {
    s.visto = Date.now();
    if (m.t === 'unir' && !lado) {
      const id = String(m.id || '').slice(0, 40), nombre = limpiarNombre(m.nombre);
      if (nombre.length < 2) return ws.enviar({ t: 'error', msg: 'Poné tu nombre (al menos 2 letras)' });
      // Reconexión: el mismo celular recupera su lado
      for (const l of ['izq', 'der']) { const j = s.jugadores[l]; if (j && j.id === id) { lado = l; j.ws = ws; j.nombre = nombre; } }
      if (!lado) for (const l of ['izq', 'der']) { const j = s.jugadores[l]; if (!j || !(j.ws && j.ws.abierto)) { lado = l; s.jugadores[l] = { id, nombre, ws }; break; } }
      if (!lado) return ws.enviar({ t: 'lleno', msg: 'Ya hay dos jugadores. Esperá a que termine el partido.' });
      ws.enviar({ t: 'unido', lado, pantalla: !!(s.tv && s.tv.abierto) }); avisarTv(s);
    } else if (m.t === 'y' && lado && s.tv && s.tv.abierto) {
      const v = Math.max(0, Math.min(1, Number(m.v))); if (Number.isFinite(v)) s.tv.enviar({ t: 'y', lado, v });
    } else if (m.t === 'listo' && lado && s.tv && s.tv.abierto) s.tv.enviar({ t: 'listo', lado });
  };
  ws.oncierre = () => { if (lado && s.jugadores[lado] && s.jugadores[lado].ws === ws) { avisarTv(s); } };
}

module.exports = function registrarPong({ route, fail, permitir, server, currentUser }) {
  route('GET', '/api/pong/qr', async ({ user, url, req }) => {
    permitir(user, 'juegos');
    const c = String(url.searchParams.get('sala') || '').toUpperCase(); if (!salas.has(c)) fail(404, 'Sala inexistente');
    const link = `${baseUrl(req)}/pong?sala=${c}`;
    return { link, qr: qr.svg(link, { color: '#1a1010' }) };
  });
  server.on('upgrade', async (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws/pong') { socket.destroy(); return; }
    if (url.searchParams.get('rol') === 'tv') {
      const user = await currentUser({ headers: { authorization: 'Bearer ' + (url.searchParams.get('token') || '') } }).catch(() => null);
      if (!user || !(user.permisos || []).includes('juegos')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      const ws = aceptar(req, socket); if (ws) conectarTv(ws, String(url.searchParams.get('sala') || '').toUpperCase());
    } else {
      const ws = aceptar(req, socket); if (ws) conectarJugador(ws, url.searchParams.get('sala'));
    }
  });
};
