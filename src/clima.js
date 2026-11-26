// Pronóstico de la noche (18 a 3 h) para el panel, desde Open-Meteo (sin clave). Caché de 30 minutos.
const TZ = 'America/Argentina/Buenos_Aires';
const LAT = Number(process.env.CLIMA_LAT || -34.5853);
const LON = Number(process.env.CLIMA_LON || -60.9589);
const CIUDAD = process.env.CLIMA_CIUDAD || 'Junín (Bs. As.)';
const URL_BASE = process.env.CLIMA_URL || 'https://api.open-meteo.com/v1/forecast';
const URL_MET = process.env.CLIMA_MET_URL || 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const UA = process.env.CLIMA_UA || 'VINILO-APP/1.0 (github.com/ezecrox/VINILO)';
const DESDE = 18, HASTA = 3; // franja de trabajo: 18 h de un día a 3 h del siguiente

// Códigos WMO → texto e ícono
const WMO = {
  0: ['Despejado', '☀️', '🌙'], 1: ['Mayormente despejado', '🌤️', '🌙'], 2: ['Parcialmente nublado', '⛅', '☁️'], 3: ['Nublado', '☁️', '☁️'],
  45: ['Niebla', '🌫️'], 48: ['Niebla con escarcha', '🌫️'],
  51: ['Llovizna débil', '🌦️'], 53: ['Llovizna', '🌦️'], 55: ['Llovizna intensa', '🌧️'], 56: ['Llovizna helada', '🌧️'], 57: ['Llovizna helada', '🌧️'],
  61: ['Lluvia débil', '🌦️'], 63: ['Lluvia', '🌧️'], 65: ['Lluvia fuerte', '🌧️'], 66: ['Lluvia helada', '🌧️'], 67: ['Lluvia helada', '🌧️'],
  71: ['Nieve débil', '🌨️'], 73: ['Nieve', '🌨️'], 75: ['Nieve fuerte', '❄️'], 77: ['Granizo fino', '🌨️'],
  80: ['Chaparrones', '🌦️'], 81: ['Chaparrones', '🌧️'], 82: ['Chaparrones fuertes', '⛈️'], 85: ['Nevadas', '🌨️'], 86: ['Nevadas fuertes', '❄️'],
  95: ['Tormenta', '⛈️'], 96: ['Tormenta con granizo', '⛈️'], 99: ['Tormenta con granizo', '⛈️'],
};
const desc = (c, noche) => { const w = WMO[c] || ['—', '🌡️']; return { texto: w[0], icono: noche && w[2] ? w[2] : w[1] }; };

let cache = null; // { clave, t, datos }
let query = null;                 // para guardar el último pronóstico en la base (sobrevive a reinicios)
let pausaOpenMeteo = 0;           // si Open-Meteo responde 429 no se lo vuelve a consultar por 20 minutos
let reintento = 0;                // si fallan todos los proveedores, no reintentar por 5 minutos

const fechaLocal = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const horaLocal = (d) => Number(d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;

// Noche a mostrar: la de hoy; entre las 0 y las 6 h, la que empezó ayer (todavía en curso)
function nocheActual(ahora = new Date()) {
  const hoy = fechaLocal(ahora);
  if (horaLocal(ahora) < 6) return fechaLocal(new Date(Date.parse(hoy + 'T12:00:00Z') - 86400e3));
  return hoy;
}

const fetchJson = async (url, opts = {}) => {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8000);
  try { const r = await fetch(url, { ...opts, signal: ctrl.signal }); if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; } return await r.json(); }
  finally { clearTimeout(to); }
};

// Proveedor 1: Open-Meteo → horas normalizadas
async function desdeOpenMeteo() {
  const qs = new URLSearchParams({
    latitude: String(LAT), longitude: String(LON), timezone: TZ, past_days: '1', forecast_days: '2',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
  });
  const j = await fetchJson(`${URL_BASE}?${qs}`);
  const h = j.hourly || {};
  return (h.time || []).map((t, i) => ({ t, temp: h.temperature_2m[i], sensacion: h.apparent_temperature[i], prob: h.precipitation_probability ? h.precipitation_probability[i] : null,
    mm: h.precipitation ? h.precipitation[i] : null, viento: h.wind_speed_10m[i], rafagas: h.wind_gusts_10m ? h.wind_gusts_10m[i] : null, codigo: h.weather_code[i] }));
}

// Proveedor 2 (respaldo): MET Norway (yr.no) → mismas horas, con el símbolo traducido a código WMO
const SIMB = [[/thunder/, 95], [/heavysleet|heavysnow/, 75], [/sleet/, 66], [/lightsnow/, 71], [/snow/, 73], [/heavyrainshowers/, 82], [/lightrainshowers/, 80], [/rainshowers/, 81],
  [/heavyrain/, 65], [/lightrain/, 61], [/rain/, 63], [/fog/, 45], [/partlycloudy/, 2], [/fair/, 1], [/clearsky/, 0], [/cloudy/, 3]];
const codigoMet = (sym) => { const s = String(sym || '').replace(/_(day|night|polartwilight)$/, ''); const m = SIMB.find(([re]) => re.test(s)); return m ? m[1] : 3; };
function sensacionTermica(t, vKmh, hr) {
  if (t <= 10 && vKmh > 4.8) return 13.12 + 0.6215 * t - 11.37 * vKmh ** 0.16 + 0.3965 * t * vKmh ** 0.16;
  if (t >= 27 && hr != null) { const T = t * 9 / 5 + 32; const HI = -42.379 + 2.04901523 * T + 10.14333127 * hr - 0.22475541 * T * hr - 0.00683783 * T * T - 0.05481717 * hr * hr + 0.00122874 * T * T * hr + 0.00085282 * T * hr * hr - 0.00000199 * T * T * hr * hr; return (HI - 32) * 5 / 9; }
  return t;
}
async function desdeMet() {
  const j = await fetchJson(`${URL_MET}?lat=${LAT.toFixed(4)}&lon=${LON.toFixed(4)}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  return ((j.properties && j.properties.timeseries) || []).filter((x) => x.data && x.data.next_1_hours).map((x) => {
    const d = new Date(x.time); const ins = (x.data.instant && x.data.instant.details) || {}; const n1 = x.data.next_1_hours;
    const t = `${fechaLocal(d)}T${String(horaLocal(d)).padStart(2, '0')}:00`;
    const viento = (ins.wind_speed || 0) * 3.6, rafagas = ins.wind_speed_of_gust != null ? ins.wind_speed_of_gust * 3.6 : null;
    return { t, temp: ins.air_temperature, sensacion: sensacionTermica(ins.air_temperature, viento, ins.relative_humidity), prob: n1.details && n1.details.probability_of_precipitation != null ? n1.details.probability_of_precipitation : null,
      mm: n1.details ? n1.details.precipitation_amount : null, viento, rafagas, codigo: codigoMet(n1.summary && n1.summary.symbol_code) };
  });
}

async function pronostico() {
  const inicio = nocheActual();
  const clave = `${inicio}|${LAT}|${LON}`;
  if (cache && cache.clave === clave && Date.now() - cache.t < 30 * 60e3) return cache.datos;
  if (Date.now() < reintento) { const e = new Error('esperando para reintentar'); e.silencioso = true; throw e; }
  let filas = null, fuente = null; const errores = [];
  if (Date.now() >= pausaOpenMeteo) {
    try { filas = await desdeOpenMeteo(); fuente = 'Open-Meteo'; }
    catch (e) { errores.push('Open-Meteo ' + e.message); if (e.status === 429) pausaOpenMeteo = Date.now() + 20 * 60e3; }
  }
  if (!filas) {
    try { filas = await desdeMet(); fuente = 'MET Norway (yr.no)'; }
    catch (e) { errores.push('MET Norway ' + e.message); }
  }
  if (!filas) { reintento = Date.now() + 5 * 60e3; throw new Error(errores.join(' · ')); }
  const datos = armar(filas, inicio, fuente);
  cache = { clave, t: Date.now(), datos };
  if (query) query("INSERT INTO app_config (clave, valor) VALUES ('clima_ultimo', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor", [JSON.stringify(cache)]).catch(() => {});
  return datos;
}

function armar(filas, inicio, fuente) {
  const fin = fechaLocal(new Date(Date.parse(inicio + 'T12:00:00Z') + 86400e3));
  const horas = [];
  for (const x of filas) {
    const [f, hh] = [x.t.slice(0, 10), Number(x.t.slice(11, 13))];
    if (!((f === inicio && hh >= DESDE) || (f === fin && hh <= HASTA))) continue;
    const d = desc(x.codigo, hh >= 20 || hh <= 6);
    horas.push({ hora: x.t.slice(11, 16), fecha: f, temp: Math.round(x.temp), sensacion: Math.round(x.sensacion ?? x.temp),
      lluvia_prob: x.prob, lluvia_mm: x.mm, viento: Math.round(x.viento), rafagas: x.rafagas != null ? Math.round(x.rafagas) : null, codigo: x.codigo, ...d });
  }
  if (!horas.length) throw new Error('Sin datos para la franja');
  const max = (k) => Math.max(...horas.map((x) => x[k] ?? -Infinity));
  const min = (k) => Math.min(...horas.map((x) => x[k] ?? Infinity));
  const mm = Math.round(horas.reduce((a, x) => a + (x.lluvia_mm || 0), 0) * 10) / 10;
  const peor = horas.reduce((a, x) => (x.codigo > a.codigo ? x : a), horas[0]);
  const avisos = [];
  if (horas.some((x) => x.codigo >= 95)) avisos.push('Posible tormenta');
  else if (max('lluvia_prob') >= 50 || mm >= 1) avisos.push('Probable lluvia');
  if (max('rafagas') >= 50) avisos.push(`Ráfagas de hasta ${max('rafagas')} km/h`);
  if (min('sensacion') <= 5) avisos.push('Noche fría');
  if (max('temp') >= 30) avisos.push('Noche calurosa');
  const datos = {
    ciudad: CIUDAD, noche: inicio, desde: `${DESDE}:00`, hasta: `0${HASTA}:00`, horas,
    resumen: { temp_min: min('temp'), temp_max: max('temp'), lluvia_prob_max: max('lluvia_prob'), lluvia_mm: mm, viento_max: max('viento'), rafagas_max: max('rafagas'),
      texto: peor.texto, icono: desc(peor.codigo, true).icono },
    avisos, fuente, actualizado: new Date().toISOString(),
  };
  return datos;
}

module.exports = function registrarClima({ route, query: q }) {
  query = q || null;
  // Recupera el último pronóstico guardado (por si el servidor se reinició y el proveedor no responde)
  if (query) query("SELECT valor FROM app_config WHERE clave = 'clima_ultimo'").then(({ rows }) => { if (rows[0] && !cache) { try { cache = JSON.parse(rows[0].valor); } catch (_) { /* nada */ } } }).catch(() => {});
  route('GET', '/api/clima', async () => {
    try { return await pronostico(); }
    catch (e) {
      if (!e.silencioso) console.warn('Clima: no se pudo obtener el pronóstico:', e.message);
      if (cache && cache.clave === `${nocheActual()}|${LAT}|${LON}`) return { ...cache.datos, desactualizado: true };
      return { error_clima: 'No se pudo obtener el pronóstico en este momento.', ciudad: CIUDAD };
    }
  });
};
module.exports.nocheActual = nocheActual;
