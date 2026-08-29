import { projectAssetImpactRiskCommandRoute } from "../risk-command-route";

export const POST = projectAssetImpactRiskCommandRoute({
  command: "REQUEST",
  operation: "projects.asset-impact.accept-risk.request",
  observabilityOperation: "request-project-asset-impact-risk-acceptance"
});
