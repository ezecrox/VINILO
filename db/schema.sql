-- Vinilo - Gestión de Almacén
-- Esquema idempotente: se ejecuta en cada arranque.

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(60)  NOT NULL UNIQUE,
  nombre        VARCHAR(120) NOT NULL,
  password_hash TEXT         NOT NULL,
  rol           VARCHAR(30)  NOT NULL,
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
-- (los roles válidos ahora están en la tabla roles; ver más abajo)

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

-- ===== Consumos importados desde ventas de Fudo =====
CREATE TABLE IF NOT EXISTS consumo_importaciones (
  id             SERIAL PRIMARY KEY,
  desde          TIMESTAMPTZ NOT NULL,
  hasta          TIMESTAMPTZ NOT NULL,
  estado         VARCHAR(20) NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR','CONFIRMADA','ANULADA')),
  almacen_id     INT REFERENCES almacenes(id),
  items_leidos   INT NOT NULL DEFAULT 0,
  items_cancelados INT NOT NULL DEFAULT 0,
  observacion    TEXT,
  movimiento_id  INT REFERENCES movimientos(id),
  creado_por     INT NOT NULL REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmado_por INT REFERENCES usuarios(id),
  confirmado_en  TIMESTAMPTZ,
  CHECK (hasta > desde)
);

CREATE TABLE IF NOT EXISTS consumo_import_items (
  id              SERIAL PRIMARY KEY,
  importacion_id  INT NOT NULL REFERENCES consumo_importaciones(id) ON DELETE CASCADE,
  fudo_product_id VARCHAR(20),
  producto_id     INT REFERENCES productos(id),      -- NULL si el producto de Fudo no está en la app
  nombre_fudo     VARCHAR(200),
  cantidad_vendida NUMERIC(12,3) NOT NULL DEFAULT 0,
  cantidad        INT NOT NULL DEFAULT 0 CHECK (cantidad >= 0),  -- a consumir (editable)
  incluir         BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_cii_imp ON consumo_import_items (importacion_id);
CREATE INDEX IF NOT EXISTS idx_ci_estado ON consumo_importaciones (estado, hasta);

-- ===== Stock mínimo por almacén (punto de reposición) =====
CREATE TABLE IF NOT EXISTS stock_minimos (
  almacen_id  INT NOT NULL REFERENCES almacenes(id),
  producto_id INT NOT NULL REFERENCES productos(id),
  minimo      INT NOT NULL CHECK (minimo > 0),
  PRIMARY KEY (almacen_id, producto_id)
);

-- ===== Roles configurables =====
CREATE TABLE IF NOT EXISTS roles (
  codigo      VARCHAR(30) PRIMARY KEY,
  nombre      VARCHAR(80) NOT NULL,
  descripcion TEXT,
  permisos    TEXT NOT NULL DEFAULT '',   -- claves separadas por coma
  almacenes   TEXT,                       -- ids separados por coma; NULL = todos
  sistema     BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO roles (codigo, nombre, descripcion, permisos, sistema) VALUES
  ('ADMIN', 'Administrador', 'Acceso total a parametrizaciones y transacciones', '', TRUE),
  ('RECEPTOR', 'Receptor', 'Recibe, transfiere, registra consumos y atiende pedidos',
     'verStock,verPedidos,atenderPedido,verCompras,recibir,transferir,consumir,verMovimientos', TRUE),
  ('ENCARGADO', 'Encargado', 'Consulta stock y movimientos; define stock mínimo',
     'verStock,minimos,verPedidos,verCompras,verMovimientos', TRUE),
  ('REQUIRENTE', 'Requirente', 'Hace notas de pedido de transferencia', 'verPedidos,crearPedido', TRUE),
  ('PROVEEDOR', 'Proveedor', 'Portal del proveedor: solo sus pedidos y documentos', 'portalProveedor', TRUE)
ON CONFLICT (codigo) DO NOTHING;

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ALTER COLUMN rol TYPE VARCHAR(30);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_rol_fk') THEN
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_fk FOREIGN KEY (rol) REFERENCES roles(codigo) ON UPDATE CASCADE;
  END IF;
END $$;

-- ===== Registro de accesos (solo ADMIN) =====
CREATE TABLE IF NOT EXISTS login_log (
  id          SERIAL PRIMARY KEY,
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id  INT REFERENCES usuarios(id),
  username    VARCHAR(120),
  evento      VARCHAR(20) NOT NULL,   -- INGRESO / FALLIDO / SALIDA
  motivo      VARCHAR(60),
  ip          VARCHAR(60),
  user_agent  VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS idx_login_fecha ON login_log (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_login_user ON login_log (usuario_id, fecha DESC);
DELETE FROM login_log WHERE fecha < now() - interval '400 days';

ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS proveedor_id INT REFERENCES proveedores(id);
CREATE INDEX IF NOT EXISTS idx_mov_prov ON movimientos (proveedor_id);

-- Gestión de stock: si es FALSE el producto solo existe en el maestro (no se transacciona)
ALTER TABLE productos ADD COLUMN IF NOT EXISTS gestion_stock BOOLEAN NOT NULL DEFAULT TRUE;

-- ===== Producción =====
ALTER TABLE productos ADD COLUMN IF NOT EXISTS gestion_produccion BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS recetas (
  producto_id  INT PRIMARY KEY REFERENCES productos(id) ON DELETE CASCADE,
  rendimiento  INT NOT NULL DEFAULT 1 CHECK (rendimiento > 0),   -- unidades que rinde una tanda
  instrucciones TEXT,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS receta_insumos (
  producto_id INT NOT NULL REFERENCES recetas(producto_id) ON DELETE CASCADE,
  insumo_id   INT NOT NULL REFERENCES productos(id),
  cantidad    INT NOT NULL CHECK (cantidad > 0),                  -- por tanda
  PRIMARY KEY (producto_id, insumo_id),
  CHECK (producto_id <> insumo_id)
);
ALTER TABLE movimientos DROP CONSTRAINT IF EXISTS movimientos_tipo_check;
ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN ('RECEPCION','TRANSFERENCIA','CONSUMO','AJUSTE','PRODUCCION'));

-- ===== Personal: solicitudes de empleados =====
INSERT INTO roles (codigo, nombre, descripcion, permisos, sistema) VALUES
  ('EMPLEADO', 'Empleado', 'Pide adelantos de sueldo, vacaciones y licencias', 'solicitudes', TRUE)
ON CONFLICT (codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS solicitudes (
  id             SERIAL PRIMARY KEY,
  usuario_id     INT NOT NULL REFERENCES usuarios(id),
  tipo           VARCHAR(20) NOT NULL CHECK (tipo IN ('ADELANTO','VACACIONES','EXAMEN','ENFERMEDAD','MATRIMONIO','NACIMIENTO','FALLECIMIENTO','MUDANZA','TRAMITE','OTRO')),
  desde          DATE,
  hasta          DATE,
  dias           INT,
  monto          NUMERIC(12,2),
  monto_aprobado NUMERIC(12,2),
  motivo         TEXT,
  estado         VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','APROBADA','RECHAZADA','CANCELADA')),
  respuesta      TEXT,
  resuelto_por   INT REFERENCES usuarios(id),
  resuelto_en    TIMESTAMPTZ,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (hasta IS NULL OR desde IS NULL OR hasta >= desde)
);
CREATE INDEX IF NOT EXISTS idx_sol_usuario ON solicitudes (usuario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_sol_estado ON solicitudes (estado);

CREATE TABLE IF NOT EXISTS solicitud_archivos (
  id             SERIAL PRIMARY KEY,
  solicitud_id   INT NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
  nombre_archivo VARCHAR(200) NOT NULL,
  mime           VARCHAR(120) NOT NULL,
  tamano         INT NOT NULL,
  contenido      BYTEA NOT NULL,
  subido_por     INT NOT NULL REFERENCES usuarios(id),
  subido_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_solarch ON solicitud_archivos (solicitud_id);
