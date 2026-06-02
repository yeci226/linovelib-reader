import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { cfFetchHtml } from "@/lib/cf-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOMAIN = "https://tw.linovelib.com";

export type SearchResult = {
  id: string;
  title: string;
  author: string;
  coverUrl: string;
  catalogUrl: string;
};

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "Missing q" }, { status: 400 });

  try {
    const html = await cfFetchHtml(`${DOMAIN}/search?kw=${encodeURIComponent(q)}`);
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    // linovelib search results: each novel in .book-li
    $(".book-li, .search-item, li.list-comic").each((_, el) => {
      const a = $(el).find("a[href*='/novel/']").first();
      const href = a.attr("href") ?? "";
      const idMatch = /\/novel\/(\d+)/.exec(href);
      if (!idMatch) return;

      const id = idMatch[1];
      const title =
        $(el).find(".book-name, .title, h3, h4").first().text().trim() ||
        a.attr("title") ||
        a.text().trim();
      if (!title) return;

      const author =
        $(el).find(".book-author, .author").first().text().trim().replace(/^作者[:：\s]+/, "") || "";

      const imgEl = $(el).find("img").first();
      const coverUrl =
        imgEl.attr("data-src") || imgEl.attr("src") || "";

      const catalogUrl = `${DOMAIN}/novel/${id}/catalog`;

      results.push({ id, title, author, coverUrl, catalogUrl });
    });

    // Fallback: scan all novel links if structured selectors found nothing
    if (results.length === 0) {
      const seen = new Set<string>();
      $("a[href*='/novel/']").each((_, el) => {
        const href = $(el).attr("href") ?? "";
        const idMatch = /\/novel\/(\d+)(?:\.html|\/|$)/.exec(href);
        if (!idMatch) return;
        const id = idMatch[1];
        if (seen.has(id)) return;
        seen.add(id);

        const title = $(el).attr("title") || $(el).text().trim();
        if (!title || title.length < 2) return;

        const coverUrl =
          $(el).find("img").attr("data-src") ||
          $(el).find("img").attr("src") || "";

        results.push({
          id,
          title,
          author: "",
          coverUrl,
          catalogUrl: `${DOMAIN}/novel/${id}/catalog`,
        });
      });
    }

    return NextResponse.json({ results: results.slice(0, 20) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
