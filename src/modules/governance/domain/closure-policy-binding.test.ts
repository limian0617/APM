import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildClosurePolicyVersionFacts } from "./project-closure-policy";
import {
  evaluateClosurePolicyBinding,
  parseClosureCheckerBindings
} from "./closure-policy-binding";

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const closeServicePath = resolve(
  sourceRoot,
  "modules/projects/application/project-close-service.ts"
);

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("closure policy binding", () => {
  it("parses only complete checker bindings and fails closed for a mismatched persisted checksum", () => {
    const bindings = [
      { code: "CLOSURE.ARCHIVE.G9", version: 2 },
      { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
    ];
    const facts = buildClosurePolicyVersionFacts({
      projectId: "project-1",
      sourceTemplateSnapshotId: "template-snapshot-1",
      sourceGateDefinitionId: "g9-definition-1",
      checkerBindings: bindings
    });

    expect(parseClosureCheckerBindings(bindings)).toEqual(bindings);
    expect(parseClosureCheckerBindings([{ code: "CLOSURE.ARCHIVE.G9", version: "2" }])).toBeNull();
    expect(
      evaluateClosurePolicyBinding({
        projectId: "project-1",
        sourceTemplateSnapshotId: "template-snapshot-1",
        sourceGateDefinitionId: "g9-definition-1",
        sourceGateDefinitionBindings: bindings,
        snapshotBindings: bindings,
        persisted: { ...facts, bindingChecksum: "f".repeat(64) }
      })
    ).toEqual({
      sourceGateDefinitionBindingsValid: true,
      snapshotCheckerBindingsValid: true,
      policyFactsValid: false
    });
  });

  it("keeps one shared evaluator and parser authority for close-project execution", () => {
    const evaluatorDefinition =
      /(?:^|\n)\s*(?:export\s+)?function\s+evaluateClosurePolicyBinding\s*\(/u;
    const definitionFiles = collectTypeScriptFiles(sourceRoot)
      .filter((path) => evaluatorDefinition.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
      .sort();
    const closeService = readFileSync(closeServicePath, "utf8");

    expect(definitionFiles).toEqual(["modules/governance/domain/closure-policy-binding.ts"]);
    expect(closeService).toMatch(
      /from\s+["']@\/modules\/governance\/domain\/closure-policy-binding["']/u
    );
    expect(closeService).toMatch(/\bevaluateClosurePolicyBinding\s*\(/u);
    expect(closeService).not.toMatch(/\bfunction\s+parseCheckerBindings\s*\(/u);
    expect(closeService).not.toMatch(/\bfunction\s+hasExactClosureBindings\s*\(/u);
  });
});
