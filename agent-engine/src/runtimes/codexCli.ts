/**
 * `codex exec` adapter(codex-cli 0.147.0)。
 *
 * 存在的理由不是「現在就要用 codex」,而是**第二個 adapter 通了才算證明介面沒有
 * 偷偷綁死在 claude 上**。它跟 `claudeCli` 只差在旗標 —— gateway 完全不用改,
 * 因為 MCP 是標準協議。
 */
import type { AgentCapabilities, CommandContext, SpawnRuntime, SpawnCommand } from '../types.js';
import { EngineError } from '../types.js';
import { childEnv } from './childEnv.js';

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * 意圖 → 沙箱等級。
 *
 * **`shell: false` 表達不了** —— codex 的沙箱管的是「指令能不能寫」,不是「能不能
 * 執行指令」。表達不了就明確拒絕,不要靜默降級成一個限制較鬆的等級:那會讓
 * manifest 上寫著的限制在這個 runtime 上默默失效。
 */
export function sandboxFor(caps: AgentCapabilities | undefined): CodexSandbox | undefined {
  if (!caps) return undefined;
  if (caps.shell === false) {
    throw new EngineError(
      'capability',
      'codex 無法表達 shell: false —— 它的沙箱管的是指令能不能寫,不是能不能執行',
    );
  }
  switch (caps.filesystem) {
    case 'none':
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace-write';
    default:
      return undefined;
  }
}

/**
 * 宿主可調的部分,形狀對齊 `ClaudeCliOptions`。**只開具名選項,不開任意參數** ——
 * `-c` 能覆寫任何設定鍵(含 `mcp_servers`),開放出去就繞過 gateway。
 *
 * 沒有 `skipPermissions`:codex 唯一對應的 `--dangerously-bypass-approvals-and-sandbox`
 * 會連沙箱一起關,而沙箱是 manifest `filesystem` 翻出來的邊界。
 */
export interface CodexCliOptions {
  /** `-p <name>`:疊上 `$CODEX_HOME/<name>.config.toml`(對應 claude 的 `--settings`)。 */
  profile?: string;
  /** 不讓子程序繼承的環境變數。例如 `OPENAI_API_KEY`:在的話 codex 會改走 API 計費而不是登入的帳號。 */
  unsetEnv?: string[];
  /** 疊在子程序環境上的變數(同 `ClaudeCliOptions.env`)。與 `unsetEnv` 衝突時拿掉優先。 */
  env?: Record<string, string>;
}

export function createCodexCli(opts: CodexCliOptions = {}): SpawnRuntime {
  const env = childEnv(opts);
  return {
    name: 'codex-cli',

    // 三個洞補上之前,一個 take 會「看起來成功」:原始 JSONL 被當成答案存成產物、gateway 的工具
    // 不存在、限制比宣告的鬆。
    experimental: '沒有 --json 事件的 decoder(原始事件流會被當成輸出)、MCP 設定沒有照 codex 的 '
      + 'mcp_servers.<name> 格式傳(gateway 會被忽略)、filesystem: none 只能降成 read-only 沙箱',

    capabilities: {
      // codex 沒有 claude 的 plugin 機制。宣告了 skills 的 agent 會在
      // spawn 之前就被能力協商擋下,不會跑一個註定查不到東西的 take。
      skills: false,
      nativeTools: true,
      filesystemPolicy: 'sandbox',
      maxSteps: false,
    },

    command({ prompt, mcpConfigPath, capabilities, model }: CommandContext): SpawnCommand {
      const sandbox = sandboxFor(capabilities);
      return {
        file: 'codex',
        // prompt 走 stdin(見 SpawnCommand.stdin):`exec -` 從 stdin 讀指示。
        stdin: prompt,
        ...(env ? { env } : {}),
        args: [
          'exec', '-',
          // codex 用 TOML 設定而不是一份 JSON 檔;`-c` 可以指到我們寫好的那份。
          ...(mcpConfigPath ? ['-c', `mcp_servers_config_path=${JSON.stringify(mcpConfigPath)}`] : []),
          ...(sandbox ? ['-s', sandbox] : []),
          ...(model ? ['-m', model] : []),
          ...(opts.profile ? ['-p', opts.profile] : []),
          // JSONL 事件流,對應 claude 的 --output-format stream-json。
          '--json',
        ],
      };
    },
  };
}

/** 不帶任何選項的預設 adapter。 */
export const codexCli: SpawnRuntime = createCodexCli();
