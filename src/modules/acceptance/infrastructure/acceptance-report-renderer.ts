import { createHash } from "node:crypto";

import type { AcceptanceReportSnapshot } from "../domain/acceptance-report-policy";

export const ACCEPTANCE_REPORT_RENDERER_VERSION = "apm-102-pdf-v1";

export class AcceptanceReportPdfIntegrityError extends Error {
  readonly code = "ACCEPTANCE_REPORT_PDF_HASH_MISMATCH";

  constructor() {
    super("最终 PDF 字节哈希与受控文档元数据不一致，不能发布验收报告。");
    this.name = "AcceptanceReportPdfIntegrityError";
  }
}

function pdfHex(value: unknown): string {
  const text = String(value ?? "");
  const bytes = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    bytes.writeUInt16BE(text.charCodeAt(index), index * 2);
  }
  return `<${bytes.toString("hex")}>`;
}

/**
 * A deliberately small, deterministic PDF renderer. It is a controlled presentation of the
 * server-frozen snapshot; it is not a legal-signature renderer.
 */
export function renderAcceptanceReportPdf(input: {
  snapshot: AcceptanceReportSnapshot;
  reportNumber: string;
  reportVersion: number;
  snapshotChecksum: string;
  controlledDocumentVersion: { code: string; version: number };
}): Uint8Array {
  const lines = [
    `APM FAT/SAT ACCEPTANCE REPORT ${input.reportNumber} v${input.reportVersion}`,
    `ControlledDocumentVersion ${input.controlledDocumentVersion.code} v${input.controlledDocumentVersion.version}`,
    `PROJECT ${input.snapshot.project.code} ${input.snapshot.project.name}`,
    `TYPE ${input.snapshot.batch.acceptanceType} SCOPE ${input.snapshot.batch.scopeType}:${input.snapshot.batch.scopeId}`,
    `FROZEN_AT ${input.snapshot.frozenAt}`,
    `GENERATED_AT ${input.snapshot.frozenAt}`,
    `RENDERER_VERSION ${input.snapshot.rendererVersion}`,
    `SNAPSHOT_SHA256 ${input.snapshotChecksum}`,
    "最终PDF完整SHA-256以APM受控文档元数据和下载审计为准。",
    "确认凭证仅作为项目验收证据，不等同于法律电子签名。",
    `SUMMARY PASS=${input.snapshot.summary.passCount} FAIL=${input.snapshot.summary.failCount} NA=${input.snapshot.summary.naCount} RATE=${input.snapshot.summary.passRate ?? "NOT_CALCULABLE"}`,
    ...input.snapshot.items.map(
      (item) =>
        `${item.position}. ${item.code} ${item.name} [${item.decision ?? "PENDING"}] ${item.measuredValue ?? ""} ${item.measuredUnit ?? item.unit ?? ""}`
    )
  ];
  const pageLines = 48;
  const pages = Array.from(
    { length: Math.max(1, Math.ceil(lines.length / pageLines)) },
    (_, page) => lines.slice(page * pageLines, (page + 1) * pageLines)
  );
  const pageIds = pages.map((_, index) => 3 + index);
  const contentIds = pages.map((_, index) => 3 + pages.length + index);
  const fontId = 3 + pages.length * 2;
  const descendantFontId = fontId + 1;
  const pageObjects = pages.map((page, index) => {
    const stream = [
      "BT",
      "/F1 9 Tf",
      "50 780 Td",
      ...page.map((line, lineIndex) => {
        const prefix = lineIndex === 0 ? "" : "0 -14 Td ";
        return `${prefix}${pdfHex(line)} Tj`;
      }),
      "ET"
    ].join("\n");
    return {
      page: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
      content: `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
    };
  });
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pageObjects.flatMap((object) => [object.page, object.content]),
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [" +
      descendantFontId +
      " 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "utf8"));
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertFinalPdfHashIntegrity(input: {
  pdf: Uint8Array;
  acceptanceReportPdfSha256: string;
  fileObjectSha256: string;
}): string {
  const calculatedPdfSha256 = sha256Bytes(input.pdf);
  if (
    calculatedPdfSha256 !== input.acceptanceReportPdfSha256 ||
    calculatedPdfSha256 !== input.fileObjectSha256
  ) {
    throw new AcceptanceReportPdfIntegrityError();
  }
  return calculatedPdfSha256;
}
