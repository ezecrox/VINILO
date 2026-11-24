// Catálogo de permisos configurables por rol (puntos de menú y acciones).
const CATALOGO = [
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
  { grupo: 'Operaciones', clave: 'ajustar', menu: 'Ajuste de inventario', desc: 'Ajustar stock por conteo físico' },
  { grupo: 'Operaciones', clave: 'verMovimientos', menu: 'Movimientos', desc: 'Ver el historial de movimientos' },
  { grupo: 'Parametrización', clave: 'productos', menu: 'Productos', desc: 'Maestro de productos, alertas e importación' },
  { grupo: 'Parametrización', clave: 'almacenes', menu: 'Almacenes', desc: 'Alta y edición de almacenes' },
  { grupo: 'Parametrización', clave: 'usuarios', menu: 'Usuarios y roles', desc: 'Usuarios, roles y permisos' },
];
const CLAVES = CATALOGO.map((c) => c.clave);

/** Permisos efectivos de un usuario a partir de su rol (ya cargado desde la tabla roles). */
function permisosDe(u, permisosRol) {
  if (u.rol === 'PROVEEDOR') return ['portalProveedor'];
  let p = u.rol === 'ADMIN' ? [...CLAVES] : String(permisosRol || '').split(',').map((x) => x.trim()).filter((x) => CLAVES.includes(x));
  if (u.permiso_compras) p.push('compras', 'verCompras');
  p.push('verProductos'); // listas de productos para formularios
  // Dependencias: una acción implica poder ver su menú
  for (const c of CATALOGO) if (c.requiere && p.includes(c.clave)) p.push(c.requiere);
  return [...new Set(p)];
}

module.exports = { CATALOGO, CLAVES, permisosDe };
