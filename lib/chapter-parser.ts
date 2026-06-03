/**
 * Client-side chapter parser — mirrors the logic in app/api/chapter/route.ts.
 *
 * Uses the browser's native DOMParser (no cheerio / Node.js deps) so it can
 * run entirely in the browser when the Next.js API is unavailable.
 *
 * Ported from bili_novel_packer (Dart) by Montaro2017
 * https://github.com/Montaro2017/bili_novel_packer
 */

import { restoreChars } from "@/lib/linovelib-charmap";

export type ChapterPageResult = {
  title: string;
  content: string;
  nextPageUrl: string | null;
  nextChapterUrl: string | null;
  prevChapterUrl: string | null;
};

// ─── ChapterLog (paragraph-shuffle) logic ────────────────────────────────────

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

/** Simple integer expression evaluator: handles +,-,*,/,%,^,<<,>> and hex literals */
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

const OBFUSCATED_SEED_RE =
  /var\s+[_$a-zA-Z0-9]+\s*=\s*[^;]*?Number\s*\(\s*[_$a-zA-Z0-9]+\s*\)\s*,\s*([^,)]+?)\s*\)\s*,\s*([^,)]+?)\s*\)\s*,/g;
const OBFUSCATED_LCG_RE =
  /([_$a-zA-Z0-9]+)\s*=\s*[^;]*?\(\s*\1\s*,\s*([^,)]+?)\s*\)\s*,\s*([^,)]+?)\s*\)\s*,\s*([^;)]+?)\s*\)\s*;/g;

function tryParseObfuscated(js: string): ChapterLogParams | null {
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

export function parseChapterLog(js: string): ChapterLogParams {
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
 * Reorder paragraphs in the content element to correct reading order.
 * Uses browser native DOM — no cheerio dependency.
 */
function applyParagraphShuffleDom(
  contentEl: Element,
  chapterId: number,
  params: ChapterLogParams,
): void {
  // Remove non-content elements
  contentEl.querySelectorAll("div, ins, figure, fig, br, script, .tp, .bd").forEach(el => el.remove());
  // Remove fake paragraphs with auto-generated class names like `a1234`
  contentEl.querySelectorAll("p").forEach(el => {
    const cls = el.getAttribute("class") ?? "";
    if (/^[a-z]\d{4}$/.test(cls.trim())) el.remove();
  });

  const pEls = Array.from(contentEl.querySelectorAll("p")).filter(
    el => (el.textContent?.trim() ?? "") !== ""
  );
  if (pEls.length === 0) return;

  const n = pEls.length;
  const seed = chapterId * params.seedMultiplier + params.seedOffset;

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

  // mapped[indices[i]] = pEls[i] → display position indices[i] gets paragraph i
  const mapped = new Array<Element>(n);
  for (let i = 0; i < n; i++) {
    mapped[indices[i]] = pEls[i].cloneNode(true) as Element;
  }

  // Replace p elements in DOM order with mapped[0], mapped[1], ...
  let k = 0;
  Array.from(contentEl.querySelectorAll("p")).forEach(el => {
    if ((el.textContent?.trim() ?? "") === "") return;
    el.replaceWith(mapped[k++]);
  });
}

/** Rewrite TW/CN URLs back to tw.linovelib.com for the frontend */
function toLinovelib(url: string): string {
  return url
    .replace("www.bilinovel.com", "tw.linovelib.com")
    .replace("cn.linovelib.com", "tw.linovelib.com");
}

/**
 * Parse raw chapter HTML entirely in the browser.
 *
 * @param html          Raw HTML of the chapter page
 * @param currentUrl    The canonical URL of this page (used for relative-URL resolution)
 * @param chapterLogJs  Contents of the corresponding chapterlog.js (null → use fallback params)
 */
export function parseChapterHtml(
  html: string,
  currentUrl: string,
  chapterLogJs: string | null,
): ChapterPageResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Extract chapterId from inline script or URL path
  const chapterIdMatch =
    /chapterid['":\s]+['"]?(\d+)['"]?/i.exec(html) ??
    /\/(\d+)(?:_\d+)?\.html/.exec(currentUrl);
  const chapterId = chapterIdMatch ? parseInt(chapterIdMatch[1], 10) : 0;

  // Remove junk
  doc.querySelectorAll("script, style, ins, iframe, .ads, #ads").forEach(el => el.remove());

  const title = doc.querySelector("h1")?.textContent?.trim() ?? "";

  const clParams = chapterLogJs ? parseChapterLog(chapterLogJs) : FALLBACK_PARAMS;

  const contentEl = doc.querySelector(
    "#acontent, #mlfy_main_text, .read-content, .chapter-content, #TextContent"
  );

  if (contentEl && chapterId > 0) {
    applyParagraphShuffleDom(contentEl, chapterId, clParams);
  }

  let content = "";
  if (contentEl) {
    contentEl.querySelectorAll("p").forEach(el => {
      const text = restoreChars(el.textContent?.trim() ?? "");
      if (!text) return;
      content += text + "\n\n";
    });
  }

  // Navigation: extract url_previous / url_next from inline JS
  const baseUrl = new URL(currentUrl);
  const urlNavMatch = /url_previous:'(.*?)',url_next:'(.*?)'/.exec(html);
  const rawPrevUrl = urlNavMatch?.[1] ?? null;
  const rawNextUrl = urlNavMatch?.[2] ?? null;

  const resolve = (raw: string | null): string | null => {
    if (!raw) return null;
    const full = raw.startsWith("http") ? raw : baseUrl.origin + raw;
    return toLinovelib(full);
  };

  const prevLinkText = doc.querySelector("#footlink a:first-child")?.textContent?.trim() ?? "";
  const nextLinkText = doc.querySelector("#footlink a:last-child")?.textContent?.trim() ?? "";
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
