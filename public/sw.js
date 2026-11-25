// Service worker de Vinilo: recibe las notificaciones push y abre la app al tocarlas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Vinilo', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Vinilo', {
    body: d.body || '', icon: '/icon-192.png', badge: '/badge-96.png', tag: d.tag || undefined, renotify: !!d.tag,
    data: { url: d.url || '/' }, vibrate: [120, 60, 120], lang: 'es-AR',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = new URL(e.notification.data && e.notification.data.url ? e.notification.data.url : '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if (new URL(w.url).origin === self.location.origin) { await w.focus(); if ('navigate' in w) return w.navigate(destino); return; } }
    return self.clients.openWindow(destino);
  })());
});
