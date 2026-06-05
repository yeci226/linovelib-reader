import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q");
  const type = req.nextUrl.searchParams.get("type") || "normal";
  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const pageSize = 50;

  if (!query) {
    return NextResponse.json({ items: [], totalPages: 1 });
  }

  const q = query.toLowerCase();
  
  try {
    const rows = db.prepare(`SELECT data FROM DiscoverCache`).all() as { data: string }[];
    
    // We will collect all items in a map to remove duplicates (by url)
    const uniqueItems = new Map<string, any>();
    
    for (const row of rows) {
      if (!row.data) continue;
      try {
        const parsed = JSON.parse(row.data);
        const items = Array.isArray(parsed) ? parsed : parsed.items;
        if (Array.isArray(items)) {
          for (const item of items) {
            // Keep the first occurrence
            if (!uniqueItems.has(item.url)) {
              uniqueItems.set(item.url, item);
            }
          }
        }
      } catch (e) {
        console.error("Failed to parse DiscoverCache data", e);
      }
    }
    
    const allItems = Array.from(uniqueItems.values());
    
    // Score and filter
    const scored = allItems.map(item => {
      const titleMatch = item.title && item.title.toLowerCase().includes(q) ? 1 : 0;
      const authorMatch = item.author && item.author.toLowerCase().includes(q) ? 1 : 0;
      const tagMatch = item.tags && item.tags.some((t: string) => t.toLowerCase().includes(q)) ? 1 : 0;
      
      let score = 0;
      if (titleMatch || authorMatch || tagMatch) {
        if (type === "tag") {
          score = tagMatch * 3 + authorMatch * 2 + titleMatch * 1;
        } else {
          score = titleMatch * 3 + authorMatch * 2 + tagMatch * 1;
        }
      }
      return { item, score };
    }).filter(x => x.score > 0);
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    const filtered = scored.map(x => x.item);
    
    const totalPages = Math.ceil(filtered.length / pageSize) || 1;
    const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);
    
    return NextResponse.json({
      items: paginated,
      totalPages,
      totalCount: filtered.length
    });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json({ error: "Failed to search" }, { status: 500 });
  }
}
