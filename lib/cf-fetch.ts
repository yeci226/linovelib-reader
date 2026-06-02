/**
 * Cloudflare-aware fetch via FlareSolverr.
 *
 * FlareSolverr 跑 headless Chromium 解 CF challenge，回傳 HTML + cookies。
 * 解過一次後我們把 cookies 快取，後續直接用普通 fetch 重用，省下 5-10 秒。
 *
 * Docs: https://github.com/FlareSolverr/FlareSolverr
 */
import { setTimeout as sleep } from "node:timers/promises";

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL ?? "http://localhost:8191/v1";

const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const DEFAULT_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,zh-CN;q=0.8",
  Cookie: "night=0",
};

type CookieJarEntry = {
  cookieHeader: string;
  userAgent: string;
  expiresAt: number; // epoch ms
};

// host -> cookies. CF clearance is per-host.
const jar = new Map<string, CookieJarEntry>();

// Cookie 重用窗口：CF clearance 一般有效約 30 分鐘。保守設 20 分。
const COOKIE_TTL_MS = 20 * 60 * 1000;

type FlareResp = {
  status: string;
  message: string;
  solution?: {
    url: string;
    status: number;
    cookies: { name: string; value: string; domain: string }[];
    userAgent: string;
    response: string; // HTML
  };
};

async function solveWithFlareSolverr(url: string): Promise<FlareResp["solution"]> {
  const res = await fetch(FLARESOLVERR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cmd: "request.get",
      url,
      maxTimeout: 60000,
    }),
  });
  if (!res.ok) {
    throw new Error(`FlareSolverr HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as FlareResp;
  if (data.status !== "ok" || !data.solution) {
    throw new Error(`FlareSolverr failed: ${data.message}`);
  }
  return data.solution;
}

function cacheCookies(host: string, sol: NonNullable<FlareResp["solution"]>) {
  const cookieHeader = sol.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  jar.set(host, {
    cookieHeader,
    userAgent: sol.userAgent || UA,
    expiresAt: Date.now() + COOKIE_TTL_MS,
  });
}

function getCachedJar(host: string): CookieJarEntry | null {
  const entry = jar.get(host);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    jar.delete(host);
    return null;
  }
  return entry;
}

/**
 * Fetch a URL, transparently handling Cloudflare.
 * Returns the HTML body as string.
 *
 * Strategy:
 *  1. Try direct fetch with cached CF cookies (if any).
 *  2. If response looks like a CF challenge (403/503 or cf-mitigated header), fall back to FlareSolverr.
 *  3. Cache the new cookies for subsequent requests.
 */
export async function cfFetchHtml(url: string): Promise<string> {
  const host = new URL(url).host;
  const cached = getCachedJar(host);

  if (cached) {
    const direct = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        "User-Agent": cached.userAgent,
        Cookie: `night=0; ${cached.cookieHeader}`,
      },
    });
    if (direct.ok && !isCfChallenge(direct)) {
      return await direct.text();
    }
    // cookies dead — drop and re-solve
    jar.delete(host);
  }

  // small jitter to avoid burst
  await sleep(200 + Math.floor(Math.random() * 300));

  // Try FlareSolverr if available, otherwise fall back to direct fetch
  try {
    const sol = await solveWithFlareSolverr(url);
    if (!sol) throw new Error("no solution");
    cacheCookies(host, sol);
    return sol.response;
  } catch (e) {
    const msg = String(e);
    // If FlareSolverr is simply not running, fall back to direct fetch
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("500")) {
      console.warn("[cf-fetch] FlareSolverr unavailable, falling back to direct fetch:", msg);
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      return await res.text();
    }
    throw e;
  }
}

function isCfChallenge(res: Response): boolean {
  if (res.status === 403 || res.status === 503) return true;
  const server = res.headers.get("server") ?? "";
  const mitigated = res.headers.get("cf-mitigated");
  if (mitigated) return true;
  if (server.toLowerCase().includes("cloudflare") && res.status >= 400) return true;
  return false;
}
