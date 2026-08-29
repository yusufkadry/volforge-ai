import { NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";

export async function POST(request: Request) {
  const { password } = await request.json() as { password?: string };
  const expected = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  if (!expected || !secret) return NextResponse.json({ error: "Dashboard is not configured" }, { status: 503 });
  if (!password || password !== expected) return NextResponse.json({ error: "Invalid access code" }, { status: 401 });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSession(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
  return response;
}
