// Juegos → Guerra de Hornos: dos equipos (Tomate vs Albahaca) juegan con el celular; la pantalla del bar muestra los hornos.
// La pantalla (VINILO APP) lleva el juego; el servidor reparte jugadores en equipos, respeta el cupo por lado
// y le pasa a la pantalla los toques de cada celular agrupados cada 100 ms.
const crypto = require('crypto');
const { aceptar } = require('./ws');
const qr = require('./qr');

const salas = new Map();
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const EQUIPOS = ['tomate', 'albahaca'];
const nuevoCodigo = () => { let c; do { c = Array.from({ length: 4 }, () => LETRAS[crypto.randomInt(LETRAS.length)]).join(''); } while (salas.has(c)); return c; };
const limpiarNombre = (n) => String(n || '').replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/$/, '');
const MAX_TOQUES_SEG = 12; // tope por celular (evita trampas)

const lista = (s) => [...s.jugadores.values()].map((j) => ({ id: j.id, nombre: j.nombre, equipo: j.equipo, conectado: !!(j.ws && j.ws.abierto) }));
const enEquipo = (s, e) => [...s.jugadores.values()].filter((j) => j.equipo === e).length;
function avisarTv(s) { if (s.tv && s.tv.abierto) s.tv.enviar({ t: 'jugadores', lista: lista(s), max: s.max }); }
function aTodos(s, m) { const txt = JSON.stringify(m); for (const j of s.jugadores.values()) if (j.ws && j.ws.abierto) j.ws.enviar(txt); }

setInterval(() => { const ahora = Date.now(); for (const [c, s] of salas) if (!(s.tv && s.tv.abierto) && ahora - s.visto > 30 * 60e3) { clearInterval(s.lote); salas.delete(c); } }, 5 * 60e3).unref();

function crearSala() {
  const s = { codigo: nuevoCodigo(), tv: null, jugadores: new Map(), max: 10, visto: Date.now(), pend: new Map() };
  // Envío agrupado a la pantalla: { id: [toques, aciertos, errores] }
  s.lote = setInterval(() => {
    if (!s.pend.size || !(s.tv && s.tv.abierto)) { s.pend.clear(); return; }
    s.tv.enviar({ t: 'in', d: Object.fromEntries(s.pend) }); s.pend.clear();
  }, 100);
  s.lote.unref && s.lote.unref();
  salas.set(s.codigo, s);
  return s;
}

function conectarTv(ws, codigo) {
  let s = codigo && salas.get(codigo);
  if (!s) s = crearSala();
  if (s.tv && s.tv !== ws && s.tv.abierto) s.tv.cerrar();
  s.tv = ws; s.visto = Date.now();
  ws.enviar({ t: 'sala', codigo: s.codigo }); avisarTv(s);
  ws.onmensaje = (m) => {
    s.visto = Date.now();
    if (m.t === 'estado') aTodos(s, m);
    else if (m.t === 'config') { s.max = Math.max(1, Math.min(30, Number(m.max) || 10)); rebalancear(s); avisarTv(s); }
    else if (m.t === 'vibrar') { const ms = Math.min(400, Number(m.ms) || 60); for (const j of s.jugadores.values()) if ((!m.equipo || j.equipo === m.equipo) && j.ws) j.ws.enviar({ t: 'vibrar', ms }); }
    else if (m.t === 'mezclar') { const js = [...s.jugadores.values()].sort(() => Math.random() - 0.5); js.forEach((j, i) => { j.equipo = EQUIPOS[i % 2]; if (j.ws) j.ws.enviar({ t: 'equipo', equipo: j.equipo }); }); avisarTv(s); }
    else if (m.t === 'liberar') { for (const j of s.jugadores.values()) if (j.ws) { j.ws.enviar({ t: 'liberado' }); j.ws.cerrar(); } s.jugadores.clear(); avisarTv(s); }
    else if (m.t === 'expulsar') { const j = s.jugadores.get(String(m.id)); if (j) { if (j.ws) { j.ws.enviar({ t: 'liberado' }); j.ws.cerrar(); } s.jugadores.delete(j.id); avisarTv(s); } }
  };
  ws.oncierre = () => { s.visto = Date.now(); aTodos(s, { t: 'pantalla', conectada: false }); };
  aTodos(s, { t: 'pantalla', conectada: true });
}

// Si se baja el cupo, los últimos en entrar de cada equipo pasan a la espera
function rebalancear(s) {
  for (const e of EQUIPOS) {
    const js = [...s.jugadores.values()].filter((j) => j.equipo === e);
    for (const j of js.slice(s.max)) { if (j.ws) { j.ws.enviar({ t: 'lleno', msg: 'Se achicaron los equipos: quedaste afuera de esta partida. ¡En la próxima entrás!' }); j.ws.cerrar(); } s.jugadores.delete(j.id); }
  }
}

function conectarJugador(ws, codigo) {
  const s = salas.get(String(codigo || '').toUpperCase());
  if (!s) { ws.enviar({ t: 'error', msg: 'Esta sala ya no existe. Escaneá de nuevo el QR de la pantalla.' }); setTimeout(() => ws.cerrar(), 300); return; }
  let yo = null, presupuesto = MAX_TOQUES_SEG, ult = Date.now();
  ws.onmensaje = (m) => {
    s.visto = Date.now();
    if (m.t === 'unir' && !yo) {
      const id = String(m.id || '').slice(0, 40), nombre = limpiarNombre(m.nombre);
      if (!id) return;
      if (nombre.length < 2) return ws.enviar({ t: 'error', msg: 'Poné tu nombre (al menos 2 letras)' });
      const previo = s.jugadores.get(id);
      if (previo) { yo = previo; if (previo.ws && previo.ws !== ws && previo.ws.abierto) previo.ws.cerrar(); yo.ws = ws; yo.nombre = nombre; }
      else {
        const [a, b] = EQUIPOS.map((e) => enEquipo(s, e));
        if (a >= s.max && b >= s.max) return ws.enviar({ t: 'lleno', msg: `Los equipos están completos (${s.max} por lado). ¡Esperá la próxima partida!` });
        const equipo = a < b ? 'tomate' : b < a ? 'albahaca' : EQUIPOS[crypto.randomInt(2)];
        yo = { id, nombre, equipo: enEquipo(s, equipo) >= s.max ? EQUIPOS.find((e) => e !== equipo) : equipo, ws };
        s.jugadores.set(id, yo);
      }
      ws.enviar({ t: 'unido', equipo: yo.equipo, pantalla: !!(s.tv && s.tv.abierto), max: s.max }); avisarTv(s);
    } else if (yo && (m.t === 'tap' || m.t === 'arm')) {
      const ahora = Date.now(); presupuesto = Math.min(MAX_TOQUES_SEG * 1.5, presupuesto + (ahora - ult) / 1000 * MAX_TOQUES_SEG); ult = ahora;
      const p = s.pend.get(yo.id) || [0, 0, 0];
      if (m.t === 'tap') { const n = Math.max(0, Math.min(Math.floor(presupuesto), Math.floor(Number(m.n) || 0))); presupuesto -= n; p[0] += n; }
      else if (m.ok) p[1]++; else p[2]++;
      s.pend.set(yo.id, p);
    }
  };
  ws.oncierre = () => { if (yo && yo.ws === ws) avisarTv(s); };
}

module.exports = function registrarHornos({ route, fail, permitir, server, currentUser }) {
  route('GET', '/api/hornos/qr', async ({ user, url, req }) => {
    permitir(user, 'juegos');
    const c = String(url.searchParams.get('sala') || '').toUpperCase(); if (!salas.has(c)) fail(404, 'Sala inexistente');
    const link = `${baseUrl(req)}/hornos?sala=${c}`;
    return { link, qr: qr.svg(link, { color: '#1a1010' }) };
  });
  server.on('upgrade', async (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws/hornos') return;
    if (url.searchParams.get('rol') === 'tv') {
      const user = await currentUser({ headers: { authorization: 'Bearer ' + (url.searchParams.get('token') || '') } }).catch(() => null);
      if (!user || !(user.permisos || []).includes('juegos')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      const ws = aceptar(req, socket); if (ws) conectarTv(ws, String(url.searchParams.get('sala') || '').toUpperCase());
    } else {
      const ws = aceptar(req, socket); if (ws) conectarJugador(ws, url.searchParams.get('sala'));
    }
  });
};
