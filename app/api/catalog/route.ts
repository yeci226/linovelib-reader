import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { cfFetchHtml } from "@/lib/cf-fetch";
import { readCache, writeCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

type CatalogResult = {
  title: string;
  chapters: { title: string; url: string }[];
};

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  try {
    if (!force) {
      const cached = await readCache<CatalogResult>("catalog", url);
      if (cached) return NextResponse.json({ ...cached, cached: true });
    }

    const html = await cfFetchHtml(url);
    const $ = cheerio.load(html);

    const title = $("h1").first().text().trim() || "未知小說";
    const base = new URL(url).origin;

    const chapters: CatalogResult["chapters"] = [];
    const seen = new Set<string>();
    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().trim();
      if (!text) return;
      if (!/\/novel\/\d+\/\d+\.html$/.test(href)) return;
      const fullUrl = href.startsWith("http") ? href : base + href;
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);
      chapters.push({ title: text, url: fullUrl });
    });

    const result: CatalogResult = { title, chapters };
    await writeCache("catalog", url, result, CATALOG_TTL_MS);
    return NextResponse.json({ ...result, cached: false });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
