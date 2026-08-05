import { z } from "zod";

import { ApiContractError, type ApiFieldIssue } from "./errors";

const DEFAULT_BODY_BYTES = 1024 * 1024;

export const identifierSchema = z.string().trim().min(1).max(191);
export const idempotencyKeySchema = z.string().trim().min(1).max(191);
export const reasonSchema = z.string().trim().min(1).max(1024);
export const positiveVersionSchema = z.number().int().min(1);
export const nonNegativeVersionSchema = z.number().int().min(0);

function fieldName(source: string, path: PropertyKey[]): string {
  const suffix = path.map(String).join(".");
  return suffix ? `${source}.${suffix}` : source;
}

function issueMessage(code: string): string {
  switch (code) {
    case "unrecognized_keys":
      return "不允许的字段。";
    case "invalid_type":
      return "类型无效。";
    case "too_big":
      return "超过允许范围。";
    case "too_small":
      return "低于允许范围。";
    default:
      return "值无效。";
  }
}

function fieldIssues(error: z.ZodError, source: string): ApiFieldIssue[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        field: fieldName(source, [...issue.path, key]),
        code: "UNKNOWN_FIELD",
        message: issueMessage(issue.code)
      }));
    }
    return [
      {
        field: fieldName(source, issue.path),
        code: issue.code.toUpperCase(),
        message: issueMessage(issue.code)
      }
    ];
  });
}

export function parseDto<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiContractError(
      "VALIDATION_FAILED",
      "请求参数未通过校验。",
      422,
      fieldIssues(result.error, source)
    );
  }
  return result.data;
}

export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maximumBytes = DEFAULT_BODY_BYTES
): Promise<T> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new ApiContractError("BODY_TOO_LARGE", "请求体超过允许大小。", 413, [
      { field: "body", code: "TOO_BIG", message: "请求体超过允许大小。" }
    ]);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== "application/json" && !contentType.endsWith("+json")) {
    throw new ApiContractError("INVALID_CONTENT_TYPE", "请求体必须使用 JSON 内容类型。", 400, [
      { field: "headers.content-type", code: "INVALID_VALUE", message: "必须是 JSON 内容类型。" }
    ]);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new ApiContractError("BODY_TOO_LARGE", "请求体超过允许大小。", 413, [
      { field: "body", code: "TOO_BIG", message: "请求体超过允许大小。" }
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiContractError("INVALID_JSON", "请求体不是有效 JSON。", 400, [
      { field: "body", code: "INVALID_JSON", message: "JSON 语法无效。" }
    ]);
  }
  return parseDto(schema, value, "body");
}

export function parsePath<T>(schema: z.ZodType<T>, value: unknown): T {
  return parseDto(schema, value, "path");
}

export function parseQuery<T>(request: Request, schema: z.ZodType<T>): T {
  const entries: Record<string, string> = {};
  const params = new URL(request.url).searchParams;
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (values.length !== 1) {
      throw new ApiContractError("INVALID_QUERY", "查询参数格式无效。", 400, [
        { field: `query.${key}`, code: "DUPLICATE_FIELD", message: "参数不能重复。" }
      ]);
    }
    entries[key] = values[0]!;
  }
  try {
    return parseDto(schema, entries, "query");
  } catch (error) {
    if (error instanceof ApiContractError) {
      throw new ApiContractError("INVALID_QUERY", "查询参数未通过校验。", 400, error.issues);
    }
    throw error;
  }
}

export function parseHeaders<T>(
  request: Request,
  schema: z.ZodType<T>,
  fields: Record<string, string>
): T {
  const value = Object.fromEntries(
    Object.entries(fields).map(([field, header]) => [
      field,
      request.headers.get(header) ?? undefined
    ])
  );
  try {
    return parseDto(schema, value, "headers");
  } catch (error) {
    if (error instanceof ApiContractError) {
      throw new ApiContractError("INVALID_HEADERS", "请求头未通过校验。", 400, error.issues);
    }
    throw error;
  }
}

export const idempotencyHeadersSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema
});

export function parseIdempotencyHeaders(request: Request): { idempotencyKey: string } {
  return parseHeaders(request, idempotencyHeadersSchema, {
    idempotencyKey: "idempotency-key"
  });
}
