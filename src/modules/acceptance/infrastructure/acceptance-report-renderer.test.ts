import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAcceptanceReportSnapshot,
  calculateSnapshotChecksum
} from "../domain/acceptance-report-policy";
import {
  ACCEPTANCE_REPORT_RENDERER_VERSION,
  AcceptanceReportPdfIntegrityError,
  assertFinalPdfHashIntegrity,
  renderAcceptanceReportPdf,
  sha256Bytes
} from "./acceptance-report-renderer";

function pdfContainsEncodedText(pdf: Uint8Array, text: string): boolean {
  const bytes = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    bytes.writeUInt16BE(text.charCodeAt(index), index * 2);
  }
  return Buffer.from(pdf).toString("utf8").includes(bytes.toString("hex"));
}

describe("APM-102 controlled report renderer", () => {
  it("renders a deterministic controlled PDF with separate snapshot and document-version facts", () => {
    const snapshot = buildAcceptanceReportSnapshot({
      project: { id: "project-1", name: "验收项目", code: "APM-001" },
      batch: { id: "batch-1", acceptanceType: "FAT", scopeType: "PROJECT", scopeId: "project-1" },
      template: { id: "template-1", version: 1, checksum: "a".repeat(64) },
      items: [
        {
          code: "POWER",
          position: 1,
          name: "上电检查",
          method: "观察",
          acceptanceCriteria: "正常上电",
          unit: "V",
          required: true,
          decision: "PASS",
          measuredValue: "230",
          measuredUnit: "V",
          note: null,
          resultRevisionId: "revision-1",
          evidence: []
        }
      ],
      issues: [],
      gate: { status: "PASSED", warnings: [], residualItemIds: [] },
      retestOfBatchId: null,
      frozenAt: "2026-08-09T10:00:00.000Z",
      rendererVersion: ACCEPTANCE_REPORT_RENDERER_VERSION
    });
    const bytes = renderAcceptanceReportPdf({
      snapshot,
      reportNumber: "APM-FAT-batch-1",
      reportVersion: 1,
      snapshotChecksum: calculateSnapshotChecksum(snapshot),
      controlledDocumentVersion: {
        code: "ACCEPTANCE-FAT-batch-1",
        version: 1
      }
    });
    const output = Buffer.from(bytes).toString("utf8");
    expect(output.startsWith("%PDF-1.4")).toBe(true);
    expect(output).toContain("<786e8ba451ed8bc1");
    expect(pdfContainsEncodedText(bytes, "SNAPSHOT_SHA256")).toBe(true);
    expect(
      pdfContainsEncodedText(bytes, "ControlledDocumentVersion ACCEPTANCE-FAT-batch-1 v1")
    ).toBe(true);
    expect(pdfContainsEncodedText(bytes, "GENERATED_AT 2026-08-09T10:00:00.000Z")).toBe(true);
    expect(
      pdfContainsEncodedText(bytes, `RENDERER_VERSION ${ACCEPTANCE_REPORT_RENDERER_VERSION}`)
    ).toBe(true);
    expect(
      pdfContainsEncodedText(bytes, "最终PDF完整SHA-256以APM受控文档元数据和下载审计为准。")
    ).toBe(true);
    expect(pdfContainsEncodedText(bytes, "PDF_SHA256")).toBe(false);
    expect(sha256Bytes(bytes)).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256Bytes(bytes)).not.toBe(calculateSnapshotChecksum(snapshot));
    const outputPath = process.env.APM_RENDERER_OUTPUT;
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, bytes);
    }
  });

  it("accepts publication only when final PDF bytes and both persisted hashes match", () => {
    const pdf = new Uint8Array([37, 80, 68, 70]);
    const finalPdfSha256 = sha256Bytes(pdf);

    expect(
      assertFinalPdfHashIntegrity({
        pdf,
        acceptanceReportPdfSha256: finalPdfSha256,
        fileObjectSha256: finalPdfSha256
      })
    ).toBe(finalPdfSha256);
    let metadataMismatch: unknown;
    try {
      assertFinalPdfHashIntegrity({
        pdf,
        acceptanceReportPdfSha256: finalPdfSha256,
        fileObjectSha256: "0".repeat(64)
      });
    } catch (error) {
      metadataMismatch = error;
    }
    expect(metadataMismatch).toMatchObject({
      code: "ACCEPTANCE_REPORT_PDF_HASH_MISMATCH"
    });
    expect(() =>
      assertFinalPdfHashIntegrity({
        pdf: new Uint8Array([37, 80, 68, 71]),
        acceptanceReportPdfSha256: finalPdfSha256,
        fileObjectSha256: finalPdfSha256
      })
    ).toThrow(AcceptanceReportPdfIntegrityError);
  });
});
