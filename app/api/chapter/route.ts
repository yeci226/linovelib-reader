import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { cfFetchHtmlEx } from "@/lib/cf-fetch";
import { getChapterDb, setChapterDb, addImageDb } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// 章節內容永久快取（linovelib 已發布章節不會變）
const CHAPTER_TTL_MS: number | null = null;

type ChapterPageResult = {
  title: string;
  content: string;
  /** URL of the next sub-page of THIS chapter (null if last sub-page). */
  nextPageUrl: string | null;
  /** URL of the next chapter (only present on last sub-page). */
  nextChapterUrl: string | null;
  /** URL of the previous chapter (only present on first sub-page). */
  prevChapterUrl: string | null;
};

function extractCatalogUrl(chapterUrl: string): string {
  const match = /\/novel\/(\d+)\//.exec(chapterUrl);
  if (match) {
    const origin = new URL(chapterUrl).origin;
    return `${origin}/novel/${match[1]}.html`;
  }
  return "";
}

// ─── ChapterLog (paragraph-shuffle) logic ───────────────────────────────────
// Ported from bili_novel_packer (Dart) by Montaro2017
// https://github.com/Montaro2017/bili_novel_packer

interface ChapterLogParams {
  fixedLength: number;
  seedMultiplier: number;
  seedOffset: number;
  a: number;
  c: number;
  mod: number;
}

const FALLBACK_PARAMS: ChapterLogParams = {
  fixedLength: 20,
  seedMultiplier: 135,
  seedOffset: 234,
  a: 9302,
  c: 49397,
  mod: 233280,
};

/** Simple integer expression evaluator: handles +,-,*,//,%,^,<<,>> and hex literals */
function evalIntExpr(expr: string): number | null {
  try {
    return new _ExprParser(expr.trim()).parse();
  } catch {
    return null;
  }
}

class _ExprParser {
  private src: string;
  private i = 0;
  constructor(src: string) { this.src = src; }

  parse(): number {
    const v = this.parseBitwiseXor();
    this.skipWs();
    if (this.i !== this.src.length) throw new Error("trailing");
    return v;
  }

  private parseBitwiseXor(): number {
    let v = this.parseShift();
    for (;;) { this.skipWs(); if (!this.eat("^")) return v; v ^= this.parseShift(); }
  }

  private parseShift(): number {
    let v = this.parseAddSub();
    for (;;) {
      this.skipWs();
      if (this.eat("<<")) { v = (v << this.parseAddSub()) | 0; continue; }
      if (this.eat(">>>") || this.eat(">>")) { v = (v >> this.parseAddSub()) | 0; continue; }
      return v;
    }
  }

  private parseAddSub(): number {
    let v = this.parseMulDiv();
    for (;;) {
      this.skipWs();
      if (this.eat("+")) { v += this.parseMulDiv(); continue; }
      if (this.eat("-")) { v -= this.parseMulDiv(); continue; }
      return v;
    }
  }

  private parseMulDiv(): number {
    let v = this.parseUnary();
    for (;;) {
      this.skipWs();
      if (this.eat("*")) { v = Math.imul(v, this.parseUnary()); continue; }
      if (this.eat("/")) { v = Math.trunc(v / this.parseUnary()); continue; }
      if (this.eat("%")) { v %= this.parseUnary(); continue; }
      return v;
    }
  }

  private parseUnary(): number {
    this.skipWs();
    if (this.eat("+")) return this.parseUnary();
    if (this.eat("-")) return -this.parseUnary();
    if (this.eat("~")) return ~this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWs();
    if (this.eat("(")) {
      const v = this.parseBitwiseXor();
      this.skipWs();
      if (!this.eat(")")) throw new Error("missing )");
      return v;
    }
    const start = this.i;
    while (this.i < this.src.length && /[0-9a-fA-FxX]/.test(this.src[this.i])) this.i++;
    if (this.i === start) throw new Error(`expected number at ${this.i}: ${this.src}`);
    const tok = this.src.slice(start, this.i);
    if (tok.startsWith("0x") || tok.startsWith("0X")) return parseInt(tok, 16);
    return parseInt(tok, 10);
  }

  private eat(s: string): boolean {
    if (this.src.startsWith(s, this.i)) { this.i += s.length; return true; }
    return false;
  }

  private skipWs() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }
}

function stripOuterParens(s: string): string {
  let v = s.trim();
  while (v.startsWith("(") && v.endsWith(")")) {
    let depth = 0, wraps = true;
    for (let i = 0; i < v.length; i++) {
      if (v[i] === "(") depth++;
      else if (v[i] === ")") { depth--; if (depth === 0 && i !== v.length - 1) { wraps = false; break; } }
    }
    if (!wraps) return v;
    v = v.slice(1, -1).trim();
  }
  return v;
}

function splitTopLevel(expr: string, op: string): string[] {
  const parts: string[] = [];
  let start = 0, depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") { depth++; continue; }
    if (expr[i] === ")") { depth--; continue; }
    if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

function evalWithVars(expr: string, vars: Record<string, number>): number | null {
  let s = expr;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`Number\\s*\\(\\s*${k}\\s*\\)`, "g"), String(v));
    s = s.replace(new RegExp(`\\b${k}\\b`, "g"), String(v));
  }
  return evalIntExpr(s);
}

function extractTrailingExpr(src: string, startRe: RegExp, terminator: string): string | null {
  const m = startRe.exec(src);
  if (!m) return null;
  let start = m.index + m[0].length, depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "(") { depth++; continue; }
    if (src[i] === ")") {
      if (depth === 0 && terminator === ")") return src.slice(start, i).trim();
      depth--;
      continue;
    }
    if (depth === 0 && src[i] === terminator) return src.slice(start, i).trim();
  }
  return null;
}

function tryParsePlain(js: string): ChapterLogParams | null {
  const fixedExpr = extractTrailingExpr(js, /if\s*\(\s*[_$a-zA-Z0-9]+\s*>\s*/, ")");
  const seedM = /=\s*(.+?Number\s*\(\s*chapterId\s*\).+?)\s*;/.exec(js);
  const lcgM = /=\s*(\(\s*[_$a-zA-Z0-9]+\s*\*.+?\)\s*%\s*.+?)\s*;/.exec(js);
  if (!fixedExpr || !seedM || !lcgM) return null;

  const fixedLength = evalIntExpr(stripOuterParens(fixedExpr));
  const seedExpr = seedM[1];
  const offset = evalWithVars(seedExpr, { chapterId: 0 });
  const one = evalWithVars(seedExpr, { chapterId: 1 });
  if (fixedLength == null || offset == null || one == null) return null;
  const multiplier = one - offset;

  const lcgExpr = lcgM[1];
  const parts = splitTopLevel(lcgExpr, "%");
  if (parts.length !== 2) return null;
  const mod = evalIntExpr(parts[1]);
  if (mod == null) return null;
  const left = stripOuterParens(parts[0]);
  const varName = /[_$a-zA-Z][_$a-zA-Z0-9]*/.exec(left)?.[0];
  if (!varName) return null;
  const c = evalWithVars(left, { [varName]: 0 });
  const oneV = evalWithVars(left, { [varName]: 1 });
  if (c == null || oneV == null) return null;

  return { fixedLength, seedMultiplier: multiplier, seedOffset: offset, a: oneV - c, c, mod };
}

/** Obfuscated chapterlog.js patterns (ported from bili_novel_packer Dart) */
const OBFUSCATED_SEED_RE =
  /var\s+[_$a-zA-Z0-9]+\s*=\s*[^;]*?Number\s*\(\s*[_$a-zA-Z0-9]+\s*\)\s*,\s*([^,)]+?)\s*\)\s*,\s*([^,)]+?)\s*\)\s*,/g;
const OBFUSCATED_LCG_RE =
  /([_$a-zA-Z0-9]+)\s*=\s*[^;]*?\(\s*\1\s*,\s*([^,)]+?)\s*\)\s*,\s*([^,)]+?)\s*\)\s*,\s*([^;)]+?)\s*\)\s*;/g;

function tryParseObfuscated(js: string): ChapterLogParams | null {
  // --- seed ---
  let seedMultiplier: number | null = null;
  let seedOffset: number | null = null;
  OBFUSCATED_SEED_RE.lastIndex = 0;
  for (let m = OBFUSCATED_SEED_RE.exec(js); m; m = OBFUSCATED_SEED_RE.exec(js)) {
    const mult = evalIntExpr(m[1].trim());
    const off = evalIntExpr(m[2].trim());
    if (mult == null || off == null) continue;
    if (mult <= 0 || off < 0) continue;
    seedMultiplier = mult;
    seedOffset = off;
    break;
  }
  if (seedMultiplier == null || seedOffset == null) return null;

  // --- lcg ---
  let lcgA: number | null = null, lcgC: number | null = null, lcgMod: number | null = null;
  OBFUSCATED_LCG_RE.lastIndex = 0;
  for (let m = OBFUSCATED_LCG_RE.exec(js); m; m = OBFUSCATED_LCG_RE.exec(js)) {
    const a = evalIntExpr(m[2].trim());
    const c = evalIntExpr(m[3].trim());
    const mod = evalIntExpr(m[4].trim());
    if (a == null || c == null || mod == null) continue;
    if (a <= 0 || c < 0 || mod <= a || mod <= c) continue;
    lcgA = a; lcgC = c; lcgMod = mod;
    break;
  }
  if (lcgA == null || lcgC == null || lcgMod == null) return null;

  return {
    fixedLength: FALLBACK_PARAMS.fixedLength,
    seedMultiplier,
    seedOffset,
    a: lcgA,
    c: lcgC,
    mod: lcgMod,
  };
}

function parseChapterLog(js: string): ChapterLogParams {
  return tryParsePlain(js) ?? tryParseObfuscated(js) ?? FALLBACK_PARAMS;
}

function shuffleArr(arr: number[], params: ChapterLogParams, seed: number): number[] {
  let s = seed;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * params.a + params.c) % params.mod;
    const j = Math.floor((s / params.mod) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Reorder paragraphs in #acontent to correct reading order.
 * Also removes fake `<p>` elements with auto-generated class names like `a1234`.
 */
function applyParagraphShuffle(
  $: CheerioAPI,
  contentEl: ReturnType<CheerioAPI>,
  chapterId: number,
  params: ChapterLogParams,
): void {
  // Step 1: Remove non-content elements — exactly as bili_novel_packer does before shuffling
  contentEl.find("div, ins, figure, fig, br, script, .tp, .bd").remove();
  // Remove fake paragraphs with auto-generated class names like `a1234`
  contentEl.find("p").each((_, el) => {
    const cls = $(el).attr("class") ?? "";
    if (/^[a-z]\d{4}$/.test(cls.trim())) $(el).remove();
  });

  // Collect non-empty <p> elements in DOM order
  const pEls = contentEl.find("p").toArray().filter((el) => $(el).text().trim() !== "");
  if (pEls.length === 0) return;

  const n = pEls.length;
  const seed = chapterId * params.seedMultiplier + params.seedOffset;

  console.log("[shuffle] n:", n, "chapterId:", chapterId, "seed:", seed, "fixedLength:", params.fixedLength);
  console.log("[shuffle] RAW[0]:", $(pEls[0]).text().trim().slice(0, 60));
  console.log("[shuffle] RAW[1]:", $(pEls[1]).text().trim().slice(0, 60));
  console.log("[shuffle] RAW[2]:", $(pEls[2]).text().trim().slice(0, 60));

  const fixed: number[] = [], shuffled: number[] = [];
  for (let i = 0; i < n; i++) {
    i < params.fixedLength ? fixed.push(i) : shuffled.push(i);
  }

  let indices: number[];
  if (n > params.fixedLength) {
    shuffleArr(shuffled, params, seed);
    indices = [...fixed, ...shuffled];
  } else {
    indices = [...fixed];
  }

  console.log("[shuffle] indices[0..4]:", indices.slice(0, 5));

  // mapped[indices[i]] = pEls[i]  →  display position indices[i] gets paragraph i
  const mapped = new Array<ReturnType<CheerioAPI>>(n);
  for (let i = 0; i < n; i++) {
    mapped[indices[i]] = $(pEls[i]).clone();
  }

  // Replace p elements in DOM order with mapped[0], mapped[1], ...
  let replacedIndex = 0;
  contentEl.find("p").each((_, el) => {
    if ($(el).text().trim() === "") return;
    $(el).replaceWith(mapped[replacedIndex++]);
  });

  // Log after-shuffle first 3 paragraphs
  const afterEls = contentEl.find("p").toArray().filter(el => $(el).text().trim() !== "");
  console.log("[shuffle] AFTER[0]:", $(afterEls[0]).text().trim().slice(0, 60));
  console.log("[shuffle] AFTER[1]:", $(afterEls[1]).text().trim().slice(0, 60));
  console.log("[shuffle] AFTER[2]:", $(afterEls[2]).text().trim().slice(0, 60));
}

/** Rewrite any bilinovel/CN URL to tw.linovelib.com */
function toLinovelib(url: string): string {
  return url
    .replace("www.bilinovel.com", "tw.linovelib.com")
    .replace("cn.linovelib.com", "tw.linovelib.com");
}

// ─── Page extraction ─────────────────────────────────────────────────────────

async function extractPage(
  html: string,
  currentUrl: string,
  skipShuffle = false,
): Promise<{ title: string; content: string; nextPageUrl: string | null; nextChapterUrl: string | null; prevChapterUrl: string | null }> {
  const $ = cheerio.load(html);

  // Extract chapterlog.js URL BEFORE removing scripts
  let chapterLogUrl: string | null = null;
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    if (src.includes("chapterlog.js")) {
      chapterLogUrl = src.startsWith("http") ? src : new URL(src, currentUrl).toString();
    }
  });

  // Extract chapterId from inline script (same as bili_novel_packer)
  const chapterIdMatch =
    /chapterid['":\s]+['"]?(\d+)['"]?/i.exec(html) ??
    /\/(\d+)(?:_\d+)?\.html/.exec(currentUrl);
  const chapterId = chapterIdMatch ? parseInt(chapterIdMatch[1], 10) : 0;
  console.log("[chapter] url:", currentUrl, "chapterId:", chapterId, "chapterLogUrl:", chapterLogUrl);

  $("script, style, ins, iframe, .ads, #ads").remove();

  const title = $("h1").first().text().trim() || "";

  // Fetch and parse chapterlog.js (plain fetch — it's a static JS asset, no CF)
  let clParams = FALLBACK_PARAMS;
  if (chapterLogUrl) {
    try {
      const jsRes = await fetch(chapterLogUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
          "Referer": currentUrl,
        },
      });
      if (jsRes.ok) {
        const jsText = await jsRes.text();
        clParams = parseChapterLog(jsText);
        console.log("[chapterlog] params:", clParams);
      }
    } catch (e) {
      console.warn("[chapterlog] failed to fetch/parse, using fallback params:", e);
    }
  } else {
    console.warn("[chapterlog] no chapterlog.js found in page, using fallback params");
  }

  // #acontent = 手機版；其餘為電腦版/備援
  const contentEl = $("#acontent, #mlfy_main_text, .read-content, .chapter-content, #TextContent").first();

  if (contentEl.length && chapterId > 0) {
    if (skipShuffle) {
      console.log("[chapter] skipping applyParagraphShuffle — HTML already rendered by browser");
    } else {
      applyParagraphShuffle($, contentEl, chapterId, clParams);
    }
  }

  let content = "";
  if (contentEl.length) {
    // When skipShuffle (Playwright-rendered), figure/div elements were NOT stripped
    // by applyParagraphShuffle, so strip ad/noise elements here too.
    if (skipShuffle) {
      contentEl.find("div, ins, script, .tp, .bd").remove();
      contentEl.find("p").each((_, el) => {
        const cls = $(el).attr("class") ?? "";
        if (/^[a-z]\d{4}$/.test(cls.trim())) $(el).remove();
      });
    }

    const extractImgSrc = (el: ReturnType<typeof $>): string => {
      return (
        el.attr("src") ??
        el.attr("data-src") ??
        el.attr("data-original") ??
        ""
      );
    };

    // Helper to add image to DB and content
    const processImageSrc = (src: string) => {
      if (src && !src.startsWith("data:")) {
        const abs = src.startsWith("http") ? src : new URL(src, currentUrl).toString();
        content += `[IMG:${abs}]\n\n`;
        const catalogUrl = extractCatalogUrl(currentUrl);
        if (catalogUrl) {
          addImageDb(catalogUrl, currentUrl, title, abs, "");
        }
      }
    };

    // Iterate direct children of contentEl to preserve order and avoid double-counting
    contentEl.children().each((_, el) => {
      const tag = (el as { name?: string }).name ?? "";

      // Standalone <img> direct child
      if (tag === "img") {
        processImageSrc(extractImgSrc($(el)));
        return;
      }

      // <figure>, <p>, or <div> containing an <img>
      if (tag === "p" || tag === "figure" || tag === "div") {
        const imgEls = $(el).find("img");
        if (imgEls.length) {
          imgEls.each((_, img) => {
            processImageSrc(extractImgSrc($(img)));
          });
        }
        if (tag === "figure") return;
        const text = $(el).text().trim();
        if (!text) return;
        content += text + "\n\n";
        return;
      }

      // <center> may wrap an image
      if (tag === "center") {
        const imgEls = $(el).find("img");
        if (imgEls.length) {
          imgEls.each((_, img) => processImageSrc(extractImgSrc($(img))));
        }
      }
    });
  }

  // Extract url_previous / url_next from inline JS — same as bili_novel_packer
  const baseUrl = new URL(currentUrl);
  const urlNavMatch = /url_previous:'(.*?)',url_next:'(.*?)'/.exec(html);
  const rawPrevUrl = urlNavMatch?.[1] ?? null;
  const rawNextUrl = urlNavMatch?.[2] ?? null;

  const resolve = (raw: string | null) => {
    if (!raw) return null;
    const full = raw.startsWith("http") ? raw : baseUrl.origin + raw;
    return toLinovelib(full);
  };

  // Determine whether next/prev links are same-chapter pages or chapter boundaries
  const prevLinkText = $("#footlink a:first-child").text().trim();
  const nextLinkText = $("#footlink a:last-child").text().trim();
  const isPrevPage = prevLinkText === "上一页" || prevLinkText === "上一頁";
  const isNextPage = nextLinkText === "下一页" || nextLinkText === "下一頁";

  return {
    title,
    content: content.trim(),
    nextPageUrl: isNextPage ? resolve(rawNextUrl) : null,
    nextChapterUrl: isNextPage ? null : resolve(rawNextUrl),
    prevChapterUrl: isPrevPage ? null : resolve(rawPrevUrl),
  };
}

export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get("url");
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  if (!rawUrl) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  // Normalise to tw.linovelib.com
  const url = rawUrl
    .replace("www.bilinovel.com", "tw.linovelib.com")
    .replace("cn.linovelib.com", "tw.linovelib.com");

  try {
    if (!force) {
      const cached = getChapterDb(url);
      if (cached) return NextResponse.json({ ...cached, cached: true });
    }

    const { html, renderedByBrowser }: { html: string; renderedByBrowser: boolean } = await cfFetchHtmlEx(url);
    const { title, content, nextPageUrl, nextChapterUrl, prevChapterUrl } =
      await extractPage(html, url, renderedByBrowser);

    const result: ChapterPageResult = {
      title,
      content,
      nextPageUrl,
      nextChapterUrl,
      prevChapterUrl,
    };
    const catalogUrl = extractCatalogUrl(url);
    if (catalogUrl) {
      setChapterDb(url, catalogUrl, result);
    }
    return NextResponse.json({ ...result, cached: false });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
