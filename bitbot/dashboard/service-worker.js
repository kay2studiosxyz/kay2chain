'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || './#trade', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(clients => {
    const existing = clients.find(client => client.url.startsWith(self.registration.scope));
    if (existing) return existing.focus().then(() => existing.navigate(destination));
    return self.clients.openWindow(destination);
  }));
});
