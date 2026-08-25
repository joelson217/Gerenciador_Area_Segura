// ============================================
// ÁREA SEGURA PRO - SERVICE WORKER
// Versão: 3.8.6 Pro Enterprise
// ============================================

const CACHE_NAME = 'gerenciador-v3.8.6';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './qrcode.js',
  './manifest.json',
  './logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn('[SW] Aviso ao cachear assets iniciais:', err);
      });
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Removendo cache antigo:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Network-First para conteúdo do app e bypass para APIs/version.json
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // 1. Bypass total de cache para APIs e checagem de versão
  if (
    url.includes('version.json') ||
    url.includes('supabase.co') ||
    url.includes('api.ipify.org') ||
    url.includes('ipinfo.io')
  ) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  // 2. Estratégia Network-First para páginas e assets
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
