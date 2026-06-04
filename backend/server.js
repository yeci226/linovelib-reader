// Mac-side Playwright backend for linovelib-reader.
// Renders pages in a real Chromium with stealth, returns fully decoded HTML.
//
// Env:
//   PORT          (default 3001)
//   AUTH_TOKEN    (required) — shared secret for Authorization: Bearer <token>
//   HEADLESS      (default "true") — set "false" to debug visually
//   CONCURRENCY   (default 2)
//   CACHE_TTL_MS  (default 1800000 = 30 min)
//   CACHE_MAX     (default 200)

import Fastify from "fastify";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import path from "path";
import fs from "fs";

chromiumExtra.use(StealthPlugin());

const PORT = Number(process.env.PORT ?? 3001);
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "";
const HEADLESS = (process.env.HEADLESS ?? "true") !== "false";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 30 * 60 * 1000);
const CACHE_MAX = Number(process.env.CACHE_MAX ?? 200);
const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 1500); // reduced from 2500
const JWT_SECRET = process.env.JWT_SECRET ?? "linovelib-secret-fallback";
const REGISTER_SECRET = process.env.REGISTER_SECRET ?? "";

if (!AUTH_TOKEN) {
  console.error("FATAL: AUTH_TOKEN env var is required");
  process.exit(1);
}

// --- URL allow-list ---
const ALLOWED_HOSTS = new Set([
  "www.linovelib.com",
  "w.linovelib.com",
  "tw.linovelib.com",
  "www.bilinovel.com",
  "bilinovel.com",
]);

function isAllowed(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// --- LRU-ish cache (Map preserves insertion order) ---
const cache = new Map(); // url -> { html, ts }
function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  // refresh LRU position
  cache.delete(url);
  cache.set(url, hit);
  return hit.html;
}
function cacheSet(url, html) {
  cache.set(url, { html, ts: Date.now() });
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

// --- Concurrency semaphore ---
let active = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    const tryGo = () => {
      if (active < CONCURRENCY) {
        active++;
        resolve(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
      } else {
        queue.push(tryGo);
      }
    };
    tryGo();
  });
}

// --- Browser singleton ---
let browser = null;
let context = null;
async function getContext() {
  if (browser && context) return context;
  browser = await chromiumExtra.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    extraHTTPHeaders: { "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8" },
  });
  // Block heavy resources we don't need for HTML extraction
  await context.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font") return route.abort();
    return route.continue();
  });
  return context;
}

async function renderPage(url) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    // 'load' waits for stylesheets + scripts so the anti-scrape JS can boot
    await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });

    const isChapter = new RegExp("\\/\\d+\\/\\d+\\.html").test(url) || new RegExp("_\\d+\\.html").test(url);

    if (isChapter) {
      // Wait for #acontent to exist
      await page.locator("#acontent, #acontent1, .acontent").first().waitFor({ timeout: 10_000 }).catch(() => {});

      // Wait until the deobfuscation JS has had a chance to settle. Two strategies:
      //  1. Wait for paragraph count inside #acontent to stop changing for 1.5s
      //  2. Hard timeout after SETTLE_MS
      await page
        .waitForFunction(
          (settleMs) => {
            const el = document.querySelector("#acontent, #acontent1, .acontent");
            if (!el) return false;
            const w = window;
            const now = Date.now();
            const count = el.querySelectorAll("p").length;
            if (!w.__lvCount || w.__lvCount !== count) {
              w.__lvCount = count;
              w.__lvStableSince = now;
              return false;
            }
            return now - w.__lvStableSince > 500 || now - (w.__lvStart ||= now) > settleMs;
          },
          SETTLE_MS,
          { timeout: SETTLE_MS + 5000, polling: 250 },
        )
        .catch(() => {});

      // Extract only the *visible* paragraphs from #acontent and rebuild a clean DOM.
      // linovelib inserts decoy <p data-kXXX> elements that are hidden via CSS.
      // We replace the raw acontent innerHTML with the cleaned version before serializing.
      await page.evaluate(() => {
        const el = document.querySelector("#acontent, #acontent1, .acontent");
        if (!el) return;
        const children = [...el.children];
        const kept = [];
        for (const child of children) {
          const tag = child.tagName.toLowerCase();
          if (tag === "p") {
            const cs = getComputedStyle(child);
            if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
            const rect = child.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            const txt = (child.innerText || "").trim();
            const hasImg = child.querySelector("img") !== null;
            if (!txt && !hasImg) continue;
            if (txt.includes("內容加載失敗") || txt.includes("内容加载失败")) continue;
            // Resolve lazy-load data-src → src for images
            child.querySelectorAll("img[data-src]").forEach((img) => {
              const ds = img.getAttribute("data-src");
              if (ds) img.setAttribute("src", ds.startsWith("//") ? "https:" + ds : ds);
            });
            // Strip the data-k* attribute so downstream parsing is clean
            [...child.attributes].forEach((a) => {
              if (a.name.startsWith("data-k")) child.removeAttribute(a.name);
            });
            kept.push(child.outerHTML);
          } else if (tag === "center" || tag === "br" || tag === "h1" || tag === "h2" || tag === "h3" || tag === "img") {
            kept.push(child.outerHTML);
          }
          // Skip ad <div>, <ins>, <script> etc.
        }
        el.innerHTML = kept.join("\\n");
      });
    }

    const html = await page.content();
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

// --- Database Setup ---
const dbDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, "app.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sync_data (
    user_id INTEGER PRIMARY KEY,
    history_json TEXT DEFAULT '{}',
    bookmarks_json TEXT DEFAULT '[]',
    bookshelf_json TEXT DEFAULT '[]',
    settings_json TEXT DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

try {
  db.exec("ALTER TABLE sync_data ADD COLUMN settings_json TEXT DEFAULT '{}'");
} catch (e) {
  // Ignore if column already exists
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const verifyHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return hash === verifyHash;
}

// --- Fastify server ---
const app = Fastify({ logger: { level: "info" } });

app.addHook("onRequest", async (req, reply) => {
  // CORS for browser-side calls (Vercel functions call server-side, but allow both)
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
});

app.options("/*", async (_req, reply) => reply.code(204).send());

app.get("/health", async () => ({ ok: true, active, queued: queue.length, cached: cache.size }));

app.get("/fetch", async (req, reply) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== AUTH_TOKEN) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  const url = req.query.url;
  if (!url || typeof url !== "string") {
    return reply.code(400).send({ error: "missing url" });
  }
  if (!isAllowed(url)) {
    return reply.code(403).send({ error: "host not allowed" });
  }

  const cached = cacheGet(url);
  if (cached) {
    reply.header("X-Backend-Cache", "HIT");
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(cached);
  }

  const release = await acquire();
  try {
    const html = await renderPage(url);
    cacheSet(url, html);
    reply.header("X-Backend-Cache", "MISS");
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(html);
  } catch (err) {
    req.log.error({ err: err.message, url }, "render failed");
    return reply.code(502).send({ error: "render failed", detail: err.message });
  } finally {
    release();
  }
});

app.get("/search", async (req, reply) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== AUTH_TOKEN) return reply.code(401).send({ error: "unauthorized" });
  
  const q = req.query.q;
  if (!q) return reply.code(400).send({ error: "missing q" });
  
  const release = await acquire();
  try {
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`https://www.bilinovel.com/search.html?searchkey=${encodeURIComponent(q)}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      
      // Wait for results or empty box to appear
      await page.waitForSelector(".book-li, .search-item, .empty-box", { timeout: 15_000 }).catch(() => {});
      
      const results = await page.evaluate(() => {
        const items = [...document.querySelectorAll(".book-li, .search-item")];
        return items.map(el => {
          const a = el.querySelector("a.book-layout, a.book-title-x");
          if (!a) return null;
          const href = a.getAttribute("href") || "";
          const id = href.split('/novel/')[1]?.split('.')[0];
          if (!id) return null;
          const title = (el.querySelector(".book-title, h2.book-title")?.innerText || "").trim();
          const author = (el.querySelector(".book-author, .book-author-x")?.innerText || "").replace(/^作者[:：\\s]+/, "").trim();
          const img = el.querySelector("img");
          const coverUrl = img ? (img.getAttribute("data-src") || img.getAttribute("src") || "") : "";
          const desc = (el.querySelector(".book-intro, .book-intro-x")?.innerText || "").trim();
          return { id, title, author, coverUrl, desc, catalogUrl: `https://tw.linovelib.com/novel/${id}/catalog` };
        }).filter(Boolean);
      });
      
      return reply.send({ results });
    } finally {
      await page.close().catch(() => {});
    }
  } catch(e) {
    return reply.code(502).send({ error: "search failed", detail: e.message });
  } finally {
    release();
  }
});

// --- Auth & Sync Endpoints ---

app.post("/auth/register", async (req, reply) => {
  const { username, password, inviteCode } = req.body || {};
  if (!username || !password) return reply.code(400).send({ error: "Username and password required" });
  if (REGISTER_SECRET && inviteCode !== REGISTER_SECRET) return reply.code(403).send({ error: "Invalid invite code" });

  const hashed = hashPassword(password);
  try {
    const stmt = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)");
    const info = stmt.run(username, hashed);
    const token = jwt.sign({ userId: info.lastInsertRowid, username }, JWT_SECRET, { expiresIn: "30d" });
    return reply.send({ token, username });
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return reply.code(409).send({ error: "Username already exists" });
    return reply.code(500).send({ error: e.message });
  }
});

app.post("/auth/login", async (req, reply) => {
  const { username, password } = req.body || {};
  if (!username || !password) return reply.code(400).send({ error: "Username and password required" });

  const stmt = db.prepare("SELECT id, password_hash FROM users WHERE username = ?");
  const user = stmt.get(username);

  if (!user || !verifyPassword(password, user.password_hash)) {
    return reply.code(401).send({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ userId: user.id, username }, JWT_SECRET, { expiresIn: "30d" });
  return reply.send({ token, username });
});

// Helper for verifying JWT in sync routes
function getUserId(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.userId;
  } catch {
    return null;
  }
}

app.get("/sync/pull", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });

  const stmt = db.prepare("SELECT history_json, bookmarks_json, bookshelf_json, settings_json FROM sync_data WHERE user_id = ?");
  const data = stmt.get(userId);

  if (!data) return reply.send({ history: [], bookmarks: [], bookshelf: [], settings: {} });

  return reply.send({
    history: JSON.parse(data.history_json || "[]"),
    bookmarks: JSON.parse(data.bookmarks_json || "[]"),
    bookshelf: JSON.parse(data.bookshelf_json || "[]"),
    settings: JSON.parse(data.settings_json || "{}"),
  });
});

app.post("/sync/push", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });

  const { history, bookmarks, bookshelf, settings } = req.body || {};

  const stmt = db.prepare(`
    INSERT INTO sync_data (user_id, history_json, bookmarks_json, bookshelf_json, settings_json, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      history_json = excluded.history_json,
      bookmarks_json = excluded.bookmarks_json,
      bookshelf_json = excluded.bookshelf_json,
      settings_json = excluded.settings_json,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(
    userId,
    JSON.stringify(history || []),
    JSON.stringify(bookmarks || []),
    JSON.stringify(bookshelf || []),
    JSON.stringify(settings || {})
  );

  return reply.send({ success: true });
});

// Graceful shutdown
async function shutdown() {
  app.log.info("shutting down");
  try {
    await app.close();
  } catch {}
  try {
    if (context) await context.close();
    if (browser) await browser.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`linovelib-reader-backend listening on :${PORT} (headless=${HEADLESS}, concurrency=${CONCURRENCY})`);
});
