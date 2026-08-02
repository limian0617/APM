import { currentObservabilityContext } from "@/modules/observability/application/context";

export type ApiFieldIssue = {
  field: string;
  code: string;
  message: string;
};

export class ApiContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly issues: ApiFieldIssue[] = []
  ) {
    super(message);
    this.name = "ApiContractError";
  }
}

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    issues: ApiFieldIssue[];
    requestId: string | null;
    traceId: string | null;
  };
};

function correlation(override?: { requestId: string; traceId: string }) {
  const context = currentObservabilityContext();
  return {
    requestId: override?.requestId ?? context?.requestId ?? null,
    traceId: override?.traceId ?? context?.traceId ?? null
  };
}

export function apiErrorEnvelope(input: {
  code: string;
  message: string;
  issues?: ApiFieldIssue[];
  correlation?: { requestId: string; traceId: string };
}): ApiErrorEnvelope {
  return {
    error: {
      code: input.code,
      message: input.message,
      issues: input.issues ?? [],
      ...correlation(input.correlation)
    }
  };
}

export function apiErrorResponse(input: {
  status: number;
  code: string;
  message: string;
  issues?: ApiFieldIssue[];
  headers?: HeadersInit;
  correlation?: { requestId: string; traceId: string };
}): Response {
  return Response.json(apiErrorEnvelope(input), {
    status: input.status,
    headers: input.headers
  });
}

export function apiContractErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ApiContractError)) return null;
  return apiErrorResponse({
    status: error.status,
    code: error.code,
    message: error.message,
    issues: error.issues
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function normalizeApiErrorResponse(
  response: Response,
  requestId: string,
  traceId: string
): Promise<Response> {
  if (response.status < 400) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return response;

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!isRecord(payload) || !isRecord(payload.error)) return response;

  const error = payload.error;
  const code = typeof error.code === "string" && error.code ? error.code : "REQUEST_FAILED";
  const message =
    typeof error.message === "string" && error.message
      ? error.message
      : "请求未能完成，请检查输入后重试。";
  const issues = Array.isArray(error.issues)
    ? error.issues.filter(
        (issue): issue is ApiFieldIssue =>
          isRecord(issue) &&
          typeof issue.field === "string" &&
          typeof issue.code === "string" &&
          typeof issue.message === "string"
      )
    : [];
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return apiErrorResponse({
    status: response.status,
    code,
    message,
    issues,
    headers,
    correlation: { requestId, traceId }
  });
}
