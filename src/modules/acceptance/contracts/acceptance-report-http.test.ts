import { describe, expect, it } from "vitest";

import {
  createAcceptanceConfirmationBodySchema,
  generateAcceptanceReportBodySchema
} from "./acceptance-report-http";

describe("APM-102 acceptance report HTTP contracts", () => {
  it("accepts only a server-controlled report generation request", () => {
    expect(
      generateAcceptanceReportBodySchema.parse({
        batchId: "batch-1",
        supersedesReportId: null,
        version: 4
      })
    ).toEqual({ batchId: "batch-1", supersedesReportId: null, version: 4 });

    expect(() =>
      generateAcceptanceReportBodySchema.parse({
        batchId: "batch-1",
        snapshotChecksum: "client-controlled"
      })
    ).toThrow();
  });

  it("requires an exact report checksum and at least one evidence file for confirmation", () => {
    expect(
      createAcceptanceConfirmationBodySchema.parse({
        version: 2,
        reportChecksum: "a".repeat(64),
        decision: "ACCEPTED_WITH_RESERVATIONS",
        customerOrganization: "客户公司",
        customerRepresentative: "王工",
        representativeTitle: "项目负责人",
        confirmationChannel: "SIGNED_DOCUMENT",
        customerConfirmedAt: "2026-08-09T09:00:00.000Z",
        comment: "保留项已确认",
        evidenceFileIds: ["file-1"]
      })
    ).toMatchObject({ decision: "ACCEPTED_WITH_RESERVATIONS", evidenceFileIds: ["file-1"] });

    expect(() =>
      createAcceptanceConfirmationBodySchema.parse({
        version: 2,
        reportChecksum: "not-a-sha256",
        decision: "ACCEPTED",
        customerOrganization: "客户公司",
        customerRepresentative: "王工",
        representativeTitle: "项目负责人",
        confirmationChannel: "EMAIL",
        customerConfirmedAt: "2026-08-09T09:00:00.000Z",
        comment: "",
        evidenceFileIds: []
      })
    ).toThrow();
  });
});
