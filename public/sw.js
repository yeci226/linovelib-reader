const CACHE_NAME = "linovelib-v1";
const IMAGE_CACHE_NAME = "linovelib-images-v1";
const IMAGE_CACHE_MAX = 200;
const PRECACHE_URLS = ["/", "/catalog", "/read"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== IMAGE_CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName || CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || Response.error();
  }
}

async function networkFirstProxy(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=3600");
      const modified = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, modified.clone());
      return modified;
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || Response.error();
  }
}

async function cacheFirstImage(request) {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    // Revalidate in background
    fetch(request)
      .then((response) => {
        if (response.ok) {
          cache.put(request, response.clone());
          trimImageCache(cache);
        }
      })
      .catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
      trimImageCache(cache);
    }
    return response;
  } catch {
    return Response.error();
  }
}

async function trimImageCache(cache) {
  const keys = await cache.keys();
  if (keys.length > IMAGE_CACHE_MAX) {
    const toDelete = keys.slice(0, keys.length - IMAGE_CACHE_MAX);
    await Promise.all(toDelete.map((k) => cache.delete(k)));
  }
}

self.addEventListener("fetch", (event) => {
  const { url } = event.request;
  if (url.includes("/api/proxy")) {
    event.respondWith(networkFirstProxy(event.request));
  } else if (url.includes("/api/image")) {
    event.respondWith(cacheFirstImage(event.request));
  } else {
    event.respondWith(networkFirst(event.request));
  }
});
