// Parser CSV (separador ; o , autodetectado, comillas y saltos de línea dentro de campos)
function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const primera = text.split(/\r?\n/)[0] || '';
  const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const norm = (h) => String(h).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s-]+/g, '_');
const SI = ['SI', 'S', 'X', '1', 'TRUE'];

/**
 * Convierte el maestro exportado (ID, Categoría, Subcategoría, Código, Nombre, ..., Activo)
 * en filas de producto. El código interno es el ID del maestro (único y siempre presente).
 */
function productosDesdeMaestro(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const h = rows[0].map(norm);
  const col = (r, name) => { const i = h.indexOf(name); return i >= 0 ? String(r[i] || '').trim() : ''; };
  return rows.slice(1).map((r) => {
    const cat = col(r, 'categoria');
    const sub = col(r, 'subcategoria');
    const activo = col(r, 'activo');
    return {
      codigo: col(r, 'id') || col(r, 'codigo'),
      nombre: col(r, 'nombre').replace(/\s+/g, ' '),
      categoria: sub ? `${cat} / ${sub}` : cat,
      unidad: 'UN',
      activo: activo === '' ? true : SI.includes(norm(activo).toUpperCase()),
    };
  }).filter((p) => p.codigo && p.nombre);
}

module.exports = { parseCSV, productosDesdeMaestro };
