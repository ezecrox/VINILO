# Vinilo · Gestión de Almacén

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
