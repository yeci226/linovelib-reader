import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { cfFetchHtml } from "@/lib/cf-fetch";
import { readCache, writeCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const TW_ORIGIN = "https://tw.linovelib.com";
const BILI_ORIGIN = "https://www.bilinovel.com";

type Chapter = { title: string; url: string };
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
    // Use an object wrapper so closure can mutate the reference
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
        // Skip VIP/locked chapters
        if (!href || href.startsWith("javascript")) return;
        const fullUrl = href.startsWith("http")
          ? toTwLinovelib(href)
          : TW_ORIGIN + href;
        if (!state.vol) state.vol = { volTitle: "", coverUrl: "", chapters: [] };
        state.vol.chapters.push({ title: chTitle, url: fullUrl });
      }
    });

    if (state.vol && (state.vol.chapters.length > 0 || state.vol.volTitle)) {
      volumes.push(state.vol);
    }

    const result: CatalogResult = { title, coverUrl, volumes };
    await writeCache("catalog", twUrl, result, CATALOG_TTL_MS);
    return NextResponse.json({ ...result, cached: false });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
