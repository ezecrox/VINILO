/* VINILO APP — SPA sin dependencias */
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
  const TIPO_LBL = { RECEPCION: 'Recepción', TRANSFERENCIA: 'Transferencia', CONSUMO: 'Consumo', AJUSTE: 'Ajuste', PRODUCCION: 'Producción' };
  const ROL_LBL = { ADMIN: 'Administrador', RECEPTOR: 'Receptor', ENCARGADO: 'Encargado', REQUIRENTE: 'Requirente', PROVEEDOR: 'Proveedor', EMPLEADO: 'Empleado' };
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
  // ---------- Ver como otro usuario (solo ADMIN, solo lectura) ----------
  async function verComo(u) {
    try {
      const r = await api(`/api/usuarios/${u.id}/ver-como`, { method: 'POST' });
      localStorage.setItem('vinilo_token_admin', S.token);
      localStorage.setItem('vinilo_token', r.token);
      try { sessionStorage.removeItem('vinilito_hist'); } catch (_) { /* sin storage */ }
      location.hash = '#/panel'; location.reload();
    } catch (err) { toast(err.message, true); }
  }
  function volverDeVerComo() {
    const t = localStorage.getItem('vinilo_token_admin');
    localStorage.removeItem('vinilo_token_admin');
    if (t) localStorage.setItem('vinilo_token', t); else localStorage.removeItem('vinilo_token');
    try { sessionStorage.removeItem('vinilito_hist'); } catch (_) { /* sin storage */ }
    location.hash = '#/usuarios'; location.reload();
  }
  function barraVerComo() {
    let b = document.getElementById('vc-bar');
    if (!S.user || !S.user.ver_como) { if (b) b.remove(); document.body.classList.remove('ver-como'); return; }
    if (!b) { b = document.createElement('div'); b.id = 'vc-bar'; document.body.prepend(b); }
    document.body.classList.add('ver-como');
    b.innerHTML = `<span class="vc-l">👁 Estás viendo la aplicación como <b>${esc(S.user.nombre)}</b> · ${esc(S.user.rol_nombre || S.user.rol)} · <em>solo lectura</em></span><span class="vc-c">👁 <b>${esc(S.user.nombre)}</b> <em>solo lectura</em></span><button id="vc-volver"><span class="vc-l">Volver a mi usuario</span><span class="vc-c">Volver</span></button>`;
    $('#vc-volver').onclick = volverDeVerComo;
  }

  function logout() {
    if (localStorage.getItem('vinilo_token_admin')) return volverDeVerComo();
    S.token = null; S.user = null;
    localStorage.removeItem('vinilo_token');
    try { sessionStorage.removeItem('vinilito_hist'); } catch (_) { /* sin storage */ }
    document.querySelectorAll('#vn-fab, #vn-panel').forEach((e) => e.parentElement.remove());
    if (typeof VN !== 'undefined') { VN.historial = []; VN.abierto = false; }
    renderLogin();
  }

  function renderLogin() {
    $('#app').innerHTML = `
      <div class="login">
        <form id="login-form">
          <div class="logo"><div class="logos"><img src="/logo.png" alt="Vinilo"><img src="/gato.png" alt="Vinilo Bar" class="gato"></div><b>VINILO APP</b></div>
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

  async function cargarAlmacenes() {
    const [vis, todos] = await Promise.all([api('/api/almacenes'), api('/api/almacenes?todos=1')]);
    S.almacenes = vis.filter((a) => a.visible !== false);
    S.todosAlmacenes = todos;
  }

  async function boot() {
    if (!S.token) return renderLogin();
    try {
      const me = await api('/api/me');
      S.user = me.user; S.permisos = me.permisos;
      await cargarAlmacenes();
    } catch (_) { return renderLogin(); }
    renderShell();
    barraVerComo();
    if (!S.user.ver_como) montarVinilito();
    router();
    registrarSW();
  }

  // Si el administrador cambia el rol o sus permisos, se toma al volver a la app (sin recargar)
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !S.token || !S.user) return;
    try {
      const me = await api('/api/me');
      if (JSON.stringify(me.permisos) === JSON.stringify(S.permisos)) return;
      S.user = me.user; S.permisos = me.permisos;
      await cargarAlmacenes(); renderShell(); barraVerComo(); router();
    } catch (_) { /* sin conexión: se reintenta la próxima vez */ }
  });

  // ---------- Navegación ----------
  const ICON_PATHS = {
    panel: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    stock: '<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
    pedidos: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h6M9 18h3"/>',
    compras: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3h2.6l2.3 11.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.1L21 7H6"/>',
    proveedores: '<path d="M2 6h11v10H2z"/><path d="M13 9h4.5L21 12.5V16h-8z"/><circle cx="6" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
    recepcion: '<path d="M12 3v11"/><path d="m7.5 9.5 4.5 4.5 4.5-4.5"/><path d="M3 14v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>',
    transferencia: '<path d="M4 8h14"/><path d="m14 4 4 4-4 4"/><path d="M20 16H6"/><path d="m10 12-4 4 4 4"/>',
    consumo: '<path d="M6 3h12l-1.2 7.2A4.9 4.9 0 0 1 12 14.5a4.9 4.9 0 0 1-4.8-4.3L6 3Z"/><path d="M12 14.5V20"/><path d="M8 21h8"/><path d="M6.6 7h10.8"/>',
    bolsa: '<path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h5v5"/><path d="M3 21h18"/>',
    avisos: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    tablero: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/><circle cx="19" cy="5" r="2" fill="currentColor"/>',
    manuales: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/><path d="M9 7h7M9 11h5"/>',
    checklist: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 8 1.5 1.5L12 7M8 14l1.5 1.5L12 13"/><path d="M14 8h3M14 14h3"/>',
    notificaciones: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    conteo: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z"/><path d="M8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2"/><path d="m9 13 2 2 4-4"/>',
    ajuste: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    movimientos: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 7.5V12l3 2"/>',
    productos: '<path d="M3 12.6V4.5A1.5 1.5 0 0 1 4.5 3h8.1a1.5 1.5 0 0 1 1 .4l7 7a1.5 1.5 0 0 1 0 2.1l-8.1 8.1a1.5 1.5 0 0 1-2.1 0l-7-7a1.5 1.5 0 0 1-.4-1Z"/><circle cx="8" cy="8" r="1.5"/>',
    almacenes: '<path d="M3 21V9l9-5 9 5v12"/><path d="M7 21v-8h10v8"/><path d="M7 17h10"/>',
    usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.5a6.5 6.5 0 0 1 3 5.5"/>',
    'consumos-fudo': '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2Z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
    produccion: '<path d="M6 13h12v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6Z"/><path d="M4 13h16"/><path d="M8 9c0-2 1.5-2 1.5-4M12 9c0-2 1.5-2 1.5-4M16 9c0-2 1.5-2 1.5-4"/>',
    'mis-solicitudes': '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/><path d="m9 15 2 2 4-4"/>',
    solicitudes: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="m16 11 2 2 4-4"/>',
    'mis-horas': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    programacion: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M7 13h3v3H7zM14 13h3v3h-3z"/>',
    sucursales: '<path d="M3 10 5 4h14l2 6"/><path d="M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v9h14v-9"/><path d="M10 21v-5h4v5"/>',
    horas: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6M12 2v3"/>',
    salir: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h10"/>',
    clave: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/>',
  };
  const icono = (k) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[k] || ''}</svg>`;

  const NAV = [
    { sec: 'General' },
    { id: 'tablero', lbl: 'Tablero en vivo', ok: () => puede('tablero') },
    { id: 'avisos', lbl: 'Avisos en el panel', ok: () => puede('avisos') },
    { id: 'panel', lbl: 'Panel', ok: () => true },
    { id: 'stock', lbl: 'Stock por almacén', ok: () => puede('verStock') },
    { id: 'pedidos', lbl: 'Notas de pedido', ok: () => puede('verPedidos'), pill: true },
    { id: 'compras', lbl: 'Mis pedidos', ok: () => puede('portalProveedor'), pillOc: true },
    { sec: 'Compras', ok: () => puede('compras') || puede('verCompras') || puede('proveedores') },
    { id: 'compras', lbl: 'Pedidos a proveedores', ok: () => puede('compras') || puede('verCompras'), pillOc: true },
    { id: 'proveedores', lbl: 'Proveedores', ok: () => puede('proveedores') },
    { sec: 'Operaciones', ok: () => ['recibir', 'transferir', 'consumir', 'ajustar', 'contar', 'checklist', 'checklistConfig', 'producir', 'verMovimientos'].some(puede) },
    { id: 'recepcion', lbl: 'Recepción', ok: () => puede('recibir') },
    { id: 'transferencia', lbl: 'Transferencia', ok: () => puede('transferir') },
    { id: 'consumo', lbl: 'Consumo', ok: () => puede('consumir') },
    { id: 'consumos-fudo', lbl: 'Consumos desde Fudo', ok: () => puede('consumir') || puede('verMovimientos'), pillCf: true },
    { id: 'produccion', lbl: 'Producción', ok: () => puede('producir') },
    { id: 'checklist', lbl: 'Checklist apertura / cierre', ok: () => puede('checklist') || puede('checklistConfig') },
    { id: 'conteo', lbl: 'Conteo de inventario', ok: () => puede('contar') || puede('ajustar') },
    { id: 'ajuste', lbl: 'Ajuste de inventario', ok: () => puede('ajustar') },
    { id: 'movimientos', lbl: 'Movimientos', ok: () => puede('verMovimientos') },
    { sec: 'Personal', ok: () => puede('solicitudes') || puede('misHoras') || puede('gestionarSolicitudes') || puede('verHoras') || puede('programacion') },
    { id: 'mis-solicitudes', lbl: 'Mis solicitudes', ok: () => puede('solicitudes'), pillSol: true },
    { id: 'mis-horas', lbl: 'Mis horas', ok: () => puede('misHoras') },
    { id: 'solicitudes', lbl: 'Solicitudes del personal', ok: () => puede('gestionarSolicitudes'), pillSolG: true },
    { id: 'programacion', lbl: 'Programación', ok: () => puede('programacion') },
    { id: 'horas', lbl: 'Horas del personal', ok: () => puede('verHoras') },
    { sec: 'Parametrización', ok: () => puede('productos') || puede('almacenes') || puede('sucursales') || puede('notificaciones') || puede('usuarios') },
    { id: 'productos', lbl: 'Productos', ok: () => puede('productos') },
    { id: 'almacenes', lbl: 'Almacenes', ok: () => puede('almacenes') },
    { id: 'sucursales', lbl: 'Sucursales', ok: () => puede('sucursales') },
    { id: 'notificaciones', lbl: 'Notificaciones push', ok: () => puede('notificaciones') },
    { id: 'usuarios', lbl: 'Usuarios y roles', ok: () => puede('usuarios') },
    { sec: 'Juegos' },
    { id: 'bolsa', lbl: 'Bolsa de tragos', ok: () => puede('juegos') },
    { sec: 'Ayuda' },
    { id: 'manuales', lbl: 'Manuales', ok: () => true },
  ];

  function renderShell() {
    const links = NAV.filter((n) => !n.ok || n.ok()).filter((n, i, arr) => !n.sec || (arr[i + 1] && !arr[i + 1].sec)).map((n) => n.sec
      ? `<div class="sec">${n.sec}</div>`
      : `<a class="nav" href="#/${n.id}" data-nav="${n.id}">${icono(n.id)}<span class="lbl">${n.lbl}</span>${n.pill ? '<span class="pill" id="pill-ped" hidden></span>' : ''}${n.pillOc ? '<span class="pill" id="pill-oc" hidden></span>' : ''}${n.pillCf ? '<span class="pill" id="pill-cf" hidden></span>' : ''}${n.pillSolG ? '<span class="pill" id="pill-solg" hidden></span>' : ''}</a>`).join('');
    $('#app').innerHTML = `
      <div class="topbar"><button id="menu-btn" aria-label="Menú">☰</button><span class="logo-tile sm"><img src="/logo.png" alt=""></span><span class="logo-gato sm"><img src="/gato.png" alt=""></span><b>VINILO APP</b><button id="user-btn" class="top-user" aria-label="Mi cuenta">${icono('clave')}</button></div>
      <div class="layout">
        <nav class="side" id="side">
          <div class="brand"><div class="brand-logos"><span class="logo-tile"><img src="/logo.png" alt="Vinilo"></span><span class="logo-gato"><img src="/gato.png" alt="Vinilo Bar"></span></div><b>VINILO APP</b></div>
          ${links}
          <div class="who"><b>${esc(S.user.nombre)}</b>${esc(S.user.rol_nombre || ROL_LBL[S.user.rol] || S.user.rol)}${S.user.proveedor ? ' · ' + esc(S.user.proveedor) : ''}${S.user.permiso_compras && S.user.rol !== 'ADMIN' ? ' · Compras' : ''}
            <div class="links"><button id="pwd-btn">${icono('clave')}Contraseña</button><button id="wa-btn" title="Mi celular para avisos por WhatsApp">📱 WhatsApp</button><button id="push-btn" title="Notificaciones en este dispositivo">🔔 Avisos</button><button id="out-btn">${icono('salir')}Salir</button></div></div>
        </nav>
        <main id="main"></main>
      </div>`;
    $('#out-btn').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* igual salimos */ } logout(); };
    $('#pwd-btn').onclick = cambiarPassword;
    $('#wa-btn').onclick = miWhatsapp;
    $('#push-btn').onclick = misNotificaciones;
    $('#user-btn').onclick = () => {
      const m = modal(`<h2>${esc(S.user.nombre)}</h2><p class="sub" style="margin-top:-6px">${esc(S.user.rol_nombre || S.user.rol)} · usuario <b>${esc(S.user.username)}</b></p>
        <div class="form-actions" style="justify-content:stretch;flex-direction:column;gap:10px">
          <button class="btn" id="um-pwd" style="width:100%">Cambiar contraseña</button>
          <button class="btn sec" id="um-push" style="width:100%">🔔 Notificaciones en este celular</button>
          <button class="btn sec" id="um-wa" style="width:100%">📱 Mi WhatsApp para avisos</button>
          <button class="btn sec" id="um-out" style="width:100%">Salir</button>
          <button class="btn ghost" data-close style="width:100%">Cerrar</button></div>`);
      $('#um-pwd', m).onclick = () => { closeModal(); cambiarPassword(); };
      $('#um-wa', m).onclick = () => { closeModal(); miWhatsapp(); };
      $('#um-push', m).onclick = () => { closeModal(); misNotificaciones(); };
      $('#um-out', m).onclick = () => $('#out-btn').click();
    };
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
      const pillSg = $('#pill-solg');
      if (pillSg) {
        const r = await api('/api/solicitudes?todas=1&estado=PENDIENTE');
        const n = r.solicitudes.filter((x) => x.usuario_id !== S.user.id).length;
        pillSg.textContent = n; pillSg.hidden = n === 0;
      }
      const pillCf = $('#pill-cf');
      if (pillCf && puede('consumir')) {
        const cf = await api('/api/consumos-fudo');
        const n = cf.importaciones.filter((i) => i.estado === 'BORRADOR').length;
        pillCf.textContent = n; pillCf.hidden = n === 0;
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
    closeModal();
    const id = (location.hash.replace(/^#\/?/, '') || 'panel').split('?')[0];
    const nav = NAV.find((n) => n.id === id && (!n.ok || n.ok()));
    const view = nav ? id : 'panel';
    document.body.classList.toggle('contando', (view === 'conteo' && /[?&]id=/.test(location.hash)) || (view === 'checklist' && /[?&]r=/.test(location.hash)));
    $$('#side a.nav').forEach((a) => a.classList.toggle('on', a.dataset.nav === view));
    const main = $('#main');
    main.innerHTML = '<p class="muted">Cargando…</p>';
    try { await VIEWS[view](main); }
    catch (err) { main.innerHTML = `<div class="card"><b>Error:</b> ${esc(err.message)}</div>`; }
    actualizarPill();
  }
  window.addEventListener('hashchange', router);

  // ---------- Notificaciones push (este dispositivo) ----------
  const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const esInstalada = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const pushSoportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  async function registrarSW() {
    if (!('serviceWorker' in navigator)) return null;
    try { return await navigator.serviceWorker.register('/sw.js'); } catch (_) { return null; }
  }
  async function pushEstado() {
    const e = { soportado: pushSoportado(), ios: esIOS(), instalada: esInstalada(), permiso: 'Notification' in window ? Notification.permission : 'no', suscripto: false };
    if (e.soportado) { try { const reg = await navigator.serviceWorker.getRegistration('/'); const s = reg && await reg.pushManager.getSubscription(); e.suscripto = !!s; } catch (_) { /* nada */ } }
    return e;
  }
  const b64ToU8 = (b) => { const s = atob((b + '='.repeat((4 - (b.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...s].map((c) => c.charCodeAt(0))); };
  async function activarPush() {
    if (!pushSoportado()) throw new Error(esIOS() ? 'En iPhone primero agregá la app a la pantalla de inicio y abrila desde ese ícono.' : 'Este navegador no admite notificaciones.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Las notificaciones están bloqueadas para esta app. Habilitalas en los ajustes del navegador o del teléfono.' : 'No se dieron los permisos.');
    const reg = (await registrarSW()) || await navigator.serviceWorker.ready;
    await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/clave');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
    const j = sub.toJSON();
    await api('/api/push/suscribir', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys, dispositivo: navigator.userAgent.slice(0, 200) } });
    try { localStorage.removeItem('push_no'); } catch (_) { /* sin storage */ }
    return true;
  }
  async function desactivarPush() {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await api('/api/push/desuscribir', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
  }
  const pasosIOS = `<ol class="ios-pasos"><li>Abrí la app en <b>Safari</b>.</li><li>Tocá <b>Compartir</b> <span class="ios-ico">⬆︎</span> (abajo en el centro).</li><li>Elegí <b>Agregar a pantalla de inicio</b> y confirmá.</li><li>Abrí <b>Vinilo</b> desde el ícono nuevo y tocá <b>Activar notificaciones</b>.</li></ol>`;
  async function misNotificaciones() {
    const e = await pushEstado();
    const estado = !e.soportado ? (e.ios && !e.instalada ? 'ios' : 'no') : e.permiso === 'denied' ? 'bloq' : e.suscripto && e.permiso === 'granted' ? 'on' : 'off';
    const m = modal(`<h2>🔔 Notificaciones</h2>
      ${estado === 'on' ? '<div class="card" style="background:#e9f5ee;border-color:#b9dcc6">✅ <b>Activadas en este dispositivo.</b> Te van a llegar los avisos de Vinilo aunque la app esté cerrada.</div>'
        : estado === 'ios' ? `<p>En iPhone las notificaciones funcionan con la app agregada a la pantalla de inicio (iOS 16.4 o más nuevo):</p>${pasosIOS}`
        : estado === 'bloq' ? '<div class="card" style="background:#fff6e5;border-color:#f3d9a4">⚠️ Las notificaciones están <b>bloqueadas</b> para esta app. Habilitalas en los ajustes del navegador (ícono del candado junto a la dirección) o del teléfono, y volvé a intentar.</div>'
        : estado === 'no' ? '<p>Este navegador no admite notificaciones. Probá con Chrome en Android o con la app agregada a la pantalla de inicio en iPhone.</p>'
        : '<p>Activalas para recibir avisos de Vinilo en este celular aunque la app esté cerrada (recordatorios, turnos, conteos).</p>'}
      <div class="form-actions" style="flex-wrap:wrap">${estado === 'on' ? '<button class="btn ghost" id="pu-off" style="margin-right:auto">Desactivar</button><button class="btn sec" id="pu-test">Mandarme una prueba</button>' : ''}
        ${estado === 'off' ? '<button class="btn" id="pu-on">Activar notificaciones</button>' : ''}<button class="btn sec" data-close>Cerrar</button></div>`);
    if ($('#pu-on', m)) $('#pu-on', m).onclick = async () => { try { await activarPush(); closeModal(); toast('Notificaciones activadas 🔔'); try { await api('/api/push/prueba', { method: 'POST' }); } catch (_) { /* sin prueba */ } router(); } catch (err) { toast(err.message, true); } };
    if ($('#pu-off', m)) $('#pu-off', m).onclick = async () => { try { await desactivarPush(); closeModal(); toast('Notificaciones desactivadas en este dispositivo'); } catch (err) { toast(err.message, true); } };
    if ($('#pu-test', m)) $('#pu-test', m).onclick = async () => { try { const r = await api('/api/push/prueba', { method: 'POST' }); toast(r.enviados ? 'Prueba enviada: debería llegarte en unos segundos' : 'No se pudo entregar la prueba', !r.enviados); } catch (err) { toast(err.message, true); } };
  }
  // Aviso en el panel para activar las notificaciones
  async function bannerPush(cont) {
    if (!cont || S.user.ver_como) return;
    try { if (localStorage.getItem('push_no') && Date.now() - Number(localStorage.getItem('push_no')) < 14 * 86400e3) return; } catch (_) { /* sin storage */ }
    const e = await pushEstado();
    let html = '';
    if (e.soportado && e.permiso !== 'denied' && !(e.suscripto && e.permiso === 'granted')) html = `<div class="push-ban"><span>🔔</span><div><b>Recibí los avisos de Vinilo en tu celular</b><small>Recordatorios, turnos y conteos, aunque la app esté cerrada.</small></div><button class="btn sm" id="pb-on">Activar</button><button class="pb-x" id="pb-no" title="Ahora no">✕</button></div>`;
    else if (!e.soportado && e.ios && !e.instalada) html = `<div class="push-ban"><span>📲</span><div><b>Instalá Vinilo en tu iPhone para recibir avisos</b><small>Compartir ⬆︎ → Agregar a pantalla de inicio, y abrila desde el ícono.</small></div><button class="btn sm sec" id="pb-ios">Cómo</button><button class="pb-x" id="pb-no" title="Ahora no">✕</button></div>`;
    cont.innerHTML = html;
    if ($('#pb-on')) $('#pb-on').onclick = async () => { try { await activarPush(); cont.innerHTML = ''; toast('Notificaciones activadas 🔔'); api('/api/push/prueba', { method: 'POST' }).catch(() => {}); } catch (err) { toast(err.message, true); } };
    if ($('#pb-ios')) $('#pb-ios').onclick = () => misNotificaciones();
    if ($('#pb-no')) $('#pb-no').onclick = () => { cont.innerHTML = ''; try { localStorage.setItem('push_no', String(Date.now())); } catch (_) { /* sin storage */ } };
  }

  async function miWhatsapp() {
    let d; try { d = await api('/api/me/whatsapp'); } catch (err) { return toast(err.message, true); }
    const m = modal(`<h2>📱 Mi WhatsApp</h2><p class="sub" style="margin-top:-6px">Te avisamos por WhatsApp cuando respondan tus solicitudes${puede('gestionarSolicitudes') ? ' y cuando llegue una solicitud para aprobar' : ''}${puede('portalProveedor') ? ' y cuando Vinilo te confirme un pedido' : ''}.</p>
      <form id="f-wa"><div class="f"><label>Celular</label><input name="telefono" value="${esc(d.telefono || '')}" maxlength="30" placeholder="Ej.: 236 4123456" inputmode="tel" autofocus>
        <div class="stock-hint">Con código de área, sin 0 ni 15.</div></div>
        <label class="check mt"><input type="checkbox" name="ok" ${d.whatsapp_ok ? 'checked' : ''}> Quiero recibir avisos por WhatsApp</label>
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`);
    $('#f-wa', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/me/whatsapp', { method: 'PUT', body: { telefono: e.target.telefono.value, whatsapp_ok: e.target.ok.checked } }); closeModal(); toast('Listo, guardamos tu WhatsApp'); }
      catch (err) { toast(err.message, true); }
    });
  }

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

  const optAlmacenes = (sel, { soloActivos = true, vacio = '', todos = false } = {}) =>
    (vacio ? `<option value="">${vacio}</option>` : '') +
    (todos ? S.todosAlmacenes : S.almacenes).filter((a) => !soloActivos || a.activo).map((a) => `<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('');

  // ---------- Panel: tareas pendientes ----------
  // ---------- Avisos del administrador ----------
  const AV_TIPO = { INFO: { ic: '📢', lbl: 'Aviso' }, IMPORTANTE: { ic: '⚠️', lbl: 'Importante' }, URGENTE: { ic: '🚨', lbl: 'Urgente' } };
  const textoAviso = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
  async function avisosPanel(cont) {
    if (!cont) return;
    let lista = [];
    try { lista = await api('/api/avisos/mios'); } catch (_) { return; }
    let verLeidos = false;
    const pintar = () => {
      const nuevos = lista.filter((a) => !a.leido), leidos = lista.filter((a) => a.leido);
      const tarjeta = (a) => `<div class="av av-${a.tipo.toLowerCase()} ${a.leido ? 'leido' : ''}">
        <div class="av-ic">${AV_TIPO[a.tipo].ic}</div>
        <div class="av-c"><div class="av-top"><span class="av-tipo">${AV_TIPO[a.tipo].lbl}</span><span class="av-de">${esc(a.autor || 'Administración')} · ${fmtFecha(a.creado_en)}</span></div>
          <h3>${esc(a.titulo)}</h3><p>${textoAviso(a.mensaje)}</p></div>
        ${a.leido ? '' : `<button class="btn sm av-ok" data-av="${a.id}">✓ Entendido</button>`}</div>`;
      cont.innerHTML = (nuevos.length ? `<div class="av-lista">${nuevos.map(tarjeta).join('')}</div>` : '')
        + (leidos.length ? `<div class="av-ant"><a href="#" id="av-toggle">${verLeidos ? '▾ Ocultar' : '▸ Ver'} avisos leídos (${leidos.length})</a>${verLeidos ? `<div class="av-lista">${leidos.map(tarjeta).join('')}</div>` : ''}</div>` : '');
      cont.querySelectorAll('[data-av]').forEach((b) => (b.onclick = async () => {
        const a = lista.find((x) => x.id == b.dataset.av); const card = b.closest('.av');
        try { await api(`/api/avisos/${a.id}/leido`, { method: 'POST' }); } catch (err) { toast(err.message, true); return; }
        a.leido = true; card.classList.add('saliendo'); setTimeout(pintar, 300);
      }));
      const t = $('#av-toggle', cont); if (t) t.onclick = (e) => { e.preventDefault(); verLeidos = !verLeidos; pintar(); };
    };
    pintar();
  }

  VIEWS.avisos = async (main) => {
    const [avisos, roles, sucs] = await Promise.all([api('/api/avisos'), api('/api/roles'), api('/api/sucursales').catch(() => [])]);
    const rolesV = roles.filter((r) => r.codigo !== 'PROVEEDOR');
    const nomRol = (c) => (roles.find((r) => r.codigo === c) || { nombre: c }).nombre;
    const nomSuc = (id) => (sucs.find((s) => s.id === id) || { nombre: '#' + id }).nombre;
    const paraTxt = (a) => [a.roles.length ? a.roles.map(nomRol).join(', ') : 'Todos los roles', a.sucursales.length ? a.sucursales.map(nomSuc).join(', ') : ''].filter(Boolean).join(' · ');
    const estado = (a) => (!a.activo ? '<span class="badge">Pausado</span>' : a.vigente ? '<span class="badge ok">Visible</span>' : '<span class="badge">Vencido</span>');
    main.innerHTML = `<div class="toolbar"><div><h1>Avisos en el panel</h1><p class="sub">Lo que publiques aparece arriba de todo en el Panel de cada usuario hasta que lo marque como <b>Entendido</b>. Podés elegir roles o sucursales y enviarlo también al celular.</p></div><div class="spacer"></div><button class="btn" id="av-nuevo">+ Nuevo aviso</button></div>
      ${avisos.length ? `<div class="av-admin">${avisos.map((a) => { const pct = a.destinatarios ? Math.round((a.leyeron / a.destinatarios) * 100) : 0; return `
        <div class="card av-fila ${a.vigente ? '' : 'inactive'}"><div class="av-ic">${AV_TIPO[a.tipo].ic}</div>
          <div class="av-c"><div class="av-top">${estado(a)} <span class="av-de">${esc(a.autor || '')} · ${fmtFecha(a.creado_en)}${a.hasta ? ` · hasta el ${fmtDia(String(a.hasta).slice(0, 10))}` : ' · sin vencimiento'}${a.push ? ' · 🔔 enviado al celular' : ''}</span></div>
            <h3>${esc(a.titulo)}</h3><p>${textoAviso(a.mensaje)}</p>
            <div class="av-meta">👥 ${esc(paraTxt(a))}</div>
            <div class="av-leido"><div class="tb-meter"><i style="width:${pct}%"></i></div><a href="#" data-lec="${a.id}"><b>${a.leyeron}</b> de ${a.destinatarios} lo leyeron</a></div></div>
          <div class="av-acc"><button class="btn ghost sm" data-ed="${a.id}">Editar</button><button class="btn ghost sm" data-pu="${a.id}" title="Mandarlo como notificación al celular">🔔 Al celular</button>
            <button class="btn ghost sm" data-act="${a.id}">${a.activo ? 'Pausar' : 'Activar'}</button><button class="btn ghost sm" data-del="${a.id}" style="color:var(--accent)">Borrar</button></div></div>`; }).join('')}</div>`
        : '<div class="card empty" style="padding:40px"><div style="font-size:2rem">📢</div>Todavía no publicaste avisos.<br>Por ejemplo: “El sábado hay evento privado, todo el personal a las 19 h”.</div>'}`;
    const form = (a) => {
      const hoy = hoyISO(); const sum = (n) => { const d = new Date(hoy + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); };
      a = a || { titulo: '', mensaje: '', tipo: 'INFO', roles: [], sucursales: [], hasta: sum(6), push: false };
      const hasta = a.hasta ? String(a.hasta).slice(0, 10) : '';
      const m = modal(`<h2>${a.id ? 'Editar aviso' : 'Nuevo aviso'}</h2><form id="f-av">
        <div class="f"><label>Tipo</label><div class="bv-opc av-tipos">${Object.entries(AV_TIPO).map(([k, t]) => `<button type="button" data-t="${k}" class="${a.tipo === k ? 'on' : ''} t-${k.toLowerCase()}">${t.ic} ${t.lbl}</button>`).join('')}</div></div>
        <div class="f mt"><label>Título *</label><input name="titulo" maxlength="120" required value="${esc(a.titulo)}" placeholder="Ej.: Evento privado el sábado"></div>
        <div class="f mt"><label>Mensaje *</label><textarea name="mensaje" rows="4" maxlength="2000" required placeholder="Ej.: El sábado cerramos al público. Todo el personal a las 19 h.">${esc(a.mensaje)}</textarea></div>
        <div class="f mt"><label>Para qué roles <span class="muted" style="font-weight:400">(sin marcar = todos)</span></label><div class="chk-grupo">${rolesV.map((r) => `<label class="check"><input type="checkbox" name="rol" value="${esc(r.codigo)}" ${a.roles.includes(r.codigo) ? 'checked' : ''}> ${esc(r.nombre)}</label>`).join('')}</div></div>
        ${sucs.length ? `<div class="f mt"><label>Qué sucursales <span class="muted" style="font-weight:400">(sin marcar = todas)</span></label><div class="chk-grupo">${sucs.filter((s) => s.activo).map((s) => `<label class="check"><input type="checkbox" name="suc" value="${s.id}" ${a.sucursales.includes(s.id) ? 'checked' : ''}> ${esc(s.nombre)}</label>`).join('')}</div></div>` : ''}
        <div class="f mt"><label>Se muestra hasta</label><div class="bv-opc" id="av-hasta">${[['1 día', sum(0)], ['3 días', sum(2)], ['1 semana', sum(6)], ['1 mes', sum(29)], ['Sin vencimiento', '']].map(([l, v]) => `<button type="button" data-v="${v}" class="${v === hasta ? 'on' : ''}">${l}</button>`).join('')}</div>
          <input type="date" name="hasta" value="${hasta}" min="${hoy}" style="margin-top:8px;max-width:200px"></div>
        ${a.id ? `<label class="check mt"><input type="checkbox" name="volver"> Volver a mostrarlo a todos (aunque ya lo hayan marcado como leído)</label>` : `<label class="check mt"><input type="checkbox" name="push" ${a.push ? 'checked' : ''}> 🔔 Enviarlo también como notificación al celular</label>`}
        <div class="av-prev-t mt">Vista previa</div><div id="av-prev"></div>
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn" type="submit">${a.id ? 'Guardar' : 'Publicar'}</button></div></form>`, { wide: true });
      const f = $('#f-av', m); let tipo = a.tipo;
      const prev = () => { $('#av-prev', m).innerHTML = `<div class="av av-${tipo.toLowerCase()}"><div class="av-ic">${AV_TIPO[tipo].ic}</div><div class="av-c"><div class="av-top"><span class="av-tipo">${AV_TIPO[tipo].lbl}</span><span class="av-de">${esc(S.user.nombre)} · ahora</span></div><h3>${esc(f.titulo.value || 'Título del aviso')}</h3><p>${textoAviso(f.mensaje.value || 'El mensaje aparece acá.')}</p></div><button type="button" class="btn sm av-ok">✓ Entendido</button></div>`; };
      m.querySelectorAll('.av-tipos button').forEach((b) => (b.onclick = () => { m.querySelectorAll('.av-tipos button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); tipo = b.dataset.t; prev(); }));
      m.querySelectorAll('#av-hasta button').forEach((b) => (b.onclick = () => { m.querySelectorAll('#av-hasta button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); f.hasta.value = b.dataset.v; }));
      f.hasta.oninput = () => m.querySelectorAll('#av-hasta button').forEach((x) => x.classList.toggle('on', x.dataset.v === f.hasta.value));
      f.titulo.oninput = prev; f.mensaje.oninput = prev; prev();
      f.onsubmit = async (e) => {
        e.preventDefault();
        const body = { titulo: f.titulo.value, mensaje: f.mensaje.value, tipo, hasta: f.hasta.value || null,
          roles: [...f.querySelectorAll('[name=rol]:checked')].map((x) => x.value), sucursales: [...f.querySelectorAll('[name=suc]:checked')].map((x) => Number(x.value)),
          push: !!(f.push && f.push.checked), volver_a_mostrar: !!(f.volver && f.volver.checked) };
        try {
          const r = await api(a.id ? `/api/avisos/${a.id}` : '/api/avisos', { method: a.id ? 'PUT' : 'POST', body });
          closeModal(); toast(a.id ? 'Aviso actualizado' : r.push && !r.push.error ? `Aviso publicado · llegó a ${r.push.enviados} celular${r.push.enviados === 1 ? '' : 'es'}` : 'Aviso publicado'); VIEWS.avisos(main);
        } catch (err) { toast(err.message, true); }
      };
    };
    $('#av-nuevo').onclick = () => form();
    $$('[data-ed]').forEach((b) => (b.onclick = () => form(avisos.find((x) => x.id == b.dataset.ed))));
    $$('[data-act]').forEach((b) => (b.onclick = async () => { const a = avisos.find((x) => x.id == b.dataset.act); try { await api(`/api/avisos/${a.id}`, { method: 'PUT', body: { activo: !a.activo } }); VIEWS.avisos(main); } catch (err) { toast(err.message, true); } }));
    $$('[data-del]').forEach((b) => (b.onclick = () => { const a = avisos.find((x) => x.id == b.dataset.del);
      const m = modal(`<h2>Borrar aviso</h2><p>¿Borrar <b>${esc(a.titulo)}</b>? Deja de verse en todos los paneles.</p><div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn" id="av-del-ok">Borrar</button></div>`);
      $('#av-del-ok', m).onclick = async () => { try { await api(`/api/avisos/${a.id}`, { method: 'DELETE' }); closeModal(); VIEWS.avisos(main); } catch (err) { toast(err.message, true); } }; }));
    $$('[data-pu]').forEach((b) => (b.onclick = async () => { b.disabled = true; try { const r = await api(`/api/avisos/${b.dataset.pu}/push`, { method: 'POST' }); toast(`Enviado: llegó a ${r.enviados} celular${r.enviados === 1 ? '' : 'es'}${r.sin_activar ? ` · ${r.sin_activar} sin notificaciones activadas` : ''}`); } catch (err) { toast(err.message, true); } b.disabled = false; }));
    $$('[data-lec]').forEach((b) => (b.onclick = async (e) => { e.preventDefault(); const a = avisos.find((x) => x.id == b.dataset.lec); const l = await api(`/api/avisos/${a.id}/lecturas`);
      modal(`<h2>¿Quién lo leyó?</h2><p class="muted">${esc(a.titulo)}</p><div class="av-lec">${l.map((u) => `<div class="${u.leido_en ? 'si' : 'no'}"><span>${u.leido_en ? '✅' : '⏳'} ${esc(u.nombre)}</span><small>${esc(nomRol(u.rol))}${u.leido_en ? ' · ' + fmtFecha(u.leido_en) : ' · todavía no'}</small></div>`).join('') || '<p class="muted">Nadie corresponde a este aviso.</p>'}</div>
        <div class="form-actions"><button class="btn" data-close>Cerrar</button></div>`); }));
  };

  VIEWS.panel = async (main) => {
    const d = await api('/api/dashboard');
    const tareas = d.tareas || [];
    const total = tareas.filter((t) => t.prioridad !== 'baja').length;
    const PRI = { alta: 'Urgente', media: 'Pendiente', baja: 'Sugerencia' };
    let html = `<h1>Hola, ${esc(S.user.nombre.split(' ')[0])}</h1>
      <p class="sub">${esc(S.user.rol_nombre || ROL_LBL[S.user.rol] || S.user.rol)}${S.user.proveedor ? ' · ' + esc(S.user.proveedor) : ''} · ${new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
      · ${total ? `<b>${total} ${total === 1 ? 'tarea pendiente' : 'tareas pendientes'}</b>` : 'sin tareas pendientes'}</p>`;
    html += `<div id="panel-avisos"></div><div id="panel-push"></div><div id="panel-clima"></div>`;
    if (puede('programacion')) html += `<div id="panel-cal"></div>`;
    html += tareas.length ? `<div class="tareas">${tareas.map((t) => `
      <section class="tarea pri-${t.prioridad}">
        <header><span class="tarea-n">${t.cantidad > 1 || t.items.length ? fmtN(t.cantidad) : '!'}</span>
          <div><span class="tarea-pri">${PRI[t.prioridad]}</span><h3>${esc(t.titulo)}</h3></div></header>
        <p class="tarea-det">${esc(t.detalle)}</p>
        ${t.items.length ? `<ul>${t.items.map((i) => `<li><a href="${i.link || t.link}" class="${i.alerta ? 'al' : ''}"><b>${esc(i.texto)}</b>${i.sub ? `<span>${esc(i.sub)}</span>` : ''}</a></li>`).join('')}
          ${t.cantidad > t.items.length ? `<li class="mas">y ${fmtN(t.cantidad - t.items.length)} más…</li>` : ''}</ul>` : ''}
        <a class="btn sm" href="${t.link}">${esc(t.accion)} →</a>
      </section>`).join('')}</div>`
      : `<div class="card empty" style="padding:40px"><div style="font-size:2rem">✅</div><b>Todo al día.</b><br>No hay tareas pendientes para tu usuario.</div>`;
    if (d.almacenes) {
      html += `<h2 class="mt" style="margin-top:28px">Resumen de stock</h2><div class="resumen">${d.almacenes.filter((a) => a.activo).map((a) => `
        <a href="#/stock?alm=${a.id}"><span>${esc(a.nombre)}</span><b>${fmtN(a.unidades)}</b><small>${fmtN(a.productos)} productos</small></a>`).join('')}</div>`;
    }
    if (puede('solicitudes') && !puede('verStock')) {
      html += `<h2 class="mt" style="margin-top:28px">¿Qué necesitás pedir?</h2><div class="sol-tipos">
        <a href="#/mis-solicitudes?nueva=ADELANTO" class="sol-tipo"><span>💵</span>Adelanto de sueldo</a>
        <a href="#/mis-solicitudes?nueva=VACACIONES" class="sol-tipo"><span>🏖️</span>Vacaciones</a>
        <a href="#/mis-solicitudes?nueva=EXAMEN" class="sol-tipo"><span>📚</span>Día por examen</a>
        <a href="#/mis-solicitudes?nueva=ENFERMEDAD" class="sol-tipo"><span>🤒</span>Enfermedad</a>
        <a href="#/mis-solicitudes?nueva=OTRAS" class="sol-tipo"><span>📝</span>Otra licencia</a></div>`;
    }
    if (puede('misHoras') && !puede('verStock')) html += `<div id="panel-horas"></div>`;
    if (!puede('portalProveedor')) html += `<div id="panel-prog"></div>`;
    if (S.user.rol === 'REQUIRENTE') {
      html += `<div class="form-actions" style="justify-content:flex-start"><a class="btn" href="#/pedidos?nuevo=1" style="text-decoration:none">+ Nueva nota de pedido</a></div>`;
    }
    main.innerHTML = html;
    avisosPanel($('#panel-avisos'));
    climaNoche($('#panel-clima'));
    bannerPush($('#panel-push'));
    if ($('#panel-cal')) calendarioHoyManiana($('#panel-cal'));
    if ($('#panel-prog')) misProximosDias($('#panel-prog'), { titulo: 'Tus próximos días de trabajo', dias: 7 });
    if ($('#panel-horas')) api('/api/horas/mias').then((h) => {
      if (!h.vinculado || !$('#panel-horas')) return;
      $('#panel-horas').innerHTML = `<h2 class="mt" style="margin-top:28px">Mis horas de este mes</h2><div class="resumen">
        <a href="#/mis-horas"><span>Horas trabajadas</span><b>${hm(h.minutos)}</b><small>${h.dias_trabajados} ${h.dias_trabajados === 1 ? 'día' : 'días'} · ver detalle →</small></a>
        ${h.incompletas ? `<a href="#/mis-horas"><span>Fichadas incompletas</span><b style="color:var(--accent)">${h.incompletas}</b><small>avisá a tu encargado</small></a>` : ''}</div>`;
    }).catch(() => {});
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
        <label class="check" style="margin-bottom:10px"><input type="checkbox" id="s-bajo" ${params.get('bajo') ? 'checked' : ''}> Solo bajo mínimo</label>
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
      const bajo = $('#s-bajo').checked;
      const cols = almId ? alms.filter((a) => String(a.id) === almId) : alms;
      const rows = data.productos.filter((p) => {
        if (q && !(`${p.codigo} ${p.nombre}`.toLowerCase().includes(q))) return false;
        if (cat && p.categoria !== cat) return false;
        if (al === 'any' && !tieneAlerta(p)) return false;
        if (al === 'venc' && !p.alerta_vencimiento) return false;
        if (al === 'cuid' && !p.alerta_cuidado) return false;
        if (al === 'frio' && !p.alerta_frio) return false;
        const cant = almId ? (p.stock[almId] || 0) : p.total;
        const bajoMin = (almId ? [Number(almId)] : alms.map((a) => a.id)).some((aid) => p.minimos[aid] && (p.stock[aid] || 0) < p.minimos[aid]);
        if (bajo) return bajoMin;
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
        <thead><tr><th>Código</th><th>Producto</th><th>Alertas</th>${cols.map((a) => `<th class="num">${esc(a.nombre)}</th>`).join('')}${almId ? '' : '<th class="num">Total</th>'}${puede('minimos') ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((p) => `<tr class="${p.activo ? '' : 'inactive'}"><td class="code">${esc(p.codigo)}</td><td>${esc(p.nombre)}${p.categoria ? ` <span class="muted">· ${esc(p.categoria)}</span>` : ''}${p.activo ? '' : ' <span class="muted">(inactivo)</span>'}</td>
          <td>${badgesAlerta(p)}</td>${cols.map((a) => { const v = p.stock[a.id] || 0; const mn = p.minimos[a.id]; const b = mn && v < mn;
            return `<td class="num ${v ? '' : 'zero'} ${b ? 'bajo-min' : ''}" title="${mn ? `Mínimo ${mn}` : ''}">${fmtN(v)}${mn ? `<small class="min">mín ${fmtN(mn)}</small>` : ''}</td>`; }).join('')}${almId ? '' : `<td class="num tot">${fmtN(p.total)}</td>`}
          ${puede('minimos') ? `<td class="num"><button class="btn ghost sm" data-min="${p.id}" title="Stock mínimo por almacén">✎</button></td>` : ''}</tr>`).join('')}</tbody>
        <tfoot><tr><td></td><td><b>${rows.length} productos</b></td><td></td>${totCols.map((t) => `<td class="num tot">${fmtN(t)}</td>`).join('')}${almId ? '' : `<td class="num tot">${fmtN(totCols.reduce((a, b) => a + b, 0))}</td>`}${puede('minimos') ? '<td></td>' : ''}</tr></tfoot>
        </table></div>` : `<div class="card empty">${bajoSel() ? 'Ningún producto está por debajo de su mínimo.' : 'No hay productos que coincidan con el filtro.'}</div>`;
      $$('#s-tbl [data-min]').forEach((b) => b.addEventListener('click', () => editarMinimos(data.productos.find((x) => x.id == b.dataset.min))));
    };
    const bajoSel = () => $('#s-bajo').checked;
    const editarMinimos = (p) => {
      const m = modal(`<h2>Stock mínimo · ${esc(p.nombre)}</h2>
        <p class="muted">Cuando el stock de un almacén quede por debajo de su mínimo, el producto aparece en el panel como <b>para reponer</b>. Dejá vacío o 0 para no controlar ese almacén.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Almacén</th><th class="num">Stock actual</th><th class="num" style="width:140px">Mínimo</th></tr></thead><tbody>
        ${alms.map((a) => `<tr><td>${esc(a.nombre)}</td><td class="num">${fmtN(p.stock[a.id] || 0)}</td>
          <td class="num"><input type="number" min="0" step="1" data-alm="${a.id}" value="${p.minimos[a.id] || ''}" style="width:110px;text-align:right"></td></tr>`).join('')}
        </tbody></table></div>
        <div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn" id="mn-ok">Guardar</button></div>`);
      $('#mn-ok', m).onclick = async () => {
        const minimos = Object.fromEntries($$('[data-alm]', m).map((i) => [i.dataset.alm, i.value === '' ? 0 : parseInt(i.value, 10)]));
        try {
          await api(`/api/productos/${p.id}/minimos`, { method: 'PUT', body: { minimos } });
          p.minimos = Object.fromEntries(Object.entries(minimos).filter(([, v]) => v > 0).map(([k, v]) => [Number(k), v]));
          closeModal(); toast('Mínimos guardados'); pintar();
        } catch (err) { toast(err.message, true); }
      };
    };
    ['#s-q', '#s-alm', '#s-cat', '#s-al', '#s-cero', '#s-bajo'].forEach((s) => $(s).addEventListener('input', pintar));
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
      const provs = tipo === 'RECEPCION' ? (await api('/api/proveedores').catch(() => [])).filter((p) => p.activo) : [];
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
          ${tipo === 'RECEPCION' ? `
          <div class="rec-grid">
            <div class="f"><label>Almacén que recibe *</label><select id="m-destino">${optAlmacenes(S.almacenes.length === 1 ? S.almacenes[0].id : '', { vacio: 'Seleccionar…' })}</select></div>
            <div>
              <div class="f"><label>Proveedor</label><input id="m-prov" list="m-prov-list" autocomplete="off" placeholder="Escribí para buscar el proveedor…">
                <datalist id="m-prov-list">${provs.map((p) => `<option value="${esc(p.nombre)}"></option>`).join('')}</datalist>
                <div class="stock-hint" id="m-prov-hint">Dejalo vacío si es una devolución u otro ingreso sin proveedor.</div></div>
              <div class="f mt"><label>N° de remito</label><input id="m-ref" maxlength="60" placeholder="Ej.: 0001-00001234" inputmode="text"></div>
            </div>
          </div>` : `
          <div class="row">
            ${cfg.origen ? `<div class="f"><label>${tipo === 'TRANSFERENCIA' ? 'Desde (origen)' : 'Almacén'}</label><select id="m-origen">${optAlmacenes('', { vacio: 'Seleccionar…' })}</select></div>` : ''}
            ${cfg.destino ? `<div class="f"><label>${tipo === 'TRANSFERENCIA' ? 'Hacia (destino)' : 'Almacén que recibe'}</label><select id="m-destino">${optAlmacenes('', { vacio: 'Seleccionar…', todos: tipo === 'TRANSFERENCIA' })}</select></div>` : ''}
            <div class="f"><label>${cfg.ref}</label><input id="m-ref" maxlength="120"></div>
          </div>`}
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
      const provSel = () => {
        const v = ($('#m-prov') && $('#m-prov').value.trim().toLowerCase()) || '';
        return v ? provs.find((p) => p.nombre.toLowerCase() === v) || null : null;
      };
      if ($('#m-prov')) $('#m-prov').addEventListener('input', () => {
        const v = $('#m-prov').value.trim();
        const ok = !v || provSel();
        $('#m-prov-hint').className = 'stock-hint' + (ok ? '' : ' bad');
        $('#m-prov-hint').textContent = !v ? 'Dejalo vacío si es una devolución u otro ingreso sin proveedor.' : ok ? '✓ Proveedor seleccionado' : 'Elegí un proveedor de la lista';
      });
      $('#m-clear').onclick = () => { lineas.length = 0; $('#m-obs').value = ''; $('#m-ref').value = ''; if ($('#m-prov')) $('#m-prov').value = ''; pintar(); };
      $('#m-save').onclick = async () => {
        if (!lineas.length) return toast('Agregá al menos un producto', true);
        if (tipo === 'RECEPCION' && $('#m-prov').value.trim() && !provSel()) return toast('El proveedor no está en la lista: elegilo de las opciones', true);
        const btn = $('#m-save');
        btn.disabled = true;
        try {
          const r = await api('/api/movimientos', { method: 'POST', body: {
            tipo, origen_id: cfg.origen ? $('#m-origen').value : null, destino_id: cfg.destino ? $('#m-destino').value : null,
            referencia: tipo === 'RECEPCION' ? ($('#m-ref').value.trim() ? `Remito ${$('#m-ref').value.trim()}` : '') : $('#m-ref').value,
            proveedor_id: tipo === 'RECEPCION' && provSel() ? provSel().id : null,
            observacion: $('#m-obs').value, items: lineas,
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


  // ---------- Consumos desde ventas de Fudo ----------
  const aInputLocal = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const CF_EST = { BORRADOR: 'Borrador', CONFIRMADA: 'Confirmada', ANULADA: 'Anulada' };

  VIEWS['consumos-fudo'] = async (main) => {
    const d = await api('/api/consumos-fudo');
    const puedeImp = puede('consumir');
    const ult = d.ultimo;
    const ahora = new Date(); ahora.setSeconds(0, 0);
    const desdeDef = ult ? new Date(ult.hasta) : (() => { const x = new Date(); x.setDate(x.getDate() - 1); x.setHours(6, 0, 0, 0); return x; })();
    main.innerHTML = `
      <h1>Consumos desde Fudo</h1>
      <p class="sub">Trae las unidades vendidas en Fudo en un período y las deja en <b>borrador</b> para elegir el almacén, revisar y confirmar. Al confirmar se registra un <b>Consumo</b> y se descuenta el stock.</p>
      ${!d.configurado ? '<div class="card" style="background:#faf8f5">🔌 La integración con Fudo no está configurada (FUDO_API_KEY / FUDO_API_SECRET en Render).</div>' : ''}
      ${puedeImp && d.configurado ? `<div class="card">
        <h2>Importar ventas</h2>
        <p class="stock-hint" style="margin:-6px 0 12px">${ult ? `Último período importado: <b>${fmtFecha(ult.desde)} → ${fmtFecha(ult.hasta)}</b> (#${ult.id}, ${CF_EST[ult.estado].toLowerCase()}). Para no superponer, el nuevo período empieza ahí.` : 'Todavía no se importó ningún período.'}</p>
        <div class="row">
          <div class="f"><label>Desde</label><input type="datetime-local" id="cf-desde" value="${aInputLocal(desdeDef)}"></div>
          <div class="f"><label>Hasta</label><input type="datetime-local" id="cf-hasta" value="${aInputLocal(ahora)}"></div>
          <div><button class="btn" id="cf-imp">Importar</button></div>
        </div>
        <div class="row mt" style="gap:8px">
          <span class="stock-hint">Atajos:</span>
          ${ult ? '<button class="btn ghost sm" data-pre="ult">Desde el último hasta ahora</button>' : ''}
          <button class="btn ghost sm" data-pre="jornada">Jornada de ayer (06:00 a 06:00)</button>
          <button class="btn ghost sm" data-pre="semana">Últimos 7 días</button>
        </div>
      </div>` : ''}
      <h2 class="mt">Importaciones</h2>
      ${d.importaciones.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Período</th><th>Estado</th><th>Almacén</th><th class="num">Productos</th><th class="num">Unidades</th><th class="num">Sin vincular</th><th>Importó</th><th></th></tr></thead><tbody>
        ${d.importaciones.map((i) => `<tr class="${i.estado === 'ANULADA' ? 'inactive' : ''}"><td><b>#${i.id}</b></td><td>${fmtFecha(i.desde)} → ${fmtFecha(i.hasta)}</td>
          <td><span class="badge cf-${i.estado}">${CF_EST[i.estado]}</span></td><td>${esc(i.almacen || (i.estado === 'BORRADOR' ? '— a definir —' : ''))}</td>
          <td class="num">${i.lineas}</td><td class="num">${fmtN(i.unidades)}</td><td class="num ${i.sin_vincular ? 'stock-hint bad' : ''}">${i.sin_vincular || ''}</td>
          <td>${esc(i.creado_por)}</td><td class="num"><button class="btn ghost sm" data-ver="${i.id}">${i.estado === 'BORRADOR' && puedeImp ? 'Revisar' : 'Ver'}</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="card empty">Todavía no hay importaciones.</div>'}`;
    $$('[data-ver]').forEach((b) => b.addEventListener('click', () => verConsumoFudo(Number(b.dataset.ver))));
    $$('[data-pre]').forEach((b) => b.addEventListener('click', () => {
      const h = new Date(); h.setSeconds(0, 0);
      let de = new Date(h);
      if (b.dataset.pre === 'ult') de = new Date(ult.hasta);
      if (b.dataset.pre === 'jornada') { de.setDate(de.getDate() - 1); de.setHours(6, 0, 0, 0); h.setTime(de.getTime() + 24 * 3600 * 1000); }
      if (b.dataset.pre === 'semana') de.setDate(de.getDate() - 7);
      $('#cf-desde').value = aInputLocal(de); $('#cf-hasta').value = aInputLocal(h);
    }));
    if ($('#cf-imp')) $('#cf-imp').onclick = async () => {
      const desde = $('#cf-desde').value, hasta = $('#cf-hasta').value;
      if (!desde || !hasta) return toast('Completá desde y hasta', true);
      const btn = $('#cf-imp'); btn.disabled = true; btn.textContent = 'Leyendo ventas de Fudo…';
      try {
        const r = await api('/api/consumos-fudo/importar', { method: 'POST', body: { desde: new Date(desde).toISOString(), hasta: new Date(hasta).toISOString() } });
        toast(`Importación #${r.id}: ${r.productos} productos vendidos${r.sin_vincular ? ` (${r.sin_vincular} sin vincular)` : ''}`);
        await router(); actualizarPill();
        verConsumoFudo(r.id);
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Importar'; }
    };
  };

  async function verConsumoFudo(id) {
    let imp;
    try { imp = await api('/api/consumos-fudo/' + id); } catch (err) { return toast(err.message, true); }
    const editable = imp.estado === 'BORRADOR' && puede('consumir');
    const lineas = imp.items.map((i) => ({ ...i }));
    const cats = [...new Set(lineas.filter((l) => l.producto_id).map((l) => l.categoria || 'Sin categoría'))].sort();
    const m = modal(`
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="margin:0">Consumo desde Fudo #${imp.id}</h2><span class="badge cf-${imp.estado}">${CF_EST[imp.estado]}</span></div>
      <p class="muted" style="margin-top:8px">Ventas del <b>${fmtFecha(imp.desde)}</b> al <b>${fmtFecha(imp.hasta)}</b> · ${fmtN(imp.items_leidos)} ítems leídos${imp.items_cancelados ? `, ${imp.items_cancelados} cancelados descartados` : ''}<br>
        Importó ${esc(imp.creado_por_nombre)} ${fmtFecha(imp.creado_en)}${imp.confirmado_en ? ` · Confirmó ${esc(imp.confirmado_por_nombre)} ${fmtFecha(imp.confirmado_en)} · Movimiento #${imp.movimiento_id}` : ''}</p>
      <div class="row">
        <div class="f"><label>Almacén donde se consumió *</label><select id="cf-alm" ${editable ? '' : 'disabled'}>${optAlmacenes(imp.almacen_id || '', { vacio: 'Seleccionar…' })}</select></div>
        ${editable ? `<div class="f"><label>Excluir una categoría completa</label><div style="display:flex;gap:6px"><select id="cf-cat"><option value="">Elegir…</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select><button class="btn sec sm" id="cf-excl" type="button">Excluir</button></div></div>` : ''}
      </div>
      <p class="stock-hint" id="cf-res" style="margin:12px 0 6px"></p>
      <div class="tbl-wrap" style="max-height:48vh;overflow:auto"><table><thead><tr><th>${editable ? '<input type="checkbox" id="cf-all" title="Todos">' : ''}</th><th>Producto</th><th>Categoría</th><th class="num">Vendido</th><th class="num">A consumir</th><th class="num">Stock en almacén</th><th></th></tr></thead><tbody id="cf-body"></tbody></table></div>
      ${editable ? `<label class="check mt"><input type="checkbox" id="cf-lim"> Si falta stock, consumir solo lo disponible (la diferencia queda anotada en el movimiento)</label>` : ''}
      <div class="f mt"><label>Observaciones</label><input id="cf-obs" maxlength="600" value="${esc(imp.observacion || '')}" ${editable ? '' : 'disabled'}></div>
      <div class="form-actions"><button class="btn sec" data-close>Cerrar</button>
        ${editable ? '<button class="btn danger" id="cf-anular">Anular</button><button class="btn sec" id="cf-save">Guardar borrador</button><button class="btn ok" id="cf-conf">Confirmar consumo</button>' : ''}</div>`, { wide: true });
    const almSel = () => Number($('#cf-alm', m).value) || null;
    const pintar = () => {
      const a = almSel();
      let unidades = 0, faltan = 0, incl = 0;
      $('#cf-body', m).innerHTML = lineas.map((l, i) => {
        const vinc = !!l.producto_id && l.gestion_stock !== false;
        const sinGestion = !!l.producto_id && l.gestion_stock === false;
        const disp = a && vinc ? (l.stock[a] || 0) : null;
        const falta = vinc && l.incluir && disp !== null && l.cantidad > disp;
        if (vinc && l.incluir) { unidades += l.cantidad; incl++; if (falta) faltan++; }
        return `<tr class="${!vinc || !l.incluir ? 'inactive' : ''}">
          <td>${editable && vinc ? `<input type="checkbox" data-inc="${i}" ${l.incluir ? 'checked' : ''}>` : ''}</td>
          <td>${vinc ? `<span class="code">${esc(l.codigo)}</span> ${esc(l.nombre)} ${badgesAlerta(l)}` : sinGestion ? `<span class="code">${esc(l.codigo)}</span> ${esc(l.nombre)} <span class="badge b-CANCELADO" title="El producto no tiene gestión de stock">Sin gestión de stock</span>` : `${esc(l.nombre_fudo)} <span class="badge b-RECHAZADO" title="Producto de Fudo ${esc(l.fudo_product_id)} que no está en la app">No está en la app</span>`}</td>
          <td class="muted">${esc(l.categoria || '')}</td><td class="num">${fmtN(l.cantidad_vendida)}</td>
          <td class="num">${editable && vinc ? `<input type="number" min="0" step="1" data-cant="${i}" value="${l.cantidad}" style="width:90px;text-align:right">` : fmtN(vinc && l.incluir ? l.cantidad : 0)}</td>
          <td class="num">${disp === null ? '—' : fmtN(disp)}</td><td>${falta ? `<span class="badge b-PENDIENTE">Faltan ${fmtN(l.cantidad - disp)}</span>` : ''}</td></tr>`;
      }).join('');
      const nSinG = lineas.filter((l) => l.producto_id && l.gestion_stock === false).length;
      $('#cf-res', m).innerHTML = `${incl} productos incluidos${nSinG ? ` · ${nSinG} sin gestión de stock (no se consumen)` : ''} · <b>${fmtN(unidades)} unidades</b> a consumir${a ? '' : ' · <b class="bad">elegí el almacén</b>'}${faltan ? ` · <b class="bad">${faltan} con stock insuficiente</b>` : ''}${lineas.some((l) => !l.producto_id) ? ` · ${lineas.filter((l) => !l.producto_id).length} productos de Fudo no están en la app (sincronizá productos)` : ''}`;
      $$('[data-inc]', m).forEach((c) => c.addEventListener('change', () => { lineas[c.dataset.inc].incluir = c.checked; pintar(); }));
      $$('[data-cant]', m).forEach((c) => c.addEventListener('change', () => { lineas[c.dataset.cant].cantidad = Math.max(0, parseInt(c.value, 10) || 0); pintar(); }));
    };
    $('#cf-alm', m).addEventListener('change', pintar);
    if (editable) {
      const operables = () => lineas.filter((l) => l.producto_id && l.gestion_stock !== false);
      $('#cf-all', m).checked = operables().every((l) => l.incluir);
      $('#cf-all', m).addEventListener('change', (e) => { operables().forEach((l) => { l.incluir = e.target.checked; }); pintar(); });
      $('#cf-excl', m).onclick = () => {
        const c = $('#cf-cat', m).value; if (!c) return;
        operables().forEach((l) => { if ((l.categoria || 'Sin categoría') === c) l.incluir = false; }); pintar();
      };
      const guardar = () => api('/api/consumos-fudo/' + id, { method: 'PUT', body: {
        almacen_id: almSel(), observacion: $('#cf-obs', m).value, items: operables().map((l) => ({ id: l.id, cantidad: l.cantidad, incluir: l.incluir })) } });
      $('#cf-save', m).onclick = async () => { try { await guardar(); toast('Borrador guardado'); closeModal(); router(); } catch (err) { toast(err.message, true); } };
      $('#cf-anular', m).onclick = async () => {
        if (!confirm('¿Anular esta importación? El período queda libre para volver a importarlo.')) return;
        try { await api(`/api/consumos-fudo/${id}/anular`, { method: 'POST' }); toast('Importación anulada'); closeModal(); router(); actualizarPill(); } catch (err) { toast(err.message, true); }
      };
      $('#cf-conf', m).onclick = async () => {
        if (!almSel()) return toast('Elegí el almacén donde se consumió', true);
        const nombre = S.almacenes.find((a) => a.id === almSel()).nombre;
        if (!confirm(`Se descontarán del stock de ${nombre} las cantidades incluidas. ¿Confirmar?`)) return;
        try {
          await guardar();
          const r = await api(`/api/consumos-fudo/${id}/confirmar`, { method: 'POST', body: { almacen_id: almSel(), limitar_a_stock: $('#cf-lim', m).checked } });
          toast(`Consumo registrado (movimiento #${r.movimiento_id})${r.faltantes.length ? ` · ${r.faltantes.length} productos sin stock suficiente` : ''}`);
          closeModal(); router(); actualizarPill();
        } catch (err) { toast(err.message, true); }
      };
    }
    pintar();
  }


  // ---------- Receta (insumos por tanda) ----------
  async function editarReceta(prod, productos, nuevo = false) {
    const rec = await api('/api/recetas/' + prod.id);
    const insumosPosibles = productos.filter((x) => x.gestion_stock && x.activo && x.id !== prod.id);
    const lineas = rec.insumos.map((i) => ({ insumo_id: i.insumo_id, cantidad: i.cantidad, nombre: i.nombre, codigo: i.codigo, unidad: i.unidad }));
    const m = modal(`<h2>Receta · ${esc(prod.nombre)}</h2>
      ${nuevo ? '<p class="obs" style="margin-top:-6px">Activaste la gestión de producción: cargá la receta para poder producirlo.</p>' : ''}
      <div class="row"><div class="f s" style="flex-basis:200px"><label>Rinde por tanda (unidades de ${esc(prod.nombre)}) *</label><input type="number" id="rc-rend" min="1" step="1" value="${rec.rendimiento || 1}"></div></div>
      <h2 class="mt" style="font-size:1rem">Insumos por tanda</h2>
      <div class="row"><div class="f w"><label>Insumo (productos con gestión de stock)</label><input id="rc-prod" list="rc-list" autocomplete="off" placeholder="Buscá el insumo…">
        <datalist id="rc-list">${insumosPosibles.map((x) => `<option value="${esc(x.codigo)} — ${esc(x.nombre)}"></option>`).join('')}</datalist></div>
        <div class="f s"><label>Cantidad</label><input id="rc-cant" type="number" min="1" step="1"></div>
        <div><button class="btn sec" id="rc-add" type="button">Agregar</button></div></div>
      <div id="rc-lines" class="mt"></div>
      <div class="f mt"><label>Instrucciones (opcional)</label><textarea id="rc-ins" maxlength="2000" placeholder="Pasos, tiempos, temperatura…">${esc(rec.instrucciones || '')}</textarea></div>
      <div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn" id="rc-ok">Guardar receta</button></div>`, { wide: true });
    const buscar = (t) => { const c = t.split(' — ')[0].trim().toUpperCase(); return insumosPosibles.find((x) => x.codigo.toUpperCase() === c); };
    const pintar = () => {
      $('#rc-lines', m).innerHTML = lineas.length ? `<div class="tbl-wrap"><table><thead><tr><th>Insumo</th><th class="num" style="width:140px">Por tanda</th><th></th></tr></thead><tbody>
        ${lineas.map((l, i) => `<tr><td><span class="code">${esc(l.codigo)}</span> ${esc(l.nombre)}</td><td class="num"><input type="number" min="1" step="1" value="${l.cantidad}" data-i="${i}" style="width:100px;text-align:right"></td>
          <td class="num"><button class="btn ghost sm" data-del="${i}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Agregá los insumos que lleva una tanda.</p>';
      $$('#rc-lines [data-i]', m).forEach((inp) => inp.addEventListener('change', () => { lineas[inp.dataset.i].cantidad = Math.max(1, parseInt(inp.value, 10) || 1); }));
      $$('#rc-lines [data-del]', m).forEach((b) => b.addEventListener('click', () => { lineas.splice(Number(b.dataset.del), 1); pintar(); }));
    };
    const agregar = () => {
      const x = buscar($('#rc-prod', m).value); const c = parseInt($('#rc-cant', m).value, 10);
      if (!x) return toast('Elegí un insumo de la lista', true);
      if (!Number.isInteger(c) || c < 1) return toast('Ingresá una cantidad válida', true);
      const ex = lineas.find((l) => l.insumo_id === x.id);
      if (ex) ex.cantidad += c; else lineas.push({ insumo_id: x.id, cantidad: c, nombre: x.nombre, codigo: x.codigo, unidad: x.unidad });
      $('#rc-prod', m).value = ''; $('#rc-cant', m).value = ''; $('#rc-prod', m).focus(); pintar();
    };
    $('#rc-add', m).onclick = agregar;
    $('#rc-prod', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#rc-cant', m).focus(); } });
    $('#rc-cant', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); agregar(); } });
    $('#rc-ok', m).onclick = async () => {
      try {
        await api('/api/recetas/' + prod.id, { method: 'PUT', body: { rendimiento: parseInt($('#rc-rend', m).value, 10), instrucciones: $('#rc-ins', m).value,
          insumos: lineas.map((l) => ({ insumo_id: l.insumo_id, cantidad: l.cantidad })) } });
        closeModal(); toast('Receta guardada'); router();
      } catch (err) { toast(err.message, true); }
    };
    pintar();
  }

  // ---------- Producción ----------
  VIEWS.produccion = async (main) => {
    const d = await api('/api/produccion');
    const listos = d.productos.filter((p) => p.receta && p.receta.insumos.length);
    const sinReceta = d.productos.filter((p) => !p.receta || !p.receta.insumos.length);
    main.innerHTML = `<h1>Producción</h1>
      <p class="sub">Elaborá productos a partir de su receta: se descuentan los insumos y se suma lo producido en el mismo almacén.</p>
      ${!d.productos.length ? `<div class="card empty">No hay productos con <b>Gestión de producción</b>.${puede('productos') ? ' Activala en Productos (ficha del producto) y cargale la receta.' : ''}</div>` : `
      <div class="card">
        <div class="row">
          <div class="f w"><label>Producto a producir *</label><select id="pd-prod"><option value="">Seleccionar…</option>${listos.map((p) => `<option value="${p.id}">${esc(p.nombre)} — rinde ${fmtN(p.receta.rendimiento)} por tanda</option>`).join('')}</select></div>
          <div class="f"><label>Almacén *</label><select id="pd-alm">${optAlmacenes(S.almacenes.length === 1 ? S.almacenes[0].id : '', { vacio: 'Seleccionar…' })}</select></div>
          <div class="f s"><label>Tandas *</label><input type="number" id="pd-tandas" min="1" step="1" value="1"></div>
        </div>
        ${sinReceta.length ? `<p class="stock-hint mt">Sin receta (no se pueden producir todavía): ${sinReceta.map((p) => esc(p.nombre)).join(', ')}.</p>` : ''}
        <div id="pd-det" class="mt"></div>
      </div>`}
      ${d.ultimas.length ? `<h2 class="mt">Últimas producciones</h2><div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Producto</th><th class="num">Producido</th><th>Almacén</th><th>Usuario</th><th></th></tr></thead><tbody>
        ${d.ultimas.map((u) => `<tr><td>${fmtFecha(u.fecha)}</td><td>${esc(u.producto || '')}</td><td class="num">+${fmtN(u.producido)}</td><td>${esc(u.almacen)}</td><td>${esc(u.usuario)}</td>
          <td class="num"><button class="btn ghost sm" data-ver="${u.id}">Ver</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
    $$('[data-ver]').forEach((b) => b.addEventListener('click', () => verMovimiento(b.dataset.ver)));
    if (!listos.length) return;
    let reales = {};
    const pintar = () => {
      const p = listos.find((x) => String(x.id) === $('#pd-prod').value);
      const alm = Number($('#pd-alm').value) || null;
      const tandas = Math.max(0, parseInt($('#pd-tandas').value, 10) || 0);
      if (!p) { $('#pd-det').innerHTML = '<p class="muted">Elegí qué producir.</p>'; return; }
      let falta = false;
      const filas = p.receta.insumos.map((i) => {
        const teorico = i.cantidad * tandas;
        const real = reales[i.insumo_id] ?? teorico;
        const disp = alm ? ((d.stock[i.insumo_id] || {})[alm] || 0) : null;
        const f = disp !== null && real > disp; if (f) falta = true;
        return `<tr><td><span class="code">${esc(i.codigo)}</span> ${esc(i.nombre)}</td><td class="num">${fmtN(i.cantidad)}</td><td class="num">${fmtN(teorico)}</td>
          <td class="num"><input type="number" min="0" step="1" data-real="${i.insumo_id}" value="${real}" style="width:100px;text-align:right"></td>
          <td class="num ${f ? 'stock-hint bad' : ''}">${disp === null ? '—' : fmtN(disp)}</td><td>${f ? `<span class="badge b-RECHAZADO">Faltan ${fmtN(real - disp)}</span>` : disp !== null ? '<span class="badge b-COMPLETADO">OK</span>' : ''}</td></tr>`;
      }).join('');
      const producir = tandas * p.receta.rendimiento;
      $('#pd-det').innerHTML = `
        <div class="pd-res"><span>Vas a producir</span><b>${fmtN(producir)}</b><span>${esc(p.unidad)} de ${esc(p.nombre)}</span>
          <label style="margin-left:auto">Cantidad real obtenida <input type="number" id="pd-real" min="1" step="1" value="${producir}" style="width:110px;display:inline-block;margin-left:6px"></label></div>
        <div class="tbl-wrap mt"><table><thead><tr><th>Insumo</th><th class="num">Por tanda</th><th class="num">Según receta</th><th class="num">Consumo real</th><th class="num">Stock ${alm ? 'en almacén' : ''}</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>
        ${p.receta.instrucciones ? `<p class="obs mt">📋 ${esc(p.receta.instrucciones)}</p>` : ''}
        <div class="f mt"><label>Observaciones</label><input id="pd-obs" maxlength="1000" placeholder="Ej.: lote de la mañana, merma por…"></div>
        <div class="form-actions"><button class="btn ok" id="pd-ok" ${!alm || !tandas || falta ? 'disabled' : ''}>Producir</button></div>
        ${!alm ? '<p class="stock-hint" style="text-align:right">Elegí el almacén.</p>' : falta ? '<p class="stock-hint bad" style="text-align:right">No alcanzan los insumos en ese almacén.</p>' : ''}`;
      $$('[data-real]').forEach((inp) => inp.addEventListener('change', () => { reales[inp.dataset.real] = Math.max(0, parseInt(inp.value, 10) || 0); pintar(); }));
      $('#pd-ok').onclick = async () => {
        const cant = parseInt($('#pd-real').value, 10);
        if (!confirm(`Producir ${fmtN(cant)} ${p.unidad} de ${p.nombre} en ${S.almacenes.find((a) => a.id === alm).nombre}?`)) return;
        $('#pd-ok').disabled = true;
        try {
          const r = await api('/api/produccion', { method: 'POST', body: { producto_id: p.id, almacen_id: alm, tandas, cantidad_producida: cant, observacion: $('#pd-obs').value,
            insumos: p.receta.insumos.map((i) => ({ insumo_id: i.insumo_id, cantidad: reales[i.insumo_id] ?? i.cantidad * tandas })) } });
          toast(`Producción registrada: +${fmtN(r.producido)} ${p.nombre}`); router();
        } catch (err) { toast(err.message, true); $('#pd-ok').disabled = false; }
      };
    };
    $('#pd-prod').addEventListener('change', () => { reales = {}; pintar(); });
    $('#pd-tandas').addEventListener('input', () => { reales = {}; pintar(); });
    $('#pd-alm').addEventListener('change', pintar);
    pintar();
  };


  // ---------- Personal: solicitudes ----------
  const SOL_ICO = { ADELANTO: '💵', VACACIONES: '🏖️', EXAMEN: '📚', ENFERMEDAD: '🤒', MATRIMONIO: '💍', NACIMIENTO: '👶', FALLECIMIENTO: '🕊️', MUDANZA: '📦', TRAMITE: '🗂️', OTRO: '📝' };
  const SOL_EST = { PENDIENTE: 'Pendiente', APROBADA: 'Aprobada', RECHAZADA: 'Rechazada', CANCELADA: 'Cancelada' };
  const fmt$ = (n) => (n === null || n === undefined ? '' : '$ ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
  const periodoSol = (x) => (x.tipo === 'ADELANTO' ? (x.monto === null ? 'Monto a definir' : fmt$(x.monto)) + (x.monto_aprobado !== null && x.monto_aprobado !== x.monto ? ` (aprobado ${fmt$(x.monto_aprobado)})` : '')
    : `${fmtDia(x.desde)}${x.hasta && x.hasta !== x.desde ? ' al ' + fmtDia(x.hasta) : ''} · ${x.dias} ${x.dias === 1 ? 'día' : 'días'}`);

  async function descargarAdjSol(solId, a) {
    try {
      const res = await fetch(`/api/solicitudes/${solId}/archivos/${a.id}`, { headers: { Authorization: 'Bearer ' + S.token } });
      if (!res.ok) throw new Error('No se pudo descargar');
      const url = URL.createObjectURL(await res.blob());
      const l = document.createElement('a'); l.href = url; l.download = a.nombre_archivo; l.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) { toast(err.message, true); }
  }

  function nuevaSolicitud(tipoIni, tipos, onDone) {
    const otras = tipos.filter((t) => !['ADELANTO', 'VACACIONES', 'EXAMEN', 'ENFERMEDAD'].includes(t.codigo));
    const tipo0 = tipoIni === 'OTRAS' ? otras[0].codigo : tipoIni;
    const hoy = hoyISO();
    const m = modal(`<h2 id="ns-tit"></h2><form id="f-ns">
      <div class="f" id="ns-tipo-wrap"><label>Tipo de licencia</label><select name="tipo">${(tipoIni === 'OTRAS' ? otras : tipos).map((t) => `<option value="${t.codigo}" ${t.codigo === tipo0 ? 'selected' : ''}>${SOL_ICO[t.codigo] || ''} ${esc(t.nombre)}</option>`).join('')}</select></div>
      <div id="ns-fechas" class="row mt"><div class="f"><label>Desde *</label><input type="date" name="desde" value="${hoy}"></div><div class="f"><label>Hasta *</label><input type="date" name="hasta" value="${hoy}"></div>
        <div class="f s" style="flex-basis:120px"><label>Días</label><div class="ns-dias" id="ns-dias">1</div></div></div>
      <div id="ns-monto" class="f mt"><label>Monto que necesitás (opcional)</label><input type="text" name="monto" inputmode="decimal" placeholder="Ej.: 50000"></div>
      <div class="f mt"><label id="ns-mot-lbl">Comentario</label><textarea name="motivo" maxlength="1000"></textarea></div>
      <div class="f mt" id="ns-adj"><label id="ns-adj-lbl">Adjuntar certificado (opcional)</label><input type="file" name="archivo" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic"></div>
      <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Enviar solicitud</button></div></form>`);
    const f = $('#f-ns', m);
    const sync = () => {
      const t = f.tipo.value;
      const def = tipos.find((x) => x.codigo === t);
      $('#ns-tit', m).textContent = `${SOL_ICO[t] || ''} ${def.nombre}`;
      $('#ns-tipo-wrap', m).hidden = tipoIni !== 'OTRAS';
      $('#ns-fechas', m).hidden = !def.fechas;
      $('#ns-monto', m).hidden = !def.monto;
      $('#ns-adj', m).hidden = def.monto;
      $('#ns-adj-lbl', m).textContent = t === 'ENFERMEDAD' ? 'Certificado médico (podés subirlo ahora o después)' : t === 'EXAMEN' ? 'Constancia de examen (podés subirla ahora o después)' : 'Adjunto (opcional)';
      $('#ns-mot-lbl', m).textContent = t === 'ADELANTO' || t === 'OTRO' ? 'Motivo *' : t === 'EXAMEN' ? 'Materia / institución' : 'Comentario';
      const d = Date.parse(f.hasta.value) - Date.parse(f.desde.value);
      $('#ns-dias', m).textContent = Number.isNaN(d) || d < 0 ? '—' : String(Math.round(d / 86400e3) + 1);
    };
    f.tipo.addEventListener('change', sync);
    f.desde.addEventListener('change', () => { if (f.hasta.value < f.desde.value) f.hasta.value = f.desde.value; sync(); });
    f.hasta.addEventListener('change', sync);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = f.tipo.value;
      const file = f.archivo.files[0];
      if (file && file.size > 8 * 1024 * 1024) return toast('El archivo supera los 8 MB', true);
      try {
        const r = await api('/api/solicitudes', { method: 'POST', body: { tipo: t, desde: f.desde.value, hasta: f.hasta.value, monto: f.monto.value, motivo: f.motivo.value } });
        if (file && t !== 'ADELANTO') await api(`/api/solicitudes/${r.id}/archivos`, { method: 'POST', body: { nombre: file.name, data: await leerArchivo(file) } });
        closeModal(); toast('Solicitud enviada ✅'); history.replaceState(null, '', '#/mis-solicitudes'); onDone(); actualizarPill();
      } catch (err) { toast(err.message, true); }
    });
    sync();
  }

  VIEWS['mis-solicitudes'] = async (main) => {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const [tipos, d] = await Promise.all([api('/api/solicitudes/tipos'), api('/api/solicitudes')]);
    const r = d.resumen;
    main.innerHTML = `<h1>Mis solicitudes</h1><p class="sub">Pedí adelantos de sueldo, vacaciones y licencias. Te avisamos en el panel cuando te respondan.</p>
      <div class="sol-tipos">
        <button class="sol-tipo" data-nueva="ADELANTO"><span>💵</span>Adelanto de sueldo</button>
        <button class="sol-tipo" data-nueva="VACACIONES"><span>🏖️</span>Vacaciones</button>
        <button class="sol-tipo" data-nueva="EXAMEN"><span>📚</span>Día por examen</button>
        <button class="sol-tipo" data-nueva="ENFERMEDAD"><span>🤒</span>Enfermedad</button>
        <button class="sol-tipo" data-nueva="OTRAS"><span>📝</span>Otra licencia<small>matrimonio, mudanza, trámite…</small></button>
      </div>
      <div class="resumen mt" style="margin-top:18px">
        <a><span>Vacaciones ${new Date().getFullYear()}</span><b>${r.vacaciones}</b><small>días aprobados</small></a>
        <a><span>Licencias ${new Date().getFullYear()}</span><b>${r.licencias}</b><small>días aprobados</small></a>
        <a><span>Adelantos del mes</span><b>${fmt$(r.adelantos_mes)}</b><small>aprobados</small></a>
        <a><span>En espera</span><b>${r.pendientes}</b><small>sin respuesta</small></a></div>
      <h2 class="mt" style="margin-top:24px">Historial</h2>
      ${d.solicitudes.length ? `<div class="sol-lista">${d.solicitudes.map((x) => `
        <div class="sol-card est-${x.estado}"><div class="sol-ico">${SOL_ICO[x.tipo] || '📝'}</div>
          <div class="sol-body"><div><b>${esc(x.tipo_nombre)}</b> <span class="badge sol-${x.estado}">${SOL_EST[x.estado]}</span></div>
            <div class="muted">${periodoSol(x)} · pedida ${fmtFecha(x.creado_en)}</div>
            ${x.motivo ? `<div class="sol-mot">${esc(x.motivo)}</div>` : ''}
            ${x.respuesta ? `<div class="sol-resp">💬 ${esc(x.respuesta)}${x.resuelto_por_nombre ? ` — ${esc(x.resuelto_por_nombre)}` : ''}</div>` : ''}</div>
          <div class="sol-acc">${x.archivos ? `<span class="muted" title="Adjuntos">📎 ${x.archivos}</span>` : ''}
            ${x.tipo !== 'ADELANTO' && x.estado !== 'CANCELADA' ? `<label class="btn ghost sm" title="Adjuntar certificado">Adjuntar<input type="file" data-adj="${x.id}" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" hidden></label>` : ''}
            ${x.estado === 'PENDIENTE' ? `<button class="btn ghost sm" data-cancel="${x.id}">Cancelar</button>` : ''}</div></div>`).join('')}</div>`
        : '<div class="card empty">Todavía no hiciste ninguna solicitud.</div>'}`;
    const recargar = () => router();
    $$('[data-nueva]').forEach((b) => b.addEventListener('click', () => nuevaSolicitud(b.dataset.nueva, tipos, recargar)));
    $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('¿Cancelar esta solicitud?')) return;
      try { await api(`/api/solicitudes/${b.dataset.cancel}/cancelar`, { method: 'POST' }); toast('Solicitud cancelada'); recargar(); } catch (err) { toast(err.message, true); }
    }));
    $$('[data-adj]').forEach((inp) => inp.addEventListener('change', async () => {
      const file = inp.files[0]; if (!file) return;
      if (file.size > 8 * 1024 * 1024) return toast('El archivo supera los 8 MB', true);
      try { await api(`/api/solicitudes/${inp.dataset.adj}/archivos`, { method: 'POST', body: { nombre: file.name, data: await leerArchivo(file) } }); toast('Adjunto subido'); recargar(); }
      catch (err) { toast(err.message, true); }
    }));
    if (params.get('nueva')) nuevaSolicitud(params.get('nueva'), tipos, recargar);
  };

  VIEWS.solicitudes = async (main) => {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const [tipos, usuarios, aus] = await Promise.all([api('/api/solicitudes/tipos'), puede('usuarios') ? api('/api/usuarios') : Promise.resolve([]), api('/api/solicitudes-ausencias')]);
    main.innerHTML = `<h1>Solicitudes del personal</h1><p class="sub">Adelantos de sueldo, vacaciones y licencias pedidas por los empleados.</p>
      ${aus.length ? `<div class="card" style="background:#eaf2fa;border-color:#c9d6e3"><b>🗓️ Ausencias aprobadas (próximos 60 días)</b>
        <div class="aus-lista">${aus.map((a) => `<span class="aus"><b>${esc(a.empleado)}</b> ${SOL_ICO[a.tipo] || ''} ${esc(a.tipo_nombre)} · ${fmtDia(a.desde)}${a.hasta !== a.desde ? '–' + fmtDia(a.hasta) : ''}</span>`).join('')}</div></div>` : ''}
      <div class="toolbar">
        <div class="f"><label>Estado</label><select id="sg-e"><option value="PENDIENTE">Pendientes</option><option value="">Todas</option>${Object.entries(SOL_EST).filter(([k]) => k !== 'PENDIENTE').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="f"><label>Tipo</label><select id="sg-t"><option value="">Todos</option>${tipos.map((t) => `<option value="${t.codigo}">${esc(t.nombre)}</option>`).join('')}</select></div>
        ${usuarios.length ? `<div class="f"><label>Empleado</label><select id="sg-u"><option value="">Todos</option>${usuarios.filter((u) => u.rol !== 'PROVEEDOR').map((u) => `<option value="${u.id}">${esc(u.nombre)}</option>`).join('')}</select></div>` : ''}
        <div class="spacer"></div><button class="btn sec" id="sg-csv">Exportar CSV</button>
      </div><div id="sg-res" class="resumen" style="margin-bottom:12px"></div><div id="sg-tbl"></div>`;
    let lista = [];
    const cargar = async () => {
      const qs = new URLSearchParams({ todas: '1' });
      if ($('#sg-e').value) qs.set('estado', $('#sg-e').value);
      if ($('#sg-t').value) qs.set('tipo', $('#sg-t').value);
      if ($('#sg-u') && $('#sg-u').value) qs.set('usuario_id', $('#sg-u').value);
      const d = await api('/api/solicitudes?' + qs);
      lista = d.solicitudes;
      $('#sg-res').innerHTML = d.resumen ? `<a><span>Vacaciones ${new Date().getFullYear()}</span><b>${d.resumen.vacaciones}</b><small>días aprobados</small></a>
        <a><span>Licencias ${new Date().getFullYear()}</span><b>${d.resumen.licencias}</b><small>días aprobados</small></a><a><span>Adelantos del mes</span><b>${fmt$(d.resumen.adelantos_mes)}</b><small>aprobados</small></a>` : '';
      $('#sg-tbl').innerHTML = lista.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Empleado</th><th>Tipo</th><th>Período / monto</th><th>Estado</th><th>Pedida</th><th class="num">📎</th><th></th></tr></thead><tbody>
        ${lista.map((x) => `<tr><td>${x.id}</td><td><b>${esc(x.empleado)}</b></td><td>${SOL_ICO[x.tipo] || ''} ${esc(x.tipo_nombre)}</td><td>${periodoSol(x)}</td>
          <td><span class="badge sol-${x.estado}">${SOL_EST[x.estado]}</span></td><td class="muted">${fmtFecha(x.creado_en)}</td><td class="num">${x.archivos || ''}</td>
          <td class="num"><button class="btn ${x.estado === 'PENDIENTE' && x.usuario_id !== S.user.id ? '' : 'ghost'} sm" data-ver="${x.id}">${x.estado === 'PENDIENTE' && x.usuario_id !== S.user.id ? 'Responder' : 'Ver'}</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="card empty">No hay solicitudes para el filtro.</div>';
      $$('#sg-tbl [data-ver]').forEach((b) => b.addEventListener('click', () => verSolicitud(Number(b.dataset.ver), cargar)));
    };
    ['#sg-e', '#sg-t', '#sg-u'].forEach((sel) => { if ($(sel)) $(sel).addEventListener('change', () => cargar().catch((e) => toast(e.message, true))); });
    $('#sg-csv').onclick = () => descargarCSV(`solicitudes_${hoyISO()}.csv`, [
      ['Id', 'Empleado', 'Tipo', 'Desde', 'Hasta', 'Dias', 'Monto', 'Monto aprobado', 'Estado', 'Motivo', 'Respuesta', 'Pedida', 'Resuelta por'],
      ...lista.map((x) => [x.id, x.empleado, x.tipo_nombre, x.desde || '', x.hasta || '', x.dias ?? '', x.monto ?? '', x.monto_aprobado ?? '', SOL_EST[x.estado], x.motivo || '', x.respuesta || '', fmtFecha(x.creado_en), x.resuelto_por_nombre || '']),
    ]);
    await cargar();
    if (params.get('id')) verSolicitud(Number(params.get('id')), cargar);
  };

  async function verSolicitud(id, onDone) {
    let x;
    try { x = await api('/api/solicitudes/' + id); } catch (err) { return toast(err.message, true); }
    const responder = x.estado === 'PENDIENTE' && x.usuario_id !== S.user.id && puede('gestionarSolicitudes');
    const m = modal(`<h2>${SOL_ICO[x.tipo] || ''} ${esc(x.tipo_nombre)} · ${esc(x.empleado)}</h2>
      <p><span class="badge sol-${x.estado}">${SOL_EST[x.estado]}</span> <b>${periodoSol(x)}</b></p>
      <p class="muted">Pedida ${fmtFecha(x.creado_en)}${x.resuelto_en && x.estado !== 'CANCELADA' ? ` · Resuelta por ${esc(x.resuelto_por_nombre || '')} ${fmtFecha(x.resuelto_en)}` : ''}</p>
      ${x.motivo ? `<p class="obs">📝 ${esc(x.motivo)}</p>` : ''}${x.respuesta ? `<p class="obs">💬 ${esc(x.respuesta)}</p>` : ''}
      ${x.adjuntos.length ? `<p><b>Adjuntos:</b> ${x.adjuntos.map((a) => `<button class="btn ghost sm" data-dl="${a.id}">📎 ${esc(a.nombre_archivo)}</button>`).join(' ')}</p>`
        : (['ENFERMEDAD', 'EXAMEN'].includes(x.tipo) ? '<p class="stock-hint">Todavía no adjuntó el certificado.</p>' : '')}
      ${x.superpuestas && x.superpuestas.length ? `<div class="card" style="background:#fdf3e1;border-color:#f2d9a6"><b>⚠️ Se superpone con:</b><ul style="margin:6px 0 0 18px;padding:0">
        ${x.superpuestas.map((o) => `<li>${esc(o.empleado)} · ${esc(o.tipo_nombre)} ${fmtDia(o.desde)}–${fmtDia(o.hasta)} (${SOL_EST[o.estado].toLowerCase()})</li>`).join('')}</ul></div>` : ''}
      ${responder ? `<div class="card mt" style="margin-bottom:0">
        ${x.tipo === 'ADELANTO' ? `<div class="f"><label>Monto a aprobar${x.monto !== null ? ` (pedido ${fmt$(x.monto)})` : ''}</label><input type="text" inputmode="decimal" id="rs-monto" value="${x.monto ?? ''}"></div>` : ''}
        <div class="f mt"><label>Respuesta para el empleado (obligatoria si rechazás)</label><textarea id="rs-resp" maxlength="1000"></textarea></div></div>` : ''}
      <div class="form-actions"><button class="btn sec" data-close>Cerrar</button>
        ${responder ? '<button class="btn danger" id="rs-no">Rechazar</button><button class="btn ok" id="rs-si">Aprobar</button>' : ''}</div>`, { wide: true });
    $$('[data-dl]', m).forEach((b) => b.addEventListener('click', () => descargarAdjSol(x.id, x.adjuntos.find((a) => a.id == b.dataset.dl))));
    const resolver = async (decision) => {
      try {
        const r = await api(`/api/solicitudes/${id}/resolver`, { method: 'POST', body: { decision, respuesta: $('#rs-resp', m).value, monto_aprobado: $('#rs-monto', m) ? $('#rs-monto', m).value : undefined } });
        closeModal(); toast(decision === 'APROBAR' ? `Solicitud aprobada${r.programacion_quitada ? ` · se ${r.programacion_quitada === 1 ? 'quitó 1 día' : `quitaron ${r.programacion_quitada} días`} de la programación` : ''}` : 'Solicitud rechazada'); onDone(); actualizarPill();
      } catch (err) { toast(err.message, true); }
    };
    if ($('#rs-si', m)) $('#rs-si', m).onclick = () => resolver('APROBAR');
    if ($('#rs-no', m)) $('#rs-no', m).onclick = () => resolver('RECHAZAR');
  }


  // ---------- Horas del personal (CrossChex) ----------
  const hm = (min) => `${Math.floor((min || 0) / 60)}:${String((min || 0) % 60).padStart(2, '0')}`;
  const DIAS_SEM = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const diaSem = (f) => DIAS_SEM[new Date(f + 'T12:00:00').getDay()];
  const isoLocal = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
  function presetsPeriodo() {
    const hoy = new Date(); const y = hoy.getFullYear(), m = hoy.getMonth(), d = hoy.getDate();
    const lunes = new Date(hoy); lunes.setDate(d - ((hoy.getDay() + 6) % 7));
    return {
      semana: [isoLocal(lunes), isoLocal(hoy)],
      quincena: d <= 15 ? [isoLocal(new Date(y, m, 1)), isoLocal(hoy)] : [isoLocal(new Date(y, m, 16)), isoLocal(hoy)],
      mes: [isoLocal(new Date(y, m, 1)), isoLocal(hoy)],
      mesAnt: [isoLocal(new Date(y, m - 1, 1)), isoLocal(new Date(y, m, 0))],
    };
  }
  function tablaDias(dias) {
    return `<table class="dias-tbl"><thead><tr><th>Jornada</th><th>Fichadas</th><th>Tramos</th><th class="num">Horas</th></tr></thead><tbody>
      ${dias.map((d) => `<tr class="${d.incompleta ? 'inc' : ''}"><td><b>${diaSem(d.fecha)}</b> ${fmtDia(d.fecha)}</td><td class="code">${d.marcas.join(' · ')}</td>
        <td>${d.tramos.map((t) => `${t.entrada}–${t.salida || '<b class="bad">sin salida</b>'}`).join(', ')}</td>
        <td class="num">${hm(d.minutos)}${d.incompleta ? ' <span class="badge b-PENDIENTE">incompleta</span>' : ''}</td></tr>`).join('')}</tbody></table>`;
  }

  // ---------- Programación de días de trabajo ----------
  const addDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); };
  const lunesDe = (iso) => { const d = new Date(iso + 'T12:00:00'); return addDias(iso, -((d.getDay() + 6) % 7)); };
  const DIAS_LV = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mié'], ['4', 'Jue'], ['5', 'Vie'], ['6', 'Sáb'], ['0', 'Dom']];
  const horario = (t) => (t.hora_desde ? `${t.hora_desde}–${t.hora_hasta}` : 'Sin horario');
  const minTurno = (t) => { if (!t.hora_desde) return 0; const [a, b] = t.hora_desde.split(':').map(Number); const [c, d] = t.hora_hasta.split(':').map(Number); let m = c * 60 + d - (a * 60 + b); if (m <= 0) m += 1440; return m; };
  const fechasEntre = (d, h, dias) => { const out = []; for (let f = d; f <= h && out.length < 400; f = addDias(f, 1)) if (dias.includes(String(new Date(f + 'T12:00:00').getDay()))) out.push(f); return out; };

  VIEWS.programacion = async (main) => {
    const hoy = hoyISO();
    const sucs = (await api('/api/sucursales'));
    const activas = sucs.filter((s) => s.activo);
    const st = VIEWS.programacion._st || (VIEWS.programacion._st = { lunes: lunesDe(hoy), suc: '' });
    const ultHorario = VIEWS.programacion._h || (VIEWS.programacion._h = {});
    main.innerHTML = `<h1>Programación</h1><p class="sub">Días y horarios que trabaja cada empleado en cada sucursal. Tocá un día para programarlo o cambiarlo.</p>
      <div class="toolbar">
        <div class="f"><label>Sucursal</label><select id="pg-suc"><option value="">Todas</option>${activas.map((s) => `<option value="${s.id}" ${String(s.id) === String(st.suc) ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:2px"><button class="btn ghost sm" id="pg-prev" title="Semana anterior">◀</button>
          <b id="pg-tit" style="min-width:190px;text-align:center"></b><button class="btn ghost sm" id="pg-next" title="Semana siguiente">▶</button>
          <button class="btn ghost sm" id="pg-hoy">Hoy</button></div>
        <div class="spacer"></div>
        <button class="btn sec" id="pg-copiar" title="Copia lo programado la semana anterior a esta semana (sin eventos)">Copiar semana ant.</button>
        <button class="btn sec" id="pg-evento">🎉 Nuevo evento</button>
        <button class="btn" id="pg-varios">Programar varios días</button>
      </div>
      <div class="pg-leyenda">${activas.map((s) => `<span><i style="background:${sucColor(s.id, sucs)}"></i>${esc(s.nombre)}</span>`).join('')}<span><i class="lg-lic"></i>Vacaciones / licencia aprobada</span><span><i class="lg-pend"></i>Pedida, sin aprobar</span></div>
      <div id="pg-tbl"><p class="muted">Cargando…</p></div>`;
    let data = null;
    const cargar = async () => {
      const dias = [...Array(7)].map((_, i) => addDias(st.lunes, i));
      $('#pg-tit').textContent = `${fmtDia(dias[0]).slice(0, 5)} al ${fmtDia(dias[6])}`;
      data = await api(`/api/programacion?desde=${dias[0]}&hasta=${dias[6]}${st.suc ? '&sucursal_id=' + st.suc : ''}`);
      if (!data.empleados.length) {
        $('#pg-tbl').innerHTML = `<div class="card empty" style="padding:32px"><div style="font-size:2rem">🗓️</div><b>No hay empleados asignados${st.suc ? ' a esta sucursal' : ' a sucursales'}.</b><br>
          Asignalos en ${puede('sucursales') ? '<a href="#/sucursales">Sucursales</a>' : 'Sucursales'}${puede('usuarios') ? ' o en <a href="#/usuarios">Usuarios</a>' : ''}.</div>`;
        return;
      }
      const porCelda = new Map();
      for (const t of data.turnos) { const k = t.usuario_id + '|' + t.fecha; if (!porCelda.has(k)) porCelda.set(k, []); porCelda.get(k).push(t); }
      const licDe = (u, f) => { const ls = data.licencias.filter((l) => l.usuario_id === u && l.desde <= f && l.hasta >= f); return ls.find((l) => l.estado === 'APROBADA') || ls[0]; };
      const sucsEmp = (e) => e.sucursales.filter((id) => activas.some((s) => s.id === id) && (!st.suc || String(id) === String(st.suc)));
      const filas = data.empleados.map((e) => {
        let dTot = 0, mTot = 0, dLic = 0;
        const celdas = dias.map((f) => {
          const ts = porCelda.get(e.id + '|' + f) || [];
          if (ts.length) dTot++; ts.forEach((t) => { mTot += minTurno(t); });
          const lic = licDe(e.id, f);
          if (lic && lic.estado === 'APROBADA') dLic++;
          const libres = lic && lic.estado === 'APROBADA' ? [] : sucsEmp(e).filter((id) => !ts.some((t) => t.sucursal_id === id));
          return `<td class="pg-cel ${f === hoy ? 'hoy' : ''} ${f < hoy ? 'pasado' : ''} ${lic && lic.estado === 'APROBADA' ? 'lic' : ''}">${lic ? `<div class="pg-lic ${lic.estado === 'APROBADA' ? '' : 'pend'}" title="${esc(lic.tipo_nombre)} del ${fmtDia(lic.desde)} al ${fmtDia(lic.hasta)}${lic.estado === 'APROBADA' ? '' : ' · pendiente de aprobación'}">${SOL_ICO[lic.tipo] || '📝'} ${esc(lic.tipo_nombre)}${lic.estado === 'APROBADA' ? '' : '<small>pendiente</small>'}</div>` : ''}${ts.map((t) => `<button class="pg-chip" style="--c:${sucColor(t.sucursal_id, sucs)}" data-t="${t.id}" title="${esc(t.sucursal)}${t.evento ? ' · Evento: ' + esc(t.evento) : ''}${t.nota ? ' · ' + esc(t.nota) : ''}"><b>${esc(sucCorto(t.sucursal))}</b><span>${horario(t)}</span>${t.evento ? `<em>🎉 ${esc(t.evento)}</em>` : ''}</button>`).join('')}
            ${libres.length ? `<button class="pg-add" data-u="${e.id}" data-f="${f}" title="Programar">${ts.length ? '+' : '<span>+</span>'}</button>` : ''}</td>`;
        }).join('');
        return `<tr><th class="pg-emp"><b>${esc(e.nombre)}</b><small>${esc(e.rol_nombre)} · ${e.sucursales.map((id) => esc(sucCorto((sucs.find((s) => s.id === id) || {}).nombre))).join(', ') || 'sin sucursal'}</small></th>${celdas}
          <td class="num pg-tot"><b>${dTot}</b> ${dTot === 1 ? 'día' : 'días'}${mTot ? `<small>${hm(mTot)} h</small>` : ''}${dLic ? `<small class="pg-tot-lic">${dLic} de licencia</small>` : ''}</td></tr>`;
      }).join('');
      const pie = dias.map((f) => {
        const ts = data.turnos.filter((t) => t.fecha === f);
        const cnt = activas.map((s) => [s, ts.filter((t) => t.sucursal_id === s.id).length]).filter(([, n]) => n);
        const nl = new Set(data.licencias.filter((l) => l.estado === 'APROBADA' && l.desde <= f && l.hasta >= f && data.empleados.some((e) => e.id === l.usuario_id)).map((l) => l.usuario_id)).size;
        return `<td class="pg-pie">${cnt.map(([s, n]) => `<span style="color:${sucColor(s.id, sucs)}">${esc(sucCorto(s.nombre))} <b>${n}</b></span>`).join('') || '<span class="muted">—</span>'}${nl ? `<span class="pg-pie-lic">🏖️ ${nl} de licencia</span>` : ''}</td>`;
      }).join('');
      const filaEv = `<tr class="pg-evrow"><th class="pg-emp"><b>🎉 Eventos</b><small>Tocá + para crear uno</small></th>${dias.map((f) => `<td class="pg-cel ${f === hoy ? 'hoy' : ''}">
        ${data.eventos.filter((e) => e.fecha === f).map((e) => `<button class="pg-ev" style="--c:${sucColor(e.sucursal_id, sucs)}" data-ev="${e.id}" title="${esc(e.sucursal)}${e.descripcion ? ' · ' + esc(e.descripcion) : ''}">
          <b>${esc(e.nombre)}</b><span>${esc(sucCorto(e.sucursal))}${e.hora_desde ? ' · ' + horario(e) : ''}</span><small>👥 ${e.personal.length} ${e.personal.length === 1 ? 'persona' : 'personas'}</small></button>`).join('')}
        ${f >= hoy ? `<button class="pg-add pg-add-ev" data-evf="${f}" title="Nuevo evento">+</button>` : ''}</td>`).join('')}<td></td></tr>`;
      $('#pg-tbl').innerHTML = `<div class="tbl-wrap"><table class="pg-tabla"><thead><tr><th>Empleado</th>${dias.map((f) => `<th class="${f === hoy ? 'hoy' : ''}">${diaSem(f)}<small>${fmtDia(f).slice(0, 5)}</small></th>`).join('')}<th class="num">Semana</th></tr></thead>
        <tbody>${filaEv}${filas}</tbody><tfoot><tr><th>Personas por día</th>${pie}<td></td></tr></tfoot></table></div>
        <p class="stock-hint mt">Un día sin programar es franco. Los turnos que pasan la medianoche (ej. 20:00–04:00) se cargan en el día en que empiezan.</p>`;
      $$('.pg-ev').forEach((b) => b.addEventListener('click', () => editarEvento(data.eventos.find((e) => e.id == b.dataset.ev))));
      $$('.pg-add-ev').forEach((b) => b.addEventListener('click', () => editarEvento(null, b.dataset.evf)));
      $$('.pg-add:not(.pg-add-ev)').forEach((b) => b.addEventListener('click', () => editarDia(data.empleados.find((e) => e.id == b.dataset.u), b.dataset.f, null)));
      $$('.pg-chip').forEach((b) => b.addEventListener('click', () => { const t = data.turnos.find((x) => x.id == b.dataset.t); editarDia(data.empleados.find((e) => e.id === t.usuario_id), t.fecha, t); }));
    };
    const opcSuc = (ids, sel) => ids.map((id) => sucs.find((s) => s.id === id)).filter((s) => s && (s.activo || s.id === sel))
      .map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('');
    const editarDia = (e, f, t) => {
      const ocupadas = data.turnos.filter((x) => x.usuario_id === e.id && x.fecha === f && (!t || x.id !== t.id)).map((x) => x.sucursal_id);
      const ids = e.sucursales.filter((id) => !ocupadas.includes(id) && (!st.suc || !t ? (!st.suc || String(id) === String(st.suc)) : true));
      const sel = t ? t.sucursal_id : ids[0];
      const h = t || ultHorario[sel] || {};
      const lp = data.licencias.find((l) => l.usuario_id === e.id && l.desde <= f && l.hasta >= f);
      const m = modal(`<h2>${esc(e.nombre)}</h2><p class="sub" style="margin-top:-6px">${diaSem(f)} ${fmtDia(f)}</p>
        ${lp ? `<div class="tip-lic">${SOL_ICO[lp.tipo] || '📝'} Pidió <b>${esc(lp.tipo_nombre.toLowerCase())}</b> del ${fmtDia(lp.desde)} al ${fmtDia(lp.hasta)}${lp.estado === 'APROBADA' ? ' (aprobada)' : ', todavía sin aprobar'}. Si se aprueba, este día se quita de la programación.</div>` : ''}<form id="f-pg">
        <div class="f"><label>Sucursal</label><select name="sucursal_id">${opcSuc(t ? [...new Set([t.sucursal_id, ...e.sucursales.filter((id) => !ocupadas.includes(id))])] : ids, sel)}</select></div>
        <div class="row mt"><div class="f"><label>Entra</label><input type="time" name="hora_desde" value="${esc(h.hora_desde || '')}"></div>
          <div class="f"><label>Sale</label><input type="time" name="hora_hasta" value="${esc(h.hora_hasta || '')}"></div></div>
        <div class="stock-hint">Podés dejar el horario vacío si todavía no está definido.</div>
        <div class="f mt"><label>Nota</label><input name="nota" maxlength="200" value="${esc(t && t.nota ? t.nota : '')}" placeholder="Ej.: apertura, evento, cubre a…"></div>
        <div class="form-actions">${t ? '<button type="button" class="btn ghost" id="pg-del" style="margin-right:auto;color:var(--accent)">Quitar este día</button>' : ''}
          <button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`);
      const fm = $('#f-pg', m);
      fm.sucursal_id.addEventListener('change', () => { if (!t) { const u = ultHorario[fm.sucursal_id.value]; if (u) { fm.hora_desde.value = u.hora_desde || ''; fm.hora_hasta.value = u.hora_hasta || ''; } } });
      fm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const body = { sucursal_id: Number(fm.sucursal_id.value), hora_desde: fm.hora_desde.value, hora_hasta: fm.hora_hasta.value, nota: fm.nota.value };
        try {
          if (t) await api('/api/programacion/' + t.id, { method: 'PUT', body });
          else await api('/api/programacion', { method: 'POST', body: { ...body, usuario_ids: [e.id], fechas: [f] } });
          ultHorario[body.sucursal_id] = { hora_desde: body.hora_desde, hora_hasta: body.hora_hasta };
          closeModal(); toast('Día programado'); cargar();
        } catch (err) { toast(err.message, true); }
      });
      if (t) $('#pg-del', m).addEventListener('click', async () => {
        try { await api('/api/programacion/' + t.id, { method: 'DELETE' }); closeModal(); toast('Día quitado'); cargar(); } catch (err) { toast(err.message, true); }
      });
    };
    const editarEvento = (ev, fecha) => {
      const sucIni = ev ? ev.sucursal_id : (st.suc ? Number(st.suc) : (activas[0] || {}).id);
      const marcados = new Set(ev ? ev.personal : []);
      const m = modal(`<h2>${ev ? 'Editar evento' : '🎉 Nuevo evento'}</h2><form id="f-ev">
        <div class="row"><div class="f" style="flex:2"><label>Nombre del evento *</label><input name="nombre" required maxlength="120" value="${esc(ev ? ev.nombre : '')}" placeholder="Ej.: Fiesta de fin de año, show en vivo, cumpleaños privado"></div>
          <div class="f"><label>Fecha *</label><input type="date" name="fecha" required value="${ev ? ev.fecha : fecha || st.lunes}"></div></div>
        <div class="row mt"><div class="f"><label>Sucursal *</label><select name="sucursal_id">${sucs.filter((s) => s.activo || (ev && s.id === ev.sucursal_id)).map((s) => `<option value="${s.id}" ${s.id === sucIni ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></div>
          <div class="f"><label>Empieza</label><input type="time" name="hora_desde" value="${esc(ev && ev.hora_desde ? ev.hora_desde : '')}"></div>
          <div class="f"><label>Termina</label><input type="time" name="hora_hasta" value="${esc(ev && ev.hora_hasta ? ev.hora_hasta : '')}"></div></div>
        <div class="row mt"><div class="f"><label>Entrada del personal</label><input type="time" name="personal_desde" value="${esc(ev && ev.personal_desde && ev.personal_desde !== ev.hora_desde ? ev.personal_desde : '')}"></div>
          <div class="f"><label>Salida del personal</label><input type="time" name="personal_hasta" value="${esc(ev && ev.personal_hasta && ev.personal_hasta !== ev.hora_hasta ? ev.personal_hasta : '')}"></div>
          <div class="f" style="flex:2"><p class="stock-hint" style="margin:24px 0 0">Si el personal entra antes o sale después del evento. Vacío = mismo horario que el evento.</p></div></div>
        <div class="f mt"><label>Descripción</label><textarea name="descripcion" maxlength="500" rows="2" placeholder="Cantidad de invitados, menú, contacto…">${esc(ev && ev.descripcion ? ev.descripcion : '')}</textarea></div>
        <div class="f mt"><label>Personal del evento <a href="#" id="ev-todos" style="font-weight:400">(marcar todos)</a></label><div class="chk-grupo chk-lista" id="ev-emp"></div>
          <div class="stock-hint">Quedan programados ese día en la sucursal del evento. Si ya tenían un turno ahí, se reemplaza por el del evento.</div></div>
        <div class="form-actions">${ev ? '<button type="button" class="btn ghost" id="ev-del" style="margin-right:auto;color:var(--accent)">Eliminar evento</button>' : ''}
          <button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar evento</button></div></form>`, { wide: true });
      const fm = $('#f-ev', m);
      const pintar = async () => {
        $$('input[name=emp]:checked', fm).forEach((c) => marcados.add(Number(c.value)));
        $$('input[name=emp]:not(:checked)', fm).forEach((c) => marcados.delete(Number(c.value)));
        const s = Number(fm.sucursal_id.value), f = fm.fecha.value;
        let ocup = data.turnos, licsF = data.licencias;
        if (f && (f < data.desde || f > data.hasta)) { try { const r = await api(`/api/programacion?desde=${f}&hasta=${f}`); ocup = r.turnos; licsF = r.licencias; } catch (_) { ocup = []; licsF = []; } }
        const lista = data.empleados.filter((e) => e.sucursales.includes(s));
        $('#ev-emp', m).innerHTML = lista.map((e) => {
          const otros = ocup.filter((t) => t.usuario_id === e.id && t.fecha === f && (!ev || t.evento_id !== ev.id));
          const lic = licsF.find((l) => l.usuario_id === e.id && l.estado === 'APROBADA' && l.desde <= f && l.hasta >= f);
          if (lic) return `<label class="check" style="opacity:.6"><input type="checkbox" disabled> ${esc(e.nombre)} <span class="muted" style="font-size:.8rem">· ${SOL_ICO[lic.tipo] || ''} ${esc(lic.tipo_nombre.toLowerCase())}</span></label>`;
          return `<label class="check"><input type="checkbox" name="emp" value="${e.id}" ${marcados.has(e.id) ? 'checked' : ''}> ${esc(e.nombre)}
            ${otros.length ? `<span class="muted" style="font-size:.8rem">· ya programado: ${otros.map((t) => `${esc(sucCorto(t.sucursal))} ${horario(t)}`).join(', ')}</span>` : ''}</label>`;
        }).join('') || '<span class="muted">Nadie asignado a esta sucursal.</span>';
      };
      fm.sucursal_id.addEventListener('change', pintar); fm.fecha.addEventListener('change', pintar);
      $('#ev-todos', m).addEventListener('click', (e) => { e.preventDefault(); const cs = $$('input[name=emp]', fm); const all = cs.every((c) => c.checked); cs.forEach((c) => { c.checked = !all; }); });
      pintar();
      fm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { nombre: fm.nombre.value, fecha: fm.fecha.value, sucursal_id: Number(fm.sucursal_id.value), hora_desde: fm.hora_desde.value, hora_hasta: fm.hora_hasta.value,
          personal_desde: fm.personal_desde.value, personal_hasta: fm.personal_hasta.value, descripcion: fm.descripcion.value,
          empleados: $$('input[name=emp]:checked', fm).map((c) => Number(c.value)) };
        try {
          const r = await api(ev ? '/api/eventos/' + ev.id : '/api/eventos', { method: ev ? 'PUT' : 'POST', body });
          closeModal(); toast(`Evento guardado · ${r.personal} ${r.personal === 1 ? 'persona programada' : 'personas programadas'}`);
          if (body.fecha < st.lunes || body.fecha > addDias(st.lunes, 6)) st.lunes = lunesDe(body.fecha);
          cargar();
        } catch (err) { toast(err.message, true); }
      });
      if (ev) $('#ev-del', m).addEventListener('click', async () => {
        if (!confirm(`¿Eliminar el evento "${ev.nombre}"? También se quitan los días programados de su personal.`)) return;
        try { await api('/api/eventos/' + ev.id, { method: 'DELETE' }); closeModal(); toast('Evento eliminado'); cargar(); } catch (err) { toast(err.message, true); }
      });
    };
    const varios = () => {
      const sucIni = st.suc ? Number(st.suc) : (activas[0] || {}).id;
      const m = modal(`<h2>Programar varios días</h2><form id="f-pv">
        <div class="seg" id="pv-acc"><label><input type="radio" name="acc" value="prog" checked> Programar</label><label><input type="radio" name="acc" value="quitar"> Quitar días</label></div>
        <div class="row mt"><div class="f" id="pv-suc-w"><label>Sucursal</label><select name="sucursal_id">${activas.map((s) => `<option value="${s.id}" ${s.id === sucIni ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></div>
          <div class="f"><label>Desde</label><input type="date" name="desde" value="${st.lunes}"></div><div class="f"><label>Hasta</label><input type="date" name="hasta" value="${addDias(st.lunes, 6)}"></div></div>
        <div class="f mt"><label>Días de la semana</label><div class="dias-sel">${DIAS_LV.map(([v, n]) => `<label><input type="checkbox" name="dia" value="${v}" checked><span>${n}</span></label>`).join('')}</div></div>
        <div class="row mt" id="pv-hor"><div class="f"><label>Entra</label><input type="time" name="hora_desde"></div><div class="f"><label>Sale</label><input type="time" name="hora_hasta"></div>
          <div class="f" style="flex:2"><label>Nota</label><input name="nota" maxlength="200"></div></div>
        <div class="f mt"><label>Empleados <a href="#" id="pv-todos" style="font-weight:400">(marcar todos)</a></label><div class="chk-grupo chk-lista" id="pv-emp"></div></div>
        <label class="check mt" id="pv-reem"><input type="checkbox" name="reemplazar"> Si ese día ya estaba programado en otra sucursal, reemplazarlo</label>
        <div class="card mt" id="pv-res" style="background:#eaf2fa;border-color:#c9d6e3"></div>
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn" id="pv-ok">Programar</button></div></form>`, { wide: true });
      const fm = $('#f-pv', m);
      const acc = () => fm.acc.value;
      const pintarEmp = () => {
        const s = Number(fm.sucursal_id.value);
        const lista = data.empleados.filter((e) => e.sucursales.includes(s));
        const marcados = new Set($$('input[name=emp]:checked', fm).map((c) => Number(c.value)));
        $('#pv-emp', m).innerHTML = lista.map((e) => `<label class="check"><input type="checkbox" name="emp" value="${e.id}" ${marcados.has(e.id) ? 'checked' : ''}> ${esc(e.nombre)}</label>`).join('') || '<span class="muted">Nadie asignado a esta sucursal.</span>';
        $$('input[name=emp]', fm).forEach((c) => c.addEventListener('change', resumen));
      };
      const fechas = () => fechasEntre(fm.desde.value, fm.hasta.value, $$('input[name=dia]:checked', fm).map((c) => c.value));
      const resumen = () => {
        const n = fechas().length, e = $$('input[name=emp]:checked', fm).length;
        const q = acc() === 'quitar';
        $('#pv-hor', m).hidden = q; $('#pv-reem', m).hidden = q;
        $('#pv-ok', m).textContent = q ? 'Quitar días' : 'Programar';
        $('#pv-res', m).innerHTML = !fm.desde.value || !fm.hasta.value || fm.hasta.value < fm.desde.value ? 'Revisá las fechas.'
          : `${q ? 'Se quitan' : 'Se programan'} <b>${n}</b> ${n === 1 ? 'día' : 'días'} para <b>${e}</b> ${e === 1 ? 'empleado' : 'empleados'}${q ? ' en la sucursal elegida' : ''}${n && e ? ` (${n * e} en total)` : ''}.`;
      };
      fm.sucursal_id.addEventListener('change', () => { pintarEmp(); resumen(); });
      [fm.desde, fm.hasta].forEach((i) => i.addEventListener('change', resumen));
      $$('input[name=dia], input[name=acc]', fm).forEach((c) => c.addEventListener('change', resumen));
      $('#pv-todos', m).addEventListener('click', (ev) => { ev.preventDefault(); const cs = $$('input[name=emp]', fm); const all = cs.every((c) => c.checked); cs.forEach((c) => { c.checked = !all; }); resumen(); });
      pintarEmp(); resumen();
      fm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fs = fechas(); const emp = $$('input[name=emp]:checked', fm).map((c) => Number(c.value));
        if (!emp.length) return toast('Elegí al menos un empleado', true);
        if (!fs.length) return toast('No hay días en ese rango con los días de la semana elegidos', true);
        try {
          if (acc() === 'quitar') {
            const r = await api('/api/programacion/quitar', { method: 'POST', body: { usuario_ids: emp, fechas: fs, sucursal_id: Number(fm.sucursal_id.value) } });
            toast(`${r.quitados} ${r.quitados === 1 ? 'día quitado' : 'días quitados'}`);
          } else {
            const r = await api('/api/programacion', { method: 'POST', body: { usuario_ids: emp, fechas: fs, sucursal_id: Number(fm.sucursal_id.value),
              hora_desde: fm.hora_desde.value, hora_hasta: fm.hora_hasta.value, nota: fm.nota.value, reemplazar: fm.reemplazar.checked } });
            toast(`Listo: ${r.creados} nuevos${r.actualizados ? `, ${r.actualizados} actualizados` : ''}${r.quitados ? `, ${r.quitados} reemplazados` : ''}${r.omitidos ? ` · ${r.omitidos} ${r.omitidos === 1 ? 'día salteado' : 'días salteados'} por vacaciones o licencia` : ''}`);
          }
          closeModal(); cargar();
        } catch (err) { toast(err.message, true); }
      });
    };
    $('#pg-suc').addEventListener('change', (e) => { st.suc = e.target.value; cargar(); });
    $('#pg-prev').addEventListener('click', () => { st.lunes = addDias(st.lunes, -7); cargar(); });
    $('#pg-next').addEventListener('click', () => { st.lunes = addDias(st.lunes, 7); cargar(); });
    $('#pg-hoy').addEventListener('click', () => { st.lunes = lunesDe(hoy); cargar(); });
    $('#pg-evento').addEventListener('click', () => { if (!activas.length) return toast('Primero cargá una sucursal', true); editarEvento(null, hoy > st.lunes && hoy <= addDias(st.lunes, 6) ? hoy : st.lunes); });
    $('#pg-varios').addEventListener('click', () => { if (!activas.length) return toast('Primero cargá una sucursal', true); varios(); });
    $('#pg-copiar').addEventListener('click', async () => {
      if (!confirm(`¿Copiar lo programado la semana anterior a la semana del ${fmtDia(st.lunes)}${st.suc ? ' (solo esta sucursal)' : ''}? Los días que ya estén programados no se tocan.`)) return;
      try { const r = await api('/api/programacion/copiar-semana', { method: 'POST', body: { desde: st.lunes, sucursal_id: st.suc ? Number(st.suc) : null } }); toast(r.copiados ? `${r.copiados} días copiados` : 'No había nada nuevo para copiar'); cargar(); }
      catch (err) { toast(err.message, true); }
    });
    await cargar();
  };

  // Pronóstico de la noche (18 a 3 h) en el panel
  async function climaNoche(cont) {
    if (!cont) return;
    try {
      const c = await api('/api/clima');
      if (!document.body.contains(cont)) return;
      if (c.error_clima) { cont.innerHTML = `<div class="clima clima-err">🌡️ ${esc(c.error_clima)}</div>`; return; }
      const r = c.resumen;
      const hoyN = c.noche === hoyISO();
      cont.innerHTML = `<section class="clima">
        <div class="clima-res">
          <div class="clima-ico">${r.icono}</div>
          <div><small>${esc(c.ciudad)} · ${hoyN ? 'Esta noche' : 'Noche del ' + fmtDia(c.noche).slice(0, 5)} · ${c.desde} a ${c.hasta} h</small>
            <b>${r.temp_min}° a ${r.temp_max}°</b><span>${esc(r.texto)} · 💧 ${r.lluvia_prob_max ?? 0}%${r.lluvia_mm ? ` (${String(r.lluvia_mm).replace('.', ',')} mm)` : ''} · 💨 ${r.viento_max} km/h${r.rafagas_max >= 35 ? `, ráfagas ${r.rafagas_max}` : ''}</span>
            ${c.avisos.length ? `<div class="clima-av">${c.avisos.map((a) => `<em>⚠️ ${esc(a)}</em>`).join('')}</div>` : ''}</div></div>
        <div class="clima-horas">${c.horas.map((h) => `<div class="${(h.lluvia_prob || 0) >= 50 ? 'llueve' : ''}" title="${esc(h.texto)} · sensación ${h.sensacion}° · viento ${h.viento} km/h"><span>${h.hora.slice(0, 2)} h</span><i>${h.icono}</i><b>${h.temp}°</b><small>💧${h.lluvia_prob ?? 0}%</small></div>`).join('')}</div>
        <p class="clima-src">Pronóstico ${esc(c.fuente)}${c.desactualizado ? ' (sin conexión, último dato disponible)' : ''}</p></section>`;
    } catch (_) { cont.innerHTML = ''; }
  }

  // Calendario de hoy y mañana (panel de quien programa): eventos y personal por sucursal
  async function calendarioHoyManiana(cont) {
    try {
      const hoy = hoyISO(), man = addDias(hoy, 1);
      const [d, sucs] = await Promise.all([api(`/api/programacion?desde=${hoy}&hasta=${man}`), api('/api/sucursales')]);
      if (!document.body.contains(cont)) return;
      const nom = new Map(d.empleados.map((e) => [e.id, e.nombre]));
      const dia = (f, titulo) => {
        const evs = d.eventos.filter((e) => e.fecha === f);
        const ts = d.turnos.filter((t) => t.fecha === f);
        const porSuc = sucs.map((s) => [s, ts.filter((t) => t.sucursal_id === s.id).sort((a, b) => String(a.hora_desde || '99').localeCompare(String(b.hora_desde || '99')))]).filter(([, l]) => l.length);
        const lics = [...new Map(d.licencias.filter((l) => l.estado === 'APROBADA' && l.desde <= f && l.hasta >= f).map((l) => [l.usuario_id, l])).values()];
        const licHtml = lics.length ? `<div class="cal-lic">🏖️ <b>De licencia:</b> ${lics.map((l) => `${esc(nom.get(l.usuario_id) || 'Empleado')} <span class="muted">(${esc(l.tipo_nombre.toLowerCase())})</span>`).join(', ')}</div>` : '';
        return `<div class="cal-dia ${f === hoy ? 'hoy' : ''}"><header><b>${titulo}</b><span>${diaSem(f)} ${fmtDia(f)}</span><em>${ts.length} ${ts.length === 1 ? 'persona' : 'personas'}</em></header>
          ${evs.map((e) => `<div class="cal-ev" style="--c:${sucColor(e.sucursal_id, sucs)}">🎉 <b>${esc(e.nombre)}</b> · ${esc(sucCorto(e.sucursal))}${e.hora_desde ? ' · ' + horario(e) : ''} · 👥 ${e.personal.length}</div>`).join('')}
          ${porSuc.length ? porSuc.map(([s, l]) => `<div class="cal-suc" style="--c:${sucColor(s.id, sucs)}"><h4>${esc(s.nombre)} <small>${l.length}</small></h4>
            <ul>${l.map((t) => `<li><span>${esc(nom.get(t.usuario_id) || '')}</span><b>${horario(t)}</b>${t.evento ? '<i title="Evento">🎉</i>' : ''}</li>`).join('')}</ul></div>`).join('')
            : '<p class="muted" style="margin:6px 0">Nadie programado.</p>'}${licHtml}</div>`;
      };
      cont.innerHTML = `<div class="cal-head"><h2>Calendario del personal</h2><a href="#/programacion" style="white-space:nowrap">Ver programación →</a></div>
        <div class="cal-grid">${dia(hoy, 'Hoy')}${dia(man, 'Mañana')}</div>`;
    } catch (_) { cont.innerHTML = ''; }
  }

  // Próximos días programados del propio usuario (Mis horas y panel)
  async function misProximosDias(cont, { titulo = 'Mis próximos días de trabajo', dias = 14 } = {}) {
    try {
      const hoy = hoyISO();
      const r = await api(`/api/programacion/mia?desde=${hoy}&hasta=${addDias(hoy, dias - 1)}`);
      if (!cont || !document.body.contains(cont)) return;
      const licDia = new Map();
      (r.licencias || []).forEach((l) => { for (let f = l.desde < hoy ? hoy : l.desde; f <= l.hasta && f <= r.hasta; f = addDias(f, 1)) if (!licDia.has(f) || l.estado === 'APROBADA') licDia.set(f, l); });
      if (!r.turnos.length && !licDia.size) { cont.innerHTML = ''; return; }
      const porDia = new Map(); r.turnos.forEach((t) => { if (!porDia.has(t.fecha)) porDia.set(t.fecha, []); porDia.get(t.fecha).push(t); });
      [...licDia.keys()].forEach((f) => { if (!porDia.has(f)) porDia.set(f, []); });
      const ordenados = [...porDia].sort(([a], [b]) => a.localeCompare(b));
      cont.innerHTML = `<h2 class="mt" style="margin-top:22px">${titulo}</h2><div class="mis-dias">${ordenados.map(([f, ts]) => `
        <div class="mis-dia ${f === hoy ? 'hoy' : ''}"><div class="md-f"><span>${f === hoy ? 'Hoy' : f === addDias(hoy, 1) ? 'Mañana' : diaSem(f)}</span><b>${fmtDia(f).slice(0, 5)}</b></div>
          <div>${licDia.has(f) ? `<div class="md-t md-lic">${SOL_ICO[licDia.get(f).tipo] || '📝'} <b>${esc(licDia.get(f).tipo_nombre)}</b>${licDia.get(f).estado === 'APROBADA' ? '' : '<small>Pedida, sin aprobar</small>'}</div>` : ''}${ts.map((t) => `<div class="md-t"><b>${esc(t.sucursal)}</b> ${horario(t)}${t.evento ? `<small class="md-ev">🎉 Evento: ${esc(t.evento)}</small>` : ''}${t.nota ? `<small>${esc(t.nota)}</small>` : ''}</div>`).join('')}</div></div>`).join('')}</div>
        <p class="stock-hint">Los días que no aparecen son franco.</p>`;
    } catch (_) { /* sin datos */ }
  }

  // ---------- Tablero en vivo (Fudo) ----------
  const pesos = (n) => '$ ' + Math.round(n || 0).toLocaleString('es-AR');
  const pesosK = (n) => (Math.abs(n) >= 1e6 ? '$ ' + (n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M' : Math.abs(n) >= 1e3 ? '$ ' + Math.round(n / 1e3).toLocaleString('es-AR') + ' k' : pesos(n));
  const horaAR = (iso) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Argentina/Buenos_Aires' });
  const durTxt = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);

  // Gráfico de líneas/áreas en SVG con cruz y tooltip (una sola escala)
  function graficoLinea(cont, { series, formato = (v) => v, alto = 200, yMin = 0, yMax = null }) {
    const W = Math.max(280, cont.clientWidth || 600), H = alto, ml = 36, mr = 12, mt = 10, mb = 24;
    const todos = series.flatMap((s) => s.puntos);
    if (!todos.length) { cont.innerHTML = '<div class="tb-vacio">Sin datos todavía</div>'; return; }
    const t0 = Math.min(...todos.map((p) => p.x)), t1 = Math.max(...todos.map((p) => p.x));
    const vmax = yMax != null ? yMax - yMin : Math.max(1, ...todos.map((p) => p.y)); const paso = vmax <= 5 ? 1 : vmax <= 20 ? 5 : vmax <= 60 ? 10 : vmax <= 150 ? 25 : 50; const ymax = yMax != null ? yMax : Math.ceil(vmax / paso) * paso;
    const X = (x) => ml + ((x - t0) / Math.max(1, t1 - t0)) * (W - ml - mr), Y = (y) => mt + (1 - (y - yMin) / Math.max(1, ymax - yMin)) * (H - mt - mb);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="tb-svg" role="img">`;
    for (let v = Math.ceil(yMin / paso) * paso; v <= ymax; v += paso) svg += `<line x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}" class="tb-grid"/><text x="${ml - 6}" y="${Y(v) + 4}" class="tb-ax" text-anchor="end">${v}</text>`;
    const h0 = new Date(t0); h0.setMinutes(0, 0, 0);
    for (let h = h0.getTime() + 3600e3; h <= t1; h += 3600e3) { const hh = new Date(h).getHours(); if ((t1 - t0) > 10 * 3600e3 && hh % 2) continue; svg += `<text x="${X(h)}" y="${H - 6}" class="tb-ax" text-anchor="middle">${String(hh).padStart(2, '0')}h</text>`; }
    for (const s of series) {
      if (!s.puntos.length) continue;
      const d = s.puntos.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
      if (s.area) svg += `<path d="${d}L${X(s.puntos.at(-1).x).toFixed(1)},${Y(yMin)}L${X(s.puntos[0].x).toFixed(1)},${Y(yMin)}Z" fill="${s.color}" opacity=".12"/>`;
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.punteada ? 'stroke-dasharray="5 4"' : ''}/>`;
    }
    const ult = series[0].puntos.at(-1); if (ult) svg += `<circle cx="${X(ult.x)}" cy="${Y(ult.y)}" r="4.5" fill="${series[0].color}" stroke="#fff" stroke-width="2"/>`;
    svg += `<line class="tb-cruz" visibility="hidden" y1="${mt}" y2="${H - mb}" x1="-10" x2="-10"/><rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}" fill="transparent" class="tb-hit"/></svg><div class="tb-tip" hidden></div>`;
    cont.innerHTML = svg;
    const hit = cont.querySelector('.tb-hit'), cruz = cont.querySelector('.tb-cruz'), tip = cont.querySelector('.tb-tip'), svgEl = cont.querySelector('svg');
    const mover = (ev) => {
      const r = svgEl.getBoundingClientRect(); const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * (W / r.width);
      const x = t0 + ((cx - ml) / (W - ml - mr)) * (t1 - t0);
      const filas = series.map((s) => { if (!s.puntos.length) return null; const p = s.puntos.reduce((b, q) => (Math.abs(q.x - x) < Math.abs(b.x - x) ? q : b)); return { s, p }; }).filter(Boolean);
      if (!filas.length) return;
      const px = X(filas[0].p.x); cruz.setAttribute('visibility', 'visible'); cruz.setAttribute('x1', px); cruz.setAttribute('x2', px);
      tip.hidden = false; tip.innerHTML = `<b>${horaAR(filas[0].p.x)}</b>${filas.map(({ s, p }) => `<div><i style="background:${s.color}${s.punteada ? ';opacity:.6' : ''}"></i>${esc(s.nombre)}: <b>${formato(p.y)}</b></div>`).join('')}`;
      const left = (px / W) * r.width; tip.style.left = Math.min(r.width - 150, Math.max(0, left + 12)) + 'px';
    };
    hit.addEventListener('mousemove', mover); hit.addEventListener('touchmove', mover, { passive: true }); hit.addEventListener('touchstart', mover, { passive: true });
    hit.addEventListener('mouseleave', () => { tip.hidden = true; cruz.setAttribute('visibility', 'hidden'); cruz.setAttribute('x1', -10); cruz.setAttribute('x2', -10); });
  }
  function graficoBarras(cont, datos, { formato = pesos, color = '#165f96', alto = 180 }) {
    const W = Math.max(280, cont.clientWidth || 500), H = alto, ml = 44, mr = 8, mt = 10, mb = 24;
    if (!datos.length) { cont.innerHTML = '<div class="tb-vacio">Sin ventas todavía</div>'; return; }
    const vmax = Math.max(1, ...datos.map((d) => d.v)); const ex = Math.pow(10, Math.floor(Math.log10(vmax))); const paso = [1, 2, 2.5, 5, 10].map((k) => k * ex).find((p) => vmax / p <= 4); const ymax = Math.ceil(vmax / paso) * paso;
    const bw = (W - ml - mr) / datos.length, Y = (v) => mt + (1 - v / ymax) * (H - mt - mb);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="tb-svg">`;
    for (let v = 0; v <= ymax; v += paso) svg += `<line x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}" class="tb-grid"/><text x="${ml - 6}" y="${Y(v) + 4}" class="tb-ax" text-anchor="end">${pesosK(v).replace('$ ', '')}</text>`;
    datos.forEach((d, i) => {
      const x = ml + i * bw + Math.min(6, bw * 0.15), w = Math.max(3, bw - 2 * Math.min(6, bw * 0.15)), y = Y(d.v), h = Math.max(0, Y(0) - y);
      svg += `<g class="tb-bar" data-i="${i}"><rect x="${ml + i * bw}" y="${mt}" width="${bw}" height="${H - mt - mb}" fill="transparent"/>${h ? `<path d="M${x},${Y(0)}V${y + Math.min(4, h)}Q${x},${y} ${x + Math.min(4, w / 2)},${y}H${x + w - Math.min(4, w / 2)}Q${x + w},${y} ${x + w},${y + Math.min(4, h)}V${Y(0)}Z" fill="${d.actual ? color : color}" opacity="${d.actual ? 0.55 : 1}"/>` : ''}
        <text x="${ml + i * bw + bw / 2}" y="${H - 6}" class="tb-ax" text-anchor="middle">${esc(d.etq)}</text></g>`;
    });
    svg += '</svg><div class="tb-tip" hidden></div>';
    cont.innerHTML = svg;
    const tip = cont.querySelector('.tb-tip'), svgEl = cont.querySelector('svg');
    cont.querySelectorAll('.tb-bar').forEach((g) => {
      const d = datos[g.dataset.i];
      const show = () => { const r = svgEl.getBoundingClientRect(); tip.hidden = false; tip.innerHTML = `<b>${esc(d.etq)}</b><div>${formato(d.v)}</div>${d.extra ? `<div class="muted">${d.extra}</div>` : ''}`;
        tip.style.left = Math.min(r.width - 150, ((ml + g.dataset.i * bw) / W) * r.width) + 'px'; };
      g.addEventListener('mouseenter', show); g.addEventListener('touchstart', show, { passive: true }); g.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  VIEWS.tablero = async (main) => {
    clearInterval(VIEWS.tablero._t);
    main.innerHTML = `<div class="tb-head"><div><h1>Tablero en vivo</h1><p class="sub" id="tb-sub">Cargando datos de Fudo…</p></div>
      <div class="tb-acc"><span class="tb-live" id="tb-live"><i></i>En vivo</span><button class="btn ghost sm" id="tb-ref">🔄 Actualizar</button><button class="btn sec sm" id="tb-tv">📺 Modo TV</button></div></div>
      <div class="tb-tabs" id="tb-tabs" hidden></div>
      <div id="tb-body"><div class="card empty">Leyendo mesas y ventas de Fudo…</div></div>`;
    let comp = null, compT = 0, ultimo = null, cuentas = [];
    let cuenta = (() => { try { return localStorage.getItem('vinilo_tb_cuenta') || ''; } catch (_) { return ''; } })();
    try { cuentas = await api('/api/tablero/cuentas'); } catch (_) { cuentas = []; }
    if (!cuentas.some((c) => c.id === cuenta)) cuenta = cuentas[0] ? cuentas[0].id : '';
    const pintarTabs = () => { const t = $('#tb-tabs'); t.hidden = cuentas.length < 2;
      t.innerHTML = cuentas.map((c) => `<button class="${c.id === cuenta ? 'on' : ''}" data-c="${esc(c.id)}">${esc(c.nombre)}</button>`).join('');
      t.querySelectorAll('button').forEach((b) => (b.onclick = () => { if (b.dataset.c === cuenta) return; cuenta = b.dataset.c; try { localStorage.setItem('vinilo_tb_cuenta', cuenta); } catch (_) { /* sin storage */ }
        comp = null; compT = 0; ultimo = null; pintarTabs(); $('#tb-body').innerHTML = '<div class="card empty">Leyendo mesas y ventas de Fudo…</div>'; cargar(); })); };
    pintarTabs();
    const qc = () => (cuenta ? 'cuenta=' + encodeURIComponent(cuenta) : '');
    const pintar = (d) => {
      const k = d.kpi, pct = k.mesas_total ? Math.round((k.mesas_ocupadas / k.mesas_total) * 100) : 0;
      const ventasHoy = k.ventas_cerradas + k.ventas_abiertas;
      const dif = comp && comp.ventas_a_esta_hora ? Math.round(((ventasHoy - comp.ventas_a_esta_hora) / comp.ventas_a_esta_hora) * 100) : null;
      $('#tb-sub').innerHTML = `${d.sucursal ? `<b>${esc(d.sucursal)}</b> · ` : ''}Jornada del ${new Date(d.jornada + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })} · datos de Fudo${d.desactualizado ? ' · <b style="color:var(--accent)">sin conexión con Fudo, últimos datos</b>' : ''}`;
      $('#tb-body').innerHTML = `
        <div class="tb-kpis">
          <div class="tb-kpi"><span>Mesas ocupadas</span><b>${k.mesas_ocupadas}<small> / ${k.mesas_total}</small></b><div class="tb-meter"><i style="width:${pct}%"></i></div><small>${pct}% del salón</small></div>
          <div class="tb-kpi"><span>Comensales ahora</span><b>${d.personas_informadas ? k.comensales : '—'}</b><small>${k.pico_comensales ? `pico ${k.pico_comensales} a las ${horaAR(k.pico_hora)}` : d.personas_informadas ? 'sin pico todavía' : 'Fudo no informa personas'}</small></div>
          <div class="tb-kpi"><span>Ventas de la jornada</span><b>${pesosK(ventasHoy)}</b><small>${pesos(k.ventas_cerradas)} cobrado · ${pesos(k.ventas_abiertas)} en mesas</small>
            ${dif !== null ? `<em class="${dif >= 0 ? 'up' : 'down'}">${dif >= 0 ? '▲' : '▼'} ${Math.abs(dif)}% vs. ${diaSem(comp.fecha).toLowerCase()} pasado a esta hora</em>` : ''}</div>
          <div class="tb-kpi"><span>Ticket promedio</span><b>${pesosK(k.ticket_promedio)}</b><small>${k.tickets_cerrados} cerrados · ${k.tickets_abiertos} abiertos</small></div>
          <div class="tb-kpi"><span>Gasto por comensal</span><b>${k.por_comensal ? pesosK(k.por_comensal) : '—'}</b><small>${k.comensales_jornada} comensales en la jornada</small></div>
          <div class="tb-kpi"><span>Permanencia promedio</span><b>${durTxt(k.permanencia_min)}</b><small>mesas ya cerradas</small></div>
        </div>
        <div class="tb-fila2">
          <div class="card tb-card"><div class="tb-ct"><h3>Comensales en el salón</h3><div class="tb-ley"><span><i style="background:#165f96"></i>Hoy</span>${comp ? `<span><i class="pt"></i>${esc(diaSem(comp.fecha))} pasado</span>` : ''}</div></div><div id="tb-g1" class="tb-graf"></div></div>
          <div class="card tb-card"><div class="tb-ct"><h3>Mesas ocupadas</h3><div class="tb-ley"><span><i style="background:#165f96"></i>Hoy</span>${comp ? `<span><i class="pt"></i>${esc(diaSem(comp.fecha))} pasado</span>` : ''}</div></div><div id="tb-g2" class="tb-graf"></div></div>
        </div>
        <div class="tb-fila3">
          <div class="card tb-card"><div class="tb-ct"><h3>Ventas por hora</h3><small class="muted">según la hora en que se abrió la mesa</small></div><div id="tb-g3" class="tb-graf"></div></div>
          <div class="card tb-card"><h3>Lo más vendido hoy</h3>${d.top.length ? `<div class="tb-top">${d.top.map((t) => `<div><span>${esc(t.producto)}</span><b>${t.cantidad.toLocaleString('es-AR')}</b><i style="width:${Math.round((t.cantidad / d.top[0].cantidad) * 100)}%"></i></div>`).join('')}</div>` : '<div class="tb-vacio">Sin ítems todavía</div>'}</div>
          <div class="card tb-card"><h3>Cómo se vende</h3>${d.mix.length ? `<div class="tb-mix">${d.mix.map((m) => { const p = ventasHoy ? Math.round((m.total / ventasHoy) * 100) : 0; return `<div><span>${esc(m.tipo)}</span><b>${p}%</b><div class="tb-meter"><i style="width:${p}%"></i></div><small>${pesos(m.total)} · ${m.tickets} tickets</small></div>`; }).join('')}</div>` : '<div class="tb-vacio">Sin ventas todavía</div>'}</div>
        </div>
        ${(() => { const salaN = new Map(d.salas.map((x) => [x.id, x.nombre])); const ls = d.mapa.filter((m) => m.ocupada && m.minutos >= 90).sort((x, y) => y.minutos - x.minutos);
          return `<div class="card tb-card"><div class="tb-ct"><h3>Mesas con más de 1 h 30</h3><small class="muted">${ls.length ? `${ls.length} de ${k.mesas_ocupadas} ocupadas` : ''}</small></div>
          ${ls.length ? `<div class="tb-largas">${ls.map((m) => `<div class="${m.minutos >= 150 ? 'muy' : ''}"><b>Mesa ${esc(m.numero)}</b><span>${esc(salaN.get(m.sala_id) || '')}</span><span>${m.personas ? `👥 ${m.personas}` : ''}</span><span class="t">⏱ ${durTxt(m.minutos)}</span><span class="m">${pesos(m.total)}</span></div>`).join('')}</div>`
            : '<div class="tb-vacio">Ninguna mesa lleva más de 1 h 30 abierta</div>'}</div>`; })()}`;
      const pts = (arr, k) => arr.map((p) => ({ x: new Date(p.t).getTime(), y: p[k] }));
      const ahoraMs = Date.now();
      const compPts = (k) => (comp ? pts(comp.serie, k).filter((p) => p.x >= new Date(d.serie[0] ? d.serie[0].t : d.desde).getTime() && p.x <= Math.max(ahoraMs + 2 * 3600e3, ahoraMs)) : []);
      graficoLinea($('#tb-g1'), { series: [{ nombre: 'Hoy', color: '#165f96', puntos: pts(d.serie, 'comensales'), area: true }, ...(comp ? [{ nombre: `${diaSem(comp.fecha)} pasado`, color: '#7b8794', punteada: true, puntos: compPts('comensales') }] : [])], formato: (v) => `${v} comensales` });
      graficoLinea($('#tb-g2'), { series: [{ nombre: 'Hoy', color: '#165f96', puntos: pts(d.serie, 'mesas'), area: true }, ...(comp ? [{ nombre: `${diaSem(comp.fecha)} pasado`, color: '#7b8794', punteada: true, puntos: compPts('mesas') }] : [])], formato: (v) => `${v} mesas` });
      const hActual = new Date().getHours();
      graficoBarras($('#tb-g3'), d.por_hora.map((h) => ({ etq: `${String(h.hora).padStart(2, '0')}h`, v: h.ventas, actual: h.hora === hActual, extra: `${h.tickets} tickets${h.comensales ? ` · ${h.comensales} comensales` : ''}${h.hora === hActual ? ' · hora en curso' : ''}` })), {});
    };
    const cargar = async (forzar) => {
      try {
        if (!comp || Date.now() - compT > 10 * 60e3) { const pedida = cuenta; api('/api/tablero/comparacion?' + qc()).then((c) => { if (pedida !== cuenta) return; comp = c; compT = Date.now(); if (ultimo) pintar(ultimo); }).catch(() => {}); compT = Date.now(); }
        const pedida = cuenta; const d = await api('/api/tablero?' + qc() + (forzar ? '&t=' + Date.now() : ''));
        if (pedida !== cuenta) return; ultimo = d; d._recibido = Date.now(); pintar(d);
      } catch (err) { $('#tb-body').innerHTML = `<div class="card empty">⚠️ ${esc(err.message)}</div>`; $('#tb-sub').textContent = 'Sin datos'; }
    };
    $('#tb-ref').onclick = () => cargar(true);
    $('#tb-tv').onclick = () => { document.body.classList.toggle('tv'); $('#tb-tv').textContent = document.body.classList.contains('tv') ? '✕ Salir de modo TV' : '📺 Modo TV';
      try { if (document.body.classList.contains('tv')) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); else document.fullscreenElement && document.exitFullscreen(); } catch (_) { /* sin pantalla completa */ } };
    await cargar();
    VIEWS.tablero._t = setInterval(() => {
      if (!location.hash.startsWith('#/tablero')) { clearInterval(VIEWS.tablero._t); document.body.classList.remove('tv'); return; }
      if (!document.hidden) cargar();
    }, 60000);
    let rz; window.onresize = () => { clearTimeout(rz); rz = setTimeout(() => { if (ultimo && location.hash.startsWith('#/tablero')) pintar(ultimo); }, 250); };
  };

  // ---------- Juegos: Bolsa de tragos ----------
  function sparkBolsa(serie, sube, w = 120, h = 34) {
    if (!serie || serie.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
    const mn = Math.min(...serie, 1), mx = Math.max(...serie, 1), rg = Math.max(0.02, mx - mn);
    const X = (i) => (i / (serie.length - 1)) * w, Y = (v) => h - 2 - ((v - mn) / rg) * (h - 4);
    const d = serie.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="bv-spark ${sube ? 'up' : 'down'}"><line x1="0" x2="${w}" y1="${Y(1)}" y2="${Y(1)}" class="bv-base"/><path d="${d}L${w},${h}L0,${h}Z" class="bv-area"/><path d="${d}" class="bv-line"/></svg>`;
  }
  const flecha = (v) => (v > 0.05 ? '▲' : v < -0.05 ? '▼' : '■');
  const clsVar = (v) => (v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'eq');
  const pctTxt = (v) => `${v > 0 ? '+' : ''}${v.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

  // Animaciones de ventas: una pizza volando o dos tragos brindando, con variantes al azar
  const azar = (a) => a[Math.floor(Math.random() * a.length)];
  const rnd = (a, b) => a + Math.random() * (b - a);
  function capaAnim() { let c = document.getElementById('bv-anim'); if (!c) { c = document.createElement('div'); c.id = 'bv-anim'; document.body.appendChild(c); } return c; }
  function etiquetaAnim(capa, txt, x, y, dur) {
    const e = document.createElement('div'); e.className = 'bv-an-etq'; e.textContent = txt; e.style.left = x + 'px'; e.style.top = y + 'px'; capa.appendChild(e);
    e.animate([{ opacity: 0, transform: 'translate(-50%, 10px) scale(.8)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.15 }, { opacity: 1, offset: 0.75 }, { opacity: 0, transform: 'translate(-50%, -20px)' }], { duration: dur, easing: 'ease-out' }).onfinish = () => e.remove();
  }
  function emoji(capa, ch, size) { const e = document.createElement('div'); e.className = 'bv-an'; e.textContent = ch; e.style.fontSize = size + 'px'; capa.appendChild(e); return e; }
  function animPizza(v) {
    const capa = capaAnim(), W = innerWidth, H = innerHeight, txt = `🍕 ${v.nombre}${v.cantidad > 1 ? ' ×' + v.cantidad : ''}`;
    const tipo = azar(['cruza', 'sube', 'lluvia', 'zoom', 'boomerang']);
    if (tipo === 'lluvia') {
      for (let i = 0; i < 5 + Math.min(4, v.cantidad); i++) { const e = emoji(capa, '🍕', rnd(50, 90)); const x = rnd(0.05, 0.9) * W;
        e.animate([{ transform: `translate(${x}px, -120px) rotate(0deg)` }, { transform: `translate(${x + rnd(-80, 80)}px, ${H + 60}px) rotate(${rnd(360, 900)}deg)` }], { duration: rnd(1800, 2800), delay: i * 140, easing: 'cubic-bezier(.4,0,.8,1)', fill: 'backwards' }).onfinish = () => e.remove(); }
      etiquetaAnim(capa, txt, W / 2, H * 0.4, 2600); return;
    }
    const e = emoji(capa, '🍕', tipo === 'zoom' ? 120 : rnd(90, 130)); let kf, dur = 2400, ex = W / 2, ey = H * 0.4;
    if (tipo === 'cruza') { const izq = Math.random() < 0.5, y0 = rnd(0.2, 0.7) * H; ey = y0 - 60; kf = [0, 0.5, 1].map((p, i) => ({ transform: `translate(${izq ? -150 + p * (W + 300) : W + 150 - p * (W + 300)}px, ${y0 - Math.sin(p * Math.PI) * rnd(80, 200)}px) rotate(${(izq ? 1 : -1) * p * 720}deg)` })); }
    else if (tipo === 'sube') { const x = rnd(0.15, 0.8) * W; ex = x + 50; ey = H * 0.25; kf = [{ transform: `translate(${x}px, ${H + 50}px) rotate(0deg) scale(.6)` }, { transform: `translate(${x + rnd(-60, 60)}px, ${H * 0.25}px) rotate(360deg) scale(1.1)`, offset: 0.5 }, { transform: `translate(${x + rnd(-120, 120)}px, ${H + 80}px) rotate(720deg) scale(.7)` }]; dur = 2600; }
    else if (tipo === 'boomerang') { const y0 = rnd(0.25, 0.6) * H; ey = y0 - 40; kf = [{ transform: `translate(-150px, ${y0}px) rotate(0deg)` }, { transform: `translate(${W * 0.7}px, ${y0 - 120}px) rotate(540deg)`, offset: 0.5 }, { transform: `translate(-150px, ${y0}px) rotate(1080deg)` }]; dur = 2800; }
    else { kf = [{ transform: `translate(${W / 2 - 60}px, ${H / 2 - 60}px) scale(0) rotate(-90deg)` }, { transform: `translate(${W / 2 - 60}px, ${H / 2 - 60}px) scale(2.2) rotate(20deg)`, offset: 0.35 }, { transform: `translate(${W / 2 - 60}px, ${H / 2 - 60}px) scale(2) rotate(0deg)`, offset: 0.65 }, { transform: `translate(${W + 100}px, ${-150}px) scale(.5) rotate(540deg)` }]; ey = H / 2 + 140; }
    e.animate(kf, { duration: dur, easing: 'ease-in-out' }).onfinish = () => e.remove();
    etiquetaAnim(capa, txt, ex, ey, dur);
  }
  function animBrindis(v) {
    const capa = capaAnim(), W = innerWidth, H = innerHeight;
    const vaso = azar(['🍸', '🍹', '🥃', '🍷', '🍺', '🍸']);
    const tipo = azar(['centro', 'lugar', 'lados', 'doble']);
    const brindar = (cx, cy, tam, dur, retraso = 0) => {
      const iz = emoji(capa, vaso, tam), de = emoji(capa, vaso, tam), d = tam * 0.62, desde = tipo === 'lados' ? W * 0.6 : tam * 1.3;
      const k = (lado) => [{ transform: `translate(${cx - tam / 2 + lado * desde}px, ${cy}px) rotate(${lado * 0}deg) scaleX(${lado})`, opacity: 0 },
        { transform: `translate(${cx - tam / 2 + lado * d}px, ${cy}px) rotate(${-lado * 25}deg) scaleX(${lado})`, opacity: 1, offset: 0.3 },
        { transform: `translate(${cx - tam / 2 + lado * d * 0.6}px, ${cy - 10}px) rotate(${-lado * 35}deg) scaleX(${lado})`, opacity: 1, offset: 0.4 },
        { transform: `translate(${cx - tam / 2 + lado * d}px, ${cy}px) rotate(${-lado * 15}deg) scaleX(${lado})`, opacity: 1, offset: 0.55 },
        { transform: `translate(${cx - tam / 2 + lado * d * 0.6}px, ${cy - 14}px) rotate(${-lado * 35}deg) scaleX(${lado})`, opacity: 1, offset: 0.65 },
        { transform: `translate(${cx - tam / 2 + lado * d}px, ${cy - 40}px) rotate(${-lado * 10}deg) scaleX(${lado})`, opacity: 0 }];
      iz.animate(k(-1), { duration: dur, delay: retraso, easing: 'ease-in-out', fill: 'backwards' }).onfinish = () => iz.remove();
      de.animate(k(1), { duration: dur, delay: retraso, easing: 'ease-in-out', fill: 'backwards' }).onfinish = () => de.remove();
      for (const off of [0.4, 0.65]) for (let i = 0; i < 7; i++) {
        const ch = emoji(capa, azar(['✨', '✨', '💫', '⭐', '🎉']), tam * rnd(0.2, 0.35)); const ang = rnd(0, Math.PI * 2), r = tam * rnd(0.7, 1.4);
        ch.animate([{ transform: `translate(${cx - tam * 0.12}px, ${cy - tam * 0.25}px) scale(.2)`, opacity: 1 }, { transform: `translate(${cx - tam * 0.12 + Math.cos(ang) * r}px, ${cy - tam * 0.25 + Math.sin(ang) * r}px) scale(1)`, opacity: 0 }],
          { duration: 700, delay: retraso + dur * off, easing: 'ease-out', fill: 'backwards' }).onfinish = () => ch.remove(); }
    };
    const txt = `🥂 ${v.nombre}${v.cantidad > 1 ? ' ×' + v.cantidad : ''}`;
    if (tipo === 'centro' || tipo === 'lados') { brindar(W / 2, H * 0.32, 130, 2600); etiquetaAnim(capa, txt, W / 2, H * 0.32 + 160, 2600); }
    else if (tipo === 'lugar') { const cx = rnd(0.2, 0.8) * W, cy = rnd(0.2, 0.6) * H; brindar(cx, cy, 90, 2300); etiquetaAnim(capa, txt, cx, cy + 115, 2300); }
    else { brindar(W * 0.3, H * 0.35, 90, 2400); brindar(W * 0.7, H * 0.45, 90, 2400, 350); etiquetaAnim(capa, txt, W / 2, H * 0.62, 2600); }
  }
  function animCrash(c) {
    const capa = capaAnim(); const e = document.createElement('div'); e.className = 'bv-crash-fx';
    e.innerHTML = `<b>💥 CRASH 💥</b><span>Todo −${c.caida}% por ${c.minutos} minutos</span>`; capa.appendChild(e);
    e.animate([{ opacity: 0, transform: 'scale(3)' }, { opacity: 1, transform: 'scale(1)', offset: 0.12 }, { transform: 'translate(-12px, 4px)', offset: 0.18 }, { transform: 'translate(12px, -4px)', offset: 0.24 }, { transform: 'translate(-8px, 2px)', offset: 0.3 }, { transform: 'translate(0, 0)', opacity: 1, offset: 0.8 }, { opacity: 0, transform: 'translateY(40px)' }], { duration: 4200, easing: 'ease-out' }).onfinish = () => e.remove();
    const bv = document.querySelector('.bv'); if (bv) bv.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-10px,6px)' }, { transform: 'translate(9px,-5px)' }, { transform: 'translate(-6px,3px)' }, { transform: 'translate(0,0)' }], { duration: 600, delay: 400 });
    for (let i = 0; i < 14; i++) { const f = emoji(capa, azar(['📉', '📉', '💸', '🔻']), rnd(40, 80)); const x = rnd(0, innerWidth);
      f.animate([{ transform: `translate(${x}px, -100px) rotate(0deg)` }, { transform: `translate(${x + rnd(-60, 60)}px, ${innerHeight + 80}px) rotate(${rnd(-180, 180)}deg)` }], { duration: rnd(1600, 2600), delay: rnd(200, 1600), easing: 'ease-in', fill: 'backwards' }).onfinish = () => f.remove(); }
  }

  VIEWS.bolsa = async (main) => {
    clearInterval(VIEWS.bolsa._t);
    document.body.classList.add('bolsa-on');
    main.innerHTML = `<div class="bv">
      <div class="bv-top"><div class="bv-marca"><img class="bv-logo-img" src="/vinilo-club-blanco.png" alt="Vinilo Bar Club"><div><h1 id="bv-tit">Bolsa de tragos</h1><p id="bv-sub">Abriendo el mercado…</p></div></div>
        <div class="bv-acc"><span class="bv-reloj" id="bv-reloj"></span>${puede('juegosCrash') ? '<button class="bv-btn bv-crash-btn" id="bv-crash">💥 Crash</button>' : ''}<button class="bv-btn" id="bv-demo">🎬 Demo</button>${S.user.rol === 'ADMIN' ? '<button class="bv-btn" id="bv-conf">⚙️ Productos</button>' : ''}<button class="bv-btn" id="bv-tv">📺 Modo TV</button></div></div>
      <div class="bv-demo-bar" id="bv-demobar" hidden>🎬 <b>MODO DEMO</b> · ventas simuladas sobre los productos y precios reales de Fudo · <a href="#" id="bv-demo-salir">volver a las ventas reales</a></div>
      <div class="bv-sel"><div class="bv-merc" id="bv-merc"></div><div class="bv-tabs" id="bv-tabs" hidden></div></div>
      <div class="bv-crash-bar" id="bv-crashbar" hidden></div>
      <div class="bv-cinta"><div class="bv-cinta-in" id="bv-cinta"></div></div>
      <div id="bv-body"><div class="bv-vacio">Leyendo las ventas de Fudo…</div></div></div>`;
    let cuentas = [], cuenta = (() => { try { return localStorage.getItem('vinilo_bv_cuenta') || ''; } catch (_) { return ''; } })(), previo = new Map();
    let mercado = (() => { try { return localStorage.getItem('vinilo_bv_mercado') || 'tragos'; } catch (_) { return 'tragos'; } })();
    let vistos = null, crashVisto = null, crashAct = null, cola = [];
    let demo = /[?&]demo=1/.test(location.hash);
    const qs = () => `?mercado=${encodeURIComponent(mercado)}${cuenta ? '&cuenta=' + encodeURIComponent(cuenta) : ''}${demo ? '&demo=1' : ''}`;
    const pintarMerc = (ms) => { $('#bv-merc').innerHTML = (ms || [{ id: 'tragos', nombre: 'Tragos' }, { id: 'pizzas', nombre: 'Pizzas' }]).map((m) => `<button class="${m.id === mercado ? 'on' : ''}" data-m="${m.id}">${m.id === 'pizzas' ? '🍕' : '🍸'} ${esc(m.nombre)}</button>`).join('');
      $$('#bv-merc button').forEach((b) => (b.onclick = () => { if (b.dataset.m === mercado) return; mercado = b.dataset.m; try { localStorage.setItem('vinilo_bv_mercado', mercado); } catch (_) { /* sin storage */ } previo = new Map(); pintarMerc(ms); $('#bv-body').innerHTML = '<div class="bv-vacio">Abriendo el mercado…</div>'; cargar(); })); };
    pintarMerc();
    try { cuentas = await api('/api/bolsa/cuentas'); } catch (_) { cuentas = []; }
    if (!cuentas.some((c) => c.id === cuenta)) cuenta = cuentas[0] ? cuentas[0].id : '';
    const tabs = () => { const t = $('#bv-tabs'); t.hidden = cuentas.length < 2; t.innerHTML = cuentas.map((c) => `<button class="${c.id === cuenta ? 'on' : ''}" data-c="${esc(c.id)}">${esc(c.nombre)}</button>`).join('');
      t.querySelectorAll('button').forEach((b) => (b.onclick = () => { cuenta = b.dataset.c; try { localStorage.setItem('vinilo_bv_cuenta', cuenta); } catch (_) { /* sin storage */ } previo = new Map(); vistos = null; tabs(); cargar(); })); };
    tabs();
    const reloj = () => { const e = $('#bv-reloj'); if (e) e.textContent = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      const cb = $('#bv-crashbar'); if (!cb) return;
      const resta = crashAct ? new Date(crashAct.hasta).getTime() - Date.now() : 0;
      if (resta > 0) { cb.hidden = false; const mm = Math.floor(resta / 60000), ss = Math.floor((resta % 60000) / 1000);
        cb.innerHTML = `<b>💥 CRASH EN CURSO</b><span>Todo −${crashAct.caida}%</span><span class="bv-cd">termina en ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}</span>`; }
      else cb.hidden = true;
      const bt = $('#bv-crash'); if (bt) bt.textContent = resta > 0 ? '⏹ Terminar crash' : '💥 Crash';
    };
    // Cola de animaciones: de a una, con pausa entre cada una
    const animar = () => { if (!cola.length || document.hidden) return; if (document.querySelector('#modal-root .modal-bg')) { setTimeout(animar, 1500); return; } const v = cola.shift(); (v.mercado === 'pizzas' ? animPizza : animBrindis)(v); if (cola.length) setTimeout(animar, rnd(1400, 2200)); };
    reloj();

    const pintar = (d) => {
      const ts = d.tragos.slice(); const pz = d.mercado === 'pizzas', unidad = pz ? 'pizzas' : 'tragos';
      if (d.mercados) pintarMerc(d.mercados);
      $('#bv-tit').textContent = `Bolsa de ${d.mercado_nombre.toLowerCase()}`;
      $('#bv-sub').innerHTML = `${esc(d.sucursal)} · ${d.abierto ? `mercado abierto desde las ${horaAR(d.apertura)} · ${d.unidades} ${unidad} operad${pz ? 'as' : 'os'}` : `mercado cerrado: abre con ${pz ? 'la primera pizza' : 'el primer trago'} de la noche`}${d.desactualizado ? ' · <b>sin conexión con Fudo</b>' : ''}`;
      $('#bv-demobar').hidden = !d.demo; $('#bv-demo').textContent = d.demo ? '📡 Ventas reales' : '🎬 Demo'; $('#bv-demo').classList.toggle('on', !!d.demo);
      crashAct = d.crash; if (d.crash && d.crash.desde !== crashVisto) { if (crashVisto !== null || Date.now() - new Date(d.crash.desde).getTime() < 60e3) animCrash(d.crash); crashVisto = d.crash.desde; } else if (!d.crash && crashVisto === null) crashVisto = '';
      reloj();
      const rec = d.ventas_recientes || [];
      if (vistos === null) vistos = new Set(rec.map((v) => v.id));
      else { const nuevas = rec.filter((v) => !vistos.has(v.id)); nuevas.forEach((v) => vistos.add(v.id)); if (nuevas.length) { const vacia = !cola.length; cola.push(...nuevas.slice(-8)); if (vacia) animar(); } }
      // Cinta
      const enCinta = (d.abierto ? ts.filter((t) => t.vendidos > 0).sort((a, b) => b.ultima_hora - a.ultima_hora || b.vendidos - a.vendidos) : ts.sort((a, b) => a.nombre.localeCompare(b.nombre))).slice(0, 30);
      const items = enCinta.map((t) => `<span class="bv-tk ${clsVar(t.var_dia)}"><b>${esc(t.nombre.toUpperCase())}</b> ${pesos(t.precio)} <i>${flecha(t.var_dia)} ${pctTxt(t.var_dia)}</i></span>`).join('');
      $('#bv-cinta').innerHTML = items + items;
      $('#bv-cinta').style.animationDuration = Math.max(25, enCinta.length * 4) + 's';
      if (!d.abierto) {
        $('#bv-body').innerHTML = `<div class="bv-cerrado"><div class="bv-campana">🔔</div><h2>El mercado todavía no abrió</h2><p>La rueda empieza con ${pz ? 'la primera pizza vendida' : 'el primer trago vendido'} en Fudo (o a las 18 h). Estos son los precios de apertura:</p>
          <div class="bv-grid">${ts.slice(0, 24).map((t) => `<div class="bv-tile eq"><div class="bv-tn">${esc(t.nombre)}</div><div class="bv-tp">${pesos(t.precio)}</div><div class="bv-tv">■ 0,0%</div></div>`).join('')}</div></div>`;
        return;
      }
      const op = ts.filter((t) => t.vendidos > 0).sort((a, b) => b.vendidos - a.vendidos);
      const quietos = ts.filter((t) => !t.vendidos).sort((a, b) => a.var_dia - b.var_dia);
      const subas = [...op].sort((a, b) => b.var_30 - a.var_30).filter((t) => t.var_30 > 0.05).slice(0, 5);
      const bajas = [...ts].sort((a, b) => a.var_30 - b.var_30).filter((t) => t.var_30 < -0.05).slice(0, 5);
      const ix = d.indice;
      const fila = (t, k) => `<div class="bv-mv"><span>${esc(t.nombre)}</span><b>${pesos(t.precio)}</b><i class="${clsVar(t[k])}">${flecha(t[k])} ${pctTxt(t[k])}</i></div>`;
      $('#bv-body').innerHTML = `
        <div class="bv-head">
          <div class="bv-idx"><span>ÍNDICE VINILO</span><b class="${clsVar(ix.var_dia)}">${ix.valor.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</b>
            <i class="${clsVar(ix.var_dia)}">${flecha(ix.var_dia)} ${pctTxt(ix.var_dia)} hoy</i><i class="${clsVar(ix.var_30)}">${flecha(ix.var_30)} ${pctTxt(ix.var_30)} últ. 30 min</i></div>
          <div class="bv-idxg" id="bv-idxg"></div>
          <div class="bv-mov"><h3>🚀 Suben (30 min)</h3>${subas.map((t) => fila(t, 'var_30')).join('') || '<p class="bv-nada">Nada en alza</p>'}</div>
          <div class="bv-mov"><h3>📉 Bajan (30 min)</h3>${bajas.map((t) => fila(t, 'var_30')).join('') || '<p class="bv-nada">Nada en baja</p>'}</div>
        </div>
        <div class="bv-grid">${op.map((t) => { const p0 = previo.get(t.id); const fl = p0 == null || p0 === t.precio ? '' : p0 < t.precio ? 'fl-up' : 'fl-down';
          return `<div class="bv-tile ${clsVar(t.var_dia)} ${fl}" title="Precio de carta ${pesos(t.base)} · máx ${pesos(t.maximo)} · mín ${pesos(t.minimo)}">
            <div class="bv-tn">${esc(t.nombre)}</div><div class="bv-tp">${pesos(t.precio)}</div>
            <div class="bv-tv">${flecha(t.var_dia)} ${pctTxt(t.var_dia)}</div>${sparkBolsa(t.serie, t.var_dia >= 0)}
            <div class="bv-tf"><span>Vol. ${t.vendidos}</span><span>máx ${pesosK(t.maximo)}</span><span>mín ${pesosK(t.minimo)}</span></div></div>`; }).join('')}</div>
        ${quietos.length ? `<div class="bv-quietos"><h3>Sin operar hoy <small>${quietos.length} ${unidad}</small></h3><div>${quietos.map((t) => `<span class="${clsVar(t.var_dia)}">${esc(t.nombre)} <b>${pesos(t.precio)}</b> <i>${flecha(t.var_dia)} ${pctTxt(t.var_dia)}</i></span>`).join('')}</div></div>` : ''}
        <p class="bv-nota">Juego de pantalla: cada ${pz ? 'pizza' : 'trago'} sube cuando se pide y baja cuando no sale, y siempre tiende a volver a su precio de carta. Los precios de Fudo no cambian.</p>`;
      const g = $('#bv-idxg');
      if (g) { const pts = ix.serie.map((p) => ({ x: new Date(p.t).getTime(), y: p.v })); const mn = Math.min(...pts.map((p) => p.y), 1000), mx = Math.max(...pts.map((p) => p.y), 1000);
        graficoLinea(g, { series: [{ nombre: 'Índice', color: ix.var_dia >= 0 ? '#22c55e' : '#ef4444', puntos: pts, area: true }], formato: (v) => v.toLocaleString('es-AR', { maximumFractionDigits: 1 }), alto: 150, yMin: Math.floor((mn - 10) / 10) * 10, yMax: Math.ceil((mx + 10) / 10) * 10 }); }
      previo = new Map(ts.map((t) => [t.id, t.precio]));
    };
    const cargar = async () => {
      const pedida = cuenta;
      const pedidoM = mercado;
      try { const d = await api('/api/bolsa' + qs()); if (pedida === cuenta && pedidoM === mercado) pintar(d); }
      catch (err) { $('#bv-body').innerHTML = `<div class="bv-vacio">⚠️ ${esc(err.message)}</div>`; }
    };
    $('#bv-tv').onclick = () => { document.body.classList.toggle('tv'); $('#bv-tv').textContent = document.body.classList.contains('tv') ? '✕ Salir' : '📺 Modo TV';
      try { if (document.body.classList.contains('tv')) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); else document.fullscreenElement && document.exitFullscreen(); } catch (_) { /* sin pantalla completa */ } };
    if ($('#bv-conf')) $('#bv-conf').onclick = async () => {
      const lista = await api('/api/bolsa/config' + qs()); const nm = mercado === 'pizzas' ? 'Pizzas' : 'Tragos';
      const m = modal(`<h2>${nm} de la bolsa</h2><p class="stock-hint">Son los productos de Fudo de la categoría <b>${nm}</b>. Destildá los que no querés mostrar en la pantalla${mercado === 'pizzas' ? ' (por ejemplo, porciones)' : ' (por ejemplo, "fuera de carta" o medidas)'}.</p>
        <input id="bc-q" placeholder="Buscar…" style="margin-bottom:8px"><div class="chk-grupo chk-lista" id="bc-l" style="max-height:50vh">${lista.map((p) => `<label class="check" data-n="${esc(p.nombre.toLowerCase())}"><input type="checkbox" value="${esc(p.id)}" ${p.oculto ? '' : 'checked'}> ${esc(p.nombre)} <span class="muted">· ${pesos(p.base)}${p.activo ? '' : ' · inactivo en Fudo'}</span></label>`).join('')}</div>
        <div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn" id="bc-ok">Guardar</button></div>`);
      $('#bc-q', m).oninput = (e) => { const q = e.target.value.toLowerCase(); m.querySelectorAll('#bc-l label').forEach((l) => (l.style.display = l.dataset.n.includes(q) ? '' : 'none')); };
      $('#bc-ok', m).onclick = async () => { const ocultos = [...m.querySelectorAll('#bc-l input')].filter((i) => !i.checked).map((i) => i.value);
        try { await api('/api/bolsa/config' + qs(), { method: 'PUT', body: { ocultos } }); closeModal(); toast('Listo'); cargar(); } catch (err) { toast(err.message, true); } };
    };
    const cambiarDemo = (e) => { if (e) e.preventDefault(); demo = !demo; history.replaceState(null, '', '#/bolsa' + (demo ? '?demo=1' : '')); previo = new Map(); vistos = null; crashVisto = null; cola = []; $('#bv-body').innerHTML = '<div class="bv-vacio">Abriendo el mercado…</div>'; cargar(); };
    $('#bv-demo').onclick = () => cambiarDemo(); $('#bv-demo-salir').onclick = cambiarDemo;
    if ($('#bv-crash')) $('#bv-crash').onclick = async () => {
      if (crashAct && new Date(crashAct.hasta) > new Date()) { try { await api('/api/bolsa/crash' + qs(), { method: 'DELETE' }); crashAct = null; toast('Crash terminado: los precios se recuperan en 10 minutos'); cargar(); } catch (err) { toast(err.message, true); } return; }
      const m = modal(`<h2>💥 Lanzar un CRASH</h2><p>Todos los precios de la bolsa de esta sucursal (tragos y pizzas) se desploman durante unos minutos. Al terminar se recuperan de a poco en 10 minutos. Los precios de Fudo no cambian.</p>
        <div class="f"><label>Cuánto bajan</label><div class="bv-opc" id="cr-caida">${[20, 30, 40, 50].map((v) => `<button type="button" data-v="${v}" class="${v === 30 ? 'on' : ''}">−${v}%</button>`).join('')}</div></div>
        <div class="f mt"><label>Durante</label><div class="bv-opc" id="cr-min">${[5, 10, 15, 20, 30].map((v) => `<button type="button" data-v="${v}" class="${v === 10 ? 'on' : ''}">${v} min</button>`).join('')}</div></div>
        <div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn" id="cr-ok">💥 ¡Crash!</button></div>`);
      m.querySelectorAll('.bv-opc').forEach((g) => g.querySelectorAll('button').forEach((b) => (b.onclick = () => { g.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); })));
      $('#cr-ok', m).onclick = async () => { const caida = Number(m.querySelector('#cr-caida .on').dataset.v), minutos = Number(m.querySelector('#cr-min .on').dataset.v);
        try { await api('/api/bolsa/crash' + qs(), { method: 'POST', body: { caida, minutos } }); closeModal(); cargar(); } catch (err) { toast(err.message, true); } };
    };
    await cargar();
    let n = 0;
    VIEWS.bolsa._t = setInterval(() => {
      if (!location.hash.startsWith('#/bolsa')) { clearInterval(VIEWS.bolsa._t); document.body.classList.remove('tv', 'bolsa-on'); cola = []; const c = document.getElementById('bv-anim'); if (c) c.remove(); return; }
      reloj(); if (++n % (demo ? 8 : 20) === 0 && !document.hidden) cargar();
    }, 1000);
  };

  // ---------- Manuales ----------
  const MANUALES = [
    { id: 'empleado', titulo: 'Manual del Empleado', para: 'Todo el personal', desc: 'Ingresar a la app, pedir adelantos, vacaciones y licencias, seguir las solicitudes y ver las horas trabajadas.', paginas: 7, ok: () => true },
    { id: 'programador', titulo: 'Manual del Programador de días', para: 'Quien arma la programación', desc: 'Sucursales, asignación de empleados, grilla semanal, programar uno o varios días y copiar la semana.', paginas: 9, ok: () => puede('programacion') || puede('sucursales') },
    { id: 'conteo', titulo: 'Manual de Conteo de Inventario', para: 'Quien cuenta y quien aplica', desc: 'Crear un conteo, contar desde el celular entre varios, sumar, escanear códigos y revisar y aplicar las diferencias.', paginas: 7, ok: () => puede('contar') || puede('ajustar') },
    { id: 'checklist', titulo: 'Manual de Checklist de Apertura y Cierre', para: 'Personal del local y encargados', desc: 'Completar la apertura y el cierre desde el celular, anotar temperaturas y caja, finalizar, historial y plantillas.', paginas: 8, ok: () => true },
  ];
  VIEWS.manuales = async (main) => {
    const lista = MANUALES; // todos los manuales son públicos para todos los usuarios
    main.innerHTML = `<h1>Manuales</h1><p class="sub">Guías paso a paso de la app, con capturas de las pantallas. Se pueden ver en el celular, descargar o imprimir.</p>
      <div class="man-grid">${lista.map((m) => `<div class="card man-card">
        <a class="man-tapa" href="/manuales/manual-${m.id}.pdf" target="_blank" rel="noopener"><img src="/manuales/tapa-${m.id}.png" alt="Tapa del ${esc(m.titulo)}" loading="lazy"></a>
        <div class="man-info"><b>${esc(m.titulo)}</b><span class="badge">${esc(m.para)}</span><p>${esc(m.desc)}</p><small class="muted">PDF · ${m.paginas} páginas</small>
          <div class="man-acc"><a class="btn sm" href="/manuales/manual-${m.id}.pdf" target="_blank" rel="noopener">Ver</a><a class="btn sm sec" href="/manuales/manual-${m.id}.pdf" download="Vinilo - ${esc(m.titulo)}.pdf">Descargar</a></div></div></div>`).join('')}</div>`;
  };

  // ---------- Checklist de apertura y cierre ----------
  const CK_ICO = { APERTURA: '🌅', CIERRE: '🌙', OTRO: '📋' };
  const tabsCk = (act) => (puede('checklistConfig') ? `<div class="tabs"><a href="#/checklist" class="${act === 'hoy' ? 'on' : ''}">Hoy</a><a href="#/checklist?tab=historial" class="${act === 'historial' ? 'on' : ''}">Historial</a><a href="#/checklist?tab=plantillas" class="${act === 'plantillas' ? 'on' : ''}">Plantillas</a></div>` : '');
  VIEWS.checklist = async (main) => {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    if (q.get('r')) return vistaRegistroCk(main, Number(q.get('r')));
    if (q.get('tab') === 'historial' && puede('checklistConfig')) return historialCk(main);
    if (q.get('tab') === 'plantillas' && puede('checklistConfig')) return plantillasCk(main);
    let sel = q.get('s') || (() => { try { return localStorage.getItem('ck_suc'); } catch (_) { return null; } })();
    const d = await api('/api/checklist/hoy' + (sel ? '?sucursal_id=' + sel : ''));
    try { if (d.sucursal) localStorage.setItem('ck_suc', d.sucursal.id); } catch (_) { /* sin storage */ }
    const fechaLarga = (f) => new Date(f + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
    main.innerHTML = `${tabsCk('hoy')}<h1>Checklist del local</h1><p class="sub">Jornada del <b>${fechaLarga(d.jornada)}</b>${d.jornada !== hoyISO() ? ' (el cierre de la madrugada cuenta para el día en que abrió)' : ''}.</p>
      ${d.sucursales.length > 1 ? `<div class="ct-chips" style="margin-bottom:12px">${d.sucursales.map((s) => `<button class="ct-chip ${s.id === d.sucursal.id ? 'on' : ''}" data-s="${s.id}">${esc(s.nombre)}</button>`).join('')}</div>` : ''}
      ${!d.sucursales.length ? '<div class="card empty">No hay sucursales cargadas.</div>' : d.checklists.length ? `<div class="ck-cards">${d.checklists.map((c) => {
        const r = c.registro, pct = r ? Math.round((r.hechos / Math.max(1, c.items)) * 100) : 0, ok = r && r.estado === 'COMPLETO';
        return `<div class="card ck-card ${ok ? 'ok' : c.vencida ? 'venc' : ''}"><div class="ck-ico">${CK_ICO[c.tipo]}</div>
          <div class="ck-body"><div class="ck-tit"><b>${esc(c.nombre)}</b>${ok ? '<span class="badge b-COMPLETADO">Completo</span>' : c.vencida ? '<span class="badge b-RECHAZADO">Atrasado</span>' : r ? '<span class="badge b-PENDIENTE">En curso</span>' : ''}</div>
            <div class="ct-bar"><i style="width:${pct}%"></i></div>
            <small>${ok ? `✓ Finalizado por ${esc(r.completado_por || '')} · ${fmtFecha(r.completado_en)}` : r ? `${r.hechos} de ${c.items} tareas · empezado por ${esc(r.iniciado_por || '')}` : `${c.items} tareas${c.hora_limite ? ` · hasta las ${esc(c.hora_limite)}` : ''}`}</small></div>
          <button class="btn ${ok ? 'sec' : ''}" data-ck="${c.plantilla_id}">${ok ? 'Ver' : r ? 'Continuar' : 'Empezar'}</button></div>`; }).join('')}</div>`
        : '<div class="card empty">No hay checklists para esta sucursal.</div>'}`;
    $$('[data-s]').forEach((b) => b.onclick = () => { location.hash = '#/checklist?s=' + b.dataset.s; });
    $$('[data-ck]').forEach((b) => b.onclick = async () => {
      const c = d.checklists.find((x) => x.plantilla_id == b.dataset.ck);
      if (c.registro) { location.hash = '#/checklist?r=' + c.registro.id; return; }
      try { const r = await api('/api/checklist/abrir', { method: 'POST', body: { plantilla_id: c.plantilla_id, sucursal_id: d.sucursal.id, jornada: d.jornada } }); location.hash = '#/checklist?r=' + r.id; }
      catch (err) { toast(err.message, true); }
    });
  };

  async function vistaRegistroCk(main, id) {
    let d = await api('/api/checklist/registros/' + id);
    const pend = new Map();
    const pintar = () => {
      const oblig = d.items.filter((i) => i.obligatorio), hechos = d.items.filter((i) => i.hecho).length, faltan = oblig.filter((i) => !i.hecho).length;
      const secciones = [...new Set(d.items.map((i) => i.seccion || ''))];
      main.innerHTML = `<div class="ct-top"><div class="ct-titulo"><a href="#/checklist${d.estado === 'COMPLETO' || !d.editable ? '' : ''}" class="ct-back">←</a>
          <div><b>${CK_ICO[d.tipo]} ${esc(d.nombre)} · ${esc(d.sucursal)}</b><small>Jornada ${fmtDia(d.jornada)}${d.estado === 'COMPLETO' ? ` · ✓ Finalizado por ${esc(d.completado_por || '')}, ${fmtFecha(d.completado_en)}` : d.vencida ? ' · <b style="color:var(--accent)">atrasado</b>' : ''}</small></div>
          ${d.estado !== 'COMPLETO' ? '<button class="btn ghost sm" id="ck-ref" title="Actualizar">🔄</button>' : ''}</div>
        <div class="ct-bar"><i style="width:${Math.round((hechos / Math.max(1, d.items.length)) * 100)}%"></i></div>
        <div class="ct-prog"><b>${hechos}</b> de ${d.items.length} tareas${faltan && d.estado !== 'COMPLETO' ? ` · faltan <b>${faltan}</b> obligatorias` : ''}</div></div>
        ${secciones.map((sec) => `${sec ? `<h3 class="ck-sec">${esc(sec)}</h3>` : ''}<div class="ck-lista">${d.items.filter((i) => (i.seccion || '') === sec).map((i) => `
          <div class="ck-item ${i.hecho ? 'hecho' : ''}" data-i="${i.id}">
            <button class="ck-box" ${d.editable ? '' : 'disabled'} aria-label="Marcar">${i.hecho ? '✓' : ''}</button>
            <div class="ck-txt"><span>${esc(i.texto)}${i.obligatorio ? '' : ' <em>(opcional)</em>'}</span>
              ${i.tipo_valor ? `<div class="ck-val"><input ${i.tipo_valor === 'NUMERO' ? 'inputmode="decimal"' : ''} value="${esc(i.valor || '')}" placeholder="${i.tipo_valor === 'NUMERO' ? 'Valor' : 'Escribí acá'}" ${d.editable ? '' : 'disabled'}>${i.unidad ? `<b>${esc(i.unidad)}</b>` : ''}</div>` : ''}
              ${i.nota ? `<div class="ck-nota">📝 ${esc(i.nota)}</div>` : ''}
              <small>${i.hecho_por ? `${i.hecho ? '✓' : '↺'} ${esc(i.hecho_por)} · ${new Date(i.hecho_en).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}` : ''}${d.editable ? ` <a href="#" data-nota>${i.nota ? 'editar nota' : '+ nota'}</a>` : ''}</small></div></div>`).join('')}</div>`).join('')}
        ${d.observacion ? `<div class="card mt"><b>Observaciones:</b> ${esc(d.observacion)}</div>` : ''}
        <div style="height:90px"></div>
        <div class="ct-pie">${d.estado === 'COMPLETO' ? `<a class="btn sec" href="#/checklist">Volver</a>${puede('checklistConfig') ? '<button class="btn ghost sm" id="ck-reabrir">Reabrir</button>' : ''}`
          : d.editable ? `<button class="btn" id="ck-fin" ${faltan ? 'disabled' : ''}>${faltan ? `Faltan ${faltan} obligatorias` : 'Finalizar checklist'}</button>` : '<a class="btn sec" href="#/checklist">Volver</a>'}</div>`;
      enlazar();
    };
    const guardar = (i, body, inmediato) => {
      clearTimeout(pend.get(i.id));
      pend.set(i.id, setTimeout(async () => {
        try { const r = await api(`/api/checklist/registros/${id}/items/${i.id}`, { method: 'PUT', body }); pend.delete(i.id);
          Object.assign(i, { hecho: r.hecho, valor: r.valor, hecho_por: r.hecho_por, hecho_en: new Date().toISOString() }); if (body.nota !== undefined) i.nota = body.nota || null;
          const y = window.scrollY; pintar(); window.scrollTo(0, y); }
        catch (err) { pend.delete(i.id); toast(err.message, true); const y = window.scrollY; pintar(); window.scrollTo(0, y); }
      }, inmediato ? 0 : 700));
    };
    const enlazar = () => {
      $$('.ck-item').forEach((row) => {
        const i = d.items.find((x) => x.id == row.dataset.i); const inp = $('.ck-val input', row);
        $('.ck-box', row).onclick = () => {
          if (!i.hecho && i.tipo_valor && i.obligatorio && !(inp && inp.value.trim())) { toast(`Anotá ${i.unidad ? 'el valor en ' + i.unidad : 'el dato'} primero`, true); if (inp) inp.focus(); return; }
          if (navigator.vibrate) navigator.vibrate(30);
          row.classList.toggle('hecho', !i.hecho); $('.ck-box', row).textContent = i.hecho ? '' : '✓';
          guardar(i, { hecho: !i.hecho, valor: inp ? inp.value : i.valor }, true);
        };
        if (inp) inp.addEventListener('input', () => guardar(i, { hecho: !!inp.value.trim() || (!i.tipo_valor && i.hecho), valor: inp.value }));
        const n = $('[data-nota]', row);
        if (n) n.onclick = (e) => { e.preventDefault();
          const m = modal(`<h2>Nota</h2><p class="sub" style="margin-top:-6px">${esc(i.texto)}</p><form id="f-nt2"><textarea name="t" maxlength="300" rows="3" autofocus placeholder="Ej.: falta reponer jabón, heladera 2 hace ruido…">${esc(i.nota || '')}</textarea>
            <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`);
          $('#f-nt2', m).addEventListener('submit', (ev) => { ev.preventDefault(); closeModal(); guardar(i, { hecho: i.hecho, valor: i.valor, nota: ev.target.t.value }, true); }); };
      });
      if ($('#ck-ref')) $('#ck-ref').onclick = async () => { d = await api('/api/checklist/registros/' + id); pintar(); toast('Actualizado'); };
      if ($('#ck-fin')) $('#ck-fin').onclick = () => {
        const m = modal(`<h2>Finalizar ${esc(d.nombre.toLowerCase())}</h2><p class="sub" style="margin-top:-6px">${esc(d.sucursal)} · jornada ${fmtDia(d.jornada)}</p>
          <form id="f-fin"><div class="f"><label>Observaciones (opcional)</label><textarea name="o" maxlength="1000" rows="3" placeholder="Novedades, faltantes, algo para avisar…"></textarea></div>
          <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Finalizar</button></div></form>`);
        $('#f-fin', m).addEventListener('submit', async (e) => { e.preventDefault();
          try { await api(`/api/checklist/registros/${id}/completar`, { method: 'POST', body: { observacion: e.target.o.value } }); closeModal(); toast('Checklist finalizado ✅'); location.hash = '#/checklist'; }
          catch (err) { toast(err.message, true); } });
      };
      if ($('#ck-reabrir')) $('#ck-reabrir').onclick = async () => { try { await api(`/api/checklist/registros/${id}/reabrir`, { method: 'POST' }); d = await api('/api/checklist/registros/' + id); pintar(); toast('Checklist reabierto'); } catch (err) { toast(err.message, true); } };
    };
    pintar();
    clearInterval(VIEWS.checklist._t);
    if (d.estado !== 'COMPLETO') VIEWS.checklist._t = setInterval(async () => {
      if (!location.hash.startsWith('#/checklist?r=' + id)) return clearInterval(VIEWS.checklist._t);
      if (pend.size || (document.activeElement && document.activeElement.closest && document.activeElement.closest('.ck-item, .modal'))) return;
      try { const y = window.scrollY; d = await api('/api/checklist/registros/' + id); pintar(); window.scrollTo(0, y); } catch (_) { /* sin conexión */ }
    }, 20000);
  }

  async function historialCk(main) {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const d = await api('/api/checklist/historial?' + new URLSearchParams({ desde: q.get('desde') || '', hasta: q.get('hasta') || '' }));
    main.innerHTML = `${tabsCk('historial')}<h1>Historial de checklists</h1><p class="sub">Del ${fmtDia(d.desde)} al ${fmtDia(d.hasta)}.</p>
      <div class="toolbar"><div class="f"><label>Desde</label><input type="date" id="hc-d" value="${d.desde}"></div><div class="f"><label>Hasta</label><input type="date" id="hc-h" value="${d.hasta}"></div><button class="btn sec" id="hc-ok">Ver</button></div>
      ${d.faltantes.length ? `<div class="card" style="background:#fdeceb;border-color:#f3c5c2"><b>⚠️ ${d.faltantes.length} ${d.faltantes.length === 1 ? 'checklist sin hacer' : 'checklists sin hacer'}</b><div class="stock-hint" style="margin-top:4px">${d.faltantes.slice(0, 12).map((f) => `${fmtDia(f.jornada).slice(0, 5)} ${esc(f.nombre)} ${esc(f.sucursal)}`).join(' · ')}${d.faltantes.length > 12 ? '…' : ''}</div></div>` : ''}
      ${d.registros.length ? `<div class="tbl-wrap mt"><table><thead><tr><th>Jornada</th><th>Sucursal</th><th>Checklist</th><th>Estado</th><th class="num">Hechas</th><th>Finalizado</th><th>Valores</th><th></th></tr></thead><tbody>
        ${d.registros.map((r) => `<tr><td style="white-space:nowrap">${diaSem(r.jornada)} ${fmtDia(r.jornada)}</td><td>${esc(r.sucursal)}</td><td>${CK_ICO[r.tipo]} ${esc(r.nombre)}</td>
          <td><span class="badge ${r.estado === 'COMPLETO' ? 'b-COMPLETADO' : 'b-PENDIENTE'}">${r.estado === 'COMPLETO' ? 'Completo' : 'Incompleto'}</span></td><td class="num">${r.hechos}/${r.items}</td>
          <td class="muted">${r.completado_en ? `${esc(r.completado_por || '')} · ${new Date(r.completado_en).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}` : ''}</td>
          <td style="font-size:.8rem;max-width:300px">${esc(r.valores || '')}${r.observacion ? `<div class="muted">📝 ${esc(r.observacion)}</div>` : ''}</td><td><a class="btn ghost sm" href="#/checklist?r=${r.id}">Ver</a></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="card empty mt">No hay checklists en ese período.</div>'}`;
    $('#hc-ok').onclick = () => { location.hash = `#/checklist?tab=historial&desde=${$('#hc-d').value}&hasta=${$('#hc-h').value}`; };
  }

  async function plantillasCk(main) {
    const [pls, sucs] = await Promise.all([api('/api/checklist/plantillas'), api('/api/sucursales')]);
    main.innerHTML = `${tabsCk('plantillas')}<h1>Plantillas de checklist</h1><p class="sub">Qué tareas tiene cada checklist. Los cambios se aplican desde el próximo checklist que se empiece.</p>
      <div class="toolbar"><div class="spacer"></div><button class="btn" id="pl-new">+ Nueva plantilla</button></div>
      <div class="ck-cards">${pls.map((p) => `<div class="card ck-card ${p.activo ? '' : 'inactive'}"><div class="ck-ico">${CK_ICO[p.tipo]}</div>
        <div class="ck-body"><div class="ck-tit"><b>${esc(p.nombre)}</b>${p.activo ? '' : '<span class="badge">Inactiva</span>'}</div>
          <small>${p.items.length} tareas · ${esc(p.sucursal || 'Todas las sucursales')}${p.hora_limite ? ` · hasta las ${esc(p.hora_limite)}` : ''}</small></div>
        <button class="btn sec" data-pl="${p.id}">Editar</button></div>`).join('')}</div>`;
    const editar = (p) => {
      p = p || { nombre: '', tipo: 'OTRO', sucursal_id: null, hora_limite: '', activo: true, items: [{ seccion: '', texto: '', tipo_valor: null, unidad: '', obligatorio: true }] };
      let items = p.items.map((x) => ({ ...x }));
      const m = modal(`<h2>${p.id ? 'Editar plantilla' : 'Nueva plantilla'}</h2><form id="f-pl">
        <div class="row"><div class="f"><label>Nombre *</label><input name="nombre" maxlength="80" required value="${esc(p.nombre)}"></div>
          <div class="f s"><label>Tipo</label><select name="tipo">${['APERTURA', 'CIERRE', 'OTRO'].map((t) => `<option value="${t}" ${p.tipo === t ? 'selected' : ''}>${CK_ICO[t]} ${t === 'OTRO' ? 'Otro' : t[0] + t.slice(1).toLowerCase()}</option>`).join('')}</select></div>
          <div class="f"><label>Sucursal</label><select name="sucursal_id"><option value="">Todas</option>${sucs.filter((s) => s.activo).map((s) => `<option value="${s.id}" ${p.sucursal_id === s.id ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></div>
          <div class="f s"><label>Hora límite</label><input type="time" name="hora_limite" value="${esc(p.hora_limite || '')}"></div></div>
        <h3 class="mt" style="margin-bottom:6px">Tareas</h3><div id="pl-items" class="pl-items"></div><button type="button" class="btn ghost sm" id="pl-add">+ Agregar tarea</button>
        ${p.id ? `<label class="check mt"><input type="checkbox" name="activo" ${p.activo ? 'checked' : ''}> Activa</label>` : ''}
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`, { wide: true });
      const leer = () => { $$('.pl-it', m).forEach((r, n) => { Object.assign(items[n], { seccion: $('[data-k=seccion]', r).value, texto: $('[data-k=texto]', r).value, tipo_valor: $('[data-k=tipo]', r).value || null, unidad: $('[data-k=unidad]', r).value, obligatorio: $('[data-k=obl]', r).checked }); }); };
      const pintarIt = () => {
        $('#pl-items', m).innerHTML = items.map((x, n) => `<div class="pl-it"><input data-k="seccion" placeholder="Sección" value="${esc(x.seccion || '')}" maxlength="60" list="pl-secs">
          <input data-k="texto" placeholder="Tarea" value="${esc(x.texto || '')}" maxlength="200" class="pl-txt">
          <select data-k="tipo"><option value="">Tildar</option><option value="NUMERO" ${x.tipo_valor === 'NUMERO' ? 'selected' : ''}>Número</option><option value="TEXTO" ${x.tipo_valor === 'TEXTO' ? 'selected' : ''}>Texto</option></select>
          <input data-k="unidad" placeholder="°C, $…" value="${esc(x.unidad || '')}" maxlength="20" class="pl-un">
          <label class="check" title="Obligatoria"><input type="checkbox" data-k="obl" ${x.obligatorio ? 'checked' : ''}> Oblig.</label>
          <span class="pl-bt"><button type="button" data-up="${n}" title="Subir">↑</button><button type="button" data-dn="${n}" title="Bajar">↓</button><button type="button" data-rm="${n}" title="Quitar">✕</button></span></div>`).join('')
          + `<datalist id="pl-secs">${[...new Set(items.map((x) => x.seccion).filter(Boolean))].map((s) => `<option value="${esc(s)}">`).join('')}</datalist>`;
        $$('[data-up]', m).forEach((b) => b.onclick = () => { leer(); const n = +b.dataset.up; if (n > 0) [items[n - 1], items[n]] = [items[n], items[n - 1]]; pintarIt(); });
        $$('[data-dn]', m).forEach((b) => b.onclick = () => { leer(); const n = +b.dataset.dn; if (n < items.length - 1) [items[n + 1], items[n]] = [items[n], items[n + 1]]; pintarIt(); });
        $$('[data-rm]', m).forEach((b) => b.onclick = () => { leer(); items.splice(+b.dataset.rm, 1); pintarIt(); });
      };
      pintarIt();
      $('#pl-add', m).onclick = () => { leer(); items.push({ seccion: items.length ? items[items.length - 1].seccion : '', texto: '', tipo_valor: null, unidad: '', obligatorio: true }); pintarIt(); $$('[data-k=texto]', m).at(-1).focus(); };
      $('#f-pl', m).addEventListener('submit', async (e) => { e.preventDefault(); leer(); const f = e.target;
        try { await api(p.id ? '/api/checklist/plantillas/' + p.id : '/api/checklist/plantillas', { method: p.id ? 'PUT' : 'POST', body: { nombre: f.nombre.value, tipo: f.tipo.value, sucursal_id: f.sucursal_id.value || null,
          hora_limite: f.hora_limite.value, activo: f.activo ? f.activo.checked : true, orden: p.orden || 0, items } }); closeModal(); toast('Plantilla guardada'); router(); }
        catch (err) { toast(err.message, true); } });
    };
    $('#pl-new').onclick = () => editar(null);
    $$('[data-pl]').forEach((b) => b.onclick = () => editar(pls.find((p) => p.id == b.dataset.pl)));
  }

  // ---------- Notificaciones push programadas ----------
  const DIAS_C = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']];
  const PANTALLAS = [['', 'Inicio (panel)'], ['#/conteo', 'Conteo de inventario'], ['#/checklist', 'Checklist'], ['#/stock', 'Stock por almacén'], ['#/pedidos', 'Notas de pedido'],
    ['#/programacion', 'Programación'], ['#/mis-horas', 'Mis horas'], ['#/mis-solicitudes', 'Mis solicitudes'], ['#/solicitudes', 'Solicitudes del personal'], ['#/consumos-fudo', 'Consumos desde Fudo']];
  const diasTxt = (ds) => { const s = [...ds].sort().join(','); if (s === '0,1,2,3,4,5,6') return 'Todos los días'; if (s === '1,2,3,4,5') return 'Lunes a viernes'; if (s === '0,3,4,5,6') return 'Miércoles a domingo'; if (s === '0,4,5,6') return 'Jueves a domingo'; if (s === '0,6') return 'Fines de semana';
    return DIAS_C.filter(([n]) => ds.includes(n)).map(([, l]) => l).join(', '); };
  VIEWS.notificaciones = async (main) => {
    const [d, roles] = await Promise.all([api('/api/push/programadas'), api('/api/roles')]);
    const nomRol = (c) => (roles.find((r) => r.codigo === c) || { nombre: c }).nombre;
    const rolesTxt = (rs) => (rs.length ? rs.map(nomRol).join(', ') : 'Todos los usuarios');
    main.innerHTML = `<h1>Notificaciones push</h1><p class="sub">Avisos que llegan al celular de cada usuario, aunque la app esté cerrada. Se programan por rol, días y hora.</p>
      <div class="card" style="background:#eaf2fa;border-color:#c9d6e3"><b>¿Quiénes las reciben?</b> Solo quienes las activaron en su celular (botón <b>🔔 Activar</b> del panel).
        <div class="push-roles">${d.por_rol.map((r) => `<span><b>${esc(nomRol(r.rol))}</b> ${r.activados}/${r.usuarios}</span>`).join('')}</div></div>
      <div class="toolbar mt"><button class="btn sec" id="nt-ya">Enviar ahora…</button><div class="spacer"></div><button class="btn" id="nt-new">+ Nueva programada</button></div>
      ${d.programadas.length ? `<div class="nt-lista">${d.programadas.map((p) => `<div class="card nt-card ${p.activo ? '' : 'inactive'}">
        <div class="nt-hora"><b>${esc(p.hora)}</b><small>${esc(diasTxt(p.dias))}</small></div>
        <div class="nt-cuerpo"><div class="nt-prev"><img src="/icon-192.png" alt=""><div><b>${esc(p.titulo)}</b><span>${esc(p.mensaje)}</span></div></div>
          <div class="muted" style="font-size:.82rem;margin-top:6px">👥 ${esc(rolesTxt(p.roles))}${p.link ? ` · abre ${esc((PANTALLAS.find(([v]) => v === p.link) || ['', p.link])[1])}` : ''}${p.ultimo_envio ? ` · último envío ${fmtFecha(p.ultimo_envio)}` : ''}</div></div>
        <div class="nt-acc"><label class="switch" title="${p.activo ? 'Activa' : 'Pausada'}"><input type="checkbox" data-act="${p.id}" ${p.activo ? 'checked' : ''}><i></i></label>
          <button class="btn ghost sm" data-send="${p.id}">Enviar ahora</button><button class="btn ghost sm" data-ed="${p.id}">Editar</button></div></div>`).join('')}</div>`
        : '<div class="card empty">Todavía no hay notificaciones programadas. Creá la primera, por ejemplo: “Recordar realizar conteo” de miércoles a domingo a la 1:00.</div>'}
      <div class="tip-lic mt" style="background:#eef2f6;border-left-color:#165f96">ℹ️ Se envían a la hora de Argentina. Si el servidor estaba en reposo, la notificación sale apenas se activa, hasta 20 minutos después de la hora programada.</div>
      ${d.envios.length ? `<h2 class="mt" style="margin-top:20px">Últimos envíos</h2><div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Notificación</th><th>Para</th><th class="num">Recibidas</th><th class="num">Sin activar</th></tr></thead><tbody>
        ${d.envios.map((e) => `<tr><td class="muted" style="white-space:nowrap">${fmtFecha(e.creado_en)}</td><td><b>${esc(e.titulo || '')}</b> <span class="badge">${e.origen === 'PROGRAMADA' ? 'Programada' : e.origen === 'MANUAL' ? 'Manual' : 'Prueba'}</span><div class="muted" style="font-size:.82rem">${esc(e.mensaje || '')}</div></td>
          <td>${e.origen === 'PRUEBA' ? esc(e.enviado_por_nombre || '') : esc(rolesTxt(String(e.roles || '').split(',').filter(Boolean)))}</td><td class="num"><b>${e.enviados}</b>${Number(e.fallidos) ? ` <span style="color:var(--accent)">(${e.fallidos} fallidas)</span>` : ''}</td><td class="num">${e.sin_activar}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    const form = (p, soloEnviar = false) => {
      p = p || { titulo: '', mensaje: '', link: '', roles: [], dias: [0, 3, 4, 5, 6], hora: '01:00', activo: true };
      const m = modal(`<h2>${soloEnviar ? 'Enviar ahora' : p.id ? 'Editar notificación' : 'Nueva notificación programada'}</h2><form id="f-nt">
        <div class="row"><div class="f"><label>Título *</label><input name="titulo" maxlength="80" required value="${esc(p.titulo)}" placeholder="Ej.: Conteo"></div>
          <div class="f"><label>Al tocarla abre</label><select name="link">${PANTALLAS.map(([v, l]) => `<option value="${v}" ${p.link === v || (!p.link && !v) ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <div class="f mt"><label>Mensaje *</label><textarea name="mensaje" maxlength="300" rows="2" required placeholder="Ej.: Recordar realizar conteo">${esc(p.mensaje)}</textarea></div>
        ${soloEnviar ? '' : `<div class="f mt"><label>Días</label><div class="dias-sel">${DIAS_C.map(([n, l]) => `<label><input type="checkbox" name="dia" value="${n}" ${p.dias.includes(n) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
          <div class="nt-rap"><a href="#" data-r="0,1,2,3,4,5,6">Todos</a><a href="#" data-r="1,2,3,4,5">Lun a vie</a><a href="#" data-r="0,3,4,5,6">Mié a dom</a><a href="#" data-r="0,4,5,6">Jue a dom</a><a href="#" data-r="0,6">Fin de semana</a></div></div>
          <div class="row mt"><div class="f s"><label>Hora</label><input type="time" name="hora" value="${esc(p.hora)}" required></div>
          <div class="f"><p class="stock-hint" style="margin:24px 0 0">La 1:00 del miércoles es la madrugada del martes al miércoles.</p></div></div>`}
        <div class="f mt"><label>Para los roles <span class="muted" style="font-weight:400">(sin marcar = todos)</span></label><div class="chk-grupo">${roles.filter((r) => r.codigo !== 'PROVEEDOR').map((r) => `<label class="check"><input type="checkbox" name="rol" value="${esc(r.codigo)}" ${p.roles.includes(r.codigo) ? 'checked' : ''}> ${esc(r.nombre)}</label>`).join('')}</div></div>
        <div class="nt-prev mt" id="nt-prev"></div>
        ${!soloEnviar && p.id ? `<label class="check mt"><input type="checkbox" name="activo" ${p.activo ? 'checked' : ''}> Activa</label>` : ''}
        <div class="form-actions">${!soloEnviar && p.id ? '<button type="button" class="btn ghost" id="nt-del" style="margin-right:auto;color:var(--accent)">Eliminar</button>' : ''}
          <button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">${soloEnviar ? 'Enviar' : 'Guardar'}</button></div></form>`, { wide: true });
      const f = $('#f-nt', m);
      const prev = () => { $('#nt-prev', m).innerHTML = `<img src="/icon-192.png" alt=""><div><b>${esc(f.titulo.value || 'Título')}</b><span>${esc(f.mensaje.value || 'Mensaje')}</span></div>`; };
      [f.titulo, f.mensaje].forEach((i) => i.addEventListener('input', prev)); prev();
      $$('[data-r]', m).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const set = a.dataset.r.split(','); $$('input[name=dia]', f).forEach((c) => { c.checked = set.includes(c.value); }); }));
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { titulo: f.titulo.value, mensaje: f.mensaje.value, link: f.link.value, roles: $$('input[name=rol]:checked', f).map((c) => c.value) };
        try {
          if (soloEnviar) { const r = await api('/api/push/enviar', { method: 'POST', body }); closeModal(); toast(`Enviada a ${r.enviados} ${r.enviados === 1 ? 'dispositivo' : 'dispositivos'}${r.sin_activar ? ` · ${r.sin_activar} sin activar` : ''}`); return router(); }
          Object.assign(body, { dias: $$('input[name=dia]:checked', f).map((c) => Number(c.value)), hora: f.hora.value, activo: f.activo ? f.activo.checked : true });
          await api(p.id ? '/api/push/programadas/' + p.id : '/api/push/programadas', { method: p.id ? 'PUT' : 'POST', body });
          closeModal(); toast('Notificación guardada'); router();
        } catch (err) { toast(err.message, true); }
      });
      if ($('#nt-del', m)) $('#nt-del', m).onclick = async () => { if (!confirm('¿Eliminar esta notificación programada?')) return; try { await api('/api/push/programadas/' + p.id, { method: 'DELETE' }); closeModal(); toast('Eliminada'); router(); } catch (err) { toast(err.message, true); } };
    };
    $('#nt-new').onclick = () => form(null);
    $('#nt-ya').onclick = () => form(null, true);
    $$('[data-ed]').forEach((b) => b.addEventListener('click', () => form(d.programadas.find((p) => p.id == b.dataset.ed))));
    $$('[data-send]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await api(`/api/push/programadas/${b.dataset.send}/enviar`, { method: 'POST' }); toast(`Enviada a ${r.enviados} ${r.enviados === 1 ? 'dispositivo' : 'dispositivos'}${r.sin_activar ? ` · ${r.sin_activar} sin activar` : ''}`); router(); }
      catch (err) { toast(err.message, true); }
    }));
    $$('[data-act]').forEach((c) => c.addEventListener('change', async () => {
      const p = d.programadas.find((x) => x.id == c.dataset.act);
      try { await api('/api/push/programadas/' + p.id, { method: 'PUT', body: { ...p, activo: c.checked } }); toast(c.checked ? 'Activada' : 'Pausada'); router(); } catch (err) { toast(err.message, true); c.checked = !c.checked; }
    }));
  };

  // ---------- Conteo de inventario (celular) ----------
  VIEWS.conteo = async (main) => {
    const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
    if (id) return vistaContar(main, Number(id));
    const lista = await api('/api/conteos');
    const enCurso = lista.filter((c) => c.estado === 'EN_CURSO'), hist = lista.filter((c) => c.estado !== 'EN_CURSO');
    const pct = (c) => (c.total ? Math.min(100, Math.round((c.contados / c.total) * 100)) : 0);
    main.innerHTML = `<h1>Conteo de inventario</h1><p class="sub">Contá el stock desde el celular. Pueden contar varias personas a la vez: cada producto se guarda al instante.${puede('ajustar') ? ' Al terminar, revisás las diferencias y aplicás el conteo.' : ''}</p>
      ${puede('contar') ? '<div class="toolbar"><div class="spacer"></div><button class="btn" id="ct-new">+ Nuevo conteo</button></div>' : ''}
      ${enCurso.length ? `<div class="ct-cards">${enCurso.map((c) => `<a class="card ct-card" href="#/conteo?id=${c.id}">
          <div class="ct-card-top"><b>${esc(c.almacen)}</b><span class="badge b-PENDIENTE">En curso</span></div>
          <div class="muted" style="font-size:.85rem">${c.categoria ? esc(c.categoria) + ' · ' : 'Todos los productos · '}${c.ciego ? 'ciego' : 'con stock visible'} · por ${esc(c.creado_por)}, ${fmtFecha(c.creado_en)}</div>
          <div class="ct-bar"><i style="width:${pct(c)}%"></i></div><div class="ct-card-foot"><span><b>${c.contados}</b> de ${c.total} contados${c.personas ? ` · ${c.personas} ${c.personas === 1 ? 'persona' : 'personas'}` : ''}</span><span class="btn sm">Contar →</span></div></a>`).join('')}</div>`
        : '<div class="card empty">No hay conteos en curso.</div>'}
      ${hist.length ? `<h2 class="mt" style="margin-top:22px">Historial</h2><div class="tbl-wrap"><table><thead><tr><th>#</th><th>Almacén</th><th>Alcance</th><th>Estado</th><th class="num">Contados</th><th>Cerrado</th><th></th></tr></thead><tbody>
        ${hist.map((c) => `<tr><td>${c.id}</td><td><b>${esc(c.almacen)}</b></td><td>${esc(c.categoria || 'Todos')}</td><td><span class="badge ${c.estado === 'APLICADO' ? 'b-COMPLETADO' : ''}">${c.estado === 'APLICADO' ? 'Aplicado' : 'Anulado'}</span></td>
          <td class="num">${c.contados}</td><td class="muted">${c.cerrado_en ? fmtFecha(c.cerrado_en) : ''}${c.cerrado_por ? ' · ' + esc(c.cerrado_por) : ''}</td>
          <td class="num"><a class="btn ghost sm" href="#/conteo?id=${c.id}">Ver</a></td></tr>`).join('')}</tbody></table></div>` : ''}`;
    if ($('#ct-new')) $('#ct-new').onclick = async () => {
      const prods = await api('/api/productos');
      const cats = [...new Set(prods.map((p) => p.categoria).filter(Boolean))].sort();
      const alms = S.almacenes.filter((a) => a.activo);
      const m = modal(`<h2>Nuevo conteo</h2><form id="f-ct">
        <div class="f"><label>Almacén</label><select name="almacen_id">${alms.map((a) => `<option value="${a.id}">${esc(a.nombre)}</option>`).join('')}</select></div>
        <div class="f mt"><label>Qué se cuenta</label><select name="categoria"><option value="">Todos los productos con gestión de stock</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        ${puede('ajustar') ? '<label class="check mt"><input type="checkbox" name="ciego" checked> Conteo ciego: quien cuenta no ve el stock del sistema (recomendado)</label>' : ''}
        <div class="f mt"><label>Observación</label><input name="observacion" maxlength="500" placeholder="Ej.: conteo mensual, cierre de noviembre"></div>
        <p class="stock-hint mt">Conviene contar con el local cerrado o sin movimientos: al aplicar, el stock pasa a ser lo contado.</p>
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Empezar a contar</button></div></form>`);
      $('#f-ct', m).addEventListener('submit', async (e) => {
        e.preventDefault(); const f = e.target;
        try {
          const r = await api('/api/conteos', { method: 'POST', body: { almacen_id: Number(f.almacen_id.value), categoria: f.categoria.value, ciego: f.ciego ? f.ciego.checked : true, observacion: f.observacion.value } });
          closeModal(); location.hash = '#/conteo?id=' + r.id;
        } catch (err) { toast(err.message, true); }
      });
    };
  };

  async function vistaContar(main, id) {
    let d = await api('/api/conteos/' + id);
    const abierto = d.estado === 'EN_CURSO';
    const st = { filtro: abierto ? 'pend' : 'todos', q: '', cat: '' };
    const pend = new Map(); // producto_id → timeout de guardado
    const prodPorId = () => new Map(d.productos.map((p) => [p.id, p]));
    const cats = [...new Set(d.productos.map((p) => p.categoria).filter(Boolean))];
    const scan = 'BarcodeDetector' in window;
    main.innerHTML = `<div class="ct-top">
        <div class="ct-titulo"><a href="#/conteo" class="ct-back">←</a><div><b>${esc(d.almacen)}</b><small>Conteo #${d.id}${d.categoria ? ' · ' + esc(d.categoria) : ''}${abierto ? (d.ciego && !d.ve_sistema ? ' · ciego' : '') : ` · ${d.estado === 'APLICADO' ? 'Aplicado' : 'Anulado'}`}</small></div>
          ${abierto ? '<button class="btn ghost sm" id="ct-ref" title="Actualizar">🔄</button>' : ''}</div>
        <div class="ct-bar"><i id="ct-bar"></i></div><div class="ct-prog" id="ct-prog"></div>
        ${abierto ? `<div class="ct-busca"><input id="ct-q" type="search" placeholder="Buscar o escanear código…" autocomplete="off" enterkeyhint="search">${scan ? '<button class="btn" id="ct-scan" title="Escanear con la cámara">📷</button>' : ''}</div>` : ''}
        <div class="ct-chips" id="ct-chips"></div>
        ${cats.length > 1 ? `<select id="ct-cat" class="ct-cat"><option value="">Todas las categorías</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select>` : ''}
      </div>
      <div id="ct-list" class="ct-list"></div>
      ${abierto ? `<div class="ct-pie">${d.puede_aplicar ? '<button class="btn" id="ct-aplicar">Revisar y aplicar</button>' : '<a class="btn" href="#/conteo">Terminé de contar</a>'}
        <button class="btn ghost sm" id="ct-anular">Anular</button></div>` : ''}`;
    const conDif = (p) => p.contado !== null && p.sistema !== null && p.contado !== p.sistema;
    const chips = () => {
      const c = d.productos.filter((p) => p.contado !== null).length, tot = d.productos.length;
      const dif = d.productos.filter(conDif).length;
      const opts = [['pend', `Pendientes ${tot - c}`], ['cont', `Contados ${c}`], ['todos', 'Todos']];
      if (d.ve_sistema) opts.push(['dif', `Con diferencia ${dif}`]);
      $('#ct-chips').innerHTML = opts.map(([k, l]) => `<button class="ct-chip ${st.filtro === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('');
      $$('[data-f]').forEach((b) => b.onclick = () => { st.filtro = b.dataset.f; pintar(); });
      const enAl = d.productos.filter((p) => p.en_alcance), cc = enAl.filter((p) => p.contado !== null).length;
      $('#ct-bar').style.width = (enAl.length ? Math.round((cc / enAl.length) * 100) : 0) + '%';
      $('#ct-prog').innerHTML = `<b>${cc}</b> de ${enAl.length} productos contados${dif && d.ve_sistema ? ` · <span style="color:var(--accent)">${dif} con diferencia</span>` : ''}`;
    };
    const fila = (p) => {
      const dif = conDif(p) ? p.contado - p.sistema : 0;
      return `<div class="ct-row ${p.contado !== null ? 'ok' : ''} ${dif ? 'dif' : ''}" data-p="${p.id}">
        <div class="ct-info"><b>${esc(p.nombre)}</b><small>${esc(p.codigo)}${p.categoria ? ' · ' + esc(p.categoria) : ''}${p.sistema !== null ? ` · sistema <b>${p.sistema}</b>` : ''}</small>
          <small class="ct-est">${p.contado !== null ? `✓ ${esc(p.contado_por || '')}${dif ? ` · <b>${dif > 0 ? '+' : ''}${dif}</b>` : ''}` : ''}</small></div>
        ${abierto ? `<div class="ct-qty"><button class="ct-b" data-a="-1" aria-label="Restar">−</button><input type="number" inputmode="numeric" min="0" step="1" value="${p.contado ?? ''}" placeholder="—" aria-label="Cantidad contada de ${esc(p.nombre)}"><button class="ct-b" data-a="1" aria-label="Sumar">+</button>
          <button class="ct-mas" data-sum title="Sumar lo encontrado en otro lugar">＋ sumar</button></div>`
          : `<div class="ct-final"><b>${p.contado ?? '—'}</b>${dif ? `<small style="color:var(--accent)">${dif > 0 ? '+' : ''}${dif}</small>` : ''}</div>`}</div>`;
    };
    const visibles = () => {
      const q = st.q.toLowerCase();
      return d.productos.filter((p) => (!st.cat || p.categoria === st.cat)
        && (!q || p.nombre.toLowerCase().includes(q) || p.codigo.toLowerCase().includes(q) || (p.codigo_barras || '').includes(q))
        && (st.filtro === 'todos' || (st.filtro === 'pend' && p.contado === null) || (st.filtro === 'cont' && p.contado !== null) || (st.filtro === 'dif' && conDif(p))));
    };
    const pintar = () => {
      chips();
      const v = visibles();
      $('#ct-list').innerHTML = v.length ? v.slice(0, 300).map(fila).join('') + (v.length > 300 ? `<p class="muted">Y ${v.length - 300} más: buscá para encontrarlos.</p>` : '')
        : `<div class="card empty">${st.filtro === 'pend' && !st.q ? '🎉 No quedan productos pendientes.' : 'Nada para mostrar con este filtro.'}</div>`;
      if (abierto) enlazar();
    };
    const guardar = (p, valor, sumar = false) => {
      const row = $(`.ct-row[data-p="${p.id}"]`);
      clearTimeout(pend.get(p.id));
      pend.set(p.id, setTimeout(async () => {
        if (row) row.classList.add('guardando');
        try {
          if (valor === null) { await api(`/api/conteos/${id}/items/${p.id}`, { method: 'DELETE' }); p.contado = null; p.contado_por = null; }
          else { const r = await api(`/api/conteos/${id}/items`, { method: 'PUT', body: { producto_id: p.id, cantidad: valor, sumar } }); p.contado = r.cantidad; p.contado_por = S.user.nombre; }
          pend.delete(p.id);
          const nr = $(`.ct-row[data-p="${p.id}"]`);
          if (nr) { const foco = document.activeElement && nr.contains(document.activeElement); nr.outerHTML = fila(p); if (abierto) enlazar(); if (foco) { const i = $(`.ct-row[data-p="${p.id}"] input`); if (i) i.focus(); } }
          chips();
        } catch (err) { toast(err.message, true); if (row) row.classList.remove('guardando'); }
      }, sumar ? 0 : 600));
    };
    const enlazar = () => {
      const pm = prodPorId();
      $$('.ct-row').forEach((row) => {
        if (row.dataset.ok) return; row.dataset.ok = 1;
        const p = pm.get(Number(row.dataset.p)); const inp = $('input', row);
        inp.addEventListener('input', () => { const v = inp.value === '' ? null : Math.max(0, Math.floor(Number(inp.value))); if (v === null || Number.isFinite(v)) guardar(p, v); });
        inp.addEventListener('focus', () => inp.select());
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const sig = row.nextElementSibling && $('input', row.nextElementSibling); if (sig) sig.focus(); else inp.blur(); } });
        $$('.ct-b', row).forEach((b) => b.addEventListener('click', () => { const v = Math.max(0, (Number(inp.value) || 0) + Number(b.dataset.a)); inp.value = v; guardar(p, v); }));
        $('[data-sum]', row).addEventListener('click', () => sumarModal(p));
      });
    };
    const sumarModal = (p) => {
      const m = modal(`<h2>Sumar a ${esc(p.nombre)}</h2><p class="sub" style="margin-top:-6px">Ya contados: <b>${p.contado ?? 0}</b>. ¿Cuántos más encontraste (otra heladera, estante, depósito)?</p>
        <form id="f-sum"><input name="n" type="number" inputmode="numeric" min="1" step="1" required autofocus style="font-size:1.4rem;text-align:center">
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Sumar</button></div></form>`);
      setTimeout(() => $('input', m).focus(), 50);
      $('#f-sum', m).addEventListener('submit', (e) => { e.preventDefault(); const n = Math.floor(Number(e.target.n.value)); if (n > 0) { closeModal(); guardar(p, n, true); toast(`+${n} ${p.nombre}`); } });
    };
    const irA = (p) => {
      st.q = ''; if ($('#ct-q')) $('#ct-q').value = ''; st.cat = ''; if ($('#ct-cat')) $('#ct-cat').value = '';
      if (!visibles().includes(p)) st.filtro = 'todos';
      pintar();
      const row = $(`.ct-row[data-p="${p.id}"]`);
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('resaltar'); setTimeout(() => row.classList.remove('resaltar'), 1600); const i = $('input', row); if (i) setTimeout(() => i.focus(), 250); }
    };
    const porCodigo = async (cod) => {
      cod = String(cod || '').trim(); if (!cod) return;
      const local = d.productos.find((p) => p.codigo_barras === cod || p.codigo.toUpperCase() === cod.toUpperCase());
      if (local) return irA(local);
      const r = await api('/api/productos/barras/' + encodeURIComponent(cod));
      if (r.encontrado) {
        const p = prodPorId().get(r.producto.id);
        if (p) return irA(p);
        return toast(`${r.producto.nombre} no tiene gestión de stock`, true);
      }
      if (!/^\d{6,}$/.test(cod)) return; // no parece un código de barras: queda como búsqueda
      const m = modal(`<h2>Código ${esc(cod)}</h2><p class="sub" style="margin-top:-6px">No está asociado a ningún producto. Elegí cuál es y queda guardado para la próxima.</p>
        <input id="as-q" type="search" placeholder="Buscar producto…" autofocus><div id="as-l" class="as-lista"></div>
        <div class="form-actions"><button class="btn sec" data-close>Cancelar</button></div>`);
      const pintarL = () => { const q = $('#as-q', m).value.toLowerCase(); $('#as-l', m).innerHTML = d.productos.filter((p) => !q || p.nombre.toLowerCase().includes(q) || p.codigo.toLowerCase().includes(q)).slice(0, 40)
        .map((p) => `<button class="as-it" data-id="${p.id}"><b>${esc(p.nombre)}</b><small>${esc(p.codigo)}${p.codigo_barras ? ' · ya tiene ' + esc(p.codigo_barras) : ''}</small></button>`).join('');
        $$('.as-it', m).forEach((b) => b.onclick = async () => { try { await api(`/api/productos/${b.dataset.id}/barras`, { method: 'PUT', body: { codigo_barras: cod } }); const p = prodPorId().get(Number(b.dataset.id)); p.codigo_barras = cod; closeModal(); toast('Código asociado'); irA(p); } catch (err) { toast(err.message, true); } }); };
      $('#as-q', m).addEventListener('input', pintarL); pintarL();
    };
    const escanear = async () => {
      let stream, activo = true;
      const m = modal(`<h2>Escanear código</h2><div class="scan-box"><video id="sc-v" playsinline muted></video><i></i></div><p class="stock-hint" style="text-align:center">Apuntá al código de barras del producto.</p>
        <div class="form-actions"><button class="btn sec" data-close id="sc-x">Cerrar</button></div>`);
      const parar = () => { activo = false; if (stream) stream.getTracks().forEach((t) => t.stop()); };
      $$('[data-close]', m).forEach((b) => b.addEventListener('click', parar));
      $('.modal-bg').addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) parar(); });
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const v = $('#sc-v', m); v.srcObject = stream; await v.play();
        const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] });
        const loop = async () => {
          if (!activo) return;
          try { const r = await det.detect(v); if (r.length) { parar(); closeModal(); if (navigator.vibrate) navigator.vibrate(80); return porCodigo(r[0].rawValue); } } catch (_) { /* cuadro sin leer */ }
          setTimeout(loop, 250);
        };
        loop();
      } catch (err) { parar(); closeModal(); toast('No se pudo abrir la cámara: ' + err.message, true); }
    };
    const recargar = async () => {
      if (pend.size || (document.activeElement && document.activeElement.closest && document.activeElement.closest('.ct-row'))) return;
      const y = window.scrollY; d = await api('/api/conteos/' + id); pintar(); window.scrollTo(0, y);
    };
    if (abierto) {
      $('#ct-q').addEventListener('input', (e) => { st.q = e.target.value.trim(); if (st.q && st.filtro === 'pend') st.filtro = 'todos'; pintar(); });
      $('#ct-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = visibles(); if (v.length === 1) irA(v[0]); else porCodigo(e.target.value).catch((err) => toast(err.message, true)); } });
      if ($('#ct-scan')) $('#ct-scan').onclick = escanear;
      $('#ct-ref').onclick = () => recargar().then(() => toast('Actualizado'));
      clearInterval(VIEWS.conteo._t); VIEWS.conteo._t = setInterval(() => { if (!location.hash.startsWith('#/conteo?id=' + id)) return clearInterval(VIEWS.conteo._t); recargar().catch(() => {}); }, 20000);
      $('#ct-anular').onclick = async () => {
        if (!confirm('¿Anular este conteo? Se descarta lo contado y el stock no cambia.')) return;
        try { await api(`/api/conteos/${id}/anular`, { method: 'POST' }); toast('Conteo anulado'); location.hash = '#/conteo'; } catch (err) { toast(err.message, true); }
      };
      if ($('#ct-aplicar')) $('#ct-aplicar').onclick = async () => {
        await recargar();
        const contados = d.productos.filter((p) => p.contado !== null);
        const difs = contados.filter(conDif).sort((a, b) => Math.abs(b.contado - b.sistema) - Math.abs(a.contado - a.sistema));
        const sinContar = d.productos.filter((p) => p.en_alcance && p.contado === null && p.sistema > 0);
        const neto = difs.reduce((a, p) => a + (p.contado - p.sistema), 0);
        const m = modal(`<h2>Revisar y aplicar el conteo</h2>
          <div class="resumen" style="margin-bottom:12px"><a><span>Contados</span><b>${contados.length}</b></a><a><span>Con diferencia</span><b style="${difs.length ? 'color:var(--accent)' : ''}">${difs.length}</b></a>
            <a><span>Diferencia neta</span><b>${neto > 0 ? '+' : ''}${neto}</b><small>unidades</small></a><a><span>Sin contar con stock</span><b>${sinContar.length}</b></a></div>
          ${difs.length ? `<div class="tbl-wrap" style="max-height:300px;overflow:auto"><table><thead><tr><th>Producto</th><th class="num">Sistema</th><th class="num">Contado</th><th class="num">Diferencia</th></tr></thead><tbody>
            ${difs.map((p) => `<tr><td>${esc(p.nombre)}</td><td class="num">${p.sistema}</td><td class="num"><b>${p.contado}</b></td><td class="num" style="color:${p.contado < p.sistema ? 'var(--accent)' : 'var(--ok)'}"><b>${p.contado > p.sistema ? '+' : ''}${p.contado - p.sistema}</b></td></tr>`).join('')}</tbody></table></div>`
            : '<div class="card" style="background:#e9f5ee;border-color:#b9dcc6">✅ Lo contado coincide con el sistema.</div>'}
          ${sinContar.length ? `<div class="f mt"><label>Productos sin contar que tienen stock en el sistema (${sinContar.length})</label>
            <label class="check"><input type="radio" name="nc" value="MANTENER" checked> Dejarlos como están</label>
            <label class="check"><input type="radio" name="nc" value="CERO"> Ponerlos en 0 (no hay ninguno)</label>
            <div class="stock-hint">${sinContar.slice(0, 8).map((p) => esc(p.nombre) + ' (' + p.sistema + ')').join(', ')}${sinContar.length > 8 ? '…' : ''}</div></div>` : ''}
          <p class="stock-hint mt">Al aplicar, el stock de ${esc(d.almacen)} pasa a ser lo contado y queda un movimiento de <b>Ajuste</b>. El stock del sistema se toma en este momento.</p>
          <div class="form-actions"><button class="btn sec" data-close>Seguir contando</button><button class="btn" id="ap-ok">Aplicar conteo</button></div>`, { wide: true });
        $('#ap-ok', m).onclick = async () => {
          const nc = $('input[name=nc]:checked', m);
          try {
            const r = await api(`/api/conteos/${id}/aplicar`, { method: 'POST', body: { no_contados: nc ? nc.value : 'MANTENER' } });
            closeModal(); toast(r.movimiento_id ? `Conteo aplicado: ${r.productos_ajustados} productos ajustados` : 'Conteo aplicado: no había diferencias'); location.hash = '#/conteo';
          } catch (err) { toast(err.message, true); }
        };
      };
    }
    if ($('#ct-cat')) $('#ct-cat').addEventListener('change', (e) => { st.cat = e.target.value; pintar(); });
    pintar();
  }

  // ---------- Mis horas (empleado) ----------
  VIEWS['mis-horas'] = async (main) => {
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const hoy = new Date();
    let y = hoy.getFullYear(), m = hoy.getMonth(), vista = 'mes';
    main.innerHTML = `<h1>Mis horas</h1><p class="sub">Tus días programados, tus fichadas del reloj y las horas trabajadas en cada jornada.</p>
      <div id="mh-prog"></div><h2 class="mt" style="margin-top:18px">Horas trabajadas</h2>
      <div class="toolbar">
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn ghost sm" id="mh-prev" title="Mes anterior">◀</button>
          <b id="mh-tit" style="min-width:150px;text-align:center;text-transform:capitalize"></b>
          <button class="btn ghost sm" id="mh-next" title="Mes siguiente">▶</button></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn ghost sm" data-v="semana">Esta semana</button><button class="btn ghost sm" data-v="q1">1ª quincena</button>
          <button class="btn ghost sm" data-v="q2">2ª quincena</button><button class="btn ghost sm" data-v="mes">Mes completo</button></div>
      </div><div id="mh-res"><p class="muted">Cargando…</p></div>`;
    const rangoVista = () => {
      const fin = new Date(y, m + 1, 0); const lim = (d) => isoLocal(d > hoy ? hoy : d);
      if (vista === 'semana') { const l = new Date(hoy); l.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7)); return [isoLocal(l), isoLocal(hoy), 'Esta semana']; }
      if (vista === 'q1') return [isoLocal(new Date(y, m, 1)), lim(new Date(y, m, 15)), `1ª quincena de ${MESES[m]}`];
      if (vista === 'q2') return [isoLocal(new Date(y, m, 16)), lim(fin), `2ª quincena de ${MESES[m]}`];
      return [isoLocal(new Date(y, m, 1)), lim(fin), `${MESES[m]} ${y}`];
    };
    const cargar = async () => {
      const futuro = new Date(y, m, vista === 'q2' ? 16 : 1) > hoy;
      $('#mh-tit').textContent = `${MESES[m]} ${y}`;
      $('#mh-next').disabled = y === hoy.getFullYear() && m === hoy.getMonth();
      $$('[data-v]').forEach((b) => b.classList.toggle('sec', b.dataset.v === vista));
      if (futuro) { $('#mh-res').innerHTML = '<div class="card empty">Ese período todavía no empezó.</div>'; return; }
      const [desde, hasta, nombre] = rangoVista();
      $('#mh-res').innerHTML = '<p class="muted">Cargando…</p>';
      let h;
      try { h = await api(`/api/horas/mias?desde=${desde}&hasta=${hasta}`); } catch (err) { $('#mh-res').innerHTML = `<div class="card empty">${esc(err.message)}</div>`; return; }
      const act = h.actualizado ? `Datos del reloj actualizados ${fmtFecha(h.actualizado)}.` : '';
      if (!h.vinculado) {
        $('#mh-res').innerHTML = `<div class="card empty" style="padding:32px"><div style="font-size:2rem">⏱️</div>
          <b>Todavía no tenés tu número del reloj vinculado.</b><br>Pedile al administrador que cargue tu N° en el reloj en tu usuario y vas a ver acá tus horas.</div>`;
        return;
      }
      const prom = h.dias_trabajados ? Math.round(h.minutos / h.dias_trabajados) : 0;
      $('#mh-res').innerHTML = `<div class="resumen" style="margin-bottom:14px">
          <a><span>Horas trabajadas</span><b>${hm(h.minutos)}</b><small>${esc(nombre)} · del ${fmtDia(h.desde)} al ${fmtDia(h.hasta)}</small></a>
          <a><span>Días trabajados</span><b>${h.dias_trabajados}</b><small>con fichadas</small></a>
          <a><span>Promedio por día</span><b>${prom ? hm(prom) : '—'}</b><small>jornadas completas</small></a>
          ${h.incompletas ? `<a><span>Jornadas incompletas</span><b style="color:var(--accent)">${h.incompletas}</b><small>falta una fichada</small></a>` : ''}</div>
        ${h.incompletas ? `<div class="card" style="background:#fff6e5;border-color:#f3d9a4">⚠️ Hay ${h.incompletas === 1 ? 'una jornada' : h.incompletas + ' jornadas'} con una fichada de menos (entrada sin salida o al revés). Esas horas no se cuentan: avisale a tu encargado para que la corrija.</div>` : ''}
        ${h.dias.length ? `<div class="tbl-wrap">${tablaDias([...h.dias].reverse())}</div>` : '<div class="card empty">No hay fichadas en este período.</div>'}
        <p class="stock-hint mt">N° en el reloj: <b>${esc(h.legajo)}</b>${h.ultima_fichada ? ` · tu última fichada: ${fmtFecha(h.ultima_fichada)}` : ''}. ${act}
          Los turnos que pasan la medianoche cuentan para el día en que empezaron.</p>`;
    };
    $('#mh-prev').addEventListener('click', () => { if (--m < 0) { m = 11; y--; } if (vista === 'semana') vista = 'mes'; cargar(); });
    $('#mh-next').addEventListener('click', () => { if (++m > 11) { m = 0; y++; } if (vista === 'semana') vista = 'mes'; cargar(); });
    $$('[data-v]').forEach((b) => b.addEventListener('click', () => {
      vista = b.dataset.v; if (vista === 'semana') { y = hoy.getFullYear(); m = hoy.getMonth(); } cargar();
    }));
    misProximosDias($('#mh-prog'));
    cargar();
  };

  VIEWS.horas = async (main) => {
    const pre = presetsPeriodo();
    main.innerHTML = `<h1>Horas del personal</h1><p class="sub">Fichadas del reloj (CrossChex Cloud) y horas trabajadas por empleado.</p>
      <div id="hs-sync"></div>
      <div class="toolbar">
        <div class="f"><label>Desde</label><input type="date" id="hs-d" value="${pre.mes[0]}"></div>
        <div class="f"><label>Hasta</label><input type="date" id="hs-h" value="${pre.mes[1]}"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
          <button class="btn ghost sm" data-pre="semana">Esta semana</button><button class="btn ghost sm" data-pre="quincena">Quincena</button>
          <button class="btn ghost sm" data-pre="mes">Este mes</button><button class="btn ghost sm" data-pre="mesAnt">Mes anterior</button></div>
        <div class="spacer"></div><button class="btn sec" id="hs-csv">Exportar CSV</button>
      </div><div id="hs-tbl"><p class="muted">Cargando…</p></div>`;
    let datos = null;
    const pintarSync = () => {
      const u = datos.ultimo;
      $('#hs-sync').innerHTML = !datos.configurado
        ? `<div class="card" style="background:#faf8f5">🔌 <b>CrossChex:</b> no configurado. Cargá <span class="code">CROSSCHEX_API_KEY</span> y <span class="code">CROSSCHEX_API_SECRET</span> en Render (Environment) para traer las fichadas del reloj.</div>`
        : `<div class="card" style="background:#faf8f5;display:flex;gap:14px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:260px">⏱️ <b>Reloj conectado</b> · ${fmtN(datos.fichadas_total)} fichadas${datos.ultima_fichada ? ` · última ${fmtFecha(datos.ultima_fichada)}` : ''}<br>
          <span class="stock-hint">${u ? `Última sincronización: ${fmtFecha(u.fin || u.inicio)} · ${u.ok === false ? `<b class="bad">Error: ${esc(u.detalle || '')}</b>` : u.ok ? `${fmtN(u.leidos)} leídas, ${fmtN(u.creados)} nuevas` : 'en curso…'}` : 'Todavía no se sincronizó.'}
          · Los turnos que pasan la medianoche cuentan para el día en que empezaron (corte ${datos.corte}:00 h).</span></div>
          <button class="btn sec" id="hs-sync-btn">Sincronizar</button><button class="btn ghost sm" id="hs-sync-31">Traer últimos 31 días</button></div>`;
      const sync = async (dias) => {
        try {
          await api('/api/horas/sincronizar', { method: 'POST', body: dias ? { dias } : {} });
          toast('Sincronizando con el reloj… puede tardar un minuto (CrossChex permite una consulta cada 15 segundos).');
          await cargar();
        } catch (err) { toast(err.message, true); }
      };
      if (datos.sincronizando) {
        const b = $('#hs-sync-btn'); if (b) { b.disabled = true; b.textContent = 'Sincronizando…'; }
        if ($('#hs-sync-31')) $('#hs-sync-31').hidden = true;
        clearTimeout(VIEWS.horas._t);
        VIEWS.horas._t = setTimeout(async () => {
          if (!location.hash.startsWith('#/horas')) return;
          const antes = datos.ultimo && datos.ultimo.id;
          await cargar().catch(() => {});
          if (!datos.sincronizando && datos.ultimo) toast(datos.ultimo.ok === false ? `Reloj: ${datos.ultimo.detalle}` : `Reloj sincronizado: ${datos.ultimo.creados} fichadas nuevas`, datos.ultimo.ok === false);
        }, 5000);
      }
      if ($('#hs-sync-btn') && !datos.sincronizando) { $('#hs-sync-btn').onclick = () => sync(); $('#hs-sync-31').onclick = () => sync(31); }
    };
    const cargar = async () => {
      datos = await api(`/api/horas?desde=${$('#hs-d').value}&hasta=${$('#hs-h').value}`);
      pintarSync();
      const emps = datos.empleados;
      const total = emps.reduce((a, e) => a + e.minutos, 0);
      $('#hs-tbl').innerHTML = emps.length ? `<p class="muted">${emps.length} empleados · ${hm(total)} h en el período. Tocá un empleado para ver el detalle por día.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Empleado</th><th>N° reloj</th><th class="num">Días</th><th class="num">Horas</th><th class="num">Promedio/día</th><th class="num">Incompletas</th></tr></thead><tbody>
        ${emps.map((e, i) => `<tr class="hs-row" data-i="${i}" style="cursor:pointer"><td><b>${esc(e.usuario || e.nombre || '—')}</b>${e.usuario && e.nombre && e.usuario !== e.nombre ? ` <span class="muted">(${esc(e.nombre)})</span>` : ''}${e.usuario_id ? '' : ' <span class="badge b-CANCELADO" title="Cargá este N° en el usuario">sin usuario</span>'}</td>
          <td class="code">${esc(e.workno)}</td><td class="num">${e.dias_trabajados}</td><td class="num"><b>${hm(e.minutos)}</b></td>
          <td class="num">${e.dias_trabajados ? hm(Math.round(e.minutos / e.dias_trabajados)) : '—'}</td><td class="num ${e.incompletas ? 'stock-hint bad' : ''}">${e.incompletas || ''}</td></tr>
          <tr class="hs-det" data-det="${i}" hidden><td colspan="6">${tablaDias(e.dias)}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="card empty">${datos.configurado ? 'No hay fichadas en el período.' : 'Sin datos del reloj todavía.'}</div>`;
      $$('.hs-row').forEach((r) => r.addEventListener('click', () => { const d = $(`[data-det="${r.dataset.i}"]`); d.hidden = !d.hidden; }));
    };
    $$('[data-pre]').forEach((b) => b.addEventListener('click', () => { const [d, h] = pre[b.dataset.pre]; $('#hs-d').value = d; $('#hs-h').value = h; cargar().catch((e) => toast(e.message, true)); }));
    ['#hs-d', '#hs-h'].forEach((sel) => $(sel).addEventListener('change', () => cargar().catch((e) => toast(e.message, true))));
    $('#hs-csv').onclick = () => descargarCSV(`horas_${$('#hs-d').value}_${$('#hs-h').value}.csv`, [
      ['Empleado', 'Nombre en reloj', 'N reloj', 'Jornada', 'Dia', 'Fichadas', 'Tramos', 'Horas', 'Minutos', 'Incompleta'],
      ...datos.empleados.flatMap((e) => e.dias.map((d) => [e.usuario || '', e.nombre || '', e.workno, d.fecha, diaSem(d.fecha), d.marcas.join(' '),
        d.tramos.map((t) => `${t.entrada}-${t.salida || '?'}`).join(' '), hm(d.minutos), d.minutos, d.incompleta ? 'SI' : ''])),
    ]);
    await cargar();
  };

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
      $('#v-tbl').innerHTML = rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Fecha</th><th>Tipo</th><th>Desde</th><th>Hacia</th><th>Proveedor / referencia</th><th class="num">Ítems</th><th class="num">Unidades</th><th>Usuario</th><th></th></tr></thead><tbody>
        ${rows.map((m) => `<tr><td>${m.id}</td><td>${fmtFecha(m.fecha)}</td><td><span class="badge b-${m.tipo}">${TIPO_LBL[m.tipo]}</span></td><td>${esc(m.origen || '—')}</td><td>${esc(m.destino || (m.tipo === 'AJUSTE' ? '' : '—'))}</td>
          <td>${m.proveedor ? `<b>${esc(m.proveedor)}</b>${m.referencia ? '<br>' : ''}` : ''}<span class="${m.proveedor ? 'muted' : ''}">${esc(m.referencia || '')}</span></td><td class="num">${m.items}</td><td class="num">${(m.tipo === 'AJUSTE' || m.tipo === 'PRODUCCION') && m.unidades > 0 ? '+' : ''}${fmtN(m.unidades)}</td><td>${esc(m.usuario)}</td>
          <td><button class="btn ghost sm" data-ver="${m.id}">Ver</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">Sin movimientos para el filtro.</div>';
      $$('[data-ver]').forEach((b) => b.addEventListener('click', () => verMovimiento(b.dataset.ver)));
    };
    ['#v-tipo', '#v-alm', '#v-desde', '#v-hasta'].forEach((s) => $(s).addEventListener('change', () => cargar().catch((e) => toast(e.message, true))));
    $('#v-csv').onclick = () => descargarCSV(`movimientos_${hoyISO()}.csv`, [
      ['Id', 'Fecha', 'Tipo', 'Desde', 'Hacia', 'Proveedor', 'Referencia', 'Items', 'Unidades', 'Usuario', 'Observacion'],
      ...rows.map((m) => [m.id, fmtFecha(m.fecha), TIPO_LBL[m.tipo], m.origen || '', m.destino || '', m.proveedor || '', m.referencia || '', m.items, m.unidades, m.usuario, m.observacion || '']),
    ]);
    await cargar();
  };

  async function verMovimiento(id) {
    try {
      const m = await api('/api/movimientos/' + id);
      modal(`<h2>${TIPO_LBL[m.tipo]} #${m.id}</h2>
        <p class="muted">${fmtFecha(m.fecha)} · ${esc(m.usuario)}${m.origen ? ` · Desde <b>${esc(m.origen)}</b>` : ''}${m.destino ? ` · Hacia <b>${esc(m.destino)}</b>` : ''}</p>
        ${m.proveedor ? `<p><b>Proveedor:</b> ${esc(m.proveedor)}</p>` : ''}${m.referencia ? `<p><b>Referencia:</b> ${esc(m.referencia)}</p>` : ''}${m.pedido_id ? `<p><b>Nota de pedido:</b> #${m.pedido_id}</p>` : ''}
        <div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th></tr></thead><tbody>
        ${m.items.map((i) => `<tr><td class="code">${esc(i.codigo)}</td><td>${esc(i.nombre)}</td><td class="num ${m.tipo === 'PRODUCCION' && i.cantidad < 0 ? 'muted' : ''}">${(m.tipo === 'AJUSTE' || m.tipo === 'PRODUCCION') && i.cantidad > 0 ? '+' : ''}${fmtN(i.cantidad)} ${esc(i.unidad)}${m.tipo === 'PRODUCCION' ? (i.cantidad > 0 ? ' · producido' : ' · insumo') : ''}</td></tr>`).join('')}
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
      <div class="row"><div class="f"><label>Pedir desde (origen)</label><select id="n-orig">${optAlmacenes('', { vacio: 'Seleccionar…', todos: true })}</select></div>
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
    const [productos, fe] = await Promise.all([api('/api/productos?todos=1'), api('/api/fudo/estado').catch(() => null)]);
    const u = fe && fe.ultimo_productos;
    const fudoHtml = !fe ? '' : !fe.configurado
      ? `<div class="card" style="background:#faf8f5">🔌 <b>Fudo:</b> sincronización no configurada. Cargá <span class="code">FUDO_API_KEY</span> y <span class="code">FUDO_API_SECRET</span> en Render para traer los productos automáticamente.</div>`
      : `<div class="card" style="background:#faf8f5;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:260px">🔄 <b>Sincronizado con Fudo</b>${fe.minutos ? ` cada ${fe.minutos} min` : ''} · ${fe.vinculados_productos} productos vinculados<br>
          <span class="stock-hint">${u ? `Última: ${fmtFecha(u.fin || u.inicio)} · ${u.ok === false ? `<b class="bad">Error: ${esc(u.detalle || '')}</b>` : u.ok ? `${u.leidos} leídos, ${u.creados} nuevos, ${u.actualizados} actualizados, ${u.desactivados} desactivados` : 'en curso…'}` : 'Todavía no se sincronizó.'}
          ${u && u.ok && u.detalle ? `<br>⚠ ${esc(u.detalle).replace(/\n/g, '<br>⚠ ')}` : ''}</span><br>
          <span class="stock-hint">De Fudo se toman nombre, categoría y estado. Stock, unidad y alertas se manejan solo en esta app.</span></div>
          <button class="btn sec" id="pr-sync">Sincronizar con Fudo</button></div>`;
    main.innerHTML = `
      <h1>Productos</h1><p class="sub">Maestro de productos y alertas (vencimiento próximo, producto de cuidado, cadena de frío).</p>
      ${fudoHtml}
      <div class="toolbar">
        <div class="grow"><label>Buscar</label><input id="pr-q" placeholder="Código, nombre o categoría…"></div>
        <div class="f"><label>Categoría</label><select id="pr-cat"><option value="">Todas</option>${[...new Set(productos.map((p) => p.categoria).filter(Boolean))].sort().map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="f"><label>Gestión de stock</label><select id="pr-gs"><option value="">Todos</option><option value="si">Con gestión de stock</option><option value="no">Solo maestro (sin gestión)</option><option value="prod">Con gestión de producción</option></select></div>
        <div class="f"><label>Alerta</label><select id="pr-al"><option value="">Todas</option><option value="any">Con alguna alerta</option><option value="venc">Vencimiento próximo</option><option value="cuid">De cuidado</option><option value="frio">Cadena de frío</option></select></div>
        <label class="check" style="margin-bottom:10px"><input type="checkbox" id="pr-inac"> Ver inactivos</label>
        <div class="spacer"></div>
        <button class="btn sec" id="pr-tpl">Plantilla CSV</button><button class="btn sec" id="pr-imp">Importar maestro</button><button class="btn" id="pr-new">+ Nuevo producto</button>
      </div><div id="pr-tbl"></div>`;
    const pintar = () => {
      const q = $('#pr-q').value.trim().toLowerCase();
      const al = $('#pr-al').value;
      const inac = $('#pr-inac').checked;
      const cat = $('#pr-cat').value;
      const gs = $('#pr-gs').value;
      const rows = productos.filter((p) => (inac || p.activo)
        && (!cat || p.categoria === cat) && (!gs || (gs === 'prod' ? p.gestion_produccion : gs === 'si' ? p.gestion_stock : !p.gestion_stock))
        && (!q || `${p.codigo} ${p.nombre} ${p.categoria || ''}`.toLowerCase().includes(q))
        && (!al || (al === 'any' && tieneAlerta(p)) || (al === 'venc' && p.alerta_vencimiento) || (al === 'cuid' && p.alerta_cuidado) || (al === 'frio' && p.alerta_frio)));
      $('#pr-tbl').innerHTML = rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Unidad</th><th>Stock</th><th>Alertas</th><th>Nota</th><th></th></tr></thead><tbody>
        ${rows.map((p) => `<tr class="${p.activo ? '' : 'inactive'}"><td class="code">${esc(p.codigo)}</td><td>${esc(p.nombre)}${p.fudo_id ? ' <span class="badge b-rol" title="Sincronizado desde Fudo">Fudo</span>' : ''}${p.activo ? '' : ' (inactivo)'}</td><td>${esc(p.categoria || '')}</td><td>${esc(p.unidad)}</td>
          <td>${p.gestion_produccion ? `<button class="gs-tog prod" data-receta="${p.id}" title="Producto que se produce: tocá para ver o editar la receta">🍳 Receta</button> ` : ''}<button class="gs-tog ${p.gestion_stock ? 'on' : ''}" data-gs="${p.id}" title="${p.gestion_stock ? 'Se opera en la app (recepción, consumo, transferencias…). Tocá para pasarlo a solo maestro.' : 'Solo maestro: no se opera. Tocá para activar la gestión de stock.'}">${p.gestion_stock ? '✓ Gestiona' : 'Solo maestro'}</button></td>
          <td>${badgesAlerta(p)}</td><td class="muted">${esc(p.nota_alerta || '')}</td><td class="num"><button class="btn ghost sm" data-ed="${p.id}">Editar</button></td></tr>`).join('')}
        </tbody></table></div><div class="row" style="justify-content:space-between;align-items:center;margin-top:10px"><p class="muted" style="margin:0">${rows.length} de ${productos.length} productos · ${productos.filter((p) => p.gestion_stock).length} con gestión de stock</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sec sm" id="pr-gs-on">Activar gestión a los ${rows.length} filtrados</button><button class="btn sec sm" id="pr-gs-off">Pasar los ${rows.length} filtrados a solo maestro</button></div></div>` : `<div class="card empty">${productos.length ? 'Sin resultados.' : 'Todavía no hay productos. Cargalos uno a uno o importá el maestro en CSV.'}</div>`;
      const cambiarGestion = async (ids, valor, desc) => {
        if (!ids.length) return;
        if (ids.length > 1 && !confirm(`${valor ? 'Activar la gestión de stock' : 'Pasar a solo maestro'} ${desc}?${valor ? '' : '\n\nDejarán de aparecer en stock, recepción, consumos, transferencias y pedidos. El stock que tengan queda guardado y vuelve a verse si reactivás la gestión.'}`)) return;
        try {
          const r = await api('/api/productos/gestion-stock', { method: 'POST', body: { ids, valor } });
          productos.forEach((p) => { if (ids.includes(p.id)) p.gestion_stock = valor; });
          toast(`${r.cambiados} ${r.cambiados === 1 ? 'producto actualizado' : 'productos actualizados'}`); pintar();
        } catch (err) { toast(err.message, true); }
      };
      $$('[data-receta]').forEach((b) => b.addEventListener('click', () => editarReceta(productos.find((x) => x.id == b.dataset.receta), productos)));
      $$('[data-gs]').forEach((b) => b.addEventListener('click', () => { const p = productos.find((x) => x.id == b.dataset.gs); cambiarGestion([p.id], !p.gestion_stock, ''); }));
      if ($('#pr-gs-on')) $('#pr-gs-on').onclick = () => cambiarGestion(rows.filter((p) => !p.gestion_stock).map((p) => p.id), true, `a ${rows.filter((p) => !p.gestion_stock).length} productos filtrados`);
      if ($('#pr-gs-off')) $('#pr-gs-off').onclick = () => cambiarGestion(rows.filter((p) => p.gestion_stock).map((p) => p.id), false, `${rows.filter((p) => p.gestion_stock).length} productos filtrados`);
      $$('[data-ed]').forEach((b) => b.addEventListener('click', () => editarProducto(productos.find((p) => p.id == b.dataset.ed))));
    };
    ['#pr-q', '#pr-al', '#pr-inac', '#pr-cat', '#pr-gs'].forEach((s) => $(s).addEventListener('input', pintar));
    $('#pr-new').onclick = () => editarProducto(null);
    if ($('#pr-sync')) $('#pr-sync').onclick = async () => {
      const b = $('#pr-sync'); b.disabled = true; b.textContent = 'Sincronizando…';
      try {
        const r = await api('/api/fudo/sincronizar?entidad=productos', { method: 'POST' });
        toast(`Fudo: ${r.creados} nuevos, ${r.actualizados} actualizados, ${r.desactivados} desactivados`);
        router();
      } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Sincronizar con Fudo'; }
    };
    $('#pr-imp').onclick = importarMaestro;
    $('#pr-tpl').onclick = () => descargarCSV('plantilla_productos.csv', [
      ['codigo', 'nombre', 'categoria', 'unidad', 'vencimiento_proximo', 'fecha_vencimiento', 'cuidado', 'cadena_frio', 'nota_alerta', 'activo', 'gestion_stock'],
      ['BEB001', 'Cerveza rubia lata 473ml', 'Bebidas', 'UN', '', '', '', 'SI', 'Mantener refrigerada', 'SI', 'SI'],
      ['ALI010', 'Queso cheddar feteado 1kg', 'Alimentos', 'UN', 'SI', '2026-12-15', '', 'SI', '', 'SI', 'SI'],
      ['TRA001', 'Negroni (trago de carta)', 'Tragos', 'UN', '', '', '', '', '', 'SI', 'NO'],
    ]);
    pintar();
  };

  function editarProducto(p) {
    const n = !p;
    p = p || { codigo: '', nombre: '', categoria: '', unidad: 'UN', alerta_vencimiento: false, fecha_vencimiento: '', alerta_cuidado: false, alerta_frio: false, nota_alerta: '', activo: true, gestion_stock: true, gestion_produccion: false };
    const m = modal(`<h2>${n ? 'Nuevo producto' : 'Editar producto'}</h2>
      ${p.fudo_id ? `<p class="obs" style="margin-top:-6px">🔄 Vinculado a Fudo (ID ${esc(p.fudo_id)}): nombre, categoría y estado se actualizan desde Fudo. Unidad y alertas son solo de esta app.</p>` : ''}
      <form id="f-prod">
        <div class="row"><div class="f s"><label>Código *</label><input name="codigo" value="${esc(p.codigo)}" required maxlength="40"></div>
          <div class="f w"><label>Nombre *</label><input name="nombre" value="${esc(p.nombre)}" required maxlength="200"></div></div>
        <div class="row mt"><div class="f"><label>Categoría</label><input name="categoria" value="${esc(p.categoria || '')}" maxlength="80"></div>
          <div class="f s"><label>Unidad</label><input name="unidad" value="${esc(p.unidad)}" maxlength="20"></div>
          <div class="f"><label>Código de barras</label><input name="codigo_barras" value="${esc(p.codigo_barras || '')}" maxlength="40" inputmode="numeric" placeholder="EAN, opcional"></div></div>
        <div class="card mt" style="background:#faf8f5">
          <h2 style="font-size:1rem">Alertas</h2>
          <div class="row"><label class="check"><input type="checkbox" name="alerta_vencimiento" ${p.alerta_vencimiento ? 'checked' : ''}> ⏳ Vencimiento próximo</label>
            <div class="f"><label>Fecha de vencimiento (opcional)</label><input type="date" name="fecha_vencimiento" value="${esc(p.fecha_vencimiento || '')}"></div></div>
          <div class="row mt"><label class="check"><input type="checkbox" name="alerta_cuidado" ${p.alerta_cuidado ? 'checked' : ''}> ⚠ Producto de cuidado</label>
            <label class="check"><input type="checkbox" name="alerta_frio" ${p.alerta_frio ? 'checked' : ''}> ❄ Cadena de frío</label></div>
          <div class="f mt"><label>Nota de la alerta</label><input name="nota_alerta" value="${esc(p.nota_alerta || '')}" maxlength="500" placeholder="Ej.: conservar entre 2 °C y 8 °C"></div>
        </div>
        <div class="card mt" style="background:#eaf2fa;border-color:#c9d6e3">
          <label class="check"><input type="checkbox" name="gestion_stock" ${p.gestion_stock ? 'checked' : ''}> <b>Gestión de stock</b></label>
          <p class="stock-hint" style="margin:6px 0 0 26px">Tildado: se opera en la app (recepción, transferencias, consumos, pedidos) y aparece en Stock, el panel y Vinilito. Destildado: solo figura en este maestro (p. ej. tragos o platos de la carta).</p>
          <label class="check mt"><input type="checkbox" name="gestion_produccion" ${p.gestion_produccion ? 'checked' : ''}> <b>Gestión de producción</b></label>
          <p class="stock-hint" style="margin:6px 0 0 26px">Se elabora en el local a partir de insumos (p. ej. masa, salsa, empanadas). Requiere una receta y activa la gestión de stock. ${p.id && p.gestion_produccion ? '<a href="#" id="pr-ir-receta">Ver / editar receta →</a>' : ''}</p>
        </div>
        <label class="check mt"><input type="checkbox" name="activo" ${p.activo ? 'checked' : ''}> Activo</label>
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div>
      </form>`);
    const fp = $('#f-prod', m);
    fp.gestion_produccion.addEventListener('change', () => { if (fp.gestion_produccion.checked) fp.gestion_stock.checked = true; });
    fp.gestion_stock.addEventListener('change', () => { if (!fp.gestion_stock.checked) fp.gestion_produccion.checked = false; });
    if ($('#pr-ir-receta', m)) $('#pr-ir-receta', m).onclick = async (e) => { e.preventDefault(); editarReceta(p, await api('/api/productos?todos=1')); };
    $('#f-prod', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        codigo: f.codigo.value, nombre: f.nombre.value, categoria: f.categoria.value, unidad: f.unidad.value,
        alerta_vencimiento: f.alerta_vencimiento.checked, fecha_vencimiento: f.fecha_vencimiento.value || null,
        alerta_cuidado: f.alerta_cuidado.checked, alerta_frio: f.alerta_frio.checked, nota_alerta: f.nota_alerta.value, activo: f.activo.checked,
        gestion_stock: f.gestion_stock.checked || f.gestion_produccion.checked, gestion_produccion: f.gestion_produccion.checked,
      };
      try {
        const r = await api(n ? '/api/productos' : '/api/productos/' + p.id, { method: n ? 'POST' : 'PUT', body });
        if ((f.codigo_barras.value || '') !== (p.codigo_barras || '')) await api(`/api/productos/${n ? r.id : p.id}/barras`, { method: 'PUT', body: { codigo_barras: f.codigo_barras.value } });
        closeModal(); toast('Producto guardado');
        if (body.gestion_produccion && !p.gestion_produccion) {
          const todos = await api('/api/productos?todos=1');
          const prod = todos.find((x) => x.id === (n ? r.id : p.id));
          if (prod) return editarReceta(prod, todos, true);
        }
        router();
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
      cuidado: 'alerta_cuidado', alerta_cuidado: 'alerta_cuidado', cadena_frio: 'alerta_frio', frio: 'alerta_frio', alerta_frio: 'alerta_frio', nota_alerta: 'nota_alerta', nota: 'nota_alerta', activo: 'activo', gestion_stock: 'gestion_stock', gestiona_stock: 'gestion_stock', stock: 'gestion_stock' };
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
        if (o.gestion_stock !== undefined) o.gestion_stock = o.gestion_stock === '' ? null : ['SI', 'S', 'X', '1', 'TRUE', 'SÍ'].includes(String(o.gestion_stock).trim().toUpperCase());
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
          await cargarAlmacenes();
          closeModal(); toast('Almacén guardado'); router();
        } catch (err) { toast(err.message, true); }
      });
    };
    $('#al-new').onclick = () => editar(null);
    $$('[data-ed]').forEach((b) => b.addEventListener('click', () => editar(alms.find((a) => a.id == b.dataset.ed))));
  };

  // ---------- Sucursales ----------
  const SUC_COL = ['#165f96', '#c0221f', '#2f7d4f', '#8e44ad', '#b7791f', '#0f766e'];
  const sucColor = (id, sucs) => SUC_COL[Math.max(0, sucs.findIndex((s) => s.id === id)) % SUC_COL.length];
  const sucCorto = (n) => String(n || '').replace(/^VINILO\s+/i, '');

  VIEWS.sucursales = async (main) => {
    const [sucs, us] = await Promise.all([api('/api/sucursales'), puede('usuarios') || puede('sucursales') ? api('/api/programacion/empleados').catch(() => []) : Promise.resolve([])]);
    main.innerHTML = `<h1>Sucursales</h1><p class="sub">Locales donde trabaja el personal. Un empleado puede estar en una o en varias sucursales a la vez.</p>
      <div class="toolbar"><div class="spacer"></div><button class="btn" id="su-new">+ Nueva sucursal</button></div>
      ${sucs.length ? `<div class="suc-grid">${sucs.map((s) => `<div class="card suc-card ${s.activo ? '' : 'inactive'}" style="--c:${sucColor(s.id, sucs)}">
        <div class="suc-top"><div><h3>${esc(s.nombre)}</h3>${s.direccion ? `<div class="muted">${esc(s.direccion)}</div>` : ''}</div>
          <span class="badge ${s.activo ? 'b-COMPLETADO' : ''}">${s.activo ? 'Activa' : 'Inactiva'}</span></div>
        <div class="suc-emp"><b>${s.empleados.length}</b> ${s.empleados.length === 1 ? 'empleado' : 'empleados'}
          <div>${s.empleados.map((e) => `<span class="emp-chip">${esc(e.nombre)}</span>`).join('') || '<span class="muted">Sin empleados asignados</span>'}</div></div>
        <div class="form-actions" style="margin-top:10px"><button class="btn ghost sm" data-ed="${s.id}">Editar</button></div></div>`).join('')}</div>`
        : '<div class="card empty">Todavía no hay sucursales.</div>'}`;
    const editar = (s) => {
      const asign = new Set(s ? s.empleados.map((e) => e.id) : []);
      const m = modal(`<h2>${s ? 'Editar' : 'Nueva'} sucursal</h2><form id="f-su">
        <div class="row"><div class="f"><label>Nombre *</label><input name="nombre" value="${esc(s ? s.nombre : '')}" required maxlength="80"></div>
          <div class="f"><label>Dirección</label><input name="direccion" value="${esc(s ? s.direccion || '' : '')}" maxlength="200"></div></div>
        ${us.length ? `<div class="f mt"><label>Empleados que trabajan en esta sucursal</label>
          <input type="search" id="su-q" placeholder="Buscar empleado…" style="margin-bottom:6px">
          <div class="chk-grupo chk-lista">${us.map((u) => `<label class="check" data-n="${esc(u.nombre.toLowerCase())}"><input type="checkbox" name="emp" value="${u.id}" ${asign.has(u.id) ? 'checked' : ''}> ${esc(u.nombre)} <span class="muted">· ${esc(u.rol_nombre)}</span></label>`).join('')}</div></div>` : ''}
        ${s ? `<label class="check mt"><input type="checkbox" name="activo" ${s.activo ? 'checked' : ''}> Activa</label>` : ''}
        <div class="form-actions"><button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`, { wide: true });
      const f = $('#f-su', m);
      if ($('#su-q', m)) $('#su-q', m).addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); $$('.chk-lista label', m).forEach((l) => { l.hidden = q && !l.dataset.n.includes(q); }); });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { nombre: f.nombre.value, direccion: f.direccion.value, activo: s ? f.activo.checked : true };
        if (us.length) body.empleados = $$('input[name=emp]:checked', f).map((c) => Number(c.value));
        try { await api(s ? '/api/sucursales/' + s.id : '/api/sucursales', { method: s ? 'PUT' : 'POST', body }); closeModal(); toast('Sucursal guardada'); router(); }
        catch (err) { toast(err.message, true); }
      });
    };
    $('#su-new').onclick = () => editar(null);
    $$('[data-ed]').forEach((b) => b.addEventListener('click', () => editar(sucs.find((x) => x.id == b.dataset.ed))));
  };

  // ---------- Usuarios (ADMIN) ----------
  VIEWS.usuarios = async (main) => {
    const tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab');
    if (tab === 'roles') return vistaRoles(main);
    if (tab === 'accesos' && S.user.rol === 'ADMIN') return vistaAccesos(main);
    if (tab === 'whatsapp') return vistaWhatsapp(main);
    const [us, provs, roles, sucs] = await Promise.all([api('/api/usuarios'), api('/api/proveedores'), api('/api/roles'), api('/api/sucursales')]);
    const nomSuc = (ids) => (ids || []).map((i) => (sucs.find((s) => s.id === i) || {}).nombre).filter(Boolean).map((n) => n.replace(/^VINILO\s+/i, '')).join(', ');
    main.innerHTML = `${tabsUsuarios('usuarios')}<h1>Usuarios</h1><p class="sub">Cada usuario tiene un <b>rol</b>, que define qué opciones del menú y qué almacenes ve (se configuran en la pestaña <a href="#/usuarios?tab=roles">Roles</a>). El permiso <b>Compras</b> se puede sumar a cualquier usuario.</p>
      <div class="toolbar"><div class="spacer"></div><button class="btn" id="us-new">+ Nuevo usuario</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Compras</th><th>Proveedor</th><th>N° reloj</th><th>WhatsApp</th><th>Sucursales</th><th>Último ingreso</th><th>Estado</th><th></th></tr></thead><tbody>
      ${us.map((u) => `<tr class="${u.activo ? '' : 'inactive'}"><td class="code">${esc(u.username)}</td><td>${esc(u.nombre)}</td><td><span class="badge b-rol">${esc(u.rol_nombre || u.rol)}</span></td>
        <td>${u.rol === 'ADMIN' || u.permiso_compras ? '<span class="badge b-COMPLETADO">Sí</span>' : ''}</td><td>${esc(u.proveedor || '')}</td><td class="code">${esc(u.legajo || '')}</td><td>${u.telefono ? `<span title="${esc(u.telefono)}${u.whatsapp_ok ? '' : ' · avisos desactivados'}">${u.whatsapp_ok ? '📱' : '🔕'}</span>` : ''}</td><td>${esc(nomSuc(u.sucursales))}</td>
        <td class="muted">${u.ultimo_ingreso ? fmtFecha(u.ultimo_ingreso) : 'Nunca'}</td>
        <td>${u.activo ? 'Activo' : 'Inactivo'}</td><td class="num">${S.user.rol === 'ADMIN' && u.activo && u.id !== S.user.id && !S.user.ver_como ? `<button class="btn ghost sm" data-vc="${u.id}" title="Ver la aplicación como este usuario (solo lectura)">👁 Ver como</button>` : ''}<button class="btn ghost sm" data-ed="${u.id}">Editar</button></td></tr>`).join('')}
      </tbody></table></div>`;
    const editar = (u) => {
      const m = modal(`<h2>${u ? 'Editar' : 'Nuevo'} usuario</h2><form id="f-us">
        <div class="row"><div class="f"><label>Usuario (login)</label><input name="username" value="${esc(u ? u.username : '')}" ${u ? 'disabled' : 'required'} maxlength="60" autocomplete="off"></div>
          <div class="f"><label>Nombre y apellido</label><input name="nombre" value="${esc(u ? u.nombre : '')}" required maxlength="120"></div></div>
        <div class="row mt"><div class="f"><label>Rol</label><select name="rol">${roles.map((r) => `<option value="${esc(r.codigo)}" ${u && u.rol === r.codigo ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select></div>
          <div class="f"><label>${u ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña (mín. 6)'}</label><input type="password" name="password" ${u ? '' : 'required'} minlength="6" autocomplete="new-password"></div></div>
        <div class="row mt"><div class="f"><label>N° en el reloj (CrossChex)</label><input name="legajo" value="${esc(u ? u.legajo || '' : '')}" maxlength="30" placeholder="Ej.: 12"></div>
          <div class="f"><p class="stock-hint" style="margin:24px 0 0">Vincula al usuario con sus fichadas para ver sus horas.</p></div></div>
        <div class="row mt"><div class="f"><label>Celular para WhatsApp</label><input name="telefono" value="${esc(u ? u.telefono || '' : '')}" maxlength="30" placeholder="Ej.: 236 4123456" inputmode="tel"></div>
          <div class="f"><label class="check" style="margin-top:26px"><input type="checkbox" name="whatsapp_ok" ${!u || u.whatsapp_ok !== false ? 'checked' : ''}> Recibir avisos por WhatsApp</label></div></div>
        <div class="f mt" id="us-suc"><label>Sucursales donde trabaja</label><div class="chk-grupo">${sucs.filter((s) => s.activo || (u && (u.sucursales || []).includes(s.id))).map((s) => `<label class="check"><input type="checkbox" name="suc" value="${s.id}" ${u && (u.sucursales || []).includes(s.id) ? 'checked' : ''}> ${esc(s.nombre)}</label>`).join('') || '<span class="muted">No hay sucursales cargadas.</span>'}</div></div>
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
        $('#us-suc', m).hidden = r === 'PROVEEDOR';
      };
      f.rol.addEventListener('change', sync); sync();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { nombre: f.nombre.value, rol: f.rol.value, password: f.password.value || undefined, legajo: f.legajo.value,
          proveedor_id: f.rol.value === 'PROVEEDOR' ? f.proveedor_id.value : null, permiso_compras: f.permiso_compras.checked,
          sucursales: $$('input[name=suc]:checked', f).map((c) => Number(c.value)), telefono: f.telefono.value, whatsapp_ok: f.whatsapp_ok.checked };
        if (u) body.activo = f.activo.checked; else body.username = f.username.value;
        try {
          await api(u ? '/api/usuarios/' + u.id : '/api/usuarios', { method: u ? 'PUT' : 'POST', body });
          closeModal(); toast('Usuario guardado'); router();
        } catch (err) { toast(err.message, true); }
      });
    };
    $('#us-new').onclick = () => editar(null);
    $$('[data-ed]').forEach((b) => b.addEventListener('click', () => editar(us.find((x) => x.id == b.dataset.ed))));
    $$('[data-vc]').forEach((b) => b.addEventListener('click', async () => { const u = us.find((x) => x.id == b.dataset.vc);
      const m = modal(`<h2>Ver como ${esc(u.nombre)}</h2><p>Vas a ver la aplicación exactamente como la ve <b>${esc(u.nombre)}</b> (rol ${esc(u.rol_nombre || u.rol)}): su menú, sus permisos, sus almacenes y sus datos.</p>
        <p class="stock-hint">Es <b>solo lectura</b>: no se puede guardar ni cambiar nada en su nombre. Dura hasta 2 horas y queda registrado en el registro de accesos. Para salir, tocá <b>Volver a mi usuario</b> en la barra de arriba.</p>
        <div class="form-actions"><button class="btn sec" data-close>Cancelar</button><button class="btn" id="vc-ok">👁 Ver como ${esc(u.nombre.split(' ')[0])}</button></div>`);
      $('#vc-ok', m).onclick = () => verComo(u); }));
  };


  // ---------- WhatsApp ----------
  async function vistaWhatsapp(main) {
    const est = new URLSearchParams(location.hash.split('?')[1] || '').get('estado') || '';
    const d = await api('/api/whatsapp' + (est ? '?estado=' + est : ''));
    const EST = { ENVIADA: ['Enviado', 'b-COMPLETADO'], ERROR: ['Error', 'b-RECHAZADO'], OMITIDA: ['No enviado', ''], PENDIENTE: ['Enviando…', 'b-PENDIENTE'] };
    const EVT = { SOLICITUD_NUEVA: 'Nueva solicitud', SOLICITUD_RESUELTA: 'Solicitud respondida', PEDIDO_CONFIRMADO: 'Pedido a proveedor', PRUEBA: 'Prueba' };
    const c = d.contadores;
    main.innerHTML = `${tabsUsuarios('whatsapp')}<h1>Avisos por WhatsApp</h1><p class="sub">Se mandan solos: al empleado cuando le responden una solicitud, a quien aprueba cuando llega una nueva y al proveedor cuando se le confirma un pedido.</p>
      <div class="card" style="${d.configurado ? 'background:#e9f5ee;border-color:#b9dcc6' : 'background:#fff6e5;border-color:#f3d9a4'}">
        ${d.configurado ? `✅ <b>Conectado</b> a WhatsApp Cloud API (número ${esc(d.phone_id)}, idioma ${esc(d.idioma)}).`
          : `⚠️ <b>Falta conectar WhatsApp.</b> Cargá <span class="code">WHATSAPP_TOKEN</span> y <span class="code">WHATSAPP_PHONE_ID</span> en Render → Environment. Mientras tanto los avisos quedan registrados como “No enviado”.`}
        ${d.usuarios_sin_telefono ? `<div class="stock-hint" style="margin-top:6px">${d.usuarios_sin_telefono} usuarios activos no tienen celular cargado: no van a recibir avisos. Se carga en Usuarios → Editar, o cada uno desde 📱 WhatsApp en su menú.</div>` : ''}</div>
      <div class="resumen" style="margin:14px 0"><a href="#/usuarios?tab=whatsapp&estado=ENVIADA"><span>Enviados (30 días)</span><b>${c.ENVIADA || 0}</b></a>
        <a href="#/usuarios?tab=whatsapp&estado=ERROR"><span>Con error</span><b style="${c.ERROR ? 'color:var(--accent)' : ''}">${c.ERROR || 0}</b></a>
        <a href="#/usuarios?tab=whatsapp&estado=OMITIDA"><span>No enviados</span><b>${c.OMITIDA || 0}</b></a><a href="#/usuarios?tab=whatsapp"><span>Todos</span><b>→</b></a></div>
      <div class="toolbar"><div class="f"><label>Mandar un mensaje de prueba a</label><input id="wa-tel" placeholder="Celular, ej.: 236 4123456" inputmode="tel"></div>
        <div class="f"><label>Plantilla</label><select id="wa-pl"><option value="">hello_world (prueba de Meta)</option>${Object.entries({ solicitud_nueva: 'vinilo_solicitud_nueva', solicitud_resuelta: 'vinilo_solicitud_resuelta', pedido_proveedor: 'vinilo_pedido_proveedor' }).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <button class="btn" id="wa-test" ${d.configurado ? '' : 'disabled'}>Enviar prueba</button></div>
      <details class="card mt" ${d.configurado ? '' : 'open'}><summary style="cursor:pointer;font-weight:700;color:var(--side)">Plantillas que hay que crear en WhatsApp Manager</summary>
        <p class="stock-hint">Creá cada una con <b>categoría Utilidad</b>, idioma <b>Español (ARG)</b>, el <b>mismo nombre</b> y el texto tal cual (las variables {{1}}, {{2}}… las completa la app). Meta tiene que aprobarlas antes de usarlas.</p>
        ${d.plantillas.map((p) => `<div class="wa-pl"><div><b class="code">${esc(p.nombre)}</b> <span class="muted">· para ${esc(p.para.toLowerCase())}</span></div>
          <pre>${esc(p.texto)}</pre><div class="stock-hint">Ejemplo: ${esc(p.ejemplo_texto)}</div><button class="btn ghost sm" data-copy="${esc(p.texto)}">Copiar texto</button></div>`).join('')}</details>
      <h2 class="mt" style="margin-top:20px">Últimos avisos${est ? ` · ${EST[est] ? EST[est][0] : est}` : ''}</h2>
      ${d.notificaciones.length ? `<div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Aviso</th><th>Para</th><th>Mensaje</th><th>Estado</th><th></th></tr></thead><tbody>
        ${d.notificaciones.map((n) => `<tr><td class="muted" style="white-space:nowrap">${fmtFecha(n.creado_en)}</td><td>${esc(EVT[n.evento] || n.evento)}</td>
          <td><b>${esc(n.destinatario || '')}</b><div class="code">${esc(n.telefono || '—')}</div></td><td style="max-width:420px;font-size:.85rem">${esc(n.texto || '')}</td>
          <td><span class="badge ${EST[n.estado][1]}">${EST[n.estado][0]}</span>${n.detalle ? `<div class="stock-hint" style="max-width:240px">${esc(n.detalle)}</div>` : ''}</td>
          <td>${['ERROR', 'OMITIDA'].includes(n.estado) && d.configurado && /^\d{10,15}$/.test(n.telefono || '') ? `<button class="btn ghost sm" data-re="${n.id}">Reintentar</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="card empty">Todavía no se mandó ningún aviso.</div>'}`;
    $('#wa-test').addEventListener('click', async () => {
      try { const r = await api('/api/whatsapp/prueba', { method: 'POST', body: { telefono: $('#wa-tel').value, plantilla: $('#wa-pl').value } }); toast(`Mensaje enviado a +${r.telefono}`); router(); }
      catch (err) { toast(err.message, true); }
    });
    $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Texto copiado'); } catch (_) { toast('No se pudo copiar', true); } }));
    $$('[data-re]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await api(`/api/whatsapp/${b.dataset.re}/reintentar`, { method: 'POST' }); toast(r.estado === 'ENVIADA' ? 'Enviado' : `No se pudo: ${r.detalle || ''}`, r.estado !== 'ENVIADA'); router(); }
      catch (err) { toast(err.message, true); }
    }));
  }

  // ---------- Roles ----------
  const tabsUsuarios = (act) => `<div class="tabs"><a href="#/usuarios" class="${act === 'usuarios' ? 'on' : ''}">Usuarios</a><a href="#/usuarios?tab=roles" class="${act === 'roles' ? 'on' : ''}">Roles</a>${S.user.rol === 'ADMIN' ? `<a href="#/usuarios?tab=accesos" class="${act === 'accesos' ? 'on' : ''}">Accesos</a>` : ''}<a href="#/usuarios?tab=whatsapp" class="${act === 'whatsapp' ? 'on' : ''}">WhatsApp</a></div>`;

  async function vistaRoles(main) {
    const [roles, cat] = await Promise.all([api('/api/roles'), api('/api/roles/catalogo')]);
    const nomAlm = (ids) => (ids ? ids.map((id) => (S.todosAlmacenes.find((a) => a.id === id) || { nombre: `#${id}` }).nombre).join(', ') : 'Todos');
    const menus = (r) => [...new Set(cat.filter((c) => r.permisos.includes(c.clave)).map((c) => c.menu))];
    main.innerHTML = `${tabsUsuarios('roles')}<h1>Roles</h1>
      <p class="sub">Elegí, para cada rol, a qué opciones del menú accede y qué almacenes ve. El Administrador tiene acceso total y el Proveedor solo a su portal.</p>
      <div class="toolbar"><div class="spacer"></div><button class="btn" id="rl-new">+ Nuevo rol</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Rol</th><th>Menú habilitado</th><th>Almacenes</th><th class="num">Usuarios</th><th></th></tr></thead><tbody>
      ${roles.map((r) => `<tr><td><b>${esc(r.nombre)}</b><br><span class="muted" style="font-size:.85rem">${esc(r.descripcion || '')}</span></td>
        <td>${r.codigo === 'PROVEEDOR' ? '<span class="muted">Portal: sus pedidos y documentos</span>' : r.codigo === 'ADMIN' ? '<span class="muted">Todo</span>' : menus(r).map((m) => `<span class="badge b-rol">${esc(m)}</span>`).join(' ')}</td>
        <td>${r.codigo === 'PROVEEDOR' ? '—' : esc(nomAlm(r.almacenes))}</td><td class="num">${r.usuarios}</td>
        <td class="num">${r.fijo ? '<span class="muted" style="font-size:.85rem">fijo</span>' : `<button class="btn ghost sm" data-ed="${esc(r.codigo)}">Editar</button>`}</td></tr>`).join('')}
      </tbody></table></div>`;
    const editar = (r) => {
      const grupos = [...new Set(cat.map((c) => c.grupo))];
      const todos = !r || !r.almacenes;
      const m = modal(`<h2>${r ? 'Editar rol' : 'Nuevo rol'}</h2><form id="f-rl">
        <div class="row"><div class="f"><label>Nombre *</label><input name="nombre" value="${esc(r ? r.nombre : '')}" maxlength="80" required></div>
          <div class="f w"><label>Descripción</label><input name="descripcion" value="${esc(r ? r.descripcion || '' : '')}" maxlength="300"></div></div>
        <h2 class="mt" style="font-size:1rem">Opciones del menú y acciones</h2>
        <div class="perm-grid">${grupos.map((g) => `<fieldset><legend>${esc(g)}</legend>
          ${cat.filter((c) => c.grupo === g).map((c) => `<label class="check perm"><input type="checkbox" name="perm" value="${c.clave}" data-req="${c.requiere || ''}" ${r && r.permisos.includes(c.clave) ? 'checked' : ''}>
            <span><b>${esc(c.menu)}</b>${c.requiere ? ' · acción' : ''}<small>${esc(c.desc)}</small></span></label>`).join('')}</fieldset>`).join('')}</div>
        <h2 class="mt" style="font-size:1rem">Almacenes que ve</h2>
        <label class="check"><input type="radio" name="almmodo" value="todos" ${todos ? 'checked' : ''}> Todos los almacenes (incluye los que se creen después)</label>
        <label class="check mt"><input type="radio" name="almmodo" value="solo" ${todos ? '' : 'checked'}> Solo estos:</label>
        <div class="alm-list">${S.todosAlmacenes.map((a) => `<label class="check"><input type="checkbox" name="alm" value="${a.id}" ${r && r.almacenes && r.almacenes.includes(a.id) ? 'checked' : ''}> ${esc(a.nombre)}${a.activo ? '' : ' (inactivo)'}</label>`).join('')}</div>
        <p class="stock-hint">Un usuario solo ve el stock, los movimientos y las operaciones de sus almacenes. Para transferir o pedir mercadería puede elegir cualquier almacén como contraparte.</p>
        <div class="form-actions">${r && !r.sistema ? '<button type="button" class="btn danger" id="rl-del">Eliminar rol</button>' : ''}<span style="flex:1"></span>
          <button type="button" class="btn sec" data-close>Cancelar</button><button class="btn">Guardar</button></div></form>`, { wide: true });
      const f = $('#f-rl', m);
      // marcar una acción marca su menú; desmarcar el menú desmarca sus acciones
      $$('input[name=perm]', m).forEach((c) => c.addEventListener('change', () => {
        if (c.checked && c.dataset.req) { const base = $(`input[name=perm][value="${c.dataset.req}"]`, m); if (base) base.checked = true; }
        if (!c.checked) $$(`input[name=perm][data-req="${c.value}"]`, m).forEach((x) => { x.checked = false; });
      }));
      const syncAlm = () => { const solo = f.almmodo.value === 'solo'; $$('input[name=alm]', m).forEach((x) => { x.disabled = !solo; }); };
      $$('input[name=almmodo]', m).forEach((x) => x.addEventListener('change', syncAlm)); syncAlm();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { nombre: f.nombre.value, descripcion: f.descripcion.value,
          permisos: $$('input[name=perm]:checked', m).map((x) => x.value),
          almacenes: f.almmodo.value === 'todos' ? null : $$('input[name=alm]:checked', m).map((x) => Number(x.value)) };
        try {
          await api(r ? '/api/roles/' + encodeURIComponent(r.codigo) : '/api/roles', { method: r ? 'PUT' : 'POST', body });
          closeModal(); toast('Rol guardado. Los usuarios lo ven al recargar la página.'); router();
        } catch (err) { toast(err.message, true); }
      });
      if ($('#rl-del', m)) $('#rl-del', m).onclick = async () => {
        if (!confirm(`¿Eliminar el rol ${r.nombre}?`)) return;
        try { await api('/api/roles/' + encodeURIComponent(r.codigo), { method: 'DELETE' }); closeModal(); toast('Rol eliminado'); router(); } catch (err) { toast(err.message, true); }
      };
    };
    $('#rl-new').onclick = () => editar(null);
    $$('[data-ed]').forEach((b) => b.addEventListener('click', () => editar(roles.find((x) => x.codigo === b.dataset.ed))));
  }


  // ---------- Registro de accesos (solo ADMIN) ----------
  function dispositivo(ua) {
    ua = String(ua || '');
    if (!ua) return '—';
    const nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Otro';
    const so = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return `${nav}${so ? ' · ' + so : ''}${/Mobile|Android|iPhone/.test(ua) ? ' 📱' : ''}`;
  }
  async function vistaAccesos(main) {
    const usuarios = await api('/api/usuarios');
    const EV = { INGRESO: 'Ingreso', FALLIDO: 'Intento fallido', SALIDA: 'Salida', VER_COMO: 'Ver como' };
    main.innerHTML = `${tabsUsuarios('accesos')}<h1>Registro de accesos</h1>
      <p class="sub">Ingresos, intentos fallidos y salidas de los usuarios. Solo lo ve el administrador. Se guardan los últimos 400 días.</p>
      <div class="resumen" id="ac-res" style="margin-bottom:16px"></div>
      <div class="toolbar">
        <div class="f"><label>Usuario</label><select id="ac-u"><option value="">Todos</option>${usuarios.map((u) => `<option value="${u.id}">${esc(u.nombre)} (${esc(u.username)})</option>`).join('')}</select></div>
        <div class="f"><label>Evento</label><select id="ac-e"><option value="">Todos</option>${Object.entries(EV).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="f"><label>Desde</label><input type="date" id="ac-d"></div>
        <div class="f"><label>Hasta</label><input type="date" id="ac-h"></div>
        <div class="spacer"></div><button class="btn sec" id="ac-csv">Exportar CSV</button>
      </div><div id="ac-tbl"></div>`;
    let regs = [];
    const cargar = async () => {
      const qs = new URLSearchParams();
      [['usuario_id', '#ac-u'], ['evento', '#ac-e'], ['desde', '#ac-d'], ['hasta', '#ac-h']].forEach(([k, sel]) => { if ($(sel).value) qs.set(k, $(sel).value); });
      const r = await api('/api/accesos?' + qs);
      regs = r.registros;
      const h = r.ultimas24h;
      $('#ac-res').innerHTML = `<a><span>Ingresos (24 h)</span><b>${fmtN(h.ingresos)}</b><small>${fmtN(h.usuarios)} usuarios distintos</small></a>
        <a style="${h.fallidos ? 'border-color:#f3b8b1;background:#fff6f5' : ''}"><span>Intentos fallidos (24 h)</span><b style="${h.fallidos ? 'color:var(--accent)' : ''}">${fmtN(h.fallidos)}</b><small>contraseña o usuario incorrecto</small></a>`;
      $('#ac-tbl').innerHTML = regs.length ? `<div class="tbl-wrap"><table><thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Evento</th><th>Detalle</th><th>IP</th><th>Dispositivo</th></tr></thead><tbody>
        ${regs.map((x) => `<tr><td>${fmtFecha(x.fecha)}</td><td>${x.nombre ? `<b>${esc(x.nombre)}</b> <span class="code">${esc(x.username)}</span>` : `<span class="code">${esc(x.username || '—')}</span>`}</td>
          <td><span class="badge ac-${x.evento}">${EV[x.evento] || x.evento}</span></td><td class="muted">${esc(x.motivo || '')}</td>
          <td class="code">${esc(x.ip || '')}</td><td title="${esc(x.user_agent || '')}">${esc(dispositivo(x.user_agent))}</td></tr>`).join('')}
        </tbody></table></div><p class="muted">${regs.length === 500 ? 'Se muestran los últimos 500 registros; usá los filtros para acotar.' : `${regs.length} registros`}</p>`
        : '<div class="card empty">No hay accesos para el filtro.</div>';
    };
    ['#ac-u', '#ac-e', '#ac-d', '#ac-h'].forEach((sel) => $(sel).addEventListener('change', () => cargar().catch((e) => toast(e.message, true))));
    $('#ac-csv').onclick = () => descargarCSV(`accesos_${hoyISO()}.csv`, [
      ['Fecha', 'Usuario', 'Nombre', 'Evento', 'Detalle', 'IP', 'Dispositivo'],
      ...regs.map((x) => [fmtFecha(x.fecha), x.username || '', x.nombre || '', EV[x.evento] || x.evento, x.motivo || '', x.ip || '', dispositivo(x.user_agent)]),
    ]);
    await cargar();
  }

  // ---------- Proveedores ----------
  VIEWS.proveedores = async (main) => {
    const provs = await api('/api/proveedores');
    const fe = await api('/api/fudo/estado').catch(() => null);
    const u = fe && fe.ultimo;
    const fudoHtml = !fe ? '' : !fe.configurado
      ? `<div class="card" style="background:#faf8f5">🔌 <b>Fudo:</b> sincronización no configurada. Cargá <span class="code">FUDO_API_KEY</span> y <span class="code">FUDO_API_SECRET</span> en Render (Environment) para traer los proveedores automáticamente.</div>`
      : `<div class="card" style="background:#faf8f5;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:260px">🔄 <b>Sincronizado con Fudo</b>${fe.minutos ? ` cada ${fe.minutos} min` : ''} · ${fe.vinculados} proveedores vinculados<br>
          <span class="stock-hint">${u ? `Última: ${fmtFecha(u.fin || u.inicio)} · ${u.ok === false ? `<b class="bad">Error: ${esc(u.detalle || '')}</b>` : u.ok ? `${u.leidos} leídos, ${u.creados} nuevos, ${u.actualizados} actualizados, ${u.desactivados} desactivados` : 'en curso…'}` : 'Todavía no se sincronizó.'}
          ${u && u.ok && u.detalle ? `<br>⚠ ${esc(u.detalle).replace(/\n/g, '<br>⚠ ')}` : ''}</span></div>
          <button class="btn sec" id="pv-sync">Sincronizar con Fudo</button></div>`;
    main.innerHTML = `<h1>Proveedores</h1><p class="sub">Para que un proveedor entre al sistema, creá un usuario con rol <b>Proveedor</b> vinculado acá${puede('usuarios') ? ' (en Usuarios)' : ' (lo hace el administrador)'}.</p>
      ${fudoHtml}
      <div class="toolbar"><div class="grow"><label>Buscar</label><input id="pv-q" placeholder="Nombre, CUIT, comentario…"></div>
        <label class="check" style="margin-bottom:10px"><input type="checkbox" id="pv-inac"> Ver inactivos</label>
        <div class="spacer"></div><button class="btn" id="pv-new">+ Nuevo proveedor</button></div>
      <div id="pv-tbl"></div>`;
    const pintarProv = () => {
      const q = $('#pv-q').value.trim().toLowerCase();
      const rows = provs.filter((p) => ($('#pv-inac').checked || p.activo) && (!q || [p.nombre, p.cuit, p.comentario, p.contacto, p.email].join(' ').toLowerCase().includes(q)));
      $('#pv-tbl').innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>Nombre</th><th>CUIT</th><th>Contacto</th><th>Teléfono / Email</th><th>Dirección</th><th>Comentario</th><th class="num">Usuarios</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map((p) => `<tr class="${p.activo ? '' : 'inactive'}"><td><b>${esc(p.nombre)}</b>${p.fudo_id ? ' <span class="badge b-rol" title="Sincronizado desde Fudo">Fudo</span>' : ''}${p.activo ? '' : ' (inactivo)'}</td><td>${esc(p.cuit || '')}</td><td>${esc(p.contacto || '')}</td>
        <td>${esc(p.telefono || '')}${p.telefono && p.email ? '<br>' : ''}${esc(p.email || '')}</td><td>${esc(p.direccion || '')}</td><td class="muted">${esc(p.comentario || '')}</td>
        <td class="num">${p.usuarios}</td><td class="num"><button class="btn ghost sm" data-ed="${p.id}">Editar</button></td></tr>`).join('') : '<tr><td colspan="8" class="empty">Sin proveedores para el filtro.</td></tr>'}
      </tbody></table></div><p class="muted">${rows.length} de ${provs.length} proveedores</p>`;
      $$('#pv-tbl [data-ed]').forEach((b) => b.addEventListener('click', () => editar(provs.find((x) => x.id == b.dataset.ed))));
    };
    const editar = (p) => {
      const m = modal(`<h2>${p ? 'Editar' : 'Nuevo'} proveedor</h2>${p && p.fudo_id ? `<p class="obs" style="margin-top:-6px">🔄 Vinculado a Fudo (Id ${esc(p.fudo_id)}): nombre, email, teléfono, dirección, CUIT, comentario y estado se actualizan desde Fudo; los cambios hechos acá se pisan en la próxima sincronización. El campo <b>Contacto</b> es solo de esta app.</p>` : ''}<form id="f-pv">
        <div class="f"><label>Razón social / nombre *</label><input name="nombre" value="${esc(p ? p.nombre : '')}" required maxlength="150"></div>
        <div class="row mt"><div class="f"><label>CUIT</label><input name="cuit" value="${esc(p ? p.cuit || '' : '')}" maxlength="20"></div>
          <div class="f"><label>Contacto</label><input name="contacto" value="${esc(p ? p.contacto || '' : '')}" maxlength="120"></div></div>
        <div class="row mt"><div class="f"><label>Email</label><input type="email" name="email" value="${esc(p ? p.email || '' : '')}" maxlength="150"></div>
          <div class="f"><label>Teléfono / WhatsApp</label><input name="telefono" value="${esc(p ? p.telefono || '' : '')}" maxlength="50" placeholder="Celular con código de área: 236 4123456"></div></div>
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
    if ($('#pv-sync')) $('#pv-sync').onclick = async () => {
      const b = $('#pv-sync'); b.disabled = true; b.textContent = 'Sincronizando…';
      try {
        const r = await api('/api/fudo/sincronizar', { method: 'POST' });
        toast(`Fudo: ${r.creados} nuevos, ${r.actualizados} actualizados, ${r.desactivados} desactivados`);
        router();
      } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Sincronizar con Fudo'; }
    };
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


  // ---------- Vinilito (asistente) ----------
  const VN = { abierto: false, historial: [], modo: 'reglas', ejemplos: [] };
  try { VN.historial = JSON.parse(sessionStorage.getItem('vinilito_hist') || '[]'); } catch (_) { VN.historial = []; }
  const guardarHist = () => { try { sessionStorage.setItem('vinilito_hist', JSON.stringify(VN.historial.slice(-30))); } catch (_) { /* sin storage */ } };
  // Markdown mínimo y seguro: **negrita** y listas con "- "
  function mdLite(txt) {
    const lineas = esc(txt).split('\n');
    let html = '', enLista = false;
    for (const l of lineas) {
      const li = l.match(/^\s*[-•]\s+(.*)$/);
      if (li) { if (!enLista) { html += '<ul>'; enLista = true; } html += `<li>${li[1]}</li>`; continue; }
      if (enLista) { html += '</ul>'; enLista = false; }
      html += l.trim() ? `<p>${l}</p>` : '';
    }
    if (enLista) html += '</ul>';
    return html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  function montarVinilito() {
    if (S.user.rol === 'PROVEEDOR' || $('#vn-fab')) return;
    if (!['verStock', 'verPedidos', 'verCompras', 'consumir', 'recibir', 'verMovimientos', 'compras'].some(puede)) return;
    const root = document.createElement('div');
    root.innerHTML = `
      <button id="vn-fab" class="vn-fab" aria-label="Preguntale a Vinilito" title="Preguntale a Vinilito"><img src="/vinilito-cara.svg" alt=""><span class="vn-fab-txt">Preguntale a Vinilito</span></button>
      <section id="vn-panel" class="vn-panel" hidden role="dialog" aria-label="Vinilito">
        <header><img src="/vinilito.svg" alt=""><div><b>Vinilito</b><small id="vn-modo">Tu mozo de almacén</small></div>
          <button class="vn-x" id="vn-limpiar" title="Nueva conversación">↺</button><button class="vn-x" id="vn-cerrar" aria-label="Cerrar">✕</button></header>
        <div class="vn-msgs" id="vn-msgs" aria-live="polite"></div>
        <div class="vn-chips" id="vn-chips"></div>
        <form id="vn-form" class="vn-form"><input id="vn-in" autocomplete="off" maxlength="1000" placeholder="Ej.: ¿Cuántas Coca-Cola hay en el Galpón?"><button class="btn" aria-label="Enviar">➤</button></form>
      </section>`;
    document.body.appendChild(root);
    $('#vn-fab').onclick = () => abrirVinilito(!VN.abierto);
    $('#vn-cerrar').onclick = () => abrirVinilito(false);
    $('#vn-limpiar').onclick = () => { VN.historial = []; guardarHist(); pintarVinilito(); };
    $('#vn-form').addEventListener('submit', (e) => { e.preventDefault(); preguntarVinilito($('#vn-in').value); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && VN.abierto) abrirVinilito(false); });
    api('/api/vinilito').then((r) => { VN.modo = r.modo; VN.ejemplos = r.ejemplos; pintarVinilito(); }).catch(() => {});
  }
  function abrirVinilito(si) {
    VN.abierto = si;
    $('#vn-panel').hidden = !si;
    $('#vn-fab').classList.toggle('on', si);
    if (si) { pintarVinilito(); setTimeout(() => $('#vn-in').focus(), 50); }
  }
  function pintarVinilito(pensando = false) {
    const box = $('#vn-msgs');
    if (!box) return;
    const saludo = { rol: 'vinilito', texto: `¡Hola ${S.user.nombre.split(' ')[0]}! Soy **Vinilito** 🍕. ¿Qué te traigo? Preguntame por stock, reposición, vencimientos, pedidos o consumos.` };
    box.innerHTML = [saludo, ...VN.historial].map((m) => `<div class="vn-m ${m.rol === 'yo' ? 'yo' : 'vn'}">${m.rol === 'yo' ? '' : '<img src="/vinilito-cara.svg" alt="">'}
      <div class="vn-b">${m.rol === 'yo' ? `<p>${esc(m.texto)}</p>` : mdLite(m.texto)}${(m.acciones || []).map((a) => `<a class="vn-acc" href="${esc(a.link)}">${esc(a.texto)} →</a>`).join('')}</div></div>`).join('')
      + (pensando ? '<div class="vn-m vn"><img src="/vinilito-cara.svg" alt=""><div class="vn-b vn-typing"><span></span><span></span><span></span></div></div>' : '');
    box.scrollTop = box.scrollHeight;
    $('#vn-chips').innerHTML = VN.historial.length ? '' : (VN.ejemplos || []).slice(0, 4).map((e) => `<button type="button" class="vn-chip">${esc(e)}</button>`).join('');
    $$('#vn-chips .vn-chip').forEach((c) => c.addEventListener('click', () => preguntarVinilito(c.textContent)));
    $$('#vn-msgs .vn-acc').forEach((a) => a.addEventListener('click', () => { if (window.innerWidth < 860) abrirVinilito(false); }));
    $('#vn-modo').textContent = VN.modo === 'claude' ? 'Tu mozo de almacén · con IA' : 'Tu mozo de almacén';
  }
  async function preguntarVinilito(txt) {
    txt = String(txt || '').trim();
    if (!txt) return;
    $('#vn-in').value = '';
    const previo = VN.historial.slice(-8).map((m) => ({ rol: m.rol, texto: m.texto }));
    VN.historial.push({ rol: 'yo', texto: txt });
    pintarVinilito(true);
    try {
      const r = await api('/api/vinilito', { method: 'POST', body: { mensaje: txt, historial: previo } });
      VN.historial.push({ rol: 'vinilito', texto: r.texto, acciones: r.acciones || [] });
    } catch (err) {
      VN.historial.push({ rol: 'vinilito', texto: `Uy, se me cayó la bandeja 😬: ${err.message}` });
    }
    guardarHist();
    pintarVinilito();
  }

  boot();
})();
