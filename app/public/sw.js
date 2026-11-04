// Particull service worker: opens instantly from a cached copy of the app, and shows the
// last data it saw when the server can't be reached. The server fills in BUILD and ASSETS.
const BUILD = '{{BUILD}}';
const ASSETS = JSON.parse('{{ASSETS}}');
const SHELL = `particull-shell-${BUILD}`;
const API = 'particull-api';
const API_TIMEOUT = 4000;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Fetch fresh copies so the cached app is one consistent version.
    await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('particull-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function offlineResponse() {
  return new Response(JSON.stringify({ error: 'You’re offline, so this can’t be saved. Try again when Particull is reachable.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'X-Particull-Offline': '1' },
  });
}

async function fromApi(request) {
  const cache = await caches.open(API);
  const network = fetch(request).then(res => {
    if (res.ok && !res.headers.get('Content-Disposition')) cache.put(request, res.clone());
    return res;
  });
  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), API_TIMEOUT)),
    ]);
  } catch {
    const cached = await cache.match(request);
    if (!cached) {
      try { return await network; } catch { return offlineResponse(); }
    }
    const headers = new Headers(cached.headers);
    headers.set('X-Particull-Offline', '1');
    return new Response(await cached.blob(), { status: cached.status, headers });
  }
}

async function fromShell(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try { return await fetch(request); } catch { return Response.error(); }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET') {
      event.respondWith(fetch(request).catch(offlineResponse));
      return;
    }
    if (url.pathname.startsWith('/api/backups/') || url.searchParams.has('download')) return;
    event.respondWith(fromApi(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(caches.open(SHELL).then(c => c.match('/')).then(hit => hit || fetch(request)));
    return;
  }
  event.respondWith(fromShell(request));
});
