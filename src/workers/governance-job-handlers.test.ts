import { describe, expect, it, vi } from "vitest";

import type { JobExecution } from "@/modules/governance/contracts/jobs";
import { createAssetImpactAlertHandler } from "@/modules/governance/application/asset-impact-alert-handler";

import { createGovernanceJobHandlers } from "./governance-job-handlers";

function job(payload: JobExecution["payload"]): JobExecution {
  return {
    id: "asset-impact-job",
    jobType: "asset.impact.assessed",
    payload,
    payloadHash: "a".repeat(64),
    idempotencyKey: "asset-impact-job",
    traceId: "a".repeat(32),
    attemptId: "asset-impact-attempt",
    attemptNumber: 1,
    maxAttempts: 3,
    isReplay: false,
    workerId: "test-worker"
  };
}

describe("APM-064 asset-impact alert worker registration", () => {
  it("registers every authoritative AST event with one GOV projection handler", () => {
    expect(Object.keys(createGovernanceJobHandlers())).toEqual([
      "governance.alert-scan.requested",
      "asset.impact.assessed",
      "asset.impact.disposition-recorded",
      "asset.impact.risk-acceptance.decided",
      "project.asset-upgrade.adopted",
      "asset.impact.closed"
    ]);
  });

  it("passes only source identities and worker metadata to the projection", async () => {
    const projectAssetImpact = vi.fn();
    const handler = createAssetImpactAlertHandler("asset.impact.assessed", projectAssetImpact);
    await handler(
      job({
        projectId: "project-1",
        impactId: "impact-1",
        assessmentRevisionId: "assessment-1",
        toStatus: "CLOSED",
        ownerMembershipId: "untrusted-owner"
      })
    );

    expect(projectAssetImpact).toHaveBeenCalledWith({
      projectId: "project-1",
      impactId: "impact-1",
      eventAssessmentRevisionId: "assessment-1",
      sourceEventType: "asset.impact.assessed",
      sourceJobId: "asset-impact-job",
      jobAttemptId: "asset-impact-attempt",
      traceId: "a".repeat(32)
    });
  });

  it("rejects malformed identities instead of trusting event facts", async () => {
    const handler = createAssetImpactAlertHandler("project.asset-upgrade.adopted", vi.fn());
    await expect(handler(job({ projectId: "project-1", toStatus: "MITIGATED" }))).rejects.toThrow(
      "资产影响预警投影负载无效"
    );
  });
});
