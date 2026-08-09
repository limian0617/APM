import { describe, expect, it, vi } from "vitest";

import {
  acceptanceReportDownloadHref,
  uploadConfirmationEvidenceFile
} from "./acceptance-page-client";

describe("APM-102 confirmation-evidence upload", () => {
  it("uses the server-authorized report download API for the current project", () => {
    expect(acceptanceReportDownloadHref("project A", "report/1")).toBe(
      "/api/projects/project%20A/acceptance/reports/report%2F1/download"
    );
  });

  it("uses the existing restricted upload, signed-part, and completion contract", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      const url = String(input);
      if (url.endsWith("/files/uploads")) {
        return Response.json(
          {
            file: { id: "evidence-file-1" },
            upload: { sessionId: "upload-session-1", expectedParts: 1, partSize: 10 }
          },
          { status: 201 }
        );
      }
      if (url.endsWith("/parts/1")) {
        return Response.json(
          { partNumber: 1, expectedSize: 3, uploadUrl: "https://storage.example/upload-1" },
          { status: 200 }
        );
      }
      if (url === "https://storage.example/upload-1") {
        return new Response(null, { status: 200, headers: { etag: "etag-1" } });
      }
      if (url.endsWith("/complete")) {
        return Response.json({ file: { id: "evidence-file-1", status: "PENDING_SCAN" } });
      }
      return new Response(null, { status: 404 });
    });
    const file = Object.assign(new Blob(["pdf"], { type: "application/pdf" }), {
      name: "signed-fat.pdf"
    });

    await expect(
      uploadConfirmationEvidenceFile({ projectId: "project-1", file, fetchImpl })
    ).resolves.toEqual({ fileId: "evidence-file-1", status: "PENDING_SCAN" });

    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      originalName: "signed-fat.pdf",
      mimeType: "application/pdf",
      size: 3,
      sensitivity: "RESTRICTED"
    });
    expect(requests.map((request) => String(request.input))).toEqual([
      "/api/projects/project-1/files/uploads",
      "/api/projects/project-1/files/uploads/upload-session-1/parts/1",
      "https://storage.example/upload-1",
      "/api/projects/project-1/files/uploads/upload-session-1/complete"
    ]);
  });
});
