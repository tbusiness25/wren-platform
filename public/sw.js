/* Wren service worker — web push delivery + notification clicks.
 * Registered by wren-app-shell.js on the EY portal. Kept deliberately minimal:
 * it exists so PushManager subscriptions can be created and incoming pushes shown.
 */
'use strict';

const ICON = '/little-angels-logo.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Incoming web push → show a notification.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { title: 'Wren', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Wren';
  const options = {
    body: data.body || '',
    icon: ICON,
    badge: ICON,
    tag: data.tag || 'wren',
    renotify: true,
    data: { url: data.url || '/ey/inbox' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Click → focus an existing Wren window (navigating it) or open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        try { await w.navigate(url); } catch (_) { /* cross-origin/nav guard */ }
        return w.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
