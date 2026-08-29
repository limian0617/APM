import { projectAssetImpactCommandRoute } from "../command-route";

export const POST = projectAssetImpactCommandRoute({
  operation: "projects.asset-impact.refresh",
  observabilityOperation: "refresh-project-asset-impact"
});
