// Vinilito: asistente de la app. Modo Claude (si hay ANTHROPIC_API_KEY) con herramientas de solo lectura;
// si no, o si falla, un motor de reglas en español que entiende las consultas más comunes.
const crearDatos = require('./datos');

const MODEL = process.env.VINILITO_MODEL || 'claude-haiku-5-5';
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const llmDisponible = () => !!process.env.ANTHROPIC_API_KEY;

const n = (x) => Number(x || 0).toLocaleString('es-AR');
const fmtDia = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

const EJEMPLOS = [
  '¿Cuántas Coca-Cola tengo en el Galpón?',
  '¿Qué tengo que reponer?',
  '¿Qué tareas tengo pendientes?',
  '¿Qué productos vencen pronto?',
  '¿Qué pedidos a proveedores faltan recibir?',
  '¿Cuánto Fernet se consumió esta semana?',
];

// ---------- Motor de reglas ----------
function periodo(t) {
  const ahora = new Date();
  const inicioDia = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  if (/\bayer\b/.test(t)) { const h = inicioDia(ahora); return { desde: new Date(h - 86400e3), hasta: h, txt: 'ayer' }; }
  if (/\bhoy\b/.test(t)) return { desde: inicioDia(ahora), hasta: ahora, txt: 'hoy' };
  if (/\bmes\b/.test(t)) return { desde: new Date(ahora - 30 * 86400e3), hasta: ahora, txt: 'en los últimos 30 días' };
  return { desde: new Date(ahora - 7 * 86400e3), hasta: ahora, txt: 'en los últimos 7 días' };
}

async function responderConReglas(mensaje, D, user) {
  const t = D.norm(mensaje);
  const p = (x) => user.permisos.includes(x);
  if (!t || /^(hola|buenas|buen dia|buenas tardes|buenas noches|ayuda|help|que podes hacer|que sabes hacer)\b/.test(t)) {
    return { texto: `¡Hola ${user.nombre.split(' ')[0]}! Soy **Vinilito** 🍕, tu mozo de almacén. Preguntame cosas como:\n${EJEMPLOS.map((e) => `- ${e}`).join('\n')}`, sugerencias: EJEMPLOS.slice(0, 3) };
  }
  if (/reponer|reposicion|bajo (el )?minimo|debajo del minimo|que falta|faltantes?\b|comprar/.test(t)) {
    const almacen = (await D.detectarAlmacen(mensaje)) ? mensaje : null;
    const r = await D.bajoMinimo({ almacen });
    if (r.error) return { texto: r.error };
    if (!r.definidos) return { texto: 'Todavía no hay **stock mínimo** cargado para ningún producto, así que no puedo saber qué reponer. Cargalo en Stock por almacén (✎).', acciones: [{ texto: 'Ir a Stock', link: '#/stock' }] };
    if (!r.productos.length) return { texto: '¡Todo en orden! 👌 No hay productos por debajo del mínimo.' };
    return { texto: `Hay **${r.productos.length}** ${r.productos.length === 1 ? 'producto' : 'productos'} para reponer:\n${r.productos.slice(0, 12).map((x) => `- **${x.producto}** en ${x.almacen}: hay ${n(x.cantidad)}, mínimo ${n(x.minimo)} (faltan ${n(x.faltan)})`).join('\n')}${r.productos.length > 12 ? `\n- …y ${r.productos.length - 12} más` : ''}`,
      acciones: [{ texto: 'Ver bajo mínimo', link: '#/stock?bajo=1' }] };
  }
  if (/venc/.test(t)) {
    const r = await D.vencimientos({ dias: 15 });
    if (r.error) return { texto: r.error };
    const con = r.productos.filter((x) => x.stock > 0);
    if (!con.length) return { texto: 'No hay productos con stock que venzan en los próximos 15 días. 🙌' };
    return { texto: `Productos con stock que vencen en los próximos 15 días:\n${con.map((x) => `- **${x.producto}**: ${x.dias < 0 ? 'vencido' : x.dias === 0 ? 'vence hoy' : `vence el ${fmtDia(x.vence)}`} · ${n(x.stock)} u.`).join('\n')}`, acciones: [{ texto: 'Ver stock', link: '#/stock' }] };
  }
  if (/proveedor|por recibir|entrega|orden(es)? de compra/.test(t)) {
    const r = await D.pedidosProveedores({});
    if (r.error) return { texto: r.error };
    if (!r.pedidos.length) return { texto: 'No hay pedidos a proveedores abiertos.' };
    const est = { BORRADOR: 'borrador', CONFIRMADA: 'por recibir', PARCIAL: 'entrega parcial' };
    return { texto: `Pedidos a proveedores abiertos:\n${r.pedidos.map((x) => `- **#${x.numero} ${x.proveedor}** → ${x.almacen} · ${est[x.estado] || x.estado}${x.entrega ? ` · entrega ${fmtDia(x.entrega)}` : ''} · ${n(x.unidades_pendientes)} u. pendientes`).join('\n')}`,
      acciones: [{ texto: 'Ir a pedidos a proveedores', link: '#/compras' }] };
  }
  if (/nota(s)? de pedido|pedidos? (pendiente|interno)|pedidos? entre almacenes|transferencias? pendiente/.test(t)) {
    const r = await D.notasPedido({});
    if (r.error) return { texto: r.error };
    if (!r.notas.length) return { texto: 'No hay notas de pedido pendientes.' };
    return { texto: `Notas de pedido pendientes:\n${r.notas.map((x) => `- **#${x.numero}** ${x.origen} → ${x.destino} · ${x.productos} productos · pidió ${x.solicitante}`).join('\n')}`, acciones: [{ texto: 'Ir a notas de pedido', link: '#/pedidos' }] };
  }
  if (/tarea|pendiente|que tengo que hacer|que hay (para|que) hacer|que me falta|resumen del dia/.test(t)) {
    const r = await D.tareas();
    const reales = r.filter((x) => x.prioridad !== 'baja');
    if (!reales.length) return { texto: '¡Estás al día! No tenés tareas pendientes. ✅' };
    return { texto: `Tenés **${reales.length}** ${reales.length === 1 ? 'tarea pendiente' : 'tareas pendientes'}:\n${reales.map((x) => `- ${x.prioridad === 'alta' ? '🔴' : '🟠'} **${x.titulo}**${x.cantidad > 1 ? ` (${x.cantidad})` : ''}`).join('\n')}`,
      acciones: [{ texto: 'Ir al panel', link: '#/panel' }] };
  }
  const esMov = /consum|vendi|vend(io|ieron)|se (uso|usaron|gasto|gastaron)|recib(i|imos|io|ieron)|ingres|transfer/.test(t);
  const alm = await D.detectarAlmacen(mensaje);
  const excluir = alm ? alm.toks : [];
  if (esMov) {
    const tipo = /recib|ingres/.test(t) ? 'RECEPCION' : /transfer/.test(t) ? 'TRANSFERENCIA' : 'CONSUMO';
    const per = periodo(t);
    const prodTxt = D.tokens(mensaje).filter((x) => !excluir.includes(x) && !/^(consum|vend|recib|ingres|transfer|semana|mes|ayer|hoy|ultim|cuant|se|uso|usaron|gasto)/.test(x)).join(' ');
    const prods = prodTxt ? await D.buscarProductos(prodTxt) : [];
    const r = await D.movimientos({ tipo, producto: prods.length ? prodTxt : null, almacen: alm ? alm.nombre : null, desde: per.desde, hasta: per.hasta });
    if (r.error) return { texto: r.error };
    const verbo = { CONSUMO: 'Consumos', RECEPCION: 'Recepciones', TRANSFERENCIA: 'Transferencias' }[tipo];
    if (!r.productos.length) return { texto: `No hay ${verbo.toLowerCase()} registrados ${per.txt}${alm ? ` en ${alm.nombre}` : ''}${prods.length ? ` de ${prods[0].nombre}` : ''}.` };
    return { texto: `${verbo} ${per.txt}${alm ? ` en **${alm.nombre}**` : ''}:\n${r.productos.slice(0, 12).map((x) => `- **${x.producto}**: ${n(x.unidades)} u.`).join('\n')}`, acciones: [{ texto: 'Ver movimientos', link: '#/movimientos' }] };
  }
  // Por defecto: consulta de stock de un producto
  if (alm && !user.almacenes?.includes(alm.id) && user.almacenes) return { texto: `No tenés acceso al almacén ${alm.nombre}.` };
  const prods = await D.buscarProductos(mensaje, { excluir });
  if (prods.length) {
    if (!p('verStock')) return { texto: 'Tu usuario no tiene acceso a ver el stock.' };
    const r = await D.stock({ productos: prods, almacen: alm ? alm.id : null });
    if (r.error) return { texto: r.error };
    const lista = r.productos || [];
    if (alm) {
      return { texto: `En **${r.almacen || alm.nombre}** ${lista.length === 1 ? 'tenés' : 'tenés:'}${lista.length === 1
        ? ` **${n(lista[0].por_almacen[0].cantidad)}** de **${lista[0].producto}**.${lista[0].por_almacen[0].minimo ? ` (Mínimo: ${n(lista[0].por_almacen[0].minimo)})` : ''}`
        : `\n${lista.map((x) => `- **${x.producto}**: ${n(x.por_almacen[0].cantidad)}`).join('\n')}`}`,
        acciones: [{ texto: 'Ver stock', link: `#/stock?alm=${alm.id}` }] };
    }
    return { texto: lista.map((x) => {
      const filas = x.por_almacen.filter((a) => a.cantidad !== 0 || (a.minimo && a.cantidad < a.minimo));
      if (!filas.length) return `**${x.producto}**: sin stock en tus almacenes.`;
      const sinStock = x.por_almacen.length - filas.length;
      return `**${x.producto}** — total **${n(x.total)}**\n${filas.map((a) => `- ${a.almacen}: ${n(a.cantidad)}${a.minimo && a.cantidad < a.minimo ? ` ⚠️ bajo mínimo (${n(a.minimo)})` : ''}`).join('\n')}${sinStock ? `\n- (sin stock en ${sinStock === 1 ? 'el otro almacén' : `los otros ${sinStock}`})` : ''}`;
    }).join('\n\n'),
      acciones: [{ texto: 'Ver stock', link: '#/stock' }] };
  }
  return { texto: `Mmm, no te entendí 🤔. Probá con algo como:\n${EJEMPLOS.slice(0, 4).map((e) => `- ${e}`).join('\n')}`, sugerencias: EJEMPLOS.slice(0, 3) };
}

// ---------- Modo Claude (herramientas de solo lectura) ----------
const TOOLS = [
  { name: 'consultar_stock', description: 'Stock actual por almacén de uno o más productos (búsqueda por nombre aproximado) y su mínimo. Si no se indica almacén, devuelve todos los almacenes visibles.',
    input_schema: { type: 'object', properties: { producto: { type: 'string', description: 'Nombre o parte del nombre, p. ej. "coca cola"' }, almacen: { type: 'string', description: 'Nombre o parte del nombre del almacén, p. ej. "galpon"' } }, required: ['producto'] } },
  { name: 'buscar_productos', description: 'Busca productos del maestro por nombre aproximado.', input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] } },
  { name: 'productos_bajo_minimo', description: 'Productos por debajo del stock mínimo (para reponer).', input_schema: { type: 'object', properties: { almacen: { type: 'string' } } } },
  { name: 'tareas_pendientes', description: 'Tareas pendientes del usuario (las del panel inicial).', input_schema: { type: 'object', properties: {} } },
  { name: 'proximos_vencimientos', description: 'Productos con alerta de vencimiento que vencen en los próximos N días y su stock.', input_schema: { type: 'object', properties: { dias: { type: 'integer' } } } },
  { name: 'pedidos_a_proveedores', description: 'Pedidos a proveedores (órdenes de compra). Sin estado: los abiertos.', input_schema: { type: 'object', properties: { estado: { type: 'string', enum: ['BORRADOR', 'CONFIRMADA', 'PARCIAL', 'RECIBIDA', 'CERRADA', 'ANULADA'] } } } },
  { name: 'notas_de_pedido', description: 'Notas de pedido internas (transferencias solicitadas entre almacenes).', input_schema: { type: 'object', properties: { estado: { type: 'string', enum: ['PENDIENTE', 'COMPLETADO', 'RECHAZADO', 'CANCELADO'] } } } },
  { name: 'resumen_movimientos', description: 'Unidades por producto en movimientos de un tipo entre dos fechas ISO (por defecto, últimos 7 días). Útil para consumos/ventas registradas.',
    input_schema: { type: 'object', properties: { tipo: { type: 'string', enum: ['CONSUMO', 'RECEPCION', 'TRANSFERENCIA', 'AJUSTE'] }, producto: { type: 'string' }, almacen: { type: 'string' }, desde: { type: 'string' }, hasta: { type: 'string' } } } },
];

async function ejecutarTool(nombre, input, D) {
  switch (nombre) {
    case 'consultar_stock': return D.stock({ producto: input.producto, almacen: input.almacen });
    case 'buscar_productos': return { productos: (await D.buscarProductos(input.texto || '')).map((x) => ({ nombre: x.nombre, codigo: x.codigo, categoria: x.categoria, activo: x.activo })) };
    case 'productos_bajo_minimo': return D.bajoMinimo({ almacen: input.almacen });
    case 'tareas_pendientes': return { tareas: await D.tareas() };
    case 'proximos_vencimientos': return D.vencimientos({ dias: input.dias });
    case 'pedidos_a_proveedores': return D.pedidosProveedores({ estado: input.estado });
    case 'notas_de_pedido': return D.notasPedido({ estado: input.estado });
    case 'resumen_movimientos': return D.movimientos(input);
    default: return { error: 'Herramienta desconocida' };
  }
}

async function responderConClaude(mensaje, historial, D, user) {
  const almVis = (await D.almacenes()).map((a) => a.nombre).join(', ');
  const system = `Sos Vinilito, el asistente de "Vinilo - Gestión de Almacén" (bar Vinilo y El Galpón Vinilo, Junín). Personaje: un mozo simpático con cara de pizza.
Hablás en español rioplatense, breve y claro, con algún toque de humor de mozo pero sin exagerar. Fecha y hora actual: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}.
Usuario: ${user.nombre} (rol ${user.rol_nombre || user.rol}). Almacenes que puede ver: ${almVis || 'ninguno'}.
Reglas: respondé SOLO con datos obtenidos de las herramientas; nunca inventes cantidades. Si una herramienta devuelve error de permisos, decilo amablemente.
Sos de solo lectura: no podés registrar ni modificar nada; si te piden una acción, indicá en qué pantalla hacerlo (Recepción, Transferencia, Consumo, Notas de pedido, Pedidos a proveedores, Consumos desde Fudo, Stock por almacén).
Si un producto coincide con varios, mostralos todos. Formato: texto corto, listas con "- " y **negrita** para cantidades clave. No uses tablas ni títulos.`;
  const messages = [
    ...historial.slice(-8).map((h) => ({ role: h.rol === 'yo' ? 'user' : 'assistant', content: String(h.texto).slice(0, 2000) })),
    { role: 'user', content: mensaje },
  ];
  // la conversación debe empezar con el usuario y alternar
  while (messages.length && messages[0].role !== 'user') messages.shift();
  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, tools: TOOLS, messages }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });
    const usos = (data.content || []).filter((b) => b.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || !usos.length) {
      const texto = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { texto: texto || 'No encontré una respuesta. ¿Me lo preguntás de otra forma?' };
    }
    const resultados = [];
    for (const u of usos) {
      let out;
      try { out = await ejecutarTool(u.name, u.input || {}, D); } catch (e) { out = { error: e.message }; }
      resultados.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000), ...(out && out.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: resultados });
  }
  return { texto: 'Me enredé buscando la respuesta 😅. ¿Probás con una pregunta más concreta?' };
}

// Límite simple para el modo Claude: 30 consultas cada 10 minutos por usuario
const uso = new Map();
function permitidoLLM(uid) {
  const ahora = Date.now();
  const lista = (uso.get(uid) || []).filter((t) => ahora - t < 10 * 60e3);
  if (lista.length >= 30) return false;
  lista.push(ahora); uso.set(uid, lista);
  return true;
}

module.exports = function registrarVinilito({ route, query, fail, calcularTareas, fudo, sqlAlm }) {
  route('GET', '/api/vinilito', async () => ({ modo: llmDisponible() ? 'claude' : 'reglas', ejemplos: EJEMPLOS }));

  route('POST', '/api/vinilito', async ({ user, body }) => {
    const mensaje = String(body.mensaje || '').trim().slice(0, 1000);
    if (!mensaje) fail(400, 'Escribí una consulta');
    const historial = Array.isArray(body.historial) ? body.historial.filter((h) => h && h.texto) : [];
    const D = crearDatos({ query, user, calcularTareas, fudo, sqlAlm });
    if (llmDisponible() && permitidoLLM(user.id)) {
      try {
        return { ...(await responderConClaude(mensaje, historial, D, user)), modo: 'claude' };
      } catch (e) {
        console.error('Vinilito (Claude) falló, uso reglas:', e.message);
      }
    }
    return { ...(await responderConReglas(mensaje, D, user)), modo: 'reglas' };
  });
};

module.exports.responderConReglas = responderConReglas;
