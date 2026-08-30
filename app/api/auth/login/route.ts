import { NextResponse } from "next/server";
import { constantTimeEqual, createSession, loginFingerprint, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";
import { journal } from "@/lib/supabase";

export async function POST(request: Request) {
  const { password } = await request.json() as { password?: string };
  const expected = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  if (!expected || !secret) return NextResponse.json({ error: "Dashboard is not configured" }, { status: 503 });
  const fingerprint = await loginFingerprint(request, secret);
  const success = Boolean(password && await constantTimeEqual(password, expected));
  let rateLimit: Awaited<ReturnType<typeof journal.registerLoginAttempt>>;
  try { rateLimit = await journal.registerLoginAttempt(fingerprint, success); }
  catch { return NextResponse.json({ error: "Login control plane unavailable" }, { status: 503 }); }
  if (rateLimit.blocked) {
    const response = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    response.headers.set("retry-after", String(rateLimit.retry_after_seconds ?? 900));
    return response;
  }
  if (!success || !rateLimit.allowed) return NextResponse.json({ error: "Invalid access code" }, { status: 401 });

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
