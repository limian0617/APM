import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import * as knowledgeUi from "./knowledge-page-client";
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
          items: [item],
          reuseContext: { reuseId: "reuse-1", version: 1 }
        }
      })
    );
    expect(markup).not.toContain("创建知识草稿");
    expect(markup).not.toContain("确认复用");
    expect(markup).not.toMatch(/entryId|versionId/);
  });

  it("builds only the strict server command contracts, including the public reuse selector", () => {
    const build = (knowledgeUi as Record<string, unknown>).buildKnowledgeCommandRequest;
    expect(build).toBeTypeOf("function");

    expect(
      (build as (input: any) => unknown)({
        action: "REUSE",
        targetProjectId: "target-project-1",
        targetDeliveryUnitId: null,
        entryCode: "KNW-1",
        version: 1,
        scenario: "上线调试采用。",
        evidenceSummary: "已完成现场确认。"
      })
    ).toEqual({
      endpoint: "/api/projects/target-project-1/knowledge-reuse",
      body: {
        targetDeliveryUnitId: null,
        entryCode: "KNW-1",
        version: 1,
        scenario: "上线调试采用。",
        evidenceSummary: "已完成现场确认。"
      }
    });

    expect(
      (build as (input: any) => unknown)({
        action: "PUBLISH",
        entryId: "author-entry-1",
        versionId: "author-version-1",
        expectedEntryVersion: 2,
        reason: "已完成知识产权和脱敏复核。"
      })
    ).toEqual({
      endpoint: "/api/knowledge/author-entry-1/versions/author-version-1/reviews",
      body: {
        expectedEntryVersion: 2,
        decision: "PUBLISH",
        reason: "已完成知识产权和脱敏复核。",
        ipConfirmed: true,
        sanitizationConfirmed: true
      }
    });
  });

  it("renders real form controls only for server-granted knowledge actions", () => {
    const markup = renderToStaticMarkup(
      createElement(KnowledgePageClient, {
        initialState: {
          status: "NORMAL",
          allowedActions: ["CREATE", "CONFIRM_REUSE", "CORRECT_REUSE"],
          capability: "TRIGRAM",
          warningCode: null,
          items: [item],
          reuseContext: { reuseId: "reuse-1", version: 1 }
        }
      })
    );

    expect(markup).toContain("知识编码");
    expect(markup).toContain("提交知识草稿");
    expect(markup).toContain("确认采用");
    expect(markup).toContain("提交更正");
    expect(markup).not.toMatch(/sourceProjectId|issueHistoryIds|finalArchiveVersionId/);
  });

  it("loads initial and search states exclusively from the server page-state without clearing allowed actions", async () => {
    const load = (knowledgeUi as Record<string, unknown>).loadKnowledgePageState;
    expect(load).toBeTypeOf("function");

    const initialFetcher = vi.fn(async () =>
      Response.json({
        pageState: { status: "EMPTY", allowedActions: ["CREATE"] },
        items: []
      })
    );
    const initial = await (load as (input: any) => Promise<any>)({
      fetcher: initialFetcher,
      query: "",
      targetProjectId: null,
      reuseId: null
    });

    expect(initialFetcher).toHaveBeenCalledWith("/api/knowledge?view=PAGE_STATE", {
      cache: "no-store"
    });
    expect(initial).toMatchObject({
      state: { status: "EMPTY", allowedActions: ["CREATE"], items: [] }
    });

    const search = await (load as (input: any) => Promise<any>)({
      fetcher: vi.fn(async () =>
        Response.json({
          pageState: { status: "NORMAL", allowedActions: ["CREATE", "CONFIRM_REUSE"] },
          capability: "DEGRADED",
          warningCode: "SEARCH_DEGRADED",
          items: [item]
        })
      ),
      query: "复位",
      targetProjectId: "target-project-1",
      reuseId: null
    });

    expect(search).toMatchObject({
      state: {
        status: "NORMAL",
        allowedActions: ["CREATE", "CONFIRM_REUSE"],
        capability: "DEGRADED",
        warningCode: "SEARCH_DEGRADED",
        items: [item]
      }
    });
  });

  it("requests server page-state once on initial mount and never synthesizes a later reload from typed input", () => {
    const shouldLoad = (knowledgeUi as Record<string, unknown>).shouldLoadInitialKnowledgeState;
    expect(shouldLoad).toBeTypeOf("function");
    expect(
      (shouldLoad as (input: any) => boolean)({ hasInitialState: false, hasLoaded: false })
    ).toBe(true);
    expect(
      (shouldLoad as (input: any) => boolean)({ hasInitialState: true, hasLoaded: false })
    ).toBe(false);
    expect(
      (shouldLoad as (input: any) => boolean)({ hasInitialState: false, hasLoaded: true })
    ).toBe(false);
  });

  it("recovers global knowledge state after a target-project context receives no write actions", async () => {
    const load = (knowledgeUi as Record<string, unknown>).loadKnowledgePageState;
    expect(load).toBeTypeOf("function");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          pageState: { status: "NORMAL", allowedActions: [], reuseContext: null },
          items: [item]
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          pageState: { status: "EMPTY", allowedActions: ["CREATE"], reuseContext: null },
          items: []
        })
      );

    await (load as (input: any) => Promise<any>)({
      fetcher,
      query: "复位",
      targetProjectId: "denied-target-project",
      reuseId: null
    });
    await (load as (input: any) => Promise<any>)({
      fetcher,
      query: "",
      targetProjectId: null,
      reuseId: null
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/knowledge?query=%E5%A4%8D%E4%BD%8D&targetProjectId=denied-target-project",
      { cache: "no-store" }
    );
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/knowledge?view=PAGE_STATE", {
      cache: "no-store"
    });
  });

  it("keeps server page-state actions after search and runs public-selector reuse only through the exact command endpoint", async () => {
    const execute = (knowledgeUi as Record<string, unknown>).executeKnowledgeCommand;
    expect(execute).toBeTypeOf("function");

    const reload = vi.fn(async () => undefined);
    const result = await (execute as (input: any) => Promise<any>)({
      fetcher: vi.fn(async () => Response.json({ id: "reuse-1" }, { status: 201 })),
      endpoint: "/api/projects/target-project-1/knowledge-reuse",
      body: {
        targetDeliveryUnitId: null,
        entryCode: "KNW-1",
        version: 1,
        scenario: "上线调试采用。",
        evidenceSummary: "已完成人工确认。"
      },
      idempotencyKey: "reuse-1",
      reload
    });

    expect(result).toMatchObject({ kind: "SUCCESS" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("uses the protected reuse response to reload the server page-state before correction", async () => {
    const contextFromPayload = (knowledgeUi as Record<string, unknown>).knowledgeReuseReloadContext;
    const load = (knowledgeUi as Record<string, unknown>).loadKnowledgePageState;
    expect(contextFromPayload).toBeTypeOf("function");
    expect(load).toBeTypeOf("function");

    const context = (
      contextFromPayload as (input: any) => {
        targetProjectId: string;
        reuseId: string;
      } | null
    )({
      targetProjectId: "target-project-1",
      payload: { id: "reuse-server-1", version: 1 }
    });
    expect(context).toEqual({ targetProjectId: "target-project-1", reuseId: "reuse-server-1" });

    const fetcher = vi.fn(async () =>
      Response.json({
        pageState: {
          status: "NORMAL",
          allowedActions: ["CORRECT_REUSE"],
          reuseContext: { reuseId: "reuse-server-1", version: 2 }
        },
        items: [item]
      })
    );
    const pageState = await (load as (input: any) => Promise<any>)({
      fetcher,
      query: "复位",
      ...(context as { targetProjectId: string; reuseId: string })
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/knowledge?query=%E5%A4%8D%E4%BD%8D&targetProjectId=target-project-1&reuseId=reuse-server-1",
      { cache: "no-store" }
    );
    expect(pageState.state.reuseContext).toEqual({ reuseId: "reuse-server-1", version: 2 });
  });

  it("derives protected authoring actions and 409 recovery from structured server facts", () => {
    const authoringActions = (knowledgeUi as Record<string, unknown>).knowledgeAuthoringActions;
    const recovery = (knowledgeUi as Record<string, unknown>).knowledgeCommandRecovery;
    expect(authoringActions).toBeTypeOf("function");
    expect(recovery).toBeTypeOf("function");

    expect((authoringActions as (input: any) => unknown)({ status: "DRAFT" })).toEqual(["SUBMIT"]);
    expect((authoringActions as (input: any) => unknown)({ status: "IN_REVIEW" })).toEqual([
      "PUBLISH"
    ]);
    expect((authoringActions as (input: any) => unknown)({ status: "PUBLISHED" })).toEqual([]);
    expect(
      (recovery as (input: any) => unknown)({
        operation: "knowledge-reuse",
        result: {
          kind: "CONFLICT",
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "同一键已用于不同请求。",
          preserveInput: true,
          idempotencyKey: "old-key",
          payload: null
        }
      })
    ).toEqual({ show: true, canDiscardIdempotencyKey: true });
  });

  it.each(["PUBLISHED", "REJECTED"] as const)(
    "uses the real protected review response for %s as a terminal read-only authoring state",
    (status) => {
      const applyAuthoringResponse = (knowledgeUi as Record<string, unknown>)
        .applyKnowledgeAuthoringResponse;
      const contextFromPayload = (knowledgeUi as Record<string, unknown>)
        .knowledgeAuthoringContextFromPayload;
      const authoringActions = (knowledgeUi as Record<string, unknown>).knowledgeAuthoringActions;
      const reviewResponse = {
        entryId: "author-entry-1",
        versionId: "author-version-1",
        entryVersion: 6,
        status,
        reviewId: "review-1",
        auditId: "audit-1",
        outboxEventId: "outbox-1"
      };

      expect(applyAuthoringResponse).toBeTypeOf("function");
      expect(contextFromPayload).toBeTypeOf("function");
      const context = (
        applyAuthoringResponse as (input: { current: unknown; payload: unknown }) => unknown
      )({
        current: {
          entryId: "author-entry-1",
          versionId: "author-version-1",
          expectedEntryVersion: 5,
          status: "IN_REVIEW"
        },
        payload: reviewResponse
      });
      expect(context).toEqual({
        entryId: "author-entry-1",
        versionId: "author-version-1",
        expectedEntryVersion: 6,
        status
      });
      expect((authoringActions as (input: unknown) => unknown)(context)).toEqual([]);
    }
  );

  it("does not require a manually entered internal reuse ID or reuse version", () => {
    const markup = renderToStaticMarkup(
      createElement(KnowledgePageClient, {
        initialState: {
          status: "NORMAL",
          allowedActions: ["CORRECT_REUSE"],
          capability: "TRIGRAM",
          warningCode: null,
          items: [item],
          reuseContext: { reuseId: "reuse-server-1", version: 2 }
        } as any
      })
    );

    expect(markup).toContain("提交更正");
    expect(markup).not.toContain("已有复用记录（更正时填写）");
    expect(markup).not.toContain("当前记录版本");
  });

  it.each([
    [403, "DENIED"],
    [503, "UNAVAILABLE"]
  ])("maps command HTTP %i to %s without clearing user input", async (status, kind) => {
    const execute = (knowledgeUi as Record<string, unknown>).executeKnowledgeCommand;
    expect(execute).toBeTypeOf("function");

    const draft = { entryCode: "KNW-1", version: 1 };
    const result = await (execute as (input: any) => Promise<any>)({
      fetcher: vi.fn(async () =>
        Response.json({ error: { code: "SERVER_CODE", message: "服务端拒绝。" } }, { status })
      ),
      endpoint: "/api/projects/target-project-1/knowledge-reuse",
      body: draft,
      idempotencyKey: "reuse-2",
      reload: vi.fn(async () => undefined)
    });

    expect(result).toMatchObject({ kind, preserveInput: true, idempotencyKey: "reuse-2" });
  });
});
