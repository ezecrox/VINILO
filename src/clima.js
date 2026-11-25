// Pronóstico de la noche (18 a 3 h) para el panel, desde Open-Meteo (sin clave). Caché de 30 minutos.
const TZ = 'America/Argentina/Buenos_Aires';
const LAT = Number(process.env.CLIMA_LAT || -34.5853);
const LON = Number(process.env.CLIMA_LON || -60.9589);
const CIUDAD = process.env.CLIMA_CIUDAD || 'Junín (Bs. As.)';
const URL_BASE = process.env.CLIMA_URL || 'https://api.open-meteo.com/v1/forecast';
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

const fechaLocal = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const horaLocal = (d) => Number(d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;

// Noche a mostrar: la de hoy; entre las 0 y las 6 h, la que empezó ayer (todavía en curso)
function nocheActual(ahora = new Date()) {
  const hoy = fechaLocal(ahora);
  if (horaLocal(ahora) < 6) return fechaLocal(new Date(Date.parse(hoy + 'T12:00:00Z') - 86400e3));
  return hoy;
}

async function pronostico() {
  const inicio = nocheActual();
  const clave = `${inicio}|${LAT}|${LON}`;
  if (cache && cache.clave === clave && Date.now() - cache.t < 30 * 60e3) return cache.datos;
  const qs = new URLSearchParams({
    latitude: String(LAT), longitude: String(LON), timezone: TZ, past_days: '1', forecast_days: '2',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
  });
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8000);
  let j;
  try {
    const r = await fetch(`${URL_BASE}?${qs}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
  } finally { clearTimeout(to); }
  const h = j.hourly || {};
  const fin = fechaLocal(new Date(Date.parse(inicio + 'T12:00:00Z') + 86400e3));
  const horas = [];
  (h.time || []).forEach((t, i) => {
    const [f, hh] = [t.slice(0, 10), Number(t.slice(11, 13))];
    if (!((f === inicio && hh >= DESDE) || (f === fin && hh <= HASTA))) return;
    const d = desc(h.weather_code[i], hh >= 20 || hh <= 6);
    horas.push({ hora: t.slice(11, 16), fecha: f, temp: Math.round(h.temperature_2m[i]), sensacion: Math.round(h.apparent_temperature[i]),
      lluvia_prob: h.precipitation_probability ? h.precipitation_probability[i] : null, lluvia_mm: h.precipitation ? h.precipitation[i] : null,
      viento: Math.round(h.wind_speed_10m[i]), rafagas: h.wind_gusts_10m ? Math.round(h.wind_gusts_10m[i]) : null, codigo: h.weather_code[i], ...d });
  });
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
    avisos, fuente: 'Open-Meteo', actualizado: new Date().toISOString(),
  };
  cache = { clave, t: Date.now(), datos };
  return datos;
}

module.exports = function registrarClima({ route }) {
  route('GET', '/api/clima', async () => {
    try { return await pronostico(); }
    catch (e) {
      console.warn('Clima: no se pudo obtener el pronóstico:', e.message);
      if (cache) return { ...cache.datos, desactualizado: true };
      return { error_clima: 'No se pudo obtener el pronóstico en este momento.', ciudad: CIUDAD };
    }
  });
};
module.exports.nocheActual = nocheActual;
