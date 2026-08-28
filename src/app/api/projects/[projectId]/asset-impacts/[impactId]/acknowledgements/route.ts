import { projectAssetImpactCommandRoute } from "../command-route";

export const POST = projectAssetImpactCommandRoute({
  operation: "projects.asset-impact.acknowledge",
  observabilityOperation: "acknowledge-project-asset-impact",
  action: "ACKNOWLEDGE"
});
