import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

function unavailable() {
  return apiErrorResponse({
    status: 404,
    code: "EXTERNAL_API_NOT_AVAILABLE",
    message: "外部协作 API 尚未启用。"
  });
}

const observedUnavailable = withRequestObservability(
  { module: "external-api", operation: "reserved-v1" },
  unavailable
);

export const GET = observedUnavailable;
export const POST = observedUnavailable;
export const PUT = observedUnavailable;
export const PATCH = observedUnavailable;
export const DELETE = observedUnavailable;
