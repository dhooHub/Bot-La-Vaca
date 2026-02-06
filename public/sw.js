// Service Worker para TICObot PWA
const CACHE_NAME = 'ticobot-v1';

// Instalar - cachear recursos básicos
self.addEventListener('install', event => {
  console.log('🐄 Service Worker instalado');
  self.skipWaiting();
});

// Activar
self.addEventListener('activate', event => {
  console.log('🐄 Service Worker activado');
  event.waitUntil(clients.claim());
});

// Interceptar fetch (opcional, para offline)
self.addEventListener('fetch', event => {
  // Por ahora solo pass-through
  event.respondWith(fetch(event.request));
});

// Recibir mensajes del panel principal
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = event.data;
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: tag || 'ticobot-notification',
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 200, 100, 200],
      actions: [
        { action: 'open', title: 'Abrir Panel' },
        { action: 'dismiss', title: 'Ignorar' }
      ]
    });
  }
});

// Click en notificación
self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  if (event.action === 'dismiss') {
    return;
  }
  
  // Abrir o enfocar el panel
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Si ya hay una ventana abierta, enfocarla
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Si no, abrir una nueva
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// Push notification (para futuro si agregamos servidor push)
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'TICObot', body: 'Nueva notificación' };
  
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'ticobot-push',
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 200]
    })
  );
});
