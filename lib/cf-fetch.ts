/**
 * HTML fetcher with Playwright backend support.
 *
 * Priority:
 *  1. PLAYWRIGHT_BACKEND_URL is set → call the Mac Playwright server (real Chromium + stealth)
 *  2. FlareSolverr available → use it
 *  3. Direct fetch fallback
 */
import { setTimeout as sleep } from "node:timers/promises";

const PLAYWRIGHT_BACKEND_URL = process.env.PLAYWRIGHT_BACKEND_URL ?? "";
const PLAYWRIGHT_AUTH_TOKEN = process.env.PLAYWRIGHT_AUTH_TOKEN ?? "";

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL ?? "http://localhost:8191/v1";

const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const DEFAULT_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,zh-CN;q=0.8",
  Cookie: "night=0",
};

/** Call the Mac Playwright backend's /fetch endpoint */
async function fetchViaPlaywrightBackend(url: string): Promise<string> {
  const endpoint = `${PLAYWRIGHT_BACKEND_URL}/fetch?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${PLAYWRIGHT_AUTH_TOKEN}` },
    // 60s timeout — Playwright can be slow on cold start
    signal: AbortSignal.timeout(65_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Playwright backend HTTP ${res.status}: ${body}`);
  }
  return res.text();
}

type CookieJarEntry = {
  cookieHeader: string;
  userAgent: string;
  expiresAt: number;
};

const jar = new Map<string, CookieJarEntry>();
const COOKIE_TTL_MS = 20 * 60 * 1000;

type FlareResp = {
  status: string;
  message: string;
  solution?: {
    url: string;
    status: number;
    cookies: { name: string; value: string; domain: string }[];
    userAgent: string;
    response: string;
  };
};

async function solveWithFlareSolverr(url: string): Promise<FlareResp["solution"]> {
  const res = await fetch(FLARESOLVERR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
  });
  if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as FlareResp;
  if (data.status !== "ok" || !data.solution)
    throw new Error(`FlareSolverr failed: ${data.message}`);
  return data.solution;
}

function cacheCookies(host: string, sol: NonNullable<FlareResp["solution"]>) {
  const cookieHeader = sol.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  jar.set(host, { cookieHeader, userAgent: sol.userAgent || UA, expiresAt: Date.now() + COOKIE_TTL_MS });
}

function getCachedJar(host: string): CookieJarEntry | null {
  const entry = jar.get(host);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { jar.delete(host); return null; }
  return entry;
}

/**
 * Fetch a URL, bypassing Cloudflare.
 *
 * Strategy:
 *  1. Playwright backend (if PLAYWRIGHT_BACKEND_URL set) — real browser, best quality
 *  2. FlareSolverr (if running locally)
 *  3. Direct fetch with cached CF cookies
 *  4. Direct fetch fallback
 */
export type CfFetchResult = { html: string; renderedByBrowser: boolean };

export async function cfFetchHtmlEx(url: string): Promise<CfFetchResult> {
  // 1. Playwright backend — returns fully rendered DOM (site JS has already unshuffled paragraphs)
  if (PLAYWRIGHT_BACKEND_URL) {
    const html = await fetchViaPlaywrightBackend(url);
    return { html, renderedByBrowser: true };
  }

  const host = new URL(url).host;
  const cached = getCachedJar(host);

  if (cached) {
    const direct = await fetch(url, {
      headers: { ...DEFAULT_HEADERS, "User-Agent": cached.userAgent, Cookie: `night=0; ${cached.cookieHeader}` },
    });
    if (direct.ok && !isCfChallenge(direct)) return { html: await direct.text(), renderedByBrowser: false };
    jar.delete(host);
  }

  await sleep(200 + Math.floor(Math.random() * 300));

  // 2. FlareSolverr — also renders via browser
  try {
    const sol = await solveWithFlareSolverr(url);
    if (!sol) throw new Error("no solution");
    cacheCookies(host, sol);
    return { html: sol.response, renderedByBrowser: true };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("500")) {
      console.warn("[cf-fetch] FlareSolverr unavailable, falling back to direct fetch:", msg);
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      return { html: await res.text(), renderedByBrowser: false };
    }
    throw e;
  }
}

export async function cfFetchHtml(url: string): Promise<string> {
  // 1. Playwright backend
  if (PLAYWRIGHT_BACKEND_URL) {
    return fetchViaPlaywrightBackend(url);
  }

  const host = new URL(url).host;
  const cached = getCachedJar(host);

  if (cached) {
    const direct = await fetch(url, {
      headers: { ...DEFAULT_HEADERS, "User-Agent": cached.userAgent, Cookie: `night=0; ${cached.cookieHeader}` },
    });
    if (direct.ok && !isCfChallenge(direct)) return await direct.text();
    jar.delete(host);
  }

  await sleep(200 + Math.floor(Math.random() * 300));

  // 2. FlareSolverr
  try {
    const sol = await solveWithFlareSolverr(url);
    if (!sol) throw new Error("no solution");
    cacheCookies(host, sol);
    return sol.response;
  } catch (e) {
    const msg = String(e);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("500")) {
      console.warn("[cf-fetch] FlareSolverr unavailable, falling back to direct fetch:", msg);
      // 3. Direct fetch fallback
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      return await res.text();
    }
    throw e;
  }
}

function isCfChallenge(res: Response): boolean {
  if (res.status === 403 || res.status === 503) return true;
  const mitigated = res.headers.get("cf-mitigated");
  if (mitigated) return true;
  const server = res.headers.get("server") ?? "";
  if (server.toLowerCase().includes("cloudflare") && res.status >= 400) return true;
  return false;
}
