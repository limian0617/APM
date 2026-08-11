import { describe, expect, it, vi } from "vitest";

import type { JobExecution } from "@/modules/governance/contracts/jobs";

import { createArchiveGenerationHandler } from "./archive-generation-handler";

const job: JobExecution = {
  id: "generation-job-1",
  jobType: "archive.generate",
  payload: { projectId: "project-1", requestedById: "user-1" },
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
  it("creates one immutable version and schedules its first integrity check", async () => {
    const createVersion = vi.fn().mockResolvedValue({ id: "archive-version-1", version: 2 });
    const scheduleIntegrityCheck = vi.fn().mockResolvedValue(undefined);
    const handler = createArchiveGenerationHandler({
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
