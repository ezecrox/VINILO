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

**Permiso de Compras:** el ADMIN lo puede sumar a cualquier usuario (ADMIN lo tiene siempre). Solo con este permiso se crean, confirman, cierran o anulan pedidos a proveedores.

> El consumo quedó habilitado para ADMIN y RECEPTOR. Para cambiarlo, editar el objeto `PUEDE` al principio de `server.js`.

## Funcionalidades

- **Stock por almacén:** tabla con una columna por depósito y total, búsqueda, filtros por almacén / categoría / alerta, exportación CSV.
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
