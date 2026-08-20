import { describe, expect, it, vi } from "vitest";

import type { JobExecution } from "@/modules/governance/contracts/jobs";

import { createArchiveGenerationHandler } from "./archive-generation-handler";

const job: JobExecution = {
  id: "generation-job-1",
  jobType: "archive.generate",
  payload: {
    projectId: "project-1",
    requestedById: "user-1",
    archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2"
  },
  payloadHash: "a".repeat(64),
  idempotencyKey: "archive-generate-project-1-v3",
  traceId: "b".repeat(32),
  attemptId: "attempt-1",
  attemptNumber: 1,
  maxAttempts: 3,
  isReplay: false,
  workerId: "worker-1"
};

describe("archive generation worker", () => {
  it("default-denies a missing formula before reading source facts", async () => {
    const readSources = vi.fn();
    const handler = createArchiveGenerationHandler({
      readSources,
      createVersion: vi.fn(),
      scheduleIntegrityCheck: vi.fn()
    });

    await expect(
      handler({ ...job, payload: { projectId: "project-1", requestedById: "user-1" } })
    ).rejects.toMatchObject({ code: "ARCHIVE_SOURCE_FORMULA_UNSUPPORTED" });
    expect(readSources).not.toHaveBeenCalled();
  });

  it("default-denies V2 generation when retrospective input facts cannot be read", async () => {
    const readSources = vi.fn();
    const createVersion = vi.fn();
    const handler = createArchiveGenerationHandler({
      readSources,
      createVersion,
      scheduleIntegrityCheck: vi.fn()
    });

    await expect(handler(job)).rejects.toMatchObject({
      code: "ARCHIVE_SOURCE_FACTS_UNAVAILABLE"
    });
    expect(readSources).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
  });

  it("creates one immutable version and schedules its first integrity check", async () => {
    const createVersion = vi.fn().mockResolvedValue({ id: "archive-version-1", version: 2 });
    const scheduleIntegrityCheck = vi.fn().mockResolvedValue(undefined);
    const handler = createArchiveGenerationHandler({
      readRetrospectiveInput: vi.fn().mockResolvedValue({
        snapshot: { formulaVersion: "RETROSPECTIVE.INPUT@1", project: { id: "project-1" } },
        watermark: "d".repeat(64)
      }),
      readSources: vi.fn().mockResolvedValue([
        {
          sourceType: "CONTROLLED_DOCUMENT_VERSION",
          sourceId: "doc-version-1",
          sourceVersion: "2",
          file: {
            id: "file-1",
            projectId: "project-1",
            status: "AVAILABLE",
            scannedAt: new Date("2026-08-11T00:00:00.000Z"),
            storageArea: "CONTROLLED",
            sha256: "c".repeat(64),
            mimeType: "application/pdf",
            size: 8
          },
          snapshotJson: { documentCode: "DOC-001" }
        }
      ]),
      createVersion,
      scheduleIntegrityCheck
    });

    await handler(job);

    expect(createVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        retrospectiveInput: expect.objectContaining({
          watermark: "d".repeat(64)
        }),
        generationJobId: "generation-job-1",
        projectId: "project-1",
        requestedById: "user-1",
        manifest: expect.objectContaining({
          items: [expect.objectContaining({ sourceId: "doc-version-1", sourceVersion: "2" })]
        })
      })
    );
    expect(scheduleIntegrityCheck).toHaveBeenCalledWith({
      projectId: "project-1",
      archiveVersionId: "archive-version-1",
      generationJobId: "generation-job-1"
    });
  });

  it("keeps V1 generation off the retrospective input path", async () => {
    const readRetrospectiveInput = vi.fn();
    const createVersion = vi.fn().mockResolvedValue({ id: "archive-version-v1", version: 1 });
    const handler = createArchiveGenerationHandler({
      readRetrospectiveInput,
      readSources: vi.fn().mockResolvedValue([]),
      createVersion,
      scheduleIntegrityCheck: vi.fn().mockResolvedValue(undefined)
    });

    await handler({
      ...job,
      payload: {
        projectId: "project-1",
        requestedById: "user-1",
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@1"
      }
    });

    expect(readRetrospectiveInput).not.toHaveBeenCalled();
    expect(createVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@1",
        retrospectiveInput: undefined
      })
    );
  });

  it("rejects a malformed generation payload before reading source facts", async () => {
    const readSources = vi.fn();
    const handler = createArchiveGenerationHandler({
      readSources,
      createVersion: vi.fn(),
      scheduleIntegrityCheck: vi.fn()
    });

    await expect(handler({ ...job, payload: { projectId: "project-1" } })).rejects.toThrow(
      "归档生成作业负载无效。"
    );
    expect(readSources).not.toHaveBeenCalled();
  });
});
