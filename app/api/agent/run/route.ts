import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";

export const maxDuration = 60;
export async function POST() {
  try { return NextResponse.json(await runAgent("manual")); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Agent failed" }, { status: 500 }); }
}
