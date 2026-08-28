import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const contractPath = fileURLToPath(new URL("./uph-analysis-http.ts", import.meta.url));

type ContractModule = Record<string, { parse(value: unknown): unknown }>;

async function loadContracts(): Promise<ContractModule | null> {
  if (!existsSync(contractPath)) return null;
  return (await import(/* @vite-ignore */ pathToFileURL(contractPath).href)) as ContractModule;
}

async function requireContracts(): Promise<ContractModule | null> {
  const contracts = await loadContracts();
  expect(contracts === null, "APM-082 RED: strict UPH analysis HTTP contracts are required").toBe(
    false
  );
  return contracts;
}

function schema(contracts: ContractModule, name: string) {
  const value = contracts[name];
  expect(value, `APM-082 requires DTO ${name}`).toBeDefined();
  return value;
}

describe("APM-082 UPH analysis HTTP contracts", () => {
  it("accepts only a strict empty create body so engine, formula, actor, project, and revision remain server-derived", async () => {
    const contracts = await requireContracts();
    if (!contracts) return;
    const body = schema(contracts, "createUphAnalysisBodySchema");

    expect(body.parse({})).toEqual({});
    for (const forgedBody of [
      { engineCode: "UPH_ANALYSIS@1" },
      { formulaVersionId: "formula-client-v1" },
      { actorId: "actor-client" },
      { projectId: "project-client" },
      { batchId: "batch-client" },
      { revisionId: "revision-client" },
      { lockedChecksum: "0".repeat(64) },
      { unknown: true }
    ]) {
      expect(() => body.parse(forgedBody)).toThrow();
    }
  });

  it("keeps collection list query strict and requires all collection/detail identities in path DTOs", async () => {
    const contracts = await requireContracts();
    if (!contracts) return;
    const list = schema(contracts, "listUphAnalysesQuerySchema");

    expect(list.parse({ limit: "25" })).toMatchObject({ limit: 25 });
    for (const invalidQuery of [
      { limit: "0" },
      { limit: "101" },
      { analysisId: "analysis-client" },
      { projectId: "project-client" },
      { revisionId: "revision-client" },
      { engineCode: "UPH_ANALYSIS@1" },
      { unknown: true }
    ]) {
      expect(() => list.parse(invalidQuery)).toThrow();
    }
    const collectionPath = schema(contracts, "uphAnalysisCollectionPathSchema");
    const detailPath = schema(contracts, "uphAnalysisDetailPathSchema");
    const collection = { projectId: "project-1", batchId: "batch-1", revisionId: "revision-1" };

    expect(collectionPath.parse(collection)).toEqual(collection);
    expect(detailPath.parse({ ...collection, analysisId: "analysis-1" })).toEqual({
      ...collection,
      analysisId: "analysis-1"
    });
    for (const invalidDetailPath of [
      collection,
      { ...collection, analysisId: "" },
      { ...collection, analysisId: "analysis-1", unknown: true }
    ]) {
      expect(() => detailPath.parse(invalidDetailPath)).toThrow();
    }
    expect("getUphAnalysisQuerySchema" in contracts).toBe(false);
  });
});
