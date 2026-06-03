import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { cfFetchHtml } from "@/lib/cf-fetch";
import { readCache, writeCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const TW_ORIGIN = "https://tw.linovelib.com";
const BILI_ORIGIN = "https://www.bilinovel.com";

type Chapter = { title: string; url: string | null };
type VolumeGroup = { volTitle: string; coverUrl: string; chapters: Chapter[] };
type CatalogResult = { title: string; coverUrl: string; volumes: VolumeGroup[] };

function toTwLinovelib(url: string): string {
  return url
    .replace("https://www.bilinovel.com", TW_ORIGIN)
    .replace("http://www.bilinovel.com", TW_ORIGIN);
}

function toBilinovel(url: string): string {
  return url
    .replace("https://tw.linovelib.com", BILI_ORIGIN)
    .replace("http://tw.linovelib.com", BILI_ORIGIN);
}

const UA_MOBILE =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

/**
 * Fetch a chapter page's navigation JS using plain HTTP to bilinovel.com first
 * (same approach as bili_novel_packer). Falls back to cfFetchHtml if CF-blocked.
 * Returns { prev, next, isNextPage } where isNextPage=true means "next" is the
 * next SUB-PAGE of the same chapter rather than the next chapter.
 */
async function fetchChapterNav(
  url: string,
): Promise<{ prev: string | null; next: string | null; isNextPage: boolean }> {
  const biliUrl = toBilinovel(url);
  let html = "";

  try {
    const res = await fetch(biliUrl, {
      headers: {
        "User-Agent": UA_MOBILE,
        Cookie: "night=0",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) html = await res.text();
  } catch {
    // ignore
  }

  if (
    !html ||
    html.includes("cf-browser-verification") ||
    html.includes("Just a moment") ||
    html.includes("Cloudflare")
  ) {
    try {
      html = await cfFetchHtml(url);
    } catch {
      return { prev: null, next: null, isNextPage: false };
    }
  }

  const navMatch = /url_previous:'(.*?)',url_next:'(.*?)'/.exec(html);
  const prevRaw = navMatch?.[1] ?? null;
  const nextRaw = navMatch?.[2] ?? null;

  const resolve = (raw: string | null): string | null => {
    if (!raw) return null;
    const full = raw.startsWith("http") ? raw : TW_ORIGIN + raw;
    return toTwLinovelib(full);
  };

  // Determine if next link is a sub-page ("下一頁") or a chapter ("下一章")
  const nextLinkText = /#footlink[\s\S]{0,500}?<a\b[^>]*>\s*([^<]+?)\s*<\/a>\s*<\/div>/
    .exec(html)?.[1]
    ?.trim() ?? "";
  const isNextPage = nextLinkText === "下一页" || nextLinkText === "下一頁";

  return { prev: resolve(prevRaw), next: resolve(nextRaw), isNextPage };
}

/**
 * Resolve null-url chapters using the bili_novel_packer strategy:
 *
 * Strategy A (preferred): find the next chapter with a known URL, fetch it,
 * extract url_previous → that's the URL for the chapter just before it.
 * Chain backwards through consecutive nulls.
 *
 * Strategy B (fallback): find the prev chapter with a known URL, follow its
 * url_next links (skipping sub-pages) until we reach the first "next chapter"
 * boundary, which gives us the first null chapter's URL.
 */
async function resolveNullChapterUrls(allChapters: Chapter[]): Promise<void> {
  let i = 0;
  while (i < allChapters.length) {
    if (allChapters[i].url !== null) { i++; continue; }

    const gapStart = i;
    while (i < allChapters.length && allChapters[i].url === null) i++;
    const gapEnd = i - 1;

    console.log(`[catalog] resolving gap [${gapStart}..${gapEnd}]`);

    // ── Strategy A: chain backwards from next known chapter ──
    const nextKnownUrl = i < allChapters.length ? allChapters[i].url : null;
    if (nextKnownUrl) {
      let currentUrl = nextKnownUrl;
      let resolved = 0;
      for (let k = gapEnd; k >= gapStart; k--) {
        const { prev } = await fetchChapterNav(currentUrl);
        if (!prev) {
          console.warn(`[catalog] strategy A stopped at k=${k}, no prev url from ${currentUrl}`);
          break;
        }
        allChapters[k].url = prev;
        currentUrl = prev;
        resolved++;
        console.log(`[catalog] resolved "${allChapters[k].title}" → ${prev}`);
      }
      if (resolved === gapEnd - gapStart + 1) continue; // fully resolved
    }

    // ── Strategy B: follow next links from prev known chapter ──
    const prevKnownUrl = gapStart > 0 ? allChapters[gapStart - 1].url : null;
    if (prevKnownUrl && allChapters[gapStart].url === null) {
      let url = prevKnownUrl;
      for (let attempt = 0; attempt < 25; attempt++) {
        const { next, isNextPage } = await fetchChapterNav(url);
        if (!next) break;
        if (!isNextPage) {
          // next is the first chapter boundary after prev — that's gapStart
          allChapters[gapStart].url = next;
          console.log(`[catalog] strategy B resolved "${allChapters[gapStart].title}" → ${next}`);
          // If there are more nulls in the gap, chain backwards from next known (now gapStart is known)
          if (gapStart < gapEnd) {
            let cur = next;
            for (let k = gapStart + 1; k <= gapEnd; k++) {
              // We need to go FORWARD through gapStart's sub-pages to reach k's chapter
              // Simpler: chain backwards from nextKnown (may be partially filled now)
              // Re-use strategy A from gapEnd back to gapStart+1
              const nk = i < allChapters.length ? allChapters[i].url : null;
              if (nk) {
                cur = nk;
                for (let m = gapEnd; m >= gapStart + 1; m--) {
                  if (allChapters[m].url !== null) { cur = allChapters[m].url!; continue; }
                  const { prev } = await fetchChapterNav(cur);
                  if (!prev) break;
                  allChapters[m].url = prev;
                  cur = prev;
                  console.log(`[catalog] strategy B+A resolved "${allChapters[m].title}" → ${prev}`);
                }
              }
              break;
            }
          }
          break;
        }
        url = next;
      }
    }
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  // Normalize: cache key uses tw.linovelib.com, fetch from bilinovel.com (no CF)
  const twUrl = toTwLinovelib(url);
  const fetchUrl = toBilinovel(url);

  try {
    if (!force) {
      const cached = await readCache<CatalogResult>("catalog", twUrl);
      if (cached) return NextResponse.json({ ...cached, cached: true });
    }

    const html = await cfFetchHtml(fetchUrl);
    const $ = cheerio.load(html);

    const title =
      $("h1.book-title, h1").first().text().trim() || "未知小說";

    // Novel cover
    const coverEl = $(".book-img img, .cover img, .novel-cover img").first();
    let coverUrl =
      coverEl.attr("data-src") || coverEl.attr("src") || "";
    if (coverUrl && !coverUrl.startsWith("http"))
      coverUrl = BILI_ORIGIN + coverUrl;
    if (coverUrl) coverUrl = toTwLinovelib(coverUrl);

    // Parse volumes using bili_novel_packer selectors
    // .volume-chapters > li  →  .chapter-bar | .volume-cover | .jsChapter
    const volumes: VolumeGroup[] = [];
    const state: { vol: VolumeGroup | null } = { vol: null };

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
        // Locked/VIP chapters have href="javascript:..." — keep them in list with null url
        const isLocked = !href || href.startsWith("javascript");
        const fullUrl = isLocked
          ? null
          : href.startsWith("http")
            ? toTwLinovelib(href)
            : TW_ORIGIN + href;
        if (!state.vol) state.vol = { volTitle: "", coverUrl: "", chapters: [] };
        state.vol.chapters.push({ title: chTitle, url: fullUrl });
      }
    });

    if (state.vol && (state.vol.chapters.length > 0 || state.vol.volTitle)) {
      volumes.push(state.vol);
    }

    // ── Resolve locked/VIP chapters (bili_novel_packer _getChapterUrl strategy) ──
    const allChapters = volumes.flatMap(v => v.chapters);
    const hasNulls = allChapters.some(c => c.url === null);
    if (hasNulls) {
      await resolveNullChapterUrls(allChapters);
    }

    const result: CatalogResult = { title, coverUrl, volumes };
    await writeCache("catalog", twUrl, result, CATALOG_TTL_MS);
    return NextResponse.json({ ...result, cached: false });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
