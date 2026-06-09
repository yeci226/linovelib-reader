import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const BACKEND_URL = process.env.BACKEND_URL ?? "";

export async function GET(req: NextRequest) {
  if (!BACKEND_URL) {
    return NextResponse.json({ error: "Backend not configured" }, { status: 500 });
  }

  try {
    const auth = req.headers.get("authorization");
    if (!auth) return NextResponse.json({ error: "No auth" }, { status: 401 });

    const res = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/auth/me`, {
      method: "GET",
      headers: {
        "Authorization": auth,
      },
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
