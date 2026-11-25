// Checklists de apertura y cierre: plantillas por sucursal, un registro por jornada que varios completan desde el celular.
const TZ = 'America/Argentina/Buenos_Aires';
const CORTE = 6; // antes de las 6 h, la jornada es la del día anterior (el cierre de la madrugada)

function jornadaActual(ahora = new Date()) {
  const hoy = ahora.toLocaleDateString('en-CA', { timeZone: TZ });
  const h = Number(ahora.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
  if (h >= CORTE) return hoy;
  return new Date(Date.parse(hoy + 'T12:00:00Z') - 86400e3).toISOString().slice(0, 10);
}
// ¿Ya pasó la hora límite de la jornada? (una hora límite antes del corte cae en la madrugada siguiente)
function vencida(jornada, horaLimite, ahora = new Date()) {
  if (!horaLimite) return false;
  const [h, m] = horaLimite.split(':').map(Number);
  const base = Date.parse(jornada + 'T00:00:00-03:00') + (h < CORTE ? 86400e3 : 0);
  return ahora.getTime() > base + (h * 60 + m) * 60e3;
}

module.exports = function registrarChecklist({ route, query, tx, fail, permitir, permitirAlguno, isTrue, toInt, str, fechaOk }) {
  const puede = (u, p) => u.permisos.includes(p);
  const idPos = (v) => { const n = toInt(v); return Number.isInteger(n) && n > 0 ? n : null; };

  async function sucursalesDe(user) {
    const { rows: todas } = await query('SELECT id, nombre FROM sucursales WHERE activo ORDER BY nombre');
    if (user.rol === 'ADMIN' || puede(user, 'checklistConfig')) return todas.map((s) => ({ id: Number(s.id), nombre: s.nombre }));
    const { rows } = await query('SELECT sucursal_id FROM usuario_sucursales WHERE usuario_id = $1', [user.id]);
    const mias = new Set(rows.map((r) => Number(r.sucursal_id)));
    const lista = todas.filter((s) => mias.has(Number(s.id)));
    return (lista.length ? lista : todas).map((s) => ({ id: Number(s.id), nombre: s.nombre }));
  }
  const plantillasPara = async (sucursalId) => (await query(
    `SELECT p.*, (SELECT count(*)::int FROM checklist_items i WHERE i.plantilla_id = p.id AND i.activo) AS items,
            (SELECT count(*)::int FROM checklist_items i WHERE i.plantilla_id = p.id AND i.activo AND i.obligatorio) AS obligatorios
     FROM checklist_plantillas p WHERE p.activo AND (p.sucursal_id IS NULL OR p.sucursal_id = $1) ORDER BY p.orden, p.id`, [sucursalId])).rows;

  // Estado de la jornada (para el celular y el panel)
  async function estadoJornada(user, sucursalId, jornada) {
    const pls = await plantillasPara(sucursalId);
    const { rows: regs } = await query(
      `SELECT r.*, uc.nombre AS completado_por_nombre, ui.nombre AS iniciado_por_nombre,
              (SELECT count(*)::int FROM checklist_respuestas x JOIN checklist_items i ON i.id = x.item_id WHERE x.registro_id = r.id AND x.hecho AND i.activo) AS hechos,
              (SELECT count(*)::int FROM checklist_respuestas x JOIN checklist_items i ON i.id = x.item_id WHERE x.registro_id = r.id AND x.hecho AND i.activo AND i.obligatorio) AS hechos_oblig
       FROM checklist_registros r LEFT JOIN usuarios uc ON uc.id = r.completado_por LEFT JOIN usuarios ui ON ui.id = r.iniciado_por
       WHERE r.sucursal_id = $1 AND r.jornada = $2`, [sucursalId, jornada]);
    return pls.map((p) => {
      const r = regs.find((x) => Number(x.plantilla_id) === Number(p.id));
      return { plantilla_id: Number(p.id), nombre: p.nombre, tipo: p.tipo, hora_limite: p.hora_limite, items: Number(p.items), obligatorios: Number(p.obligatorios),
        vencida: vencida(jornada, p.hora_limite) && !(r && r.estado === 'COMPLETO'),
        registro: r ? { id: Number(r.id), estado: r.estado, hechos: Number(r.hechos), hechos_oblig: Number(r.hechos_oblig), iniciado_por: r.iniciado_por_nombre, iniciado_en: r.iniciado_en,
          completado_por: r.completado_por_nombre, completado_en: r.completado_en } : null };
    });
  }

  route('GET', '/api/checklist/hoy', async ({ user, url }) => {
    permitirAlguno(user, 'checklist', 'checklistConfig');
    const sucs = await sucursalesDe(user);
    if (!sucs.length) return { jornada: jornadaActual(), sucursales: [], checklists: [] };
    const pedida = idPos(url.searchParams.get('sucursal_id'));
    const suc = sucs.find((s) => s.id === pedida) || sucs[0];
    const jornada = fechaOk(url.searchParams.get('jornada')) || jornadaActual();
    return { jornada, hoy: jornadaActual(), sucursal: suc, sucursales: sucs, checklists: await estadoJornada(user, suc.id, jornada) };
  });

  route('POST', '/api/checklist/abrir', async ({ user, body }) => {
    permitir(user, 'checklist');
    const pid = idPos(body.plantilla_id), sid = idPos(body.sucursal_id);
    const sucs = await sucursalesDe(user);
    if (!sucs.some((s) => s.id === sid)) fail(403, 'No tenés acceso a esa sucursal');
    const { rows: p } = await query('SELECT * FROM checklist_plantillas WHERE id = $1 AND activo AND (sucursal_id IS NULL OR sucursal_id = $2)', [pid, sid]);
    if (!p[0]) fail(404, 'Checklist inexistente para esa sucursal');
    const hoy = jornadaActual();
    const jornada = fechaOk(body.jornada) || hoy;
    if (jornada !== hoy && !puede(user, 'checklistConfig')) fail(400, 'Solo se puede completar el checklist de la jornada actual');
    const { rows } = await query(
      `INSERT INTO checklist_registros (plantilla_id, sucursal_id, jornada, iniciado_por) VALUES ($1,$2,$3,$4)
       ON CONFLICT (plantilla_id, sucursal_id, jornada) DO UPDATE SET plantilla_id = EXCLUDED.plantilla_id RETURNING id`, [pid, sid, jornada, user.id]);
    return { id: Number(rows[0].id) };
  });

  async function cargarRegistro(id, user) {
    const { rows } = await query(
      `SELECT r.*, p.nombre, p.tipo, p.hora_limite, s.nombre AS sucursal, uc.nombre AS completado_por_nombre, ui.nombre AS iniciado_por_nombre
       FROM checklist_registros r JOIN checklist_plantillas p ON p.id = r.plantilla_id JOIN sucursales s ON s.id = r.sucursal_id
       LEFT JOIN usuarios uc ON uc.id = r.completado_por LEFT JOIN usuarios ui ON ui.id = r.iniciado_por WHERE r.id = $1`, [id]);
    const r = rows[0];
    if (!r) fail(404, 'Checklist inexistente');
    if (!puede(user, 'checklistConfig') && !(await sucursalesDe(user)).some((s) => s.id === Number(r.sucursal_id))) fail(404, 'Checklist inexistente');
    return r;
  }

  route('GET', '/api/checklist/registros/:id', async ({ user, params }) => {
    permitirAlguno(user, 'checklist', 'checklistConfig');
    const r = await cargarRegistro(idPos(params.id), user);
    const { rows: it } = await query(
      `SELECT i.*, x.hecho, x.valor, x.nota, x.hecho_en, u.nombre AS hecho_por FROM checklist_items i
       LEFT JOIN checklist_respuestas x ON x.item_id = i.id AND x.registro_id = $1 LEFT JOIN usuarios u ON u.id = x.usuario_id
       WHERE i.plantilla_id = $2 AND (i.activo OR x.item_id IS NOT NULL) ORDER BY i.orden, i.id`, [r.id, r.plantilla_id]);
    const editable = r.estado === 'EN_CURSO' ? (r.jornada === jornadaActual() || puede(user, 'checklistConfig')) && puede(user, 'checklist') : puede(user, 'checklistConfig');
    return { id: Number(r.id), nombre: r.nombre, tipo: r.tipo, sucursal: r.sucursal, sucursal_id: Number(r.sucursal_id), jornada: r.jornada, estado: r.estado,
      iniciado_por: r.iniciado_por_nombre, iniciado_en: r.iniciado_en, completado_por: r.completado_por_nombre, completado_en: r.completado_en, observacion: r.observacion,
      editable, vencida: r.estado !== 'COMPLETO' && vencida(r.jornada, r.hora_limite),
      items: it.map((i) => ({ id: Number(i.id), seccion: i.seccion, texto: i.texto, tipo_valor: i.tipo_valor, unidad: i.unidad, obligatorio: isTrue(i.obligatorio),
        hecho: isTrue(i.hecho), valor: i.valor, nota: i.nota, hecho_por: i.hecho_por || null, hecho_en: i.hecho_en || null })) };
  });

  route('PUT', '/api/checklist/registros/:id/items/:item', async ({ user, body, params }) => {
    permitirAlguno(user, 'checklist', 'checklistConfig');
    const r = await cargarRegistro(idPos(params.id), user);
    if (r.estado === 'COMPLETO' && !puede(user, 'checklistConfig')) fail(409, 'El checklist ya se finalizó');
    if (r.estado !== 'COMPLETO' && r.jornada !== jornadaActual() && !puede(user, 'checklistConfig')) fail(409, 'Ese checklist es de otra jornada');
    const { rows: it } = await query('SELECT * FROM checklist_items WHERE id = $1 AND plantilla_id = $2', [idPos(params.item), r.plantilla_id]);
    const item = it[0]; if (!item) fail(404, 'Ítem inexistente');
    let valor = str(body.valor, 60);
    if (valor && item.tipo_valor === 'NUMERO') { const n = Number(String(valor).replace(',', '.')); if (!Number.isFinite(n)) fail(400, 'Ingresá un número'); valor = String(n); }
    let hecho = body.hecho === undefined ? !!valor : !!body.hecho;
    if (hecho && item.tipo_valor && isTrue(item.obligatorio) && !valor) fail(400, `Anotá ${item.unidad ? 'el valor en ' + item.unidad : 'el dato'} para marcarlo`);
    await query(
      `INSERT INTO checklist_respuestas (registro_id, item_id, hecho, valor, nota, usuario_id) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (registro_id, item_id) DO UPDATE SET hecho = EXCLUDED.hecho, valor = EXCLUDED.valor,
         nota = COALESCE(EXCLUDED.nota, checklist_respuestas.nota), usuario_id = EXCLUDED.usuario_id, hecho_en = now()`,
      [r.id, item.id, hecho, valor, body.nota === undefined ? null : str(body.nota, 300), user.id]);
    if (body.nota !== undefined && !str(body.nota, 300)) await query('UPDATE checklist_respuestas SET nota = NULL WHERE registro_id = $1 AND item_id = $2', [r.id, item.id]);
    return { ok: true, hecho, valor, hecho_por: user.nombre };
  });

  route('POST', '/api/checklist/registros/:id/completar', async ({ user, body, params }) => {
    permitir(user, 'checklist');
    const r = await cargarRegistro(idPos(params.id), user);
    if (r.estado === 'COMPLETO') fail(409, 'El checklist ya se finalizó');
    const { rows: falt } = await query(
      `SELECT i.texto FROM checklist_items i LEFT JOIN checklist_respuestas x ON x.item_id = i.id AND x.registro_id = $1
       WHERE i.plantilla_id = $2 AND i.activo AND i.obligatorio AND NOT coalesce(x.hecho, false) ORDER BY i.orden`, [r.id, r.plantilla_id]);
    if (falt.length) fail(400, `Faltan ${falt.length} ${falt.length === 1 ? 'tarea obligatoria' : 'tareas obligatorias'}: ${falt.slice(0, 3).map((f) => f.texto).join(', ')}${falt.length > 3 ? '…' : ''}`);
    await query("UPDATE checklist_registros SET estado = 'COMPLETO', completado_por = $2, completado_en = now(), observacion = $3 WHERE id = $1", [r.id, user.id, str(body.observacion, 1000)]);
    return { ok: true };
  });
  route('POST', '/api/checklist/registros/:id/reabrir', async ({ user, params }) => {
    permitir(user, 'checklistConfig');
    const r = await cargarRegistro(idPos(params.id), user);
    await query("UPDATE checklist_registros SET estado = 'EN_CURSO', completado_por = NULL, completado_en = NULL WHERE id = $1", [r.id]);
    return { ok: true };
  });

  route('GET', '/api/checklist/historial', async ({ user, url }) => {
    permitir(user, 'checklistConfig');
    const hasta = fechaOk(url.searchParams.get('hasta')) || jornadaActual();
    const desde = fechaOk(url.searchParams.get('desde')) || new Date(Date.parse(hasta) - 13 * 86400e3).toISOString().slice(0, 10);
    const suc = idPos(url.searchParams.get('sucursal_id'));
    const { rows } = await query(
      `SELECT r.id, r.jornada, r.estado, r.completado_en, r.iniciado_en, r.observacion, p.nombre, p.tipo, s.nombre AS sucursal, uc.nombre AS completado_por,
              (SELECT count(*)::int FROM checklist_items i WHERE i.plantilla_id = p.id AND i.activo) AS items,
              (SELECT count(*)::int FROM checklist_respuestas x JOIN checklist_items i ON i.id = x.item_id WHERE x.registro_id = r.id AND x.hecho AND i.activo) AS hechos,
              (SELECT string_agg(i.texto || ': ' || x.valor || coalesce(' ' || i.unidad, ''), ' · ' ORDER BY i.orden) FROM checklist_respuestas x JOIN checklist_items i ON i.id = x.item_id
                WHERE x.registro_id = r.id AND i.tipo_valor = 'NUMERO' AND x.valor IS NOT NULL) AS valores
       FROM checklist_registros r JOIN checklist_plantillas p ON p.id = r.plantilla_id JOIN sucursales s ON s.id = r.sucursal_id LEFT JOIN usuarios uc ON uc.id = r.completado_por
       WHERE r.jornada BETWEEN $1 AND $2 ${suc ? 'AND r.sucursal_id = $3' : ''} ORDER BY r.jornada DESC, s.nombre, p.orden`, suc ? [desde, hasta, suc] : [desde, hasta]);
    // Jornadas sin checklist hecho (faltantes)
    const { rows: sucs } = await query(`SELECT id, nombre FROM sucursales WHERE activo ${suc ? 'AND id = $1' : ''}`, suc ? [suc] : []);
    const { rows: pls } = await query(`SELECT id, nombre, tipo, sucursal_id, hora_limite, (creado_en AT TIME ZONE '${TZ}')::date::text AS desde FROM checklist_plantillas WHERE activo`);
    const faltantes = [];
    for (let f = hasta; f >= desde; f = new Date(Date.parse(f) - 86400e3).toISOString().slice(0, 10)) {
      for (const s of sucs) for (const p of pls) {
        if (p.sucursal_id && Number(p.sucursal_id) !== Number(s.id)) continue;
        if (f < p.desde || f > jornadaActual()) continue; // antes de existir la plantilla no cuenta como faltante
        if (f === jornadaActual() && !vencida(f, p.hora_limite)) continue; // hoy todavía está a tiempo
        if (!rows.some((r) => r.jornada === f && r.sucursal === s.nombre && r.nombre === p.nombre)) faltantes.push({ jornada: f, sucursal: s.nombre, nombre: p.nombre, tipo: p.tipo });
      }
    }
    return { desde, hasta, registros: rows.map((r) => ({ ...r, id: Number(r.id), items: Number(r.items), hechos: Number(r.hechos) })), faltantes };
  });

  // ---- Plantillas ----
  route('GET', '/api/checklist/plantillas', async ({ user }) => {
    permitir(user, 'checklistConfig');
    const { rows: p } = await query('SELECT p.*, s.nombre AS sucursal FROM checklist_plantillas p LEFT JOIN sucursales s ON s.id = p.sucursal_id ORDER BY p.activo DESC, p.orden, p.id');
    const { rows: i } = await query('SELECT * FROM checklist_items WHERE activo ORDER BY orden, id');
    return p.map((x) => ({ id: Number(x.id), nombre: x.nombre, tipo: x.tipo, sucursal_id: x.sucursal_id ? Number(x.sucursal_id) : null, sucursal: x.sucursal || null,
      hora_limite: x.hora_limite, activo: isTrue(x.activo), orden: Number(x.orden),
      items: i.filter((y) => Number(y.plantilla_id) === Number(x.id)).map((y) => ({ id: Number(y.id), seccion: y.seccion, texto: y.texto, tipo_valor: y.tipo_valor, unidad: y.unidad, obligatorio: isTrue(y.obligatorio) })) }));
  });
  const guardarPlantilla = async (user, body, id) => {
    permitir(user, 'checklistConfig');
    const nombre = str(body.nombre, 80); if (!nombre) fail(400, 'Poné un nombre');
    const tipo = ['APERTURA', 'CIERRE', 'OTRO'].includes(body.tipo) ? body.tipo : 'OTRO';
    const hl = body.hora_limite ? (/^(\d{1,2}):(\d{2})$/.exec(String(body.hora_limite)) || fail(400, 'Hora límite inválida')) : null;
    const hora = hl ? `${hl[1].padStart(2, '0')}:${hl[2]}` : null;
    const items = (Array.isArray(body.items) ? body.items : []).map((x, n) => ({ id: idPos(x.id), texto: str(x.texto, 200), seccion: str(x.seccion, 60), orden: n + 1,
      tipo_valor: ['NUMERO', 'TEXTO'].includes(x.tipo_valor) ? x.tipo_valor : null, unidad: str(x.unidad, 20), obligatorio: x.obligatorio === undefined ? true : !!x.obligatorio })).filter((x) => x.texto);
    if (!items.length) fail(400, 'Agregá al menos una tarea');
    return tx(async (c) => {
      let pid = id;
      if (id) {
        const { rows } = await c.query('UPDATE checklist_plantillas SET nombre=$2, tipo=$3, sucursal_id=$4, hora_limite=$5, activo=$6, orden=$7 WHERE id=$1 RETURNING id',
          [id, nombre, tipo, idPos(body.sucursal_id), hora, body.activo === undefined ? true : !!body.activo, toInt(body.orden) || 0]);
        if (!rows.length) fail(404, 'Plantilla inexistente');
      } else {
        const { rows } = await c.query('INSERT INTO checklist_plantillas (nombre, tipo, sucursal_id, hora_limite, orden) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [nombre, tipo, idPos(body.sucursal_id), hora, toInt(body.orden) || 0]);
        pid = Number(rows[0].id);
      }
      const { rows: act } = await c.query('SELECT id FROM checklist_items WHERE plantilla_id = $1 AND activo', [pid]);
      const quedan = new Set(items.filter((x) => x.id).map((x) => x.id));
      for (const a of act) if (!quedan.has(Number(a.id))) {
        const { rows: usado } = await c.query('SELECT 1 FROM checklist_respuestas WHERE item_id = $1 LIMIT 1', [a.id]);
        if (usado.length) await c.query('UPDATE checklist_items SET activo = FALSE WHERE id = $1', [a.id]);
        else await c.query('DELETE FROM checklist_items WHERE id = $1', [a.id]);
      }
      for (const x of items) {
        if (x.id && act.some((a) => Number(a.id) === x.id)) await c.query('UPDATE checklist_items SET texto=$2, seccion=$3, orden=$4, tipo_valor=$5, unidad=$6, obligatorio=$7 WHERE id=$1', [x.id, x.texto, x.seccion, x.orden, x.tipo_valor, x.unidad, x.obligatorio]);
        else await c.query('INSERT INTO checklist_items (plantilla_id, texto, seccion, orden, tipo_valor, unidad, obligatorio) VALUES ($1,$2,$3,$4,$5,$6,$7)', [pid, x.texto, x.seccion, x.orden, x.tipo_valor, x.unidad, x.obligatorio]);
      }
      return { id: pid };
    });
  };
  route('POST', '/api/checklist/plantillas', ({ user, body }) => guardarPlantilla(user, body, null));
  route('PUT', '/api/checklist/plantillas/:id', ({ user, body, params }) => guardarPlantilla(user, body, idPos(params.id)));
};
module.exports.jornadaActual = jornadaActual;
module.exports.vencida = vencida;
