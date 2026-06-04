import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const BACKEND_URL = process.env.BACKEND_URL ?? "";

export async function GET(req: NextRequest) {
  if (!BACKEND_URL) {
    return NextResponse.json({ error: "Backend not configured" }, { status: 500 });
  }
  
  try {
    const authHeader = req.headers.get("authorization") || "";
    const res = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/sync/pull`, {
      method: "GET",
      headers: { "Authorization": authHeader },
    });
    
    const data = await res.json().catch(() => null);
    return NextResponse.json(data || {}, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
