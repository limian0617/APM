import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-034 alert persistence contract", () => {
  it("defines scoped alert rules, current aggregates, scan freshness, and append-only events", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migrationPath = resolve(
      process.cwd(),
      "prisma/migrations/20260804060000_apm_034_alert_governance/migration.sql"
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

    for (const declaration of [
      "enum AlertSourceType",
      "enum AlertRiskLevel",
      "enum AlertRuleStatus",
      "enum ProjectAlertStatus",
      "enum ProjectAlertEventType",
      "enum ProjectAlertScanStatus",
      "model ProjectAlertRule",
      "model ProjectAlert",
      "model ProjectAlertEvent",
      "model ProjectAlertScan",
      "ALERT_RULE_CREATED",
      "ALERT_TRIGGERED",
      "ALERT_ESCALATED",
      "ALERT_RULE",
      "PROJECT_ALERT"
    ]) {
      expect(schema).toContain(declaration);
    }

    for (const declaration of [
      'CREATE TABLE "project_alert_rules"',
      'CREATE TABLE "project_alerts"',
      'CREATE TABLE "project_alert_events"',
      'CREATE TABLE "project_alert_scans"',
      "CREATE FUNCTION reject_project_alert_event_mutation()",
      "CREATE FUNCTION reject_project_alert_fact_removal()",
      "project_alert_events_reject_mutation",
      "project_alerts_reject_delete",
      "ADD VALUE 'ALERT_RULE_CREATED'",
      "ADD VALUE 'ALERT_TRIGGERED'",
      "ADD VALUE 'ALERT_ESCALATED'"
    ]) {
      expect(migration).toContain(declaration);
    }
  });

  it("keeps the APM-034 prerequisite migration in APM-023 CI upgrade coverage", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("Validate APM-023 to APM-050 upgrade migration");
    expect(workflow).toContain("20260804060000_apm_034_alert_governance");
  });
});
