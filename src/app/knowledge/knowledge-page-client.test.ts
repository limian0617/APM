import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KnowledgePageClient } from "./knowledge-page-client";

const item = {
  entryCode: "KNW-1",
  version: 1,
  title: "安全复位",
  sanitizedSummary: "脱敏经验",
  experienceType: "LESSON_LEARNED",
  discipline: "MECHANICAL",
  keywords: ["复位"],
  applicableProjectTypes: ["LINE"],
  applicableStageCodes: ["S4"],
  status: "PUBLISHED"
};

describe("KnowledgePageClient", () => {
  it("renders only public search DTO fields and the confirmed degraded warning", () => {
    const markup = renderToStaticMarkup(
      createElement(KnowledgePageClient, {
        initialState: {
          status: "NORMAL",
          allowedActions: ["CREATE", "CONFIRM_REUSE", "CORRECT_REUSE"],
          capability: "DEGRADED",
          warningCode: "SEARCH_DEGRADED",
          items: [item]
        }
      })
    );
    expect(markup).toContain('data-state="NORMAL"');
    expect(markup).toContain("检索处于受限模式");
    expect(markup).toContain("安全复位");
    expect(markup).not.toMatch(/sourceProjectId|客户|issueHistory|archive/i);
    expect(markup).toContain("确认复用");
  });

  it.each(["LOADING", "EMPTY", "ERROR", "DENIED", "STALE"] as const)(
    "renders an accessible %s state",
    (status) => {
      const markup = renderToStaticMarkup(
        createElement(KnowledgePageClient, {
          initialState: {
            status,
            allowedActions: [],
            capability: null,
            warningCode: null,
            items: []
          }
        })
      );
      expect(markup).toContain(`data-state="${status}"`);
      expect(markup).toMatch(/role="(status|alert)"/);
    }
  );

  it("does not render actions not granted by server page state", () => {
    const markup = renderToStaticMarkup(
      createElement(KnowledgePageClient, {
        initialState: {
          status: "NORMAL",
          allowedActions: [],
          capability: "TRIGRAM",
          warningCode: null,
          items: [item]
        }
      })
    );
    expect(markup).not.toContain("创建知识草稿");
    expect(markup).not.toContain("确认复用");
  });
});
