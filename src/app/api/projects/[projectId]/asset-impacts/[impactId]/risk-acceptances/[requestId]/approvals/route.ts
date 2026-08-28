import { projectAssetImpactRiskCommandRoute } from "../../../risk-command-route";

export const POST = projectAssetImpactRiskCommandRoute({
  command: "APPROVE",
  operation: "projects.asset-impact.accept-risk.approve",
  observabilityOperation: "approve-project-asset-impact-risk-acceptance"
});
