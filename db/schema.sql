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
  ('EMPLEADO', 'Empleado', 'Pide adelantos de sueldo, vacaciones y licencias y ve sus horas', 'solicitudes,misHoras', TRUE)
ON CONFLICT (codigo) DO NOTHING;
-- Una sola vez: el rol Empleado existente pasa a ver "Mis horas"
UPDATE roles SET permisos = permisos || ',misHoras', descripcion = 'Pide adelantos de sueldo, vacaciones y licencias y ve sus horas'
 WHERE codigo = 'EMPLEADO' AND (',' || permisos || ',') NOT LIKE '%,misHoras,%'
   AND NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'rol_empleado_mis_horas');
INSERT INTO app_config (clave, valor) VALUES ('rol_empleado_mis_horas', '1') ON CONFLICT (clave) DO NOTHING;

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

-- ===== CrossChex Cloud (reloj de asistencia) =====
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS legajo VARCHAR(30);   -- N° de empleado en el reloj (workno)
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_legajo ON usuarios (legajo) WHERE legajo IS NOT NULL AND legajo <> '';
CREATE TABLE IF NOT EXISTS fichadas (
  id          SERIAL PRIMARY KEY,
  workno      VARCHAR(30) NOT NULL,
  nombre      VARCHAR(150),
  checktime   TIMESTAMPTZ NOT NULL,
  checktype   INT,
  device_sn   VARCHAR(60) NOT NULL DEFAULT '',
  device_name VARCHAR(120),
  importado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workno, checktime, device_sn)
);
CREATE INDEX IF NOT EXISTS idx_fichadas_time ON fichadas (checktime);
CREATE INDEX IF NOT EXISTS idx_fichadas_workno ON fichadas (workno, checktime);

-- ===== Limpieza única de datos de prueba (pedido del 25/11/2026) =====
-- Borra notas de pedido, pedidos a proveedores, movimientos (recepción, transferencia, consumo,
-- producción, ajuste), importaciones de consumos de Fudo y solicitudes del personal; deja el stock en cero.
-- Se ejecuta una sola vez (marca en app_config). No toca productos, proveedores, usuarios, roles,
-- almacenes, mínimos, recetas ni fichadas del reloj.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'limpieza_transacciones_20261125') THEN
    TRUNCATE consumo_import_items, consumo_importaciones, movimiento_items, movimientos,
             pedido_items, pedidos, oc_archivos, oc_items, ordenes_compra,
             solicitud_archivos, solicitudes, stock RESTART IDENTITY;
    INSERT INTO app_config (clave, valor) VALUES ('limpieza_transacciones_20261125', now()::text);
    RAISE NOTICE 'Limpieza de transacciones realizada';
  END IF;
END $$;

-- ===== Sucursales y programación de días de trabajo =====
CREATE TABLE IF NOT EXISTS sucursales (
  id         SERIAL PRIMARY KEY,
  nombre     VARCHAR(80) NOT NULL UNIQUE,
  direccion  VARCHAR(200),
  activo     BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'seed_sucursales') THEN
    INSERT INTO sucursales (nombre) VALUES ('VINILO BAR'), ('VINILO GALPON') ON CONFLICT (nombre) DO NOTHING;
    INSERT INTO app_config (clave, valor) VALUES ('seed_sucursales', '1');
  END IF;
END $$;

-- Un empleado puede estar en una o varias sucursales
CREATE TABLE IF NOT EXISTS usuario_sucursales (
  usuario_id  INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  sucursal_id INT NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, sucursal_id)
);

-- Días calendario programados para trabajar (sin fila = no trabaja / franco)
CREATE TABLE IF NOT EXISTS programacion (
  id          SERIAL PRIMARY KEY,
  usuario_id  INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  sucursal_id INT NOT NULL REFERENCES sucursales(id),
  fecha       DATE NOT NULL,
  hora_desde  TIME,
  hora_hasta  TIME,
  nota        VARCHAR(200),
  creado_por  INT REFERENCES usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, fecha, sucursal_id)
);
CREATE INDEX IF NOT EXISTS programacion_fecha_idx ON programacion (fecha);

-- ===== Eventos (fiesta, show, privado…) con el personal asignado =====
CREATE TABLE IF NOT EXISTS eventos (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(120) NOT NULL,
  sucursal_id INT NOT NULL REFERENCES sucursales(id),
  fecha       DATE NOT NULL,
  hora_desde  TIME,
  hora_hasta  TIME,
  descripcion VARCHAR(500),
  creado_por  INT REFERENCES usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eventos_fecha_idx ON eventos (fecha);
-- El personal de un evento se guarda como días programados vinculados al evento
ALTER TABLE programacion ADD COLUMN IF NOT EXISTS evento_id INT REFERENCES eventos(id) ON DELETE CASCADE;

-- Limpieza única de la programación cargada en pruebas (pedido del 25/11/2026). No toca sucursales ni asignaciones.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'limpieza_programacion_20261125') THEN
    DELETE FROM programacion;
    DELETE FROM eventos;
    INSERT INTO app_config (clave, valor) VALUES ('limpieza_programacion_20261125', now()::text);
  END IF;
END $$;

-- ===== Avisos por WhatsApp (WhatsApp Cloud API de Meta) =====
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefono VARCHAR(30);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_ok BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS whatsapp_ok BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS notificaciones (
  id           SERIAL PRIMARY KEY,
  canal        VARCHAR(20) NOT NULL DEFAULT 'WHATSAPP',
  evento       VARCHAR(40) NOT NULL,
  referencia   VARCHAR(60),
  usuario_id   INT REFERENCES usuarios(id) ON DELETE SET NULL,
  proveedor_id INT REFERENCES proveedores(id) ON DELETE SET NULL,
  destinatario VARCHAR(150),
  telefono     VARCHAR(30),
  plantilla    VARCHAR(80),
  parametros   TEXT,
  texto        TEXT,
  estado       VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','ENVIADA','ERROR','OMITIDA')),
  detalle      TEXT,
  mensaje_id   VARCHAR(120),
  intentos     INT NOT NULL DEFAULT 0,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_en   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notificaciones_creado_idx ON notificaciones (creado_en DESC);

-- ===== Conteo de inventario desde el celular =====
ALTER TABLE productos ADD COLUMN IF NOT EXISTS codigo_barras VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS productos_codigo_barras_uq ON productos (codigo_barras) WHERE codigo_barras IS NOT NULL;
CREATE TABLE IF NOT EXISTS conteos (
  id            SERIAL PRIMARY KEY,
  almacen_id    INT NOT NULL REFERENCES almacenes(id),
  estado        VARCHAR(20) NOT NULL DEFAULT 'EN_CURSO' CHECK (estado IN ('EN_CURSO','APLICADO','ANULADO')),
  categoria     VARCHAR(80),                       -- NULL = todos los productos con gestión de stock
  ciego         BOOLEAN NOT NULL DEFAULT TRUE,     -- quien cuenta no ve el stock del sistema
  observacion   TEXT,
  creado_por    INT NOT NULL REFERENCES usuarios(id),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_por   INT REFERENCES usuarios(id),
  cerrado_en    TIMESTAMPTZ,
  no_contados   VARCHAR(10),                       -- MANTENER | CERO (al aplicar)
  movimiento_id INT REFERENCES movimientos(id)
);
-- Un conteo en curso por almacén y rubro (se pueden abrir varios a la vez si son de rubros distintos)
DROP INDEX IF EXISTS conteos_uno_en_curso;
CREATE UNIQUE INDEX IF NOT EXISTS conteos_en_curso_rubro ON conteos (almacen_id, coalesce(categoria, '')) WHERE estado = 'EN_CURSO';
CREATE TABLE IF NOT EXISTS conteo_items (
  conteo_id   INT NOT NULL REFERENCES conteos(id) ON DELETE CASCADE,
  producto_id INT NOT NULL REFERENCES productos(id),
  cantidad    INT NOT NULL CHECK (cantidad >= 0),
  contado_por INT REFERENCES usuarios(id),
  contado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conteo_id, producto_id)
);
-- Una sola vez: quien ya podía ajustar inventario también puede contar
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'permiso_contar') THEN
    UPDATE roles SET permisos = permisos || ',contar' WHERE (',' || permisos || ',') LIKE '%,ajustar,%' AND (',' || permisos || ',') NOT LIKE '%,contar,%';
    INSERT INTO app_config (clave, valor) VALUES ('permiso_contar', '1');
  END IF;
END $$;

-- Limpieza única (pedido del 25/11/2026): conteos de prueba y la solicitud de vacaciones de Nico Aguilar
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'limpieza_conteos_solicitud_20261125') THEN
    DELETE FROM conteos WHERE movimiento_id IS NULL;   -- ninguno fue aplicado: no hay stock que revertir
    DELETE FROM solicitudes s USING usuarios u
     WHERE u.id = s.usuario_id AND u.nombre = 'Nico Aguilar' AND s.tipo = 'VACACIONES' AND s.desde = DATE '2026-12-01' AND s.hasta = DATE '2026-12-08';
    INSERT INTO app_config (clave, valor) VALUES ('limpieza_conteos_solicitud_20261125', now()::text);
  END IF;
END $$;

-- ===== Notificaciones push (Web Push) =====
CREATE TABLE IF NOT EXISTS push_suscripciones (
  id          SERIAL PRIMARY KEY,
  usuario_id  INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      VARCHAR(200) NOT NULL,
  auth        VARCHAR(100) NOT NULL,
  dispositivo VARCHAR(200),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_ok   TIMESTAMPTZ,
  fallos      INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_programadas (
  id           SERIAL PRIMARY KEY,
  titulo       VARCHAR(80) NOT NULL,
  mensaje      VARCHAR(300) NOT NULL,
  link         VARCHAR(120),
  roles        TEXT NOT NULL DEFAULT '',        -- códigos de rol separados por coma ('' = todos)
  dias         VARCHAR(20) NOT NULL,            -- 0=domingo … 6=sábado, separados por coma
  hora         VARCHAR(5) NOT NULL,             -- HH:MM (hora de Argentina)
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por   INT REFERENCES usuarios(id),
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_envio TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS push_envios (
  id            SERIAL PRIMARY KEY,
  programada_id INT REFERENCES push_programadas(id) ON DELETE SET NULL,
  origen        VARCHAR(20) NOT NULL,           -- PROGRAMADA | MANUAL | PRUEBA
  titulo        VARCHAR(80),
  mensaje       VARCHAR(300),
  roles         TEXT,
  usuarios      INT NOT NULL DEFAULT 0,
  dispositivos  INT NOT NULL DEFAULT 0,
  enviados      INT NOT NULL DEFAULT 0,
  fallidos      INT NOT NULL DEFAULT 0,
  sin_activar   INT NOT NULL DEFAULT 0,         -- usuarios del rol sin notificaciones activadas
  enviado_por   INT REFERENCES usuarios(id),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Checklist de apertura y cierre =====
CREATE TABLE IF NOT EXISTS checklist_plantillas (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(80) NOT NULL,
  tipo        VARCHAR(20) NOT NULL DEFAULT 'OTRO' CHECK (tipo IN ('APERTURA','CIERRE','OTRO')),
  sucursal_id INT REFERENCES sucursales(id),     -- NULL = todas las sucursales
  hora_limite VARCHAR(5),                        -- HH:MM: después de esa hora el panel lo marca urgente
  activo      BOOLEAN NOT NULL DEFAULT TRUE,
  orden       INT NOT NULL DEFAULT 0,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id           SERIAL PRIMARY KEY,
  plantilla_id INT NOT NULL REFERENCES checklist_plantillas(id) ON DELETE CASCADE,
  seccion      VARCHAR(60),
  texto        VARCHAR(200) NOT NULL,
  orden        INT NOT NULL DEFAULT 0,
  tipo_valor   VARCHAR(10) CHECK (tipo_valor IN ('NUMERO','TEXTO')),
  unidad       VARCHAR(20),
  obligatorio  BOOLEAN NOT NULL DEFAULT TRUE,
  activo       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS checklist_registros (
  id             SERIAL PRIMARY KEY,
  plantilla_id   INT NOT NULL REFERENCES checklist_plantillas(id),
  sucursal_id    INT NOT NULL REFERENCES sucursales(id),
  jornada        DATE NOT NULL,
  estado         VARCHAR(20) NOT NULL DEFAULT 'EN_CURSO' CHECK (estado IN ('EN_CURSO','COMPLETO')),
  iniciado_por   INT REFERENCES usuarios(id),
  iniciado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completado_por INT REFERENCES usuarios(id),
  completado_en  TIMESTAMPTZ,
  observacion    TEXT,
  UNIQUE (plantilla_id, sucursal_id, jornada)
);
CREATE TABLE IF NOT EXISTS checklist_respuestas (
  registro_id INT NOT NULL REFERENCES checklist_registros(id) ON DELETE CASCADE,
  item_id     INT NOT NULL REFERENCES checklist_items(id),
  hecho       BOOLEAN NOT NULL DEFAULT FALSE,
  valor       VARCHAR(60),
  nota        VARCHAR(300),
  usuario_id  INT REFERENCES usuarios(id),
  hecho_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (registro_id, item_id)
);
DO $$
DECLARE ap INT; ci INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'seed_checklist') THEN
    INSERT INTO checklist_plantillas (nombre, tipo, hora_limite, orden) VALUES ('Apertura', 'APERTURA', '20:00', 1) RETURNING id INTO ap;
    INSERT INTO checklist_items (plantilla_id, seccion, texto, orden, tipo_valor, unidad, obligatorio) VALUES
      (ap, 'Salón', 'Encender luces, música y cartel', 1, NULL, NULL, TRUE),
      (ap, 'Salón', 'Salón, mesas y sillas limpias y en su lugar', 2, NULL, NULL, TRUE),
      (ap, 'Salón', 'Baños limpios y con papel, jabón y toallas', 3, NULL, NULL, TRUE),
      (ap, 'Barra', 'Temperatura de heladeras de barra', 4, 'NUMERO', '°C', TRUE),
      (ap, 'Barra', 'Reponer bebidas en heladeras', 5, NULL, NULL, TRUE),
      (ap, 'Barra', 'Hielo cargado', 6, NULL, NULL, TRUE),
      (ap, 'Barra', 'Cristalería y vajilla limpias', 7, NULL, NULL, TRUE),
      (ap, 'Cocina', 'Temperatura de cámara / heladera de cocina', 8, 'NUMERO', '°C', TRUE),
      (ap, 'Cocina', 'Temperatura del freezer', 9, 'NUMERO', '°C', TRUE),
      (ap, 'Cocina', 'Encender equipos (horno, freidora, plancha)', 10, NULL, NULL, TRUE),
      (ap, 'Cocina', 'Mise en place lista', 11, NULL, NULL, TRUE),
      (ap, 'Cocina', 'Revisar vencimientos de productos abiertos', 12, NULL, NULL, TRUE),
      (ap, 'Caja', 'Cambio inicial en caja', 13, 'NUMERO', '$', TRUE),
      (ap, 'Caja', 'Fudo y posnet funcionando', 14, NULL, NULL, TRUE),
      (ap, 'Caja', 'Revisar reservas y eventos del día', 15, NULL, NULL, FALSE);
    INSERT INTO checklist_plantillas (nombre, tipo, hora_limite, orden) VALUES ('Cierre', 'CIERRE', '05:00', 2) RETURNING id INTO ci;
    INSERT INTO checklist_items (plantilla_id, seccion, texto, orden, tipo_valor, unidad, obligatorio) VALUES
      (ci, 'Caja', 'Cerrar caja en Fudo', 1, NULL, NULL, TRUE),
      (ci, 'Caja', 'Efectivo contado', 2, 'NUMERO', '$', TRUE),
      (ci, 'Caja', 'Efectivo guardado en caja fuerte', 3, NULL, NULL, TRUE),
      (ci, 'Cocina', 'Alimentos guardados, tapados y rotulados con fecha', 4, NULL, NULL, TRUE),
      (ci, 'Cocina', 'Temperatura de cámara / heladera de cocina', 5, 'NUMERO', '°C', TRUE),
      (ci, 'Cocina', 'Hornos, freidoras, plancha y gas apagados', 6, NULL, NULL, TRUE),
      (ci, 'Cocina', 'Cocina y equipos limpios', 7, NULL, NULL, TRUE),
      (ci, 'Barra', 'Barra y cristalería limpias', 8, NULL, NULL, TRUE),
      (ci, 'Barra', 'Temperatura de heladeras de barra', 9, 'NUMERO', '°C', TRUE),
      (ci, 'Barra', 'Botellas abiertas tapadas y guardadas', 10, NULL, NULL, TRUE),
      (ci, 'Salón', 'Salón y baños limpios', 11, NULL, NULL, TRUE),
      (ci, 'Salón', 'Basura y reciclables afuera', 12, NULL, NULL, TRUE),
      (ci, 'Salón', 'Luces, aire, música y cartel apagados', 13, NULL, NULL, TRUE),
      (ci, 'Salón', 'Puertas y ventanas cerradas, alarma activada', 14, NULL, NULL, TRUE),
      (ci, 'Salón', 'Novedades para el turno siguiente', 15, 'TEXTO', NULL, FALSE);
    -- Quien atiende el local completa los checklists
    UPDATE roles SET permisos = permisos || ',checklist' WHERE codigo IN ('EMPLEADO','ENCARGADO') AND (',' || permisos || ',') NOT LIKE '%,checklist,%';
    INSERT INTO app_config (clave, valor) VALUES ('seed_checklist', '1');
  END IF;
END $$;

-- Avisos del administrador que aparecen en el Panel de los usuarios
CREATE TABLE IF NOT EXISTS avisos (
  id          SERIAL PRIMARY KEY,
  titulo      VARCHAR(120) NOT NULL,
  mensaje     TEXT NOT NULL,
  tipo        VARCHAR(12) NOT NULL DEFAULT 'INFO',      -- INFO | IMPORTANTE | URGENTE
  roles       TEXT NOT NULL DEFAULT '',                 -- CSV de códigos de rol ('' = todos)
  sucursales  TEXT NOT NULL DEFAULT '',                 -- CSV de ids de sucursal ('' = todas)
  desde       TIMESTAMPTZ NOT NULL DEFAULT now(),
  hasta       TIMESTAMPTZ,                              -- NULL = sin vencimiento
  activo      BOOLEAN NOT NULL DEFAULT TRUE,
  push        BOOLEAN NOT NULL DEFAULT FALSE,
  creado_por  INT REFERENCES usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS avisos_leidos (
  aviso_id   INT NOT NULL REFERENCES avisos(id) ON DELETE CASCADE,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  leido_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (aviso_id, usuario_id)
);

-- Juego QR "Pizzaiolo de la Noche": partidas de los comensales
CREATE TABLE IF NOT EXISTS juego_partidas (
  id           SERIAL PRIMARY KEY,
  token        VARCHAR(48) NOT NULL UNIQUE,
  sucursal_id  INT REFERENCES sucursales(id) ON DELETE SET NULL,
  mesa         INT,
  nombre       VARCHAR(20) NOT NULL,
  jornada      DATE NOT NULL,
  estado       VARCHAR(10) NOT NULL DEFAULT 'JUGANDO',   -- JUGANDO | TERMINADA
  preguntas    TEXT NOT NULL DEFAULT '[]',                -- índices correctos (no se mandan al celular)
  puntos       INT NOT NULL DEFAULT 0,
  r1 INT, r2 INT, r3 INT,
  ip           VARCHAR(64),
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminado_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS juego_partidas_rank ON juego_partidas (sucursal_id, jornada, estado, puntos DESC);

-- Una sola vez: quien ya podía ajustar inventario también puede cerrar (aplicar/anular) cualquier conteo
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'permiso_cerrar_conteo') THEN
    UPDATE roles SET permisos = permisos || ',cerrarConteo' WHERE (',' || permisos || ',') LIKE '%,ajustar,%' AND (',' || permisos || ',') NOT LIKE '%,cerrarConteo,%';
    INSERT INTO app_config (clave, valor) VALUES ('permiso_cerrar_conteo', '1');
  END IF;
END $$;

-- Almacenes por sucursal (NULL = compartido entre sucursales, p. ej. CENTRAL)
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS sucursal_id INT REFERENCES sucursales(id) ON DELETE SET NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'almacenes_sucursal') THEN
    UPDATE almacenes a SET sucursal_id = (SELECT id FROM sucursales WHERE nombre ILIKE '%BAR%' ORDER BY id LIMIT 1) WHERE a.sucursal_id IS NULL AND a.nombre ILIKE '%BAR%';
    UPDATE almacenes a SET sucursal_id = (SELECT id FROM sucursales WHERE nombre ILIKE '%GALP%' ORDER BY id LIMIT 1) WHERE a.sucursal_id IS NULL AND a.nombre ILIKE '%GALP%';
    INSERT INTO app_config (clave, valor) VALUES ('almacenes_sucursal', '1');
  END IF;
END $$;

-- Productos por sucursal (un producto puede estar en una o en las dos) y vínculo con el Fudo de VINILO BAR
CREATE TABLE IF NOT EXISTS producto_sucursales (
  producto_id INT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  sucursal_id INT NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  PRIMARY KEY (producto_id, sucursal_id)
);
CREATE INDEX IF NOT EXISTS idx_prod_suc_suc ON producto_sucursales (sucursal_id);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS fudo_bar_id VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_fudo_bar ON productos (fudo_bar_id) WHERE fudo_bar_id IS NOT NULL;
ALTER TABLE consumo_importaciones ADD COLUMN IF NOT EXISTS cuenta VARCHAR(10) NOT NULL DEFAULT 'galpon';
-- Una sola vez: los productos que vienen del Fudo del Galpón quedan en VINILO GALPON
DO $$
DECLARE g INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE clave = 'productos_sucursal_galpon') THEN
    SELECT id INTO g FROM sucursales WHERE nombre ILIKE '%GALP%' ORDER BY id LIMIT 1;
    IF g IS NOT NULL THEN
      INSERT INTO producto_sucursales (producto_id, sucursal_id) SELECT id, g FROM productos WHERE fudo_id IS NOT NULL ON CONFLICT DO NOTHING;
    END IF;
    INSERT INTO app_config (clave, valor) VALUES ('productos_sucursal_galpon', '1');
  END IF;
END $$;

-- Consumo del personal: cliente de Fudo (cuenta corriente) de cada empleado, por cuenta de Fudo (galpon / bar)
CREATE TABLE IF NOT EXISTS usuario_fudo_clientes (
  usuario_id     INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  cuenta         VARCHAR(10) NOT NULL,
  cliente_id     VARCHAR(20) NOT NULL,
  cliente_nombre VARCHAR(200),
  PRIMARY KEY (cuenta, cliente_id)
);
CREATE INDEX IF NOT EXISTS idx_ufc_usuario ON usuario_fudo_clientes (usuario_id);
ALTER TABLE consumo_import_items ADD COLUMN IF NOT EXISTS usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL;
-- Detalle por venta de lo consumido por cada empleado (para "Mis consumos")
CREATE TABLE IF NOT EXISTS consumos_personal (
  id              SERIAL PRIMARY KEY,
  importacion_id  INT NOT NULL REFERENCES consumo_importaciones(id) ON DELETE CASCADE,
  usuario_id      INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  cuenta          VARCHAR(10) NOT NULL,
  venta_id        VARCHAR(30),
  fecha           TIMESTAMPTZ NOT NULL,
  fudo_product_id VARCHAR(20),
  producto_id     INT REFERENCES productos(id) ON DELETE SET NULL,
  nombre          VARCHAR(200),
  cantidad        NUMERIC(12,3) NOT NULL DEFAULT 0,
  importe         NUMERIC(14,2)
);
CREATE INDEX IF NOT EXISTS idx_cp_usuario ON consumos_personal (usuario_id, fecha);
CREATE INDEX IF NOT EXISTS idx_cp_imp ON consumos_personal (importacion_id);
