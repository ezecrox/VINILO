// Integración con CrossChex Cloud (Anviz): trae fichadas del reloj y calcula horas trabajadas.
// Variables: CROSSCHEX_API_KEY, CROSSCHEX_API_SECRET (obligatorias), CROSSCHEX_API_URL (default región US),
// CROSSCHEX_SYNC_MINUTES (default 60; 0 = solo manual), CROSSCHEX_CORTE_HORA (default 6: lo fichado antes de esa hora
// cuenta para la jornada del día anterior, para turnos nocturnos).
const crypto = require('crypto');

const API_URL = () => process.env.CROSSCHEX_API_URL || 'https://api.us.crosschexcloud.com/';
const configurado = () => !!(process.env.CROSSCHEX_API_KEY && process.env.CROSSCHEX_API_SECRET);
const CORTE = () => Math.min(Math.max(Number(process.env.CROSSCHEX_CORTE_HORA ?? 6), 0), 12);
const TZ = 'America/Argentina/Buenos_Aires';
const DEDUP_MIN = 2; // fichadas del mismo empleado a menos de 2 minutos se toman como una sola

let tokenCache = null;
let enCurso = null;
// CrossChex permite una consulta cada 15 s: se espera entre llamadas y se reintenta si lo pide
const ESPERA_MS = Number(process.env.CROSSCHEX_ESPERA_MS ?? 16000);
let ultimaLlamada = 0;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '+00:00');

async function llamar(nameSpace, nameAction, payload, conToken = true, intento = 1) {
  const tk = conToken ? await token() : null;
  const espera = ultimaLlamada + ESPERA_MS - Date.now();
  if (espera > 0) await dormir(espera);
  ultimaLlamada = Date.now();
  try {
    return await llamarUnaVez(nameSpace, nameAction, payload, tk);
  } catch (e) {
    if (/once every|too many|frequen|limit/i.test(e.message) && intento < 5) {
      // espera progresiva: 1x, 2x, 3x, 4x el intervalo
      ultimaLlamada = Date.now() + ESPERA_MS * (intento - 1);
      return llamar(nameSpace, nameAction, payload, conToken, intento + 1);
    }
    throw e;
  }
}

async function llamarUnaVez(nameSpace, nameAction, payload, tk) {
  const conToken = !!tk;
  const body = {
    header: { nameSpace, nameAction, version: '1.0', requestId: crypto.randomUUID(), timestamp: iso(Date.now()) },
    payload,
  };
  if (conToken) body.authorize = { type: 'token', token: tk };
  const res = await fetch(API_URL(), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch (_) { throw new Error(`CrossChex respondió algo inesperado (HTTP ${res.status}): ${txt.slice(0, 150)}`); }
  // Errores: { header: { nameSpace: 'System', name: 'Exception' }, payload: { type, message } }
  const h = data.header || (data.data && data.data.header) || {};
  if (h.name === 'Exception' || (data.payload && data.payload.type && !data.data)) {
    const p = data.payload || {};
    if (conToken && /TOKEN/i.test(`${p.type} ${p.message}`)) tokenCache = null;
    throw new Error(`CrossChex: ${p.message || p.type || 'error'}`);
  }
  if (!res.ok) throw new Error(`CrossChex HTTP ${res.status}`);
  return (data.data && data.data.payload) || data.payload || {};
}

async function token() {
  if (tokenCache && tokenCache.vence - 5 * 60e3 > Date.now()) return tokenCache.token;
  const p = await llamar('authorize.token', 'token', { api_key: process.env.CROSSCHEX_API_KEY, api_secret: process.env.CROSSCHEX_API_SECRET }, false);
  if (!p.token) throw new Error('CrossChex no devolvió un token. Revisá CROSSCHEX_API_KEY / CROSSCHEX_API_SECRET y que la cuenta tenga habilitada la API.');
  const vence = Date.parse(p.expires) || Date.now() + 24 * 3600e3;
  tokenCache = { token: p.token, vence };
  return p.token;
}

/** Trae fichadas entre dos fechas (en ventanas de hasta 31 días, 1000 por página). */
async function leerFichadas(desde, hasta) {
  const out = [];
  const VENTANA = 31 * 86400e3;
  for (let ini = new Date(desde); ini < hasta; ini = new Date(ini.getTime() + VENTANA)) {
    const fin = new Date(Math.min(ini.getTime() + VENTANA, hasta.getTime()));
    for (let page = 1; page <= 500; page++) {
      const p = await llamar('attendance.record', 'getrecord', { begin_time: iso(ini), end_time: iso(fin), order: 'asc', page, per_page: 1000 });
      const lista = Array.isArray(p.list) ? p.list : [];
      out.push(...lista);
      const pages = Number(p.pageCount || 1);
      if (!lista.length || page >= pages) break;
    }
  }
  return out;
}

async function sincronizar(pool, origen = 'MANUAL', { dias } = {}) {
  if (!configurado()) throw new Error('CrossChex no está configurado: cargá CROSSCHEX_API_KEY y CROSSCHEX_API_SECRET en Render.');
  if (enCurso) return enCurso;
  enCurso = (async () => {
    const { rows: lg } = await pool.query("INSERT INTO fudo_sync_log (entidad, origen) VALUES ('crosschex', $1) RETURNING id", [origen]);
    const logId = lg[0].id;
    try {
      const { rows: ult } = await pool.query('SELECT max(checktime) AS t FROM fichadas');
      const hasta = new Date();
      // Desde la última fichada menos 2 días (por fichadas cargadas tarde) o, la primera vez, 31 días
      let desde = dias ? new Date(Date.now() - dias * 86400e3)
        : ult[0] && ult[0].t ? new Date(new Date(ult[0].t).getTime() - 2 * 86400e3) : new Date(Date.now() - 31 * 86400e3);
      const lista = await leerFichadas(desde, hasta);
      let nuevas = 0;
      for (const r of lista) {
        const e = r.employee || {};
        const workno = String(e.workno ?? '').trim();
        const t = Date.parse(r.checktime);
        if (!workno || Number.isNaN(t)) continue;
        const nombre = [e.first_name, e.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 150) || null;
        const dev = r.device || {};
        const { rows } = await pool.query(
          `INSERT INTO fichadas (workno, nombre, checktime, checktype, device_sn, device_name) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (workno, checktime, device_sn) DO NOTHING RETURNING id`,
          [workno.slice(0, 30), nombre, new Date(t).toISOString(), Number.isFinite(Number(r.checktype)) ? Number(r.checktype) : null,
            String(dev.serial_number || '').slice(0, 60), dev.name ? String(dev.name).slice(0, 120) : null]);
        if (rows.length) nuevas++;
      }
      await pool.query('UPDATE fudo_sync_log SET fin=now(), ok=TRUE, leidos=$2, creados=$3, detalle=$4 WHERE id=$1',
        [logId, lista.length, nuevas, `Período ${iso(desde)} a ${iso(hasta)}`]);
      console.log(`CrossChex (${origen}): ${lista.length} fichadas leídas, ${nuevas} nuevas`);
      return { leidas: lista.length, nuevas, desde: iso(desde), hasta: iso(hasta) };
    } catch (e) {
      await pool.query('UPDATE fudo_sync_log SET fin=now(), ok=FALSE, detalle=$2 WHERE id=$1', [logId, String(e.message).slice(0, 1000)]).catch(() => {});
      console.error('Error sincronizando CrossChex:', e.message);
      throw e;
    }
  })();
  try { return await enCurso; } finally { enCurso = null; }
}

function iniciarSincronizacionAutomatica(pool) {
  if (!configurado()) { console.log('CrossChex: integración no configurada'); return; }
  const min = Number(process.env.CROSSCHEX_SYNC_MINUTES ?? 60);
  setTimeout(() => sincronizar(pool, 'ARRANQUE').catch(() => {}), 8000);
  if (min > 0) setInterval(() => sincronizar(pool, 'AUTO').catch(() => {}), min * 60e3).unref();
}

// ---------- Cálculo de jornadas ----------
const partes = (d) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  return { fecha: `${f.year}-${f.month}-${f.day}`, hora: Number(f.hour === '24' ? 0 : f.hour), hhmm: `${f.hour === '24' ? '00' : f.hour}:${f.minute}` };
};
const diaAnterior = (f) => new Date(Date.parse(f + 'T12:00:00Z') - 86400e3).toISOString().slice(0, 10);

/** Agrupa fichadas por empleado y jornada; empareja entrada/salida en orden. */
function calcularJornadas(fichadas) {
  const corte = CORTE();
  const porEmp = new Map();
  const ordenadas = [...fichadas].sort((a, b) => new Date(a.checktime) - new Date(b.checktime));
  for (const f of ordenadas) {
    const t = new Date(f.checktime);
    const p = partes(t);
    const jornada = p.hora < corte ? diaAnterior(p.fecha) : p.fecha;
    if (!porEmp.has(f.workno)) porEmp.set(f.workno, { workno: f.workno, nombre: f.nombre, dias: new Map() });
    const emp = porEmp.get(f.workno);
    if (f.nombre) emp.nombre = f.nombre;
    if (!emp.dias.has(jornada)) emp.dias.set(jornada, []);
    const lista = emp.dias.get(jornada);
    const prev = lista[lista.length - 1];
    if (prev && t - prev.t < DEDUP_MIN * 60e3) continue; // doble fichada
    lista.push({ t, hhmm: p.hhmm, fecha: p.fecha, dispositivo: f.device_name || null });
  }
  return [...porEmp.values()].map((e) => {
    const dias = [...e.dias.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([fecha, marcas]) => {
      const tramos = [];
      for (let i = 0; i < marcas.length; i += 2) {
        const ent = marcas[i], sal = marcas[i + 1];
        tramos.push({ entrada: ent.hhmm, salida: sal ? sal.hhmm + (sal.fecha !== ent.fecha ? ' (+1)' : '') : null, minutos: sal ? Math.round((sal.t - ent.t) / 60e3) : 0 });
      }
      const minutos = tramos.reduce((s, x) => s + x.minutos, 0);
      return { fecha, marcas: marcas.map((m) => m.hhmm), tramos, minutos, incompleta: marcas.length % 2 === 1 };
    });
    return { workno: e.workno, nombre: e.nombre, dias, minutos: dias.reduce((s, d) => s + d.minutos, 0),
      dias_trabajados: dias.filter((d) => d.minutos > 0).length, incompletas: dias.filter((d) => d.incompleta).length };
  }).sort((a, b) => (a.nombre || a.workno).localeCompare(b.nombre || b.workno));
}

module.exports = function registrarCrossChex({ route, query, fail, permitir, permitirAlguno, toInt, fechaOk, pool }) {
  async function horas(desde, hasta, workno) {
    const corte = CORTE();
    // Ampliar el rango por el corte nocturno: la jornada D incluye hasta D+1 a la hora de corte
    const { rows } = await query(
      `SELECT f.workno, f.nombre, f.checktime, f.device_name FROM fichadas f
       WHERE f.checktime >= (($1::date)::timestamp + make_interval(hours => $3)) AT TIME ZONE '${TZ}'
         AND f.checktime < ((($2::date) + 1)::timestamp + make_interval(hours => $3)) AT TIME ZONE '${TZ}'
         ${workno ? 'AND f.workno = $4' : ''}
       ORDER BY f.checktime`, workno ? [desde, hasta, corte, workno] : [desde, hasta, corte]);
    const emps = calcularJornadas(rows);
    const { rows: us } = await query("SELECT id, nombre, username, legajo FROM usuarios WHERE legajo IS NOT NULL AND legajo <> ''");
    const porLeg = new Map(us.map((u) => [String(u.legajo), u]));
    return emps.map((e) => {
      const u = porLeg.get(String(e.workno));
      return { ...e, usuario_id: u ? Number(u.id) : null, usuario: u ? u.nombre : null };
    });
  }

  const rango = (url) => {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const desde = fechaOk(url.searchParams.get('desde')) || `${hoy.slice(0, 8)}01`;
    const hasta = fechaOk(url.searchParams.get('hasta')) || hoy;
    if (hasta < desde) fail(400, 'El "hasta" no puede ser anterior al "desde"');
    if (Date.parse(hasta) - Date.parse(desde) > 93 * 86400e3) fail(400, 'El período no puede superar los 3 meses');
    return { desde, hasta };
  };

  route('GET', '/api/horas', async ({ user, url }) => {
    permitir(user, 'verHoras');
    const { desde, hasta } = rango(url);
    const { rows: lg } = await query("SELECT id, ok, detalle, inicio, fin, leidos, creados FROM fudo_sync_log WHERE entidad = 'crosschex' ORDER BY id DESC LIMIT 1");
    const { rows: tot } = await query('SELECT count(*)::int AS n, max(checktime) AS ultima FROM fichadas');
    return {
      configurado: configurado(), sincronizando: !!enCurso, corte: CORTE(), desde, hasta, ultimo: lg[0] || null,
      fichadas_total: Number(tot[0].n), ultima_fichada: tot[0].ultima,
      empleados: await horas(desde, hasta, url.searchParams.get('workno') || null),
    };
  });

  // Horas propias (para el empleado con legajo vinculado)
  route('GET', '/api/horas/mias', async ({ user, url }) => {
    permitirAlguno(user, 'misHoras', 'solicitudes', 'verHoras');
    const { rows } = await query('SELECT legajo FROM usuarios WHERE id = $1', [user.id]);
    const legajo = rows[0] && rows[0].legajo;
    const { rows: lg } = await query("SELECT fin FROM fudo_sync_log WHERE entidad = 'crosschex' AND ok IS TRUE ORDER BY id DESC LIMIT 1");
    const actualizado = lg[0] ? lg[0].fin : null;
    if (!legajo) return { vinculado: false, configurado: configurado(), actualizado };
    const { desde, hasta } = rango(url);
    const e = (await horas(desde, hasta, legajo))[0] || { dias: [], minutos: 0, dias_trabajados: 0, incompletas: 0 };
    const { rows: uf } = await query('SELECT max(checktime) AS ultima FROM fichadas WHERE workno = $1', [legajo]);
    return { vinculado: true, legajo, desde, hasta, corte: CORTE(), configurado: configurado(), actualizado, ultima_fichada: uf[0].ultima, ...e };
  });

  route('POST', '/api/horas/sincronizar', async ({ user, body }) => {
    permitir(user, 'verHoras');
    if (!configurado()) fail(400, 'CrossChex no está configurado: cargá CROSSCHEX_API_KEY y CROSSCHEX_API_SECRET en Render.');
    const dias = body && body.dias ? Math.min(Math.max(toInt(body.dias) || 0, 1), 93) : undefined;
    // Puede tardar (una consulta cada 15 s): corre en segundo plano y la pantalla consulta el estado
    if (body && body.esperar) { try { return await sincronizar(pool, 'MANUAL', { dias }); } catch (e) { fail(502, e.message); } }
    if (enCurso) return { iniciada: false, en_curso: true };
    sincronizar(pool, 'MANUAL', { dias }).catch(() => {});
    return { iniciada: true, en_curso: true };
  });

  // Números de reloj vistos sin usuario vinculado (para vincular legajos)
  route('GET', '/api/horas/sin-vincular', async ({ user }) => {
    permitirAlguno(user, 'verHoras', 'usuarios');
    const { rows } = await query(
      `SELECT f.workno, max(f.nombre) AS nombre, count(*)::int AS fichadas, max(f.checktime) AS ultima FROM fichadas f
       WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.legajo = f.workno) GROUP BY f.workno ORDER BY max(f.nombre)`);
    return rows.map((r) => ({ ...r, fichadas: Number(r.fichadas) }));
  });
};

module.exports.configurado = configurado;
module.exports.sincronizando = () => !!enCurso;
module.exports.sincronizar = sincronizar;
module.exports.iniciarSincronizacionAutomatica = iniciarSincronizacionAutomatica;
module.exports.calcularJornadas = calcularJornadas;
