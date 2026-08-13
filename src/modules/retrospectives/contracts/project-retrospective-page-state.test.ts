import { describe, expect, it } from "vitest";

import { buildProjectRetrospectivePageState } from "./project-retrospective-page-state";

describe("project retrospective page state", () => {
  it("returns server-computed actions and exposes stale approval explicitly", () => {
    const state = buildProjectRetrospectivePageState({
      projectId: "project-1",
      archiveA: { id: "archive-a", status: "READY" },
      currentVersion: { id: "version-2", status: "DRAFT" },
      latestApprovedVersion: { id: "version-1", status: "APPROVED" },
      archiveB: null,
      closurePolicy: { id: "policy-version-1", status: "ACTIVE" },
      canCreate: true,
      canSubmit: true,
      canReview: true,
      canGenerateArchiveB: true,
      canRunG9: true,
      canClose: false
    });
    expect(state.status).toBe("STALE");
    expect(state.allowedActions).toContain("SUBMIT");
    expect(state.allowedActions).not.toContain("GENERATE_ARCHIVE_B");
    expect(state.allowedActions).not.toContain("REVIEW");
    expect(state).not.toHaveProperty("contentChecksumInput");
  });

  it("returns EMPTY with only CREATE when no retrospective exists", () => {
    const state = buildProjectRetrospectivePageState({
      projectId: "project-1",
      archiveA: { id: "archive-a", status: "READY" },
      currentVersion: null,
      latestApprovedVersion: null,
      archiveB: null,
      closurePolicy: null,
      canCreate: true,
      canSubmit: false,
      canReview: false,
      canGenerateArchiveB: false,
      canRunG9: false,
      canClose: false
    });
    expect(state.status).toBe("EMPTY");
    expect(state.allowedActions).toEqual(["CREATE"]);
  });

  it("fails closed for B/G9/close actions when any frozen source fact is unavailable", () => {
    const state = buildProjectRetrospectivePageState({
      projectId: "project-1",
      archiveA: null,
      currentVersion: { id: "version-1", status: "APPROVED" },
      latestApprovedVersion: { id: "version-1", status: "APPROVED" },
      archiveB: { id: "archive-b", status: "READY" },
      closurePolicy: null,
      canCreate: true,
      canSubmit: true,
      canReview: true,
      canGenerateArchiveB: true,
      canRunG9: true,
      canClose: true
    });

    expect(state.allowedActions).not.toContain("GENERATE_ARCHIVE_B");
    expect(state.allowedActions).not.toContain("RUN_G9");
    expect(state.allowedActions).not.toContain("CLOSE_PROJECT");
  });
});
