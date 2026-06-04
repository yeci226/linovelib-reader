import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const BACKEND_URL = process.env.BACKEND_URL ?? "";

export async function POST(req: NextRequest) {
  if (!BACKEND_URL) {
    return NextResponse.json({ error: "Backend not configured" }, { status: 500 });
  }
  
  try {
    const body = await req.json();
    const res = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    
    const data = await res.json().catch(() => null);
    return NextResponse.json(data || {}, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
