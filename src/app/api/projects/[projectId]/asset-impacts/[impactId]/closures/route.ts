import { projectAssetImpactRiskCommandRoute } from "../risk-command-route";

export const POST = projectAssetImpactRiskCommandRoute({
  command: "CLOSE",
  operation: "projects.asset-impact.close",
  observabilityOperation: "close-project-asset-impact"
});
