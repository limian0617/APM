import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(
  new URL("../application/uph-definition-service.ts", import.meta.url),
  "utf8"
);

function functionBody(name: string) {
  const start = service.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const next = service.indexOf("export async function ", start + 1);
  return service.slice(start, next < 0 ? service.length : next);
}

describe("APM-080 UPH write lock order", () => {
  it("defines one project -> UPH root/version -> source -> definition-version lock contract", () => {
    expect(service).toMatch(/async function lockUphRootAndVersion\s*\(/);
    expect(service).toMatch(/async function lockUphStructureSources\s*\(/);
    expect(service).toMatch(/FOR NO KEY UPDATE/);
    const sourceHelperStart = service.indexOf("async function lockUphStructureSources");
    const sourceHelperEnd = service.indexOf("\nasync function ", sourceHelperStart + 1);
    const sourceHelper = service.slice(
      sourceHelperStart,
      sourceHelperEnd < 0 ? service.length : sourceHelperEnd
    );
    expect(sourceHelper).toMatch(/sourceType/);
    expect(sourceHelper).toMatch(/stableId|stable.*id/i);
    expect(sourceHelper).toMatch(/delivery_units[\s\S]*FOR UPDATE/);
    expect(sourceHelper).toMatch(/project_modules[\s\S]*FOR UPDATE/);
    const rootHelperStart = service.indexOf("async function lockUphRootAndVersion");
    const rootHelperEnd = service.indexOf("\nasync function ", rootHelperStart + 1);
    const rootHelper = service.slice(
      rootHelperStart,
      rootHelperEnd < 0 ? service.length : rootHelperEnd
    );
    expect(rootHelper).toMatch(/current_work_version_id/);
    expect(rootHelper).toMatch(/current_published_version_id/);
    expect(rootHelper).toMatch(/ORDER BY id FOR UPDATE/);
    expect(service).toMatch(/lockUphRootAndVersion\(\s*client/);
    expect(service).toMatch(/lockUphStructureSources\(client/);
  });

  it("locks CT current and target versions before its exact ProjectModule source", () => {
    const rootHelperStart = service.indexOf("async function lockUphRootAndVersion");
    const rootHelperEnd = service.indexOf("\nasync function ", rootHelperStart + 1);
    const rootHelper = service.slice(
      rootHelperStart,
      rootHelperEnd < 0 ? service.length : rootHelperEnd
    );
    const ctBranch = rootHelper.indexOf('if (kind === "CT")');
    const ctSourceLock = rootHelper.indexOf("await lockUphStructureSources", ctBranch);
    const currentWork = rootHelper.indexOf("currentWorkVersionId");
    const currentPublished = rootHelper.indexOf("currentPublishedVersionId");
    const target = rootHelper.indexOf("targetVersionId");
    const versionLock = rootHelper.indexOf("ORDER BY id FOR UPDATE");

    expect(ctBranch).toBeGreaterThanOrEqual(0);
    expect(ctSourceLock).toBeGreaterThan(ctBranch);
    expect(currentWork).toBeGreaterThanOrEqual(0);
    expect(currentPublished).toBeGreaterThanOrEqual(0);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(versionLock).toBeGreaterThanOrEqual(0);
    expect(versionLock).toBeLessThan(ctSourceLock);
  });

  it.each([
    "createUphDefinition",
    "signoffUphDefinition",
    "publishUphDefinition",
    "replaceSignedUphDraft"
  ])("uses the shared lock sequence in %s", (name) => {
    const body = functionBody(name);
    const root = body.search(/lockUphRootAndVersion\s*\(/u);
    expect(root).toBeGreaterThanOrEqual(0);
    expect(body).not.toMatch(/loadSourceState\(client[\s\S]{0,120}loadVersion\(/u);
  });

  it("covers the CT create and patch branches under the same shared sequence", () => {
    const body = functionBody("createUphDefinition");
    expect(body).toMatch(/if \(current && current\.status === "DRAFT"\)/);
    expect(body).toMatch(/"versionId" in input\.body/);
    expect(body).toMatch(/lockUphRootAndVersion\s*\(/u);
  });
});
