import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";
  
  try {
    const targetUrl = `${BACKEND_URL.replace(/\/$/, "")}/api/chapter${req.nextUrl.search}`;
    const proxyRes = await fetch(targetUrl, {
      headers: { "Authorization": `Bearer ${process.env.AUTH_TOKEN || ""}` }
    });
    
    if (proxyRes.ok) {
      const data = await proxyRes.json();
      return NextResponse.json(data);
    } else {
      const text = await proxyRes.text();
      return NextResponse.json({ error: `Backend returned ${proxyRes.status}: ${text}` }, { status: proxyRes.status });
    }
  } catch (err) {
    console.error(`Proxy to backend (/api/chapter) failed:`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
