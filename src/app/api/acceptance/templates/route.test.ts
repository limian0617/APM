import { beforeEach, describe, expect, it, vi } from "vitest";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const acceptanceService = vi.hoisted(() => ({ createAcceptanceTemplateVersion: vi.fn() }));

vi.mock("@/lib/auth/system-guard", () => systemGuard);
vi.mock("@/modules/acceptance/application/acceptance-service", () => acceptanceService);
vi.mock("@/modules/platform-api/application/idempotent-command", () => ({
  idempotentCommandResponse: async (input: {
    execute: (transaction: unknown) => Promise<{ status: number; body: unknown }>;
  }) => {
    const result = await input.execute(undefined);
    return Response.json(result.body, { status: result.status });
  }
}));

import { POST } from "./route";

const templateBody = {
  code: "FAT.POWER",
  name: "上电验收",
  acceptanceType: "FAT",
  items: [
    {
      code: "POWER",
      name: "上电",
      position: 1,
      method: "观察",
      acceptanceCriteria: "正常",
      unit: "V",
      required: true,
      evidenceRequired: false,
      applicableScope: "PROJECT",
      defaultDiscipline: "电气"
    }
  ]
};

describe("POST global acceptance templates", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    acceptanceService.createAcceptanceTemplateVersion.mockReset();
  });

  it("requires CONFIGURATION_WRITE and never accepts a client checksum", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "configuration-writer" }
    });
    acceptanceService.createAcceptanceTemplateVersion.mockResolvedValue({
      templateVersion: { id: "template-version-1", snapshotChecksum: "sha256:server" }
    });

    const response = await POST(
      new Request("http://localhost/api/acceptance/templates", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "template-key-1" },
        body: JSON.stringify({ ...templateBody, checksum: "sha256:tampered" })
      })
    );

    expect(response.status).toBe(422);
    expect(systemGuard.authorizeSystemRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "CONFIGURATION_WRITE",
      "ACCEPTANCE_TEMPLATE",
      "FAT.POWER"
    );
    expect(acceptanceService.createAcceptanceTemplateVersion).not.toHaveBeenCalled();
  });

  it("passes a checksum-free template content to the global application command", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "configuration-writer" }
    });
    acceptanceService.createAcceptanceTemplateVersion.mockResolvedValue({
      templateVersion: { id: "template-version-1", snapshotChecksum: "sha256:server" }
    });

    const response = await POST(
      new Request("http://localhost/api/acceptance/templates", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "template-key-2" },
        body: JSON.stringify(templateBody)
      })
    );

    expect(response.status).toBe(201);
    expect(acceptanceService.createAcceptanceTemplateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "configuration-writer",
        template: templateBody
      }),
      undefined
    );
  });
});
