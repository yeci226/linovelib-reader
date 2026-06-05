import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { getDiscoverCache, setDiscoverCache } from "@/lib/db";
import { cfFetchHtml } from "@/lib/cf-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BILI_ORIGIN = "https://www.bilinovel.com";
const TW_ORIGIN = "https://tw.linovelib.com";

function toTwLinovelib(url: string): string {
  return url.replace(BILI_ORIGIN, TW_ORIGIN).replace("http://www.bilinovel.com", TW_ORIGIN);
}

export type DiscoverItem = {
  title: string;
  url: string;
  coverUrl: string;
  author: string;
  desc: string;
  tags: string[];
};

export type DiscoverResult = {
  items: DiscoverItem[];
  totalPages: number;
};

export async function GET(req: NextRequest) {
  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  
  const DISCOVER_BACKEND_URL = process.env.DISCOVER_BACKEND_URL || "";
  if (DISCOVER_BACKEND_URL) {
    try {
      const targetUrl = `${DISCOVER_BACKEND_URL.replace(/\/$/, "")}/api/discover/wenku${req.nextUrl.search}`;
      const proxyRes = await fetch(targetUrl, {
        headers: { "Authorization": `Bearer ${process.env.AUTH_TOKEN || ""}` }
      });
      if (proxyRes.ok) {
        const data = await proxyRes.json();
        return NextResponse.json(data);
      }
    } catch (err) {
      console.error("Proxy to discover backend failed:", err);
    }
  }

  const cacheKey = `wenku_page_${page}`;

  try {
    if (!force) {
      const cached = getDiscoverCache(cacheKey);
      if (cached) return NextResponse.json({ ...cached, cached: true });
    }

    // wenku url format: https://tw.linovelib.com/wenku/lastupdate_0_0_0_0_0_0_0_1_0.html
    const fetchUrl = `${TW_ORIGIN}/wenku/lastupdate_0_0_0_0_0_0_0_${page}_0.html`;
    const html = await cfFetchHtml(fetchUrl);
    const $ = cheerio.load(html);

    const items: DiscoverItem[] = [];

    $(".book-ol .book-li").each((_, el) => {
      const a = $(el).find("a.book-layout");
      if (!a.length) return;

      const urlPath = a.attr("href") || "";
      const url = urlPath.startsWith("http") ? toTwLinovelib(urlPath) : TW_ORIGIN + urlPath;
      
      const img = $(el).find("img");
      let coverUrl = img.attr("data-original") || img.attr("data-src") || img.attr("src") || "";
      if (coverUrl && !coverUrl.startsWith("http")) coverUrl = BILI_ORIGIN + coverUrl;
      coverUrl = toTwLinovelib(coverUrl);

      const title = $(el).find("h4.book-title, .book-title").text().trim();
      const author = $(el).find(".book-author, .book-meta span").first().text().trim().replace(/^作者\s*/, '');
      const desc = $(el).find(".book-desc").text().trim();
      
      const tags: string[] = [];
      $(el).find(".tag-small").each((_, em) => {
        const text = $(em).text().trim();
        if (text) {
          tags.push(...text.split(/\s+/).filter(Boolean));
        }
      });

      if (title && url) {
        items.push({ title, url, coverUrl, author, desc, tags });
      }
    });

    let totalPages = 1;
    const lastPageLink = $(".pagelink a.last").attr("href");
    if (lastPageLink) {
      const match = /_(\d+)_0\.html/.exec(lastPageLink);
      if (match) {
        totalPages = parseInt(match[1], 10);
      }
    } else {
      $(".pagelink a").each((_, el) => {
        const text = $(el).text().trim();
        const p = parseInt(text, 10);
        if (!isNaN(p) && p > totalPages) {
          totalPages = p;
        }
      });
    }

    const result: DiscoverResult = { items, totalPages };
    setDiscoverCache(cacheKey, result);

    return NextResponse.json({ ...result, cached: false });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
