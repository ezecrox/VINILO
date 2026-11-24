const fs = require('fs');
const path = require('path');
const pg = require('pg');
const { hashPassword } = require('./auth');
const { productosDesdeMaestro } = require('./csv');

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
  await pool.query(sql);

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
}

module.exports = { pool, query, tx, migrate };
