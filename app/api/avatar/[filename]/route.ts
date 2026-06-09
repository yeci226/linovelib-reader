import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const BACKEND_URL = process.env.BACKEND_URL ?? "";

export async function GET(req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  if (!BACKEND_URL) {
    return new NextResponse("Backend not configured", { status: 500 });
  }
  
  try {
    const { filename } = await params;
    const res = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/avatar/${filename}`);
    
    if (!res.ok) return new NextResponse("Not found", { status: 404 });
    
    const buffer = await res.arrayBuffer();
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (err: any) {
    return new NextResponse(err.message, { status: 500 });
  }
}
