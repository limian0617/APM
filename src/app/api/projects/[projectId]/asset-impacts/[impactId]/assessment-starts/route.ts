import { projectAssetImpactCommandRoute } from "../command-route";

export const POST = projectAssetImpactCommandRoute({
  operation: "projects.asset-impact.start",
  observabilityOperation: "start-project-asset-impact-assessment",
  action: "START_ASSESSMENT"
});
