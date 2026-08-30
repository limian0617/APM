import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(new URL("./uph-definition-service.ts", import.meta.url), "utf8");
const contract = readFileSync(new URL("../contracts/uph-http.ts", import.meta.url), "utf8");
const route = readFileSync(
  new URL("../../../app/api/projects/[projectId]/uph/[kind]/route.ts", import.meta.url),
  "utf8"
);

describe("APM-080 CT per-module scope contract (RED)", () => {
  it("requires CT root locators to use projectModuleId, never an arbitrary project row", () => {
    expect(service).toMatch(/async function loadRoot\([\s\S]{0,220}?projectModuleId/u);
    expect(service).toMatch(/async function lockUphRootAndVersion\([\s\S]{0,260}?projectModuleId/u);
  });

  it("requires exact CT version/root/module identity on command paths", () => {
    expect(service).toMatch(/async function locateCtRootByVersion\([\s\S]{0,320}?projectModuleId/u);
    expect(service).toMatch(
      /export async function signoffUphDefinition[\s\S]{0,900}?locateCtRootByVersion[\s\S]{0,900}?lockUphRootAndVersion/u
    );
    expect(service).toMatch(
      /export async function publishUphDefinition[\s\S]{0,900}?locateCtRootByVersion[\s\S]{0,900}?lockUphRootAndVersion/u
    );
    expect(service).toMatch(
      /export async function getUphDefinition\([\s\S]{0,300}?projectModuleId/u
    );
    expect(service).toMatch(
      /getUphDefinition\([\s\S]{0,700}?projectModuleId[\s\S]{0,700}?loadRoot/u
    );
  });

  it("requires a module-scoped current query and rejects module scope for other kinds", () => {
    expect(contract).toMatch(/export const uphSelectionQuerySchemaByKind/u);
    expect(contract).toMatch(/selection: z\.literal\("currentWork"\),\s*projectModuleId/u);
    expect(route).toMatch(/path\.kind === "CT"[\s\S]{0,300}projectModuleId/u);
    expect(route).toMatch(/path\.kind !== "CT"[\s\S]{0,300}projectModuleId/u);
  });
});
