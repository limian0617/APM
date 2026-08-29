import { NextResponse } from "next/server";

import { createHealthStatus } from "@/lib/health";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

function health() {
  return NextResponse.json(createHealthStatus());
}

export const GET = withRequestObservability({ module: "health", operation: "liveness" }, health);
