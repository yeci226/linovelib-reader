import { NextRequest } from "next/server";

export const runtime = "nodejs";

const TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const BROWSER_CACHE_SEC = 60 * 60;   // 1 hour browser cache
const MAX_ENTRIES = 500;

// Mac-side Playwright backend (Cloudflare Tunnel URL). If unset, skip straight to CORS proxies.
const BACKEND_URL = process.env.BACKEND_URL ?? "";
const BACKEND_TOKEN = process.env.BACKEND_TOKEN ?? "";
const BACKEND_TIMEOUT_MS = 25_000;

// Linovelib's server-side truncation marker. If we see this in the returned HTML, the fetch
// effectively failed — try the next source.
const TRUNCATION_MARKERS = ["內容加載失敗", "内容加载失败"];

type CacheEntry = { html: string; status: number; ts: number; source: string };
const cache = new Map<string, CacheEntry>();

function pruneCache() {
  if (cache.size <= MAX_ENTRIES) return;
  const sorted = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (const [key] of sorted.slice(0, cache.size - MAX_ENTRIES)) {
    cache.delete(key);
  }
}

function makeHeaders(xCache: string, status: number, source: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "X-Cache": xCache,
    "X-Proxy-Source": source,
  };
  if (status >= 200 && status < 300) {
    headers["Cache-Control"] = `public, max-age=${BROWSER_CACHE_SEC}`;
  }
  return headers;
}

function looksTruncated(html: string): boolean {
  return TRUNCATION_MARKERS.some((m) => html.includes(m));
}

// --- Mac backend ---
async function tryBackend(url: string): Promise<string> {
  if (!BACKEND_URL || !BACKEND_TOKEN) throw new Error("backend not configured");
  const backendUrl = `${BACKEND_URL.replace(/\/$/, "")}/fetch?url=${encodeURIComponent(url)}`;
  const res = await fetch(backendUrl, {
    headers: { Authorization: `Bearer ${BACKEND_TOKEN}` },
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`backend HTTP ${res.status}`);
  const html = await res.text();
  if (html.length < 500) throw new Error("backend response too short");
  return html;
}

// --- CORS proxies ---
const PROXY_SERVICES = [
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

async function tryProxy(makeUrl: (u: string) => string, url: string): Promise<string> {
  const res = await fetch(makeUrl(url), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (html.startsWith("{") && html.includes('"http_code":403')) throw new Error("403 from upstream");
  if (html.length < 500) throw new Error("Response too short, likely an error page");
  return html;
}

async function fetchViaCorsProxies(url: string): Promise<string> {
  return Promise.any(PROXY_SERVICES.map((maker) => tryProxy(maker, url)));
}

// --- Orchestration ---
async function fetchHtml(url: string): Promise<{ html: string; status: number; source: string }> {
  // 1. Try Mac backend first if configured.
  if (BACKEND_URL && BACKEND_TOKEN) {
    try {
      const html = await tryBackend(url);
      if (!looksTruncated(html)) {
        return { html, status: 200, source: "backend" };
      }
      // Backend returned but content is still truncated — odd, but fall through to proxies as a tiebreaker.
    } catch {
      // backend failed — fall through
    }
  }

  // 2. Fallback: race CORS proxies.
  try {
    const html = await fetchViaCorsProxies(url);
    return { html, status: 200, source: "cors-proxy" };
  } catch {
    return { html: "All sources failed (backend + CORS proxies).", status: 502, source: "none" };
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new Response("Missing url", { status: 400 });

  const now = Date.now();

  // Return cached entry if fresh
  const hit = cache.get(url);
  if (hit && now - hit.ts < TTL_MS) {
    return new Response(hit.html, {
      status: hit.status,
      headers: makeHeaders("HIT", hit.status, hit.source),
    });
  }

  const { html, status, source } = await fetchHtml(url);

  // Cache successful, non-truncated responses
  if (status === 200 && !looksTruncated(html)) {
    cache.set(url, { html, status, ts: now, source });
    pruneCache();
  }

  return new Response(html, {
    status,
    headers: makeHeaders("MISS", status, source),
  });
}
