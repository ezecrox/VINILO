# VINILO APP

Aplicación web para controlar el stock (en unidades) de los almacenes **CENTRAL**, **VINILO BAR** y **EL GALPON VINILO**:
recepción de mercadería, transferencias entre depósitos, consumos, ajustes de inventario y notas de pedido.

- **Backend:** Node.js (sin framework) + PostgreSQL (única dependencia: `pg`)
- **Frontend:** HTML/CSS/JS sin dependencias, adaptable a celular
- **Despliegue:** Render (Blueprint `render.yaml` incluido)

## Roles

| Rol | Puede |
|---|---|
| **ADMIN** | Todo: usuarios, almacenes, productos y alertas, importación del maestro, recepción, transferencia, consumo, ajuste de inventario, notas de pedido, consultas |
| **RECEPTOR** | Recepción, transferencia entre depósitos, consumo, atender/rechazar notas de pedido, ver stock y movimientos |
| **ENCARGADO** | Ver stock por almacén (con filtros y exportación CSV), movimientos y notas de pedido |
| **REQUIRENTE** | Crear notas de pedido (solicitud de transferencia de un depósito a otro), ver y cancelar las propias |
| **PROVEEDOR** | Vinculado a un proveedor. Solo ve **sus** pedidos ya confirmados (lo pedido, lo recibido y lo pendiente) y sube remitos / facturas |

**Roles configurables:** en **Usuarios y roles → Roles** se elige, para cada rol, qué opciones del menú y acciones tiene habilitadas y **qué almacenes ve** (todos o una lista). Se pueden crear roles nuevos (p. ej. "Barra Galpón" que solo ve EL GALPON VINILO y registra consumos). La tabla de arriba describe la configuración inicial. ADMIN siempre tiene acceso total y PROVEEDOR solo a su portal. Un usuario solo ve el stock, los movimientos, pedidos y tareas de sus almacenes; para transferir o pedir mercadería puede elegir cualquier almacén como contraparte.

**Permiso de Compras:** el ADMIN lo puede sumar a cualquier usuario (ADMIN lo tiene siempre). Solo con este permiso se crean, confirman, cierran o anulan pedidos a proveedores.

> El consumo quedó habilitado para ADMIN y RECEPTOR. Para cambiarlo, editar el objeto `PUEDE` al principio de `server.js`.

## Funcionalidades

- **Panel de tareas pendientes:** al entrar, cada usuario ve lo que tiene que hacer según su rol, ordenado por urgencia: consumos de Fudo sin confirmar, ventas sin importar, mercadería de proveedores por recibir (con entregas vencidas), pedidos a proveedores sin confirmar o con faltantes, notas de pedido por atender, **productos para reponer** (bajo el stock mínimo, con sugerencia de transferir desde otro almacén o pedir a proveedor), productos por vencer y errores de sincronización con Fudo. El proveedor ve sus pedidos por entregar y los que no tienen remito.
- **Stock mínimo por almacén:** ADMIN y ENCARGADO lo cargan desde Stock por almacén (✎). Las celdas bajo mínimo se marcan en rojo y hay un filtro "Solo bajo mínimo".

- **Stock por almacén:** tabla con una columna por depósito y total, búsqueda, filtros por almacén / categoría / alerta, exportación CSV.
- **Gestión de stock por producto:** si está activada, el producto se opera en la app (recepción, transferencias, consumos, ajustes, notas de pedido, pedidos a proveedores, consumos de Fudo) y aparece en Stock, el panel y Vinilito. Si está desactivada, el producto solo figura en **Productos** (p. ej. tragos o platos de la carta). Se cambia desde la ficha, tocando la etiqueta en la lista o en forma masiva sobre los productos filtrados (por categoría). Columna opcional `gestion_stock` en el CSV del maestro.
- **Producción:** los productos con **Gestión de producción** (implica gestión de stock) tienen una **receta**: rendimiento por tanda e insumos por tanda (insumos = productos con gestión de stock). En **Operaciones → Producción** se elige producto, almacén y tandas; se ve el consumo según receta contra el stock, se puede corregir el consumo real y la cantidad obtenida, y al confirmar se descuentan los insumos y se suma lo producido en un movimiento **Producción**. Permiso `Producción` en el catálogo de roles (por defecto solo ADMIN).
- **Alertas por producto** (definidas por el ADMIN): ⏳ vencimiento próximo (con fecha opcional), ⚠ producto de cuidado, ❄ cadena de frío, y una nota libre. Se muestran en el stock, en los formularios de movimientos y en el panel.
- **Recepción:** ingreso a un almacén con referencia (remito / proveedor).
- **Transferencia:** valida stock disponible en el origen.
- **Consumo:** baja de stock por uso, venta, merma o rotura.
- **Ajuste de inventario (ADMIN):** se carga la cantidad contada y se registra la diferencia.
- **Notas de pedido:** el requirente pide productos de un depósito a otro; el receptor/admin la atiende (con entregas parciales si falta stock) y se genera la transferencia automáticamente, o la rechaza con motivo.
- **Pedidos a proveedores:** Compras arma la nota de pedido (proveedor, almacén de entrega, fecha prevista, productos) como borrador y la confirma; recién ahí el proveedor la ve. El proveedor sube el remito o la factura (PDF, foto, Excel, Word; máx. 8 MB, guardados en la base). El receptor registra lo que llegó y el sistema **valida contra lo pedido** ítem por ítem (completo / faltan N / excede N): admite entregas parciales, pide confirmación si llega más de lo pedido y genera la recepción de stock automáticamente. Estados: Borrador → Confirmada → Recepción parcial → Recibida, o Cerrada con faltante / Anulada. Se puede imprimir.
- **Movimientos:** historial completo con filtros y detalle; exportación CSV.
- Todas las operaciones son transaccionales: el stock nunca queda negativo.

## Despliegue en Render

1. Subí esta carpeta a un repositorio de GitHub (o GitLab).
2. En Render: **New → Blueprint** y elegí el repositorio. Render lee `render.yaml` y crea:
   - la base PostgreSQL `vinilo-db`
   - el servicio web `vinilo-almacen`
3. Cuando lo pida, cargá `ADMIN_PASSWORD` (la contraseña del usuario `admin`).
4. Al terminar el deploy, entrá a la URL del servicio con `admin` y esa contraseña.

Las tablas y los 3 almacenes se crean solos en el primer arranque.

**Planes:** el `render.yaml` usa `plan: free` para probar. En los planes gratuitos el servicio web se "duerme" sin uso y la base gratuita tiene vencimiento, así que para uso real conviene pasar ambos a un plan pago (cambiá `plan:` en `render.yaml` o desde el panel de Render).

### Despliegue manual (sin Blueprint)

1. Crear una base **PostgreSQL** en Render.
2. Crear un **Web Service** desde el repositorio: Build `npm install`, Start `node server.js`.
3. Variables de entorno:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | *Internal Database URL* de la base |
| `SESSION_SECRET` | una cadena larga aleatoria |
| `ADMIN_USER` | `admin` (opcional) |
| `ADMIN_PASSWORD` | contraseña inicial del admin |
| `PGSSL` | `true` solo si usás la URL externa de la base |

## Cargar el maestro de productos

El archivo `db/productos_iniciales.csv` (exportado del sistema de ventas) se carga automáticamente al arrancar **si la tabla de productos está vacía**. El código de cada producto es el **ID** del maestro y la categoría queda como `Categoría / Subcategoría`.

El importador de la pantalla acepta tanto ese mismo formato (ID, Categoría, Subcategoría, Código, Nombre, …, Activo) como la plantilla propia:

**Productos → Importar maestro** acepta un CSV (separado por `;` o `,`) con encabezado. Descargá la plantilla desde el botón **Plantilla CSV**.

| Columna | Obligatoria | Ejemplo |
|---|---|---|
| `codigo` | Sí | `BEB001` |
| `nombre` | Sí | `Cerveza rubia lata 473ml` |
| `categoria` | No | `Bebidas` |
| `unidad` | No (por defecto `UN`) | `UN` |
| `vencimiento_proximo` | No | `SI` |
| `fecha_vencimiento` | No | `2026-12-15` o `15/12/2026` |
| `cuidado` | No | `SI` |
| `cadena_frio` | No | `SI` |
| `nota_alerta` | No | `Conservar entre 2 y 8 °C` |
| `activo` | No (por defecto `SI`) | `SI` |

Si el código ya existe, el producto se actualiza (se puede reimportar sin duplicar). También se aceptan encabezados como `descripcion`, `rubro`, `sku`.

## Integración con Fudo (proveedores y productos)

La app trae los proveedores desde Fudo y mantiene sus cambios: crea los nuevos, actualiza nombre, email, teléfono, dirección, CUIT, comentario y estado, y deja **inactivos** los que se borran en Fudo. El campo *Contacto* es solo de esta app. La relación es por el **Id de Fudo** (los proveedores importados desde la planilla de Fudo ya quedan vinculados).

**Productos:** se traen nombre, categoría (`Categoría / Subcategoría`, igual que el maestro) y estado; los nuevos se crean con código = ID de Fudo y los borrados quedan inactivos. **Stock, unidad y alertas no se tocan**: se manejan solo en esta app. Los 199 productos del maestro inicial quedan vinculados por su ID.

Se sincroniza al arrancar, cada `FUDO_SYNC_MINUTES` minutos (30 por defecto; con el plan gratuito de Render solo mientras el servicio está despierto) y con los botones **Sincronizar con Fudo** en Proveedores y en Productos.

| Variable | Valor |
|---|---|
| `FUDO_API_KEY` | apiKey de Fudo (Administración → Usuarios → "Establecer API Secret", o pedirla a soporte@fu.do) |
| `FUDO_API_SECRET` | apiSecret correspondiente |
| `FUDO_SYNC_MINUTES` | opcional, minutos entre sincronizaciones (0 = solo manual) |

La API de Fudo requiere plan Pro o superior y el usuario de la apiKey debe tener permiso para ver proveedores y productos (si no, Fudo responde 403).

## Consumos desde las ventas de Fudo

En **Operaciones → Consumos desde Fudo** (ADMIN y RECEPTOR) se elige un período (desde / hasta, con atajos como "jornada de ayer 06:00 a 06:00") y la app trae de Fudo los ítems vendidos, descarta los cancelados y suma las unidades por producto.

- Se muestra el **último período importado** y el nuevo empieza ahí; si un período se superpone con otra importación (no anulada) se rechaza.
- La importación queda en **borrador**: se elige el **almacén** donde se consumió, se ve el stock disponible, se pueden corregir cantidades, excluir productos o categorías enteras (p. ej. platos que no llevan stock) y guardar.
- Al **confirmar** se registra un movimiento **Consumo** en ese almacén. Si falta stock, se puede optar por consumir solo lo disponible (la diferencia queda anotada).
- Los productos vendidos que no están en la app aparecen como "No está en la app" y no se consumen; antes de importar se sincronizan los productos.
- Un borrador se puede **anular** y el período queda libre para importarlo de nuevo.

## Personal: solicitudes de empleados

- Rol **Empleado** (de sistema): solo ve **Personal → Mis solicitudes**. Pide **adelantos de sueldo** (monto y motivo), **vacaciones** y **licencias** (examen, enfermedad, matrimonio, nacimiento, fallecimiento de familiar, mudanza, trámite, otro) con fechas; se calculan los días corridos. Puede adjuntar certificados (PDF o foto, 8 MB), cancelar mientras está pendiente y ve un resumen anual (vacaciones y licencias aprobadas, adelantos del mes).
- Permiso **Solicitudes del personal** (ADMIN por defecto, asignable a cualquier rol): lista con filtros, ausencias aprobadas de los próximos 60 días, aviso de superposición con otras ausencias, aprobación (en adelantos se puede aprobar un monto menor) o rechazo con motivo, y exportación CSV. Nadie resuelve su propia solicitud.
- Panel: quien aprueba ve las pendientes; el empleado, las respuestas recientes.

## Reloj de asistencia (CrossChex Cloud)

La app trae las fichadas del reloj Anviz desde **CrossChex Cloud** y calcula las horas trabajadas.

- **Personal → Horas del personal** (permiso `Horas del personal`, ADMIN por defecto): horas por empleado en el período (atajos: semana, quincena, mes, mes anterior), días trabajados, promedio, jornadas incompletas (fichada sin par) y detalle por día con entradas/salidas; exportación CSV.
- **Turnos nocturnos:** lo fichado antes de las 6:00 cuenta para la jornada del día anterior (configurable con `CROSSCHEX_CORTE_HORA`). Las fichadas del mismo empleado a menos de 2 minutos se toman como una sola.
- **Vínculo con usuarios:** en cada usuario se carga su **N° en el reloj** (workno). Con eso el empleado ve su propia pantalla **Personal → Mis horas** (permiso `misHoras`, incluido en el rol Empleado): horas por mes o quincena, días trabajados, promedio, detalle de fichadas por jornada y aviso de fichadas incompletas; también un resumen del mes en su panel, y el panel avisa qué números del reloj no tienen usuario.
- **Sincronización:** al arrancar, cada `CROSSCHEX_SYNC_MINUTES` (60 por defecto) y con el botón *Sincronizar*; la primera vez trae 31 días. No duplica fichadas.

| Variable | Valor |
|---|---|
| `CROSSCHEX_API_KEY` / `CROSSCHEX_API_SECRET` | credenciales de la API de CrossChex Cloud (requiere modo desarrollador habilitado por Anviz) |
| `CROSSCHEX_API_URL` | opcional; por defecto `https://api.us.crosschexcloud.com/` (región US). Para Asia: `https://api.ap.crosschexcloud.com/` |
| `CROSSCHEX_SYNC_MINUTES` | opcional, minutos entre sincronizaciones (0 = solo manual) |
| `CROSSCHEX_CORTE_HORA` | opcional, hora de corte de la jornada (por defecto 6) |

## Vinilito, el asistente

Botón flotante abajo a la derecha (no aparece para proveedores). Responde con los datos de la app y **respeta los permisos y almacenes** del usuario. Es de solo lectura: no registra nada, pero lleva a la pantalla correspondiente.

Ejemplos: "¿Cuántas Coca-Cola tengo en el Galpón?", "¿Qué tengo que reponer?", "¿Qué tareas tengo pendientes?", "¿Qué vence pronto?", "¿Qué pedidos a proveedores faltan recibir?", "¿Cuánto Fernet se consumió esta semana?".

- **Sin configuración:** entiende esas consultas con un motor de reglas en español.
- **Con IA (opcional):** cargando `ANTHROPIC_API_KEY` en Render usa Claude con herramientas de consulta (stock, reposición, tareas, vencimientos, pedidos, notas de pedido y movimientos) y entiende preguntas libres. Modelo configurable con `VINILITO_MODEL` (por defecto `claude-haiku-5-5`). Límite de 30 consultas cada 10 minutos por usuario; si la API falla, responde con el motor de reglas.

## Ejecutar localmente

```bash
npm install
DATABASE_URL=postgresql://usuario:clave@localhost:5432/vinilo \
SESSION_SECRET=algo-largo ADMIN_PASSWORD=admin123 node server.js
# http://localhost:3000
```

## Estructura

```
server.js          API + servidor de archivos estáticos
src/db.js          conexión, migración automática y usuario admin inicial
src/auth.js        contraseñas (scrypt) y tokens de sesión firmados
db/schema.sql      tablas: usuarios, almacenes, productos, stock, movimientos, pedidos, proveedores, órdenes de compra
src/compras.js     pedidos a proveedores, archivos y recepción validada
public/            interfaz web (index.html, app.js, styles.css)
render.yaml        Blueprint de Render
```

## Sucursales y programación del personal

- **Parametrización → Sucursales** (permiso `sucursales`): alta y edición de sucursales (se cargan VINILO BAR y VINILO GALPON) y qué empleados trabajan en cada una. Un empleado puede estar en una o varias; también se asigna desde **Usuarios**.
- **Personal → Programación** (permiso `programacion`): grilla semanal por empleado con los días y horarios a trabajar en cada sucursal. Filtro por sucursal, alta/edición de un día tocando la celda, **Programar varios días** (rango de fechas + días de la semana + horario, para varios empleados a la vez, o quitar días) y **Copiar semana anterior**. Un día sin programar es franco; los turnos que cruzan la medianoche se cargan en el día en que empiezan.
- El empleado ve sus próximos días de trabajo en su **Panel** y en **Mis horas**.
- Ambos permisos se habilitan por rol en Usuarios → Roles.
- **Eventos** (en Programación, botón *Nuevo evento* o el + de la fila 🎉 Eventos): nombre, sucursal, fecha, horario del evento, horario del personal (si entra antes o sale después) y descripción. El personal elegido queda programado ese día en esa sucursal, vinculado al evento; editar o eliminar el evento actualiza su personal. *Copiar semana anterior* no copia eventos. El empleado ve "Evento: …" en sus próximos días.
- **Vacaciones y licencias en la programación**: las solicitudes aprobadas se ven en la grilla (celda verde rayada, sin poder programar ese día) y las pendientes con borde punteado. Al aprobar una licencia se quitan de la programación los días que abarca. *Programar varios días* y *Copiar semana* saltean los días de licencia aprobada, y un evento no acepta a quien está de licencia. El panel (hoy/mañana) muestra quién está de licencia y el empleado ve sus días de licencia junto a sus próximos turnos.

## Pronóstico en el panel

Todos los usuarios ven en su panel el pronóstico de la noche (18 a 3 h) de Junín (Bs. As.): temperatura, lluvia, viento y avisos (lluvia probable, tormenta, ráfagas, frío o calor), hora por hora. Fuente: Open-Meteo, sin clave; se actualiza cada 30 minutos. Entre las 0 y las 6 h muestra la noche en curso. La ubicación se puede cambiar con `CLIMA_LAT`, `CLIMA_LON` y `CLIMA_CIUDAD`.

## Avisos por WhatsApp (WhatsApp Cloud API de Meta)

Avisos automáticos:
- **Nueva solicitud del personal** → a quienes pueden aprobarlas (Administrador y roles con *Solicitudes del personal*).
- **Solicitud aprobada o rechazada** → al empleado, con el comentario.
- **Pedido a proveedor confirmado** → al teléfono del proveedor y a los usuarios de su portal.

Configuración:
1. En Meta for Developers creá una app de tipo *Business* con el producto **WhatsApp**, y registrá un número propio (que no esté en WhatsApp común).
2. Generá un **token permanente** (usuario del sistema con permiso `whatsapp_business_messaging`) y copiá el **Phone number ID**.
3. En Render → Environment cargá `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_ID` (opcionales: `WHATSAPP_LANG`, por defecto `es_AR`; `APP_URL`).
4. En WhatsApp Manager creá las plantillas `vinilo_solicitud_nueva`, `vinilo_solicitud_resuelta` y `vinilo_pedido_proveedor` (categoría **Utilidad**, idioma **Español (ARG)**), con el texto que muestra **Usuarios → WhatsApp**.
5. Cargá los celulares: en **Usuarios → Editar** (o cada uno desde **📱 WhatsApp** en su menú) y el teléfono de cada proveedor. Formato: código de área + número, sin 0 ni 15.

En **Usuarios → WhatsApp** se ve el estado de la conexión, se manda un mensaje de prueba y está el registro de cada aviso (enviado, con error o no enviado) con opción de reintentar.

## Conteo de inventario desde el celular

**Operaciones → Conteo de inventario** (permiso `contar`; aplicar requiere `ajustar`). Se crea un conteo por almacén (todos los productos con gestión de stock o una categoría), por defecto **ciego** (quien cuenta no ve el stock del sistema). Varias personas cuentan a la vez desde el celular: botones − / +, cantidad directa o “＋ sumar” lo encontrado en otro lugar; cada producto se guarda al instante y la pantalla se actualiza sola. Búsqueda por nombre o código, lector de código de barras (cámara en Android/Chrome o lector Bluetooth/USB) y asociación de códigos nuevos a productos. Quien puede ajustar revisa diferencias (sistema vs contado), decide qué hacer con lo no contado (dejar o poner en 0) y aplica: el stock pasa a ser lo contado y queda un movimiento de **Ajuste** con referencia al conteo. Un conteo en curso por almacén; aparece como tarea en el panel.

## Notificaciones push al celular

Web Push estándar, sin servicios externos ni costo (claves VAPID generadas solas y guardadas en la base; opcional `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`).
- Cada usuario las activa desde el banner **🔔 Activar** del panel o desde **🔔 Avisos** en su menú. En iPhone (iOS 16.4+) primero hay que **agregar la app a la pantalla de inicio** y abrirla desde ese ícono.
- **Parametrización → Notificaciones push** (permiso `notificaciones`): notificaciones programadas por **roles**, **días de la semana** y **hora** (Argentina), con la pantalla que abren al tocarlas; enviar ahora, pausar, historial de envíos y cuántos usuarios de cada rol las tienen activadas.
- El programador revisa cada 30 s; si el servidor estaba en reposo, envía las de los últimos 20 minutos. En el plan gratuito de Render el servicio se duerme sin tráfico: para que salgan de madrugada conviene un plan pago o un “ping” externo periódico.

## Checklist de apertura y cierre

**Operaciones → Checklist apertura / cierre** (permiso `checklist`, incluido en Empleado y Encargado). Plantillas Apertura y Cierre cargadas por defecto (por secciones: salón, barra, cocina, caja), con tareas para tildar, valores (temperaturas en °C, efectivo en $) y notas. Un checklist por sucursal y jornada (antes de las 6 h cuenta para el día anterior) que varios completan a la vez desde el celular; se finaliza cuando están todas las obligatorias. Panel: checklists pendientes (urgentes después de la hora límite). Con `checklistConfig`: **Historial** (con valores registrados y checklists faltantes) y **Plantillas** (tareas, secciones, tipo de dato, obligatoria, orden, sucursal y hora límite).

## Tablero en vivo (Fudo)
Menú **General → Tablero en vivo** (permiso `tablero`, solo ADMIN por defecto; se puede dar a otros roles en Roles y permisos).
Lee de Fudo las mesas (`/tables` con ventas activas y salas), las ventas de la jornada (`/sales`, desde las 6 h) y los ítems (`/items`), con caché de 30 s; la pantalla se actualiza sola cada 60 s.
Muestra: mesas ocupadas, comensales ahora y pico, ventas de la jornada (cobrado + en mesas) comparadas con el mismo día de la semana pasada a la misma hora, ticket promedio, gasto por comensal, permanencia promedio, gráficos de comensales y mesas ocupadas cada 15 min (hoy vs. semana pasada), ventas por hora, lo más vendido, mix salón/para llevar/delivery y la lista de mesas abiertas hace más de 1 h 30 (las de más de 2 h 30 resaltadas). Botón **Modo TV** para dejarlo en una pantalla del bar.

### Tablero de dos sucursales
La cuenta principal de Fudo (`FUDO_API_KEY`/`FUDO_API_SECRET`) es **VINILO GALPON** y es la que sincroniza productos, proveedores y consumos.
Para sumar **VINILO BAR** al tablero, cargar en Render `FUDO_BAR_API_KEY` y `FUDO_BAR_API_SECRET` (apiKey/apiSecret de un usuario de Fudo de esa sucursal). Aparecen pestañas para elegir la sucursal (se recuerda la última). Esa cuenta se usa **solo para el tablero**; no sincroniza nada.
Nombres opcionales: `FUDO_NOMBRE` (default VINILO GALPON) y `FUDO_BAR_NOMBRE` (default VINILO BAR).

## Ver como otro usuario (ADMIN)
En **Usuarios**, el botón **👁 Ver como** abre la aplicación tal como la ve ese usuario (menú, permisos, almacenes, sus datos).
Es **solo lectura**: el servidor rechaza cualquier alta, cambio o borrado mientras dure. El token dura 2 h y se invalida si el administrador deja de ser ADMIN o se desactiva.
Una barra arriba indica a quién se está viendo y tiene el botón **Volver a mi usuario**. Cada uso queda en **Usuarios → Accesos** como evento "Ver como".

## Juegos → Bolsa de tragos
Pantalla tipo bolsa de valores con los tragos (productos de Fudo cuya categoría es **Tragos**). Permiso `juegos` (solo ADMIN por defecto).
Cada 5 minutos el precio de cada trago se mueve según lo vendido en Fudo: sube cuando se pide (+4,5 % por 1 unidad, rinde menos cada unidad extra), baja de a poco si no sale, y siempre tiende a volver al precio de carta (límites 70 %–160 %). El mercado abre a las 18 h o con el primer trago vendido.
Muestra la cinta con cotizaciones, el **Índice VINILO** (base 1000), lo que más sube y baja en 30 minutos, una tarjeta por trago con precio, variación, gráfico, volumen y máx/mín del día, y los tragos sin operar. Modo TV y pestañas por sucursal (usa las mismas cuentas de Fudo del tablero).
El ADMIN elige qué tragos se muestran con el botón **⚙️ Tragos**. Es un juego de pantalla: **los precios de Fudo no se modifican**.

### Bolsa: pizzas, crash y animaciones
- **Mercados**: selector 🍸 Tragos / 🍕 Pizzas (categorías de Fudo que contienen "Tragos" o "Pizza"). Cada mercado tiene su propia lista de productos ocultos (⚙️ Productos).
- **CRASH** (permiso `juegosCrash`): baja todos los precios de la sucursal un 20–50 % durante 5–30 minutos, con animación y cuenta regresiva en pantalla. Se puede terminar antes; los precios se recuperan de a poco en 10 minutos. Queda guardado en `app_config` (`bolsa_crash_<cuenta>`).
- **Animaciones**: cada venta nueva de una pizza o un trago dispara una animación al azar (pizza que cruza, sube, rebota o llueve; dos copas que brindan en el centro, desde los costados, en un lugar al azar o de a dos), con el nombre del producto. La pantalla consulta Fudo cada 20 s.
- Logo del juego: `public/vinilo-club-blanco.png` (y la versión roja `vinilo-club.png`).
- **Modo demo** (botón 🎬 Demo o `#/bolsa?demo=1`): ventas inventadas en vivo sobre los productos y precios reales de Fudo, para mostrar cómo funciona sin esperar a la noche. Tiene su propio crash (no afecta la bolsa real).

## Avisos en el panel
Menú **General → Avisos en el panel** (permiso `avisos`, ADMIN por defecto). El aviso aparece arriba de todo en el Panel de los usuarios elegidos (todos, ciertos roles y/o sucursales) hasta que cada uno toca **Entendido**; los leídos quedan en "Ver avisos leídos".
Tipos: 📢 Aviso, ⚠️ Importante, 🚨 Urgente (va primero y titila). Vencimiento opcional (1 día, 3 días, 1 semana, 1 mes, fecha o sin vencimiento). Opción de mandarlo también como notificación push al celular.
El administrador ve cuántos lo leyeron y quiénes sí/no, puede editarlo (y volver a mostrarlo a todos), pausarlo o borrarlo. Tablas `avisos` y `avisos_leidos`.

## Juegos → Pizzaiolo de la Noche (juego por QR para comensales)
- Los comensales escanean **un único QR** que se muestra en la pantalla del bar (o impreso) → `/jugar?s=<sucursal>` (página pública `public/juego.html`, sin usuario). Ponen su nombre y juegan 3 rondas: **Al punto** (sacar la pizza del horno), **Armá la Margherita** (tocar ingredientes correctos) y **Trivia del bar** (4 preguntas al azar).
- El puntaje lo calcula el servidor (`src/juego.js`): la trivia se corrige en el servidor (el celular nunca recibe la respuesta), hay topes por ronda, duración mínima de 30 s, token de un solo uso y límite de partidas por IP.
- En VINILO APP: **Juegos → Pizzaiolo (juego QR)** (permiso `juegos`): ranking de la jornada en vivo con el QR del local, jugadores activos, último puntaje y premio; Modo TV; pestañas por sucursal; **🖨️ Imprimir QR** genera un cartel A4 con el QR del local; **⚙️ Configurar** (ADMIN): activar/pausar, premio y preguntas de la trivia; el ADMIN puede borrar partidas (nombres inapropiados).
- **🔄 Reiniciar** y **🏆 Mostrar ganador** (permiso `juegosControl`, ADMIN por defecto): reiniciar archiva las partidas terminadas de la jornada (estado `REINICIADA`, no se borran) y el ranking vuelve a cero; mostrar ganador abre a pantalla completa el podio del 3.º al 1.º con confeti, corona y el premio (se cierra con Esc o Cerrar).
- Los QR se generan en el servidor sin dependencias (`src/qr.js`, verificado con lectores reales). Si la app está detrás de otro dominio, se puede fijar `PUBLIC_URL`.
- Tabla `juego_partidas`; configuración en `app_config` (`juego_config`).

## Juegos → Pong Pizza (cancha en la pantalla, control en el celular)
- **Juegos → Pong Pizza** (permiso `juegos`) abre la cancha con un QR. Dos personas lo escanean (`/pong?sala=CODIGO`, página `public/pong.html`), ponen su nombre y su celular se vuelve el control: arrastran el dedo para mover la pala de pizzero (roja a la izquierda, verde a la derecha). La pelota es una pizza.
- Cuenta regresiva al estar los dos, puntos con cartel, vibración en el celular al pegarle y al recibir un punto, partido a 3, 5, 7 o 10 puntos, festejo del ganador y revancha (los dos tocan 🔁 en el celular o el botón de la pantalla). **Liberar cancha** / **Que jueguen otros** desconecta a los jugadores para que entren otros. Si alguien se desconecta, el partido queda en pausa y al volver recupera su pala.
- Tiempo real por WebSocket propio sin dependencias (`src/ws.js`); salas en memoria (`src/pong.js`). La física corre en la pantalla; el servidor solo reenvía los movimientos (~25 por segundo por jugador). Teclado para probar sin celulares: W/S y ↑/↓.

### Inicio de los juegos (Pizzaiolo y Pong)
- Los juegos arrancan **cerrados**: la pantalla muestra la escena de espera (Sr. Pizzaiolo con su pala, horno napolitano con fuego, pizzas volando y logo del Galpón) con el QR para anotarse.
- **▶ Iniciar juego** (permiso `juegosControl`) muestra en la pantalla y en los celulares un conteo de **10 a 0** sincronizado (hora del servidor). En el Pizzaiolo, los que ya se anotaron arrancan solos al llegar a cero; en el Pong, al terminar el conteo empieza el partido (con su 3‑2‑1) cuando están los dos jugadores.
- **⏹ Terminar juego** vuelve a la escena de espera. Estado del Pizzaiolo por sucursal en `app_config` (`juego_estado_<id>`).
- Pong más rápido: el celular manda cada movimiento en el próximo cuadro (~60/s) y la pantalla sigue a la pala casi sin suavizado.

### Conteos: abrir, cerrar y omitir
- Con `contar` cualquiera abre conteos y cuenta en cualquier conteo en curso de sus almacenes, aunque lo haya abierto otro.
- Permiso **`cerrarConteo`** ("Cerrar conteos"): aplicar o anular cualquier conteo aunque lo haya abierto otro usuario. Se otorgó una vez a los roles que tenían `ajustar` (que también puede cerrar). Quien abrió un conteo siempre puede anular el suyo.
- Al cerrar, los productos sin contar se pueden **omitir** (su stock queda como está; opción por defecto) o poner en 0.
