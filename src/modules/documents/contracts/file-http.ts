import { FileValidationError } from "../domain/file-policy";

export function fileErrorResponse(error: unknown): Response | null {
  if (error instanceof FileValidationError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "请求体不是有效 JSON。" } },
      { status: 400 }
    );
  }
  if (error instanceof Error && error.message.startsWith("缺少对象存储环境变量")) {
    return Response.json(
      { error: { code: "OBJECT_STORAGE_UNAVAILABLE", message: "对象存储尚未配置。" } },
      { status: 503 }
    );
  }
  return null;
}
