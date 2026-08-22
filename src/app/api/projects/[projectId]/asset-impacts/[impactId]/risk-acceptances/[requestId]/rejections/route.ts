import { projectAssetImpactRiskCommandRoute } from "../../../risk-command-route";

export const POST = projectAssetImpactRiskCommandRoute({
  command: "REJECT",
  operation: "projects.asset-impact.accept-risk.reject",
  observabilityOperation: "reject-project-asset-impact-risk-acceptance"
});
