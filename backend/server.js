import 'dotenv/config';
// Mac-side Playwright backend for linovelib-reader.
// Renders pages in a real Chromium with stealth, returns fully decoded HTML.
//
// Env:
//   PORT          (default 3001)
//   AUTH_TOKEN    (required) ??shared secret for Authorization: Bearer <token>
//   HEADLESS      (default "true") ??set "false" to debug visually
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
import * as cheerio from "cheerio";

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
  "tw.linovelib.com",
  "www.linovelib.com",
  "w.linovelib.com",
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
            if (txt.includes("内容获取失败") || txt.includes("内容加载失败") || txt.includes("內容獲取失敗") || txt.includes("內容加載失敗") || txt.includes("內容載入失敗")) continue;
            // Resolve lazy-load data-src ??src for images
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
          } else if (tag === "div" || tag === "figure" || tag === "fig") {
            // Preserve wrappers that contain images
            if (child.querySelector("img") !== null) {
              child.querySelectorAll("img[data-src]").forEach((img) => {
                const ds = img.getAttribute("data-src");
                if (ds) img.setAttribute("src", ds.startsWith("//") ? "https:" + ds : ds);
              });
              kept.push(child.outerHTML);
            }
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
  
  CREATE TABLE IF NOT EXISTS DiscoverCache (
    key TEXT PRIMARY KEY,
    data JSON NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS Catalogs (
    catalogUrl TEXT PRIMARY KEY,
    data JSON NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS Chapters (
    chapterUrl TEXT PRIMARY KEY,
    catalogUrl TEXT NOT NULL,
    data JSON NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS Images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    catalogUrl TEXT NOT NULL,
    chapterUrl TEXT NOT NULL,
    chapterTitle TEXT NOT NULL,
    src TEXT NOT NULL,
    alt TEXT,
    createdAt INTEGER NOT NULL,
    UNIQUE(catalogUrl, chapterUrl, src)
  );
  CREATE INDEX IF NOT EXISTS idx_images_catalog ON Images(catalogUrl);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    words_read INTEGER DEFAULT 0,
    exp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1
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
  CREATE TABLE IF NOT EXISTS chapter_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_url TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS novel_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    catalog_url TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS comment_votes (
    user_id INTEGER NOT NULL,
    comment_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY(user_id, comment_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(comment_id) REFERENCES chapter_comments(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS review_votes (
    user_id INTEGER NOT NULL,
    review_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY(user_id, review_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(review_id) REFERENCES novel_reviews(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS followers (
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    PRIMARY KEY(follower_id, following_id),
    FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

try { db.exec("ALTER TABLE sync_data ADD COLUMN settings_json TEXT DEFAULT '{}'"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE Chapters ADD COLUMN word_count INTEGER DEFAULT 0"); } catch (e) {}
try { db.prepare("ALTER TABLE users ADD COLUMN words_read INTEGER DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE users ADD COLUMN exp INTEGER DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE users ADD COLUMN level INTEGER DEFAULT 1").run(); } catch {}

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


// --- Content DB Helpers ---
function getDiscoverCache(key) {
  const stmt = db.prepare('SELECT * FROM DiscoverCache WHERE key = ?');
  const row = stmt.get(key);
  if (!row) return null;
  if (Date.now() - row.updatedAt > 24 * 60 * 60 * 1000) return null;
  const data = JSON.parse(row.data);
  // Normalize any legacy .html item URLs to /catalog on read
  if (data && Array.isArray(data.items)) {
    data.items = data.items.map(item =>
      item.url ? { ...item, url: normalizeToNovelCatalog(item.url) } : item
    );
  }
  return data;
}
function setDiscoverCache(key, data) {
  const stmt = db.prepare('INSERT OR REPLACE INTO DiscoverCache (key, data, updatedAt) VALUES (?, ?, ?)');
  stmt.run(key, JSON.stringify(data), Date.now());
}
function getCatalogDb(catalogUrl) {
  const stmt = db.prepare('SELECT * FROM Catalogs WHERE catalogUrl = ?');
  const row = stmt.get(catalogUrl);
  if (!row) return null;
  if (Date.now() - row.updatedAt > 24 * 60 * 60 * 1000) return null;
  return JSON.parse(row.data);
}
function setCatalogDb(catalogUrl, data) {
  const stmt = db.prepare('INSERT OR REPLACE INTO Catalogs (catalogUrl, data, updatedAt) VALUES (?, ?, ?)');
  stmt.run(catalogUrl, JSON.stringify(data), Date.now());
}
function addChapterDb(url, data) {
  const stmt = db.prepare('INSERT OR REPLACE INTO Chapters (chapterUrl, catalogUrl, data, updatedAt) VALUES (?, ?, ?, ?)');
  stmt.run(url, data.catalogUrl || "", JSON.stringify(data), Date.now());
}
function getChapterDb(chapterUrl) {
  const row = db.prepare('SELECT * FROM Chapters WHERE chapterUrl = ?').get(chapterUrl);
  if (!row) return null;
  // if (Date.now() - row.updatedAt > 24 * 60 * 60 * 1000) return null; // Uncomment if we want cache expiry
  return JSON.parse(row.data);
}
function addImageDb(catalogUrl, chapterUrl, chapterTitle, src, alt) {
  const stmt = db.prepare('INSERT OR IGNORE INTO Images (catalogUrl, chapterUrl, chapterTitle, src, alt, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run(catalogUrl, chapterUrl, chapterTitle, src, alt || "", Date.now());
}
function getImagesDb(catalogUrl) {
  const stmt = db.prepare('SELECT * FROM Images WHERE catalogUrl = ? ORDER BY id ASC');
  return stmt.all(catalogUrl);
}

const BILI_ORIGIN = "https://www.bilinovel.com";
const TW_ORIGIN = "https://tw.linovelib.com";

function toTwLinovelib(url) {
  return url.replace(BILI_ORIGIN, TW_ORIGIN).replace("http://www.bilinovel.com", TW_ORIGIN);
}

/**
 * Normalizes any linovelib novel URL to the canonical catalog URL form:
 *   /novel/123.html       → https://tw.linovelib.com/novel/123/catalog
 *   /novel/123            → https://tw.linovelib.com/novel/123/catalog
 *   /novel/123/catalog    → unchanged
 * Non-novel URLs are returned as-is.
 */
function normalizeToNovelCatalog(url) {
  // Match /novel/{id}.html or /novel/{id} (end of path, no further segments)
  return url
    .replace(/(\/novel\/(\d+))\.html$/, '$1/catalog')
    .replace(/(\/novel\/\d+)$/, '$1/catalog');
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
      await page.goto(`https://tw.linovelib.com/search.html?searchkey=${encodeURIComponent(q)}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      
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


app.get("/api/discover/wenku", async (req, reply) => {
  const page = parseInt(req.query.page || "1", 10);
  const force = req.query.refresh === "1";
  const cacheKey = `wenku_page_${page}`;
  
  if (!force) {
    const cached = getDiscoverCache(cacheKey);
    if (cached) return reply.send({ ...cached, cached: true });
  }

  const fetchUrl = `${TW_ORIGIN}/wenku/lastupdate_0_0_0_0_0_0_0_${page}_0.html`;
  const release = await acquire();
  try {
    const html = await renderPage(fetchUrl);
    const $ = cheerio.load(html);
    const items = [];

    $(".book-ol .book-li").each((_, el) => {
      const a = $(el).find("a.book-layout");
      if (!a.length) return;
      const urlPath = a.attr("href") || "";
      const url = normalizeToNovelCatalog(urlPath.startsWith("http") ? toTwLinovelib(urlPath) : TW_ORIGIN + urlPath);
      
      const img = $(el).find("img");
      let coverUrl = img.attr("data-original") || img.attr("data-src") || img.attr("src") || "";
      if (coverUrl && !coverUrl.startsWith("http")) coverUrl = BILI_ORIGIN + coverUrl;
      coverUrl = toTwLinovelib(coverUrl);

      const title = $(el).find("h4.book-title, .book-title").text().trim();
      const author = $(el).find(".book-author, .book-meta span").first().text().trim().replace(/^作者\s*/, '');
      const desc = $(el).find(".book-desc, .book-intro").text().trim();
      
      const tags = [];
      $(el).find(".tag-small").each((_, em) => {
        const text = $(em).text().trim();
        if (text) tags.push(...text.split(/\s+/).filter(Boolean));
      });

      if (title && url) items.push({ title, url, coverUrl, author, desc, tags });
    });

    let totalPages = 1;
    const lastPageLink = $(".pagelink a.last").attr("href");
    if (lastPageLink) {
      const match = /_(\d+)_0\.html/.exec(lastPageLink);
      if (match) totalPages = parseInt(match[1], 10);
    } else {
      $(".pagelink a").each((_, el) => {
        const text = $(el).text().trim();
        const p = parseInt(text, 10);
        if (!isNaN(p) && p > totalPages) totalPages = p;
      });
    }

    const result = { items, totalPages };
    setDiscoverCache(cacheKey, result);
    return reply.send({ ...result, cached: false });
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({ error: String(e) });
  } finally {
    release();
  }
});

app.get("/api/discover/top", async (req, reply) => {
  const page = parseInt(req.query.page || "1", 10);
  const force = req.query.refresh === "1";
  const cacheKey = `top_monthvisit_${page}`;
  
  if (!force) {
    const cached = getDiscoverCache(cacheKey);
    if (cached) return reply.send({ ...cached, cached: true });
  }

  const fetchUrl = `${TW_ORIGIN}/top/monthvisit/${page}.html`;
  const release = await acquire();
  try {
    const html = await renderPage(fetchUrl);
    const $ = cheerio.load(html);
    const items = [];

    $(".book-li").each((_, el) => {
      const a = $(el).find("a.book-layout");
      if (!a.length) return;
      const urlPath = a.attr("href") || "";
      const url = normalizeToNovelCatalog(urlPath.startsWith("http") ? toTwLinovelib(urlPath) : TW_ORIGIN + urlPath);
      
      const img = $(el).find("img");
      let coverUrl = img.attr("data-original") || img.attr("data-src") || img.attr("src") || "";
      if (coverUrl && !coverUrl.startsWith("http")) coverUrl = BILI_ORIGIN + coverUrl;
      coverUrl = toTwLinovelib(coverUrl);

      const title = $(el).find("h4.book-title, .book-title").text().trim();
      const author = $(el).find(".book-author, .book-meta span").first().text().trim().replace(/^作者\s*/, '');
      const desc = $(el).find(".book-desc, .book-intro").text().trim();
      
      const tags = [];
      $(el).find(".tag-small, .book-cell span, .book-meta span").each((_, em) => {
        const text = $(em).text().trim();
        if (text && text !== author && isNaN(parseInt(text, 10)) && text.length > 1) {
          tags.push(...text.split(/\s+/).filter(Boolean));
        }
      });

      if (title && url) items.push({ title, url, coverUrl, author, desc, tags });
    });

    let totalPages = 1;
    const lastPageLink = $(".pagelink a.last").attr("href");
    if (lastPageLink) {
      const match = /\/(\d+)\.html/.exec(lastPageLink);
      if (match) totalPages = parseInt(match[1], 10);
    } else {
      $(".pagelink a").each((_, el) => {
        const text = $(el).text().trim();
        const p = parseInt(text, 10);
        if (!isNaN(p) && p > totalPages) totalPages = p;
      });
    }

    const result = { items, totalPages };
    setDiscoverCache(cacheKey, result);
    return reply.send({ ...result, cached: false });
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({ error: String(e) });
  } finally {
    release();
  }
});

app.get("/api/discover/search", async (req, reply) => {
  const query = req.query.q;
  const type = req.query.type || "normal";
  const page = parseInt(req.query.page || "1", 10);
  const pageSize = 50;

  if (!query) {
    return reply.send({ items: [], totalPages: 1, totalCount: 0 });
  }

  const q = query.toLowerCase();
  
  try {
    const rows = db.prepare(`SELECT data FROM DiscoverCache`).all();
    const uniqueItems = new Map();
    
    for (const row of rows) {
      if (!row.data) continue;
      try {
        const parsed = JSON.parse(row.data);
        const items = Array.isArray(parsed) ? parsed : parsed.items;
        if (Array.isArray(items)) {
          for (const item of items) {
            // Normalize legacy .html URLs when reading from cache
            const normalizedItem = item.url
              ? { ...item, url: normalizeToNovelCatalog(item.url) }
              : item;
            if (!uniqueItems.has(normalizedItem.url)) uniqueItems.set(normalizedItem.url, normalizedItem);
          }
        }
      } catch (e) {}
    }
    
    const allItems = Array.from(uniqueItems.values());
    
    const scored = allItems.map(item => {
      const titleMatch = item.title && item.title.toLowerCase().includes(q) ? 1 : 0;
      const authorMatch = item.author && item.author.toLowerCase().includes(q) ? 1 : 0;
      const tagMatch = item.tags && item.tags.some(t => t.toLowerCase().includes(q)) ? 1 : 0;
      
      let score = 0;
      if (titleMatch || authorMatch || tagMatch) {
        if (type === "tag") score = tagMatch * 3 + authorMatch * 2 + titleMatch * 1;
        else score = titleMatch * 3 + authorMatch * 2 + tagMatch * 1;
      }
      return { item, score };
    }).filter(x => x.score > 0);
    
    scored.sort((a, b) => b.score - a.score);
    const filtered = scored.map(x => x.item);
    const totalPages = Math.ceil(filtered.length / pageSize) || 1;
    const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);
    
    return reply.send({ items: paginated, totalPages, totalCount: filtered.length });
  } catch (error) {
    req.log.error(error);
    return reply.code(500).send({ error: "Failed to search" });
  }
});


app.get("/api/catalog", async (req, reply) => {
  const url = req.query.url;
  const force = req.query.refresh === "1";
  if (!url) return reply.code(400).send({ error: "Missing url" });

  const twUrl = toTwLinovelib(url);
  const fetchUrl = twUrl;

  try {
    if (!force) {
      const cached = getCatalogDb(twUrl);
      if (cached && cached.title !== "未知小說") return reply.send({ ...cached, cached: true });
    }

    const release = await acquire();
    let html;
    try {
      html = await renderPage(fetchUrl);
    } finally {
      release();
    }
    
    const $ = cheerio.load(html);

    const title = $("h1.book-title, h1, h2.book-title, h2.title, .book-title").first().text().trim() || "未知小說";
    const coverEl = $(".book-img img, .cover img, .novel-cover img").first();
    let coverUrl = coverEl.attr("data-src") || coverEl.attr("src") || "";
    if (coverUrl && !coverUrl.startsWith("http")) coverUrl = BILI_ORIGIN + coverUrl;
    if (coverUrl) coverUrl = toTwLinovelib(coverUrl);

    // Extract extra metadata
    const author = $('meta[property="og:novel:author"]').attr("content") || $(".book-author").text().trim() || "";
    const desc = $('meta[property="og:description"]').attr("content") || $(".book-dec, .book-intro").text().trim() || "";
    const tagsStr = $('meta[property="og:novel:category"]').attr("content") || "";
    const tags = tagsStr ? tagsStr.split(" ").filter(Boolean) : [];

    const volumes = [];
    const state = { vol: null };

    $(".volume-chapters > li").each((_, li) => {
      const el = $(li);
      if (el.hasClass("chapter-bar")) {
        if (state.vol) volumes.push(state.vol);
        state.vol = { volTitle: el.text().trim(), coverUrl: "", chapters: [] };
        return;
      }
      if (el.hasClass("volume-cover")) {
        const img = el.find("img");
        let src = img.attr("data-src") || img.attr("src") || "";
        if (src && !src.startsWith("http")) src = BILI_ORIGIN + src;
        if (src) src = toTwLinovelib(src);
        if (state.vol) state.vol.coverUrl = src;
        return;
      }
      if (el.hasClass("jsChapter")) {
        const a = el.find("a");
        const chTitle = a.text().trim() || el.text().trim();
        if (!chTitle) return;
        const href = a.attr("href") || "";
        const onclick = a.attr("onclick") || el.attr("onclick") || "";
        const dataHref = a.attr("data-href") || a.attr("data-url") || el.attr("data-href") || el.attr("data-url") || "";
        const cidSource = [href, onclick, dataHref].find(Boolean) || "";
        
        const novelIdMatch = fetchUrl.match(/\/novel\/(\d+)/);
        const novelId = novelIdMatch ? novelIdMatch[1] : "";

        let fullUrl = null;
        if (href.startsWith("http")) {
          fullUrl = toTwLinovelib(href);
        } else if (href.startsWith("/") || href.startsWith("novel")) {
          fullUrl = TW_ORIGIN + (href.startsWith("/") ? href : "/" + href);
        } else if (dataHref.startsWith("http")) {
          fullUrl = toTwLinovelib(dataHref);
        } else if (dataHref.startsWith("/") || dataHref.startsWith("novel")) {
          fullUrl = TW_ORIGIN + (dataHref.startsWith("/") ? dataHref : "/" + dataHref);
        } else {
          const cidMatch = cidSource.match(/cid\(\s*\d+\s*,\s*(\d+)\s*\)/);
          if (cidMatch && novelId) {
            fullUrl = TW_ORIGIN + `/novel/${novelId}/${cidMatch[1]}.html`;
          }
        }

        if (!state.vol) state.vol = { volTitle: "", coverUrl: "", chapters: [] };
        state.vol.chapters.push({ title: chTitle, url: fullUrl });
      }
    });

    if (state.vol && (state.vol.chapters.length > 0 || state.vol.volTitle)) {
      volumes.push(state.vol);
    }

    // Since server.js runs Playwright, we can just resolve locked chapters here if needed, 
    // but the old Next.js code did it using cfFetchHtml. We will skip the complex backwards chaining here
    // or just leave null chapters. Actually, since renderPage is used, maybe linovelib doesn't hide them in Playwright?
    // If they do, the frontend can handle it or we can implement it later.
    
    const result = { title, coverUrl, author, desc, tags, volumes };
    setCatalogDb(twUrl, result);
    return reply.send({ ...result, cached: false });
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({ error: String(e) });
  }
});

app.get("/api/chapter", async (req, reply) => {
  const url = req.query.url;
  const catalogUrl = req.query.catalogUrl;
  const force = req.query.refresh === "1";
  
  if (!url || !catalogUrl) return reply.code(400).send({ error: "Missing url or catalogUrl" });

  const fetchUrl = toTwLinovelib(url);
  try {
    if (!force) {
      const cached = getChapterDb(fetchUrl);
      if (cached && cached.content !== undefined) {
        return reply.send({ ...cached, cached: true });
      }
    }

    const release = await acquire();
    let html;
    try {
      html = await renderPage(fetchUrl);
    } finally {
      release();
    }
    
    const $ = cheerio.load(html);
    const title = $("#atitle").text().trim() || $("h1.title").text().trim() || "未知章節";
    
    let contentStr = "";
    const contentEl = $("#acontent, #acontent1, .acontent");
    const targetEl = contentEl.length ? contentEl : $("#readcontent, .readcontent");
    
    const imgItems = [];
    if (targetEl.length) {
      targetEl.children().each((_, el) => {
        const tag = (el.name || "").toLowerCase();
        
        if (tag === "img") {
          let src = $(el).attr("data-src") || $(el).attr("src") || "";
          if (src && !src.startsWith("http")) src = "https:" + src;
          if (src && !src.startsWith("data:")) {
            const alt = $(el).attr("alt") || "";
            addImageDb(catalogUrl, fetchUrl, title, src, alt);
            imgItems.push({ src, alt });
            contentStr += `[IMG:${src}]\n\n`;
          }
          return;
        }
        
        if (tag === "p" || tag === "figure" || tag === "div" || tag === "center") {
          const imgEl = $(el).find("img");
          if (imgEl.length) {
            imgEl.each((_, img) => {
              let src = $(img).attr("data-src") || $(img).attr("src") || "";
              if (src && !src.startsWith("http")) src = "https:" + src;
              if (src && !src.startsWith("data:")) {
                const alt = $(img).attr("alt") || "";
                addImageDb(catalogUrl, fetchUrl, title, src, alt);
                imgItems.push({ src, alt });
                contentStr += `[IMG:${src}]\n\n`;
              }
            });
            if (tag === "figure" || tag === "center") return;
            // div might just be an image wrapper
            if (tag === "div" && $(el).find("p").length > 0) return;
          }
          
          const text = $(el).text().trim();
          if (text) contentStr += text + "\n\n";
        }
      });
    }

    const baseUrl = new URL(fetchUrl);
    const urlNavMatch = /url_previous:'(.*?)',url_next:'(.*?)'/.exec(html);
    const rawPrevUrl = urlNavMatch?.[1] ?? null;
    const rawNextUrl = urlNavMatch?.[2] ?? null;

    const resolveUrl = (raw) => {
      if (!raw || raw === "null" || raw === "undefined") return null;
      if (raw.endsWith("/null") || raw.endsWith("/undefined")) return null;
      const full = raw.startsWith("http") ? raw : baseUrl.origin + raw;
      return toTwLinovelib(full);
    };

    const prevLinkText = $("#footlink a:first-child").text().trim();
    const nextLinkText = $("#footlink a:last-child").text().trim();
    const isPrevPage = prevLinkText === "上一页" || prevLinkText === "上一頁";
    const isNextPage = nextLinkText === "下一页" || nextLinkText === "下一頁";

    const result = {
      title,
      content: contentStr.trim(),
      images: imgItems,
      nextPageUrl: isNextPage ? resolveUrl(rawNextUrl) : null,
      nextChapterUrl: isNextPage ? null : resolveUrl(rawNextUrl),
      prevChapterUrl: isPrevPage ? null : resolveUrl(rawPrevUrl),
    };
    
    addChapterDb(fetchUrl, result);
    return reply.send({ ...result, cached: false });
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({ error: String(e) });
  }
});

app.get("/api/gallery", async (req, reply) => {
  const catalogUrl = req.query.catalogUrl;
  if (!catalogUrl) return reply.code(400).send({ error: "Missing catalogUrl" });
  try {
    const images = getImagesDb(catalogUrl);
    return reply.send({ images });
  } catch (e) {
    return reply.code(500).send({ error: String(e) });
  }
});

// --- Auth & Sync Endpoints ---

app.post("/auth/register", async (req, reply) => {
  const { username, password, answer1, answer2 } = req.body || {};
  if (!username || !password) return reply.code(400).send({ error: "Username and password required" });
  if (String(answer1 || "").toLowerCase().trim() !== "nerd") return reply.code(403).send({ error: "第一題驗證失敗：安全碼錯誤" });
  if (String(answer2 || "").trim() !== "0226") return reply.code(403).send({ error: "第二題驗證失敗：開發者生日錯誤" });

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

  const stmt = db.prepare("SELECT id, password_hash FROM users WHERE username = ? COLLATE NOCASE");
  const user = stmt.get(username);

  if (!user) {
    return reply.code(401).send({ error: "查無此帳號，請先註冊或檢查帳號是否正確" });
  }
  
  if (!verifyPassword(password, user.password_hash)) {
    return reply.code(401).send({ error: "密碼錯誤，請重新輸入" });
  }

  const token = jwt.sign({ userId: user.id, username }, JWT_SECRET, { expiresIn: "30d" });
  return reply.send({ token, username, avatarUrl: user.avatar_url });
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

function updateUserLevel(userId) {
  const user = db.prepare("SELECT words_read FROM users WHERE id = ?").get(userId);
  if (!user) return null;
  
  const syncData = db.prepare("SELECT history_json FROM sync_data WHERE user_id = ?").get(userId);
  let chaptersRead = 0;
  let novelsRead = 0;
  if (syncData && syncData.history_json) {
    try {
      const history = JSON.parse(syncData.history_json);
      novelsRead = history.length;
      for (const entry of history) {
        if (entry.visitedChapters) {
          chaptersRead += Object.keys(entry.visitedChapters).length;
        }
      }
    } catch {}
  }
  
  const commentsCount = db.prepare("SELECT COUNT(*) as c FROM chapter_comments WHERE user_id = ?").get(userId).c;
  const reviewsCount = db.prepare("SELECT COUNT(*) as c FROM novel_reviews WHERE user_id = ?").get(userId).c;
  
  const totalExp = Math.floor(user.words_read / 1000 * 10) + (chaptersRead * 5) + ((commentsCount + reviewsCount) * 5);
  
  let level = 1;
  let required = 100;
  let tempExp = totalExp;
  
  while (tempExp >= required) {
    tempExp -= required;
    level++;
    required = Math.floor(required * 1.3);
  }
  
  db.prepare("UPDATE users SET exp = ?, level = ? WHERE id = ?").run(totalExp, level, userId);
  return { exp: totalExp, currentLevelExp: tempExp, expToNext: required, level, chaptersRead, novelsRead, words_read: user.words_read };
}

app.get("/auth/me", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  
  const user = db.prepare("SELECT username, avatar_url, created_at FROM users WHERE id = ?").get(userId);
  if (!user) return reply.code(404).send({ error: "User not found" });
  
  const stats = updateUserLevel(userId);
  return reply.send({ username: user.username, avatarUrl: user.avatar_url, createdAt: user.created_at, ...stats });
});

app.post("/sync/words", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  
  const { chapter_url } = req.body || {};
  if (!chapter_url) return reply.send({ success: false });
  
  const fetchUrl = toTwLinovelib(chapter_url);
  
  const chapter = db.prepare("SELECT word_count FROM Chapters WHERE url = ?").get(fetchUrl);
  if (!chapter || !chapter.word_count) return reply.send({ success: false, reason: "No chapter cache found" });
  
  // Cap to 20000 just in case
  const toAdd = Math.min(chapter.word_count, 20000);
  if (toAdd > 0) {
    db.prepare("UPDATE users SET words_read = words_read + ? WHERE id = ?").run(toAdd, userId);
    updateUserLevel(userId);
  }
  
  return reply.send({ success: true, added: toAdd });
});

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

  const existingData = db.prepare("SELECT history_json FROM sync_data WHERE user_id = ?").get(userId);
  let mergedHistory = history || [];
  
  if (existingData && existingData.history_json) {
    try {
      const cloudHistory = JSON.parse(existingData.history_json);
      const mergedMap = new Map();
      for (const entry of cloudHistory) mergedMap.set(entry.catalogUrl, entry);
      for (const entry of (history || [])) {
        const existing = mergedMap.get(entry.catalogUrl);
        if (!existing || entry.updatedAt > existing.updatedAt) {
          mergedMap.set(entry.catalogUrl, entry);
        } else if (existing && entry.updatedAt === existing.updatedAt) {
          existing.visitedChapters = { ...existing.visitedChapters, ...entry.visitedChapters };
        }
      }
      mergedHistory = Array.from(mergedMap.values());
    } catch (e) {}
  }

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
    JSON.stringify(mergedHistory),
    JSON.stringify(bookmarks || []),
    JSON.stringify(bookshelf || []),
    JSON.stringify(settings || {})
  );

  updateUserLevel(userId);

  return reply.send({ success: true, mergedHistory });
});

app.post("/auth/avatar", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });

  const { avatarBase64 } = req.body || {};
  if (!avatarBase64) return reply.code(400).send({ error: "No avatar provided" });

  try {
    const base64Data = avatarBase64.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    
    const avatarDir = path.join(dbDir, "avatars");
    if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
    
    const filename = `avatar_${userId}.webp`;
    const filePath = path.join(avatarDir, filename);
    fs.writeFileSync(filePath, buffer);
    
    const avatarUrl = `/api/avatar/${filename}?t=${Date.now()}`;
    db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl, userId);
    
    return reply.send({ success: true, avatarUrl });
  } catch (e) {
    return reply.code(500).send({ error: "Failed to save avatar" });
  }
});

app.get("/avatar/:filename", async (req, reply) => {
  const { filename } = req.params;
  const filePath = path.join(dbDir, "avatars", filename);
  if (!fs.existsSync(filePath)) return reply.code(404).send("Not found");
  const buffer = fs.readFileSync(filePath);
  reply.type("image/webp").send(buffer);
});

// --- Social API ---
app.get("/comments", async (req, reply) => {
  const { chapter_url } = req.query;
  const userId = getUserId(req); // Optional for GET
  
  if (!chapter_url) return reply.code(400).send({ error: "Missing chapter_url" });
  
  const stmt = db.prepare(`
    SELECT c.id, c.content, c.created_at, u.username, u.avatar_url, u.level,
           COALESCE(SUM(v.value), 0) AS score,
           IFNULL((SELECT value FROM comment_votes WHERE user_id = ? AND comment_id = c.id), 0) AS user_vote
    FROM chapter_comments c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN comment_votes v ON c.id = v.comment_id
    WHERE c.chapter_url = ?
    GROUP BY c.id
    ORDER BY score DESC, c.created_at ASC
  `);
  return reply.send(stmt.all(userId || 0, chapter_url));
});

app.post("/comments", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  const { chapter_url, content } = req.body || {};
  if (!chapter_url || !content) return reply.code(400).send({ error: "Missing fields" });
  
  db.prepare("INSERT INTO chapter_comments (chapter_url, user_id, content) VALUES (?, ?, ?)").run(chapter_url, userId, content);
  updateUserLevel(userId);
  return reply.send({ success: true });
});

app.post("/comments/vote", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  const { comment_id, value } = req.body || {};
  if (typeof comment_id !== 'number' || typeof value !== 'number') return reply.code(400).send({ error: "Invalid payload" });
  
  if (value === 0) {
    db.prepare("DELETE FROM comment_votes WHERE user_id = ? AND comment_id = ?").run(userId, comment_id);
  } else {
    const v = value > 0 ? 1 : -1;
    db.prepare("INSERT INTO comment_votes (user_id, comment_id, value) VALUES (?, ?, ?) ON CONFLICT(user_id, comment_id) DO UPDATE SET value=excluded.value").run(userId, comment_id, v);
  }
  return reply.send({ success: true });
});

app.get("/reviews", async (req, reply) => {
  const { catalog_url } = req.query;
  const userId = getUserId(req);
  
  if (!catalog_url) return reply.code(400).send({ error: "Missing catalog_url" });
  const stmt = db.prepare(`
    SELECT r.id, r.content, r.rating, r.created_at, u.username, u.avatar_url, u.level,
           COALESCE(SUM(v.value), 0) AS score,
           IFNULL((SELECT value FROM review_votes WHERE user_id = ? AND review_id = r.id), 0) AS user_vote
    FROM novel_reviews r
    JOIN users u ON r.user_id = u.id
    LEFT JOIN review_votes v ON r.id = v.review_id
    WHERE r.catalog_url = ?
    GROUP BY r.id
    ORDER BY score DESC, r.created_at DESC
  `);
  return reply.send(stmt.all(userId || 0, catalog_url));
});

app.post("/reviews", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  const { catalog_url, content, rating } = req.body || {};
  if (!catalog_url || !content) return reply.code(400).send({ error: "Missing fields" });
  
  db.prepare("INSERT INTO novel_reviews (catalog_url, user_id, content, rating) VALUES (?, ?, ?, ?)").run(catalog_url, userId, content, rating || 5);
  updateUserLevel(userId);
  return reply.send({ success: true });
});

app.post("/reviews/vote", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  const { review_id, value } = req.body || {};
  if (typeof review_id !== 'number' || typeof value !== 'number') return reply.code(400).send({ error: "Invalid payload" });
  
  if (value === 0) {
    db.prepare("DELETE FROM review_votes WHERE user_id = ? AND review_id = ?").run(userId, review_id);
  } else {
    const v = value > 0 ? 1 : -1;
    db.prepare("INSERT INTO review_votes (user_id, review_id, value) VALUES (?, ?, ?) ON CONFLICT(user_id, review_id) DO UPDATE SET value=excluded.value").run(userId, review_id, v);
  }
  return reply.send({ success: true });
});

app.get("/community/recent", async (req, reply) => {
  const userId = getUserId(req);

  // Try to parse the latest history_json from sync_data to find out what users are reading
  const stmt = db.prepare(`
    SELECT s.updated_at, s.history_json, u.id as user_id, u.username, u.avatar_url, u.level
    FROM sync_data s
    JOIN users u ON s.user_id = u.id
    ORDER BY s.updated_at DESC LIMIT 30
  `);
  const rows = stmt.all();
  const recent = [];
  
  for (const row of rows) {
    try {
      const history = JSON.parse(row.history_json || "[]");
      if (history.length > 0) {
        // Find most recently read novel
        history.sort((a, b) => b.updatedAt - a.updatedAt);
        const lastRead = history[0];
        
        let author = "";
        let desc = "";
        let volTitle = "";
        const catalogData = getCatalogDb(lastRead.catalogUrl);
        if (catalogData) {
          author = catalogData.author || "";
          desc = catalogData.desc || "";
          const groups = catalogData.volumes || catalogData.groups;
          if (groups) {
            for (const g of groups) {
              if (g.chapters && g.chapters.some((c) => c.url === lastRead.lastChapterUrl)) {
                volTitle = g.volTitle || "";
                break;
              }
            }
          }
        }
        
        let isFollowing = false;
        if (userId) {
          const followCheck = db.prepare("SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ?").get(userId, row.user_id);
          if (followCheck) isFollowing = true;
        }

        recent.push({
          userId: row.user_id,
          username: row.username,
          avatarUrl: row.avatar_url,
          level: row.level,
          isFollowing,
          novelTitle: lastRead.novelTitle,
          catalogUrl: lastRead.catalogUrl,
          coverUrl: lastRead.coverUrl,
          lastChapterUrl: lastRead.lastChapterUrl,
          lastChapterTitle: lastRead.lastChapterTitle,
          volTitle,
          author,
          desc,
          updatedAt: row.updated_at
        });
      }
    } catch (e) {
      // ignore parse error
    }
  }
  
  return reply.send(recent);
});

app.post("/community/follow", async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  
  const { target_user_id } = req.body || {};
  if (!target_user_id) return reply.code(400).send({ error: "Missing target_user_id" });
  if (userId === target_user_id) return reply.code(400).send({ error: "Cannot follow yourself" });

  const existing = db.prepare("SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ?").get(userId, target_user_id);
  if (existing) {
    db.prepare("DELETE FROM followers WHERE follower_id = ? AND following_id = ?").run(userId, target_user_id);
    return reply.send({ success: true, isFollowing: false });
  } else {
    db.prepare("INSERT INTO followers (follower_id, following_id) VALUES (?, ?)").run(userId, target_user_id);
    return reply.send({ success: true, isFollowing: true });
  }
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
  
  // Start background auto-scraper
  startAutoScraper();
});

// --- Auto-Scraper Background Task ---
const SCRAPE_DELAY_MS = 4000; // 4s between requests
const FORCE_REFRESH_PAGES = 5;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchScrapePage(page, forceRefresh) {
  const url = `http://127.0.0.1:${PORT}/api/discover/wenku?page=${page}${forceRefresh ? '&refresh=1' : ''}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    console.log(`[AutoScraper] Page ${page} OK (cached: ${data.cached}). Items: ${data.items?.length || 0}`);
    return data;
  } catch (err) {
    console.error(`[AutoScraper] Error on page ${page}:`, err.message);
    return null;
  }
}

async function runAutoScrapeCycle() {
  console.log("[AutoScraper] Starting daily scrape cycle...");
  const firstPage = await fetchScrapePage(1, true);
  if (!firstPage || !firstPage.totalPages) {
    console.log("[AutoScraper] Failed to fetch page 1. Will retry next cycle.");
    return;
  }

  const totalPages = firstPage.totalPages;
  console.log(`[AutoScraper] Total pages to check: ${totalPages}`);

  for (let page = 2; page <= totalPages; page++) {
    await delay(SCRAPE_DELAY_MS);
    const forceRefresh = page <= FORCE_REFRESH_PAGES;
    let data = await fetchScrapePage(page, forceRefresh);
    
    if (!data) {
      // Simple retry once
      await delay(10000);
      await fetchScrapePage(page, forceRefresh);
    }
  }
  console.log("[AutoScraper] Cycle finished!");
}

function startAutoScraper() {
  // Wait 10 seconds after server starts before beginning the first scrape
  setTimeout(() => {
    runAutoScrapeCycle();
    // Run again every 24 hours
    setInterval(runAutoScrapeCycle, 24 * 60 * 60 * 1000);
  }, 10000);
}
