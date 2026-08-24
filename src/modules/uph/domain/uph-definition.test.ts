import { describe, expect, it } from "vitest";

import {
  calculateModuleCapacity,
  calculateTopologyForestCapacity,
  replaceSignedDraft,
  transitionUphVersion,
  validateTopologyForest,
  type TopologyForest,
  type UphVersionState
} from "./uph-definition";

describe("APM-080 UPH definition domain", () => {
  it("calculates a module from total output without multiplying cavity count", () => {
    expect(
      calculateModuleCapacity({
        intrinsicCtSeconds: 12,
        outputPerCycleTotal: 4,
        parallelChannelCount: 2,
        cavityCount: 8
      })
    ).toBe(2400);
  });

  it("requires cavity count to be a positive integer", () => {
    expect(() =>
      calculateModuleCapacity({
        intrinsicCtSeconds: 12,
        outputPerCycleTotal: 4,
        parallelChannelCount: 2,
        cavityCount: 1.5
      })
    ).toThrow("CAVITY_COUNT_INVALID");
  });

  it("requires per-cycle output and parallel channels to be positive integers", () => {
    expect(() =>
      calculateModuleCapacity({
        intrinsicCtSeconds: 12,
        outputPerCycleTotal: 1.5,
        parallelChannelCount: 2,
        cavityCount: 1
      })
    ).toThrow("OUTPUT_PER_CYCLE_INVALID");
    expect(() =>
      calculateModuleCapacity({
        intrinsicCtSeconds: 12,
        outputPerCycleTotal: 2,
        parallelChannelCount: 1.5,
        cavityCount: 1
      })
    ).toThrow("PARALLEL_CHANNEL_INVALID");
  });

  it("evaluates mandatory and the single parallel group as min/sum/min", () => {
    const forest: TopologyForest = {
      projectShape: "LINE",
      roots: [
        {
          sourceId: "line-1",
          sourceType: "LINE",
          parentSourceId: null,
          relation: "ROOT",
          children: [
            {
              sourceId: "mandatory",
              sourceType: "MACHINE",
              parentSourceId: "line-1",
              relation: "MANDATORY",
              capacity: 120
            },
            {
              sourceId: "parallel-a",
              sourceType: "MACHINE",
              parentSourceId: "line-1",
              relation: "PARALLEL",
              capacity: 80
            },
            {
              sourceId: "parallel-b",
              sourceType: "MACHINE",
              parentSourceId: "line-1",
              relation: "PARALLEL",
              capacity: 70
            }
          ]
        }
      ]
    };

    expect(calculateTopologyForestCapacity(forest)).toEqual([
      { rootSourceId: "line-1", capacity: 120 }
    ]);
  });

  it("supports multiple physical LINE roots without inventing a project total", () => {
    const forest: TopologyForest = {
      projectShape: "LINE",
      roots: [
        {
          sourceId: "line-a",
          sourceType: "LINE",
          parentSourceId: null,
          relation: "ROOT",
          capacity: 100
        },
        {
          sourceId: "line-b",
          sourceType: "LINE",
          parentSourceId: null,
          relation: "ROOT",
          capacity: 160
        }
      ]
    };

    expect(calculateTopologyForestCapacity(forest)).toEqual([
      { rootSourceId: "line-a", capacity: 100 },
      { rootSourceId: "line-b", capacity: 160 }
    ]);
  });

  it("accepts one MACHINE root for SINGLE_MACHINE and rejects a line root", () => {
    expect(() =>
      validateTopologyForest({
        projectShape: "SINGLE_MACHINE",
        roots: [
          {
            sourceId: "machine-1",
            sourceType: "MACHINE",
            parentSourceId: null,
            relation: "ROOT",
            capacity: 100
          }
        ]
      })
    ).not.toThrow();

    expect(() =>
      validateTopologyForest({
        projectShape: "SINGLE_MACHINE",
        roots: [
          {
            sourceId: "line-1",
            sourceType: "LINE",
            parentSourceId: null,
            relation: "ROOT",
            capacity: 100
          }
        ]
      })
    ).toThrow("SINGLE_MACHINE_ROOT_INVALID");
  });

  it("rejects cycles, skipped physical parents, and more than one parallel group", () => {
    expect(() =>
      validateTopologyForest({
        projectShape: "LINE",
        roots: [
          {
            sourceId: "line-1",
            sourceType: "LINE",
            parentSourceId: null,
            relation: "ROOT",
            children: [
              {
                sourceId: "line-1",
                sourceType: "LINE",
                parentSourceId: "line-1",
                relation: "MANDATORY"
              }
            ]
          }
        ]
      })
    ).toThrow("TOPOLOGY_CYCLE");

    expect(() =>
      validateTopologyForest({
        projectShape: "LINE",
        roots: [
          {
            sourceId: "line-1",
            sourceType: "LINE",
            parentSourceId: null,
            relation: "ROOT",
            children: [
              {
                sourceId: "module-1",
                sourceType: "MODULE",
                parentSourceId: "other-line",
                relation: "MANDATORY"
              }
            ]
          }
        ]
      })
    ).toThrow("TOPOLOGY_PARENT_MISMATCH");

    expect(() =>
      validateTopologyForest({
        projectShape: "LINE",
        roots: [
          {
            sourceId: "line-1",
            sourceType: "LINE",
            parentSourceId: null,
            relation: "ROOT",
            parallelGroups: [["a"], ["b"]]
          }
        ]
      } as never)
    ).toThrow("UNSUPPORTED_PARALLEL_TOPOLOGY");
  });

  it("allows only DRAFT edits and requires commissioning before topology publish", () => {
    expect(transitionUphVersion({ status: "DRAFT", commissioningSigned: false }, "PATCH")).toEqual({
      status: "DRAFT",
      commissioningSigned: false
    });
    expect(() =>
      transitionUphVersion({ status: "DRAFT", commissioningSigned: false }, "PUBLISH")
    ).toThrow("COMMISSIONING_REQUIRED");
    expect(transitionUphVersion({ status: "DRAFT", commissioningSigned: true }, "PUBLISH")).toEqual(
      {
        status: "PUBLISHED",
        commissioningSigned: true
      }
    );
    expect(() =>
      transitionUphVersion({ status: "PUBLISHED", commissioningSigned: true }, "PATCH")
    ).toThrow("VERSION_IMMUTABLE");
  });

  it("uses a neutral correction reason and supersedes the signed draft atomically", () => {
    expect(
      replaceSignedDraft({
        rootVersion: 4,
        currentWork: {
          id: "v2",
          status: "DRAFT",
          commissioningSigned: true,
          contentChecksum: "old"
        },
        replacement: {
          contentChecksum: "new",
          reasonCode: "DRAFT_CORRECTION",
          reason: "修正会签遗漏"
        }
      })
    ).toEqual({
      rootVersion: 5,
      oldStatus: "SUPERSEDED",
      successorStatus: "DRAFT",
      supersedesVersionId: "v2",
      reasonCode: "DRAFT_CORRECTION"
    });

    expect(() =>
      replaceSignedDraft({
        rootVersion: 4,
        currentWork: {
          id: "v2",
          status: "DRAFT",
          commissioningSigned: true,
          contentChecksum: "old"
        },
        replacement: {
          contentChecksum: "new",
          reasonCode: "QUALITY_PUBLICATION_REFUSAL",
          reason: "no"
        }
      } as never)
    ).toThrow("REPLACEMENT_REASON_INVALID");
  });

  it("does not allow an arbitrary supersede or quality rejection transition", () => {
    const states: UphVersionState[] = ["DRAFT", "PUBLISHED", "SUPERSEDED"];
    for (const state of states) {
      expect(() =>
        transitionUphVersion({ status: state, commissioningSigned: true }, "SUPERSEDE" as never)
      ).toThrow("CONTROLLED_REPLACEMENT_REQUIRED");
    }
  });
});
