import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  buildIssueCapturePayload,
  buildIssueConfirmationPayload,
  IssueCapturePageClient,
  issueCaptureStepLabel,
  uploadIssueCaptureFile
} from "./issue-capture-page-client";

describe("ISS-003 mobile issue capture page", () => {
  it("requires text or voice and keeps optional media separate", () => {
    expect(
      buildIssueCapturePayload({
        inputText: "  现场卡滞  ",
        voiceFileId: null,
        mediaFileIds: ["photo-1", "video-1"]
      })
    ).toEqual({ inputText: "现场卡滞", voiceFileId: null, mediaFileIds: ["photo-1", "video-1"] });
    expect(() =>
      buildIssueCapturePayload({ inputText: "", voiceFileId: null, mediaFileIds: [] })
    ).toThrow("请输入文字或选择语音。");
  });

  it("builds confirmed issue facts from the user's confirmation text", () => {
    expect(
      buildIssueConfirmationPayload({
        title: "输送带卡滞",
        confirmedText: "输送带在进入工位时卡滞。",
        category: "FUNCTION",
        severity: "HIGH",
        tags: "卡滞,现场"
      })
    ).toEqual({
      title: "输送带卡滞",
      confirmedText: "输送带在进入工位时卡滞。",
      category: "FUNCTION",
      severity: "HIGH",
      phenomenonDescription: "输送带在进入工位时卡滞。",
      rootCauseCategory: null,
      rootCauseDescription: null,
      tags: ["卡滞", "现场"]
    });
  });

  it("uses the completed server FileObject identity when an audio upload succeeds", async () => {
    const file = Object.assign(new Blob(["voice"], { type: "audio/wav" }), {
      name: "现场录音.wav"
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          upload: { sessionId: "upload-1", expectedParts: 1, partSize: 5 },
          file: { id: "file-voice-1" }
        })
      )
      .mockResolvedValueOnce(
        Response.json({ expectedSize: 5, uploadUrl: "https://object-storage.invalid/part" })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { etag: "part-etag" } }))
      .mockResolvedValueOnce(Response.json({ file: { id: "file-voice-1", status: "AVAILABLE" } }));

    await expect(
      uploadIssueCaptureFile({ projectId: "project-1", file, fetchImpl })
    ).resolves.toEqual({ fileId: "file-voice-1", status: "AVAILABLE" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/projects/project-1/files/uploads");
  });

  it("exposes a stable, linear mobile flow", () => {
    expect(issueCaptureStepLabel("capture")).toBe("录入素材");
    expect(issueCaptureStepLabel("confirm")).toBe("确认文字");
    expect(issueCaptureStepLabel("submitted")).toBe("已提交");
  });

  it("renders the project context and mobile capture controls", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueCapturePageClient, { projectId: "project/1" })
    );
    expect(markup).toContain("现场问题");
    expect(markup).toContain("文字、语音至少一项");
    expect(markup).toContain('accept="audio/*"');
    expect(markup).toContain('accept="image/*,video/*"');
    expect(markup).toContain("确认文字");
    expect(markup).toContain("项目 project/1");
  });
});
