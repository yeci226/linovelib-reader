const CACHE_NAME = "linovelib-v4";
const IMAGE_CACHE_NAME = "linovelib-images-v2";
const OFFLINE_ROUTE_CACHE_NAME = "linovelib-offline-routes-v1";
const CHAPTER_CONTENT_CACHE_NAME = "linovelib-chapter-content-v1";
const IMAGE_CACHE_MAX = 200;
const PRECACHE_URLS = ["/", "/catalog", "/read", "/bookshelf", "/settings"];

function extractShellAssetUrls(html) {
  const assets = new Set();
  const attributePattern = /(?:src|href)=["']([^"'#]+)["']/gi;
  let match;

  while ((match = attributePattern.exec(html)) !== null) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin !== self.location.origin) continue;
      if (!url.pathname.startsWith("/_next/") && url.pathname !== "/manifest.json") continue;
      assets.add(url.pathname + url.search);
    } catch {
      // Ignore malformed asset URLs in generated HTML.
    }
  }

  return [...assets];
}

async function cacheShellWithAssets(cache, shellUrl) {
  const response = await fetch(shellUrl, { cache: "reload" });
  if (!response.ok) throw new Error(`Failed to precache ${shellUrl}`);
  await cache.put(shellUrl, response.clone());

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return;
  const html = await response.text();
  const assets = extractShellAssetUrls(html);
  await Promise.allSettled(assets.map(async (assetUrl) => {
    if (await cache.match(assetUrl)) return;
    const assetResponse = await fetch(assetUrl, { cache: "reload" });
    if (assetResponse.ok) await cache.put(assetUrl, assetResponse.clone());
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(
      PRECACHE_URLS.map((url) => cacheShellWithAssets(cache, url))
    );
    if (results[0]?.status === "rejected") throw results[0].reason;
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => ![CACHE_NAME, IMAGE_CACHE_NAME, OFFLINE_ROUTE_CACHE_NAME, CHAPTER_CONTENT_CACHE_NAME].includes(key))
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
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

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const exact = await caches.match(request);
    if (exact) return exact;
    const pathname = new URL(request.url).pathname;
    return (await caches.match(pathname)) || (await caches.match("/")) || Response.error();
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
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
  } else if (url.pathname === "/api/image") {
    event.respondWith(cacheFirstImage(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});
