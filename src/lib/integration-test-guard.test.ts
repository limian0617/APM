import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function collectIntegrationTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectIntegrationTestFiles(path);
    return entry.isFile() && path.endsWith(".integration.test.ts") ? [path] : [];
  });
}

const integrationTestFiles = collectIntegrationTestFiles(srcRoot);

/**
 * 主门禁：文件里必须真的写着这个表达式本身，而不是只在字符串字面量或注释里提到
 * 这个变量名（例如断言 CI 命令文本包含 "RUN_DATABASE_INTEGRATION=1" 不算数）。
 */
const GATE_EXPRESSION = "process.env.RUN_DATABASE_INTEGRATION";

interface GateException {
  /** 仓库相对路径（含 "src/" 前缀，相对仓库根）。 */
  path: string;
  /** 替代主门禁的环境变量名，不含 "process.env." 前缀。 */
  flag: string;
  /** 人类可读的豁免理由。 */
  reason: string;
}

/**
 * 主门禁判据之外唯一的豁免途径。每条例外都必须同时给出路径、替代门禁变量名、理由
 * 三项，且会被下面"例外表自我校验"测试逐条核实（路径存在、确实不含主门禁、确实
 * 含声明的替代门禁），防止条目腐烂或被随口添加。
 */
const GATE_EXCEPTIONS: GateException[] = [
  {
    path: "src/modules/archives/infrastructure/apm-054-to-apm-104-upgrade.integration.test.ts",
    flag: "APM104_UPGRADE_REPLAY",
    reason:
      "唯一触达数据库的用例（第137行）以 it.skipIf 按 APM104_UPGRADE_REPLAY 单独门禁，" +
      "其余三个用例为纯静态文本断言，不使用 RUN_DATABASE_INTEGRATION。"
  }
];

describe("集成测试门禁静态守卫", () => {
  it("至少发现 58 个 *.integration.test.ts 文件（防止路径推导或枚举出错导致下面的检查在空数组上假通过）", () => {
    if (integrationTestFiles.length < 58) {
      throw new Error(
        `只在 ${srcRoot} 下发现 ${integrationTestFiles.length} 个 *.integration.test.ts 文件，` +
          `少于预期下限 58，枚举可能出错。已发现的文件：\n${integrationTestFiles.join("\n") || "(无)"}`
      );
    }
    expect(integrationTestFiles.length).toBeGreaterThanOrEqual(58);
  });

  it("每个 *.integration.test.ts 文件都必须以 process.env.RUN_DATABASE_INTEGRATION 作为启用门禁，除非在 GATE_EXCEPTIONS 里有登记", () => {
    const exceptionPaths = new Set(
      GATE_EXCEPTIONS.map((exception) => resolve(repoRoot, exception.path))
    );

    const violations = integrationTestFiles.filter((path) => {
      if (exceptionPaths.has(path)) return false;
      return !readFileSync(path, "utf8").includes(GATE_EXPRESSION);
    });

    if (violations.length > 0) {
      throw new Error(
        `以下 ${violations.length} 个集成测试文件既没有引用 ${GATE_EXPRESSION} 作为门禁，` +
          `也没有在本文件的 GATE_EXCEPTIONS 里登记豁免，会在只设置了 DATABASE_URL` +
          `（未显式选择跑集成测试）的终端里意外执行、写入真实数据库：\n${violations.join("\n")}\n` +
          `请二选一处理：把启用条件改成 ${GATE_EXPRESSION}；或者确认该文件已用其他环境变量单独门禁后，` +
          `在 GATE_EXCEPTIONS 里补充 { path, flag, reason } 三项登记（会被下面的自我校验测试核实真伪）。`
      );
    }

    expect(violations).toEqual([]);
  });

  it("GATE_EXCEPTIONS 里的每条豁免都必须自我校验通过：路径存在、确实不含主门禁、确实含声明的替代门禁", () => {
    const issues: string[] = [];

    for (const exception of GATE_EXCEPTIONS) {
      const absolutePath = resolve(repoRoot, exception.path);

      if (!existsSync(absolutePath)) {
        issues.push(
          `${exception.path}：路径在磁盘上不存在，文件可能已被删除或改名，该例外条目已经腐烂，应予删除或修正路径`
        );
        continue;
      }

      const content = readFileSync(absolutePath, "utf8");

      if (content.includes(GATE_EXPRESSION)) {
        issues.push(
          `${exception.path}：文件里现在已经包含 ${GATE_EXPRESSION}，说明已经用上主门禁，` +
            `该例外条目已经过期，应从 GATE_EXCEPTIONS 里删除`
        );
        continue;
      }

      const flagExpression = `process.env.${exception.flag}`;
      if (!content.includes(flagExpression)) {
        issues.push(
          `${exception.path}：声明的替代门禁 ${flagExpression} 在文件里没有出现，` +
            `例外条目的 flag 字段（"${exception.flag}"）与文件实际代码不符`
        );
      }
    }

    if (issues.length > 0) {
      throw new Error(
        `以下 ${issues.length} 条 GATE_EXCEPTIONS 例外条目未通过自我校验：\n${issues.join("\n")}`
      );
    }

    expect(issues).toEqual([]);
  });
});
