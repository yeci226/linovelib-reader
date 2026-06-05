import { NextRequest, NextResponse } from "next/server";
import { getImagesDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  try {
    const images = getImagesDb(url);
    return NextResponse.json({ images });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
