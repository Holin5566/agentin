/**
 * 裸模型(OpenAI 相容 API:bifrost gateway / ollama)的 spawn adapter。
 *
 * 形狀跟 `claudeCli` 一樣:宣告「該執行什麼指令」,engine 負責 spawn、串流、逾時、取消、產物、事件。
 * 指令是我們自己的 runner(`vercelAi/runner.ts`)—— 它扮演 `claude -p`,內部跑 tool loop。
 * 所以宿主用它跟用 claude 完全一樣:`createAgentEngine({ runtime: createVercelAiCli({...}) })`,之後同一個 `runTake`。
 *
 * 能力:沒有原生工具(Read / Grep / Bash…)、沒有 skill。manifest 的 `capabilities` 靠 **gateway 工具**表達
 * (`filesystem: 'read-only'` → mcp-hub 的唯讀檔案工具 `fs-*`),所以 `filesystemPolicy` 是 `'tool-list'`:
 *   - `none` / 沒宣告 → 不給任何檔案工具
 *   - `read-only`     → 加上 `FS_READ_TOOLS`
 *   - `workspace-write` / `shell: true` → 沒有對應工具,**拒絕**(沒工具的 agent 不能「看起來成功」)
 */
import { join } from 'node:path';
import { EngineError } from '../types.js';
import type { AgentCapabilities, CommandContext, SpawnCommand, SpawnRuntime } from '../types.js';
import { createVercelAiDecoder } from './vercelAi/decoder.js';
import { parseRunnerFailure } from './vercelAi/protocol.js';

/** mcp-hub `fs-readonly` 宣告的 tool id(`manifests/mcp-servers/fs-readonly.json`)。 */
export const FS_READ_TOOLS = ['fs-read_file', 'fs-list_dir', 'fs-glob', 'fs-grep'];

/** 這個 runtime 給不起的能力。丟 `EngineError` 讓能力協商在載入時就擋下。 */
function assertSupported(caps: AgentCapabilities | undefined): void {
  if (caps?.filesystem === 'workspace-write') {
    throw new EngineError('capability', 'vercel-ai runtime 沒有寫檔案的工具(filesystem: workspace-write)');
  }
  if (caps?.shell === true) {
    throw new EngineError('capability', 'vercel-ai runtime 沒有 shell 工具(shell: true)');
  }
}

export interface VercelAiCliOptions {
  /** 預設 `openai-compat`(bifrost / ollama)。`anthropic` = 直連 Anthropic Messages API。 */
  provider?: 'openai-compat' | 'anthropic';
  /** `openai-compat`:API 的根(含 `/v1`),必填。`anthropic`:省略 = 官方端點。 */
  baseUrl?: string;
  /** openai-compat:原樣當 Bearer token(bifrost 的 virtual key 要帶 `sk-bf-` 前綴,由呼叫端補);anthropic:當 `x-api-key`。走環境變數給 runner,不放 argv。 */
  apiKey?: string;
  /** 預設模型。`TakeSpec.model` 有給就以它為準。兩者都沒有 → spawn 前回 `EngineError('config')`。 */
  model?: string;
  /** 沒有模型時附在錯誤訊息後面的提示(例:宿主該去設哪個設定)。 */
  modelHint?: string;
  /** 模型呼叫輪數上限。預設 30;用完回 `max_turn_requests`(可 salvage)。 */
  maxSteps?: number;
  /** 單一 tool 結果塞回對話前的字元上限。預設 20000。 */
  maxToolResultChars?: number;
  /** 整段對話的字元上限(估算)。預設 120000;超過先省略最舊的工具結果,仍超過就以 `context_exceeded` 收尾(可 salvage)。 */
  maxContextChars?: number;
  /** 單回合思考上限(token,以串流片段數估算):還沒有文字或工具呼叫就超過 → 中斷,要求簡短思考後重來一次;仍超過以 `reasoning_budget` 收尾。預設 4000;0 = 不限。 */
  maxReasoningTokens?: number;
  /** 單輪輸出 token 上限。省略 = 由模型端決定。 */
  maxTokens?: number;
  /** runner 的路徑。預設是 build 產物(`dist/runtimes/vercelAi/runner.js`);測試或換位置時覆寫。 */
  runnerPath?: string;
}

export function createVercelAiCli(opts: VercelAiCliOptions): SpawnRuntime {
  if ((opts.provider ?? 'openai-compat') === 'openai-compat' && !opts.baseUrl) {
    throw new EngineError('config', 'createVercelAiCli:openai-compat 需要 baseUrl');
  }
  const runner = opts.runnerPath ?? join(__dirname, 'vercelAi', 'runner.js');
  return {
    name: 'vercel-ai-cli',

    capabilities: {
      skills: false,
      nativeTools: false,
      // 用 gateway 工具名單表達檔案系統限制(見 `gatewayToolsFor`)。
      filesystemPolicy: 'tool-list',
      // runner 自己跑 loop,步數觀測得到。
      maxSteps: true,
    },

    gatewayToolDefinitionsFor(caps) {
      assertSupported(caps);
      return caps?.filesystem === 'read-only' ? [
        { id: 'fs-read_file', serverId: 'fs-readonly', toolName: 'fs_read_file' },
        { id: 'fs-list_dir', serverId: 'fs-readonly', toolName: 'fs_list_dir' },
        { id: 'fs-glob', serverId: 'fs-readonly', toolName: 'fs_glob' },
        { id: 'fs-grep', serverId: 'fs-readonly', toolName: 'fs_grep' },
      ] : [];
    },

    gatewayToolsFor(caps) {
      assertSupported(caps);
      return caps?.filesystem === 'read-only' ? FS_READ_TOOLS : [];
    },

    // 只驗能力。`command()` 還會驗模型 —— 模型可以由 `TakeSpec.model` 提供,載入 agent 時還不知道,不能拿它做預檢。
    validateCapabilities: assertSupported,

    command({ prompt, mcpConfigPath, model, capabilities }: CommandContext): SpawnCommand {
      assertSupported(capabilities);
      const useModel = model ?? opts.model;
      if (!useModel) {
        throw new EngineError('config', `vercel-ai runtime 沒有指定模型(TakeSpec.model 與 createVercelAiCli 的 model 都沒有)${opts.modelHint ? `:${opts.modelHint}` : ''}`);
      }
      return {
        // process.execPath 而不是 'node':宿主跑在哪個 node 上,runner 就跑在哪個。
        file: process.execPath,
        // prompt 走 stdin;金鑰走環境變數 —— 兩者都不進 argv(`ps` 看得到)。
        stdin: prompt,
        ...(opts.apiKey ? { env: { VERCEL_AI_API_KEY: opts.apiKey } } : {}),
        args: [
          runner,
          ...(opts.provider ? ['--provider', opts.provider] : []),
          ...(opts.baseUrl ? ['--base-url', opts.baseUrl] : []),
          '--model', useModel,
          ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
          ...(opts.maxSteps !== undefined ? ['--max-steps', String(opts.maxSteps)] : []),
          ...(opts.maxToolResultChars !== undefined ? ['--max-tool-chars', String(opts.maxToolResultChars)] : []),
          ...(opts.maxContextChars !== undefined ? ['--max-context-chars', String(opts.maxContextChars)] : []),
          ...(opts.maxReasoningTokens !== undefined ? ['--max-reasoning-tokens', String(opts.maxReasoningTokens)] : []),
          ...(opts.maxTokens !== undefined ? ['--max-tokens', String(opts.maxTokens)] : []),
        ],
      };
    },

    // runner 失敗時在 stderr 最後一行留標記(`vercelAi/protocol.ts`);在這裡轉成 `EngineError.retryable` / `.status`,
    // 宿主不必知道標記的格式。
    classifyFailure({ stderr }) {
      const f = parseRunnerFailure(stderr);
      return f ? { retryable: f.retryable, ...(f.status !== undefined ? { status: f.status } : {}) } : undefined;
    },

    createDecoder: createVercelAiDecoder,
  };
}
