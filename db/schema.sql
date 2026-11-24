-- Vinilo - Gestión de Almacén
-- Esquema idempotente: se ejecuta en cada arranque.

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(60)  NOT NULL UNIQUE,
  nombre        VARCHAR(120) NOT NULL,
  password_hash TEXT         NOT NULL,
  rol           VARCHAR(20)  NOT NULL CHECK (rol IN ('ADMIN','RECEPTOR','ENCARGADO','REQUIRENTE')),
  activo        BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS almacenes (
  id        SERIAL PRIMARY KEY,
  nombre    VARCHAR(80) NOT NULL UNIQUE,
  activo    BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS productos (
  id                 SERIAL PRIMARY KEY,
  codigo             VARCHAR(40)  NOT NULL UNIQUE,
  nombre             VARCHAR(200) NOT NULL,
  categoria          VARCHAR(80),
  unidad             VARCHAR(20)  NOT NULL DEFAULT 'UN',
  alerta_vencimiento BOOLEAN      NOT NULL DEFAULT FALSE,  -- vencimiento próximo
  fecha_vencimiento  DATE,
  alerta_cuidado     BOOLEAN      NOT NULL DEFAULT FALSE,  -- producto de cuidado
  alerta_frio        BOOLEAN      NOT NULL DEFAULT FALSE,  -- cadena de frío
  nota_alerta        TEXT,
  activo             BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock (
  almacen_id  INT NOT NULL REFERENCES almacenes(id),
  producto_id INT NOT NULL REFERENCES productos(id),
  cantidad    INT NOT NULL DEFAULT 0 CHECK (cantidad >= 0),
  PRIMARY KEY (almacen_id, producto_id)
);

CREATE TABLE IF NOT EXISTS pedidos (
  id             SERIAL PRIMARY KEY,
  solicitante_id INT NOT NULL REFERENCES usuarios(id),
  origen_id      INT NOT NULL REFERENCES almacenes(id),
  destino_id     INT NOT NULL REFERENCES almacenes(id),
  estado         VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE'
                 CHECK (estado IN ('PENDIENTE','COMPLETADO','RECHAZADO','CANCELADO')),
  observacion    TEXT,
  motivo_rechazo TEXT,
  atendido_por   INT REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atendido_en    TIMESTAMPTZ,
  CHECK (origen_id <> destino_id)
);

CREATE TABLE IF NOT EXISTS pedido_items (
  id                 SERIAL PRIMARY KEY,
  pedido_id          INT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id        INT NOT NULL REFERENCES productos(id),
  cantidad           INT NOT NULL CHECK (cantidad > 0),
  cantidad_entregada INT NOT NULL DEFAULT 0 CHECK (cantidad_entregada >= 0)
);

CREATE TABLE IF NOT EXISTS movimientos (
  id          SERIAL PRIMARY KEY,
  tipo        VARCHAR(20) NOT NULL CHECK (tipo IN ('RECEPCION','TRANSFERENCIA','CONSUMO','AJUSTE')),
  origen_id   INT REFERENCES almacenes(id),
  destino_id  INT REFERENCES almacenes(id),
  usuario_id  INT NOT NULL REFERENCES usuarios(id),
  pedido_id   INT REFERENCES pedidos(id),
  referencia  VARCHAR(120),   -- remito, proveedor, etc.
  observacion TEXT,
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS movimiento_items (
  id            SERIAL PRIMARY KEY,
  movimiento_id INT NOT NULL REFERENCES movimientos(id) ON DELETE CASCADE,
  producto_id   INT NOT NULL REFERENCES productos(id),
  cantidad      INT NOT NULL CHECK (cantidad <> 0)  -- en AJUSTE puede ser negativa
);

CREATE INDEX IF NOT EXISTS idx_mov_fecha   ON movimientos (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_movi_mov    ON movimiento_items (movimiento_id);
CREATE INDEX IF NOT EXISTS idx_movi_prod   ON movimiento_items (producto_id);
CREATE INDEX IF NOT EXISTS idx_pedido_est  ON pedidos (estado);
CREATE INDEX IF NOT EXISTS idx_pitems_ped  ON pedido_items (pedido_id);

-- Almacenes iniciales
INSERT INTO almacenes (nombre) VALUES ('CENTRAL'), ('VINILO BAR'), ('EL GALPON VINILO')
ON CONFLICT (nombre) DO NOTHING;
