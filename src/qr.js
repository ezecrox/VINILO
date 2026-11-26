// Generador de códigos QR (modo byte, corrección M) sin dependencias. Basado en el algoritmo de referencia de Nayuki (MIT).
const ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOQ_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMATO_M = 0; // bits de nivel M

function modulosDatos(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const codewordsDatos = (ver) => Math.floor(modulosDatos(ver) / 8) - ECC_M[ver] * BLOQ_M[ver];

// Reed-Solomon sobre GF(256)
function mulGF(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; }
function divisorRS(grado) {
  const r = new Array(grado).fill(0); r[grado - 1] = 1; let raiz = 1;
  for (let i = 0; i < grado; i++) { for (let j = 0; j < r.length; j++) { r[j] = mulGF(r[j], raiz); if (j + 1 < r.length) r[j] ^= r[j + 1]; } raiz = mulGF(raiz, 0x02); }
  return r;
}
function restoRS(datos, div) {
  const r = div.map(() => 0);
  for (const b of datos) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mulGF(c, f); }); }
  return r;
}

function posicionesAlineacion(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, paso = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6]; for (let p = ver * 4 + 10; r.length < n; p -= paso) r.splice(1, 0, p);
  return r;
}

function generar(texto) {
  const bytes = [...Buffer.from(String(texto), 'utf8')];
  let ver = 1;
  for (; ver <= 40; ver++) { const cc = ver < 10 ? 8 : 16; if (4 + cc + bytes.length * 8 <= codewordsDatos(ver) * 8) break; }
  if (ver > 40) throw new Error('Texto demasiado largo para un QR');
  // Bits: modo byte (0100), largo, datos, terminador, relleno
  const bits = []; const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => push(b, 8));
  const cap = codewordsDatos(ver) * 8;
  push(0, Math.min(4, cap - bits.length)); push(0, (8 - (bits.length % 8)) % 8);
  for (let p = 0xec; bits.length < cap; p ^= 0xec ^ 0x11) push(p, 8);
  const datos = []; for (let i = 0; i < bits.length; i += 8) datos.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // Bloques + corrección de errores, intercalados
  const nB = BLOQ_M[ver], eccLen = ECC_M[ver], raw = Math.floor(modulosDatos(ver) / 8), cortos = nB - (raw % nB), largoCorto = Math.floor(raw / nB);
  const div = divisorRS(eccLen); const bloques = [];
  for (let i = 0, k = 0; i < nB; i++) {
    const dat = datos.slice(k, k + largoCorto - eccLen + (i < cortos ? 0 : 1)); k += dat.length;
    const ecc = restoRS(dat, div); if (i < cortos) dat.push(0); bloques.push(dat.concat(ecc));
  }
  const final = [];
  for (let i = 0; i < bloques[0].length; i++) bloques.forEach((b, j) => { if (i !== largoCorto - eccLen || j >= cortos) final.push(b[i]); });

  // Matriz
  const N = ver * 4 + 17; const m = Array.from({ length: N }, () => new Array(N).fill(false)); const fijo = Array.from({ length: N }, () => new Array(N).fill(false));
  const set = (x, y, v) => { m[y][x] = v; fijo[y][x] = true; };
  for (let i = 0; i < N; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const buscador = (x, y) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy; if (xx >= 0 && xx < N && yy >= 0 && yy < N) set(xx, yy, d !== 2 && d !== 4); } };
  buscador(3, 3); buscador(N - 4, 3); buscador(3, N - 4);
  const al = posicionesAlineacion(ver);
  al.forEach((ax, i) => al.forEach((ay, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
  const formato = (mask) => {
    const d = (FORMATO_M << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412; const bit = (i) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i)); set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(N - 1 - i, 8, bit(i)); for (let i = 8; i < 15; i++) set(8, N - 15 + i, bit(i)); set(8, N - 8, true);
  };
  formato(0);
  if (ver >= 7) { let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) { const v = ((b >>> i) & 1) !== 0, a = N - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, v); set(c, a, v); } }
  // Datos en zigzag
  let i = 0;
  for (let der = N - 1; der >= 1; der -= 2) { if (der === 6) der = 5;
    for (let v = 0; v < N; v++) for (let j = 0; j < 2; j++) { const x = der - j, arriba = ((der + 1) & 2) === 0, y = arriba ? N - 1 - v : v;
      if (!fijo[y][x] && i < final.length * 8) { m[y][x] = ((final[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; } } }
  // Máscaras: elegir la de menor penalidad
  const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const aplicar = (k) => { for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!fijo[y][x] && MASK[k](x, y)) m[y][x] = !m[y][x]; };
  const penal = () => {
    let p = 0;
    const linea = (get) => { for (let a = 0; a < N; a++) { let run = 1; for (let b = 1; b <= N; b++) { if (b < N && get(a, b) === get(a, b - 1)) run++; else { if (run >= 5) p += run - 2; run = 1; } } } };
    linea((a, b) => m[a][b]); linea((a, b) => m[b][a]);
    for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
    const pat = [true, false, true, true, true, false, true];
    const fin = (get) => { for (let a = 0; a < N; a++) for (let b = 0; b + 7 <= N; b++) { if (!pat.every((v, k) => get(a, b + k) === v)) continue;
      const blanco = (d) => { for (let k = 0; k < 4; k++) { const q = d < 0 ? b - 1 - k : b + 7 + k; if (q >= 0 && q < N && get(a, q)) return false; } return true; };
      if (blanco(-1) || blanco(1)) p += 40; } };
    fin((a, b) => m[a][b]); fin((a, b) => m[b][a]);
    let osc = 0; m.forEach((r) => r.forEach((v) => { if (v) osc++; })); const tot = N * N; p += Math.ceil(Math.abs(osc * 20 - tot * 10) / tot - 1) * 10;
    return p;
  };
  let mejor = 0, minP = Infinity;
  for (let k = 0; k < 8; k++) { aplicar(k); formato(k); const p = penal(); if (p < minP) { minP = p; mejor = k; } aplicar(k); }
  aplicar(mejor); formato(mejor);
  return m;
}

// SVG listo para imprimir o mostrar (borde de 4 módulos)
function svg(texto, { color = '#111', fondo = '#fff', borde = 4 } = {}) {
  const m = generar(texto), N = m.length, T = N + borde * 2; let d = '';
  m.forEach((r, y) => r.forEach((v, x) => { if (v) d += `M${x + borde} ${y + borde}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${T} ${T}" shape-rendering="crispEdges"><rect width="${T}" height="${T}" fill="${fondo}"/><path d="${d}" fill="${color}"/></svg>`;
}

module.exports = { generar, svg };
