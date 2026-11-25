import { defineAgent } from '../agents/manifest.js';
/**
 * 介面的編譯測試 —— 把三個真實呼叫端貼上來,看型別接不接得住。
 *
 * **這個檔不執行,只編譯。** `tsc` 過了代表介面自洽;不過就代表某個呼叫端被
 * 介面擋住了,而那是現在該知道的事,不是實作到一半才知道。
 *
 * 三個呼叫端分別探測天花板、地板與可攜性,依據見 `docs/caller-shapes.md`。
 */
import { createAgentEngine, codexCli } from '../index.js';
import type { ArtifactRef, DraftRef, ArtifactStore, RunEvent, TakeResult } from '../index.js';

// ─── 地板:最小 caller ────────────────────────────────────────────────────
// 除了什麼都不給以外,還要能一行拿到結果。這一段寫不出來就是 engine 沒做完自己
// 那一半。
export async function minimalCaller(): Promise<string> {
  const engine = createAgentEngine();
  const { output } = await engine.runTake({ agent: defineAgent({ id: 'hello', tools: [] }), prompt: '幫我看一下這段錯誤訊息' });
  await engine.close();
  return output;
}

// ─── 天花板:bug Director ─────────────────────────────────────────────────
// 探測的是:多執行緒共用一個 engine(scope)、自訂產物格式、逾時 + salvage、
// 三層 abort 合併後傳一個 signal、事件驅動的 heartbeat。

declare function caseDirStore(rootDir: string): ArtifactStore;
declare function checkSkillAvailable(plugin: string): { available: boolean; reason: string };
declare function makeBugOutputParser(name: string, sanitize: (s: string) => string): (raw: string) => string;
declare function parseCompleteReport(raw: string): string | null;
declare function applyToHeartbeat(event: RunEvent): void;

export async function bugDirector(args: {
  runnerDir: string;
  threadTs: string;
  bugAbort: AbortController;
  sanitizePaths: (s: string) => string;
  prompt: string;
}): Promise<TakeResult[]> {
  const engine = createAgentEngine({
    root: args.runnerDir,
    artifacts: caseDirStore(args.runnerDir),
    checkSkill: checkSkillAvailable,
    onEvent: applyToHeartbeat,
    defaults: { timeoutMs: 600_000 },
  });

  // 五路併行,共用同一個 engine —— scope 讓它們各自寫到自己 thread 的目錄。
  const angles = ['code-tracer', 'elk-investigator', 'db-state-checker'].map(id => defineAgent({ id, tools: [] }));
  const results = await Promise.all(angles.map((agent) => engine.runTake({
    agent,
    prompt: args.prompt,
    scope: args.threadTs,
    signal: args.bugAbort.signal,
    parseOutput: makeBugOutputParser(agent.id, args.sanitizePaths),
    salvage: parseCompleteReport,
  })));

  await engine.close();
  return results;
}

// ─── 可攜性:換 runtime ───────────────────────────────────────────────────
// 呼叫端除了 runtime 那一行之外完全不變 —— 這是「介面沒綁死在 claude 上」的檢查。
export async function onCodex(root: string): Promise<TakeResult> {
  // codex 還是 experimental(見 codexCli),要明寫才建得起來。
  const engine = createAgentEngine({ root, runtime: codexCli, allowExperimentalRuntime: true });
  try {
    return await engine.runTake({ agent: defineAgent({ id: 'jira-analyze', tools: [] }), prompt: '分析這張單' });
  } finally {
    await engine.close();
  }
}

// ─── 產物 store 的實作形狀 ────────────────────────────────────────────────
// 確認 ArtifactRef 夠用:bug 用 threadTs 當 scope,e2e 用 <issueKey>-<threadId>。
// 僅型別 fixture,不實作持久化與冪等保證。
export const storeShape: ArtifactStore = {
  append: async (_ref: DraftRef, _chunk: string) => {},
  readPartial: async (_ref: DraftRef) => null,
  commit: async (_draft, key, _content) => ({ ...key, version: 'v1' }),
  latest: async (_key) => null,
  read: async (_ref: ArtifactRef) => null,
  supersede: async (_ref: ArtifactRef) => {},
};
