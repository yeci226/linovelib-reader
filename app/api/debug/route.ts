import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { cfFetchHtml } from "@/lib/cf-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  const html = await cfFetchHtml(url);
  const $ = cheerio.load(html);

  // Extract chapterId (same as route.ts)
  const chapterIdMatch =
    /chapterid['":\s]+['"]?(\d+)['"]?/i.exec(html) ??
    /\/(\d+)(?:_\d+)?\.html/.exec(url);
  const chapterId = chapterIdMatch ? parseInt(chapterIdMatch[1], 10) : 0;

  // Find chapterlog.js URL
  let chapterLogUrl: string | null = null;
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    if (src.includes("chapterlog.js")) {
      chapterLogUrl = src.startsWith("http") ? src : new URL(src, url).toString();
    }
  });

  $("script, style, ins, iframe").remove();

  const contentEl = $("#acontent").first();
  if (!contentEl.length) return NextResponse.json({ error: "no #acontent" });

  // Raw paragraphs before any shuffle
  const rawPs = contentEl.find("p").toArray()
    .filter(el => $(el).text().trim() !== "")
    .map(el => ({
      attrs: Object.entries((el as any).attribs ?? {}).map(([k, v]) => `${k}=${v}`).join(" "),
      text: $(el).text().trim().slice(0, 80),
    }));

  // ReadParams raw
  const readParamsMatch = /ReadParams\s*=\s*\{([^}]+)\}/.exec(html);
  const readParamsRaw = readParamsMatch ? readParamsMatch[1].slice(0, 300) : "not found";

  return NextResponse.json({
    chapterId,
    chapterLogUrl,
    readParamsRaw,
    pCount: rawPs.length,
    first10: rawPs.slice(0, 10),
    last5: rawPs.slice(-5),
  });
}
