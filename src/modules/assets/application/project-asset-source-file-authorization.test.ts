import { describe, expect, it, vi } from "vitest";

import { ProjectAssetUsageError } from "@/modules/assets/domain/project-asset-usage";
import type { AuthorizationActor } from "@/lib/auth/authorize";

import {
  assertSensitiveFileReadAuthorized,
  assertSourceFilesAvailableAndAuthorized,
  assertSourceFilesSensitiveReadAuthorized
} from "./project-asset-usage-service";

const actor: AuthorizationActor = {
  id: "actor-1",
  name: "Engineer",
  status: "ACTIVE" as const,
  departmentId: "target-department",
  systemRoles: [],
  grants: [{ permission: "SENSITIVE_FILE_READ", scope: "PROJECT", systemRole: "ENGINEER" }]
};
const sha = (value: string) => value.repeat(64).slice(0, 64);

function client(input: {
  component?: Record<string, unknown>;
  files?: Record<string, Record<string, unknown> | null>;
}) {
  const component = {
    sourceProjectId: "source-project-1",
    sourceFileId: "main-file",
    sourceFileSha256: sha("a"),
    snapshotJson: { files: [] },
    ...input.component
  };
  return {
    assetComponentSnapshot: { findMany: vi.fn().mockResolvedValue([component]) },
    fileObject: {
      findFirst: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(input.files?.[where.id] ?? null)
      )
    }
  };
}

function file(input: Partial<Record<string, unknown>> = {}) {
  return {
    id: "main-file",
    projectId: "source-project-1",
    status: "AVAILABLE",
    sensitivity: "INTERNAL",
    sha256: sha("a"),
    uploadedById: "source-owner-1",
    project: {
      departmentId: "source-department",
      members: [{ projectRole: "ENGINEER" }]
    },
    ...input
  };
}

const accessInput = {
  technicalAssetId: "asset-1",
  assetReleaseVersionId: "version-1",
  authorizationActor: actor
};

describe("APM-063 exact release source-file authorization", () => {
  it("does not omit a component primary source file when snapshot files is empty", async () => {
    const transaction = client({
      files: {
        "main-file": file({ sensitivity: "RESTRICTED" })
      }
    });

    await expect(
      assertSourceFilesAvailableAndAuthorized(
        transaction as never,
        {
          ...accessInput,
          authorizationActor: { ...actor, grants: [] }
        } as never
      )
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_SENSITIVE_FILE_DENIED", status: 403 });
    expect(transaction.fileObject.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "main-file", projectId: "source-project-1" } })
    );
  });

  it("rejects unavailable or SHA-mismatched primary and attached frozen files", async () => {
    const primaryUnavailable = client({
      files: { "main-file": file({ status: "QUARANTINED" }) }
    });
    await expect(
      assertSourceFilesAvailableAndAuthorized(primaryUnavailable as never, accessInput as never)
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_SOURCE_FILE_UNAVAILABLE", status: 409 });

    const primaryHashMismatch = client({
      files: { "main-file": file({ sha256: sha("b") }) }
    });
    await expect(
      assertSourceFilesAvailableAndAuthorized(primaryHashMismatch as never, accessInput as never)
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_SOURCE_FILE_INVALID", status: 409 });

    const attachedHashMismatch = client({
      component: {
        snapshotJson: { files: [{ fileId: "attached-file", sha256: sha("c") }] }
      },
      files: {
        "main-file": file(),
        "attached-file": file({ id: "attached-file", sha256: sha("d") })
      }
    });
    await expect(
      assertSourceFilesAvailableAndAuthorized(attachedHashMismatch as never, accessInput as never)
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_SOURCE_FILE_INVALID", status: 409 });
  });

  it("does not let a target-project-sensitive grant authorize an unrelated source project", async () => {
    const transaction = client({
      files: {
        "main-file": file({
          sensitivity: "RESTRICTED",
          project: { departmentId: "source-department", members: [] }
        })
      }
    });

    await expect(
      assertSourceFilesAvailableAndAuthorized(transaction as never, accessInput as never)
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_SENSITIVE_FILE_DENIED", status: 403 });
  });

  it("uses each actual file's project, department, owner and membership context", () => {
    const targetRestricted = file({
      projectId: "target-project-1",
      uploadedById: "target-owner-1",
      sensitivity: "RESTRICTED",
      project: { departmentId: "target-department", members: [{ projectRole: "ENGINEER" }] }
    });
    expect(() => assertSensitiveFileReadAuthorized(targetRestricted, actor)).not.toThrow();

    const departmentActor: AuthorizationActor = {
      ...actor,
      departmentId: "source-department",
      grants: [{ permission: "SENSITIVE_FILE_READ", scope: "DEPARTMENT", systemRole: "ENGINEER" }]
    };
    expect(() =>
      assertSensitiveFileReadAuthorized(file({ sensitivity: "RESTRICTED" }), departmentActor)
    ).not.toThrow();
    expect(() =>
      assertSensitiveFileReadAuthorized(
        file({
          sensitivity: "RESTRICTED",
          project: { departmentId: "other-department", members: [{ projectRole: "ENGINEER" }] }
        }),
        departmentActor
      )
    ).toThrow(ProjectAssetUsageError);

    const ownerActor: AuthorizationActor = {
      ...actor,
      grants: [{ permission: "SENSITIVE_FILE_READ", scope: "SELF", systemRole: "ENGINEER" }]
    };
    expect(() =>
      assertSensitiveFileReadAuthorized(
        file({ sensitivity: "RESTRICTED", uploadedById: "actor-1" }),
        ownerActor
      )
    ).not.toThrow();
    expect(() =>
      assertSensitiveFileReadAuthorized(file({ sensitivity: "RESTRICTED" }), ownerActor)
    ).toThrow(ProjectAssetUsageError);
  });

  it("keeps later file availability out of retirement authorization but denies restricted sources", async () => {
    const unavailableInternal = client({
      files: { "main-file": file({ status: "QUARANTINED" }) }
    });
    await expect(
      assertSourceFilesSensitiveReadAuthorized(unavailableInternal as never, accessInput as never)
    ).resolves.toBeUndefined();

    const restricted = client({
      files: { "main-file": file({ sensitivity: "RESTRICTED" }) }
    });
    await expect(
      assertSourceFilesSensitiveReadAuthorized(
        restricted as never,
        {
          ...accessInput,
          authorizationActor: { ...actor, grants: [] }
        } as never
      )
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_SENSITIVE_FILE_DENIED", status: 403 });
  });
});
