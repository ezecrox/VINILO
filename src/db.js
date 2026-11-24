const fs = require('fs');
const path = require('path');
const pg = require('pg');
const { hashPassword } = require('./auth');
const { productosDesdeMaestro, parseCSV } = require('./csv');

// DATE como texto 'YYYY-MM-DD' (evita corrimientos por zona horaria)
pg.types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Falta la variable de entorno DATABASE_URL');
  process.exit(1);
}

// Render: la URL interna no usa SSL; la externa sí. PGSSL=true lo fuerza.
const needsSsl = process.env.PGSSL === 'true' || /render\.com/.test(connectionString);
const pool = new pg.Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  connectionTimeoutMillis: 15000,
});

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  console.log('Actualizando estructura de la base…');
  // Si otra instancia bloquea una tabla, fallar en 20 s en vez de quedar colgado
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '20s'");
    await client.query(sql);
  } finally {
    client.release();
  }
  console.log('Estructura de la base OK');

  // Usuario ADMIN inicial si no hay ninguno
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM usuarios WHERE rol = 'ADMIN'");
  if (Number(rows[0].n) === 0) {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASSWORD || 'admin123';
    await pool.query(
      `INSERT INTO usuarios (username, nombre, password_hash, rol)
       VALUES ($1, 'Administrador', $2, 'ADMIN') ON CONFLICT (username) DO NOTHING`,
      [user, hashPassword(pass)]
    );
    console.log(`Usuario ADMIN inicial creado: ${user}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('ATENCION: se usó la contraseña por defecto "admin123". Cambiala apenas ingreses.');
    }
  }

  // Carga inicial del maestro de productos (solo si la tabla está vacía)
  const maestro = path.join(__dirname, '..', 'db', 'productos_iniciales.csv');
  const { rows: cnt } = await pool.query('SELECT count(*)::int AS n FROM productos');
  if (Number(cnt[0].n) === 0 && fs.existsSync(maestro)) {
    const productos = productosDesdeMaestro(fs.readFileSync(maestro, 'utf8'));
    for (const p of productos) {
      await pool.query(
        `INSERT INTO productos (codigo, nombre, categoria, unidad, activo) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (codigo) DO NOTHING`,
        [p.codigo, p.nombre.slice(0, 200), p.categoria ? p.categoria.slice(0, 80) : null, p.unidad, p.activo]
      );
    }
    console.log(`Maestro inicial cargado: ${productos.length} productos`);
  }

  // Proveedores iniciales tomados del maestro (solo si no hay ninguno)
  const { rows: cp } = await pool.query('SELECT count(*)::int AS n FROM proveedores');
  if (Number(cp[0].n) === 0 && fs.existsSync(maestro)) {
    const nombres = [...new Set(productosDesdeMaestro(fs.readFileSync(maestro, 'utf8')).map((p) => p.proveedor).filter(Boolean))];
    for (const n of nombres) {
      await pool.query('INSERT INTO proveedores (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [n.slice(0, 150)]);
    }
    if (nombres.length) console.log(`Proveedores iniciales: ${nombres.join(', ')}`);
  }

  // Maestro de proveedores (una sola vez): crea los que faltan y completa datos vacíos de los existentes
  const archProv = path.join(__dirname, '..', 'db', 'proveedores_iniciales.csv');
  const { rows: hecho } = await pool.query("SELECT 1 FROM app_config WHERE clave = 'seed_proveedores_v1'");
  if (!hecho.length && fs.existsSync(archProv)) {
    const filas = parseCSV(fs.readFileSync(archProv, 'utf8'));
    const head = filas[0];
    let creados = 0, completados = 0;
    for (const f of filas.slice(1)) {
      const r = Object.fromEntries(head.map((h, i) => [h, (f[i] || '').trim() || null]));
      if (!r.nombre) continue;
      const { rows: ex } = await pool.query('SELECT id FROM proveedores WHERE lower(trim(nombre)) = lower($1)', [r.nombre]);
      if (ex.length) {
        await pool.query(
          `UPDATE proveedores SET email = coalesce(nullif(email,''), $2), telefono = coalesce(nullif(telefono,''), $3),
             direccion = coalesce(nullif(direccion,''), $4), cuit = coalesce(nullif(cuit,''), $5), comentario = coalesce(nullif(comentario,''), $6)
           WHERE id = $1`, [ex[0].id, r.email, r.telefono, r.direccion, r.cuit, r.comentario]);
        completados++;
      } else {
        await pool.query(
          `INSERT INTO proveedores (nombre, email, telefono, direccion, cuit, comentario, activo) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (nombre) DO NOTHING`,
          [r.nombre.slice(0, 150), r.email, r.telefono, r.direccion, r.cuit, r.comentario, r.activo !== 'NO']);
        creados++;
      }
    }
    await pool.query("INSERT INTO app_config (clave, valor) VALUES ('seed_proveedores_v1', $1) ON CONFLICT (clave) DO NOTHING",
      [`creados ${creados}, completados ${completados}`]);
    console.log(`Maestro de proveedores: ${creados} creados, ${completados} existentes completados`);
  }

  // Vincular con Fudo: la planilla exportada de Fudo trae su Id (columna id_origen)
  const { rows: hecho2 } = await pool.query("SELECT 1 FROM app_config WHERE clave = 'vinculo_fudo_v1'");
  if (!hecho2.length && fs.existsSync(archProv)) {
    const filas = parseCSV(fs.readFileSync(archProv, 'utf8'));
    const head = filas[0];
    let n = 0;
    for (const f of filas.slice(1)) {
      const r = Object.fromEntries(head.map((h, i) => [h, (f[i] || '').trim()]));
      if (!r.id_origen || !r.nombre) continue;
      const { rowCount } = await pool.query(
        `UPDATE proveedores SET fudo_id = $1 WHERE fudo_id IS NULL AND lower(trim(nombre)) = lower($2)
           AND NOT EXISTS (SELECT 1 FROM proveedores x WHERE x.fudo_id = $1)`, [r.id_origen, r.nombre]);
      n += rowCount || 0;
    }
    await pool.query("INSERT INTO app_config (clave, valor) VALUES ('vinculo_fudo_v1', $1) ON CONFLICT (clave) DO NOTHING", [`vinculados ${n}`]);
    console.log(`Proveedores vinculados a Fudo por Id: ${n}`);
  }
}

module.exports = { pool, query, tx, migrate };
