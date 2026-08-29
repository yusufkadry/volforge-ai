import { NextResponse } from "next/server";
import { getDashboardSnapshot } from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export async function GET() { return NextResponse.json(await getDashboardSnapshot()); }
