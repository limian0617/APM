import { describe, expect, it } from "vitest";

import {
  NotificationValidationError,
  renderNotificationTemplate,
  validateTargetPath,
  validateTemplateDefinition
} from "./notification-policy";

describe("notification template policy", () => {
  const schema = {
    owner: { type: "string", required: true },
    count: { type: "number", required: true }
  };

  it("renders validated text and escapes variables in HTML", () => {
    expect(
      renderNotificationTemplate({
        subjectTemplate: "{{owner}} has {{count}} tasks",
        bodyTextTemplate: "Owner: {{owner}}",
        bodyHtmlTemplate: "<b>{{owner}}</b>",
        variableSchema: schema,
        variables: { owner: "<Alice>", count: 2 }
      })
    ).toEqual({
      subject: "<Alice> has 2 tasks",
      bodyText: "Owner: <Alice>",
      bodyHtml: "<b>&lt;Alice&gt;</b>"
    });
  });

  it("rejects missing, mistyped, and undeclared variables", () => {
    const base = {
      subjectTemplate: "{{owner}}",
      bodyTextTemplate: "{{count}}",
      bodyHtmlTemplate: null,
      variableSchema: schema
    };
    expect(() => renderNotificationTemplate({ ...base, variables: { owner: "A" } })).toThrowError(
      NotificationValidationError
    );
    expect(() =>
      renderNotificationTemplate({ ...base, variables: { owner: "A", count: "2" } })
    ).toThrow("必须是 number");
    expect(() =>
      renderNotificationTemplate({ ...base, variables: { owner: "A", count: 2, secret: true } })
    ).toThrow("未声明字段");
  });

  it("rejects placeholders missing from the immutable schema", () => {
    expect(() =>
      validateTemplateDefinition({
        subjectTemplate: "{{unknown}}",
        bodyTextTemplate: "body",
        variableSchema: schema
      })
    ).toThrow("不存在的变量 unknown");
  });

  it("allows only internal relative navigation targets", () => {
    expect(validateTargetPath("/projects/one/issues")).toBe("/projects/one/issues");
    expect(() => validateTargetPath("https://example.com")).toThrow("站内相对路径");
    expect(() => validateTargetPath("//example.com")).toThrow("站内相对路径");
  });
});
