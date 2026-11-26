// Catálogo de permisos configurables por rol (puntos de menú y acciones).
const CATALOGO = [
  { grupo: 'General', clave: 'tablero', menu: 'Tablero en vivo', desc: 'Ver el estado del bar en vivo con datos de Fudo: mesas, comensales y ventas de la jornada' },
  { grupo: 'General', clave: 'avisos', menu: 'Avisos en el panel', desc: 'Publicar avisos que aparecen en el Panel de todos los usuarios (o de algunos roles o sucursales)' },
  { grupo: 'Juegos', clave: 'juegos', menu: 'Bolsa de tragos', desc: 'Ver la bolsa de tragos: precios que suben y bajan según las ventas de Fudo (para mostrar en una pantalla)' },
  { grupo: 'Juegos', clave: 'juegosCrash', menu: 'Bolsa de tragos', desc: 'Lanzar un CRASH en la bolsa (bajan todos los precios por unos minutos)', requiere: 'juegos' },
  { grupo: 'General', clave: 'verStock', menu: 'Stock por almacén', desc: 'Ver el stock de los almacenes habilitados' },
  { grupo: 'General', clave: 'minimos', menu: 'Stock por almacén', desc: 'Definir stock mínimo por almacén', requiere: 'verStock' },
  { grupo: 'General', clave: 'verPedidos', menu: 'Notas de pedido', desc: 'Ver notas de pedido entre almacenes' },
  { grupo: 'General', clave: 'crearPedido', menu: 'Notas de pedido', desc: 'Crear notas de pedido', requiere: 'verPedidos' },
  { grupo: 'General', clave: 'atenderPedido', menu: 'Notas de pedido', desc: 'Atender o rechazar notas de pedido (genera la transferencia)', requiere: 'verPedidos' },
  { grupo: 'Compras', clave: 'verCompras', menu: 'Pedidos a proveedores', desc: 'Ver pedidos a proveedores' },
  { grupo: 'Compras', clave: 'compras', menu: 'Pedidos a proveedores', desc: 'Crear, confirmar, cerrar y anular pedidos a proveedores', requiere: 'verCompras' },
  { grupo: 'Compras', clave: 'proveedores', menu: 'Proveedores', desc: 'Alta y edición de proveedores' },
  { grupo: 'Operaciones', clave: 'recibir', menu: 'Recepción', desc: 'Recibir mercadería (también la de pedidos a proveedores)' },
  { grupo: 'Operaciones', clave: 'transferir', menu: 'Transferencia', desc: 'Transferir entre almacenes' },
  { grupo: 'Operaciones', clave: 'consumir', menu: 'Consumo / Consumos desde Fudo', desc: 'Registrar consumos e importar ventas de Fudo' },
  { grupo: 'Operaciones', clave: 'contar', menu: 'Conteo de inventario', desc: 'Contar el stock desde el celular (aplicar el conteo requiere Ajuste de inventario)' },
  { grupo: 'Operaciones', clave: 'ajustar', menu: 'Ajuste de inventario', desc: 'Ajustar stock por conteo físico' },
  { grupo: 'Operaciones', clave: 'producir', menu: 'Producción', desc: 'Producir productos con receta (descuenta insumos y suma lo producido)' },
  { grupo: 'Operaciones', clave: 'checklist', menu: 'Checklist apertura / cierre', desc: 'Completar los checklists de apertura y cierre del local' },
  { grupo: 'Operaciones', clave: 'verMovimientos', menu: 'Movimientos', desc: 'Ver el historial de movimientos' },
  { grupo: 'Personal', clave: 'solicitudes', menu: 'Mis solicitudes', desc: 'Pedir adelantos de sueldo, vacaciones y licencias (examen, enfermedad, etc.)' },
  { grupo: 'Personal', clave: 'misHoras', menu: 'Mis horas', desc: 'Ver las propias horas trabajadas. Todo usuario con N° en el reloj ya lo tiene, sea cual sea su rol' },
  { grupo: 'Personal', clave: 'gestionarSolicitudes', menu: 'Solicitudes del personal', desc: 'Ver, aprobar o rechazar las solicitudes de los empleados' },
  { grupo: 'Personal', clave: 'programacion', menu: 'Programación', desc: 'Programar los días y horarios que trabaja cada empleado en cada sucursal' },
  { grupo: 'Personal', clave: 'verHoras', menu: 'Horas del personal', desc: 'Ver fichadas y horas trabajadas (CrossChex) y sincronizar el reloj' },
  { grupo: 'Parametrización', clave: 'productos', menu: 'Productos', desc: 'Maestro de productos, alertas e importación' },
  { grupo: 'Parametrización', clave: 'sucursales', menu: 'Sucursales', desc: 'Alta y edición de sucursales y qué empleados trabajan en cada una' },
  { grupo: 'Parametrización', clave: 'almacenes', menu: 'Almacenes', desc: 'Alta y edición de almacenes' },
  { grupo: 'Parametrización', clave: 'checklistConfig', menu: 'Checklist apertura / cierre', desc: 'Armar las plantillas de checklist y ver el historial de todos', requiere: 'checklist' },
  { grupo: 'Parametrización', clave: 'notificaciones', menu: 'Notificaciones push', desc: 'Programar y enviar notificaciones al celular por rol' },
  { grupo: 'Parametrización', clave: 'usuarios', menu: 'Usuarios y roles', desc: 'Usuarios, roles y permisos' },
];
const CLAVES = CATALOGO.map((c) => c.clave);

/** Permisos efectivos de un usuario a partir de su rol (ya cargado desde la tabla roles). */
function permisosDe(u, permisosRol) {
  if (u.rol === 'PROVEEDOR') return ['portalProveedor'];
  let p = u.rol === 'ADMIN' ? [...CLAVES] : String(permisosRol || '').split(',').map((x) => x.trim()).filter((x) => CLAVES.includes(x));
  if (u.permiso_compras) p.push('compras', 'verCompras');
  p.push('verProductos'); // listas de productos para formularios
  if (u.legajo) p.push('misHoras'); // quien ficha en el reloj siempre ve sus propias horas
  // Dependencias: una acción implica poder ver su menú
  for (const c of CATALOGO) if (c.requiere && p.includes(c.clave)) p.push(c.requiere);
  return [...new Set(p)];
}

module.exports = { CATALOGO, CLAVES, permisosDe };
