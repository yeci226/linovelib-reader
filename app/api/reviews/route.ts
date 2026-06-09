import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const BACKEND_URL = process.env.BACKEND_URL ?? "";

export async function GET(req: NextRequest) {
  if (!BACKEND_URL) return NextResponse.json({ error: "Backend not configured" }, { status: 500 });
  const url = new URL(req.url);
  const catalogUrl = url.searchParams.get("catalogUrl") || url.searchParams.get("catalog_url");
  const auth = req.headers.get("authorization") || "";
  
  try {
    const res = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/reviews?catalog_url=${encodeURIComponent(catalogUrl || "")}`, {
      headers: { "Authorization": auth }
    });
    const data = await res.json().catch(() => []);
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!BACKEND_URL) return NextResponse.json({ error: "Backend not configured" }, { status: 500 });
  const auth = req.headers.get("authorization") || "";
  try {
    const body = await req.json();
    const res = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": auth },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
