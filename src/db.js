const fs = require('fs');
const path = require('path');
const pg = require('pg');
const { hashPassword } = require('./auth');

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
}

module.exports = { pool, query, tx, migrate };
