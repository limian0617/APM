#!/usr/bin/env node
// PreToolUse hook: 拦截"会把整段输出灌进会话"的命令。
//
// 背景见本仓 CLAUDE.md「Context discipline」：本仓会话天生产出大段文本
// （mutations / verify / diff / schema dumps），一旦撑爆上下文且自动压缩失败，
// 整个会话会以 `Prompt is too long · automatic compaction failed` 死在半途。
// 光靠文档约束管不住——settings.local.json 里 `Bash(npm run *)` 是放行的，
// 所以七道质量闸跑起来既不弹窗、也没人拦。这里把它变成硬拦。
//
// 命中条件（Bash 工具）：
//   - 命令是已知的高产出调用（npm run test/lint/typecheck/build/... 或 npx vitest/eslint/tsc/...）
//   - 且没有把 stdout 落盘（无 > / >> 重定向到文件）
//   - 且没有用管道截断（无 | head / | tail / | wc -l ...）
//   - 且不是 --help / --version / --list* / watch 这类低产出调用
// 命中则 exit 2（阻塞），stderr 里给出可直接复制的正确写法。
//
// 注意：本脚本只管"少读"，不管命令是否安全——权限由 settings.local.json 负责，两者不要混。

import { readFileSync } from 'node:fs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8'); // fd 0 = stdin，同步读完
  } catch {
    return '';
  }
}

// —— 识别"这条命令是不是在跑某个高产出脚本" ——
// 用 `npm run <name>` / `npx <bin>` 的形式匹配，且必须出现在某个命令段的**段首**，
// 避免误伤 `git commit -m "跑通了 npm run test"` 这类只是提到命令名的调用。
const HIGH_OUTPUT_NPM_SCRIPTS = new Set([
  'test',
  'test:watch',
  'lint',
  'typecheck',
  'typecheck:scripts',
  'build',
  'format:check',
  'db:validate',
  'db:generate',
]);

// npx 直接调用的二进制（本仓 allowlist 里已有 npx vitest / npx eslint / npx prisma / npx prettier）
const HIGH_OUTPUT_BINS = new Set(['vitest', 'eslint', 'tsc', 'prisma', 'next', 'prettier']);

function isHighOutputInvocation(cmd) {
  // 按 shell 分隔符切成"段"（; && || | 换行），每段单独判断。
  // 宽松处：`time npm run test` / `bash -c '...'` 这类包一层的会漏（放过）。
  // 有意为之——宁可漏拦，不可误伤（误伤会让正常命令跑不动，更烦人）。
  const segments = cmd.split(/(?:&&|\|\||;|\n|\|)/);
  for (const seg of segments) {
    const s = seg.trim();
    // npm run <script>
    const npmRun = s.match(/^(?:npm|pnpm|yarn)\s+run\s+([\w:.+-]+)/);
    if (npmRun) {
      if (HIGH_OUTPUT_NPM_SCRIPTS.has(npmRun[1])) return true;
      continue;
    }
    // 裸 `npm test` / `npm t`
    if (/^(?:npm|pnpm|yarn)\s+(?:t|test)\b/.test(s)) return true;
    // npx <bin>
    const npx = s.match(/^(?:npx|pnpx)\s+(?:--\S+\s+)*([\w@/.-]+)/);
    if (npx) {
      const bin = npx[1].split('@')[0].split('/').pop();
      if (HIGH_OUTPUT_BINS.has(bin)) return true;
    }
  }
  return false;
}

// 落盘：> file / >> file / 2> file（1> / &> 也涵盖）。
// 只认"stdout 去文件"；> /dev/null 是丢弃，不灌会话，也算合规。
function redirectsToFile(cmd) {
  return /(^|[^0-9&])>>?\s*(?!&)\S+/.test(cmd) || /&>>?\s*\S+/.test(cmd);
}

// 截断：管道给 head/tail/wc/grep -c 等，输出量已被压到很小。
function isTruncated(cmd) {
  return /\|\s*(head|tail|wc|sort\s+-u|uniq|grep\s+-[cblomnq]|awk|sed\s+-n)\b/.test(cmd);
}

// 低产出 / 长驻调用：--help / -v / --version / --list* / --dry-run / watch
function isLowOutput(cmd) {
  if (/(--help|-h\b|--version|-v\b|--list[\w-]*|--dry-run)\b/.test(cmd)) return true;
  // vitest watch / npm run test:watch 是长驻进程，本来就不该拦
  if (/\bwatch\b/.test(cmd)) return true;
  return false;
}

function main() {
  const raw = readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // 解析不了就放行，不要因为 hook 自身问题卡住用户
  }

  if (payload?.tool_name !== 'Bash') process.exit(0);

  const cmd = String(payload?.tool_input?.command ?? '');
  if (!cmd) process.exit(0);

  if (!isHighOutputInvocation(cmd)) process.exit(0);
  if (isLowOutput(cmd)) process.exit(0);
  if (redirectsToFile(cmd)) process.exit(0);
  if (isTruncated(cmd)) process.exit(0);

  const hint = '.tmp\\out\\<task>-<purpose>.txt'; // 本仓约定：<task>-<purpose>.txt

  process.stderr.write(
    [
      '被仓库约定拦下：这条命令会把整段输出灌进会话，可能撑爆上下文（CLAUDE.md「Context discipline」）。',
      '',
      '请落盘后只回报结论，例如：',
      `  npm run test > "${hint}" 2>&1`,
      '',
      '然后：',
      '  - 只看结论：读文件末尾几行，或 grep 出 FAIL/AssertionError 的行号区间',
      '  - 需要具体某段：用 Read 带 offset/limit 小窗口读',
      '  - 确实只想看个大概：改成 `... 2>&1 | tail -40`（管道截断会放行）',
      '',
      '一个任务做完后清掉本任务的输出：Remove-Item -Recurse -Force .tmp\\out',
    ].join('\n'),
  );
  process.exit(2); // 2 = 阻塞本次工具调用，stderr 会回给模型
}

main();
