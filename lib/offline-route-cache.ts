export const OFFLINE_ROUTE_CACHE_NAME = "linovelib-offline-routes-v1";

type ResponseLike = {
  ok: boolean;
  headers: { get(name: string): string | null };
  clone(): ResponseLike;
  text(): Promise<string>;
};

type CacheLike = {
  match(request: string): Promise<unknown>;
  put(request: string, response: ResponseLike): Promise<unknown>;
};

type OfflineRouteCacheOptions = {
  origin?: string;
  cache?: CacheLike;
  fetchFn?: (request: string, init?: RequestInit) => Promise<ResponseLike>;
};

function extractShellAssetUrls(html: string, origin: string): string[] {
  const assets = new Set<string>();
  const attributePattern = /(?:src|href)=["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(html)) !== null) {
    try {
      const url = new URL(match[1], origin);
      if (url.origin !== origin) continue;
      if (!url.pathname.startsWith("/_next/") && url.pathname !== "/manifest.json") continue;
      assets.add(url.toString());
    } catch {
      // Ignore malformed asset URLs in the generated HTML.
    }
  }

  return [...assets];
}

export async function cacheOfflineRoute(
  href: string,
  options: OfflineRouteCacheOptions = {},
): Promise<boolean> {
  if (typeof window === "undefined" && !options.origin) return false;

  const origin = options.origin ?? window.location.origin;
  const fetchFn = options.fetchFn ?? ((request, init) => fetch(request, init) as unknown as Promise<ResponseLike>);
  const cache = options.cache ?? await caches.open(OFFLINE_ROUTE_CACHE_NAME) as unknown as CacheLike;
  const documentUrl = new URL(href, origin).toString();

  try {
    const response = await fetchFn(documentUrl, { cache: "reload" });
    if (!response.ok) return false;

    await cache.put(documentUrl, response.clone());
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return true;

    const html = await response.text();
    const assets = extractShellAssetUrls(html, origin);
    await Promise.allSettled(assets.map(async assetUrl => {
      if (await cache.match(assetUrl)) return;
      const assetResponse = await fetchFn(assetUrl, { cache: "reload" });
      if (assetResponse.ok) await cache.put(assetUrl, assetResponse.clone());
    }));
    return true;
  } catch {
    return false;
  }
}
