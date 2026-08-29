import { projectAssetImpactCommandRoute } from "../command-route";

export const POST = projectAssetImpactCommandRoute({
  operation: "projects.asset-impact.plan",
  observabilityOperation: "plan-project-asset-upgrade",
  action: "PLAN_UPGRADE"
});
