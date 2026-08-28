import { NotificationValidationError } from "../domain/notification-policy";

export function notificationErrorResponse(error: unknown): Response | null {
  if (error instanceof NotificationValidationError) {
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
  if (error instanceof Error && error.message.startsWith("缺少邮件环境变量")) {
    return Response.json(
      { error: { code: "MAIL_UNAVAILABLE", message: "邮件服务尚未配置。" } },
      { status: 503 }
    );
  }
  return null;
}
