import { NextResponse } from "next/server";
import { journal } from "@/lib/supabase";

export async function POST() {
  try {
    const active = await journal.activeControlRequest();
    if (active) return NextResponse.json({ status: active.status.toUpperCase(), request_id: active.id }, { status: 202 });
    const request = await journal.enqueueControlRequest("dashboard");
    return NextResponse.json({ status: "QUEUED", request_id: request.id }, { status: 202 });
  } catch (error) {
    const active = await journal.activeControlRequest().catch(() => null);
    if (active) return NextResponse.json({ status: active.status.toUpperCase(), request_id: active.id }, { status: 202 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Agent request failed" }, { status: 500 });
  }
}
