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

-- ===== Compras a proveedores =====
CREATE TABLE IF NOT EXISTS proveedores (
  id        SERIAL PRIMARY KEY,
  nombre    VARCHAR(150) NOT NULL UNIQUE,
  cuit      VARCHAR(20),
  email     VARCHAR(150),
  telefono  VARCHAR(50),
  contacto  VARCHAR(120),
  activo    BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permiso_compras BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS proveedor_id INT REFERENCES proveedores(id);
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('ADMIN','RECEPTOR','ENCARGADO','REQUIRENTE','PROVEEDOR'));

CREATE TABLE IF NOT EXISTS ordenes_compra (
  id             SERIAL PRIMARY KEY,
  proveedor_id   INT NOT NULL REFERENCES proveedores(id),
  almacen_id     INT NOT NULL REFERENCES almacenes(id),   -- almacén de entrega
  estado         VARCHAR(20) NOT NULL DEFAULT 'BORRADOR'
                 CHECK (estado IN ('BORRADOR','CONFIRMADA','PARCIAL','RECIBIDA','CERRADA','ANULADA')),
  fecha_entrega  DATE,
  observacion    TEXT,
  creado_por     INT NOT NULL REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmado_por INT REFERENCES usuarios(id),
  confirmado_en  TIMESTAMPTZ,
  cerrado_por    INT REFERENCES usuarios(id),
  cerrado_en     TIMESTAMPTZ,
  motivo_cierre  TEXT
);

CREATE TABLE IF NOT EXISTS oc_items (
  id                SERIAL PRIMARY KEY,
  oc_id             INT NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  producto_id       INT NOT NULL REFERENCES productos(id),
  cantidad          INT NOT NULL CHECK (cantidad > 0),
  cantidad_recibida INT NOT NULL DEFAULT 0 CHECK (cantidad_recibida >= 0)
);

CREATE TABLE IF NOT EXISTS oc_archivos (
  id             SERIAL PRIMARY KEY,
  oc_id          INT NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  tipo           VARCHAR(20) NOT NULL CHECK (tipo IN ('REMITO','FACTURA','OTRO')),
  numero         VARCHAR(60),
  nombre_archivo VARCHAR(200) NOT NULL,
  mime           VARCHAR(120) NOT NULL,
  tamano         INT NOT NULL,
  contenido      BYTEA NOT NULL,
  subido_por     INT NOT NULL REFERENCES usuarios(id),
  subido_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS oc_id INT REFERENCES ordenes_compra(id);

CREATE INDEX IF NOT EXISTS idx_oc_estado    ON ordenes_compra (estado);
CREATE INDEX IF NOT EXISTS idx_oc_prov      ON ordenes_compra (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_ocitems_oc   ON oc_items (oc_id);
CREATE INDEX IF NOT EXISTS idx_ocarch_oc    ON oc_archivos (oc_id);
CREATE INDEX IF NOT EXISTS idx_mov_oc       ON movimientos (oc_id);

ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS direccion  VARCHAR(200);
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS comentario TEXT;

-- Marcas de cargas iniciales ya realizadas
CREATE TABLE IF NOT EXISTS app_config (
  clave VARCHAR(60) PRIMARY KEY,
  valor TEXT,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Integración Fudo =====
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS fudo_id VARCHAR(20);
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS fudo_sync_en TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_prov_fudo ON proveedores (fudo_id) WHERE fudo_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fudo_sync_log (
  id            SERIAL PRIMARY KEY,
  entidad       VARCHAR(30) NOT NULL DEFAULT 'proveedores',
  origen        VARCHAR(20) NOT NULL,          -- AUTO / MANUAL / ARRANQUE
  inicio        TIMESTAMPTZ NOT NULL DEFAULT now(),
  fin           TIMESTAMPTZ,
  ok            BOOLEAN,
  leidos        INT DEFAULT 0,
  creados       INT DEFAULT 0,
  actualizados  INT DEFAULT 0,
  desactivados  INT DEFAULT 0,
  detalle       TEXT
);

ALTER TABLE productos ADD COLUMN IF NOT EXISTS fudo_id VARCHAR(20);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS fudo_sync_en TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_fudo ON productos (fudo_id) WHERE fudo_id IS NOT NULL;
