/* Vinilo · Gestión de Almacén — SPA sin dependencias */
(() => {
  'use strict';

  // ---------- Estado y utilidades ----------
  const S = { token: localStorage.getItem('vinilo_token'), user: null, permisos: [], almacenes: [] };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => Number(n || 0).toLocaleString('es-AR');
  const fmtFecha = (d) => (d ? new Date(d).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const fmtDia = (d) => (d ? d.split('-').reverse().join('/') : '');
  const puede = (p) => S.permisos.includes(p);
  const hoyISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const TIPO_LBL = { RECEPCION: 'Recepción', TRANSFERENCIA: 'Transferencia', CONSUMO: 'Consumo', AJUSTE: 'Ajuste' };
  const ROL_LBL = { ADMIN: 'Administrador', RECEPTOR: 'Receptor', ENCARGADO: 'Encargado', REQUIRENTE: 'Requirente', PROVEEDOR: 'Proveedor' };
  const OC_EST = { BORRADOR: 'Borrador', CONFIRMADA: 'Confirmada', PARCIAL: 'Recepción parcial', RECIBIDA: 'Recibida', CERRADA: 'Cerrada', ANULADA: 'Anulada' };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* sin cuerpo */ }
    if (res.status === 401 && path !== '/api/login') { logout(); throw new Error('Sesión vencida'); }
    if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
    return data;
  }

  let toastTimer;
  function toast(msg, error = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (error ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
  }

  function modal(html, { wide = false } = {}) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
    const bg = $('.modal-bg', root);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) closeModal(); });
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal));
    return $('.modal', root);
  }
  const closeModal = () => { $('#modal-root').innerHTML = ''; };

  function badgesAlerta(p) {
    let h = '';
    if (p.alerta_vencimiento) {
      const urg = p.dias_venc !== null && p.dias_venc <= 7;
      let txt = 'Vence pronto';
      if (p.fecha_vencimiento) txt = p.dias_venc < 0 ? `Vencido ${fmtDia(p.fecha_vencimiento)}` : `Vence ${fmtDia(p.fecha_vencimiento)}`;
      h += `<span class="badge b-venc ${urg ? 'urg' : ''}" title="Vencimiento próximo">⏳ ${esc(txt)}</span>`;
    }
    if (p.alerta_cuidado) h += '<span class="badge b-cuid" title="Producto de cuidado">⚠ Cuidado</span>';
    if (p.alerta_frio) h += '<span class="badge b-frio" title="Cadena de frío">❄ Frío</span>';
    return h;
  }
  const tieneAlerta = (p) => p.alerta_vencimiento || p.alerta_cuidado || p.alerta_frio;

  function descargarCSV(nombre, filas) {
    const csv = filas.map((r) => r.map((c) => {
      const s = String(c ?? '');
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(';')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Parser CSV simple (separador ; o , autodetectado, soporta comillas)
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const primera = text.split(/\r?\n/)[0] || '';
    const sep = (primera.match(/;/g) || []).length >= (primera.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  // ---------- Sesión ----------
  function logout() {
    S.token = null; S.user = null;
    localStorage.removeItem('vinilo_token');
    renderLogin();
  }

  function renderLogin() {
    $('#app').innerHTML = `
      <div class="login">
        <form id="login-form">
          <div class="logo"><img src="/favicon.svg" alt=""><div><b>VINILO</b><small>Gestión de Almacén</small></div></div>
          <div class="f"><label for="u">Usuario</label><input id="u" autocomplete="username" required autofocus></div>
          <div class="f"><label for="p">Contraseña</label><input id="p" type="password" autocomplete="current-password" required></div>
          <div class="err" id="login-err"></div>
          <button class="btn" type="submit">Ingresar</button>
        </form>
      </div>`;
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#login-form button');
      btn.disabled = true;
      try {
        const r = await api('/api/login', { method: 'POST', body: { username: $('#u').value, password: $('#p').value } });
        S.token = r.token;
        localStorage.setItem('vinilo_token', r.token);
        await boot();
      } catch (err) {
        $('#login-err').textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  async function boot() {
    if (!S.token) return renderLogin();
    try {
      const me = await api('/api/me');
      S.user = me.user; S.permisos = me.permisos;
      S.almacenes = await api('/api/almacenes');
    } catch (_) { return renderLogin(); }
    renderShell();
    router();
  }

  // ---------- Navegación ----------
  const NAV = [
    { sec: 'General' },
    { id: 'panel', lbl: 'Panel', ok: () => true },
    { id: 'stock', lbl: 'Stock por almacén', ok: () => puede('verStock') },
    { id: 'pedidos', lbl: 'Notas de pedido', ok: () => puede('verPedidos'), pill: true },
    { id: 'compras', lbl: 'Mis pedidos', ok: () => puede('portalProveedor'), pillOc: true },
    { sec: 'Compras', ok: () => puede('compras') || puede('verCompras') },
    { id: 'compras', lbl: 'Pedidos a proveedores', ok: () => puede('compras') || puede('verCompras'), pillOc: true },
    { id: 'proveedores', lbl: 'Proveedores', ok: () => puede('compras') || puede('parametrizar') },
    { sec: 'Operaciones', ok: () => puede('recibir') || puede('consumir') },
    { id: 'recepcion', lbl: 'Recepción', ok: () => puede('recibir') },
    { id: 'transferencia', lbl: 'Transferencia', ok: () => puede('transferir') },
    { id: 'consumo', lbl: 'Consumo', ok: () => puede('consumir') },
    { id: 'ajuste', lbl: 'Ajuste de inventario', ok: () => puede('ajustar') },
    { id: 'movimientos', lbl: 'Movimientos', ok: () => puede('verMovimientos') },
    { sec: 'Parametrización', ok: () => puede('parametrizar') },
    { id: 'productos', lbl: 'Productos', ok: () => puede('parametrizar') },
    { id: 'almacenes', lbl: 'Almacenes', ok: () => puede('parametrizar') },
    { id: 'usuarios', lbl: 'Usuarios', ok: () => puede('parametrizar') },
  ];

  function renderShell() {
    const links = NAV.filter((n) => !n.ok || n.ok()).map((n) => n.sec
      ? `<div class="sec">${n.sec}</div>`
      : `<a class="nav" href="#/${n.id}" data-nav="${n.id}">${n.lbl}${n.pill ? '<span class="pill" id="pill-ped" hidden></span>' : ''}${n.pillOc ? '<span class="pill" id="pill-oc" hidden></span>' : ''}</a>`).join('');
    $('#app').innerHTML = `
      <div class="topbar"><button id="menu-btn" aria-label="Menú">☰</button><b>VINILO</b></div>
      <div class="layout">
        <nav class="side" id="side">
          <div class="brand"><img src="/favicon.svg" alt=""><div><b>VINILO</b><small>Gestión de Almacén</small></div></div>
          ${links}
          <div class="who"><b>${esc(S.user.nombre)}</b>${ROL_LBL[S.user.rol]}${S.user.proveedor ? ' · ' + esc(S.user.proveedor) : ''}${S.user.permiso_compras && S.user.rol !== 'ADMIN' ? ' · Compras' : ''}
            <div class="links"><button id="pwd-btn">Contraseña</button><button id="out-btn">Salir</button></div></div>
        </nav>
        <main id="main"></main>
      </div>`;
    $('#out-btn').onclick = logout;
    $('#pwd-btn').onclick = cambiarPassword;
    $('#menu-btn').onclick = () => $('#side').classList.toggle('open');
    $$('#side a.nav').forEach((a) => a.addEventListener('click', () => $('#side').classList.remove('open')));
  }

  async function actualizarPill() {
    try {
      if (puede('verPedidos')) {
        const pend = await api('/api/pedidos?estado=PENDIENTE');
        const pill = $('#pill-ped');
        if (pill) { pill.textContent = pend.length; pill.hidden = pend.length === 0; }
      }
      const pillOc = $('#pill-oc');
      if (pillOc) {
        // Proveedor: pedidos confirmados por entregar · Receptor: por recibir · Compras: borradores por confirmar
        const ocs = await api('/api/oc?estado=ABIERTAS');
        const n = ocs.filter((o) => (puede('compras') ? o.estado === 'BORRADOR' : ['CONFIRMADA', 'PARCIAL'].includes(o.estado))).length;
        pillOc.textContent = n; pillOc.hidden = n === 0;
      }
    } catch (_) { /* ignore */ }
  }

  const VIEWS = {};
  async function router() {
    if (!S.user) return;
    const id = (location.hash.replace(/^#\/?/, '') || 'panel').split('?')[0];
    const nav = NAV.find((n) => n.id === id && (!n.ok || n.ok()));
    const view = nav ? id : 'panel';
    $$('#side a.nav').forEach((a) => a.classList.toggle('on', a.dataset.nav === view));
    const main = $('#main');
    main.innerHTML = '<p class="muted">Cargando…</p>';
    try { await VIEWS[view](main); }
    catch (err) { main.innerHTML = `<div class="card"><b>Error:</b> ${esc(err.message)}</div>`; }
    actualizarPill();
  }
  window.addEventListener('hashchange', router);

  function cambiarPassword() {
    const m = modal(`
      <h2>Cambiar contraseña</h2>
      <form id="f-pwd">
        <div class="f mt"><label>Contraseña actual</label><input type="password" name="actual" required></div>
        <div class="f mt"><label>Nueva contraseña (mín. 6)</label><input type="password" name="nueva" minlength="6" required></div>
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div>
      </form>`);
    $('#f-pwd', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/me/password', { method: 'POST', body: Object.fromEntries(fd) });
        closeModal(); toast('Contraseña actualizada');
      } catch (err) { toast(err.message, true); }
    });
  }

  const optAlmacenes = (sel, { soloActivos = true, vacio = '' } = {}) =>
    (vacio ? `<option value="">${vacio}</option>` : '') +
    S.almacenes.filter((a) => !soloActivos || a.activo).map((a) => `<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('');

  // ---------- Panel ----------
  VIEWS.panel = async (main) => {
    const d = await api('/api/dashboard');
    let html = `<h1>Hola, ${esc(S.user.nombre.split(' ')[0])}</h1><p class="sub">${ROL_LBL[S.user.rol]}${S.user.proveedor ? ' · ' + esc(S.user.proveedor) : ''} · ${new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>`;
    const oc = d.oc || {};
    const kpiOc = (lbl, n, det, href = '#/compras') => `<a class="kpi acc" href="${href}" style="text-decoration:none"><div class="lbl">${lbl}</div><div class="val">${n || 0}</div><div class="det">${det}</div></a>`;
    if (S.user.rol === 'PROVEEDOR') {
      html += `<div class="grid cols-3">${kpiOc('Pedidos por entregar', oc.CONFIRMADA, 'confirmados por Vinilo')}${kpiOc('Entregas parciales', oc.PARCIAL, 'con productos pendientes')}${kpiOc('Completados', (oc.RECIBIDA || 0) + (oc.CERRADA || 0), 'recibidos o cerrados')}</div>
        <div class="card mt"><p style="margin:0">En <a href="#/compras"><b>Mis pedidos</b></a> ves cada nota de pedido, lo que Vinilo ya recibió y lo pendiente, y podés subir el <b>remito</b> o la <b>factura</b> (PDF o foto).</p></div>`;
      main.innerHTML = html;
      return;
    }
    if (d.oc && (puede('compras') || puede('recibir'))) {
      html += `<div class="grid cols-3" style="margin-bottom:14px">${puede('compras') ? kpiOc('Borradores sin confirmar', oc.BORRADOR, 'pedidos a proveedores') : ''}${kpiOc('Por recibir de proveedores', oc.CONFIRMADA, 'confirmados')}${kpiOc('Recepción parcial', oc.PARCIAL, 'con faltantes')}</div>`;
    }
    if (d.almacenes) {
      html += '<div class="grid cols-3">' + d.almacenes.filter((a) => a.activo).map((a) => `
        <a class="kpi" href="#/stock?alm=${a.id}" style="text-decoration:none">
          <div class="lbl">${esc(a.nombre)}</div><div class="val">${fmtN(a.unidades)}</div>
          <div class="det">unidades · ${fmtN(a.productos)} productos con stock</div></a>`).join('') + `
        <a class="kpi acc" href="#/pedidos" style="text-decoration:none"><div class="lbl">Notas de pedido pendientes</div>
          <div class="val">${d.pedidos_pendientes}</div><div class="det">${puede('atenderPedido') ? 'para atender' : 'en curso'}</div></a></div>`;
      const conStock = d.alertas.filter((a) => a.total > 0);
      html += `<div class="card mt"><h2>Productos con alerta (${conStock.length} con stock)</h2>${conStock.length ? `
        <div class="tbl-wrap"><table><thead><tr><th>Producto</th><th>Alertas</th><th>Nota</th><th class="num">Stock total</th></tr></thead><tbody>
        ${conStock.map((p) => `<tr><td><span class="code">${esc(p.codigo)}</span> ${esc(p.nombre)}</td><td>${badgesAlerta(p)}</td><td class="muted">${esc(p.nota_alerta || '')}</td><td class="num">${fmtN(p.total)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No hay productos con alerta y stock.</p>'}</div>`;
      html += `<div class="card"><h2>Últimos movimientos</h2>${d.ultimos.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Fecha</th><th>Tipo</th><th>Desde</th><th>Hacia</th><th>Usuario</th></tr></thead><tbody>
        ${d.ultimos.map((m) => `<tr><td>${m.id}</td><td>${fmtFecha(m.fecha)}</td><td><span class="badge b-${m.tipo}">${TIPO_LBL[m.tipo]}</span></td><td>${esc(m.origen || '—')}</td><td>${esc(m.destino || '—')}</td><td>${esc(m.usuario)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Todavía no hay movimientos.</p>'}</div>`;
    } else {
      html += `<div class="grid cols-3"><a class="kpi acc" href="#/pedidos" style="text-decoration:none"><div class="lbl">Mis pedidos pendientes</div><div class="val">${d.pedidos_pendientes}</div></a></div>
        <div class="form-actions" style="justify-content:flex-start"><a class="btn" href="#/pedidos?nuevo=1" style="text-decoration:none">+ Nueva nota de pedido</a></div>`;
    }
    main.innerHTML = html;
  };

  // ---------- Stock ----------
  VIEWS.stock = async (main) => {
    const data = await api('/api/stock');
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const alms = data.almacenes.filter((a) => a.activo);
    const cats = [...new Set(data.productos.map((p) => p.categoria).filter(Boolean))].sort();
    main.innerHTML = `
      <h1>Stock por almacén</h1><p class="sub">Cantidades en unidades. Las alertas las define el administrador en cada producto.</p>
      <div class="toolbar">
        <div class="grow"><label>Buscar</label><input id="s-q" placeholder="Código o nombre…"></div>
        <div class="f"><label>Almacén</label><select id="s-alm"><option value="">Todos</option>${alms.map((a) => `<option value="${a.id}" ${params.get('alm') == a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></div>
        <div class="f"><label>Categoría</label><select id="s-cat"><option value="">Todas</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="f"><label>Alerta</label><select id="s-al"><option value="">Todas</option><option value="any">Cualquier alerta</option><option value="venc">Vencimiento próximo</option><option value="cuid">De cuidado</option><option value="frio">Cadena de frío</option></select></div>
        <label class="check" style="margin-bottom:10px"><input type="checkbox" id="s-cero"> Mostrar sin stock</label>
        <div class="spacer"></div>
        <button class="btn sec" id="s-csv">Exportar CSV</button>
      </div>
      <div id="s-tbl"></div>`;
    const filtrar = () => {
      const q = $('#s-q').value.trim().toLowerCase();
      const almId = $('#s-alm').value;
      const cat = $('#s-cat').value;
      const al = $('#s-al').value;
      const cero = $('#s-cero').checked;
      const cols = almId ? alms.filter((a) => String(a.id) === almId) : alms;
      const rows = data.productos.filter((p) => {
        if (q && !(`${p.codigo} ${p.nombre}`.toLowerCase().includes(q))) return false;
        if (cat && p.categoria !== cat) return false;
        if (al === 'any' && !tieneAlerta(p)) return false;
        if (al === 'venc' && !p.alerta_vencimiento) return false;
        if (al === 'cuid' && !p.alerta_cuidado) return false;
        if (al === 'frio' && !p.alerta_frio) return false;
        const cant = almId ? (p.stock[almId] || 0) : p.total;
        if (!cero && cant === 0) return false;
        if (!p.activo && cant === 0) return false;
        return true;
      });
      return { cols, rows, almId };
    };
    const pintar = () => {
      const { cols, rows, almId } = filtrar();
      const totCols = cols.map((a) => rows.reduce((s, p) => s + (p.stock[a.id] || 0), 0));
      $('#s-tbl').innerHTML = rows.length ? `<div class="tbl-wrap"><table>
        <thead><tr><th>Código</th><th>Producto</th><th>Alertas</th>${cols.map((a) => `<th class="num">${esc(a.nombre)}</th>`).join('')}${almId ? '' : '<th class="num">Total</th>'}</tr></thead>
        <tbody>${rows.map((p) => `<tr class="${p.activo ? '' : 'inactive'}"><td class="code">${esc(p.codigo)}</td><td>${esc(p.nombre)}${p.categoria ? ` <span class="muted">· ${esc(p.categoria)}</span>` : ''}${p.activo ? '' : ' <span class="muted">(inactivo)</span>'}</td>
          <td>${badgesAlerta(p)}</td>${cols.map((a) => { const v = p.stock[a.id] || 0; return `<td class="num ${v ? '' : 'zero'}">${fmtN(v)}</td>`; }).join('')}${almId ? '' : `<td class="num tot">${fmtN(p.total)}</td>`}</tr>`).join('')}</tbody>
        <tfoot><tr><td></td><td><b>${rows.length} productos</b></td><td></td>${totCols.map((t) => `<td class="num tot">${fmtN(t)}</td>`).join('')}${almId ? '' : `<td class="num tot">${fmtN(totCols.reduce((a, b) => a + b, 0))}</td>`}</tr></tfoot>
        </table></div>` : '<div class="card empty">No hay productos que coincidan con el filtro.</div>';
    };
    ['#s-q', '#s-alm', '#s-cat', '#s-al', '#s-cero'].forEach((s) => $(s).addEventListener('input', pintar));
    $('#s-csv').onclick = () => {
      const { cols, rows } = filtrar();
      descargarCSV(`stock_${hoyISO()}.csv`, [
        ['Codigo', 'Producto', 'Categoria', 'Vencimiento proximo', 'Fecha vencimiento', 'Cuidado', 'Cadena de frio', ...cols.map((a) => a.nombre), 'Total'],
        ...rows.map((p) => [p.codigo, p.nombre, p.categoria || '', p.alerta_vencimiento ? 'SI' : '', p.fecha_vencimiento || '', p.alerta_cuidado ? 'SI' : '', p.alerta_frio ? 'SI' : '',
          ...cols.map((a) => p.stock[a.id] || 0), cols.reduce((s, a) => s + (p.stock[a.id] || 0), 0)]),
      ]);
    };
    pintar();
  };

  // ---------- Formulario de movimientos (recepción / transferencia / consumo / ajuste) ----------
  function movimientoView(tipo) {
    return async (main) => {
      const conStock = tipo !== 'RECEPCION';
      const stockData = puede('verStock') ? await api('/api/stock') : { productos: await api('/api/productos') };
      const productos = stockData.productos.filter((p) => p.activo);
      const pMap = new Map(productos.map((p) => [p.id, p]));
      const cfg = {
        RECEPCION: { t: 'Recepción de mercadería', s: 'Ingreso de productos a un almacén (compra, remito de proveedor, devolución).', origen: false, destino: true, ref: 'Remito / proveedor', btn: 'Registrar recepción' },
        TRANSFERENCIA: { t: 'Transferencia entre almacenes', s: 'Mueve unidades de un almacén a otro. Se valida el stock disponible en el origen.', origen: true, destino: true, ref: 'Referencia', btn: 'Registrar transferencia' },
        CONSUMO: { t: 'Consumo', s: 'Baja de stock por uso, venta en barra, merma o rotura.', origen: true, destino: false, ref: 'Motivo / referencia', btn: 'Registrar consumo' },
        AJUSTE: { t: 'Ajuste de inventario', s: 'Cargá la cantidad contada físicamente. El sistema registra la diferencia contra el stock actual.', origen: true, destino: false, ref: 'Referencia del conteo', btn: 'Registrar ajuste' },
      }[tipo];
      const lineas = [];
      main.innerHTML = `
        <h1>${cfg.t}</h1><p class="sub">${cfg.s}</p>
        <div class="card">
          <div class="row">
            ${cfg.origen ? `<div class="f"><label>${tipo === 'TRANSFERENCIA' ? 'Desde (origen)' : 'Almacén'}</label><select id="m-origen">${optAlmacenes('', { vacio: 'Seleccionar…' })}</select></div>` : ''}
            ${cfg.destino ? `<div class="f"><label>${tipo === 'TRANSFERENCIA' ? 'Hacia (destino)' : 'Almacén que recibe'}</label><select id="m-destino">${optAlmacenes('', { vacio: 'Seleccionar…' })}</select></div>` : ''}
            <div class="f"><label>${cfg.ref}</label><input id="m-ref" maxlength="120"></div>
          </div>
        </div>
        <div class="card">
          <h2>Productos</h2>
          <div class="row">
            <div class="f w"><label>Producto (buscá por código o nombre)</label><input id="m-prod" list="m-prod-list" autocomplete="off" placeholder="Escribí para buscar…">
              <datalist id="m-prod-list">${productos.map((p) => `<option value="${esc(p.codigo)} — ${esc(p.nombre)}"></option>`).join('')}</datalist></div>
            <div class="f s"><label>${tipo === 'AJUSTE' ? 'Cant. contada' : 'Cantidad'}</label><input id="m-cant" type="number" min="${tipo === 'AJUSTE' ? 0 : 1}" step="1" inputmode="numeric"></div>
            <div><button class="btn sec" id="m-add" type="button">Agregar</button></div>
          </div>
          <div id="m-hint" class="stock-hint mt"></div>
          <div id="m-lines" class="mt"></div>
          <div class="f mt"><label>Observaciones</label><textarea id="m-obs" maxlength="1000"></textarea></div>
          <div class="form-actions"><button class="btn sec" id="m-clear" type="button">Limpiar</button><button class="btn" id="m-save" type="button">${cfg.btn}</button></div>
        </div>`;

      const origenId = () => (cfg.origen ? Number($('#m-origen').value) || null : null);
      const disponible = (pid) => {
        const p = pMap.get(pid);
        const o = origenId();
        return p && p.stock && o ? (p.stock[o] || 0) : null;
      };
      const buscarProducto = (txt) => {
        const codigo = txt.split(' — ')[0].trim().toUpperCase();
        return productos.find((p) => p.codigo.toUpperCase() === codigo) ||
          productos.find((p) => p.nombre.toLowerCase() === txt.trim().toLowerCase());
      };
      const hint = () => {
        const p = buscarProducto($('#m-prod').value);
        const h = $('#m-hint');
        if (!p) { h.innerHTML = ''; return; }
        const d = disponible(p.id);
        h.innerHTML = `${badgesAlerta(p)} ${p.nota_alerta ? esc(p.nota_alerta) + ' · ' : ''}${conStock && d !== null ? `Stock en origen: <b>${fmtN(d)}</b> ${esc(p.unidad)}` : ''}`;
      };
      const pintar = () => {
        if (!lineas.length) { $('#m-lines').innerHTML = '<div class="empty" style="border:1px dashed var(--line);border-radius:10px">Todavía no agregaste productos.</div>'; return; }
        $('#m-lines').innerHTML = `<div class="tbl-wrap lines"><table><thead><tr><th>Código</th><th>Producto</th><th>Alertas</th>${conStock ? `<th class="num">${tipo === 'AJUSTE' ? 'Stock sistema' : 'Disponible'}</th>` : ''}<th class="num" style="width:130px">${tipo === 'AJUSTE' ? 'Contado' : 'Cantidad'}</th>${tipo === 'AJUSTE' ? '<th class="num">Diferencia</th>' : ''}<th></th></tr></thead><tbody>
          ${lineas.map((l, i) => {
            const p = pMap.get(l.producto_id);
            const d = disponible(l.producto_id);
            const bad = (tipo === 'TRANSFERENCIA' || tipo === 'CONSUMO') && d !== null && l.cantidad > d;
            return `<tr><td class="code">${esc(p.codigo)}</td><td>${esc(p.nombre)}</td><td>${badgesAlerta(p)}</td>
              ${conStock ? `<td class="num">${d === null ? '—' : fmtN(d)}</td>` : ''}
              <td class="num"><input type="number" min="${tipo === 'AJUSTE' ? 0 : 1}" step="1" value="${l.cantidad}" data-i="${i}" style="width:110px;text-align:right"></td>
              ${tipo === 'AJUSTE' ? `<td class="num">${d === null ? '—' : ((l.cantidad - d) > 0 ? '+' : '') + fmtN(l.cantidad - d)}</td>` : ''}
              <td class="num">${bad ? '<span class="stock-hint bad">Supera stock</span> ' : ''}<button class="btn ghost sm" data-del="${i}" title="Quitar">✕</button></td></tr>`;
          }).join('')}</tbody></table></div>`;
        $$('#m-lines input[data-i]').forEach((inp) => inp.addEventListener('change', () => { lineas[inp.dataset.i].cantidad = parseInt(inp.value, 10) || 0; pintar(); }));
        $$('#m-lines [data-del]').forEach((b) => b.addEventListener('click', () => { lineas.splice(Number(b.dataset.del), 1); pintar(); }));
      };
      const agregar = () => {
        const p = buscarProducto($('#m-prod').value);
        const cant = parseInt($('#m-cant').value, 10);
        if (!p) return toast('Elegí un producto de la lista', true);
        if (!Number.isInteger(cant) || cant < (tipo === 'AJUSTE' ? 0 : 1)) return toast('Ingresá una cantidad válida', true);
        const ex = lineas.find((l) => l.producto_id === p.id);
        if (ex) ex.cantidad = tipo === 'AJUSTE' ? cant : ex.cantidad + cant;
        else lineas.push({ producto_id: p.id, cantidad: cant });
        $('#m-prod').value = ''; $('#m-cant').value = ''; $('#m-hint').innerHTML = '';
        $('#m-prod').focus();
        pintar();
      };
      $('#m-prod').addEventListener('input', hint);
      $('#m-prod').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#m-cant').focus(); } });
      $('#m-cant').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); agregar(); } });
      $('#m-add').onclick = agregar;
      if (cfg.origen) $('#m-origen').addEventListener('change', () => { hint(); pintar(); });
      $('#m-clear').onclick = () => { lineas.length = 0; $('#m-obs').value = ''; $('#m-ref').value = ''; pintar(); };
      $('#m-save').onclick = async () => {
        if (!lineas.length) return toast('Agregá al menos un producto', true);
        const btn = $('#m-save');
        btn.disabled = true;
        try {
          const r = await api('/api/movimientos', { method: 'POST', body: {
            tipo, origen_id: cfg.origen ? $('#m-origen').value : null, destino_id: cfg.destino ? $('#m-destino').value : null,
            referencia: $('#m-ref').value, observacion: $('#m-obs').value, items: lineas,
          } });
          toast(`${TIPO_LBL[tipo]} #${r.id} registrada`);
          router();
        } catch (err) { toast(err.message, true); btn.disabled = false; }
      };
      pintar();
    };
  }
  VIEWS.recepcion = movimientoView('RECEPCION');
  VIEWS.transferencia = movimientoView('TRANSFERENCIA');
  VIEWS.consumo = movimientoView('CONSUMO');
  VIEWS.ajuste = movimientoView('AJUSTE');

  // ---------- Movimientos ----------
  VIEWS.movimientos = async (main) => {
    main.innerHTML = `
      <h1>Movimientos</h1><p class="sub">Historial de recepciones, transferencias, consumos y ajustes (últimos 500 según filtro).</p>
      <div class="toolbar">
        <div class="f"><label>Tipo</label><select id="v-tipo"><option value="">Todos</option>${Object.entries(TIPO_LBL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="f"><label>Almacén</label><select id="v-alm">${optAlmacenes('', { soloActivos: false, vacio: 'Todos' })}</select></div>
        <div class="f"><label>Desde</label><input type="date" id="v-desde"></div>
        <div class="f"><label>Hasta</label><input type="date" id="v-hasta"></div>
        <div class="spacer"></div><button class="btn sec" id="v-csv">Exportar CSV</button>
      </div><div id="v-tbl"></div>`;
    let rows = [];
    const cargar = async () => {
      const qs = new URLSearchParams();
      [['tipo', '#v-tipo'], ['almacen_id', '#v-alm'], ['desde', '#v-desde'], ['hasta', '#v-hasta']].forEach(([k, s]) => { if ($(s).value) qs.set(k, $(s).value); });
      rows = await api('/api/movimientos?' + qs);
      $('#v-tbl').innerHTML = rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Fecha</th><th>Tipo</th><th>Desde</th><th>Hacia</th><th>Referencia</th><th class="num">Ítems</th><th class="num">Unidades</th><th>Usuario</th><th></th></tr></thead><tbody>
        ${rows.map((m) => `<tr><td>${m.id}</td><td>${fmtFecha(m.fecha)}</td><td><span class="badge b-${m.tipo}">${TIPO_LBL[m.tipo]}</span></td><td>${esc(m.origen || '—')}</td><td>${esc(m.destino || (m.tipo === 'AJUSTE' ? '' : '—'))}</td>
          <td>${esc(m.referencia || '')}</td><td class="num">${m.items}</td><td class="num">${m.tipo === 'AJUSTE' && m.unidades > 0 ? '+' : ''}${fmtN(m.unidades)}</td><td>${esc(m.usuario)}</td>
          <td><button class="btn ghost sm" data-ver="${m.id}">Ver</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">Sin movimientos para el filtro.</div>';
      $$('[data-ver]').forEach((b) => b.addEventListener('click', () => verMovimiento(b.dataset.ver)));
    };
    ['#v-tipo', '#v-alm', '#v-desde', '#v-hasta'].forEach((s) => $(s).addEventListener('change', () => cargar().catch((e) => toast(e.message, true))));
    $('#v-csv').onclick = () => descargarCSV(`movimientos_${hoyISO()}.csv`, [
      ['Id', 'Fecha', 'Tipo', 'Desde', 'Hacia', 'Referencia', 'Items', 'Unidades', 'Usuario', 'Observacion'],
      ...rows.map((m) => [m.id, fmtFecha(m.fecha), TIPO_LBL[m.tipo], m.origen || '', m.destino || '', m.referencia || '', m.items, m.unidades, m.usuario, m.observacion || '']),
    ]);
    await cargar();
  };

  async function verMovimiento(id) {
    try {
      const m = await api('/api/movimientos/' + id);
      modal(`<h2>${TIPO_LBL[m.tipo]} #${m.id}</h2>
        <p class="muted">${fmtFecha(m.fecha)} · ${esc(m.usuario)}${m.origen ? ` · Desde <b>${esc(m.origen)}</b>` : ''}${m.destino ? ` · Hacia <b>${esc(m.destino)}</b>` : ''}</p>
        ${m.referencia ? `<p><b>Referencia:</b> ${esc(m.referencia)}</p>` : ''}${m.pedido_id ? `<p><b>Nota de pedido:</b> #${m.pedido_id}</p>` : ''}
        <div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th></tr></thead><tbody>
        ${m.items.map((i) => `<tr><td class="code">${esc(i.codigo)}</td><td>${esc(i.nombre)}</td><td class="num">${m.tipo === 'AJUSTE' && i.cantidad > 0 ? '+' : ''}${fmtN(i.cantidad)} ${esc(i.unidad)}</td></tr>`).join('')}
        </tbody></table></div>${m.observacion ? `<p class="obs mt">${esc(m.observacion)}</p>` : ''}
        <div class="form-actions"><button class="btn sec" data-close>Cerrar</button></div>`, { wide: true });
    } catch (err) { toast(err.message, true); }
  }

  // ---------- Notas de pedido ----------
  VIEWS.pedidos = async (main) => {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    main.innerHTML = `
      <h1>Notas de pedido</h1><p class="sub">${S.user.rol === 'REQUIRENTE' ? 'Solicitá transferencias de mercadería entre almacenes y seguí su estado.' : 'Solicitudes de transferencia entre almacenes.'}</p>
      <div class="toolbar">
        <div class="f"><label>Estado</label><select id="p-est"><option value="PENDIENTE">Pendientes</option><option value="">Todos</option><option value="COMPLETADO">Completados</option><option value="RECHAZADO">Rechazados</option><option value="CANCELADO">Cancelados</option></select></div>
        <div class="spacer"></div>${puede('crearPedido') ? '<button class="btn" id="p-new">+ Nueva nota de pedido</button>' : ''}
      </div><div id="p-list"></div>`;
    const cargar = async () => {
      const est = $('#p-est').value;
      const list = await api('/api/pedidos' + (est ? '?estado=' + est : ''));
      $('#p-list').innerHTML = list.length ? list.map((p) => `
        <div class="pedido"><header>
          <span class="t">#${p.id}</span><span class="badge b-${p.estado}">${p.estado}</span>
          <span><b>${esc(p.origen)}</b> → <b>${esc(p.destino)}</b></span><span class="sp"></span>
          <span class="r">${esc(p.solicitante)} · ${fmtFecha(p.creado_en)}</span>
        </header><div class="body">
          <div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Producto</th><th class="num">Pedido</th>${p.estado === 'PENDIENTE' && puede('atenderPedido') ? `<th class="num">Disp. en ${esc(p.origen)}</th>` : ''}${p.estado === 'COMPLETADO' ? '<th class="num">Entregado</th>' : ''}</tr></thead><tbody>
          ${p.items.map((i) => `<tr><td class="code">${esc(i.codigo)}</td><td>${esc(i.nombre)}</td><td class="num">${fmtN(i.cantidad)}</td>
            ${p.estado === 'PENDIENTE' && puede('atenderPedido') ? `<td class="num ${i.disponible_origen < i.cantidad ? 'stock-hint bad' : ''}">${fmtN(i.disponible_origen)}</td>` : ''}
            ${p.estado === 'COMPLETADO' ? `<td class="num">${fmtN(i.cantidad_entregada)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
          ${p.observacion ? `<p class="obs">📝 ${esc(p.observacion)}</p>` : ''}
          ${p.motivo_rechazo ? `<p class="obs">Motivo de rechazo: ${esc(p.motivo_rechazo)}</p>` : ''}
          ${p.atendido_por ? `<p class="obs">Atendido por ${esc(p.atendido_por)} · ${fmtFecha(p.atendido_en)}</p>` : ''}
          ${p.estado === 'PENDIENTE' ? `<div class="form-actions">
            ${(p.solicitante_id === S.user.id || S.user.rol === 'ADMIN') ? `<button class="btn sec sm" data-cancel="${p.id}">Cancelar pedido</button>` : ''}
            ${puede('atenderPedido') ? `<button class="btn danger sm" data-rech="${p.id}">Rechazar</button><button class="btn ok sm" data-aten="${p.id}">Atender y transferir</button>` : ''}
          </div>` : ''}
        </div></div>`).join('') : '<div class="card empty">No hay notas de pedido para este filtro.</div>';
      $$('[data-aten]').forEach((b) => b.addEventListener('click', () => atenderPedido(list.find((x) => x.id == b.dataset.aten), cargar)));
      $$('[data-rech]').forEach((b) => b.addEventListener('click', () => rechazarPedido(b.dataset.rech, cargar)));
      $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('¿Cancelar esta nota de pedido?')) return;
        try { await api(`/api/pedidos/${b.dataset.cancel}/cancelar`, { method: 'POST' }); toast('Pedido cancelado'); cargar(); actualizarPill(); }
        catch (err) { toast(err.message, true); }
      }));
    };
    $('#p-est').addEventListener('change', () => cargar().catch((e) => toast(e.message, true)));
    if ($('#p-new')) $('#p-new').onclick = () => nuevoPedido(cargar);
    await cargar();
    if (params.get('nuevo') && puede('crearPedido')) nuevoPedido(cargar);
  };

  async function nuevoPedido(onDone) {
    const productos = (await api('/api/productos')).filter((p) => p.activo);
    const lineas = [];
    const m = modal(`<h2>Nueva nota de pedido</h2>
      <div class="row"><div class="f"><label>Pedir desde (origen)</label><select id="n-orig">${optAlmacenes('', { vacio: 'Seleccionar…' })}</select></div>
        <div class="f"><label>Para (destino)</label><select id="n-dest">${optAlmacenes('', { vacio: 'Seleccionar…' })}</select></div></div>
      <div class="row mt"><div class="f w"><label>Producto</label><input id="n-prod" list="n-prod-list" autocomplete="off" placeholder="Código o nombre…">
        <datalist id="n-prod-list">${productos.map((p) => `<option value="${esc(p.codigo)} — ${esc(p.nombre)}"></option>`).join('')}</datalist></div>
        <div class="f s"><label>Cantidad</label><input id="n-cant" type="number" min="1" step="1" inputmode="numeric"></div>
        <div><button class="btn sec" id="n-add" type="button">Agregar</button></div></div>
      <div id="n-lines" class="mt"></div>
      <div class="f mt"><label>Observaciones</label><textarea id="n-obs" maxlength="1000" placeholder="Ej.: para el evento del sábado"></textarea></div>
      <div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn" id="n-save">Enviar pedido</button></div>`, { wide: true });
    const buscar = (txt) => { const c = txt.split(' — ')[0].trim().toUpperCase(); return productos.find((p) => p.codigo.toUpperCase() === c); };
    const pintar = () => {
      $('#n-lines', m).innerHTML = lineas.length ? `<div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th></th></tr></thead><tbody>
        ${lineas.map((l, i) => `<tr><td class="code">${esc(l.p.codigo)}</td><td>${esc(l.p.nombre)} ${badgesAlerta(l.p)}</td><td class="num">${fmtN(l.cantidad)}</td><td class="num"><button class="btn ghost sm" data-del="${i}">✕</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Agregá los productos que necesitás.</p>';
      $$('[data-del]', m).forEach((b) => b.addEventListener('click', () => { lineas.splice(Number(b.dataset.del), 1); pintar(); }));
    };
    const agregar = () => {
      const p = buscar($('#n-prod', m).value);
      const c = parseInt($('#n-cant', m).value, 10);
      if (!p) return toast('Elegí un producto de la lista', true);
      if (!Number.isInteger(c) || c < 1) return toast('Ingresá una cantidad válida', true);
      const ex = lineas.find((l) => l.p.id === p.id);
      if (ex) ex.cantidad += c; else lineas.push({ p, cantidad: c });
      $('#n-prod', m).value = ''; $('#n-cant', m).value = ''; $('#n-prod', m).focus();
      pintar();
    };
    $('#n-add', m).onclick = agregar;
    $('#n-prod', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#n-cant', m).focus(); } });
    $('#n-cant', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); agregar(); } });
    $('#n-save', m).onclick = async () => {
      if (!lineas.length) return toast('Agregá al menos un producto', true);
      try {
        const r = await api('/api/pedidos', { method: 'POST', body: {
          origen_id: $('#n-orig', m).value, destino_id: $('#n-dest', m).value, observacion: $('#n-obs', m).value,
          items: lineas.map((l) => ({ producto_id: l.p.id, cantidad: l.cantidad })),
        } });
        closeModal(); toast(`Nota de pedido #${r.id} enviada`);
        history.replaceState(null, '', '#/pedidos');
        onDone(); actualizarPill();
      } catch (err) { toast(err.message, true); }
    };
    pintar();
  }

  function atenderPedido(p, onDone) {
    const m = modal(`<h2>Atender nota de pedido #${p.id}</h2>
      <p class="muted">Se registrará una transferencia de <b>${esc(p.origen)}</b> a <b>${esc(p.destino)}</b>. Podés ajustar las cantidades para entregas parciales (0 = no se entrega).</p>
      <div class="tbl-wrap"><table><thead><tr><th>Producto</th><th class="num">Pedido</th><th class="num">Disponible</th><th class="num">A entregar</th></tr></thead><tbody>
      ${p.items.map((i) => `<tr><td>${esc(i.nombre)} <span class="code">${esc(i.codigo)}</span></td><td class="num">${fmtN(i.cantidad)}</td>
        <td class="num ${i.disponible_origen < i.cantidad ? 'stock-hint bad' : ''}">${fmtN(i.disponible_origen)}</td>
        <td class="num"><input type="number" min="0" step="1" data-item="${i.id}" value="${Math.min(i.cantidad, i.disponible_origen)}" style="width:100px;text-align:right"></td></tr>`).join('')}
      </tbody></table></div>
      <div class="f mt"><label>Observaciones de la entrega</label><textarea id="a-obs"></textarea></div>
      <div class="form-actions"><button class="btn sec" data-close>Volver</button><button class="btn ok" id="a-ok">Confirmar transferencia</button></div>`, { wide: true });
    $('#a-ok', m).onclick = async () => {
      const items = $$('[data-item]', m).map((inp) => ({ item_id: Number(inp.dataset.item), cantidad: parseInt(inp.value, 10) || 0 }));
      try {
        const r = await api(`/api/pedidos/${p.id}/atender`, { method: 'POST', body: { items, observacion: $('#a-obs', m).value } });
        closeModal(); toast(`Pedido #${p.id} completado · Transferencia #${r.movimiento_id}`);
        onDone(); actualizarPill();
      } catch (err) { toast(err.message, true); }
    };
  }

  function rechazarPedido(id, onDone) {
    const m = modal(`<h2>Rechazar nota de pedido #${id}</h2>
      <div class="f"><label>Motivo</label><textarea id="r-mot" placeholder="Ej.: sin stock en origen"></textarea></div>
      <div class="form-actions"><button class="btn sec" data-close>Volver</button><button class="btn danger" id="r-ok">Rechazar</button></div>`);
    $('#r-ok', m).onclick = async () => {
      try {
        await api(`/api/pedidos/${id}/rechazar`, { method: 'POST', body: { motivo: $('#r-mot', m).value } });
        closeModal(); toast('Pedido rechazado'); onDone(); actualizarPill();
      } catch (err) { toast(err.message, true); }
    };
  }

  // ---------- Productos (ADMIN) ----------
  VIEWS.productos = async (main) => {
    const productos = await api('/api/productos');
    main.innerHTML = `
      <h1>Productos</h1><p class="sub">Maestro de productos y alertas (vencimiento próximo, producto de cuidado, cadena de frío).</p>
      <div class="toolbar">
        <div class="grow"><label>Buscar</label><input id="pr-q" placeholder="Código, nombre o categoría…"></div>
        <div class="f"><label>Alerta</label><select id="pr-al"><option value="">Todas</option><option value="any">Con alguna alerta</option><option value="venc">Vencimiento próximo</option><option value="cuid">De cuidado</option><option value="frio">Cadena de frío</option></select></div>
        <label class="check" style="margin-bottom:10px"><input type="checkbox" id="pr-inac"> Ver inactivos</label>
        <div class="spacer"></div>
        <button class="btn sec" id="pr-tpl">Plantilla CSV</button><button class="btn sec" id="pr-imp">Importar maestro</button><button class="btn" id="pr-new">+ Nuevo producto</button>
      </div><div id="pr-tbl"></div>`;
    const pintar = () => {
      const q = $('#pr-q').value.trim().toLowerCase();
      const al = $('#pr-al').value;
      const inac = $('#pr-inac').checked;
      const rows = productos.filter((p) => (inac || p.activo)
        && (!q || `${p.codigo} ${p.nombre} ${p.categoria || ''}`.toLowerCase().includes(q))
        && (!al || (al === 'any' && tieneAlerta(p)) || (al === 'venc' && p.alerta_vencimiento) || (al === 'cuid' && p.alerta_cuidado) || (al === 'frio' && p.alerta_frio)));
      $('#pr-tbl').innerHTML = rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Unidad</th><th>Alertas</th><th>Nota</th><th></th></tr></thead><tbody>
        ${rows.map((p) => `<tr class="${p.activo ? '' : 'inactive'}"><td class="code">${esc(p.codigo)}</td><td>${esc(p.nombre)}${p.activo ? '' : ' (inactivo)'}</td><td>${esc(p.categoria || '')}</td><td>${esc(p.unidad)}</td>
          <td>${badgesAlerta(p)}</td><td class="muted">${esc(p.nota_alerta || '')}</td><td class="num"><button class="btn ghost sm" data-ed="${p.id}">Editar</button></td></tr>`).join('')}
        </tbody></table></div><p class="muted">${rows.length} de ${productos.length} productos</p>` : `<div class="card empty">${productos.length ? 'Sin resultados.' : 'Todavía no hay productos. Cargalos uno a uno o importá el maestro en CSV.'}</div>`;
      $$('[data-ed]').forEach((b) => b.addEventListener('click', () => editarProducto(productos.find((p) => p.id == b.dataset.ed))));
    };
    ['#pr-q', '#pr-al', '#pr-inac'].forEach((s) => $(s).addEventListener('input', pintar));
    $('#pr-new').onclick = () => editarProducto(null);
    $('#pr-imp').onclick = importarMaestro;
    $('#pr-tpl').onclick = () => descargarCSV('plantilla_productos.csv', [
      ['codigo', 'nombre', 'categoria', 'unidad', 'vencimiento_proximo', 'fecha_vencimiento', 'cuidado', 'cadena_frio', 'nota_alerta', 'activo'],
      ['BEB001', 'Cerveza rubia lata 473ml', 'Bebidas', 'UN', '', '', '', 'SI', 'Mantener refrigerada', 'SI'],
      ['ALI010', 'Queso cheddar feteado 1kg', 'Alimentos', 'UN', 'SI', '2026-12-15', '', 'SI', '', 'SI'],
      ['LIM003', 'Lavandina 5L', 'Limpieza', 'UN', '', '', 'SI', '', 'Producto corrosivo', 'SI'],
    ]);
    pintar();
  };

  function editarProducto(p) {
    const n = !p;
    p = p || { codigo: '', nombre: '', categoria: '', unidad: 'UN', alerta_vencimiento: false, fecha_vencimiento: '', alerta_cuidado: false, alerta_frio: false, nota_alerta: '', activo: true };
    const m = modal(`<h2>${n ? 'Nuevo producto' : 'Editar producto'}</h2>
      <form id="f-prod">
        <div class="row"><div class="f s"><label>Código *</label><input name="codigo" value="${esc(p.codigo)}" required maxlength="40"></div>
          <div class="f w"><label>Nombre *</label><input name="nombre" value="${esc(p.nombre)}" required maxlength="200"></div></div>
        <div class="row mt"><div class="f"><label>Categoría</label><input name="categoria" value="${esc(p.categoria || '')}" maxlength="80"></div>
          <div class="f s"><label>Unidad</label><input name="unidad" value="${esc(p.unidad)}" maxlength="20"></div></div>
        <div class="card mt" style="background:#faf8f5">
          <h2 style="font-size:1rem">Alertas</h2>
          <div class="row"><label class="check"><input type="checkbox" name="alerta_vencimiento" ${p.alerta_vencimiento ? 'checked' : ''}> ⏳ Vencimiento próximo</label>
            <div class="f"><label>Fecha de vencimiento (opcional)</label><input type="date" name="fecha_vencimiento" value="${esc(p.fecha_vencimiento || '')}"></div></div>
          <div class="row mt"><label class="check"><input type="checkbox" name="alerta_cuidado" ${p.alerta_cuidado ? 'checked' : ''}> ⚠ Producto de cuidado</label>
            <label class="check"><input type="checkbox" name="alerta_frio" ${p.alerta_frio ? 'checked' : ''}> ❄ Cadena de frío</label></div>
          <div class="f mt"><label>Nota de la alerta</label><input name="nota_alerta" value="${esc(p.nota_alerta || '')}" maxlength="500" placeholder="Ej.: conservar entre 2 °C y 8 °C"></div>
        </div>
        <label class="check mt"><input type="checkbox" name="activo" ${p.activo ? 'checked' : ''}> Activo</label>
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div>
      </form>`);
    $('#f-prod', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        codigo: f.codigo.value, nombre: f.nombre.value, categoria: f.categoria.value, unidad: f.unidad.value,
        alerta_vencimiento: f.alerta_vencimiento.checked, fecha_vencimiento: f.fecha_vencimiento.value || null,
        alerta_cuidado: f.alerta_cuidado.checked, alerta_frio: f.alerta_frio.checked, nota_alerta: f.nota_alerta.value, activo: f.activo.checked,
      };
      try {
        await api(n ? '/api/productos' : '/api/productos/' + p.id, { method: n ? 'POST' : 'PUT', body });
        closeModal(); toast('Producto guardado'); router();
      } catch (err) { toast(err.message, true); }
    });
  }

  function importarMaestro() {
    const m = modal(`<h2>Importar maestro de productos</h2>
      <p class="muted">Archivo CSV (separado por <b>;</b> o <b>,</b>) con encabezado. Columnas: <span class="code">codigo, nombre</span> (obligatorias) y opcionales
      <span class="code">categoria, unidad, vencimiento_proximo, fecha_vencimiento, cuidado, cadena_frio, nota_alerta, activo</span>.
      Las alertas se marcan con SI / X / 1. Si el código ya existe, se actualiza. Fecha en formato AAAA-MM-DD o DD/MM/AAAA.</p>
      <input type="file" id="imp-file" accept=".csv,text/csv">
      <div id="imp-prev" class="mt"></div>
      <div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn" id="imp-ok" disabled>Importar</button></div>`, { wide: true });
    let filas = [];
    const ALIAS = { id: 'id', codigo: 'codigo', cod: 'codigo', sku: 'codigo', nombre: 'nombre', descripcion: 'nombre', producto: 'nombre', categoria: 'categoria', rubro: 'categoria', subcategoria: 'subcategoria', unidad: 'unidad',
      vencimiento_proximo: 'alerta_vencimiento', vencimiento: 'alerta_vencimiento', alerta_vencimiento: 'alerta_vencimiento', fecha_vencimiento: 'fecha_vencimiento', vence: 'fecha_vencimiento',
      cuidado: 'alerta_cuidado', alerta_cuidado: 'alerta_cuidado', cadena_frio: 'alerta_frio', frio: 'alerta_frio', alerta_frio: 'alerta_frio', nota_alerta: 'nota_alerta', nota: 'nota_alerta', activo: 'activo' };
    const norm = (h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s-]+/g, '_');
    const fecha = (v) => { v = (v || '').trim(); const d = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return d ? `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}` : v; };
    $('#imp-file', m).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const rows = parseCSV(await file.text());
      if (rows.length < 2) { $('#imp-prev', m).innerHTML = '<p class="stock-hint bad">El archivo no tiene filas de datos.</p>'; return; }
      const head = rows[0].map((h) => ALIAS[norm(h)] || null);
      // Si una columna destino aparece dos veces (ej. Nombre y Descripción), vale la primera
      head.forEach((k, i) => { if (k && head.indexOf(k) !== i) head[i] = null; });
      if (head.includes('id')) { const ic = head.indexOf('codigo'); if (ic >= 0) head[ic] = null; head[head.indexOf('id')] = 'codigo'; }
      if (!head.includes('codigo') || !head.includes('nombre')) { $('#imp-prev', m).innerHTML = '<p class="stock-hint bad">Faltan las columnas "codigo" y/o "nombre".</p>'; return; }
      filas = rows.slice(1).map((r) => {
        const o = {};
        head.forEach((k, i) => { if (k) o[k] = (r[i] || '').trim(); });
        if (o.subcategoria) o.categoria = o.categoria ? `${o.categoria} / ${o.subcategoria}` : o.subcategoria;
        delete o.subcategoria;
        if (o.nombre) o.nombre = o.nombre.replace(/\s+/g, ' ');
        o.alerta_vencimiento = (o.alerta_vencimiento || '').toUpperCase();
        o.alerta_cuidado = (o.alerta_cuidado || '').toUpperCase();
        o.alerta_frio = (o.alerta_frio || '').toUpperCase();
        o.activo = o.activo === undefined || o.activo === '' ? true : ['SI', 'S', 'X', '1', 'TRUE', 'SÍ'].includes(o.activo.trim().toUpperCase());
        o.fecha_vencimiento = fecha(o.fecha_vencimiento) || null;
        if (o.fecha_vencimiento && !o.alerta_vencimiento) o.alerta_vencimiento = '';
        ['alerta_vencimiento', 'alerta_cuidado', 'alerta_frio'].forEach((k) => { o[k] = ['SI', 'S', 'X', '1', 'TRUE', 'SÍ'].includes(o[k]); });
        return o;
      });
      $('#imp-prev', m).innerHTML = `<p><b>${filas.length}</b> filas detectadas. Vista previa:</p><div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Alertas</th></tr></thead><tbody>
        ${filas.slice(0, 8).map((f) => `<tr><td class="code">${esc(f.codigo)}</td><td>${esc(f.nombre)}</td><td>${esc(f.categoria || '')}</td><td>${badgesAlerta({ ...f, dias_venc: null })}</td></tr>`).join('')}</tbody></table></div>`;
      $('#imp-ok', m).disabled = false;
    });
    $('#imp-ok', m).onclick = async () => {
      $('#imp-ok', m).disabled = true;
      try {
        const r = await api('/api/productos/importar', { method: 'POST', body: { productos: filas } });
        closeModal();
        toast(`Importación: ${r.creados} creados, ${r.actualizados} actualizados${r.errores.length ? `, ${r.errores.length} con error` : ''}`, r.errores.length > 0);
        if (r.errores.length) console.warn(r.errores);
        router();
      } catch (err) { toast(err.message, true); $('#imp-ok', m).disabled = false; }
    };
  }

  // ---------- Almacenes (ADMIN) ----------
  VIEWS.almacenes = async (main) => {
    const [alms, dash] = await Promise.all([api('/api/almacenes'), api('/api/dashboard')]);
    const info = new Map((dash.almacenes || []).map((a) => [a.id, a]));
    main.innerHTML = `<h1>Almacenes</h1><p class="sub">Depósitos donde se guarda mercadería.</p>
      <div class="toolbar"><div class="spacer"></div><button class="btn" id="al-new">+ Nuevo almacén</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Nombre</th><th class="num">Productos con stock</th><th class="num">Unidades</th><th>Estado</th><th></th></tr></thead><tbody>
      ${alms.map((a) => `<tr class="${a.activo ? '' : 'inactive'}"><td>${a.id}</td><td><b>${esc(a.nombre)}</b></td><td class="num">${fmtN(info.get(a.id)?.productos)}</td><td class="num">${fmtN(info.get(a.id)?.unidades)}</td>
        <td>${a.activo ? 'Activo' : 'Inactivo'}</td><td class="num"><button class="btn ghost sm" data-ed="${a.id}">Editar</button></td></tr>`).join('')}
      </tbody></table></div>`;
    const editar = (a) => {
      const m = modal(`<h2>${a ? 'Editar' : 'Nuevo'} almacén</h2><form id="f-al">
        <div class="f"><label>Nombre</label><input name="nombre" value="${esc(a ? a.nombre : '')}" required maxlength="80"></div>
        ${a ? `<label class="check mt"><input type="checkbox" name="activo" ${a.activo ? 'checked' : ''}> Activo</label>` : ''}
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`);
      $('#f-al', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(a ? '/api/almacenes/' + a.id : '/api/almacenes', { method: a ? 'PUT' : 'POST', body: { nombre: e.target.nombre.value, activo: a ? e.target.activo.checked : true } });
          S.almacenes = await api('/api/almacenes');
          closeModal(); toast('Almacén guardado'); router();
        } catch (err) { toast(err.message, true); }
      });
    };
    $('#al-new').onclick = () => editar(null);
    $$('[data-ed]').forEach((b) => b.addEventListener('click', () => editar(alms.find((a) => a.id == b.dataset.ed))));
  };

  // ---------- Usuarios (ADMIN) ----------
  VIEWS.usuarios = async (main) => {
    const [us, provs] = await Promise.all([api('/api/usuarios'), api('/api/proveedores')]);
    main.innerHTML = `<h1>Usuarios</h1><p class="sub">Roles: <b>Administrador</b> (todo) · <b>Receptor</b> (recibe, transfiere, consume, atiende pedidos) · <b>Encargado</b> (consulta stock y movimientos) · <b>Requirente</b> (notas de pedido internas) · <b>Proveedor</b> (solo sus pedidos y documentos).<br>El permiso <b>Compras</b> habilita a crear y confirmar pedidos a proveedores y se puede sumar a cualquier rol.</p>
      <div class="toolbar"><div class="spacer"></div><button class="btn" id="us-new">+ Nuevo usuario</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Compras</th><th>Proveedor</th><th>Estado</th><th></th></tr></thead><tbody>
      ${us.map((u) => `<tr class="${u.activo ? '' : 'inactive'}"><td class="code">${esc(u.username)}</td><td>${esc(u.nombre)}</td><td><span class="badge b-rol">${ROL_LBL[u.rol]}</span></td>
        <td>${u.rol === 'ADMIN' || u.permiso_compras ? '<span class="badge b-COMPLETADO">Sí</span>' : ''}</td><td>${esc(u.proveedor || '')}</td>
        <td>${u.activo ? 'Activo' : 'Inactivo'}</td><td class="num"><button class="btn ghost sm" data-ed="${u.id}">Editar</button></td></tr>`).join('')}
      </tbody></table></div>`;
    const editar = (u) => {
      const m = modal(`<h2>${u ? 'Editar' : 'Nuevo'} usuario</h2><form id="f-us">
        <div class="row"><div class="f"><label>Usuario (login)</label><input name="username" value="${esc(u ? u.username : '')}" ${u ? 'disabled' : 'required'} maxlength="60" autocomplete="off"></div>
          <div class="f"><label>Nombre y apellido</label><input name="nombre" value="${esc(u ? u.nombre : '')}" required maxlength="120"></div></div>
        <div class="row mt"><div class="f"><label>Rol</label><select name="rol">${Object.entries(ROL_LBL).map(([k, v]) => `<option value="${k}" ${u && u.rol === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="f"><label>${u ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña (mín. 6)'}</label><input type="password" name="password" ${u ? '' : 'required'} minlength="6" autocomplete="new-password"></div></div>
        <div class="row mt" id="us-prov"><div class="f"><label>Proveedor vinculado *</label><select name="proveedor_id"><option value="">Seleccionar…</option>
          ${provs.filter((p) => p.activo || (u && u.proveedor_id === p.id)).map((p) => `<option value="${p.id}" ${u && u.proveedor_id === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select>
          <div class="stock-hint">El usuario solo verá los pedidos confirmados de este proveedor.</div></div></div>
        <label class="check mt" id="us-comp"><input type="checkbox" name="permiso_compras" ${u && u.permiso_compras ? 'checked' : ''}> Permiso de <b>&nbsp;Compras</b>&nbsp;(crear y confirmar pedidos a proveedores)</label>
        ${u ? `<label class="check mt"><input type="checkbox" name="activo" ${u.activo ? 'checked' : ''}> Activo</label>` : ''}
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`);
      const f = $('#f-us', m);
      const sync = () => {
        const r = f.rol.value;
        $('#us-prov', m).hidden = r !== 'PROVEEDOR';
        $('#us-comp', m).hidden = r === 'PROVEEDOR' || r === 'ADMIN';
      };
      f.rol.addEventListener('change', sync); sync();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { nombre: f.nombre.value, rol: f.rol.value, password: f.password.value || undefined,
          proveedor_id: f.rol.value === 'PROVEEDOR' ? f.proveedor_id.value : null, permiso_compras: f.permiso_compras.checked };
        if (u) body.activo = f.activo.checked; else body.username = f.username.value;
        try {
          await api(u ? '/api/usuarios/' + u.id : '/api/usuarios', { method: u ? 'PUT' : 'POST', body });
          closeModal(); toast('Usuario guardado'); router();
        } catch (err) { toast(err.message, true); }
      });
    };
    $('#us-new').onclick = () => editar(null);
    $$('[data-ed]').forEach((b) => b.addEventListener('click', () => editar(us.find((x) => x.id == b.dataset.ed))));
  };

  // ---------- Proveedores ----------
  VIEWS.proveedores = async (main) => {
    const provs = await api('/api/proveedores');
    const vistaProv = { q: '', inac: false };
    main.innerHTML = `<h1>Proveedores</h1><p class="sub">Para que un proveedor entre al sistema, creá un usuario con rol <b>Proveedor</b> vinculado acá${puede('parametrizar') ? ' (en Usuarios)' : ' (lo hace el administrador)'}.</p>
      <div class="toolbar"><div class="grow"><label>Buscar</label><input id="pv-q" placeholder="Nombre, CUIT, comentario…"></div>
        <label class="check" style="margin-bottom:10px"><input type="checkbox" id="pv-inac"> Ver inactivos</label>
        <div class="spacer"></div><button class="btn" id="pv-new">+ Nuevo proveedor</button></div>
      <div id="pv-tbl"></div>`;
    const pintarProv = () => {
      const q = $('#pv-q').value.trim().toLowerCase();
      const rows = provs.filter((p) => ($('#pv-inac').checked || p.activo) && (!q || [p.nombre, p.cuit, p.comentario, p.contacto, p.email].join(' ').toLowerCase().includes(q)));
      $('#pv-tbl').innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>Nombre</th><th>CUIT</th><th>Contacto</th><th>Teléfono / Email</th><th>Dirección</th><th>Comentario</th><th class="num">Usuarios</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map((p) => `<tr class="${p.activo ? '' : 'inactive'}"><td><b>${esc(p.nombre)}</b>${p.activo ? '' : ' (inactivo)'}</td><td>${esc(p.cuit || '')}</td><td>${esc(p.contacto || '')}</td>
        <td>${esc(p.telefono || '')}${p.telefono && p.email ? '<br>' : ''}${esc(p.email || '')}</td><td>${esc(p.direccion || '')}</td><td class="muted">${esc(p.comentario || '')}</td>
        <td class="num">${p.usuarios}</td><td class="num"><button class="btn ghost sm" data-ed="${p.id}">Editar</button></td></tr>`).join('') : '<tr><td colspan="8" class="empty">Sin proveedores para el filtro.</td></tr>'}
      </tbody></table></div><p class="muted">${rows.length} de ${provs.length} proveedores</p>`;
      $$('#pv-tbl [data-ed]').forEach((b) => b.addEventListener('click', () => editar(provs.find((x) => x.id == b.dataset.ed))));
    };
    const editar = (p) => {
      const m = modal(`<h2>${p ? 'Editar' : 'Nuevo'} proveedor</h2><form id="f-pv">
        <div class="f"><label>Razón social / nombre *</label><input name="nombre" value="${esc(p ? p.nombre : '')}" required maxlength="150"></div>
        <div class="row mt"><div class="f"><label>CUIT</label><input name="cuit" value="${esc(p ? p.cuit || '' : '')}" maxlength="20"></div>
          <div class="f"><label>Contacto</label><input name="contacto" value="${esc(p ? p.contacto || '' : '')}" maxlength="120"></div></div>
        <div class="row mt"><div class="f"><label>Email</label><input type="email" name="email" value="${esc(p ? p.email || '' : '')}" maxlength="150"></div>
          <div class="f"><label>Teléfono</label><input name="telefono" value="${esc(p ? p.telefono || '' : '')}" maxlength="50"></div></div>
        <div class="f mt"><label>Dirección</label><input name="direccion" value="${esc(p ? p.direccion || '' : '')}" maxlength="200"></div>
        <div class="f mt"><label>Comentario</label><input name="comentario" value="${esc(p ? p.comentario || '' : '')}" maxlength="1000" placeholder="Ej.: vinos y espumantes"></div>
        ${p ? `<label class="check mt"><input type="checkbox" name="activo" ${p.activo ? 'checked' : ''}> Activo</label>` : ''}
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`);
      $('#f-pv', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { nombre: f.nombre.value, cuit: f.cuit.value, contacto: f.contacto.value, email: f.email.value, telefono: f.telefono.value,
          direccion: f.direccion.value, comentario: f.comentario.value, activo: p ? f.activo.checked : true };
        try {
          await api(p ? '/api/proveedores/' + p.id : '/api/proveedores', { method: p ? 'PUT' : 'POST', body });
          closeModal(); toast('Proveedor guardado'); router();
        } catch (err) { toast(err.message, true); }
      });
    };
    $('#pv-new').onclick = () => editar(null);
    ['#pv-q', '#pv-inac'].forEach((sel) => $(sel).addEventListener('input', pintarProv));
    pintarProv();
  };

  // ---------- Pedidos a proveedores ----------
  const ocAbierta = (o) => o.estado === 'CONFIRMADA' || o.estado === 'PARCIAL';
  function estadoItem(i) {
    if (i.excedente > 0) return `<span class="badge b-RECHAZADO">Excede ${fmtN(i.excedente)}</span>`;
    if (i.pendiente === 0) return '<span class="badge b-COMPLETADO">Completo</span>';
    if (i.cantidad_recibida === 0) return '<span class="badge b-CANCELADO">Sin recibir</span>';
    return `<span class="badge b-PENDIENTE">Faltan ${fmtN(i.pendiente)}</span>`;
  }
  const fmtTam = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  VIEWS.compras = async (main) => {
    const esProv = S.user.rol === 'PROVEEDOR';
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const provs = esProv ? [] : await api('/api/proveedores');
    main.innerHTML = `
      <h1>${esProv ? 'Mis pedidos' : 'Pedidos a proveedores'}</h1>
      <p class="sub">${esProv ? `Notas de pedido de Vinilo a ${esc(S.user.proveedor)}. Subí el remito o la factura de cada entrega.` : 'Notas de pedido a proveedores: se crean y confirman con el permiso de Compras; al recibir se valida lo entregado contra lo pedido.'}</p>
      <div class="toolbar">
        <div class="f"><label>Estado</label><select id="oc-est"><option value="ABIERTAS">Abiertos</option><option value="">Todos</option>
          ${Object.entries(OC_EST).filter(([k]) => !(esProv && k === 'BORRADOR')).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        ${esProv ? '' : `<div class="f"><label>Proveedor</label><select id="oc-prov"><option value="">Todos</option>${provs.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select></div>`}
        <div class="spacer"></div>${puede('compras') ? '<button class="btn" id="oc-new">+ Nuevo pedido a proveedor</button>' : ''}
      </div><div id="oc-list"></div>`;
    const cargar = async () => {
      const qs = new URLSearchParams();
      if ($('#oc-est').value) qs.set('estado', $('#oc-est').value);
      if (!esProv && $('#oc-prov').value) qs.set('proveedor_id', $('#oc-prov').value);
      const list = await api('/api/oc?' + qs);
      $('#oc-list').innerHTML = list.length ? `<div class="tbl-wrap"><table><thead><tr><th>N°</th><th>Fecha</th>${esProv ? '' : '<th>Proveedor</th>'}<th>Entregar en</th><th>Entrega prevista</th><th>Estado</th>
        <th class="num">Pedido</th><th class="num">Recibido</th><th class="num">Pendiente</th><th class="num">📎</th><th></th></tr></thead><tbody>
        ${list.map((o) => `<tr><td><b>#${o.id}</b></td><td>${fmtFecha(o.creado_en)}</td>${esProv ? '' : `<td>${esc(o.proveedor)}</td>`}<td>${esc(o.almacen)}</td><td>${fmtDia(o.fecha_entrega)}</td>
          <td><span class="badge oc-${o.estado}">${OC_EST[o.estado]}</span></td><td class="num">${fmtN(o.pedido)}</td><td class="num">${fmtN(o.recibido)}</td>
          <td class="num ${o.pendiente && ocAbierta(o) ? 'stock-hint bad' : ''}">${fmtN(o.pendiente)}</td><td class="num">${o.archivos || ''}</td>
          <td class="num"><button class="btn ghost sm" data-ver="${o.id}">Ver</button></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="card empty">No hay pedidos para este filtro.</div>';
      $$('[data-ver]').forEach((b) => b.addEventListener('click', () => verOC(Number(b.dataset.ver), cargar)));
    };
    $('#oc-est').addEventListener('change', () => cargar().catch((e) => toast(e.message, true)));
    if (!esProv) $('#oc-prov').addEventListener('change', () => cargar().catch((e) => toast(e.message, true)));
    if ($('#oc-new')) $('#oc-new').onclick = () => formOC(null, cargar);
    await cargar();
    if (params.get('id')) verOC(Number(params.get('id')), cargar);
  };

  async function formOC(oc, onDone) {
    const [provs, productos] = await Promise.all([api('/api/proveedores'), api('/api/productos')]);
    const activos = productos.filter((p) => p.activo);
    const pMap = new Map(productos.map((p) => [p.id, p]));
    const lineas = oc ? oc.items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad })) : [];
    const m = modal(`<h2>${oc ? `Editar pedido #${oc.id}` : 'Nuevo pedido a proveedor'}</h2>
      <div class="row"><div class="f w"><label>Proveedor *</label><select id="o-prov"><option value="">Seleccionar…</option>
        ${provs.filter((p) => p.activo).map((p) => `<option value="${p.id}" ${oc && oc.proveedor_id === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select></div>
        <div class="f"><label>Entregar en *</label><select id="o-alm">${optAlmacenes(oc ? oc.almacen_id : '', { vacio: 'Seleccionar…' })}</select></div>
        <div class="f s" style="flex-basis:160px"><label>Entrega prevista</label><input type="date" id="o-fecha" value="${oc && oc.fecha_entrega ? oc.fecha_entrega : ''}"></div></div>
      <div class="row mt"><div class="f w"><label>Producto</label><input id="o-prod" list="o-prod-list" autocomplete="off" placeholder="Código o nombre…">
        <datalist id="o-prod-list">${activos.map((p) => `<option value="${esc(p.codigo)} — ${esc(p.nombre)}"></option>`).join('')}</datalist></div>
        <div class="f s"><label>Cantidad</label><input id="o-cant" type="number" min="1" step="1" inputmode="numeric"></div>
        <div><button class="btn sec" id="o-add" type="button">Agregar</button></div></div>
      <div id="o-lines" class="mt"></div>
      <div class="f mt"><label>Observaciones para el proveedor</label><textarea id="o-obs" maxlength="2000">${esc(oc ? oc.observacion || '' : '')}</textarea></div>
      <div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn sec" id="o-save">Guardar borrador</button><button class="btn" id="o-conf">Guardar y confirmar</button></div>`, { wide: true });
    const buscar = (txt) => { const c = txt.split(' — ')[0].trim().toUpperCase(); return activos.find((p) => p.codigo.toUpperCase() === c); };
    const pintar = () => {
      $('#o-lines', m).innerHTML = lineas.length ? `<div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th></th></tr></thead><tbody>
        ${lineas.map((l, i) => { const p = pMap.get(l.producto_id); return `<tr><td class="code">${esc(p.codigo)}</td><td>${esc(p.nombre)} ${badgesAlerta(p)}</td>
          <td class="num"><input type="number" min="1" step="1" value="${l.cantidad}" data-i="${i}" style="width:100px;text-align:right"></td><td class="num"><button class="btn ghost sm" data-del="${i}">✕</button></td></tr>`; }).join('')}
        </tbody><tfoot><tr><td></td><td><b>${lineas.length} productos</b></td><td class="num tot">${fmtN(lineas.reduce((a, l) => a + l.cantidad, 0))}</td><td></td></tr></tfoot></table></div>` : '<p class="muted">Agregá los productos a pedir.</p>';
      $$('#o-lines input[data-i]', m).forEach((inp) => inp.addEventListener('change', () => { lineas[inp.dataset.i].cantidad = Math.max(1, parseInt(inp.value, 10) || 1); pintar(); }));
      $$('#o-lines [data-del]', m).forEach((b) => b.addEventListener('click', () => { lineas.splice(Number(b.dataset.del), 1); pintar(); }));
    };
    const agregar = () => {
      const p = buscar($('#o-prod', m).value);
      const c = parseInt($('#o-cant', m).value, 10);
      if (!p) return toast('Elegí un producto de la lista', true);
      if (!Number.isInteger(c) || c < 1) return toast('Ingresá una cantidad válida', true);
      const ex = lineas.find((l) => l.producto_id === p.id);
      if (ex) ex.cantidad += c; else lineas.push({ producto_id: p.id, cantidad: c });
      $('#o-prod', m).value = ''; $('#o-cant', m).value = ''; $('#o-prod', m).focus();
      pintar();
    };
    $('#o-add', m).onclick = agregar;
    $('#o-prod', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#o-cant', m).focus(); } });
    $('#o-cant', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); agregar(); } });
    const guardar = async (confirmar) => {
      if (!lineas.length) return toast('Agregá al menos un producto', true);
      if (confirmar && !confirm('Al confirmar, el pedido queda visible para el proveedor y ya no se puede editar. ¿Confirmar?')) return;
      const body = { proveedor_id: $('#o-prov', m).value, almacen_id: $('#o-alm', m).value, fecha_entrega: $('#o-fecha', m).value || null, observacion: $('#o-obs', m).value, items: lineas };
      try {
        let id = oc && oc.id;
        if (oc) {
          await api('/api/oc/' + oc.id, { method: 'PUT', body });
          if (confirmar) await api(`/api/oc/${oc.id}/confirmar`, { method: 'POST' });
        } else {
          id = (await api('/api/oc', { method: 'POST', body: { ...body, confirmar } })).id;
        }
        closeModal(); toast(confirmar ? `Pedido #${id} confirmado y enviado al proveedor` : `Borrador #${id} guardado`);
        await onDone(); actualizarPill();
        verOC(id, onDone);
      } catch (err) { toast(err.message, true); }
    };
    $('#o-save', m).onclick = () => guardar(false);
    $('#o-conf', m).onclick = () => guardar(true);
    pintar();
  }

  async function descargarArchivo(ocId, a) {
    try {
      const res = await fetch(`/api/oc/${ocId}/archivos/${a.id}`, { headers: { Authorization: 'Bearer ' + S.token } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo descargar');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = a.nombre_archivo; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) { toast(err.message, true); }
  }

  function leerArchivo(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('No se pudo leer el archivo'));
      r.readAsDataURL(file);
    });
  }

  function imprimirOC(oc) {
    const w = window.open('', '_blank');
    if (!w) return toast('Habilitá las ventanas emergentes para imprimir', true);
    w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Nota de pedido #${oc.id}</title>
      <style>body{font-family:Arial,sans-serif;margin:32px;color:#111}h1{margin:0 0 4px;font-size:22px}table{width:100%;border-collapse:collapse;margin-top:18px}
      th,td{border-bottom:1px solid #ccc;padding:7px;text-align:left;font-size:13px}th{background:#f3f3f3}.n{text-align:right}.m{color:#555;font-size:13px}.g{display:flex;justify-content:space-between;gap:20px;margin-top:14px}</style></head><body>
      <h1>VINILO · Nota de pedido N° ${oc.id}</h1><div class="m">Estado: ${OC_EST[oc.estado]} · Emitida ${fmtFecha(oc.confirmado_en || oc.creado_en)}</div>
      <div class="g"><div><b>Proveedor</b><br>${esc(oc.proveedor)}${oc.proveedor_cuit ? '<br>CUIT ' + esc(oc.proveedor_cuit) : ''}${oc.proveedor_email ? '<br>' + esc(oc.proveedor_email) : ''}</div>
      <div><b>Entregar en</b><br>${esc(oc.almacen)}${oc.fecha_entrega ? '<br>Fecha prevista: ' + fmtDia(oc.fecha_entrega) : ''}</div></div>
      <table><thead><tr><th>Código</th><th>Producto</th><th class="n">Cantidad</th><th class="n">Recibido</th></tr></thead><tbody>
      ${oc.items.map((i) => `<tr><td>${esc(i.codigo)}</td><td>${esc(i.nombre)}</td><td class="n">${fmtN(i.cantidad)} ${esc(i.unidad)}</td><td class="n">${fmtN(i.cantidad_recibida)}</td></tr>`).join('')}
      </tbody></table>${oc.observacion ? `<p class="m"><b>Observaciones:</b> ${esc(oc.observacion)}</p>` : ''}
      <script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
  }

  async function verOC(id, onDone) {
    let oc;
    try { oc = await api('/api/oc/' + id); } catch (err) { return toast(err.message, true); }
    const esProv = S.user.rol === 'PROVEEDOR';
    const compras = puede('compras');
    const r = oc.resumen;
    const puedeSubir = ['CONFIRMADA', 'PARCIAL', 'RECIBIDA', 'CERRADA'].includes(oc.estado) && (esProv || compras || puede('recibir'));
    const pct = r.pedido ? Math.min(100, Math.round(((r.recibido - r.excedente) / r.pedido) * 100)) : 0;
    const m = modal(`
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="margin:0">Pedido a proveedor #${oc.id}</h2><span class="badge oc-${oc.estado}">${OC_EST[oc.estado]}</span>
        <span style="flex:1"></span><button class="btn sec sm" id="v-print">Imprimir</button></div>
      <p class="muted" style="margin-top:8px"><b>${esc(oc.proveedor)}</b> → entregar en <b>${esc(oc.almacen)}</b>${oc.fecha_entrega ? ` · entrega prevista ${fmtDia(oc.fecha_entrega)}` : ''}<br>
        Creado por ${esc(oc.creado_por_nombre)} ${fmtFecha(oc.creado_en)}${oc.confirmado_en ? ` · Confirmado por ${esc(oc.confirmado_por_nombre)} ${fmtFecha(oc.confirmado_en)}` : ''}
        ${oc.cerrado_en ? `<br>${oc.estado === 'ANULADA' ? 'Anulado' : oc.estado === 'RECIBIDA' ? 'Completado' : 'Cerrado'} por ${esc(oc.cerrado_por_nombre || '')} ${fmtFecha(oc.cerrado_en)}${oc.motivo_cierre ? ' · ' + esc(oc.motivo_cierre) : ''}` : ''}</p>
      ${oc.observacion ? `<p class="obs">📝 ${esc(oc.observacion)}</p>` : ''}

      <h2 class="mt" style="font-size:1rem">Validación: pedido vs. recibido</h2>
      ${oc.estado !== 'BORRADOR' ? `<div class="valbar"><div style="width:${pct}%"></div></div>
        <p class="stock-hint" style="margin:4px 0 10px">${r.items_completos} de ${r.items_total} productos completos · Pedido ${fmtN(r.pedido)} · Recibido ${fmtN(r.recibido)} · <b class="${r.pendiente ? 'bad' : ''}">Pendiente ${fmtN(r.pendiente)}</b>${r.excedente ? ` · <b class="bad">Excedente ${fmtN(r.excedente)}</b>` : ''}</p>` : ''}
      <div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Producto</th><th class="num">Pedido</th><th class="num">Recibido</th><th class="num">Pendiente</th><th>Control</th></tr></thead><tbody>
      ${oc.items.map((i) => `<tr><td class="code">${esc(i.codigo)}</td><td>${esc(i.nombre)} ${badgesAlerta(i)}</td><td class="num">${fmtN(i.cantidad)}</td><td class="num">${fmtN(i.cantidad_recibida)}</td>
        <td class="num">${fmtN(i.pendiente)}</td><td>${oc.estado === 'BORRADOR' ? '' : estadoItem(i)}</td></tr>`).join('')}
      </tbody></table></div>

      ${oc.estado === 'BORRADOR' ? '' : `<h2 class="mt" style="font-size:1rem">Remitos y facturas</h2>
      ${oc.archivos.length ? `<div class="tbl-wrap"><table><tbody>${oc.archivos.map((a) => `<tr><td><span class="badge b-rol">${a.tipo}</span> ${esc(a.numero || '')}</td>
        <td>${esc(a.nombre_archivo)} <span class="muted">· ${fmtTam(a.tamano)}</span></td><td class="muted">${esc(a.subido_por_nombre)} · ${fmtFecha(a.subido_en)}</td>
        <td class="num"><button class="btn ghost sm" data-dl="${a.id}">Descargar</button>${ocAbierta(oc) && (a.subido_por === S.user.id || compras) ? `<button class="btn ghost sm" data-rm="${a.id}" title="Eliminar">✕</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Todavía no se subieron documentos.</p>'}
      ${puedeSubir ? `<div class="card mt" style="background:#faf8f5;margin-bottom:0"><div class="row">
        <div class="f s" style="flex-basis:140px"><label>Tipo</label><select id="u-tipo"><option value="REMITO">Remito</option><option value="FACTURA">Factura</option><option value="OTRO">Otro</option></select></div>
        <div class="f"><label>Número</label><input id="u-num" maxlength="60" placeholder="0001-00001234"></div>
        <div class="f w"><label>Archivo (PDF, foto, Excel… máx. 8 MB)</label><input type="file" id="u-file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xls,.xlsx,.doc,.docx,.csv,.txt"></div>
        <div><button class="btn" id="u-up">Subir</button></div></div></div>` : ''}`}

      ${oc.recepciones.length ? `<h2 class="mt" style="font-size:1rem">Recepciones</h2>${oc.recepciones.map((rc) => `<p class="obs" style="margin:4px 0"><b>${fmtFecha(rc.fecha)}</b> · ${esc(rc.usuario)} · ${esc(rc.referencia || '')}
        <br>${rc.items.map((x) => `${esc(x.nombre)}: <b>${fmtN(x.cantidad)}</b>`).join(' · ')}${rc.observacion ? `<br>📝 ${esc(rc.observacion)}` : ''}</p>`).join('')}` : ''}

      <div class="form-actions">
        <button class="btn sec" data-close>Cerrar ventana</button>
        ${compras && oc.estado === 'BORRADOR' ? '<button class="btn sec" id="a-edit">Editar</button>' : ''}
        ${compras && (oc.estado === 'BORRADOR' || (oc.estado === 'CONFIRMADA' && r.recibido === 0)) ? '<button class="btn danger" id="a-anular">Anular</button>' : ''}
        ${compras && ocAbierta(oc) ? '<button class="btn danger" id="a-cerrar">Cerrar con faltante</button>' : ''}
        ${compras && oc.estado === 'BORRADOR' ? '<button class="btn" id="a-conf">Confirmar pedido</button>' : ''}
        ${puede('recibir') && ocAbierta(oc) ? '<button class="btn ok" id="a-recibir">Recibir mercadería</button>' : ''}
      </div>`, { wide: true });
    const reabrir = async () => { await onDone(); actualizarPill(); verOC(id, onDone); };
    const accion = async (path, body, msg) => {
      try { await api(`/api/oc/${id}/${path}`, { method: 'POST', body }); toast(msg); await reabrir(); } catch (err) { toast(err.message, true); }
    };
    $('#v-print', m).onclick = () => imprimirOC(oc);
    $$('[data-dl]', m).forEach((b) => b.addEventListener('click', () => descargarArchivo(id, oc.archivos.find((a) => a.id == b.dataset.dl))));
    $$('[data-rm]', m).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este archivo?')) return;
      try { await api(`/api/oc/${id}/archivos/${b.dataset.rm}`, { method: 'DELETE' }); toast('Archivo eliminado'); await reabrir(); } catch (err) { toast(err.message, true); }
    }));
    if ($('#u-up', m)) $('#u-up', m).onclick = async () => {
      const file = $('#u-file', m).files[0];
      if (!file) return toast('Elegí un archivo', true);
      if (file.size > 8 * 1024 * 1024) return toast('El archivo supera los 8 MB', true);
      const btn = $('#u-up', m); btn.disabled = true; btn.textContent = 'Subiendo…';
      try {
        await api(`/api/oc/${id}/archivos`, { method: 'POST', body: { tipo: $('#u-tipo', m).value, numero: $('#u-num', m).value, nombre: file.name, data: await leerArchivo(file) } });
        toast('Documento subido'); await reabrir();
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Subir'; }
    };
    if ($('#a-edit', m)) $('#a-edit', m).onclick = () => formOC(oc, onDone);
    if ($('#a-conf', m)) $('#a-conf', m).onclick = () => { if (confirm('Al confirmar, el pedido queda visible para el proveedor y ya no se puede editar. ¿Confirmar?')) accion('confirmar', {}, 'Pedido confirmado'); };
    if ($('#a-anular', m)) $('#a-anular', m).onclick = () => { const mot = prompt('Motivo de la anulación (opcional):'); if (mot !== null) accion('anular', { motivo: mot }, 'Pedido anulado'); };
    if ($('#a-cerrar', m)) $('#a-cerrar', m).onclick = () => { const mot = prompt(`Quedan ${r.pendiente} unidades pendientes. Motivo del cierre:`); if (mot) accion('cerrar', { motivo: mot }, 'Pedido cerrado'); };
    if ($('#a-recibir', m)) $('#a-recibir', m).onclick = () => recibirOC(oc, reabrir);
  }

  function recibirOC(oc, onDone) {
    const remitos = oc.archivos.filter((a) => a.tipo === 'REMITO' && a.numero);
    const m = modal(`<h2>Recibir pedido #${oc.id} · ${esc(oc.proveedor)}</h2>
      <p class="muted">Ingresa a <b>${esc(oc.almacen)}</b>. Cargá lo que llegó físicamente; el sistema lo compara con lo pedido. Si algo no vino, dejalo en 0 y queda pendiente.</p>
      <div class="row"><div class="f"><label>Remito del proveedor</label><input id="r-ref" maxlength="90" value="${esc(remitos.length ? 'Remito ' + remitos[remitos.length - 1].numero : '')}" placeholder="N° de remito"></div></div>
      <div class="tbl-wrap mt"><table><thead><tr><th>Producto</th><th class="num">Pedido</th><th class="num">Ya recibido</th><th class="num">Pendiente</th><th class="num">Recibido ahora</th><th>Resultado</th></tr></thead><tbody>
      ${oc.items.map((i) => `<tr><td>${esc(i.nombre)} ${badgesAlerta(i)}</td><td class="num">${fmtN(i.cantidad)}</td><td class="num">${fmtN(i.cantidad_recibida)}</td><td class="num">${fmtN(i.pendiente)}</td>
        <td class="num"><input type="number" min="0" step="1" data-item="${i.id}" value="${i.pendiente}" style="width:100px;text-align:right"></td><td data-res="${i.id}"></td></tr>`).join('')}
      </tbody></table></div>
      <div class="f mt"><label>Observaciones (estado de la mercadería, cadena de frío, etc.)</label><textarea id="r-obs"></textarea></div>
      <div class="form-actions"><button class="btn sec" data-close>Volver</button><button class="btn sec" id="r-cero">Poner todo en 0</button><button class="btn ok" id="r-ok">Confirmar recepción</button></div>`, { wide: true });
    const calc = () => {
      for (const i of oc.items) {
        const v = parseInt($(`[data-item="${i.id}"]`, m).value, 10) || 0;
        const total = i.cantidad_recibida + v;
        $(`[data-res="${i.id}"]`, m).innerHTML = total > i.cantidad ? `<span class="badge b-RECHAZADO">Excede ${fmtN(total - i.cantidad)}</span>`
          : total === i.cantidad ? '<span class="badge b-COMPLETADO">Completo</span>'
            : `<span class="badge b-PENDIENTE">Quedan ${fmtN(i.cantidad - total)}</span>`;
      }
    };
    $$('[data-item]', m).forEach((inp) => inp.addEventListener('input', calc));
    $('#r-cero', m).onclick = () => { $$('[data-item]', m).forEach((inp) => { inp.value = 0; }); calc(); };
    const enviar = async (aceptar) => {
      const items = $$('[data-item]', m).map((inp) => ({ item_id: Number(inp.dataset.item), cantidad: parseInt(inp.value, 10) || 0 }));
      try {
        const res = await api(`/api/oc/${oc.id}/recibir`, { method: 'POST', body: { items, referencia: $('#r-ref', m).value, observacion: $('#r-obs', m).value, aceptar_excedente: aceptar } });
        closeModal();
        toast(res.estado === 'RECIBIDA' ? `Pedido #${oc.id} recibido completo` : `Recepción registrada · quedan productos pendientes`);
        onDone();
      } catch (err) {
        if (!aceptar && /más de lo pedido/.test(err.message)) {
          if (confirm(err.message + '\n\n¿Aceptar el excedente e ingresarlo al stock?')) enviar(true);
        } else toast(err.message, true);
      }
    };
    $('#r-ok', m).onclick = () => enviar(false);
    calc();
  }

  boot();
})();
