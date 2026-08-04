import { createAlertScanHandler } from "@/modules/governance/application/alert-scan-handler";
import type { JobHandler } from "@/modules/governance/contracts/jobs";

export function createGovernanceJobHandlers(): Readonly<Record<string, JobHandler>> {
  return { "governance.alert-scan.requested": createAlertScanHandler() };
}
