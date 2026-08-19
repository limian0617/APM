import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import * as retrospectiveUi from "./retrospective-page-client";
import { RetrospectivePageClient } from "./retrospective-page-client";

const base = {
  projectId: "project-1",
  projectStatus: "IN_PROGRESS",
  projectVersion: 3,
  aggregateVersion: 2,
  status: "NORMAL" as const,
  allowedActions: ["CREATE", "SUBMIT", "REVIEW", "GENERATE_ARCHIVE_B", "RUN_G9", "CLOSE_PROJECT"],
  archiveA: {
    id: "archive-a",
    status: "READY",
    manifestChecksum: "a-manifest",
    sourceWatermark: "a-source",
    retrospectiveInputWatermark: "a-input"
  },
  archiveB: {
    id: "archive-b",
    status: "READY",
    manifestChecksum: "b-manifest",
    sourceWatermark: "b-source",
    retrospectiveInputWatermark: "b-input"
  },
  currentVersion: { id: "current", status: "IN_REVIEW" },
  latestApprovedVersion: { id: "approved", status: "APPROVED" },
  g9Approval: null,
  g9Workflow: null
};

describe("RetrospectivePageClient", () => {
  it("renders exact server-provided governance facts, stale pointer and blockers without inferring closure eligibility", () => {
    const markup = renderToStaticMarkup(
      createElement(RetrospectivePageClient, { projectId: "project-1", initialState: base })
    );
    expect(markup).toContain('data-state="NORMAL"');
    expect(markup).toContain("a-manifest");
    expect(markup).toContain("b-source");
    expect(markup).toContain("当前版本与已批准版本不一致");
    expect(markup).toContain("G9 尚未获得批准");
    expect(markup).toContain("创建复盘");
    expect(markup).toContain("提交复盘");
    expect(markup).toContain("审核复盘");
    expect(markup).not.toContain("关闭项目</button>");
  });

  it.each(["LOADING", "EMPTY", "ERROR", "DENIED", "STALE"] as const)(
    "renders an accessible %s state",
    (status) => {
      const markup = renderToStaticMarkup(
        createElement(RetrospectivePageClient, {
          projectId: "project-1",
          initialState: {
            ...base,
            status,
            allowedActions: [],
            archiveA: status === "EMPTY" ? base.archiveA : null,
            archiveB: null,
            currentVersion: null,
            latestApprovedVersion: null
          }
        })
      );
      expect(markup).toContain(`data-state="${status}"`);
      expect(markup).toMatch(/role="(status|alert)"/);
    }
  );

  it("suppresses write controls on closed projects while retaining an explanatory status", () => {
    const markup = renderToStaticMarkup(
      createElement(RetrospectivePageClient, {
        projectId: "project-1",
        initialState: { ...base, projectStatus: "CLOSED" }
      })
    );
    expect(markup).toContain("项目已关闭，复盘事实不可再修改。");
    expect(markup).not.toContain("提交复盘</button>");
  });

  it("posts a strict retrospective command with an idempotency key and refreshes actual server state only after 2xx", async () => {
    const execute = (retrospectiveUi as Record<string, unknown>).executeRetrospectiveCommand;
    expect(execute).toBeTypeOf("function");

    const fetcher = vi.fn(async () => Response.json({ id: "job-1" }, { status: 202 }));
    const reload = vi.fn(async () => undefined);
    const result = await (execute as (input: any) => Promise<any>)({
      fetcher,
      endpoint: "/api/projects/project-1/archive/generate",
      body: { version: 9 },
      idempotencyKey: "archive-b-1",
      reload
    });

    expect(fetcher).toHaveBeenCalledWith("/api/projects/project-1/archive/generate", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "archive-b-1" },
      body: JSON.stringify({ version: 9 })
    });
    expect(result).toMatchObject({ kind: "SUCCESS" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("executeRetrospectiveCommand invokes a receiver-sensitive fetcher with globalThis", async () => {
    const execute = (retrospectiveUi as Record<string, unknown>).executeRetrospectiveCommand;
    expect(execute).toBeTypeOf("function");

    let observedThis: unknown;
    let reloadCount = 0;
    async function receiverSensitiveFetcher(
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) {
      observedThis = this;
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Response.json({ id: "job-receiver-1" }, { status: 202 });
    }
    const result = await (execute as (input: any) => Promise<any>)({
      fetcher: receiverSensitiveFetcher,
      endpoint: "/api/projects/project-1/retrospectives",
      body: { archiveVersionId: "archive-a" },
      idempotencyKey: "retrospective-create-1",
      reload: async () => {
        reloadCount += 1;
      }
    });

    expect(result.kind).toBe("SUCCESS");
    expect(observedThis).toBe(globalThis);
    expect(reloadCount).toBe(1);
  });

  it("keeps command input and idempotency context on a 409 while exposing refresh and resubmit choices", async () => {
    const execute = (retrospectiveUi as Record<string, unknown>).executeRetrospectiveCommand;
    expect(execute).toBeTypeOf("function");

    const draft = { expectedAggregateVersion: 2 };
    const reload = vi.fn(async () => undefined);
    const result = await (execute as (input: any) => Promise<any>)({
      fetcher: vi.fn(async () =>
        Response.json(
          { error: { code: "RETROSPECTIVE_VERSION_CONFLICT", message: "项目已变化，请刷新。" } },
          { status: 409 }
        )
      ),
      endpoint: "/api/projects/project-1/retrospectives/version-1/submit",
      body: draft,
      idempotencyKey: "submit-1",
      reload
    });

    expect(result).toMatchObject({
      kind: "CONFLICT",
      code: "RETROSPECTIVE_VERSION_CONFLICT",
      preserveInput: true,
      idempotencyKey: "submit-1"
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("offers conflict recovery for every 409 without parsing an error-code display string", () => {
    const recovery = (retrospectiveUi as Record<string, unknown>).retrospectiveCommandRecovery;
    expect(recovery).toBeTypeOf("function");

    expect(
      (recovery as (input: any) => unknown)({
        operation: "retrospective-submit",
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

  it("renders only the server-ready G9 step and requires its strict command reason", () => {
    const markup = renderToStaticMarkup(
      createElement(RetrospectivePageClient, {
        projectId: "project-1",
        initialState: {
          ...base,
          currentVersion: { id: "approved", status: "APPROVED" },
          latestApprovedVersion: { id: "approved", status: "APPROVED" },
          g9Workflow: {
            instanceId: "g9-instance-1",
            instanceVersion: 4,
            submission: null,
            canRunChecks: false,
            canSubmit: true,
            canApprove: false
          }
        }
      })
    );

    expect(markup).toContain("提交 G9");
    expect(markup).toContain("G9 提交理由");
    expect(markup).not.toContain("运行 G9 检查</button>");
  });
});
