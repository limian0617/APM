import { NextResponse } from "next/server";

import { createHealthStatus } from "@/lib/health";

export function GET() {
  return NextResponse.json(createHealthStatus());
}
