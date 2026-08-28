import { createAlertScanHandler } from "@/modules/governance/application/alert-scan-handler";
import { createAssetImpactAlertHandler } from "@/modules/governance/application/asset-impact-alert-handler";
import type { JobHandler } from "@/modules/governance/contracts/jobs";

export function createGovernanceJobHandlers(): Readonly<Record<string, JobHandler>> {
  return {
    "governance.alert-scan.requested": createAlertScanHandler(),
    "asset.impact.assessed": createAssetImpactAlertHandler("asset.impact.assessed"),
    "asset.impact.disposition-recorded": createAssetImpactAlertHandler(
      "asset.impact.disposition-recorded"
    ),
    "asset.impact.risk-acceptance.decided": createAssetImpactAlertHandler(
      "asset.impact.risk-acceptance.decided"
    ),
    "project.asset-upgrade.adopted": createAssetImpactAlertHandler("project.asset-upgrade.adopted"),
    "asset.impact.closed": createAssetImpactAlertHandler("asset.impact.closed")
  };
}
